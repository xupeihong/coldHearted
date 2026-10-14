/**
 * 视觉模型同图对比：同一张照片分别用多个模型识别，比较条目级结果
 *
 * 为什么单独写这个脚本、而不是直接调 ai.js 的 recognizeRoster：
 * recognizeRoster 走的是降级链，一个模型跑不通会自动换下一个，
 * 那样就分不清「这个结果是谁给的」「中间失败了几次」。
 * 对比实验必须锁死单模型，否则测的不是模型差异而是链路行为。
 *
 * 提示词从 utils/ai.js 取生产版本（ROSTER_SYSTEM_PROMPT），不另抄一份——
 * 抄一份必然与线上漂移，测出来就不是线上的行为。
 *
 * 用法：
 *   node verify-vision-compare.js <图片路径> [更多图片...]
 *
 * 可选：与图片同目录放 <图片文件名>.truth.json 提供标准答案，脚本会自动算准确率
 *   { "items": [ { "name": "张三", "amount": 1000 }, ... ] }
 *
 * 注意：脚本走真实网络（wx.request 桩换成真实 fetch），会真实消耗配额。
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')

/** 对比对象：按倍率从省到贵排列，覆盖「最省 / 当前默认 / 最强」三个档 */
const MODELS = ['glm-5.3-flash', 'glm-5v-turbo', 'glm-5.3']

global.wx = {
  /**
   * 传输桩必须同时支持两种模式，SDK 是按 enableChunked 分岔的：
   *  - 非流式（数据库等）：走 options.success，data 需能被 JSON.parse
   *  - 流式（LLM）：wx.request 必须返回 requestTask，SDK 会在 task 上挂
   *    onHeadersReceived / onChunkReceived 来收 SSE 分块。少了这两个方法，
   *    SDK 直接抛 "Cannot read properties of undefined (reading 'onHeadersReceived')"。
   *    所以这里要把 fetch 的响应体按块喂回 onChunkReceived。
   */
  request: function (options) {
    const isChunked = options.enableChunked === true
    const method = (options.method || 'GET').toUpperCase()
    const body = typeof options.data === 'string' ? options.data : JSON.stringify(options.data || {})

    const task = {
      _onHeaders: null,
      _onChunk: null,
      _aborted: false,
      abort: function () { task._aborted = true },
      onHeadersReceived: function (cb) { task._onHeaders = cb },
      onChunkReceived: function (cb) { task._onChunk = cb },
    }

    fetch(options.url, { method: method, headers: options.header || {}, body: method === 'GET' ? undefined : body })
      .then(function (res) {
        const headers = {}
        res.headers.forEach(function (v, k) { headers[k] = v })
        if (task._onHeaders) task._onHeaders({ header: headers })

        if (!isChunked) {
          return res.text().then(function (text) {
            let parsed = text
            try { parsed = JSON.parse(text) } catch (e) { parsed = text }
            if (options.success) options.success({ statusCode: res.status, data: parsed, header: headers })
            if (options.complete) options.complete({})
          })
        }

        const reader = res.body.getReader()
        return (function pump() {
          return reader.read().then(function (r) {
            if (r.done || task._aborted) {
              if (options.success) options.success({ statusCode: res.status, data: '', header: headers })
              if (options.complete) options.complete({})
              return
            }
            if (task._onChunk && r.value) {
              const v = r.value
              task._onChunk({ data: v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) })
            }
            return pump()
          })
        })()
      })
      .catch(function (err) {
        if (options.fail) options.fail({ errMsg: 'request:fail ' + err.message })
        if (options.complete) options.complete({})
      })

    return task
  },
  getStorageSync: function () { return '' },
  setStorageSync: function () {},
  removeStorageSync: function () {},
  getAccountInfoSync: function () { return { miniProgram: { appId: 'wxcompare00000000' } } },
  getFileSystemManager: function () {
    return {
      readFile: function (opts) {
        fs.readFile(opts.filePath, function (err, buf) {
          if (err) {
            if (opts.fail) opts.fail({ errMsg: 'readFile:fail ' + err.message })
            return
          }
          if (opts.success) opts.success({ data: opts.encoding === 'base64' ? buf.toString('base64') : buf })
        })
      },
      statSync: function (p) { return { size: fs.statSync(p).size } },
    }
  },
  // 刻意不做真实压缩：对比实验要固定输入，各模型必须看到完全相同的像素。
  // 这里压缩只影响「送什么图」，不影响模型差异，透传原图即可。
  compressImage: function (opts) { if (opts.success) opts.success({ tempFilePath: opts.src }) },
}

global.Page = function () {}
global.App = function () {}
global.Component = function () {}

const { cloud } = require(path.join(ROOT, 'utils', 'cloud.js'))
const ai = require(path.join(ROOT, 'utils', 'ai.js'))
const { todayStr } = require(path.join(ROOT, 'utils', 'format.js'))

/** 与 ai.js 的 rosterSpec.userText 保持一致；提示词本体直接取导出常量 */
const ROSTER_USER_TEXT =
  '请识别这一页礼金簿名单上的所有人名与金额。今天是 ' + todayStr() +
  '，遇到「今天」「昨天」这类相对日期请据此换算。按约定只返回 JSON。'

let totalCredit = 0
let totalMs = 0
let totalCalls = 0

/**
 * 用指定模型问一次。
 * response_format 不是所有模型都认，被拒就摘掉重试——与 ai.js 的策略一致。
 */
async function askOnce(modelId, base64, withJsonFormat) {
  const started = Date.now()
  let text = ''
  let truncated = false
  let credit = null
  let totalTokens = null

  const payload = {
    model: modelId,
    messages: [
      { role: 'system', content: ai.ROSTER_SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: ROSTER_USER_TEXT },
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + base64 } },
        ],
      },
    ],
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: 8192,
    temperature: 0.1,
  }
  if (withJsonFormat) payload.response_format = { type: 'json_object' }

  for await (const chunk of cloud.llm.chat.completions.create(payload)) {
    const choice = chunk && chunk.choices && chunk.choices[0]
    if (choice) {
      if (choice.finish_reason === 'length') truncated = true
      const delta = choice.delta
      if (delta && typeof delta.content === 'string') text += delta.content
    }
    if (chunk && chunk.usage) {
      credit = chunk.usage.credit
      totalTokens = chunk.usage.total_tokens
    }
  }

  return { text: text, truncated: truncated, credit: credit, totalTokens: totalTokens, ms: Date.now() - started }
}

function isParamRejection(error) {
  const text = ((error && error.message) || '') + ' ' + ((error && error.error && error.error.code) || '')
  return /response_format|json_object|unsupported|unknown.?parameter|invalid.?request|unrecognized/i.test(text)
}

async function askModel(modelId, base64) {
  try {
    return await askOnce(modelId, base64, true)
  } catch (e) {
    if (!isParamRejection(e)) throw e
    return await askOnce(modelId, base64, false)
  }
}

function loadTruth(imgPath) {
  const truthPath = imgPath + '.truth.json'
  if (!fs.existsSync(truthPath)) return null
  try {
    const raw = JSON.parse(fs.readFileSync(truthPath, 'utf8'))
    if (raw && Array.isArray(raw.items)) return raw
  } catch (e) {
    console.log('  标准答案解析失败：' + e.message)
  }
  return null
}

/** 条目级计分：姓名与金额都对上才算命中 */
function score(parsed, truth) {
  const truthKeys = truth.items.map(function (t) { return String(t.name).trim() + '|' + Number(t.amount) })
  const gotKeys = parsed.items.map(function (i) { return String(i.name).trim() + '|' + Number(i.amount) })
  const hit = gotKeys.filter(function (k) { return truthKeys.indexOf(k) >= 0 }).length
  return {
    hit: hit,
    truthCount: truthKeys.length,
    gotCount: gotKeys.length,
    recall: truthKeys.length ? hit / truthKeys.length : 0,
    precision: gotKeys.length ? hit / gotKeys.length : 0,
  }
}

function pct(n) { return (n * 100).toFixed(1) + '%' }

async function compareOnImage(imgPath) {
  console.log('='.repeat(72))
  console.log('图片：' + path.basename(imgPath))
  const bytes = fs.statSync(imgPath).size
  console.log('体积：' + (bytes / 1024).toFixed(1) + ' KB')

  const truth = loadTruth(imgPath)
  console.log('标准答案：' + (truth ? truth.items.length + ' 条' : '未提供（只能做模型间一致性比对）'))
  console.log('')

  const base64 = fs.readFileSync(imgPath).toString('base64')
  const results = []

  for (let i = 0; i < MODELS.length; i += 1) {
    const modelId = MODELS[i]
    process.stdout.write('  ' + modelId.padEnd(18))
    try {
      const r = await askModel(modelId, base64)
      totalCalls += 1
      totalMs += r.ms
      if (typeof r.credit === 'number') totalCredit += r.credit
      const parsed = ai.normalizeRoster(ai.extractJson(r.text), r.truncated)
      console.log(
        (parsed ? String(parsed.items.length) + ' 条' : '解析失败').padEnd(10) +
        String(r.ms) + 'ms' +
        '  credit=' + (r.credit === null || r.credit === undefined ? 'n/a' : r.credit) +
        '  tokens=' + (r.totalTokens === null || r.totalTokens === undefined ? 'n/a' : r.totalTokens)
      )
      results.push({ modelId: modelId, parsed: parsed, raw: r })
    } catch (e) {
      console.log('异常：' + e.message)
      results.push({ modelId: modelId, error: e.message })
    }
  }

  console.log('')

  /* 逐模型明细 */
  results.forEach(function (r) {
    console.log('--- ' + r.modelId + ' ---')
    if (!r.parsed) {
      console.log('  ' + (r.error || '没有解析出可用条目'))
      console.log('')
      return
    }
    r.parsed.items.forEach(function (item, idx) {
      console.log(
        '  ' + String(idx + 1).padStart(2) + '. ' +
        item.name.padEnd(12) +
        String(item.amount).padStart(8) +
        (item.relation ? '  ' + item.relation : '') +
        (item.note ? '  [' + item.note + ']' : '')
      )
    })
    if (r.parsed.zeroAmountCount) console.log('  （其中 ' + r.parsed.zeroAmountCount + ' 条金额为 0）')
    console.log('')
  })

  /* 与标准答案比对 */
  if (truth) {
    console.log('--- 条目级准确率（姓名 + 金额 完全一致才算命中）---')
    results.forEach(function (r) {
      if (!r.parsed) { console.log('  ' + r.modelId.padEnd(18) + '无法计分'); return }
      const s = score(r.parsed, truth)
      console.log(
        '  ' + r.modelId.padEnd(18) +
        '命中 ' + String(s.hit) + '/' + String(s.truthCount) +
        '  召回 ' + pct(s.recall) +
        '  精确 ' + pct(s.precision) +
        '  返回 ' + String(s.gotCount) + ' 条'
      )
    })
    console.log('')
  }

  /* 模型间一致性：以条目最多的那个为基准 */
  const ok = results.filter(function (r) { return r.parsed })
  if (ok.length >= 2) {
    let base = ok[0]
    ok.forEach(function (r) { if (r.parsed.items.length > base.parsed.items.length) base = r })
    console.log('--- 与「' + base.modelId + '」的差异（基准 ' + base.parsed.items.length + ' 条）---')
    const baseKeys = base.parsed.items.map(function (i) { return i.name + '|' + i.amount })
    ok.forEach(function (r) {
      if (r === base) return
      const keys = r.parsed.items.map(function (i) { return i.name + '|' + i.amount })
      const onlyBase = baseKeys.filter(function (k) { return keys.indexOf(k) < 0 })
      const onlyThis = keys.filter(function (k) { return baseKeys.indexOf(k) < 0 })
      console.log(
        '  ' + r.modelId + '：少 ' + onlyBase.length + ' 条，多 ' + onlyThis.length + ' 条' +
        (onlyThis.length ? '  多出的是：' + onlyThis.join(' / ') : '')
      )
    })
    console.log('')
  }

  return results
}

async function main() {
  const imgs = process.argv.slice(2)
  if (!imgs.length) {
    console.log('用法：node verify-vision-compare.js <图片路径> [更多图片...]')
    console.log('')
    console.log('可选：与图片同目录放 <图片文件名>.truth.json 提供标准答案，脚本会自动算条目级准确率。')
    process.exit(1)
  }

  const missing = imgs.filter(function (p) { return !fs.existsSync(p) })
  if (missing.length) {
    console.log('以下文件不存在：')
    missing.forEach(function (p) { console.log('  ' + p) })
    process.exit(1)
  }

  console.log('对比模型：' + MODELS.join(' / '))
  console.log('提示词：取自 utils/ai.js 的 ROSTER_SYSTEM_PROMPT（生产版本）')
  console.log('')

  for (let i = 0; i < imgs.length; i += 1) {
    await compareOnImage(imgs[i])
  }

  console.log('='.repeat(72))
  console.log('汇总：共 ' + totalCalls + ' 次调用，累计耗时 ' + (totalMs / 1000).toFixed(1) + 's，累计 credit ' + totalCredit.toFixed(2))
  console.log('说明：credit 是模型清单里的展示倍率口径，不是最终账单；文档明确它不是计费事实。')
}

main().catch(function (e) {
  console.log('脚本异常：' + (e && e.stack))
  process.exit(1)
})
