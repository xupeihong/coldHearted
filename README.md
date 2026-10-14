<div align="center">

<img src="docs/qrcode.png" width="280" alt="人情账簿小程序码" />

# 人情账簿

**记录人情往来，拍照留存凭证，随时核销**

原生微信小程序 · 免安装 · 扫码即用

</div>

---

## 这是什么

一份记在云端的人情账本。谁家办事随了礼、谁还了人情、自己还欠着谁——拍照、录一笔、划掉一笔，账目永远清楚。

传统礼金簿的痛点是**纸面上的人情没法检索和汇总**：一年后想查「上个月表哥结婚我随了多少」，要一页页翻。人情账簿把这件事变成一次搜索。

## 功能特性

### 记账

- **拍照识别单笔凭证** —— 拍一张礼金簿或收礼单，AI 自动读出姓名、金额、事由、日期，确认后入库
- **礼金簿整页批量录入** —— 一页几十人的名单，一次拍照全部识别成候选清单，可逐条修改、取消勾选、手动补行，确认后批量入库
- **手动记一笔** —— 不拍照也能完整记录收/送、金额、事由、日期
- **凭证留档** —— 每笔记录可关联凭证照片，随时回看原图

### 查账

- **账本页** —— 服务端分页浏览，支持按收送方向、是否结清筛选，触底自动加载更早记录
- **统计概览** —— 总笔数、往来人数、累计收/送、待还与待回金额，全部由服务端聚合计算，不受本地数据量影响
- **往来页** —— 按人汇总，一眼看清和每个人之间的人情净差
- **待还提醒** —— 超过阈值（默认 90 天，可设 30/90/180 天或不限）未结清的记录会主动提示
- **划掉核销** —— 已还的人情随手划掉，就地更新、不跳转，滚动位置不丢

### 登录

- **微信一键登录** —— `wx.login` 静默换取会话，零输入
- **手机号验证码登录** —— 备用入口，未注册的手机号自动创建账号

## 技术栈

| 层 | 选型 |
|---|---|
| 前端 | 原生微信小程序（WXML / WXSS / JavaScript），**非 UniApp** |
| 后端 | [WorkBuddy 云服务](https://www.workbuddy.cn)（全托管）：云数据库 / 对象存储 / 账号认证 / LLM 网关 |
| 数据库 | PostgreSQL + 行级安全（RLS），每行 `owner_id` 隔离，用户只能读写自己的账 |
| 识别 | 云端视觉大模型（默认 `glm-5.3-flash`），带降级链 |
| 依赖 | **零 npm 依赖** —— 云服务 SDK 内置于 `libs/`，无需「构建 npm」 |

### 架构上几个值得说的决定

**1. 服务端分页 + 服务端聚合，绝不前端拉全量。**
早期版本用 `.limit(500)` 拉全量来算统计，超过 500 笔后数据被静默截断——统计卡上的金额从第 501 笔起就是错的，而且没有任何提示。现在：

- 列表走 `listRecordsPage()`，真分页，每页 20 条、多取一条判断有无下一页；
- 统计走数据库函数 `records_stats()`，一次返回 8 个数字，传输量与记录条数无关；
- 待还提醒、往来汇总、批量查重各自独立取数，筛选条件下推到数据库。

**2. 行级安全（RLS）是唯一的账本隔离手段。**
客户端不传 `owner_id`，也不做「这行是不是我的」前端判断——数据库层就决定了你只能看到自己的账。聚合函数特意保持 `SECURITY INVOKER` 而非 `SECURITY DEFINER`，避免绕过 RLS。

**3. 识别链路在「图像质量」上花的心思比换模型多。**
礼金簿是手写场景，图像质量的波动比模型差异大得多。小程序取原图（不做 `chooseMedia` 压缩），识别前用质量 88 的 JPEG 从原图重压（仍超 3MB 才降级到 72），上传存档单独压到 70——**严禁两次有损压缩叠加**，那会把笔锋抹平，什么模型都救不回来。

**4. 提示词采用「先转写、后抽字段」两段式。**
先让模型把整页逐字转写成 `transcript`，再基于转写结果抽取结构化字段。直接抽字段时模型会跳过看不清的部分去猜——对礼金簿来说，**猜出来的金额比空白危险得多**，所以提示词里明确「读不出填 0，禁止按邻近行推测」。

## 目录结构

```
renqing-book/
├── app.js / app.json / app.wxss     # 全局入口、页面注册、tabBar 与全局样式
├── assets/tabbar/                   # tabBar 图标（81×81，两态配色）
├── components/
│   └── record-card/                 # 单笔记录卡片
├── pages/
│   ├── index/                       # 账本（首页）：分页列表 + 统计 + 待还提醒
│   ├── add/                         # 记一笔（单条 + 拍照识别）
│   ├── bulk/                        # 礼金簿整页批量录入
│   ├── detail/                      # 记录详情（编辑 / 核销 / 删除）
│   ├── contacts/                    # 往来（按人汇总）
│   ├── mine/                        # 我的（概览 + 设置）
│   └── login/                       # 登录（微信一键 + 手机号验证码）
├── utils/
│   ├── config.js                    # 云服务环境配置（endpoint / publishableKey）
│   ├── cloud.js                     # 云服务 SDK 初始化
│   ├── db.js                        # 数据访问层（分页 / 聚合 / 翻页取全量 / 引用保护删除）
│   ├── storage.js                   # 凭证上传
│   ├── file.js                      # 图片压缩（识别用 / 上传用两套参数）
│   ├── ai.js                        # 识别链路：模型降级链、提示词、结果解析与归一化
│   ├── remind.js                    # 逾期判定（纯函数）
│   ├── format.js                    # 金额 / 日期格式化
│   └── settings.js                  # 本地设置（提醒阈值 / 识别模型）
├── libs/
│   └── workbuddy-cloud-sdk.js       # 内置云服务 SDK（含本地补丁，见下）
├── verify/                          # 开发期验证脚本（不打包进小程序）
└── docs/                            # 文档资料（不打包进小程序）
```

## 快速开始

### 1. 获取代码

```bash
git clone git@github.com:xupeihong/coldHearted.git
```

### 2. 在微信开发者工具中打开

1. 打开**微信开发者工具**（本工程为原生小程序，HBuilderX 不适用）
2. 导入项目，目录选择仓库根目录
3. 填入你自己的小程序 AppID（体验可用测试号）
4. 点「编译」即可运行——**不需要执行「构建 npm」**，云服务 SDK 已内置在 `libs/`

### 3. 配置云服务

`utils/config.js` 需要填入你自己的云服务环境信息：

```js
const publicConfig = {
  resourceId: '<你的资源 ID>',
  endpoint: '<你的云服务网关地址>',
  publishableKey: '<你的客户端密钥>',
}
```

推荐通过 [WorkBuddy](https://www.workbuddy.cn) 创建云服务应用获取这三项，开通后自动具备数据库、存储、认证与大模型调用能力。

### 4. 初始化数据库

在云服务控制台执行两段 SQL：

**建表**（核心字段示意，`owner_id` 默认取当前登录用户）：

```sql
CREATE TABLE records (
  id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  owner_id     TEXT NOT NULL DEFAULT auth.uid(),
  contact_id   TEXT,
  contact_name TEXT NOT NULL,
  direction    TEXT NOT NULL,          -- 'in' 收 / 'out' 送
  amount       NUMERIC(12,2) NOT NULL,
  event_type   TEXT,
  happened_on  DATE NOT NULL,
  is_settled   BOOLEAN NOT NULL DEFAULT false,
  settled_at   TIMESTAMPTZ,
  photo_path   TEXT,
  note         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE contacts (
  id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  owner_id   TEXT NOT NULL DEFAULT auth.uid(),
  name       TEXT NOT NULL,
  relation   TEXT,
  note       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**开启行级安全**（两张表都要）：

```sql
ALTER TABLE records  ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;

CREATE POLICY records_owner_all ON records
  FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());

CREATE POLICY contacts_owner_all ON contacts
  FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
```

**建统计聚合函数**（账本页统计卡依赖）：

```sql
CREATE OR REPLACE FUNCTION records_stats()
RETURNS TABLE (
  total_count bigint, people_count bigint,
  in_total numeric, out_total numeric,
  owe_amount numeric, owe_count bigint,
  back_amount numeric, back_count bigint
)
LANGUAGE sql STABLE
AS $fn$
  SELECT
    COUNT(*)::bigint,
    COUNT(DISTINCT COALESCE(NULLIF(BTRIM(contact_name), ''), '未署名'))::bigint,
    COALESCE(SUM(CASE WHEN direction = 'in'  THEN amount ELSE 0 END), 0)::numeric,
    COALESCE(SUM(CASE WHEN direction = 'out' THEN amount ELSE 0 END), 0)::numeric,
    COALESCE(SUM(CASE WHEN direction = 'in'  AND NOT is_settled THEN amount ELSE 0 END), 0)::numeric,
    COUNT(CASE WHEN direction = 'in'  AND NOT is_settled THEN 1 END)::bigint,
    COALESCE(SUM(CASE WHEN direction = 'out' AND NOT is_settled THEN amount ELSE 0 END), 0)::numeric,
    COUNT(CASE WHEN direction = 'out' AND NOT is_settled THEN 1 END)::bigint
  FROM records
$fn$;
```

> 注意保持默认的 `SECURITY INVOKER`（不要加 `SECURITY DEFINER`），否则聚合会绕过行级安全，变成能读任何人账本的接口。

### 5. 验证环境

仓库自带两套验证脚本（位于 `verify/`，用 Node 直接运行）：

```bash
node verify/verify-ledger-paging.js   # 桩掉网络，验证分页 / 聚合 / 筛选下推 / 就地核销（89 项断言）
node verify/verify-cloud-live.js      # 走真实网络，验证云端聚合端点已生效且 RLS 隔离正确
```

## 数据模型

**records（流水）**：`contact_name` 姓名 · `direction` 收/送 · `amount` 金额 · `event_type` 事由（婚礼/满月/寿宴…自动归一） · `happened_on` 日期 · `is_settled` 是否已核销 · `photo_path` 凭证 · `note` 备注

**contacts（往来对象）**：`name` 姓名 · `relation` 关系 · `note` 备注

## 识别效果

针对手写礼金簿场景，在 4 张真实照片上对多个视觉模型做过条目级实测（姓名 + 金额是否完整读出），结论：

- **`glm-5.3-flash` 完整率最高**——包括最难的一张旋转 90° 横拍图，20 条记录零放弃；
- 成本只有原默认模型的 **约 1/13**；
- 识别失败时自动按降级链换模型重试，识别用的模型可在「我的 → 设置」里手动切换。

识别**只在拍照识别时消耗资源**，手动记账、查账、核销全部零消耗。

## 已知限制

- 批量录入一次识别一页，多页礼金簿需连续拍多页（每次确认后可无缝继续）
- 往来页按人汇总目前拉取全量后本地聚合，记录数极大时首屏会变慢（后续计划改为服务端按人聚合）
- 手写连笔字（尤其人名）识别仍有不确定性，录入后建议扫一眼候选清单

## 说明

- 本项目用于个人人情往来记录，后端数据彼此隔离，账号即边界
- `verify/` 与 `docs/` 目录已通过 `project.config.json` 的 `packOptions.ignore` 排除，不进入小程序包体
- 识别能力依赖云服务的大模型网关，请在自己的云服务环境中配置可用的视觉模型
