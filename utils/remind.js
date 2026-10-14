/**
 * 待还人情提醒
 *
 * 判定规则很朴素：一笔人情收进来之后一直没还，且已经过了约定天数，就该被拎出来。
 * 全部在本地算 —— 账本数据量级不大，没必要为此多一次服务端往返，
 * 也就不需要订阅消息那样的推送授权。
 */
const { formatAmount, toNumber, shortDate } = require('./format')

const DAY_MS = 24 * 60 * 60 * 1000

/** 取「今天 0 点」的时间戳，便于按自然日相减 */
function todayStart(now) {
  const d = now ? new Date(now) : new Date()
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** 把 YYYY-MM-DD 解析为当天 0 点的时间戳；解析不了返回 0 */
function dayStart(value) {
  if (!value) return 0
  const matched = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!matched) return 0
  const time = new Date(
    Number(matched[1]),
    Number(matched[2]) - 1,
    Number(matched[3])
  ).getTime()
  return isFinite(time) ? time : 0
}

/**
 * 距今过了多少个自然日
 * @param {string} value 记录日期
 * @param {number} nowStart 今天 0 点的时间戳
 */
function daysSince(value, nowStart) {
  const start = dayStart(value)
  if (!start || !nowStart) return 0
  const diff = Math.floor((nowStart - start) / DAY_MS)
  return diff > 0 ? diff : 0
}

/**
 * 挑出需要提醒的人情
 * @param {Array} records 云端返回的原始记录
 * @param {number} thresholdDays 逾期天数阈值，0 表示不设阈值
 * @param {number} [now] 当前时间，便于测试注入
 */
function buildReminders(records, thresholdDays, now) {
  const nowStart = todayStart(now)
  const threshold = Number(thresholdDays) > 0 ? Number(thresholdDays) : 0

  const pending = []

  ;(records || []).forEach(function (record) {
    if (!record || record.is_settled) return

    const days = daysSince(record.happened_on, nowStart)
    const isOut = record.direction === 'out'

    pending.push({
      id: record.id,
      name: record.contact_name || '未署名',
      direction: isOut ? 'out' : 'in',
      directionText: isOut ? '送礼' : '收礼',
      statusText: isOut ? '待回' : '待还',
      eventType: record.event_type || '',
      amount: toNumber(record.amount),
      amountText: formatAmount(record.amount),
      days: days,
      daysText: days === 0 ? '今天' : '已 ' + days + ' 天',
      dateText: shortDate(record.happened_on),
    })
  })

  pending.sort(function (a, b) {
    return b.days - a.days
  })

  const overdue =
    threshold > 0
      ? pending.filter(function (item) {
          return item.days >= threshold
        })
      : pending

  let overdueAmount = 0
  overdue.forEach(function (item) {
    overdueAmount += item.amount
  })

  return {
    threshold: threshold,
    /** 是否启用了逾期阈值 */
    enabled: threshold > 0,
    /** 未结清总笔数，用于「还有 N 笔在阈值内」这类提示 */
    pendingCount: pending.length,
    overdueCount: overdue.length,
    overdueAmountText: formatAmount(overdueAmount),
    maxDays: overdue.length ? overdue[0].days : 0,
    items: overdue,
  }
}

module.exports = {
  buildReminders: buildReminders,
  daysSince: daysSince,
}
