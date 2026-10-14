/**
 * 登录页（微信 + 手机号验证码）行为验证
 *
 * 桩掉 global.wx，从「页面方法 → utils/cloud → 内置 SDK」走完整真实链路，
 * 断言真正发出去的 URL 与请求体。覆盖：发码、归一化、验码登录/注册、错误原文保真、微信登录回归。
 *
 * 运行：node verify-login-phone.js
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const realSetTimeout = global.setTimeout

/* ------------------------------ 断言工具 ------------------------------ */

let passed = 0
let failed = 0
const failures = []

function check(name, cond, extra) {
  if (cond) {
    passed += 1
    return
  }
  failed += 1
  const line = name + (extra === undefined ? '' : '  → 实际：' + JSON.stringify(extra))
  failures.push(line)
  console.log('  x ' + line)
}

function group(title) {
  console.log('\n== ' + title + ' ==')
}

/**
 * 推进事件循环：SDK 内部 request → fetch → readBody 有多层 await，
 * 单次 setImmediate 不足以让整条链落地，这里固定跑几个真实定时器回合。
 */
const tick = async function (rounds) {
  const n = rounds || 4
  for (let i = 0; i < n; i += 1) {
    await new Promise((resolve) => realSetTimeout(resolve, 1))
  }
}

/* ------------------------------ wx 桩 ------------------------------ */

const requests = []
const toasts = []
const navigations = []
let refreshSessionCalls = 0
let responder = function () {
  return { statusCode: 200, data: {} }
}

const storage = {}

global.wx = {
  request(options) {
    const entry = {
      url: options.url,
      method: (options.method || 'GET').toUpperCase(),
      data: options.data,
      header: options.header,
    }
    requests.push(entry)
    const res = responder(entry)
    if (res && res.fail) {
      realSetTimeout(function () {
        options.fail({ errMsg: res.fail })
      }, 0)
      return
    }
    realSetTimeout(function () {
      options.success({ statusCode: res.statusCode, data: res.data, header: res.header || {} })
    }, 0)
  },
  getStorageSync(key) {
    return Object.prototype.hasOwnProperty.call(storage, key) ? storage[key] : ''
  },
  setStorageSync(key, value) {
    storage[key] = value
  },
  removeStorageSync(key) {
    delete storage[key]
  },
  getAccountInfoSync() {
    return { miniProgram: { appId: 'wxab9842575a865463' } }
  },
  login(options) {
    realSetTimeout(function () {
      options.success({ code: 'wx-code-1' })
    }, 0)
  },
  showToast(options) {
    toasts.push(options)
  },
  navigateBack() {
    navigations.push('back')
  },
  switchTab(options) {
    navigations.push(options.url)
  },
}

global.getApp = function () {
  return {
    ready: function () {
      return Promise.resolve(null)
    },
    refreshSession: function () {
      refreshSessionCalls += 1
      return Promise.resolve({ accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 1e6, user: { id: 'u1' } })
    },
  }
}

global.getCurrentPages = function () {
  return [{}]
}

// 页面里的倒计时与跳转延迟不需要真的跑
global.setInterval = function () {
  return 1
}
global.clearInterval = function () {}

/* ------------------------------ 载入页面 ------------------------------ */

let capturedPage = null
global.Page = function (config) {
  capturedPage = config
}

require(path.join(ROOT, 'pages', 'login', 'login.js'))

check('Page 配置已捕获', !!capturedPage)

function makePage() {
  const page = Object.assign({}, capturedPage)
  page.data = JSON.parse(JSON.stringify(capturedPage.data))
  page.setData = function (patch) {
    Object.assign(this.data, patch)
  }
  page.pendingOtp = null
  page.countdownTimer = null
  return page
}

/* ------------------------------ 响应路由 ------------------------------ */

const SESSION = {
  access_token: 'at-1',
  refresh_token: 'rt-1',
  expires_in: 3600,
  sub: 'phone-13800000000',
  phone_number: '+86 13800000000',
}

function route(map, fallback) {
  return function (entry) {
    const url = entry.url.split('?')[0]
    for (const key of Object.keys(map)) {
      if (url.endsWith(key)) return map[key]
    }
    if (fallback) return fallback(entry)
    return { statusCode: 200, data: {} }
  }
}

const authTail = (entry) => entry.url.split('?')[0].split('/').slice(-2).join('/')

function bodyOf(entry) {
  if (entry.data === undefined) return {}
  if (typeof entry.data === 'string') {
    try {
      return JSON.parse(entry.data)
    } catch (e) {
      return { __raw: entry.data }
    }
  }
  return entry.data
}

/* ------------------------------ 主流程 ------------------------------ */

async function main() {
  /* ============================================================== */
  /* A. 代码清理                                                     */
  /* ============================================================== */

  group('A. 邮箱登录是否已彻底移除')

  const loginJs = fs.readFileSync(path.join(ROOT, 'pages', 'login', 'login.js'), 'utf8')
  const loginWxml = fs.readFileSync(path.join(ROOT, 'pages', 'login', 'login.wxml'), 'utf8')
  const loginWxss = fs.readFileSync(path.join(ROOT, 'pages', 'login', 'login.wxss'), 'utf8')
  const privacy = fs.readFileSync(path.join(ROOT, '.wbapp_w0B3ojZ3u0oeql2enxe8rr.privacy.json'), 'utf8')

  check('login.js 不再出现 email', !/email/i.test(loginJs))
  check('login.js 不再调用 signInWithPassword', loginJs.indexOf('signInWithPassword') < 0)
  check('login.js 不再调用 resetPasswordForEmail', loginJs.indexOf('resetPasswordForEmail') < 0)
  check('login.wxml 不再出现邮箱', loginWxml.indexOf('邮箱') < 0 && loginWxml.indexOf('email') < 0)
  check('login.wxss 已清掉死掉的 tab 样式', loginWxss.indexOf('.tabs') < 0 && loginWxss.indexOf('.tab-on') < 0)
  check('隐私清单改为声明手机号', privacy.indexOf('PhoneNumber') >= 0 && privacy.indexOf('Email') < 0)

  /* ============================================================== */
  /* B. 发码                                                         */
  /* ============================================================== */

  group('B. 手机号发码')

  async function sendCode(page, phone, response) {
    requests.length = 0
    page.setData({ phone: phone })
    responder = route(
      response || { '/v1/verification': { statusCode: 200, data: { verification_id: 'vid-1', is_user: false } } }
    )
    page.onSendCode()
    await tick()
    await tick()
  }

  {
    const page = makePage()
    await sendCode(page, '13800000000')
    check('发码发出一次请求', requests.length === 1, requests.length)
    check(
      '发码打到 /.cloud/auth/v1/verification',
      requests[0].url.indexOf('/.cloud/auth/v1/verification') >= 0,
      requests[0].url
    )
    check('发码用 POST', requests[0].method === 'POST', requests[0].method)
    const body = bodyOf(requests[0])
    check('请求体带 +86 前缀的手机号', body.phone_number === '+86 13800000000', body)
    check('请求体 target=ANY', body.target === 'ANY', body)
    check('请求体不带 email', body.email === undefined, body)
    check('请求体不带 usage（短信分支不传）', body.usage === undefined, body)
    check('成功后提示已发送短信', page.data.notice.indexOf('短信') >= 0, page.data.notice)
    check('成功后进入 60 秒倒计时', page.data.countdown === 60, page.data.countdown)
    check(
      '成功后缓存挑战信息',
      page.pendingOtp && page.pendingOtp.verificationId === 'vid-1' && page.pendingOtp.phone === '13800000000',
      page.pendingOtp
    )
    check('发码期间不残留错误', page.data.errorMsg === '', page.data.errorMsg)
  }

  {
    const page = makePage()
    await sendCode(page, '')
    check('空手机号不发请求', requests.length === 0, requests.length)
    check('空手机号给出提示', page.data.errorMsg === '请先填写手机号', page.data.errorMsg)
  }

  {
    const page = makePage()
    await sendCode(page, '1380013800')
    check('10 位手机号不发请求', requests.length === 0, requests.length)
    check('10 位手机号提示格式错误', page.data.errorMsg.indexOf('格式不正确') >= 0, page.data.errorMsg)
  }

  {
    const page = makePage()
    await sendCode(page, '138 0000 0000')
    check('带空格的手机号可归一化', bodyOf(requests[0]).phone_number === '+86 13800000000', bodyOf(requests[0]))
  }

  {
    const page = makePage()
    await sendCode(page, '008613800000000')
    check('0086 前缀可归一化', bodyOf(requests[0]).phone_number === '+86 13800000000', bodyOf(requests[0]))
  }

  {
    const page = makePage()
    await sendCode(page, '13800000000')
    requests.length = 0
    page.onSendCode()
    await tick()
    check('倒计时中重复点击不再发码', requests.length === 0, requests.length)
  }

  /* ============================================================== */
  /* C. 验码登录 / 注册                                              */
  /* ============================================================== */

  group('C. 验码登录与注册')

  {
    const page = makePage()
    await sendCode(page, '13800000000')
    page.setData({ phone: '13900000000', code: '123456' })
    requests.length = 0
    page.onSubmitOtp()
    await tick()
    check('换了手机号后不发请求', requests.length === 0, requests.length)
    check('换了手机号后要求重新获取', page.data.errorMsg === '请先获取当前手机号的验证码', page.data.errorMsg)
  }

  {
    const page = makePage()
    requests.length = 0
    page.setData({ phone: '13800000000', code: '123456' })
    page.onSubmitOtp()
    await tick()
    check('未发码直接提交不发请求', requests.length === 0, requests.length)
    check('未发码直接提交给出提示', page.data.errorMsg === '请先获取当前手机号的验证码', page.data.errorMsg)
  }

  {
    const page = makePage()
    await sendCode(page, '13800000000', {
      '/v1/verification': { statusCode: 200, data: { verification_id: 'vid-2', is_user: true } },
    })
    page.setData({ code: '' })
    requests.length = 0
    page.onSubmitOtp()
    await tick()
    check('验证码为空不发请求', requests.length === 0, requests.length)
    check('验证码为空给出提示', page.data.errorMsg === '请填写验证码', page.data.errorMsg)
  }

  {
    // 老用户：验码 → 登录
    const page = makePage()
    await sendCode(page, '13800000000', {
      '/v1/verification': { statusCode: 200, data: { verification_id: 'vid-3', is_user: true } },
    })
    requests.length = 0
    refreshSessionCalls = 0
    toasts.length = 0
    responder = route({
      '/v1/verification/verify': { statusCode: 200, data: { verification_token: 'vt-9' } },
      '/v1/signin': { statusCode: 200, data: SESSION },
    })
    page.setData({ code: '654321' })
    page.onSubmitOtp()
    await tick()
    await tick()
    await tick()
    check('老用户走两步：验码 + 登录', requests.length === 2, requests.map(authTail))
    check('第一步打到 /v1/verification/verify', requests[0].url.indexOf('/v1/verification/verify') >= 0, requests[0].url)
    const verifyBody = bodyOf(requests[0])
    check(
      '验码请求体用 verification_id + verification_code',
      verifyBody.verification_id === 'vid-3' && verifyBody.verification_code === '654321',
      verifyBody
    )
    check('第二步打到 /v1/signin', requests[1].url.indexOf('/v1/signin') >= 0, requests[1].url)
    const signinBody = bodyOf(requests[1])
    check('登录请求体 username 为带前缀手机号', signinBody.username === '+86 13800000000', signinBody)
    check('登录请求体带一次性票据', signinBody.verification_token === 'vt-9', signinBody)
    check('登录请求体不带密码', signinBody.password === undefined, signinBody)
    check('登录成功刷新会话', refreshSessionCalls === 1, refreshSessionCalls)
    check('登录成功提示', toasts.length === 1 && toasts[0].title === '登录成功', toasts)
    check('挑战信息用完即清', page.pendingOtp === null, page.pendingOtp)
  }

  {
    // 新用户：验码 → 注册（不应带密码）
    const page = makePage()
    await sendCode(page, '13700000000', {
      '/v1/verification': { statusCode: 200, data: { verification_id: 'vid-4', is_user: false } },
    })
    requests.length = 0
    refreshSessionCalls = 0
    toasts.length = 0
    responder = route({
      '/v1/verification/verify': { statusCode: 200, data: { verification_token: 'vt-10' } },
      '/v1/signup': { statusCode: 200, data: SESSION },
    })
    page.setData({ code: '111111' })
    page.onSubmitOtp()
    await tick()
    await tick()
    await tick()
    check(
      '新用户第二步打到 /v1/signup',
      requests.length === 2 && requests[1].url.indexOf('/v1/signup') >= 0,
      requests.map(authTail)
    )
    const signupBody = bodyOf(requests[1])
    check('注册请求体用 phone_number', signupBody.phone_number === '+86 13700000000', signupBody)
    check('注册请求体带一次性票据', signupBody.verification_token === 'vt-10', signupBody)
    check('注册请求体不带密码（免密注册）', signupBody.password === undefined, signupBody)
    check(
      '注册后同样完成登录收尾',
      refreshSessionCalls === 1 && toasts.length === 1,
      { refreshSessionCalls: refreshSessionCalls, toasts: toasts }
    )
  }

  /* ============================================================== */
  /* D. 错误原文保真                                                 */
  /* ============================================================== */

  group('D. 错误文案保真')

  {
    const page = makePage()
    await sendCode(page, '13800000000', {
      '/v1/verification': { statusCode: 401, data: { message: 'phone login is disabled' } },
    })
    check('发码失败保留服务端原因', page.data.errorMsg.indexOf('phone login is disabled') >= 0, page.data.errorMsg)
    check('发码失败不被误报成会话失效', page.data.errorMsg.indexOf('登录状态已失效') < 0, page.data.errorMsg)
    check('发码失败不进入倒计时', page.data.countdown === 0, page.data.countdown)
    check('发码失败不缓存挑战信息', page.pendingOtp === null, page.pendingOtp)
  }

  {
    const page = makePage()
    await sendCode(page, '13800000000', {
      '/v1/verification': { statusCode: 200, data: { verification_id: 'vid-5', is_user: true } },
    })
    responder = route({
      '/v1/verification/verify': { statusCode: 400, data: { message: 'verification code expired' } },
    })
    page.setData({ code: '000000' })
    page.onSubmitOtp()
    await tick()
    await tick()
    check('验码失败保留服务端原因', page.data.errorMsg.indexOf('verification code expired') >= 0, page.data.errorMsg)
    check('验码失败不误报成会话失效', page.data.errorMsg.indexOf('登录状态已失效') < 0, page.data.errorMsg)
  }

  {
    const page = makePage()
    requests.length = 0
    responder = route({}, function () {
      return { fail: 'request:fail timeout' }
    })
    page.setData({ phone: '13800000000' })
    page.onSendCode()
    await tick()
    await tick()
    check('网络异常给出可读提示', page.data.errorMsg === '网络不稳定，请稍后重试', page.data.errorMsg)
  }

  {
    const page = makePage()
    await sendCode(page, '13800000000', { '/v1/verification': { statusCode: 500, data: {} } })
    check('服务端 5xx 归为服务不可用', page.data.errorMsg === '服务暂时不可用，请稍后重试', page.data.errorMsg)
  }

  {
    const page = makePage()
    await sendCode(page, '13800000000', { '/v1/verification': { statusCode: 400, data: {} } })
    check('无服务端描述时退化为可读文案', page.data.errorMsg === '验证码发送失败，请重试', page.data.errorMsg)
  }

  /* ============================================================== */
  /* E. 微信登录回归                                                 */
  /* ============================================================== */

  group('E. 微信登录回归')

  {
    const page = makePage()
    requests.length = 0
    refreshSessionCalls = 0
    responder = route({ '/v1/login-wechat': { statusCode: 200, data: SESSION } })
    page.onWechatLogin()
    await tick()
    await tick()
    await tick()
    check(
      '微信登录打到 /.cloud/auth/v1/login-wechat',
      requests.length === 1 && requests[0].url.indexOf('/.cloud/auth/v1/login-wechat') >= 0,
      requests[0] && requests[0].url
    )
    const body = bodyOf(requests[0])
    check('微信登录请求体带 code', body.code === 'wx-code-1', body)
    check('微信登录请求体带运行时 appid', body.appid === 'wxab9842575a865463', body)
    check('微信登录成功后刷新会话', refreshSessionCalls === 1, refreshSessionCalls)
  }

  {
    const page = makePage()
    responder = route({
      '/v1/login-wechat': {
        statusCode: 401,
        data: { message: 'wechat login is not enabled for this application' },
      },
    })
    page.onWechatLogin()
    await tick()
    await tick()
    check(
      '微信登录失败保留服务端原因',
      page.data.errorMsg.indexOf('wechat login is not enabled') >= 0,
      page.data.errorMsg
    )
  }

  /* ------------------------------ 汇总 ------------------------------ */

  console.log('\n' + '='.repeat(56))
  if (failed === 0) {
    console.log('全部通过：' + passed + ' 项断言')
  } else {
    console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项：')
    failures.forEach(function (item) {
      console.log('  x ' + item)
    })
  }
  console.log('='.repeat(56))
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(function (err) {
  console.error('脚本自身异常：', err)
  process.exit(1)
})
