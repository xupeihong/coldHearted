/**
 * 账本页分页 + 服务端聚合 的端到端验证
 *
 * 走真实代码路径：utils/db.js → utils/cloud.js → 内置 SDK → 桩掉的 wx.request。
 * 断言直接检查 SDK 最终拼出的 URL 与查询参数，而不是我们自己的中间变量 ——
 * 分页/筛选的正确性就住在那些参数里。
 *
 * 放在工作区根目录，不属于小程序工程，不会被打包。
 */
const path = require('path')

const ROOT = path.join(__dirname, '..')

/* --------------------------- wx.request 桩 --------------------------- */

let requests = []
let responder = function () {
  return { statusCode: 200, data: [] }
}
let pullDownCalls = 0

global.wx = {
  request: function (options) {
    const entry = {
      url: options.url,
      method: (options.method || 'GET').toUpperCase(),
      header: options.header || {},
      data: options.data,
    }
    requests.push(entry)
    let result
    try {
      result = responder(entry) || { statusCode: 200, data: [] }
    } catch (e) {
      result = { statusCode: 200, data: [] }
    }
    setTimeout(function () {
      if (options.success) {
        options.success({
          statusCode: result.statusCode || 200,
          data: result.data,
          header: result.header || {},
        })
      }
      if (options.complete) options.complete({})
    }, 0)
  },
  getStorageSync: function () {
    return ''
  },
  setStorageSync: function () {},
  removeStorageSync: function () {},
  getAccountInfoSync: function () {
    return { miniProgram: { appId: 'wxunittest0000000' } }
  },
  showToast: function () {},
  showLoading: function () {},
  hideLoading: function () {},
  navigateTo: function () {},
  redirectTo: function () {},
  stopPullDownRefresh: function () {
    pullDownCalls += 1
  },
}

let capturedPage = null
global.Page = function (config) {
  capturedPage = config
}
global.App = function () {}
global.Component = function () {}

global.getApp = function () {
  return {
    ready: function () {
      return Promise.resolve({ user: { id: 'unit-user' } })
    },
    refreshSession: function () {
      return Promise.resolve({ user: { id: 'unit-user' } })
    },
  }
}
global.getCurrentPages = function () {
  return []
}

const db = require(path.join(ROOT, 'utils', 'db.js'))
const indexPage = require(path.join(ROOT, 'pages', 'index', 'index.js'))

/* ----------------------------- 断言框架 ----------------------------- */

let passed = 0
let failed = 0
const failures = []

function check(name, cond, extra) {
  if (cond) {
    passed += 1
  } else {
    failed += 1
    failures.push(name + (extra === undefined ? '' : ' -> ' + JSON.stringify(extra)))
    console.log('  FAIL  ' + name + (extra === undefined ? '' : ' -> ' + JSON.stringify(extra)))
  }
}

function group(title) {
  console.log('\n== ' + title + ' ==')
}

function params(entry) {
  return new URL(entry.url).searchParams
}

function rowsFrom(startId, count) {
  const out = []
  for (let i = 0; i < count; i += 1) {
    const n = startId + i
    out.push({
      id: n,
      contact_id: null,
      contact_name: '客人' + n,
      direction: n % 3 === 0 ? 'out' : 'in',
      amount: 100 + n,
      event_type: '结婚',
      happened_on: '2026-0' + ((n % 9) + 1) + '-15',
      is_settled: n % 4 === 0,
      settled_at: null,
      photo_path: null,
      note: null,
      created_at: '2026-01-01T00:00:00Z',
    })
  }
  return out
}

const STATS_ROW = {
  total_count: 22,
  people_count: 21,
  in_total: '11200.00',
  out_total: '1000.00',
  owe_amount: '11200.00',
  owe_count: 21,
  back_amount: '1000.00',
  back_count: 1,
}

/* =================================================================== */

async function run() {
  /* ---------------- 1. listRecordsPage：URL 与分页参数 ---------------- */

  group('listRecordsPage · 分页参数')

  requests = []
  responder = function () {
    return { statusCode: 200, data: rowsFrom(1, 21) }
  }
  let result = await db.listRecordsPage({ settled: 'all', direction: 'all' }, 0)

  check('命中 records 表', requests[0].url.indexOf('/rest/records') >= 0, requests[0].url)
  check('第 0 页 offset=0', params(requests[0]).get('offset') === '0')
  check(
    '多取一条用于判断下一页 limit=21',
    params(requests[0]).get('limit') === '21',
    params(requests[0]).get('limit')
  )
  check(
    '按日期与 id 双重倒序（保证翻页全序稳定）',
    String(params(requests[0]).get('order')).indexOf('happened_on.desc') >= 0 &&
      String(params(requests[0]).get('order')).indexOf('id.desc') >= 0,
    params(requests[0]).get('order')
  )
  check('select 命中业务字段', String(params(requests[0]).get('select')).indexOf('contact_name') >= 0)
  check('全部/全部 不加 is_settled 条件', params(requests[0]).get('is_settled') === null)
  check('全部/全部 不加 direction 条件', params(requests[0]).get('direction') === null)
  check('peek 命中：多出的一条被丢弃', result.rows.length === 20, result.rows.length)
  check('peek 命中：hasMore=true', result.hasMore === true)

  requests = []
  await db.listRecordsPage({ settled: 'all', direction: 'all' }, 2)
  check('第 2 页 offset=40', params(requests[0]).get('offset') === '40')
  check('第 2 页 limit 仍为 21', params(requests[0]).get('limit') === '21')

  requests = []
  responder = function () {
    return { statusCode: 200, data: rowsFrom(1, 20) }
  }
  result = await db.listRecordsPage({ settled: 'all', direction: 'all' }, 0)
  check('恰好一页：hasMore=false', result.hasMore === false)
  check('恰好一页：不丢行', result.rows.length === 20)

  requests = []
  responder = function () {
    return { statusCode: 200, data: [] }
  }
  result = await db.listRecordsPage({ settled: 'all', direction: 'all' }, 0)
  check('空结果：rows=[] hasMore=false', result.rows.length === 0 && result.hasMore === false)

  /* ---------------- 2. 筛选下推到数据库 ---------------- */

  group('listRecordsPage · 筛选下推')

  responder = function () {
    return { statusCode: 200, data: [] }
  }

  requests = []
  await db.listRecordsPage({ settled: 'wait', direction: 'in' }, 0)
  check('未结 → is_settled=eq.false', String(params(requests[0]).get('is_settled')) === 'eq.false')
  check('只看收 → direction=eq.in', String(params(requests[0]).get('direction')) === 'eq.in')

  requests = []
  await db.listRecordsPage({ settled: 'done', direction: 'out' }, 0)
  check('已结 → is_settled=eq.true', String(params(requests[0]).get('is_settled')) === 'eq.true')
  check('只看送 → direction=eq.out', String(params(requests[0]).get('direction')) === 'eq.out')

  requests = []
  await db.listRecordsPage({ settled: 'all', direction: 'out' }, 0)
  check('仅方向筛选时不出 is_settled', params(requests[0]).get('is_settled') === null)
  check('仅方向筛选时出 direction', String(params(requests[0]).get('direction')) === 'eq.out')

  requests = []
  await db.listRecordsPage(undefined, 0)
  check(
    '缺省 query 不崩且无过滤',
    params(requests[0]).get('is_settled') === null && params(requests[0]).get('direction') === null
  )

  /* ---------------- 3. 待还提醒取数 ---------------- */

  group('listPendingRecords · 未结优先取最老')

  requests = []
  responder = function () {
    return { statusCode: 200, data: rowsFrom(1, 3) }
  }
  const pending = await db.listPendingRecords()
  check('只取未结', String(params(requests[0]).get('is_settled')) === 'eq.false')
  check(
    '按日期升序（最老的在前，超限时先保最该提醒的）',
    String(params(requests[0]).get('order')).indexOf('asc') >= 0,
    params(requests[0]).get('order')
  )
  check('带上限 1000', params(requests[0]).get('limit') === '1000')
  check('返回 3 条', pending.length === 3)

  /* ---------------- 4. listAllRecords：不再静默截断 ---------------- */

  group('listAllRecords · 循环翻页取全量')

  requests = []
  responder = function (entry) {
    const off = Number(params(entry).get('offset') || 0)
    const size = off >= 1000 ? 120 : 500
    return { statusCode: 200, data: rowsFrom(off + 1, size) }
  }
  const all = await db.listAllRecords()
  check('共发出 3 次请求', requests.length === 3, requests.length)
  check(
    'offset 依次为 0 / 500 / 1000',
    requests.map((r) => params(r).get('offset')).join(',') === '0,500,1000',
    requests.map((r) => params(r).get('offset')).join(',')
  )
  check('拿到全部 1120 行', all.length === 1120, all.length)
  check('超出旧上限 500 后仍然完整（旧实现在此静默丢 620 行）', all.length === 1120)

  requests = []
  await db.listAllRecords('contact_name, amount, happened_on')
  check(
    '可只取必要列（去空格）',
    params(requests[0]).get('select') === 'contact_name,amount,happened_on',
    params(requests[0]).get('select')
  )

  requests = []
  responder = function (entry) {
    const off = Number(params(entry).get('offset') || 0)
    return { statusCode: 200, data: rowsFrom(off + 1, 500) }
  }
  const capped = await db.listAllRecords()
  check('页数上限兜底：最多 40 次请求', requests.length === 40, requests.length)
  check('页数上限下有明确返回值而非挂死', capped.length === 20000, capped.length)

  /* ---------------- 5. 服务端聚合 ---------------- */

  group('getRecordsStats · 服务端聚合')

  requests = []
  responder = function (entry) {
    if (entry.url.indexOf('/rpc/records_stats') >= 0) {
      return { statusCode: 200, data: [STATS_ROW] }
    }
    return { statusCode: 200, data: [] }
  }
  const stats = await db.getRecordsStats()
  check('走 rpc/records_stats', requests[0].url.indexOf('/rpc/records_stats') >= 0, requests[0].url)
  check('totalCount=22', stats.totalCount === 22)
  check('peopleCount=21', stats.peopleCount === 21)
  check('numeric 字符串转数字：inTotal=11200', stats.inTotal === 11200, stats.inTotal)
  check('inTotal 类型是 number', typeof stats.inTotal === 'number', typeof stats.inTotal)
  check('oweAmount=11200', stats.oweAmount === 11200)
  check('oweCount=21', stats.oweCount === 21)
  check('backCount=1', stats.backCount === 1)

  responder = function () {
    return { statusCode: 200, data: [{ total_count: null, in_total: null }] }
  }
  const emptyStats = await db.getRecordsStats()
  check('空账本归零而非 NaN', emptyStats.totalCount === 0 && emptyStats.inTotal === 0)

  responder = function () {
    return { statusCode: 200, data: [] }
  }
  const noRow = await db.getRecordsStats()
  check('函数无返回行时全部归零', noRow.totalCount === 0 && noRow.oweAmount === 0)

  /* ---------------- 6. 账本页（Page）行为 ---------------- */

  group('账本页 · 首屏加载')

  const PAGE_ROWS = rowsFrom(1, 21)
  responder = function (entry) {
    const u = new URL(entry.url)
    if (u.pathname.indexOf('/rpc/records_stats') >= 0) {
      return { statusCode: 200, data: [STATS_ROW] }
    }
    if (u.pathname.indexOf('/rest/records') >= 0) {
      if (u.searchParams.get('is_settled') === 'eq.false') {
        return { statusCode: 200, data: rowsFrom(900, 3) }
      }
      const off = Number(u.searchParams.get('offset') || 0)
      if (off === 0) return { statusCode: 200, data: PAGE_ROWS }
      if (off === 20) return { statusCode: 200, data: rowsFrom(100, 5) }
      return { statusCode: 200, data: [] }
    }
    return { statusCode: 200, data: [] }
  }

  const page = makePage(capturedPage)
  requests = []
  pullDownCalls = 0
  await page.reload()

  check('首屏列表 20 条', page.data.list.length === 20, page.data.list.length)
  check('hasMore=true', page.data.hasMore === true)
  check('loading 已复位', page.data.loading === false)
  check('total 取聚合口径 22（不是列表长度 20）', page.data.total === 22, page.data.total)
  check('统计卡金额来自聚合 oweText=11200', page.data.stats.oweText === '11200', page.data.stats.oweText)
  check('统计卡笔数 oweCount=21', page.data.stats.oweCount === 21)
  check('累计收 inText=11200', page.data.stats.inText === '11200')
  check('累计送 outText=1000', page.data.stats.outText === '1000')
  check('列表与聚合分开取，共 3 个请求', requests.length === 3, requests.length)
  check(
    '提醒笔数用服务端口径（21+1=22，而非实际取到的 3 条）',
    page.data.reminder.pendingCount === 22,
    page.data.reminder.pendingCount
  )

  const vm = page.data.list[0]
  check('展示模型带姓名', vm.name === '客人1', vm.name)
  check('展示模型带方向文案', vm.directionText === '收礼' || vm.directionText === '送礼')
  check('展示模型带状态文案', typeof vm.statusText === 'string' && vm.statusText.length > 0)
  check('展示模型金额已格式化', vm.amountText === '101', vm.amountText)
  check('展示模型日期已短格式化', vm.dateText === '02-15', vm.dateText)

  /* ---------------- 7. 触底加载 ---------------- */

  group('账本页 · 触底加载')

  requests = []
  await page.loadMore()
  check('追加后共 25 条', page.data.list.length === 25, page.data.list.length)
  check('pageIndex 递增到 1', page.pageIndex === 1)
  check('最后一页 hasMore=false', page.data.hasMore === false)
  check('第一次触底只发 1 个请求', requests.length === 1, requests.length)
  check('第二次触底请求 offset=20', params(requests[0]).get('offset') === '20')

  requests = []
  await page.loadMore()
  check('没有下一页时不再发请求', requests.length === 0, requests.length)

  const appended = page.data.list[20]
  check('追加的行是第二页数据', appended.name === '客人100', appended.name)

  /* ---------------- 8. 切换筛选 ---------------- */

  group('账本页 · 切换筛选')

  requests = []
  page.onFilterTap({ currentTarget: { dataset: { key: 'wait' } } })
  await tick()
  check('切到「未结」触发重新加载', requests.length >= 3, requests.length)
  // 列表请求带 offset，待还提醒请求不带 —— 用它把两者分开
  const listReq = requests.find(function (r) {
    return r.url.indexOf('/rest/records') >= 0 && params(r).get('offset') !== null
  })
  check('筛选条件进入查询：is_settled=eq.false', listReq && listReq.url.indexOf('is_settled=eq.false') >= 0, listReq && listReq.url)
  check('切筛选后回到第 0 页', listReq && params(listReq).get('offset') === '0', listReq && params(listReq).get('offset'))
  check('切筛选后 pageIndex 归零', page.pageIndex === 0)

  requests = []
  page.onDirectionTap({ currentTarget: { dataset: { key: 'out' } } })
  await tick()
  const dirReq = requests.find(function (r) {
    return r.url.indexOf('/rest/records') >= 0 && params(r).get('offset') !== null
  })
  check('方向筛选进入查询：direction=eq.out', dirReq && dirReq.url.indexOf('direction=eq.out') >= 0, dirReq && dirReq.url)
  check('方向筛选保留已选状态位', page.data.filter === 'wait' && page.data.direction === 'out')

  requests = []
  page.onFilterTap({ currentTarget: { dataset: { key: 'wait' } } })
  await tick()
  check('重复点同一筛选不重复请求', requests.length === 0, requests.length)

  /* ---------------- 9. 划掉一笔：就地更新 ---------------- */

  group('账本页 · 划掉与就地更新')

  page.setData({ filter: 'all', direction: 'all' })
  await page.reload()
  const target = page.data.list[3]
  requests = []
  await new Promise(function (resolve) {
    page.onSettle({ detail: { id: target.id, settled: true } })
    setTimeout(resolve, 60)
  })
  check('划掉只更新该行，未重建列表', page.data.list.length === 20, page.data.list.length)
  const patched = page.data.list[3]
  check('该行已标记为已结', patched.isSettled === true)
  check('该行状态文案同步更新', patched.statusText === '已还' || patched.statusText === '已回', patched.statusText)
  check('其他行未被影响', page.data.list[2].isSettled === rowsFrom(1, 21)[2].is_settled)
  check(
    '划掉后只刷新聚合（未重新拉列表首屏）',
    requests.filter(function (r) {
      return r.method === 'GET' && params(r).get('offset') !== null
    }).length === 0,
    requests.map(function (r) {
      return r.method + ' ' + r.url
    })
  )

  group('账本页 · 划掉后不再满足筛选则移除')

  page.setData({ filter: 'wait', direction: 'all' })
  await page.reload()
  const before = page.data.list.length
  const openRow = page.data.list.find(function (row) {
    return !row.isSettled
  })
  await new Promise(function (resolve) {
    page.onSettle({ detail: { id: openRow.id, settled: true } })
    setTimeout(resolve, 60)
  })
  check('已结的行从「未结」列表移除', page.data.list.length === before - 1, page.data.list.length)
  check(
    '被移除的正是那一行',
    !page.data.list.some(function (row) {
      return row.id === openRow.id
    })
  )

  /* ---------------- 10. 下拉刷新时序 ---------------- */

  group('账本页 · 下拉刷新')

  page.setData({ filter: 'all', direction: 'all' })
  pullDownCalls = 0
  page.onPullDownRefresh()
  check('刷新过程中不提前收圈', pullDownCalls === 0, pullDownCalls)
  await tick()
  await tick()
  check('刷新完成后收圈', pullDownCalls === 1, pullDownCalls)

  /* ---------------- 11. 出错与降级 ---------------- */

  group('账本页 · 出错与降级')

  // 先成功加载一次，拿到真实数值作为基线，用于验证降级时不会把它清零
  responder = function (entry) {
    const u = new URL(entry.url)
    if (u.pathname.indexOf('/rpc/records_stats') >= 0) {
      return { statusCode: 200, data: [STATS_ROW] }
    }
    if (u.pathname.indexOf('/rest/records') >= 0) {
      if (u.searchParams.get('is_settled') === 'eq.false') {
        return { statusCode: 200, data: rowsFrom(900, 3) }
      }
      return { statusCode: 200, data: rowsFrom(1, 4) }
    }
    return { statusCode: 200, data: [] }
  }

  const degraded = makePage(capturedPage)
  await degraded.reload()
  check('记录数不足一页时 hasMore=false', degraded.data.hasMore === false)
  check('基线统计已就位', degraded.data.stats.oweText === '11200', degraded.data.stats.oweText)

  // 聚合全线不可用：列表必须照常，且不能把统计清零
  responder = function (entry) {
    const u = new URL(entry.url)
    if (u.pathname.indexOf('/rpc/records_stats') >= 0) {
      return { statusCode: 400, data: { message: 'permission denied', code: '42501' } }
    }
    if (u.pathname.indexOf('/rest/records') >= 0) {
      if (u.searchParams.get('is_settled') === 'eq.false') {
        return { statusCode: 500, data: { message: 'boom' } }
      }
      return { statusCode: 200, data: rowsFrom(1, 6) }
    }
    return { statusCode: 200, data: [] }
  }
  await degraded.reload()
  check('聚合不可用时列表照常渲染', degraded.data.list.length === 6, degraded.data.list.length)
  check('聚合不可用时不进整页错误态', degraded.data.errorMsg === '', degraded.data.errorMsg)
  check('聚合不可用时 loading 复位', degraded.data.loading === false)
  check(
    '聚合不可用时沿用上一次的真实数值而非清零',
    degraded.data.stats.oweText === '11200',
    degraded.data.stats.oweText
  )

  // 列表本身失败必须明确报错，不能装作没事
  responder = function () {
    return { statusCode: 500, data: { message: 'db down' } }
  }
  const broken = makePage(capturedPage)
  await broken.reload()
  check('列表失败时进入错误态', broken.data.errorMsg.length > 0, broken.data.errorMsg)
  check('列表失败时 loading 复位', broken.data.loading === false)
  check('列表失败时不残留旧列表', broken.data.list.length === 0, broken.data.list.length)

  /* ------------------------------ 汇总 ------------------------------ */

  console.log('\n----------------------------------------')
  console.log('通过 ' + passed + ' / ' + (passed + failed))
  if (failed) {
    console.log('失败 ' + failed + ' 项：')
    failures.forEach(function (f) {
      console.log('  - ' + f)
    })
  } else {
    console.log('全部通过')
  }
  process.exitCode = failed ? 1 : 0
}

function tick() {
  return new Promise(function (resolve) {
    setTimeout(resolve, 40)
  })
}

/** 用 Page 配置造一个可调用的页面实例，setData 支持 list[3] 这种路径写法 */
function makePage(config) {
  const page = {}
  Object.keys(config).forEach(function (key) {
    page[key] = config[key]
  })
  page.data = JSON.parse(JSON.stringify(config.data))
  page.setData = function (patch, callback) {
    Object.keys(patch).forEach(function (key) {
      const matched = key.match(/^([A-Za-z_$][\w$]*)\[(\d+)\]$/)
      if (matched) {
        page.data[matched[1]][Number(matched[2])] = patch[key]
      } else {
        page.data[key] = patch[key]
      }
    })
    if (callback) callback.call(page)
  }
  return page
}

run().catch(function (err) {
  console.log('\n验证脚本异常：' + (err && err.stack))
  process.exitCode = 1
})
