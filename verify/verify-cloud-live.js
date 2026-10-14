/**
 * 线上连通性验证：真实网络 + 真实 SDK 路径
 *
 * verify-ledger-paging.js 验证的是「我们拼出的请求对不对」，它桩掉了网络。
 * 这个脚本反过来：请求是真的，用来确认新增的 records_stats() 端点确实已对外
 * 可用 —— 函数建好不等于 PostgREST 的 schema cache 已经认识它，那是两件事。
 *
 * 未带用户会话，auth.uid() 为 null，行级安全会挡住所有行，所以预期拿到的是
 * 一行零值（或空数组）。这里要证明的是「端点存在且可调用」，不是数据对不对。
 */
const path = require('path')

const ROOT = path.join(__dirname, '..')

let lastStatus = 0

global.wx = {
  request: function (options) {
    const method = (options.method || 'GET').toUpperCase()
    const body = typeof options.data === 'string' ? options.data : JSON.stringify(options.data || {})
    fetch(options.url, { method: method, headers: options.header || {}, body: method === 'GET' ? undefined : body })
      .then(function (res) {
        return res.text().then(function (text) {
          let parsed = text
          try {
            parsed = JSON.parse(text)
          } catch (e) {
            parsed = text
          }
          const headers = {}
          res.headers.forEach(function (value, key) {
            headers[key] = value
          })
          lastStatus = res.status
          if (options.success) {
            options.success({ statusCode: res.status, data: parsed, header: headers })
          }
          if (options.complete) options.complete({})
        })
      })
      .catch(function (err) {
        lastStatus = 0
        if (options.fail) options.fail({ errMsg: 'request:fail ' + err.message })
        if (options.complete) options.complete({})
      })
  },
  getStorageSync: function () {
    return ''
  },
  setStorageSync: function () {},
  removeStorageSync: function () {},
  getAccountInfoSync: function () {
    return { miniProgram: { appId: 'wxlivecheck000000' } }
  },
}

global.Page = function () {}
global.App = function () {}
global.Component = function () {}
global.getApp = function () {
  return { ready: function () { return Promise.resolve(null) } }
}
global.getCurrentPages = function () {
  return []
}

const db = require(path.join(ROOT, 'utils', 'db.js'))

async function main() {
  console.log('endpoint: https://mp-api.app.workbuddy.host')
  console.log('')

  console.log('[1] rpc records_stats —— 新增的服务端聚合端点')
  try {
    const stats = await db.getRecordsStats()
    console.log('    HTTP ' + lastStatus)
    console.log('    返回 ' + JSON.stringify(stats))
    if (lastStatus === 200) {
      console.log('    结论：端点存在且可调用（未带会话，行级安全挡住数据属预期）')
    } else {
      console.log('    结论：非 200，需要排查函数是否已进入 PostgREST schema cache')
    }
  } catch (e) {
    console.log('    抛错：' + e.message + '（code=' + (e.code || '') + '）')
    console.log('    若 code 为 PGRST202，说明函数没进 schema cache —— 需要 NOTIFY pgrst 重载')
  }

  console.log('')
  console.log('[2] records 分页查询')
  try {
    const page = await db.listRecordsPage({ settled: 'all', direction: 'all' }, 0)
    console.log('    HTTP ' + lastStatus)
    console.log('    rows=' + page.rows.length + ' hasMore=' + page.hasMore)
    console.log('    结论：分页参数被服务端接受（200 即说明 offset/limit/order 合法）')
  } catch (e) {
    console.log('    抛错：' + e.message + '（code=' + (e.code || '') + '）')
  }

  console.log('')
  console.log('[3] 未结记录查询')
  try {
    const pending = await db.listPendingRecords()
    console.log('    HTTP ' + lastStatus)
    console.log('    未结 ' + pending.length + ' 条')
  } catch (e) {
    console.log('    抛错：' + e.message + '（code=' + (e.code || '') + '）')
  }
}

main().catch(function (e) {
  console.log('脚本异常：' + (e && e.stack))
})
