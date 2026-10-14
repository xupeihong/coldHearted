const { cloud } = require('../../utils/cloud')

/**
 * 登录类错误统一用这个文案函数：**保留服务端给出的原因**，不做「一律翻成会话失效」的归一化。
 *
 * 微信登录与短信验证码登录失败，最常见的根因都在配置侧：小程序没绑定、云服务的微信登录
 * 开关没开、手机号登录没开、权限集被别的服务商占用。这些原因都写在服务端的 message 里。
 * 若把 401 / invalid_grant 一律翻成「登录状态已失效，请重新登录」，用户会去重新登录，而
 * 问题根本不在登录态——真实原因被整条吞掉。
 */
function authErrorText(error, label) {
  const base = label || '登录失败'
  if (!error) return base + '，请重试'
  const kind = error.kind || ''
  if (kind === 'network') return '网络不稳定，请稍后重试'
  if (kind === 'backend-unavailable') return '服务暂时不可用，请稍后重试'
  const detail = error.message || error.code || ''
  // 服务端没给描述时 message 会退化成 "HTTP 401" 这类无信息量的串，不值得显示
  if (!detail || detail === 'HTTP ' + error.status) return base + '，请重试'
  return base + '：' + detail
}

/**
 * 归一化手机号：只保留数字，并把 0086 / 86 前缀去掉，返回 11 位本地号。
 *
 * 与 SDK 内部 `normalizePhone` 的口径保持一致（它负责补回 `+86 ` 前缀），这样「校验通过的
 * 号」与「真正发出去的号」不会出现分叉。
 */
function localPhone(input) {
  const digits = String(input || '').replace(/\D/g, '')
  if (digits.indexOf('0086') === 0) return digits.slice(4)
  if (digits.indexOf('86') === 0 && digits.length === 13) return digits.slice(2)
  return digits
}

function isValidPhone(local) {
  return /^1\d{10}$/.test(local)
}

Page({
  data: {
    mode: 'wechat',
    phone: '',
    code: '',
    countdown: 0,
    sending: false,
    submitting: false,
    busy: false,
    errorMsg: '',
    notice: '',
  },

  // 验证码挑战放在页面实例上，不参与渲染
  pendingOtp: null,
  countdownTimer: null,

  onLoad: function () {
    const app = getApp()
    const page = this
    app.ready().then(function (session) {
      if (session) page.leave()
    })
  },

  onUnload: function () {
    if (this.countdownTimer) {
      clearInterval(this.countdownTimer)
      this.countdownTimer = null
    }
  },

  /* ------------------------------ 模式切换 ------------------------------ */

  switchToPhone: function () {
    this.setData({ mode: 'phone', errorMsg: '', notice: '' })
  },

  switchToWechat: function () {
    this.setData({ mode: 'wechat', errorMsg: '', notice: '' })
  },

  /* ------------------------------ 表单输入 ------------------------------ */

  onPhoneInput: function (e) {
    this.setData({ phone: e.detail.value })
  },

  onCodeInput: function (e) {
    this.setData({ code: e.detail.value })
  },

  /* ------------------------------ 微信一键登录 ------------------------------ */

  onWechatLogin: function () {
    if (this.data.busy) return
    const page = this
    this.setData({ busy: true, errorMsg: '', notice: '' })

    wx.login({
      success: function (res) {
        if (!res || !res.code) {
          page.setData({ busy: false, errorMsg: '没能获取微信授权，请重试' })
          return
        }
        let appid = ''
        try {
          appid = wx.getAccountInfoSync().miniProgram.appId
        } catch (e) {
          appid = ''
        }
        cloud.auth
          .signInWithWechat(res.code, appid)
          .then(function (result) {
            if (result && result.error) {
              page.setData({ busy: false, errorMsg: authErrorText(result.error, '微信登录失败') })
              return
            }
            page.afterSignedIn()
          })
          .catch(function (err) {
            const message = err && err.message ? err.message : '微信登录失败，请重试'
            console.error(
              '[WorkBuddy Cloud] login failed',
              JSON.stringify({ stage: 'wechat-login-handler', message: message })
            )
            page.setData({ busy: false, errorMsg: authErrorText(err, '微信登录失败') })
          })
      },
      fail: function (err) {
        const message = (err && err.errMsg) || '没能获取微信授权，请重试'
        console.error(
          '[WorkBuddy Cloud] login failed',
          JSON.stringify({ stage: 'wx.login', message: message })
        )
        page.setData({ busy: false, errorMsg: message })
      },
    })
  },

  /* ------------------------------ 手机号验证码 ------------------------------ */

  onSendCode: function () {
    const local = localPhone(this.data.phone)
    if (!local) return this.setData({ errorMsg: '请先填写手机号' })
    if (!isValidPhone(local)) return this.setData({ errorMsg: '手机号格式不正确，请填写 11 位手机号' })
    if (this.data.sending || this.data.countdown > 0) return

    const page = this
    this.setData({ sending: true, errorMsg: '', notice: '' })
    cloud.auth
      .sendOtp({ phone: local })
      .then(function (result) {
        if (result && result.error) {
          page.setData({ sending: false, errorMsg: authErrorText(result.error, '验证码发送失败') })
          return
        }
        const data = result ? result.data : null
        if (!data || !data.verificationId) {
          page.setData({ sending: false, errorMsg: '验证码发送失败，请稍后重试' })
          return
        }
        // isExistingUser 由服务端判定：决定验码后是登录还是注册，客户端不猜
        page.pendingOtp = {
          phone: local,
          verificationId: data.verificationId,
          isExistingUser: !!data.isExistingUser,
        }
        page.setData({ sending: false, notice: '验证码已发送，请查看短信', countdown: 60 })
        page.startCountdown()
      })
      .catch(function (err) {
        const message = err && err.message ? err.message : ''
        console.error(
          '[WorkBuddy Cloud] login failed',
          JSON.stringify({ stage: 'send-otp', message: message })
        )
        page.setData({ sending: false, errorMsg: authErrorText(err, '验证码发送失败') })
      })
  },

  startCountdown: function () {
    const page = this
    if (this.countdownTimer) clearInterval(this.countdownTimer)
    this.countdownTimer = setInterval(function () {
      const next = page.data.countdown - 1
      if (next <= 0) {
        clearInterval(page.countdownTimer)
        page.countdownTimer = null
        page.setData({ countdown: 0 })
        return
      }
      page.setData({ countdown: next })
    }, 1000)
  },

  onSubmitOtp: function () {
    const page = this
    const local = localPhone(this.data.phone)
    const code = (this.data.code || '').trim()
    const pending = this.pendingOtp

    if (!pending || pending.phone !== local) {
      return this.setData({ errorMsg: '请先获取当前手机号的验证码' })
    }
    if (!code) return this.setData({ errorMsg: '请填写验证码' })

    this.setData({ submitting: true, errorMsg: '', notice: '' })
    cloud.auth
      .verifyOtp({
        phone: pending.phone,
        verificationId: pending.verificationId,
        isExistingUser: pending.isExistingUser,
        token: code,
      })
      .then(function (result) {
        if (result && result.error) {
          page.setData({ submitting: false, errorMsg: authErrorText(result.error, '验证码不正确或已过期') })
          return
        }
        page.pendingOtp = null
        page.afterSignedIn()
      })
      .catch(function (err) {
        const message = err && err.message ? err.message : ''
        console.error(
          '[WorkBuddy Cloud] login failed',
          JSON.stringify({ stage: 'verify-otp', message: message })
        )
        page.setData({ submitting: false, errorMsg: authErrorText(err, '验证失败，请稍后重试') })
      })
  },

  /* ------------------------------ 收尾 ------------------------------ */

  afterSignedIn: function () {
    const page = this
    const app = getApp()
    this.setData({ submitting: false, busy: false })
    app.refreshSession().then(function () {
      wx.showToast({ title: '登录成功', icon: 'success', duration: 800 })
      setTimeout(function () {
        page.leave()
      }, 500)
    })
  },

  leave: function () {
    const pages = getCurrentPages()
    if (pages.length > 1) {
      wx.navigateBack()
      return
    }
    wx.switchTab({ url: '/pages/index/index' })
  },
})
