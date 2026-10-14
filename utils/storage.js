/**
 * 凭证照片存储
 *
 * 照片放在当前用户自己的目录下，只有本人可读写；
 * 展示时用短期签名链接，不落长期可访问的公网地址。
 */
const { cloud } = require('./cloud')
const { extOf, mimeOf, readAsArrayBuffer, compressImage } = require('./file')

function randomTag() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

async function requireSessionId() {
  const result = await cloud.auth.getSession()
  if (result && result.error) throw new Error('登录状态已失效，请重新登录')
  const session = result ? result.data : null
  if (!session || !session.user || !session.user.id) {
    throw new Error('请先登录后再上传照片')
  }
  return session.user.id
}

/**
 * 上传一张凭证照片
 * @returns {Promise<string>} 存储对象路径，写入 records.photo_path
 */
async function uploadReceipt(localPath) {
  const userId = await requireSessionId()
  const compressed = await compressImage(localPath, 70)
  const ext = extOf(compressed)
  const body = await readAsArrayBuffer(compressed)
  const objectPath = cloud.storage.userPath(userId, 'receipts/' + randomTag() + '.' + ext)

  const result = await cloud.storage.upload(objectPath, body, {
    contentType: mimeOf(ext),
    cacheControl: '3600',
    upsert: false,
  })
  if (result && result.error) {
    throw new Error(result.error.message || '照片上传失败，请稍后重试')
  }
  return objectPath
}

/** 取一个短期可访问的图片地址，用于展示 */
async function receiptUrl(objectPath, ttlSeconds) {
  if (!objectPath) return ''

  const result = await cloud.storage.createSignedUrl(objectPath, ttlSeconds || 3600)
  if (result && result.error) throw new Error(result.error.message || '照片读取失败')

  const data = result ? result.data : null
  if (typeof data === 'string') return data
  if (data && typeof data === 'object') {
    return data.signedUrl || data.signedURL || data.url || ''
  }
  return ''
}

async function removeReceipt(objectPath) {
  if (!objectPath) return true
  const result = await cloud.storage.remove([objectPath])
  if (result && result.error) throw new Error(result.error.message || '照片删除失败')
  return true
}

module.exports = {
  uploadReceipt: uploadReceipt,
  receiptUrl: receiptUrl,
  removeReceipt: removeReceipt,
}
