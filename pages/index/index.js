const {
  listRecordsPage,
  listPendingRecords,
  getRecordsStats,
  setRecordSettled,
} = require('../../utils/db')
const { formatAmount, formatDate, shortDate, toNumber } = require('../../utils/format')
const { getRemindThreshold } = require('../../utils/settings')
const { buildReminders } = require('../../utils/remind')

const FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'wait', label: '未结' },
  { key: 'done', label: '已结' },
]

const EMPTY_STATS = {
  oweText: '0',
  oweCount: 0,
  backText: '0',
  backCount: 0,
  inText: '0',
  outText: '0',
}

/** 提醒卡片先露几条，其余收起来，免得把账本列表挤到屏幕外 */
const REMIND_PREVIEW_COUNT = 3

const EMPTY_REMIND = {
  threshold: 0,
  enabled: true,
  pendingCount: 0,
  overdueCount: 0,
  overdueAmountText: '0',
  maxDays: 0,
  items: [],
}

/** 数据库行 → 展示模型 */
function toViewModel(record) {
  const direction = record.direction === 'out' ? 'out' : 'in'
  const isSettled = !!record.is_settled

  let statusText
  if (direction === 'in') {
    statusText = isSettled ? '已还' : '待还'
  } else {
    statusText = isSettled ? '已回' : '待回'
  }

  return {
    id: record.id,
    name: record.contact_name || '未署名',
    direction: direction,
    directionText: direction === 'in' ? '收礼' : '送礼',
    isSettled: isSettled,
    statusText: statusText,
    amount: toNumber(record.amount),
    amountText: formatAmount(record.amount),
    eventType: record.event_type || '',
    dateText: shortDate(record.happened_on),
    fullDate: formatDate(record.happened_on),
    hasPhoto: !!record.photo_path,
    note: record.note || '',
    contactId: record.contact_id || null,
  }
}

/** 一条记录是否落在当前筛选里。筛选已在服务端执行，这里只用于就地更新后的判断 */
function matchFilter(vm, filter, direction) {
  if (direction !== 'all' && vm.direction !== direction) return false
  if (filter === 'wait' && vm.isSettled) return false
  if (filter === 'done' && !vm.isSettled) return false
  return true
}

/** 服务端聚合结果 → 统计卡展示模型 */
function toStatsVM(stats) {
  return {
    oweText: formatAmount(stats.oweAmount),
    oweCount: stats.oweCount,
    backText: formatAmount(stats.backAmount),
    backCount: stats.backCount,
    inText: formatAmount(stats.inTotal),
    outText: formatAmount(stats.outTotal),
  }
}

Page({
  data: {
    loading: true,
    loadingMore: false,
    errorMsg: '',
    filters: FILTERS,
    filter: 'all',
    direction: 'all',
    list: [],
    total: 0,
    hasMore: false,
    stats: EMPTY_STATS,
    reminder: EMPTY_REMIND,
    remindItems: [],
    remindExpanded: false,
  },

  /** 已加载到第几页，从 0 开始 */
  pageIndex: 0,

  /** 与 list 同序的原始行，就地更新一条记录时用它重建展示模型 */
  rawRows: [],

  onShow: function () {
    this.bootstrap()
  },

  bootstrap: function () {
    const page = this
    const app = getApp()
    app.ready().then(function (session) {
      if (!session) {
        wx.redirectTo({ url: '/pages/login/login' })
        return
      }
      page.reload()
    })
  },

  /** 当前筛选条件，直接翻译成服务端查询条件 */
  currentQuery: function () {
    return { settled: this.data.filter, direction: this.data.direction }
  },

  /**
   * 重新加载：回到第一页，并刷新统计与提醒
   *
   * 列表与聚合分开取，而且聚合失败不拖垮列表：统计与提醒依赖服务端新增的聚合
   * 函数，一旦它不可用（换个环境还没建、权限没配好），整页账本不该跟着变空白。
   * 拿不到就沿用上一次的数值 —— 清零会被读成「我不欠人情了」，那是在说假话。
   */
  reload: function () {
    const page = this
    this.setData({ loading: true, errorMsg: '' })

    const aggregates = Promise.all([getRecordsStats(), listPendingRecords()])
      .then(function (result) {
        return { stats: result[0], pending: result[1] }
      })
      .catch(function (err) {
        console.warn(
          '[人情账簿] 统计或提醒加载失败，本次沿用上一次的数值',
          JSON.stringify({ message: err && err.message })
        )
        return null
      })

    return Promise.all([listRecordsPage(this.currentQuery(), 0), aggregates])
      .then(function (result) {
        const first = result[0]
        const agg = result[1]
        page.pageIndex = 0
        page.rawRows = first.rows
        page.setData({
          loading: false,
          list: first.rows.map(toViewModel),
          hasMore: first.hasMore,
        })
        if (agg) page.applyAggregates(agg.stats, agg.pending)
        return true
      })
      .catch(function (err) {
        page.setData({
          loading: false,
          errorMsg: (err && err.message) || '账本加载失败，请下拉重试',
        })
        return false
      })
  },

  /**
   * 触底追加下一页
   *
   * 返回 Promise，与 reload 一致：调用方需要能在加载结束后做点什么
   * （下拉刷新要收圈、串联操作要等它落地），没有返回值就只能靠猜时间。
   */
  loadMore: function () {
    const page = this
    if (this.data.loading || this.data.loadingMore || !this.data.hasMore) {
      return Promise.resolve(false)
    }

    this.setData({ loadingMore: true })
    return listRecordsPage(this.currentQuery(), this.pageIndex + 1)
      .then(function (result) {
        page.pageIndex += 1
        page.rawRows = page.rawRows.concat(result.rows)
        page.setData({
          loadingMore: false,
          list: page.data.list.concat(result.rows.map(toViewModel)),
          hasMore: result.hasMore,
        })
        return true
      })
      .catch(function (err) {
        page.setData({ loadingMore: false })
        wx.showToast({ title: (err && err.message) || '加载失败，请重试', icon: 'none' })
        return false
      })
  },

  onReachBottom: function () {
    this.loadMore()
  },

  /** 统计与提醒（全量口径），列表变动后单独刷新 */
  applyAggregates: function (stats, pendingRows) {
    const reminder = buildReminders(pendingRows, getRemindThreshold())
    // 未结笔数用服务端口径：提醒只取了最老的一批，数组长度可能小于真实值
    reminder.pendingCount = stats.oweCount + stats.backCount

    const expanded = this.data.remindExpanded
    this.setData({
      total: stats.totalCount,
      stats: toStatsVM(stats),
      reminder: reminder,
      remindItems: reminder.items.slice(0, expanded ? reminder.items.length : REMIND_PREVIEW_COUNT),
    })
  },

  /**
   * 只刷新统计与提醒，不动列表
   *
   * 划掉一笔之后就整页重载会把用户翻过的页数和滚动位置全部弹回去。
   * 统计刷新失败不该影响那次已经成功的划掉，静默保留旧值即可。
   */
  refreshAggregates: function () {
    const page = this
    Promise.all([getRecordsStats(), listPendingRecords()])
      .then(function (result) {
        page.applyAggregates(result[0], result[1])
      })
      .catch(function (err) {
        console.warn(
          '[人情账簿] 统计刷新失败，沿用上一次的数值',
          JSON.stringify({ message: err && err.message })
        )
      })
  },

  /** 就地更新一条记录的状态；若它已不满足当前筛选则从列表移除 */
  applySettle: function (id, settled) {
    let index = -1
    for (let i = 0; i < this.rawRows.length; i += 1) {
      if (this.rawRows[i].id === id) {
        index = i
        break
      }
    }
    if (index < 0) return

    this.rawRows[index].is_settled = !!settled
    const nextVM = toViewModel(this.rawRows[index])

    if (!matchFilter(nextVM, this.data.filter, this.data.direction)) {
      this.rawRows.splice(index, 1)
      const list = this.data.list.slice()
      list.splice(index, 1)
      this.setData({ list: list })
      return
    }

    const patch = {}
    patch['list[' + index + ']'] = nextVM
    this.setData(patch)
  },

  onFilterTap: function (e) {
    const page = this
    const key = e.currentTarget.dataset.key
    if (key === this.data.filter) return
    this.setData({ filter: key }, function () {
      page.reload()
    })
  },

  onDirectionTap: function (e) {
    const page = this
    const key = e.currentTarget.dataset.key
    if (key === this.data.direction) return
    this.setData({ direction: key }, function () {
      page.reload()
    })
  },

  onSettle: function (e) {
    const page = this
    const id = e.detail.id
    const settled = e.detail.settled

    setRecordSettled(id, settled)
      .then(function () {
        wx.showToast({ title: settled ? '已划掉' : '已恢复', icon: 'none' })
        page.applySettle(id, settled)
        page.refreshAggregates()
      })
      .catch(function (err) {
        wx.showToast({ title: (err && err.message) || '操作失败，请重试', icon: 'none' })
      })
  },

  onItemTap: function (e) {
    wx.navigateTo({ url: '/pages/detail/detail?id=' + e.detail.id })
  },

  onRemindItemTap: function (e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({ url: '/pages/detail/detail?id=' + id })
  },

  onToggleRemind: function () {
    const expanded = !this.data.remindExpanded
    const items = this.data.reminder.items
    this.setData({
      remindExpanded: expanded,
      remindItems: items.slice(0, expanded ? items.length : REMIND_PREVIEW_COUNT),
    })
  },

  goAdd: function () {
    wx.navigateTo({ url: '/pages/add/add' })
  },

  /** 整页礼金簿：一次读出一页名单上的所有人 */
  goBulk: function () {
    wx.navigateTo({ url: '/pages/bulk/bulk' })
  },

  onPullDownRefresh: function () {
    const done = function () {
      wx.stopPullDownRefresh()
    }
    const pending = this.reload()
    if (pending && pending.then) pending.then(done, done)
    else done()
  },
})
