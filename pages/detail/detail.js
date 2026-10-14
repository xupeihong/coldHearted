const { getRecord, setRecordSettled, removeRecord } = require('../../utils/db')
const { receiptUrl } = require('../../utils/storage')
const { formatAmount, formatDate } = require('../../utils/format')

Page({
  data: {
    loading: true,
    errorMsg: '',
    record: null,
    photoUrl: '',
    busy: false,
  },

  recordId: 0,

  onLoad: function (query) {
    this.recordId = query && query.id ? Number(query.id) : 0
  },

  onShow: function () {
    this.load()
  },

  load: function () {
    const page = this
    if (!this.recordId) {
      this.setData({ loading: false, errorMsg: '缺少记录编号' })
      return
    }

    const app = getApp()
    app.ready().then(function (session) {
      if (!session) {
        wx.redirectTo({ url: '/pages/login/login' })
        return
      }
      page.setData({ loading: true, errorMsg: '' })
      getRecord(page.recordId)
        .then(function (record) {
          if (!record) {
            page.setData({ loading: false, record: null, errorMsg: '这条记录已经不在了' })
            return
          }
          page.render(record)
        })
        .catch(function (err) {
          page.setData({ loading: false, errorMsg: (err && err.message) || '加载失败，请下拉重试' })
        })
    })
  },

  render: function (record) {
    const page = this
    const direction = record.direction === 'out' ? 'out' : 'in'
    const isSettled = !!record.is_settled

    let statusText
    if (direction === 'in') {
      statusText = isSettled ? '已还清' : '还没还'
    } else {
      statusText = isSettled ? '已回过' : '还没回'
    }

    this.setData({
      loading: false,
      errorMsg: '',
      record: {
        id: record.id,
        name: record.contact_name || '未署名',
        direction: direction,
        directionText: direction === 'in' ? '收礼' : '送礼',
        directionHint: direction === 'in' ? '别人给我的' : '我给出去的',
        isSettled: isSettled,
        statusText: statusText,
        amountText: formatAmount(record.amount),
        eventType: record.event_type || '未填写',
        dateText: formatDate(record.happened_on) || '未填写',
        note: record.note || '',
        settledText: isSettled && record.settled_at ? formatDate(record.settled_at) : '',
        hasPhoto: !!record.photo_path,
      },
    })

    if (record.photo_path) {
      receiptUrl(record.photo_path, 3600)
        .then(function (url) {
          page.setData({ photoUrl: url || '' })
        })
        .catch(function () {
          page.setData({ photoUrl: '' })
        })
    } else {
      this.setData({ photoUrl: '' })
    }
  },

  onToggleSettled: function () {
    const page = this
    const record = this.data.record
    if (!record || this.data.busy) return

    const next = !record.isSettled
    this.setData({ busy: true })
    setRecordSettled(record.id, next)
      .then(function () {
        page.setData({ busy: false })
        wx.showToast({ title: next ? '已划掉' : '已恢复', icon: 'none' })
        page.load()
      })
      .catch(function (err) {
        page.setData({ busy: false })
        wx.showToast({ title: (err && err.message) || '操作失败，请重试', icon: 'none' })
      })
  },

  onPreviewPhoto: function () {
    if (!this.data.photoUrl) return
    wx.previewImage({ urls: [this.data.photoUrl], current: this.data.photoUrl })
  },

  onEdit: function () {
    wx.navigateTo({ url: '/pages/add/add?id=' + this.recordId })
  },

  onDelete: function () {
    const page = this
    wx.showModal({
      title: '删除这笔记录？',
      content: '删除后无法恢复，凭证照片也会一并移除。',
      confirmText: '删除',
      confirmColor: '#C0392B',
      success: function (res) {
        if (!res.confirm) return
        wx.showLoading({ title: '删除中', mask: true })
        removeRecord(page.recordId)
          .then(function () {
            wx.hideLoading()
            wx.showToast({ title: '已删除', icon: 'success', duration: 800 })
            setTimeout(function () {
              wx.navigateBack()
            }, 600)
          })
          .catch(function (err) {
            wx.hideLoading()
            wx.showModal({
              title: '没能删除',
              content: (err && err.message) || '请稍后重试',
              showCancel: false,
            })
          })
      },
    })
  },
})
