const {
  createRecord,
  updateRecord,
  ensureContact,
  getRecord,
  cleanupReceipt,
  cleanupReceiptIfUnused,
} = require('../../utils/db')
const { uploadReceipt, receiptUrl } = require('../../utils/storage')
const { recognizeReceipt } = require('../../utils/ai')
const { visionLabelOf } = require('../../utils/settings')
const { todayStr, EVENT_TYPES, formatDate } = require('../../utils/format')

Page({
  data: {
    editingId: 0,
    direction: 'in',
    contactName: '',
    amount: '',
    eventType: '',
    eventTypes: EVENT_TYPES,
    happenedOn: todayStr(),
    note: '',
    isSettled: false,
    photoPath: '',
    photoStored: '',
    photoSrc: '',
    recognizing: false,
    recognizeMsg: '',
    submitting: false,
  },

  /** 记录原本在云端的照片路径；一旦被替换或移除，这张图就成了无主文件，保存后顺手清掉 */
  originalPhoto: '',

  onLoad: function (query) {
    const page = this
    const app = getApp()
    const id = query && query.id ? Number(query.id) : 0

    app.ready().then(function (session) {
      if (!session) {
        wx.redirectTo({ url: '/pages/login/login' })
        return
      }
      if (id) {
        wx.setNavigationBarTitle({ title: '修改这一笔' })
        page.setData({ editingId: id })
        page.loadRecord(id)
      }
    })
  },

  loadRecord: function (id) {
    const page = this
    wx.showLoading({ title: '加载中', mask: true })
    getRecord(id)
      .then(function (record) {
        wx.hideLoading()
        if (!record) {
          wx.showModal({
            title: '记录不存在',
            content: '这条记录可能已经被删除了',
            showCancel: false,
            success: function () {
              wx.navigateBack()
            },
          })
          return
        }
        const amountText = record.amount === null || record.amount === undefined
          ? ''
          : String(Number(record.amount))
        page.originalPhoto = record.photo_path || ''
        page.setData({
          direction: record.direction === 'out' ? 'out' : 'in',
          contactName: record.contact_name || '',
          amount: amountText === 'NaN' ? '' : amountText,
          eventType: record.event_type || '',
          happenedOn: formatDate(record.happened_on) || todayStr(),
          note: record.note || '',
          isSettled: !!record.is_settled,
          photoStored: record.photo_path || '',
        })
        if (record.photo_path) page.loadStoredPhoto(record.photo_path)
      })
      .catch(function (err) {
        wx.hideLoading()
        wx.showModal({
          title: '加载失败',
          content: (err && err.message) || '请稍后重试',
          showCancel: false,
        })
      })
  },

  loadStoredPhoto: function (objectPath) {
    const page = this
    receiptUrl(objectPath, 3600)
      .then(function (url) {
        page.setData({ photoSrc: url || '' })
      })
      .catch(function () {
        page.setData({ recognizeMsg: '之前的凭证照片暂时打不开，可以重新选一张' })
      })
  },

  /* ------------------------------ 表单交互 ------------------------------ */

  onDirectionTap: function (e) {
    this.setData({ direction: e.currentTarget.dataset.key })
  },

  onNameInput: function (e) {
    this.setData({ contactName: e.detail.value })
  },

  onAmountInput: function (e) {
    this.setData({ amount: e.detail.value })
  },

  onNoteInput: function (e) {
    this.setData({ note: e.detail.value })
  },

  onEventTap: function (e) {
    const value = e.currentTarget.dataset.value
    this.setData({ eventType: this.data.eventType === value ? '' : value })
  },

  onDateChange: function (e) {
    this.setData({ happenedOn: e.detail.value })
  },

  onSettledChange: function (e) {
    this.setData({ isSettled: !!e.detail.value })
  },

  /* ------------------------------ 拍照与识别 ------------------------------ */

  onChoosePhoto: function () {
    const page = this
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      // 取原图：压缩版会先被微信压一道，识别用的手写笔锋就没了。
      // 后续识别与上传各自按需要压缩，这里只负责拿到最完整的像素。
      sizeType: ['original'],
      sourceType: ['album', 'camera'],
      success: function (res) {
        const file = res.tempFiles && res.tempFiles[0]
        if (!file || !file.tempFilePath) return
        page.setData({
          photoPath: file.tempFilePath,
          photoStored: '',
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
    this.setData({ photoPath: '', photoStored: '', photoSrc: '', recognizeMsg: '' })
  },

  runRecognize: function () {
    const page = this
    if (!this.data.photoPath) return

    this.setData({ recognizing: true, recognizeMsg: '' })
    recognizeReceipt(this.data.photoPath)
      .then(function (result) {
        // 把实际干活的模型名带上：识别质量变差时，先要能看出是哪个模型读的
        const by = result.modelName ? visionLabelOf(result.modelName) : ''
        const patch = {
          recognizing: false,
          recognizeMsg: by ? '已用 ' + by + ' 识别，请核对后保存' : '已自动识别，请核对后保存',
        }
        if (result.direction) patch.direction = result.direction
        if (result.contactName) patch.contactName = result.contactName
        if (result.amount) patch.amount = String(result.amount)
        if (result.eventType) patch.eventType = result.eventType
        if (result.happenedOn) patch.happenedOn = result.happenedOn
        if (result.note) patch.note = result.note
        page.setData(patch)
      })
      .catch(function (err) {
        const isNoModel = err && err.code === 'NO_VISION_MODEL'
        page.setData({
          recognizing: false,
          recognizeMsg: isNoModel
            ? '暂时无法自动识别，请手动填写'
            : (err && err.message) || '识别失败，请手动填写',
        })
      })
  },

  /* ------------------------------ 保存 ------------------------------ */

  onSubmit: function () {
    const page = this
    const name = (this.data.contactName || '').trim()
    const amount = Number(this.data.amount)

    if (!name) return wx.showToast({ title: '请填写对方姓名', icon: 'none' })
    if (!isFinite(amount) || amount <= 0) return wx.showToast({ title: '请填写金额', icon: 'none' })
    if (this.data.submitting) return

    this.setData({ submitting: true })
    wx.showLoading({ title: '保存中', mask: true })

    const newLocalPhoto = this.data.photoPath
    const keptPhoto = this.data.photoStored || ''
    const previousPhoto = this.originalPhoto || ''
    // 本次真正上传成功的路径；保存失败时要把它清掉，否则留下无主文件
    let uploadedPhoto = ''

    const preparePhoto = newLocalPhoto
      ? uploadReceipt(newLocalPhoto).then(function (objectPath) {
          uploadedPhoto = objectPath || ''
          return uploadedPhoto
        })
      : Promise.resolve(keptPhoto)

    preparePhoto
      .then(function (finalPhoto) {
        return ensureContact(name, '')
          .catch(function () {
            return null
          })
          .then(function (contact) {
            return { contact: contact, finalPhoto: finalPhoto || '' }
          })
      })
      .then(function (ctx) {
        const payload = {
          contactName: name,
          contactId: ctx.contact ? ctx.contact.id : null,
          direction: page.data.direction,
          amount: amount,
          eventType: page.data.eventType,
          happenedOn: page.data.happenedOn,
          note: page.data.note,
          isSettled: page.data.isSettled,
          photoPath: ctx.finalPhoto,
        }
        return page.data.editingId
          ? updateRecord(page.data.editingId, payload)
          : createRecord(payload)
      })
      .then(function () {
        wx.hideLoading()
        page.setData({ submitting: false })
        // 照片被换掉或被移除。这条记录可能来自批量录入、与几十条记录共享同一张照片，
        // 所以只有确认没人再用时才真删文件
        if (previousPhoto && previousPhoto !== (uploadedPhoto || keptPhoto)) {
          cleanupReceiptIfUnused(previousPhoto)
        }
        wx.showToast({
          title: page.data.editingId ? '已更新' : '已记下',
          icon: 'success',
          duration: 800,
        })
        setTimeout(function () {
          wx.navigateBack()
        }, 600)
      })
      .catch(function (err) {
        wx.hideLoading()
        page.setData({ submitting: false })
        // 记录没存成，刚传上去的那张新图（名字带随机标记，必然是全新的）就没有归属了
        if (uploadedPhoto) cleanupReceipt(uploadedPhoto)
        wx.showModal({
          title: '没能保存',
          content: (err && err.message) || '请检查网络后重试',
          showCancel: false,
          confirmText: '知道了',
        })
      })
  },
})
