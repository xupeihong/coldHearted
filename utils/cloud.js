/**
 * 云服务客户端（全局唯一实例）
 *
 * 数据库、登录、文件存储、AI 识别共用这一个 client。
 * 请勿在此之外重新创建客户端，也不要手写 wx.request 直连 /.cloud/**。
 *
 * SDK 来源：@tencent-ai/workbuddy-cloud-sdk 0.1.3-dev.c090db7.202610050023
 * 引用的是内置副本 libs/workbuddy-cloud-sdk.js（即包内 miniprogram_dist/miniprogram.js
 * 的原样拷贝，自包含、无外部依赖）。这样可以完全不依赖开发者工具的「构建 npm」。
 * 升级 SDK 时：npm install 后把 node_modules/@tencent-ai/workbuddy-cloud-sdk/
 * miniprogram_dist/miniprogram.js 重新拷贝覆盖到 libs/workbuddy-cloud-sdk.js 即可。
 *
 * ⚠️ 覆盖前先搜 WB-PATCH-P1：内置副本里有一处本地补丁（非上游代码），
 *    补齐了上游缺失的二进制请求体分支。少了它，cloud.storage.upload() 会直接抛
 *    「暂不支持非字符串 body」，凭证照片传不上去。覆盖会丢掉补丁，需重新施加。
 */
const { createMiniProgramWorkBuddyCloud } = require('../libs/workbuddy-cloud-sdk')
const { createDiagnosticWx } = require('./workbuddy-cloud-diagnostics')
const { publicConfig } = require('./config')

const cloud = createMiniProgramWorkBuddyCloud({
  endpoint: publicConfig.endpoint,
  publishableKey: publicConfig.publishableKey,
  wx: createDiagnosticWx(wx),
})

module.exports = { cloud }
