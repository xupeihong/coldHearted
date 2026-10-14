/** 通用格式化与文案映射 */

function toNumber(value) {
  const n = Number(value)
  return isFinite(n) ? n : 0
}

/** 金额展示：整数不带小数，非整数保留两位 */
function formatAmount(value) {
  const n = toNumber(value)
  if (Math.abs(n - Math.round(n)) < 0.005) return String(Math.round(n))
  return n.toFixed(2)
}

/** 带正负号的金额，用于净额展示 */
function formatSigned(value) {
  const n = toNumber(value)
  const sign = n > 0 ? '+' : n < 0 ? '-' : ''
  return sign + formatAmount(Math.abs(n))
}

function pad2(n) {
  return n < 10 ? '0' + n : String(n)
}

function todayStr() {
  const d = new Date()
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
}

/** 兼容 Date / ISO / YYYY-MM-DD，统一成 YYYY-MM-DD */
function formatDate(value) {
  if (!value) return ''
  const matched = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!matched) return String(value)
  return matched[1] + '-' + matched[2] + '-' + matched[3]
}

function shortDate(value) {
  const date = formatDate(value)
  const matched = date.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!matched) return date
  return matched[2] + '-' + matched[3]
}

const EVENT_TYPES = ['结婚', '满月', '乔迁', '升学', '生日', '寿宴', '丧事', '开业', '探病', '其他']

function directionLabel(direction) {
  return direction === 'in' ? '收礼' : '送礼'
}

function directionHint(direction) {
  return direction === 'in' ? '别人给我的' : '我送出去'
}

module.exports = {
  toNumber: toNumber,
  formatAmount: formatAmount,
  formatSigned: formatSigned,
  todayStr: todayStr,
  formatDate: formatDate,
  shortDate: shortDate,
  EVENT_TYPES: EVENT_TYPES,
  directionLabel: directionLabel,
  directionHint: directionHint,
}
