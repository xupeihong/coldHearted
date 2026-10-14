/**
 * 拍照记账 —— 由图片识别出金额、姓名、事由、日期
 *
 * 识别质量取决于三件事，按影响从大到小：
 *   1. 送进去的图够不够清楚 —— 见 utils/file.js 的 compressForVision
 *   2. 模型是不是原生多模态 —— 见 utils/settings.js 的 VISION_MODEL_OPTIONS
 *   3. 提示词有没有逼模型「先看清、再判断」—— 见下方 SYSTEM_PROMPT
 *
 * 识别结果只是「填表建议」，最终以用户确认为准。
 */
const { cloud } = require('./cloud')
const { readAsBase64, compressForVision } = require('./file')
const { todayStr } = require('./format')
const { getVisionModel, buildVisionChain } = require('./settings')

/**
 * 单条凭证的提示词：分两步，先逐字转写，再抽字段。
 *
 * 直接让模型抽字段时，它容易跳过看不清的部分直接猜一个合理值；
 * 先要求把图上文字全部转写出来，等于强制它把图看完整，
 * 后面的字段是从转写结果里读出来的，幻觉明显减少。
 */
const RECEIPT_SYSTEM_PROMPT = [
  '你是中文礼金簿识别助手，负责从照片里读出人情往来的信息。',
  '',
  '按两步作答：',
  '第一步，把图片中出现的所有文字逐字转写到 transcript 字段——包括姓名、金额、日期、',
  '事由、以及表格或页边的手写旁注。不要翻译、不要改写、不要补全。看不清的字按最接近的',
  '字形转写，实在认不出用「?」占位。',
  '第二步，基于你转写出来的内容填写后面的字段。',
  '',
  '只输出一个 JSON 对象，不要解释文字，不要 Markdown 代码块。',
  '',
  'JSON 结构：',
  '{',
  '  "transcript": "图中所有文字的逐字转写",',
  '  "contact_name": "对方姓名；没有就填空字符串",',
  '  "direction": "in 表示别人给我（收礼、收到红包、收到转账）；out 表示我给别人（送礼、发出红包、转出）",',
  '  "amount": "金额数字，必须转成阿拉伯数字（壹仟元写成 1000、八百写成 800），不带货币符号；无法确定填 0",',
  '  "event_type": "事由，从 结婚/满月/乔迁/升学/生日/寿宴/丧事/开业/探病/其他 中选一个最接近的，无法确定填空字符串",',
  '  "happened_on": "YYYY-MM-DD 日期，无法确定填空字符串",',
  '  "note": "其他有用信息，如礼品、地点、备注；没有则填空字符串"',
  '}',
  '',
  '要求：字段内容必须能在 transcript 里找到出处，不要编造。金额无法确定时填 0。',
  'direction 判断依据：礼金簿签到页上别人写的名字通常对应收礼（in）；自己记下要送出去的对应 out；',
  '转账截图里「收入」为 in、「支出」为 out。',
].join('\n')

/**
 * 整页礼金簿（签到簿）的提示词
 *
 * 与单条识别的关键差别：转写要求按阅读顺序逐行进行，输出也逐行结构化。
 * 另有两条是针对这一场景特意加的约束：
 *   - 明确列出哪些行不该算作条目（表头、页码等），否则模型会把「姓名」「合计」也读成人名；
 *   - 金额读不出来时要求填 0，禁止按邻近行推测 —— 礼金簿金额常常写得潦草，
 *     放任模型「推断」会造出一批看起来合理、实际全错的数字，比读不出来更糟。
 */
const ROSTER_SYSTEM_PROMPT = [
  '你是中文礼金簿（签到簿）识别助手。这类图片通常是一页手写名单，',
  '每行一个人名，右侧或名字下方跟着金额，有时还写着关系。',
  '',
  '按两步作答：',
  '第一步，把整页文字逐行转写到 transcript 字段：按从上到下、从左到右的阅读顺序，',
  '每行之间用换行符分隔。不要翻译、不要改写、不要补全。看不清的字按最接近的字形',
  '转写，完全认不出的字用「?」占位。',
  '第二步，基于转写内容，把每一个「人名 + 金额」整理成 items 数组里的一项。',
  '',
  '只输出一个 JSON 对象，不要解释文字，不要 Markdown 代码块。',
  '',
  'JSON 结构：',
  '{',
  '  "transcript": "整页文字的逐行转写",',
  '  "event_type": "整页共同的事由，从 结婚/满月/乔迁/升学/生日/寿宴/丧事/开业/探病/其他 中选一个最接近的，无法确定填空字符串",',
  '  "happened_on": "整页共同的日期 YYYY-MM-DD，无法确定填空字符串",',
  '  "items": [',
  '    {',
  '      "name": "姓名",',
  '      "amount": "金额数字，无法确定填 0",',
  '      "relation": "关系，如 同事/同学/亲戚；没有填空字符串",',
  '      "note": "这一行的其他信息，没有填空字符串"',
  '    }',
  '  ]',
  '}',
  '',
  '要求：',
  '- 一个人名一项。表头（「姓名」「金额」「序号」「合计」「关系」）、页脚、页码、',
  '  日期栏、落款、签名、印章都不要作为 items。',
  '- 一行里多个人名共同随一份礼（如「张三李四合 1000」）时合并为一项，',
  '  name 写成「张三、李四」。',
  '- 金额必须转成阿拉伯数字：壹仟元写成 1000，一千二写成 1200，八百写成 800。',
  '  数字里不要带货币符号和千分位逗号。',
  '- 金额没写或看不清时 amount 填 0，**不要根据上下文或邻近行推测一个数字**。',
  '- 名字必须在 transcript 里有对应，不要编造条目，也不要为了凑数把同一行拆成多条。',
  '- 被划掉、涂抹、标注作废的行仍然列出，但在 note 里写明「疑似作废」。',
].join('\n')

const EVENT_WHITELIST = ['结婚', '满月', '乔迁', '升学', '生日', '寿宴', '丧事', '开业', '探病', '其他']

/** 模型常返回语义相同但用词不同的近义词，直接按白名单过滤会把它整条丢掉 */
const EVENT_ALIAS = {
  婚礼: '结婚',
  婚宴: '结婚',
  喜宴: '结婚',
  喜酒: '结婚',
  嫁娶: '结婚',
  添丁: '满月',
  生子: '满月',
  百日: '满月',
  新房: '乔迁',
  搬家: '乔迁',
  进宅: '乔迁',
  上大学: '升学',
  考上: '升学',
  高考: '升学',
  祝寿: '寿宴',
  大寿: '寿宴',
  白事: '丧事',
  葬礼: '丧事',
  吊唁: '丧事',
  开张: '开业',
  开业庆典: '开业',
  生病: '探病',
  住院: '探病',
  探望: '探病',
}

/** 单次识别的最长等待时间，避免模型卡住时界面一直转圈 */
const RECOGNIZE_TIMEOUT_MS = 45000

function normalizeModelList(raw) {
  if (Array.isArray(raw)) return raw
  if (raw && typeof raw === 'object' && Array.isArray(raw.data)) return raw.data
  return []
}

function pad2(n) {
  return n < 10 ? '0' + n : String(n)
}

/** 模型偶尔会带上 ```json 包裹或前后废话，这里做一次宽松提取 */
function extractJson(text) {
  const raw = String(text || '').trim()
  if (!raw) return null
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced ? fenced[1].trim() : raw
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(candidate.slice(start, end + 1))
  } catch (e) {
    return null
  }
}

/** 金额可能带「元」「¥」或中文数字，统一转成数字 */
function parseAmount(raw) {
  if (typeof raw === 'number') return isFinite(raw) ? raw : 0
  const text = String(raw === null || raw === undefined ? '' : raw).replace(/[^\d.]/g, '')
  if (!text) return 0
  const n = Number(text)
  return isFinite(n) ? n : 0
}

/** 姓名常被模型带上「姓名：」这类前缀，去掉 */
function cleanName(raw) {
  return String(raw === null || raw === undefined ? '' : raw)
    .replace(/^(姓名|名字|对方|客人|户名)[\s:：]*/, '')
    .replace(/^[\s:：，,、]+/, '')
    .replace(/[\s，,。;；]+$/, '')
    .trim()
}

/** 兼容 2026-1-5 / 2026.01.05 这类写法，统一补零 */
function normalizeDate(raw) {
  const matched = String(raw === null || raw === undefined ? '' : raw)
    .trim()
    .match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/)
  if (!matched) return ''
  const month = Number(matched[2])
  const day = Number(matched[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return ''
  return matched[1] + '-' + pad2(month) + '-' + pad2(day)
}

function normalizeEventType(raw) {
  const text = String(raw === null || raw === undefined ? '' : raw).trim()
  if (!text) return ''
  if (EVENT_WHITELIST.indexOf(text) >= 0) return text
  if (EVENT_ALIAS[text]) return EVENT_ALIAS[text]
  // 「乔迁之喜」这类带后缀的，按包含关系再兜一层
  for (let i = 0; i < EVENT_WHITELIST.length; i += 1) {
    if (text.indexOf(EVENT_WHITELIST[i]) >= 0) return EVENT_WHITELIST[i]
  }
  for (const key in EVENT_ALIAS) {
    if (text.indexOf(key) >= 0) return EVENT_ALIAS[key]
  }
  return ''
}

function normalizeResult(parsed) {
  if (!parsed || typeof parsed !== 'object') return null

  const amountNumber = parseAmount(parsed.amount)
  const amount = amountNumber > 0 ? Math.round(amountNumber * 100) / 100 : 0

  return {
    contactName: cleanName(parsed.contact_name),
    direction: parsed.direction === 'out' ? 'out' : 'in',
    amount: amount,
    eventType: normalizeEventType(parsed.event_type),
    happenedOn: normalizeDate(parsed.happened_on),
    note: String(parsed.note === null || parsed.note === undefined ? '' : parsed.note).trim(),
  }
}

/* ------------------------------ 整页名单归一化 ------------------------------ */

/**
 * 签到簿上的表头与栏目标签，不是人名
 *
 * 模型经常把「姓名」「金额」「合计」这类表头也当成一条记录返回，
 * 不滤掉就会往账本里写一条姓「姓名」、金额 0 的脏数据。
 */
const NOISE_NAMES = [
  '姓名',
  '名字',
  '金额',
  '礼金',
  '礼金簿',
  '签到簿',
  '序号',
  '编号',
  '合计',
  '总计',
  '小计',
  '总额',
  '共计',
  '备注',
  '关系',
  '称呼',
  '单位',
  '地址',
  '电话',
  '手机',
  '页数',
  '页码',
  '第几页',
  '签名',
  '签字',
  '日期',
  '时间',
  '年',
  '月',
  '日',
  '人民币',
  '大写',
  '小写',
  '金额大写',
  '签到',
  '签到处',
  '正',
  '元',
  '礼',
  '随礼',
  '贺礼',
  '人名',
  '宾客',
]

/** 判断一个「名字」其实是噪音（表头、序号、空值） */
function isNoiseName(name) {
  const raw = String(name === null || name === undefined ? '' : name).trim()
  if (!raw) return true
  // 纯数字或纯标点：通常是序号栏
  if (/^[\d\s.。、,，:：\-_/\\|()（）[\]【】]+$/.test(raw)) return true
  const stripped = raw.replace(/[\s:：*。、.]+/g, '')
  if (!stripped) return true
  if (NOISE_NAMES.indexOf(stripped) >= 0) return true
  return false
}

/** 关系字段常被写成「（同事）」「关系：同事」，剥掉括号与标签 */
function cleanRelation(raw) {
  const text = String(raw === null || raw === undefined ? '' : raw)
    .replace(/^(关系|称呼|身份)[\s:：]*/, '')
    .replace(/^[\s(（[【]+/, '')
    .replace(/[\s)）\]】]+$/, '')
    .replace(/[\s。、,，]+$/, '')
    .trim()
  return text.slice(0, 20)
}

/**
 * 把「张三（同事）」拆成姓名和关系
 *
 * 手写簿上关系常紧跟在名字后面的括号里，模型往往整串塞进 name。
 * 拆出来正好填上 contacts.relation —— 那个字段一直空着没有录入入口。
 */
function splitNameRelation(rawName, rawRelation) {
  let name = String(rawName === null || rawName === undefined ? '' : rawName).trim()
  let relation = cleanRelation(rawRelation)

  const matched = name.match(/^(.+?)[\s]*[（(【\[](.+?)[）)】\]][\s]*$/)
  if (matched) {
    name = matched[1].trim()
    if (!relation) relation = cleanRelation(matched[2])
  }
  return { name: name, relation: relation }
}

/**
 * 归一整页名单里的一项
 * @returns {object|null} 噪音行返回 null
 */
function normalizeRosterItem(raw) {
  if (!raw || typeof raw !== 'object') return null

  const split = splitNameRelation(cleanName(raw.name), raw.relation)
  if (isNoiseName(split.name)) return null

  const amountNumber = parseAmount(raw.amount)
  return {
    name: split.name,
    relation: split.relation,
    amount: amountNumber > 0 ? Math.round(amountNumber * 100) / 100 : 0,
    note: String(raw.note === null || raw.note === undefined ? '' : raw.note)
      .replace(/[\s]+$/, '')
      .trim(),
  }
}

/**
 * 归一整页识别结果
 * @param {object} parsed 模型返回的 JSON
 * @param {boolean} truncated 模型是否因长度上限被截断
 * @returns {object|null} 一条都没读出来时返回 null，触发换模型重试
 */
function normalizeRoster(parsed, truncated) {
  if (!parsed || typeof parsed !== 'object') return null

  const rawItems = Array.isArray(parsed.items) ? parsed.items : []
  const items = []
  let lastKey = ''

  rawItems.forEach(function (raw) {
    const item = normalizeRosterItem(raw)
    if (!item) return
    const key = item.name + '|' + item.amount
    // 只滤掉紧挨着的重复行：模型偶尔会把同一行读两遍，
    // 但隔开的同名同金额可能是真的两个人，不能动
    if (key === lastKey) return
    lastKey = key
    item.key = 'r' + items.length
    item.selected = true
    items.push(item)
  })

  if (!items.length) return null

  const zeroAmountCount = items.filter(function (item) {
    return !item.amount
  }).length

  return {
    items: items,
    eventType: normalizeEventType(parsed.event_type),
    happenedOn: normalizeDate(parsed.happened_on),
    totalCount: items.length,
    zeroAmountCount: zeroAmountCount,
    // 一页超过 30 人时读漏的概率明显上升，界面据此给一句提醒
    dense: items.length >= 30,
    truncated: !!truncated,
  }
}

/* ------------------------------ 模型协商 ------------------------------ */

/**
 * 组装实际尝试的模型序列
 *
 * 先取云端可用模型清单，把降级链里不存在的剔除，减少无效请求；
 * 若清单本身取不到，就按原顺序硬试——宁可多试几次，也不要因为
 * 一次列表查询失败就判定「没有可用模型」。
 *
 * 唯一的例外是用户显式选定的那个模型：即使它不在清单里也保留在最前。
 * 清单可能滞后于实际开通情况，直接试一次的成本，远低于静默丢掉用户的选择。
 */
async function resolveModelChain(preferred) {
  const chain = buildVisionChain(preferred)

  let models = []
  try {
    models = normalizeModelList(await cloud.llm.models.list())
  } catch (e) {
    models = []
  }
  if (!models.length) return chain

  const usable = {}
  models.forEach(function (item) {
    if (item && item.id && item.disabled !== true && item.supportsImages === true) {
      usable[item.id] = true
    }
  })
  const available = chain.filter(function (id) {
    return usable[id] === true
  })
  if (!available.length) return chain

  const head = chain[0]
  if (head && !usable[head]) available.unshift(head)
  return available
}

/** 判断失败是否由「不认识的参数」引起；这类错误去掉该参数重试即可 */
function isParamRejection(error) {
  const text = ((error && error.message) || '') + ' ' + ((error && error.code) || '')
  return /response_format|json_object|unsupported|unknown.?parameter|invalid.?request|unrecognized/i.test(text)
}

/** 带软超时地跑一个 Promise；超时不是失败，只是不再等它 */
function withTimeout(promise, ms) {
  return new Promise(function (resolve, reject) {
    let settled = false
    const timer = setTimeout(function () {
      if (settled) return
      settled = true
      const err = new Error('识别超时，请重试或手动填写')
      err.code = 'TIMEOUT'
      reject(err)
    }, ms)
    promise.then(
      function (value) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      },
      function (err) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

/**
 * 用指定模型问一次，只负责把模型输出的原始文本拿回来
 *
 * @param {object} spec { system, userText, maxTokens }
 * @param {string} modelId
 * @param {string} base64 图片 base64（不含 data: 前缀）
 * @param {boolean} withJsonFormat 是否要求服务端强制 JSON 输出
 */
async function askModel(spec, modelId, base64, withJsonFormat) {
  const payload = {
    model: modelId,
    messages: [
      { role: 'system', content: spec.system },
      {
        role: 'user',
        content: [
          { type: 'text', text: spec.userText },
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + base64 } },
        ],
      },
    ],
    stream: true,
    // 思考模型会先在推理上花掉一部分预算，留足空间以免 JSON 被截断
    max_tokens: spec.maxTokens,
    temperature: 0.1,
  }
  if (withJsonFormat) payload.response_format = { type: 'json_object' }

  let answer = ''
  let truncated = false

  const run = (async function () {
    for await (const chunk of cloud.llm.chat.completions.create(payload)) {
      const choice = chunk && chunk.choices && chunk.choices[0]
      if (!choice) continue
      if (choice.finish_reason === 'length') truncated = true
      const delta = choice.delta
      // 思考内容走 reasoning_content，不混入正文，这里只收 content
      if (delta && typeof delta.content === 'string') answer += delta.content
    }
    return answer
  })()

  await withTimeout(run, RECOGNIZE_TIMEOUT_MS)
  return { text: answer, truncated: truncated }
}

/**
 * 沿模型降级链跑一次识图任务
 *
 * 单条识别与整页识别共用这条链路，差别只在提示词与解析函数——由 spec 传入。
 * 解析函数返回 null 视为「这次没读出可用结果」，会继续换下一个模型。
 */
async function runChain(base64, spec) {
  const chain = await resolveModelChain(spec.preferred)
  if (!chain.length) {
    const err = new Error('当前没有可用的图片识别模型，请手动填写')
    err.code = 'NO_VISION_MODEL'
    throw err
  }

  let lastError = null
  for (let i = 0; i < chain.length; i += 1) {
    const modelId = chain[i]
    try {
      const raw = await askModel(spec, modelId, base64, true)
      const result = spec.parse(raw.text, raw.truncated)
      if (result) {
        result.modelName = modelId
        return result
      }
      const err = new Error(
        raw.truncated ? '识别结果不完整，已换用其他模型重试' : '模型没能返回可用的识别结果'
      )
      err.code = raw.truncated ? 'TRUNCATED' : 'UNPARSABLE'
      throw err
    } catch (err) {
      lastError = err
      // 只有「参数不被接受」这一类值得摘掉参数用同一个模型再试一次，
      // 其余情况换模型更划算
      if (isParamRejection(err)) {
        try {
          const raw = await askModel(spec, modelId, base64, false)
          const result = spec.parse(raw.text, raw.truncated)
          if (result) {
            result.modelName = modelId
            return result
          }
        } catch (retryErr) {
          lastError = retryErr
        }
      }
    }
  }

  if (lastError && (lastError.code === 'TIMEOUT' || lastError.code === 'NO_VISION_MODEL')) {
    throw lastError
  }
  if (lastError && lastError.code === 'TRUNCATED') {
    throw new Error('这一页内容太多、没能一次读完，试试分成两张拍')
  }
  throw new Error(spec.failMessage || '换了几种模型都没能读出信息，请手动填写')
}

/* ------------------------------ 对外接口 ------------------------------ */

/** 读图前的公共准备：压缩 + 转 base64 */
async function prepareImage(localPath) {
  const compressed = await compressForVision(localPath)
  const base64 = await readAsBase64(compressed)
  if (!base64) throw new Error('图片读取失败，请重新拍照')
  return base64
}

function preferredModelOf(options) {
  return (options && options.preferredModel) || getVisionModel()
}

function receiptSpec(options) {
  return {
    preferred: preferredModelOf(options),
    system: RECEIPT_SYSTEM_PROMPT,
    maxTokens: 4096,
    userText:
      '请识别这张图片中的人情往来信息。今天是 ' +
      todayStr() +
      '，遇到「今天」「昨天」这类相对日期请据此换算。按约定只返回 JSON。',
    parse: function (text) {
      return normalizeResult(extractJson(text))
    },
    failMessage: '换了几种模型都没能读出信息，请手动填写',
  }
}

function rosterSpec(options) {
  return {
    preferred: preferredModelOf(options),
    system: ROSTER_SYSTEM_PROMPT,
    // 整页名单的输出量大得多，给思考模型留够空间
    maxTokens: 8192,
    userText:
      '请识别这一页礼金簿名单上的所有人名与金额。今天是 ' +
      todayStr() +
      '，遇到「今天」「昨天」这类相对日期请据此换算。按约定只返回 JSON。',
    parse: function (text, truncated) {
      return normalizeRoster(extractJson(text), truncated)
    },
    failMessage: '换了几种模型都没能读出这一页名单，换个清晰点的照片或手动添加',
  }
}

/**
 * 识别单张凭证，抽出一条人情记录
 * @param {string} localPath 本地图片路径
 * @param {object} [options] { preferredModel } 可临时指定首选模型
 * @returns {Promise<object>} { contactName, direction, amount, eventType, happenedOn, note, modelName }
 */
async function recognizeReceipt(localPath, options) {
  const base64 = await prepareImage(localPath)
  return await runChain(base64, receiptSpec(options))
}

/**
 * 识别一页礼金簿（签到簿），抽出名单上的多个人
 *
 * 与单条识别的区别不只是提示词：签到簿是一页几十行的手写名单，
 * 需要逐行转写再逐行结构化，还要把表头、页码这类噪音行剔掉。
 *
 * @param {string} localPath 本地图片路径
 * @param {object} [options] { preferredModel }
 * @returns {Promise<object>} { items, eventType, happenedOn, zeroAmountCount, dense, modelName }
 */
async function recognizeRoster(localPath, options) {
  const base64 = await prepareImage(localPath)
  return await runChain(base64, rosterSpec(options))
}

module.exports = {
  recognizeReceipt: recognizeReceipt,
  recognizeRoster: recognizeRoster,
  resolveModelChain: resolveModelChain,
  normalizeEventType: normalizeEventType,
  normalizeDate: normalizeDate,
  parseAmount: parseAmount,
  cleanName: cleanName,
  cleanRelation: cleanRelation,
  isNoiseName: isNoiseName,
  normalizeRosterItem: normalizeRosterItem,
  normalizeRoster: normalizeRoster,
  extractJson: extractJson,
  // 提示词对外暴露，供离线对比脚本使用。
  // 对比脚本必须跑「线上正在用的那套提示词」——另抄一份必然与这里漂移，
  // 那样测出来的就不是线上行为了。
  RECEIPT_SYSTEM_PROMPT: RECEIPT_SYSTEM_PROMPT,
  ROSTER_SYSTEM_PROMPT: ROSTER_SYSTEM_PROMPT,
}
