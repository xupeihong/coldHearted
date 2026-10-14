/**
 * 本地偏好设置
 *
 * 两项都只反映「这台设备上的人怎么记账」，与账本数据本身无关，
 * 因此放本地存储，不进云端，也不需要登录态。
 */

const THRESHOLD_KEY = 'renqing_remind_threshold_days'

/** 提醒阈值档位；value 为 0 表示不设阈值，所有未结清都进提醒 */
const REMIND_OPTIONS = [
  { value: 30, label: '30 天', hint: '一个月未回就提醒' },
  { value: 90, label: '90 天', hint: '三个月未回才提醒' },
  { value: 180, label: '180 天', hint: '半年未回才提醒' },
  { value: 0, label: '不限', hint: '所有未结清的人都进提醒，按未结天数排序' },
]

const DEFAULT_THRESHOLD = 90

function findOption(value) {
  for (let i = 0; i < REMIND_OPTIONS.length; i += 1) {
    if (REMIND_OPTIONS[i].value === value) return REMIND_OPTIONS[i]
  }
  return null
}

function normalizeThreshold(value) {
  const n = Number(value)
  if (!isFinite(n) || n < 0) return DEFAULT_THRESHOLD
  return findOption(n) ? n : DEFAULT_THRESHOLD
}

function getRemindThreshold() {
  try {
    const raw = wx.getStorageSync(THRESHOLD_KEY)
    if (raw === '' || raw === null || raw === undefined) return DEFAULT_THRESHOLD
    return normalizeThreshold(raw)
  } catch (e) {
    return DEFAULT_THRESHOLD
  }
}

function setRemindThreshold(value) {
  const next = normalizeThreshold(value)
  try {
    wx.setStorageSync(THRESHOLD_KEY, next)
  } catch (e) {
    // 写入失败不影响本次会话，下次读取回落默认值
  }
  return next
}

function thresholdLabel(value) {
  const hit = findOption(normalizeThreshold(value))
  return hit ? hit.label : DEFAULT_THRESHOLD + ' 天'
}

function thresholdHint(value) {
  const hit = findOption(normalizeThreshold(value))
  return hit ? hit.hint : ''
}

/* ------------------------------ 识别模型 ------------------------------ */

const VISION_KEY = 'renqing_vision_model'

/**
 * 识别模型候选
 *
 * 手写礼金簿是细节密集的感知任务，原生多模态的视觉模型通常读得更准；
 * 通用思考模型推理强，但「看图」未必比视觉专用模型好，所以排在后面。
 * id 必须与云端返回的可用模型 id 一致。
 */
const VISION_MODEL_OPTIONS = [
  { id: 'glm-5.3-flash', label: 'GLM-5.3-Flash', hint: '实测最完整，成本约为 turbo 的 1/13' },
  { id: 'glm-5v-turbo', label: 'GLM-5v-Turbo', hint: '原生多模态视觉模型' },
  { id: 'glm-5.3', label: 'GLM-5.3', hint: '完整版，难字较稳，偶有读不出的名字' },
  { id: 'glm-4.6v', label: 'GLM-4.6V', hint: '上一代视觉专用模型' },
  { id: 'deepseek-v4.1-flash', label: 'DeepSeek-V4.1-Flash', hint: '原生多模态，速度较快' },
  { id: 'hy4-preview', label: '混元 Hy4', hint: '混元新一代思考模型' },
  { id: 'auto', label: '自动选择', hint: '由平台按任务路由，效果不固定' },
]

/**
 * 默认 glm-5.3-flash：同一批 4 张手写礼金簿实测（verify-vision-compare.js），
 * 条目完整率最高（最难那张横拍图零放弃，turbo 放弃 6 个金额、5.3 放弃 7 个名字），
 * 实际消耗 credit 约为 turbo 的 1/13。名字存疑时靠用户在候选清单里改，完整性优先。
 */
const DEFAULT_VISION_MODEL = 'glm-5.3-flash'

/**
 * 降级顺序：首选模型跑不通（未开通、超时、输出不可解析）就换下一个。
 * glm-5.3 实测读不出时会诚实标「?」而不是猜，排在 turbo 前面；
 * auto 是浮动路由，消耗与行为都不可复现，不进降级链（仍可手动选）。
 */
const VISION_FALLBACK = [
  'glm-5.3-flash',
  'glm-5.3',
  'glm-5v-turbo',
  'glm-4.6v',
  'deepseek-v4.1-flash',
]

function findVisionOption(id) {
  for (let i = 0; i < VISION_MODEL_OPTIONS.length; i += 1) {
    if (VISION_MODEL_OPTIONS[i].id === id) return VISION_MODEL_OPTIONS[i]
  }
  return null
}

function normalizeVisionModel(id) {
  return findVisionOption(id) ? id : DEFAULT_VISION_MODEL
}

function getVisionModel() {
  try {
    const raw = wx.getStorageSync(VISION_KEY)
    if (raw === '' || raw === null || raw === undefined) return DEFAULT_VISION_MODEL
    return normalizeVisionModel(String(raw))
  } catch (e) {
    return DEFAULT_VISION_MODEL
  }
}

function setVisionModel(id) {
  const next = normalizeVisionModel(String(id || ''))
  try {
    wx.setStorageSync(VISION_KEY, next)
  } catch (e) {
    // 写入失败不影响本次会话，下次读取回落默认值
  }
  return next
}

function visionModelLabel(id) {
  const hit = findVisionOption(normalizeVisionModel(id))
  return hit ? hit.label : DEFAULT_VISION_MODEL
}

/**
 * 把实际使用的模型 id 转成展示名
 *
 * 与 visionModelLabel 的区别：不在候选表里的 id 原样返回。
 * 降级后实际跑的可能是链上的其他模型，这时要把真实名字显示出来，
 * 不能一律回落成默认名，否则用户会以为一直是首选模型在工作。
 */
function visionLabelOf(id) {
  const hit = findVisionOption(id)
  return hit ? hit.label : String(id === null || id === undefined ? '' : id)
}

function visionModelHint(id) {
  const hit = findVisionOption(normalizeVisionModel(id))
  return hit ? hit.hint : ''
}

/**
 * 组装实际尝试的模型序列：用户选的排第一，其余按降级表补齐、去重
 * @param {string} preferred 用户选定的模型 id
 * @returns {string[]}
 */
function buildVisionChain(preferred) {
  const ordered = [normalizeVisionModel(preferred)].concat(VISION_FALLBACK)
  const seen = {}
  const chain = []
  for (let i = 0; i < ordered.length; i += 1) {
    const id = ordered[i]
    if (id && !seen[id]) {
      seen[id] = true
      chain.push(id)
    }
  }
  return chain
}

module.exports = {
  THRESHOLD_KEY: THRESHOLD_KEY,
  REMIND_OPTIONS: REMIND_OPTIONS,
  DEFAULT_THRESHOLD: DEFAULT_THRESHOLD,
  getRemindThreshold: getRemindThreshold,
  setRemindThreshold: setRemindThreshold,
  thresholdLabel: thresholdLabel,
  thresholdHint: thresholdHint,
  VISION_KEY: VISION_KEY,
  VISION_MODEL_OPTIONS: VISION_MODEL_OPTIONS,
  DEFAULT_VISION_MODEL: DEFAULT_VISION_MODEL,
  VISION_FALLBACK: VISION_FALLBACK,
  getVisionModel: getVisionModel,
  setVisionModel: setVisionModel,
  visionModelLabel: visionModelLabel,
  visionLabelOf: visionLabelOf,
  visionModelHint: visionModelHint,
  buildVisionChain: buildVisionChain,
}
