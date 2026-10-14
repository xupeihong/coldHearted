const { getSession } = require('./utils/db')

App({
  globalData: {
    session: null,
    sessionReady: null,
  },

  onLaunch: function () {
    const app = this
    app.globalData.sessionReady = getSession().then(function (session) {
      app.globalData.session = session
      return session
    })
  },

  /** 页面在 onShow 中调用，拿到最新登录态 */
  ready: function () {
    if (!this.globalData.sessionReady) {
      const app = this
      app.globalData.sessionReady = getSession().then(function (session) {
        app.globalData.session = session
        return session
      })
    }
    return this.globalData.sessionReady
  },

  refreshSession: function () {
    const app = this
    app.globalData.sessionReady = getSession().then(function (session) {
      app.globalData.session = session
      return session
    })
    return app.globalData.sessionReady
  },
})
