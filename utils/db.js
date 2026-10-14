/**
 * 数据访问层
 *
 * 所有读写都走这一层，前端不做「这行是不是我的」判断 —— 归属由数据库的
 * owner_id DEFAULT auth.uid() 与 RLS 策略决定，客户端从不传 owner_id。
 */
const { cloud } = require('./cloud')
const { removeReceipt } = require('./storage')

const RECORD_FIELDS =
  'id, contact_id, contact_name, direction, amount, event_type, happened_on, is_settled, settled_at, photo_path, note, created_at'

const CONTACT_FIELDS = 'id, name, relation, note, created_at'

function CloudError(message, code) {
  const err = new Error(message)
  err.name = 'CloudError'
  err.code = code || ''
  return err
}

function unwrap(result) {
  if (result && result.error) {
    const raw = result.error
    throw CloudError(raw.message || '云端请求失败，请稍后重试', raw.code || '')
  }
  return result ? result.data : null
}

function asArray(data) {
  return Array.isArray(data) ? data : []
}

/* ------------------------------- 登录态 ------------------------------- */

async function getSession() {
  try {
    const result = await cloud.auth.getSession()
    if (!result || result.error) return null
    return result.data || null
  } catch (e) {
    return null
  }
}

/* ------------------------------- 人情流水 ------------------------------- */

/** 账本页一页列表的条数，大约两屏 */
const RECORD_PAGE_SIZE = 20

/** 内部翻页取全量时每页请求多少条。PostgREST 单次返回有条数上限，500 是安全值 */
const SCAN_PAGE_SIZE = 500

/** 内部翻页的页数上限，防御意外的超大表把小程序耗死在循环里 */
const SCAN_MAX_PAGES = 40

/** 未结记录一次最多取多少条；按日期升序取，最先被截掉的恰好是最不可能触发提醒的新记录 */
const PENDING_LIMIT = 1000

/** PostgREST 把 numeric 序列化成字符串（"11200.00"），统一转成数字再用 */
function toCount(value) {
  const n = Number(value)
  return isFinite(n) ? n : 0
}

/**
 * 读全量流水（内部自动翻页）
 *
 * 这里原来是一条 `.limit(500)`：第 501 笔起会被数据库悄悄丢掉，而调用方拿到的
 * 数组看起来完全正常。往来页的按人汇总、我的页统计、批量录入的入库查重都建立在
 * 这份数据上，于是全都跟着算错，且没有任何地方会报错 —— 修的是这个。
 *
 * 排序带上 id 是为了保证翻页期间的全序稳定：happened_on 会重复，只按它排序时
 * offset 分页可能重复或漏行。
 *
 * @param {string} [fields] 只取部分列可显著减小传输量（例如查重只需要三个字段）
 * @returns {Promise<object[]>}
 */
async function listAllRecords(fields) {
  const columns = fields || RECORD_FIELDS
  const rows = []

  for (let page = 0; page < SCAN_MAX_PAGES; page += 1) {
    const from = page * SCAN_PAGE_SIZE
    const data = unwrap(
      await cloud.database
        .from('records')
        .select(columns)
        .order('happened_on', { ascending: false })
        .order('id', { ascending: false })
        .range(from, from + SCAN_PAGE_SIZE - 1)
    )
    const chunk = asArray(data)
    for (let i = 0; i < chunk.length; i += 1) rows.push(chunk[i])
    if (chunk.length < SCAN_PAGE_SIZE) return rows
  }

  console.warn(
    '[人情账簿] 流水翻页达到页数上限，可能有数据未读出',
    JSON.stringify({ pages: SCAN_MAX_PAGES, size: SCAN_PAGE_SIZE })
  )
  return rows
}

/**
 * 服务端聚合：账本页统计卡与「我的」页概览
 *
 * 这些数字是全量口径，但不需要全量明细。交给数据库的 records_stats() 算完，
 * 传输量从「每笔记录」降到「一行数字」，也就跟着摆脱了条数上限。
 *
 * records_stats() 以 SECURITY INVOKER 创建，行级安全照常生效，只会聚合到自己的账。
 */
async function getRecordsStats() {
  const data = unwrap(await cloud.database.rpc('records_stats'))
  const row = asArray(data)[0] || {}
  return {
    totalCount: toCount(row.total_count),
    peopleCount: toCount(row.people_count),
    inTotal: toCount(row.in_total),
    outTotal: toCount(row.out_total),
    oweAmount: toCount(row.owe_amount),
    oweCount: toCount(row.owe_count),
    backAmount: toCount(row.back_amount),
    backCount: toCount(row.back_count),
  }
}

/**
 * 分页读一页流水
 *
 * 筛选条件下推到数据库执行，而不是在客户端过滤 —— 客户端只持有当前几页，
 * 在那里过滤只会得出「没有符合条件的记录」这种假结论。
 *
 * 每页多取一条用来判断还有没有下一页：省掉一次 count 往返，也不必依赖 SDK 的
 * count 选项（该产物版本的 select() 只接受一个参数，不支持 count）。
 *
 * @param {object} query { settled: 'all'|'wait'|'done', direction: 'all'|'in'|'out' }
 * @param {number} page 从 0 开始
 * @returns {Promise<{rows: object[], hasMore: boolean}>}
 */
async function listRecordsPage(query, page) {
  const index = Number(page) > 0 ? Math.floor(Number(page)) : 0
  const from = index * RECORD_PAGE_SIZE

  let builder = cloud.database
    .from('records')
    .select(RECORD_FIELDS)
    .order('happened_on', { ascending: false })
    .order('id', { ascending: false })
    .range(from, from + RECORD_PAGE_SIZE)

  const filter = query || {}
  if (filter.direction === 'in' || filter.direction === 'out') {
    builder = builder.eq('direction', filter.direction)
  }
  if (filter.settled === 'wait') {
    builder = builder.eq('is_settled', false)
  } else if (filter.settled === 'done') {
    builder = builder.eq('is_settled', true)
  }

  const rows = asArray(unwrap(await builder))
  const hasMore = rows.length > RECORD_PAGE_SIZE
  return {
    rows: hasMore ? rows.slice(0, RECORD_PAGE_SIZE) : rows,
    hasMore: hasMore,
  }
}

/**
 * 未结清的人情，按发生日期升序（最老的在前）
 *
 * 待还提醒只关心「拖了多久」，所以超限时保留最老的一批；真实未结总数由
 * getRecordsStats() 给出，不受这个上限影响。
 */
async function listPendingRecords() {
  const data = unwrap(
    await cloud.database
      .from('records')
      .select(RECORD_FIELDS)
      .eq('is_settled', false)
      .order('happened_on', { ascending: true })
      .limit(PENDING_LIMIT)
  )
  const rows = asArray(data)
  if (rows.length >= PENDING_LIMIT) {
    console.warn(
      '[人情账簿] 未结记录已达上限，提醒只覆盖最早的一批',
      JSON.stringify({ limit: PENDING_LIMIT })
    )
  }
  return rows
}

async function getRecord(id) {
  const data = unwrap(
    await cloud.database.from('records').select(RECORD_FIELDS).eq('id', id).maybeSingle()
  )
  return data || null
}

function buildRecordRow(payload) {
  const settled = !!payload.isSettled
  const row = {
    contact_name: String(payload.contactName || '').trim(),
    direction: payload.direction === 'out' ? 'out' : 'in',
    amount: Number(payload.amount) || 0,
    event_type: payload.eventType ? String(payload.eventType).trim() : null,
    happened_on: payload.happenedOn || null,
    is_settled: settled,
    settled_at: settled ? new Date().toISOString() : null,
    photo_path: payload.photoPath || null,
    note: payload.note ? String(payload.note).trim() : null,
  }
  if (payload.contactId) row.contact_id = payload.contactId
  return row
}

async function createRecord(payload) {
  const data = unwrap(
    await cloud.database.from('records').insert(buildRecordRow(payload)).select()
  )
  const rows = asArray(data)
  if (!rows.length) throw CloudError('记录未能保存，请稍后重试')
  return rows[0]
}

/**
 * 批量写入人情记录
 *
 * 整页礼金簿一次入库十几二十条，逐条发请求太慢，SDK 的 insert 支持数组，
 * 一条语句就能写完。
 *
 * @param {object[]} payloads
 * @returns {Promise<object[]>} 写入后的行
 */
async function createRecords(payloads) {
  const list = asArray(payloads).filter(function (item) {
    return item && String(item.contactName || '').trim()
  })
  if (!list.length) throw CloudError('没有可保存的记录')

  const rows = list.map(buildRecordRow)
  const data = unwrap(
    await cloud.database.from('records').insert(rows).select(RECORD_FIELDS)
  )
  const created = asArray(data)
  if (created.length !== rows.length) {
    throw CloudError('这批记录没能全部保存，请重试')
  }
  return created
}

async function updateRecord(id, payload) {
  const data = unwrap(
    await cloud.database.from('records').update(buildRecordRow(payload)).eq('id', id).select()
  )
  const rows = asArray(data)
  if (!rows.length) throw CloudError('没能修改这条记录，它可能不属于当前账号')
  return rows[0]
}

/** 划掉 / 取消划掉：一条人情是否已经了结 */
async function setRecordSettled(id, settled) {
  const data = unwrap(
    await cloud.database
      .from('records')
      .update({ is_settled: !!settled, settled_at: settled ? new Date().toISOString() : null })
      .eq('id', id)
      .select()
  )
  const rows = asArray(data)
  if (!rows.length) throw CloudError('没能修改这条记录，它可能不属于当前账号')
  return rows[0]
}

/**
 * 尝试清理一张凭证照片
 *
 * 照片是记录的附属物：清理失败只记日志，不能反过来让已经成功的删除看起来像失败。
 */
async function cleanupReceipt(objectPath) {
  if (!objectPath) return false
  try {
    await removeReceipt(objectPath)
    return true
  } catch (e) {
    console.warn(
      '[人情账簿] 凭证照片清理失败',
      JSON.stringify({ objectPath: objectPath, message: e && e.message })
    )
    return false
  }
}

/**
 * 清掉一张「已经没人用」的凭证照片
 *
 * 批量录入时，一页礼金簿上的所有人共享同一张照片。如果还按「删记录就删照片」
 * 处理，删掉其中一条就会让其余几十条的凭证全部变成裂图。
 * 所以删除文件前必须先确认没有别的记录还引用它。
 *
 * 调用时机很关键：要在记录被删除或被改掉 photo_path **之后**再调，
 * 这时查到的才是「剩余引用」。
 *
 * @returns {Promise<boolean>} 是否真的删除了文件
 */
async function cleanupReceiptIfUnused(objectPath) {
  if (!objectPath) return false
  try {
    const data = unwrap(
      await cloud.database.from('records').select('id').eq('photo_path', objectPath).limit(1)
    )
    if (asArray(data).length) return false
  } catch (e) {
    // 查不到引用情况时宁可留着文件，也不要冒删掉别人凭证的风险
    console.warn(
      '[人情账簿] 凭证引用检查失败，已保留文件',
      JSON.stringify({ objectPath: objectPath, message: e && e.message })
    )
    return false
  }
  return cleanupReceipt(objectPath)
}

async function removeRecord(id) {
  // 先取原照片路径：行删掉之后就查不到了，而存储里的文件不会跟着消失
  const existing = await getRecord(id)
  const photoPath = existing && existing.photo_path ? existing.photo_path : ''

  const data = unwrap(await cloud.database.from('records').delete().eq('id', id).select())
  if (!asArray(data).length) throw CloudError('没能删除这条记录，它可能不属于当前账号')

  // 行已删除，此时再判断这张照片是否还有别的记录在用
  await cleanupReceiptIfUnused(photoPath)
  return true
}

/* ------------------------------ 往来对象 ------------------------------ */

async function listContacts() {
  const data = unwrap(
    await cloud.database.from('contacts').select(CONTACT_FIELDS).order('name', { ascending: true }).limit(1000)
  )
  return asArray(data)
}

async function findContactByName(name) {
  const trimmed = String(name || '').trim()
  if (!trimmed) return null
  const data = unwrap(
    await cloud.database.from('contacts').select(CONTACT_FIELDS).eq('name', trimmed).limit(1)
  )
  return asArray(data)[0] || null
}

/** 按姓名取往来对象，没有就建一个 */
async function ensureContact(name, relation) {
  const trimmed = String(name || '').trim()
  if (!trimmed) return null

  const existing = await findContactByName(trimmed)
  if (existing) return existing

  try {
    const data = unwrap(
      await cloud.database
        .from('contacts')
        .insert({ name: trimmed, relation: relation ? String(relation).trim() : null })
        .select()
    )
    const rows = asArray(data)
    if (rows.length) return rows[0]
  } catch (e) {
    // 23505：并发下同名已存在，回查一次即可
    if (e && e.code === '23505') return findContactByName(trimmed)
    throw e
  }
  return findContactByName(trimmed)
}

/**
 * 一次性备好整页的往来对象
 *
 * 逐个 ensureContact 会变成 2N 次请求（20 人就是 40 次）。整页录入时
 * 先拉一次全量名单建映射，缺的批量补插，请求数降到 2 次。
 *
 * @param {string[]} names 姓名列表，允许重复
 * @returns {Promise<object>} name -> contact.id
 */
async function ensureContacts(names) {
  const unique = []
  const seen = {}
  asArray(names).forEach(function (raw) {
    const name = String(raw || '').trim()
    if (name && !seen[name]) {
      seen[name] = true
      unique.push(name)
    }
  })
  if (!unique.length) return {}

  const map = {}
  const existing = await listContacts()
  existing.forEach(function (item) {
    if (item && item.name) map[item.name] = item.id
  })

  const missing = unique.filter(function (name) {
    return !map[name]
  })
  if (missing.length) {
    try {
      const data = unwrap(
        await cloud.database
          .from('contacts')
          .insert(
            missing.map(function (name) {
              return { name: name }
            })
          )
          .select(CONTACT_FIELDS)
      )
      asArray(data).forEach(function (item) {
        if (item && item.name) map[item.name] = item.id
      })
    } catch (e) {
      // 并发下可能撞上 UNIQUE(owner_id, name)，回退成逐个兜底
      for (let i = 0; i < missing.length; i += 1) {
        const contact = await ensureContact(missing[i], '')
        if (contact) map[missing[i]] = contact.id
      }
    }
  }
  return map
}

/** 某个凭证照片下已有多少条记录；批量录入时用来提示「这张图可能已经录过」 */
async function countRecordsByPhoto(photoPath) {
  if (!photoPath) return 0
  const data = unwrap(
    await cloud.database.from('records').select('id').eq('photo_path', photoPath).limit(200)
  )
  return asArray(data).length
}

async function updateContact(id, patch) {
  const row = {}
  if (typeof patch.name === 'string') row.name = patch.name.trim()
  if (typeof patch.relation === 'string') row.relation = patch.relation.trim() || null
  if (typeof patch.note === 'string') row.note = patch.note.trim() || null

  const data = unwrap(await cloud.database.from('contacts').update(row).eq('id', id).select())
  const rows = asArray(data)
  if (!rows.length) throw CloudError('没能修改这个往来对象')
  return rows[0]
}

async function removeContact(id) {
  const data = unwrap(await cloud.database.from('contacts').delete().eq('id', id).select())
  if (!asArray(data).length) throw CloudError('没能删除这个往来对象')
  return true
}

module.exports = {
  getSession: getSession,
  listAllRecords: listAllRecords,
  listRecordsPage: listRecordsPage,
  listPendingRecords: listPendingRecords,
  getRecordsStats: getRecordsStats,
  getRecord: getRecord,
  createRecord: createRecord,
  createRecords: createRecords,
  updateRecord: updateRecord,
  setRecordSettled: setRecordSettled,
  removeRecord: removeRecord,
  cleanupReceipt: cleanupReceipt,
  cleanupReceiptIfUnused: cleanupReceiptIfUnused,
  countRecordsByPhoto: countRecordsByPhoto,
  listContacts: listContacts,
  findContactByName: findContactByName,
  ensureContact: ensureContact,
  ensureContacts: ensureContacts,
  updateContact: updateContact,
  removeContact: removeContact,
}
