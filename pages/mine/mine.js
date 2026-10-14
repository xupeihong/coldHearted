const { cloud } = require('../../utils/cloud')
const { getRecordsStats } = require('../../utils/db')
const {
  REMIND_OPTIONS,
  getRemindThreshold,
  setRemindThreshold,
  thresholdLabel,
  thresholdHint,
  VISION_MODEL_OPTIONS,
  getVisionModel,
  setVisionModel,
  visionModelLabel,
  visionModelHint,
} = require('../../utils/settings')

Page({
  data: {
    loading: true,
    accountLabel: '未登录',
    accountSub: '',
    remindOptions: REMIND_OPTIONS,
    remindThreshold: 90,
    remindHint: '',
    visionOptions: VISION_MODEL_OPTIONS,
    visionModel: '',
    visionHint: '',
    summary: {
      recordCount: 0,
      peopleCount: 0,
      pendingCount: 0,
    },
  },

  onShow: function () {
    const page = this
    const app = getApp()
    const threshold = getRemindThreshold()
    const visionModel = getVisionModel()

    this.setData({
      remindThreshold: threshold,
      remindHint: thresholdHint(threshold),
      visionModel: visionModel,
      visionHint: visionModelHint(visionModel),
    })

    app.refreshSession().then(function (session) {
      if (!session) {
        wx.redirectTo({ url: '/pages/login/login' })
        return
      }
      const user = session.user || {}
      const label = user.email || (user.phone ? String(user.phone).replace(/(\d{3})\d{4}(\d{4})/, '$1****$2') : '微信用户')
      page.setData({
        accountLabel: label,
        accountSub: user.id ? '账号 ID ' + String(user.id).slice(0, 10) : '',
      })
      page.loadSummary()
    })
  },

  loadSummary: function () {
    const page = this
    // 三个数字都是全量口径但不含明细，交给数据库聚合，不必把整本账拉到本地来数
    getRecordsStats()
      .then(function (stats) {
        page.setData({
          loading: false,
          summary: {
            recordCount: stats.totalCount,
            peopleCount: stats.peopleCount,
            pendingCount: stats.oweCount + stats.backCount,
          },
        })
      })
      .catch(function () {
        page.setData({ loading: false })
      })
  },

  onThresholdTap: function (e) {
    const next = setRemindThreshold(Number(e.currentTarget.dataset.value))
    this.setData({
      remindThreshold: next,
      remindHint: thresholdHint(next),
    })
    wx.showToast({ title: '已设为 ' + thresholdLabel(next), icon: 'none' })
  },

  onVisionTap: function (e) {
    const next = setVisionModel(e.currentTarget.dataset.id)
    this.setData({
      visionModel: next,
      visionHint: visionModelHint(next),
    })
    wx.showToast({ title: '识别模型已切换为 ' + visionModelLabel(next), icon: 'none' })
  },

  onSignOut: function () {
    wx.showModal({
      title: '退出登录？',
      content: '账本保存在云端，下次登录还能看到。',
      confirmText: '退出',
      success: function (res) {
        if (!res.confirm) return
        wx.showLoading({ title: '退出中', mask: true })
        cloud.auth
          .signOut()
          .then(function () {
            wx.hideLoading()
            const app = getApp()
            app.refreshSession().then(function () {
              wx.reLaunch({ url: '/pages/login/login' })
            })
          })
          .catch(function () {
            wx.hideLoading()
            wx.showToast({ title: '退出失败，请重试', icon: 'none' })
          })
      },
    })
  },
})
