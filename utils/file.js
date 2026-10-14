/**
 * 本地文件读取工具
 *
 * 小程序没有浏览器 File / FileReader，上传与识别都要先经文件系统读取。
 */

const ALLOWED_IMAGE_EXT = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp']

function extOf(filePath) {
  const raw = String(filePath || '').split('?')[0]
  const dot = raw.lastIndexOf('.')
  if (dot < 0) return 'jpg'
  const ext = raw.slice(dot + 1).toLowerCase()
  return ALLOWED_IMAGE_EXT.indexOf(ext) >= 0 ? ext : 'jpg'
}

function mimeOf(ext) {
  if (ext === 'png') return 'image/png'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'gif') return 'image/gif'
  if (ext === 'bmp') return 'image/bmp'
  return 'image/jpeg'
}

function readFile(filePath, encoding) {
  return new Promise(function (resolve, reject) {
    const options = {
      filePath: filePath,
      success: function (res) {
        resolve(res.data)
      },
      fail: function (err) {
        reject(new Error((err && err.errMsg) || '读取本地文件失败'))
      },
    }
    if (encoding) options.encoding = encoding
    wx.getFileSystemManager().readFile(options)
  })
}

/** 读取为 ArrayBuffer，用于上传 */
function readAsArrayBuffer(filePath) {
  return readFile(filePath)
}

/** 读取为 base64 字符串，用于模型识别 */
function readAsBase64(filePath) {
  return readFile(filePath, 'base64')
}

/** 压缩图片，降低上传体积与识别耗时 */
function compressImage(src, quality) {
  return new Promise(function (resolve) {
    if (!wx.compressImage) {
      resolve(src)
      return
    }
    wx.compressImage({
      src: src,
      quality: typeof quality === 'number' ? quality : 70,
      success: function (res) {
        resolve(res.tempFilePath || src)
      },
      fail: function () {
        resolve(src)
      },
    })
  })
}

/** 取文件字节数；拿不到时返回 0，调用方按「未知」处理 */
function fileSize(filePath) {
  try {
    const stat = wx.getFileSystemManager().statSync(filePath)
    return stat && stat.size ? stat.size : 0
  } catch (e) {
    return 0
  }
}

/**
 * 识别专用压缩：保留文字细节
 *
 * 手写礼金簿靠的是笔画结构，压缩过狠会把连笔和偏旁压成一片模糊，
 * 模型再强也读不出来。所以这里用远高于上传用途的质量。
 * 原图特别大时（超过 3MB）再降一档，避免 base64 后请求体过大。
 *
 * @param {string} src 原图本地路径
 * @returns {Promise<string>} 适合送进模型的图片路径
 */
async function compressForVision(src) {
  const QUALITY_GOOD = 88
  const QUALITY_SAFE = 72
  const SIZE_LIMIT = 3 * 1024 * 1024

  const good = await compressImage(src, QUALITY_GOOD)
  const size = fileSize(good)
  if (!size || size <= SIZE_LIMIT) return good
  return await compressImage(src, QUALITY_SAFE)
}

module.exports = {
  extOf: extOf,
  mimeOf: mimeOf,
  readAsArrayBuffer: readAsArrayBuffer,
  readAsBase64: readAsBase64,
  compressImage: compressImage,
  compressForVision: compressForVision,
  fileSize: fileSize,
}
