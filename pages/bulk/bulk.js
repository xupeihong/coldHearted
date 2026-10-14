/**
 * 批量录入：拍一页礼金簿，一次记下名单上的所有人
 *
 * 与「记一笔」的关键差别：识别结果不能直接入库。
 * 一页几十个手写名字，模型读错一两个是常态，而批量写进去之后再逐条
 * 找出来改的成本极高。所以中间必须有一道人工核对的关口，这个页面
 * 的主体就是那张可编辑、可勾选的候选清单。
 */
const {
  createRecords,
  ensureContacts,
  cleanupReceipt,
  listAllRecords,
  listContacts,
  updateContact,
} = require('../../utils/db')
const { uploadReceipt } = require('../../utils/storage')
const { recognizeRoster } = require('../../utils/ai')
const { visionLabelOf } = require('../../utils/settings')
const { todayStr, EVENT_TYPES, formatAmount } = require('../../utils/format')

/** 识别结果转成可编辑的行；金额读不出来时留空，便于在界面上标红提醒 */
function toEditableItems(roster) {
  return roster.items.map(function (item) {
    return {
      key: item.key,
      name: item.name,
      relation: item.relation || '',
      amount: item.amount ? String(item.amount) : '',
      note: item.note || '',
      selected: true,
      amountMissing: !item.amount,
    }
  })
}

Page({
  data: {
    step: 'pick', // pick 拍照 | review 核对
    photoPath: '',
    photoSrc: '',
    recognizing: false,
    recognizeMsg: '',
    modelLabel: '',

    items: [],
    selectedCount: 0,
    allSelected: false,
    totalAmountText: '0',

    direction: 'in',
    eventType: '',
    eventTypes: EVENT_TYPES,
    happenedOn: todayStr(),

    warnText: '',
    saving: false,
  },

  onLoad: function () {
    const app = getApp()
    app.ready().then(function (session) {
      if (!session) wx.redirectTo({ url: '/pages/login/login' })
    })
  },

  /* ------------------------------ 拍照与识别 ------------------------------ */

  onChoosePhoto: function () {
    const page = this
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      // 整页手写名单全靠笔画细节，压缩版会先被微信压一道，必须取原图
      sizeType: ['original'],
      sourceType: ['album', 'camera'],
      success: function (res) {
        const file = res.tempFiles && res.tempFiles[0]
        if (!file || !file.tempFilePath) return
        page.setData({
          photoPath: file.tempFilePath,
          photoSrc: file.tempFilePath,
          recognizeMsg: '',
        })
        page.runRecognize()
      },
      fail: function () {
        // 用户取消选择，无需提示
      },
    })
  },

  onPreviewPhoto: function () {
    if (!this.data.photoSrc) return
    wx.previewImage({ urls: [this.data.photoSrc], current: this.data.photoSrc })
  },

  onRemovePhoto: function () {
    this.setData({
      step: 'pick',
      photoPath: '',
      photoSrc: '',
      items: [],
      selectedCount: 0,
      warnText: '',
      recognizeMsg: '',
    })
  },

  runRecognize: function () {
    const page = this
    if (!this.data.photoPath || this.data.recognizing) return

    this.setData({ recognizing: true, recognizeMsg: '', warnText: '' })

    recognizeRoster(this.data.photoPath)
      .then(function (roster) {
        const items = toEditableItems(roster)
        const by = roster.modelName ? visionLabelOf(roster.modelName) : ''
        page.setData({
          step: 'review',
          recognizing: false,
          recognizeMsg: by
            ? '已用 ' + by + ' 读出 ' + items.length + ' 人，请对照原图核对'
            : '已读出 ' + items.length + ' 人，请对照原图核对',
          modelLabel: by,
          items: items,
          eventType: roster.eventType || page.data.eventType,
          happenedOn: roster.happenedOn || page.data.happenedOn,
          warnText: page.buildWarn(roster, items),
        })
        page.refreshCounts()
      })
      .catch(function (err) {
        page.setData({
          step: 'pick',
          recognizing: false,
          recognizeMsg: (err && err.message) || '识别失败，请换一张更清晰的照片',
        })
      })
  },

  /** 识别质量的提醒：没读出金额、人太多容易漏、输出可能被截断 */
  buildWarn: function (roster, items) {
    const parts = []
    const zero = items.filter(function (item) {
      return item.amountMissing
    }).length
    if (zero) parts.push('有 ' + zero + ' 人没读出金额，已在下方标红，请对照原图补上')
    if (roster.dense) parts.push('这一页人比较多，容易漏读，建议逐行核对一遍')
    if (roster.truncated) parts.push('这个模型可能没把整页读完，如有遗漏可以补拍一张')
    return parts.join('；')
  },

  /* ------------------------------ 整页共同的信息 ------------------------------ */

  onDirectionTap: function (e) {
    this.setData({ direction: e.currentTarget.dataset.key })
  },

  onEventTap: function (e) {
    const value = e.currentTarget.dataset.value
    this.setData({ eventType: this.data.eventType === value ? '' : value })
  },

  onDateChange: function (e) {
    this.setData({ happenedOn: e.detail.value })
  },

  /* ------------------------------ 候选清单 ------------------------------ */

  onToggleItem: function (e) {
    const index = Number(e.currentTarget.dataset.index)
    const next = !this.data.items[index].selected
    const patch = {}
    // 用路径更新而非替换整个数组，否则会重建列表导致输入框失焦
    patch['items[' + index + '].selected'] = next
    this.setData(patch)
    this.refreshCounts()
  },

  onToggleAll: function () {
    const next = !this.data.allSelected
    const patch = {}
    this.data.items.forEach(function (item, index) {
      if (item.selected !== next) patch['items[' + index + '].selected'] = next
    })
    if (!Object.keys(patch).length) return
    this.setData(patch)
    this.refreshCounts()
  },

  onItemInput: function (e) {
    const index = Number(e.currentTarget.dataset.index)
    const field = e.currentTarget.dataset.field
    const value = e.detail.value
    const patch = {}
    patch['items[' + index + '].' + field] = value
    if (field === 'amount') {
      patch['items[' + index + '].amountMissing'] = !(Number(value) > 0)
    }
    this.setData(patch)
    if (field === 'amount') this.refreshCounts()
  },

  onAddRow: function () {
    const items = this.data.items.concat([
      {
        key: 'm' + Date.now(),
        name: '',
        relation: '',
        amount: '',
        note: '',
        selected: true,
        amountMissing: true,
      },
    ])
    this.setData({ items: items })
    this.refreshCounts()
  },

  refreshCounts: function () {
    const items = this.data.items
    let selected = 0
    let total = 0
    let allSelected = items.length > 0

    items.forEach(function (item) {
      if (!item.selected) {
        allSelected = false
        return
      }
      selected += 1
      total += Number(item.amount) || 0
    })

    this.setData({
      selectedCount: selected,
      totalAmountText: formatAmount(total),
      allSelected: allSelected,
    })
  },

  /* ------------------------------ 写入 ------------------------------ */

  onSubmit: function () {
    const page = this
    const picked = this.data.items.filter(function (item) {
      return item.selected
    })
    if (!picked.length) return wx.showToast({ title: '至少选一个人', icon: 'none' })
    if (this.data.saving) return

    const nameless = picked.filter(function (item) {
      return !String(item.name || '').trim()
    })
    if (nameless.length) {
      return wx.showToast({ title: '有 ' + nameless.length + ' 行还没填姓名', icon: 'none' })
    }

    const zero = picked.filter(function (item) {
      return !(Number(item.amount) > 0)
    })
    if (zero.length) {
      wx.showModal({
        title: '还有金额没填',
        content: '有 ' + zero.length + ' 人的金额是 0，确定就这样保存吗？',
        confirmText: '仍然保存',
        cancelText: '返回补填',
        success: function (res) {
          if (res.confirm) page.checkDuplicate(picked)
        },
      })
      return
    }

    this.checkDuplicate(picked)
  },

  /**
   * 入库前查一次重复
   *
   * 一本礼金簿分页拍、或者同一页不小心拍了两遍时，会出现姓名、金额、日期
   * 完全相同的记录。批量写入之后再去清理很麻烦，所以在写之前先拦一道。
   */
  checkDuplicate: function (picked) {
    const page = this
    const happenedOn = this.data.happenedOn

    wx.showLoading({ title: '检查中', mask: true })
    // 查重必须比对全量，漏掉的部分会变成重复入库；只取三个字段，传输量很小
    listAllRecords('contact_name, amount, happened_on')
      .then(function (records) {
        wx.hideLoading()
        const known = {}
        records.forEach(function (row) {
          known[
            (row.contact_name || '') + '|' + Number(row.amount || 0) + '|' + (row.happened_on || '')
          ] = true
        })
        const dupes = picked.filter(function (item) {
          return known[item.name + '|' + (Number(item.amount) || 0) + '|' + happenedOn]
        })
        if (!dupes.length) {
          page.doSave(picked)
          return
        }
        wx.showModal({
          title: '可能有重复',
          content:
            '有 ' +
            dupes.length +
            ' 条的姓名、金额、日期与账本里已有的记录完全相同，可能这一页之前录过了。仍然保存吗？',
          confirmText: '仍然保存',
          cancelText: '取消',
          success: function (res) {
            if (res.confirm) page.doSave(picked)
          },
        })
      })
      .catch(function () {
        // 查重是额外的保险，它失败不该挡住正常的保存
        wx.hideLoading()
        page.doSave(picked)
      })
  },

  doSave: function (picked) {
    const page = this
    this.setData({ saving: true })
    wx.showLoading({ title: '正在写入', mask: true })

    let uploaded = ''

    const preparePhoto = page.data.photoPath
      ? uploadReceipt(page.data.photoPath).then(function (objectPath) {
          uploaded = objectPath || ''
          return uploaded
        })
      : Promise.resolve('')

    preparePhoto
      .then(function (photoPath) {
        const names = picked.map(function (item) {
          return item.name
        })
        return ensureContacts(names).then(function (map) {
          return picked.map(function (item) {
            return {
              contactName: item.name,
              contactId: map[item.name] || null,
              direction: page.data.direction,
              amount: Number(item.amount) || 0,
              eventType: page.data.eventType,
              happenedOn: page.data.happenedOn,
              // 整页共享同一张凭证照片
              photoPath: photoPath,
              note: item.note || '',
            }
          })
        })
      })
      .then(function (rows) {
        return createRecords(rows)
      })
      .then(function () {
        return page.syncRelations(picked)
      })
      .then(function () {
        wx.hideLoading()
        page.setData({ saving: false })
        page.askNextPage(picked.length)
      })
      .catch(function (err) {
        wx.hideLoading()
        page.setData({ saving: false })
        // 记录没写成，刚上传的照片就没人引用了
        if (uploaded) cleanupReceipt(uploaded)
        wx.showModal({
          title: '没能写入',
          content: (err && err.message) || '请检查网络后重试',
          showCancel: false,
        })
      })
  },

  /**
   * 把这一批识别出的关系写进往来对象
   *
   * 关系字段一直没有录入入口，批量录入正好顺手补上。
   * 只在原来是空的情况下写入，不覆盖已有值。
   */
  syncRelations: function (picked) {
    const wanted = {}
    picked.forEach(function (item) {
      const relation = String(item.relation || '').trim()
      const name = String(item.name || '').trim()
      if (name && relation) wanted[name] = relation
    })
    if (!Object.keys(wanted).length) return Promise.resolve()

    return listContacts()
      .then(function (contacts) {
        const tasks = []
        contacts.forEach(function (contact) {
          const relation = wanted[contact.name]
          if (!relation) return
          if (contact.relation) return
          tasks.push(
            updateContact(contact.id, { relation: relation }).catch(function () {
              return null
            })
          )
        })
        return Promise.all(tasks)
      })
      .catch(function () {
        // 关系只是附带的补充信息，写失败不该影响记录本身
        return null
      })
  },

  /** 一本礼金簿通常有好几页，写完问一句要不要接着拍 */
  askNextPage: function (count) {
    const page = this
    wx.showModal({
      title: '已写入 ' + count + ' 条',
      content: '这本礼金簿还有下一页吗？',
      confirmText: '继续拍',
      cancelText: '回账本',
      success: function (res) {
        if (res.confirm) page.resetForNext()
        else wx.navigateBack()
      },
      fail: function () {
        wx.navigateBack()
      },
    })
  },

  resetForNext: function () {
    this.setData({
      step: 'pick',
      photoPath: '',
      photoSrc: '',
      items: [],
      selectedCount: 0,
      allSelected: false,
      totalAmountText: '0',
      recognizeMsg: '',
      warnText: '',
    })
  },
})
