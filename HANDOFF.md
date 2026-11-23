# dsh-second-sight 方案交接文档

| 项 | 值 |
|---|---|
| 插件名 | `dsh-second-sight`（中文名：副眼） |
| 版本 | 0.6.0（双胞胎路由 + `ask_image` + 模型面板副眼开关 + GitHub Release 在线升级；副模型会话级、无全局默认） |
| 文档日期 | 2026-11-20（实施记录见第 16–19 节，2026-11-21 / 2026-11-23） |
| 目标宿主 | DSH `0.2.2-rc.1`（`@deepseek-ai/dsh` 各内部包版本一致） |
| 运行环境 | Node ≥ 22.13、Windows 11（示例路径按 win10 机器写） |
| 配套文件 | `index.js`（Host 半边，~1010 行）、`client.js`（浏览器半边，~1200 行）、`update.js`（升级通道，~860 行）、`test/smoke.mjs`（50 组）、`test/client.mjs`（23 组）、`test/gateway-mount.mjs`（8 组）、`test/host-integration.mjs`（8 组，打真实 LlmRuntime/ToolsService）、`test/update.mjs`（升级冒烟）、`package.json`、`cordis.patch.yml` |
| 读者 | 接手开发的你 / 未来的维护者 |

---

## 0. 一页速览

**它解决什么**：DSH 里选中纯文本模型时，图片连发都发不出去——服务端准入检查会以 `MODEL_DOES_NOT_SUPPORT_IMAGES` 拒绝；即使绕过去，请求组装阶段也会把图片替换成一行 8 位 sha256 占位符。结果是「用户的截图 → 模型完全不知道有这回事」。

**它怎么做**：给每个 provider 再注册一条**双胞胎路由** `<provider>-second-sight`，模型表照抄、只把 `inputModalities` 加成 `['text','image']`。用户在选择器里选中双胞胎模型后，三道闸全部放行；请求到达双胞胎适配器时，图片块被替换成**可引用的句柄提示**，主模型通过 `ask_image(image, question)` 工具向副模型（任意已配置的多模态模型）提问，可以一问再问。

**关键性质**：

1. 转写只发生在「发往 provider 的请求投影」里，**不动持久会话**——历史里仍是原图，切回真多模态模型它看到的就是原图。
2. 出题权在主模型：它看过用户原话，能问「这个报错为什么发生在第三行」这类知情问题；一问一答都落成 durable 消息，可审计。
3. 零依赖、零构建，单个 ESM 文件，只用宿主公开 API，**不碰 `@deprecated` 的 `agent/request`**。

**当前状态**：0.5.3 已实施完成并装入 web profile。Host 半边（`index.js`）是双胞胎路由 + 请求投影 + `ask_image` + 预算缓存 + 工具门控 + 生命周期清理，另加 `remote.secondSight`（面板的读写通道）；浏览器半边（`client.js`）在模型选择器右侧加一枚副眼按钮：**睁眼=开着、闭眼（带斜杠）=关着**，不画边框；桌面端带「副眼」二字，窄屏（<641px）只留图标。面板里现选副模型与思考强度（档位来自 `resolveModelInfo`，选中后直接列在模型名下方），并把模型列表收敛成「每个 provider 一行」（未开副眼时隐藏所有 `+ 副眼` 组；开着时只留当前那条 `<provider> + 副眼`，其余 provider 显示原始项）。0.5.1 起双胞胎目录**照抄基座**（含多模态模型），在 `+ 副眼` 里选到多模态模型会立刻自动关副眼、切回基座原生路径；双胞胎的显示名也用基座显示名（`天翼云CodingPlan (19276) + 副眼`）。副模型**没有全局默认值**：不选就没有副眼，`ask_image` 会提示去面板里选。**主模型换成多模态模型时，副眼自动关掉**（Host 在 `stateFor` 里发现 `textOnly === false` 就删掉该会话的覆盖；客户端同时把按钮隐藏，并且不切换用户刚选的模型）。四套测试全绿：`test/smoke.mjs` 50 组（契约精确的假宿主）、`test/client.mjs` 23 组（最小 React 挂载点击）、`test/gateway-mount.mjs` 8 组（真实 Typert 网关校验）、`test/host-integration.mjs` 8 组（真实 `LlmRuntime` / `ToolsService`），共 89 组。下一步是第 8.1 节的手工验收。

> **0.4.1 修的 boot 竞速（别再踩）**：官方 `credentials` 服务在插件 `apply` **之后**才挂上（`dsh-credentials-local` 的 `async *[Service.init]` → `loadInitial()`），而 `PiAiAdapter.listModels` 对 `MISSING_CREDENTIAL` 是**静默 `return []`**（`dsh-llm-pi-ai/lib/index.js:1932-1934`）。0.4.0 起双胞胎注册要看目录（只给纯文本模型挂），于是启动时全部 provider 都被判成「没有纯文本模型」→ 零双胞胎 → 面板的副眼按钮永不出现；pi-ai 又不发 `llm/models-updated`，之后再没事件补注册。0.4.1 用 `retryDelays`（默认 2s/5s/10s/20s/40s）退避重试 reconcile，条件只有 `unresolved > 0 && (threw || ctx.get('credentials') === undefined)`——credentials 已在而目录为空是合法终态（全多模态 provider），不重试。

---

## 1. 问题与边界

### 1.1 需求原话

> 「用纯文本模型时能额外选一个多模态副模型，遇到图片自动识图，不受『纯文本模型无法发送图片消息』限制。」

补充确认过的两个点：

- 不需要 `dsh-vision-router` 那套免费视觉链、OCR、裁剪、取色、SVG 描摹等重工具；
- 希望「PROMPT 能由主模型生成」，进而「主模型会问辅助看图模型多步不同的问题」。

### 1.2 宿主的「三道闸」

所有闸门都基于**同一条信息**——模型声明的输入模态。理解这一点，整个方案就成立了。

| # | 闸门 | 位置 | 行为 |
|---|---|---|---|
| 1 | 准入闸（服务端） | `dsh-api-session-controller/lib/index.js:844-849` | `agent.model.current()` → `resolveModelInfo()`；模型未声明 `image` 时抛 `session/attachment-invalid` / `MODEL_DOES_NOT_SUPPORT_IMAGES`。**这一步发生在 `agent/request` 瀑布之前**，所以在请求阶段改 provider 救不回来。 |
| 2 | 投影闸（请求组装） | `dsh-llm/lib/index.js:2342`、`dsh-llm/lib/types/index.js:888-891` | 模型声明了模态且不含 `image` 时，调用 `projectImagesForTextModel()`（`dsh-llm/lib/types/content.js:240`），把每个图片块替换为 `textOnlyImageText()` 的文本（`content.js:47`），形如 `[image omitted because this model accepts text only; attachment sha256:xxxxxxxx]`——**不含路径**，后续任何工具都无法据此找回图。 |
| 3 | 工具闸 | `dsh-tool-fs/lib/index.js:1685` | `read_image` 工具要求当前模型声明 `image`，否则直接报错「switch to an image-capable model」。 |

**结论**：与其在每一道闸上打补丁，不如让「用户选中的模型」本身就声明能收图——这正是双胞胎路由做的事。

### 1.3 不做的事（明确排除）

- 不做 OCR/取色/裁剪/抠图/SVG 描摹等像素级工具；
- 不做截图、不做免费的视觉链/反代，副模型就是用户已配好的多模态 provider；
- 不改 DSH 核心代码，不 patch 已安装的 `@deepseek-ai/*`；
- 不绕过闸门 1 的语义：**在真·纯文本模型下粘贴图片仍然被拒绝**。用户想看图，就得主动选双胞胎模型——这是刻意的显式选择，不是偷偷改路。

### 1.4 与既有插件的关系

| 插件 | 形态 | 与本方案的关系 |
|---|---|---|
| `@iroam2375/dsh-autovision` | 双胞胎 + `agent/request` 重定向 + 客户端补丁 + 自动全量转写 | 思路同源。它依赖 `@deprecated` 瀑布、且新会话第一条带图消息会被静默跳过；本方案去掉重定向、改为工具化。 |
| `dsh-tool-see-image` | 只提供 `see_image(path)` 工具 | 互补：它解决「磁盘上的文件」，本方案解决「会话里贴进来的图」。工具名刻意错开（`ask_image`）。 |
| `dsh-tool-fs` 的 `read_image` | 内置工具 | 选中双胞胎后它自动可用（闸 3 放行）；它产生的图片会变成句柄，同样可以 `ask_image`。 |

---

## 2. 名词表

| 词 | 含义 |
|---|---|
| 双胞胎路由 / twin | `<provider>-second-sight`，一个由本插件注册的 provider，模型表与 `<provider>` 相同，唯独声明能收图。 |
| 副模型 / vision model | 每个会话在模型面板里现选（`remote.secondSight.set`），**没有全局默认**；没选就没有副眼。 |
| 主模型 | 用户真正在对话的纯文本模型（经双胞胎路由转发）。 |
| 投影 / projection | 把 durable 消息转换成「发往某个 provider 的请求消息」的过程。本插件在适配器层做最后一次改写。 |
| 句柄 / handle | `img-<8hex>`，由 `attachmentId` 内容寻址派生的稳定短 id，主模型用它指名一张图。 |
| 定位子 / locator | 宿主内部概念：`attachment sha256:<前8位>` 只是占位符文本，不是句柄；不要混用。 |

---

## 3. 总体架构

```
┌─────────────────────────────── DSH web ───────────────────────────────┐
│                                                                       │
│  模型选择器                                                            │
│    ├─ opencode-go / deepseek-v4.1-flash          ← 原生纯文本          │
│    └─ opencode-go-second-sight / deepseek-v4.1-flash                    │
│         （providerInfo.name 显示为「opencode-go + 副眼」）              │
│                              │                                        │
│  会话贴图 ──► 准入闸(1) ──► 会话消息（image 块，durable）               │
│                              │                                        │
│                    agent loop 组装请求                                 │
│                              │                                        │
│                    llm.stream(provider=…-second-sight)                 │
│                              │                                        │
│                  ┌───────────▼────────────┐                           │
│                  │ SecondSightAdapter      │                           │
│                  │  rewrite(): 图→句柄提示 │                           │
│                  │  forward → ctx.llm.stream│                          │
│                  └───────────┬────────────┘                           │
│                              │                                        │
│             llm.stream(provider=opencode-go, messages=改写后)          │
│                              │                                        │
│                    主模型回答（只看到文字）                            │
│                              │                                        │
│              需要细节 → 工具调用 ask_image(handle, question)           │
│                              │                                        │
│                  ┌───────────▼────────────┐                           │
│                  │ ask_image → 副模型      │                           │
│                  │ （图 + 问题，带历史问答）│                          │
│                  └───────────┬────────────┘                           │
│                              │  文本答案                               │
│                    工具结果进入会话，主模型继续作答                     │
└───────────────────────────────────────────────────────────────────────┘
```

### 四条运行时路径

| 路径 | 触发 | 行为 | 额外开销 |
|---|---|---|---|
| P1 纯文字 | 请求中没有 image 块 | 只做一次 provider 替换就转发 | ≈0 |
| P2 贴图 | 请求中有 image 块 | 图片块→句柄提示；转发 | ≈0（不调用副模型） |
| P3 追问 | 主模型调 `ask_image` | 一次副模型调用；结果进工具结果 | 1 次副模型调用（2–5s） |
| P4 多图对比 | `ask_image` 传多个句柄 | 一次调用带多张图 | 1 次调用，图 token 变多 |

---

## 4. 运行时行为规格

### 4.1 贴图请求（P2）

投影后，每个图片块变成**恰好一个** text 块：

```
[图片 img-3f2a8c1e 已附上。你无法直接看到它；需要内容时调用
 ask_image(image="img-3f2a8c1e", question="具体问题")，同一张图可多次追问。]
```

- 句柄按 `attachmentId` 派生：`sha256:<64hex>` → `img-<前8位>`；同一张图在同一会话/跨会话稳定。
- 被 `offloaded: true` 标记的图片块同样转成句柄（附件对象仍在存储里，`ask_image` 通常仍可读；见 11.3 待实测）。
- 保留消息的其余字段（`role`/`id`/`source`/`toolCallId`），只换 `content`。

### 4.2 不带图的请求（P1）

`rewrite()` 逐条判断 `content.some(b => b.type === 'image')`，没有就直接引用原消息对象（不做无谓复制）。转发时**剥掉所有符号键**（`Object.entries` 只取字符串键），避免把 `dsh-agent-loop` 的 `WeakSet` 请求标记带进内层调用。

### 4.3 工具追问（P3）

`ask_image` 的契约：

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `image` | string | 是 | 句柄；逗号/空格/中文逗号分隔可传多张 |
| `question` | string | 是 | 一个具体问题 |
| `detail` | `gist` \| `full` | 否 | 默认 `full`；`gist` 限两句话，省 token |

返回 `{ text: string }`，渲染为一段文本。错误以抛错形式交给宿主，工具结果标记 `isError`。

### 4.4 缓存与预算

| 机制 | 键 | 行为 |
|---|---|---|
| 答案缓存 | `排序后的句柄 + detail + question` | 命中直接返回，**0 次调用**；容量 256，LRU 淘汰 |
| 问答历史 | 单句柄 | 最近 `historyTurns`（默认 6）条，拼进副模型 prompt，用于**前缀缓存热身** |
| 次数上限 | 单句柄 | 超过 `maxPerImage`（默认 12）返回提示文本而不是报错，逼模型基于已有答案收尾 |
| 句柄表 | 句柄 | 最多 512 条，按插入顺序淘汰 |

### 4.5 失败与取消

- 副模型返回 error finish → 抛出带 `failure.message/code` 的 Error；
- 副模型只返回空文本 → 抛「没有返回任何文字」；
- 取消（`signal` aborted）→ 抛 `signal.reason`；
- 句柄解析不到 → **不抛错**，返回一句可读说明（模型能自己改口，用户也看得懂）。

### 4.6 会话持久性

工具结果、用户消息、原图全部照常落 durable 消息。重启后 `refs` Map 为空，但下一次请求会重新投影历史里的图片并重建句柄表——**无需持久化**。

---

## 5. 宿主契约（必须遵守）

> 这些签名都在 `dsh-llm` 的类型声明里；参考实现是零依赖的，靠鸭子类型满足契约。升级 DSH 时逐条复验。

### 5.1 适配器（`registerAdapter`）

```ts
// dsh-llm/lib/types/index.d.ts:262
registerAdapter(providers: string[], adapter: LlmAdapter): AdapterRegistrationHandle
// 重复 provider → LlmError DUPLICATE_ADAPTER（全有或全无）
// handle 是 disposer，另有 handle.replace(providers)
```

适配器需要实现（基类 `dsh-llm/lib/index.js:1670`，只有 `stream` 是抽象成员，其余是默认实现）：

| 成员 | 签名 | 本实现 |
|---|---|---|
| `providerInfo` | `(provider) => { id, name }` | `id` 必须等于注册 id；`name` 给 UI 看 |
| `providerRetryPolicy` | `(provider) => ResolvedRetryPolicy \| undefined` | 返回 `undefined`，用宿主默认 |
| `imageRequestPricing` | `(provider, model) => pricing \| undefined` | 返回 `undefined` |
| `imageRequestTarget` | `(provider, model, image) => { width, height, maxBytes }` | 原样透传（与基类默认一致） |
| `listModels` | `(provider) => Promise<LlmModelInfo[]>` | 复制 `base` 的模型表，改写 `inputModalities` |
| `resolveModel` | `(provider, model, signal) => Promise<LlmResolvedModelInfo>` | 复制 `base` 的解析结果，改 `provider` 与模态 |
| `prepareCall` | `(provider, model, signal) => Promise<{ model, stream }>` | 见下 |
| `stream` | `(options: GenerateOptions) => AsyncIterable<StreamChunk>` | 改写消息 → 转交 `ctx.llm.stream` → 逐块转发 |

### 5.2 运行时方法

| 方法 | 用途 | 备注 |
|---|---|---|
| `ctx.llm.listProviders()` | 枚举已注册 provider | `llm/adapters-updated` 事件后需重新调用 |
| `ctx.llm.listModels(provider)` | 列模型 | 可能走网络，UI 会调 |
| `ctx.llm.resolveModelInfo(provider, model, signal)` | 解析元数据 | 准入闸、压缩、UI 都依赖它 |
| `ctx.llm.stream(options)` | 发起一次流式调用 | 在内层调用时不带 agent-loop 标记 |
| `ctx.tools.register(definition)` | 注册工具 | **必须**有 `output.render`（`dsh-tools/lib/index.js:433` 起校验） |
| `ctx.on('llm/adapters-updated', fn)` | provider 增删通知 | 无 payload |
| `ctx.effect(function*(){ yield disposer })` | 生命周期清理 | fiber 销毁时撤路由与工具 |

### 5.3 消息与流

```ts
GenerateOptions { provider, model, messages: RequestMessage[], system?, tools?, temperature?, maxTokens?, stop?, signal?, sessionId?, purpose? }
RequestMessage  = Message | { role: 'user', content }
StreamChunk     = block-start | text-delta{index,text} | reasoning-delta | tool-call-delta
                | block-end | usage | finish{reason:{kind:'stop'|'tool-calls'|'max-tokens'|'aborted'|'error'}, replayState?}
ImageBlock      = { type: 'image', attachment: ImageAttachmentRef, offloaded?: true }
```

- `finish.replayState` 是**产生它的适配器**的私有数据；跨适配器转发时必须剥掉（参考实现里做了）。
- 内层调用不要复制 `options` 的符号键，否则可能被误认为 agent loop 请求。

---

## 6. 实现规格

### 6.1 文件结构

```
dsh-second-sight/
├── package.json          # type: module，dsh.bundle.patch 指向 cordis.patch.yml
├── cordis.patch.yml      # insert 一条 second-sight 节点 + 默认 config
├── index.js              # 全部逻辑（0.2.0，零依赖）
├── HANDOFF.md            # 本文档
├── README.md             # 给使用者看的说明
├── scripts/
│   ├── install-profile.ps1  # 测试 → 打包 → 装进 profile → 自检
│   └── verify-install.mjs   # 从 profile 里解析装好的那份，挂真实宿主自检
└── test/
    ├── smoke.mjs            # 假宿主单测（32 组断言）
    └── host-integration.mjs # 真实 LlmRuntime/ToolsService 契约测试（8 组）
```

无构建、无 TypeScript、无 npm 依赖。`index.js` 的导出面：`name`、`version`、`inject`、`apply`（与宿主其它插件一致，见 `dsh-llm-pi-ai/lib/index.js` 文件尾部 `export { Config, apply, inject, name }`），外加两个给测试用的纯函数 `resolveConfig`、`handleOf`。

### 6.2 状态

```js
state = {
  refs:    Map<handle, ImageAttachmentRef>,  // 句柄 → 附件，投影时填充，上限 512
  answers: Map<key, Promise<string>>,        // 答案缓存，上限 256
  history: Map<handle, {question, answer}[]>,// 单图最近 6 条，用于前缀热身
  calls:   Map<handle, number>,              // 已发起的不同问题数（预算）
}
```

全部实例内内存，**不落盘**；进程重启后由下一次请求的历史投影自动重建 `refs`。

### 6.3 句柄规则

```js
handleOf(ref) = ref.attachmentId.startsWith('sha256:')
  ? 'img-' + attachmentId.slice(7, 15)
  : ''
```

- 8 位 hex = 32 bit，512 张图内碰撞概率可忽略；若担心可加到 12 位。
- 句柄**必须**来自内容寻址 id 而不是消息 id：同一张图在不同消息里应指向同一个句柄。

### 6.4 投影规则

对每条消息：

1. 没有 image 块 → 原样引用，不复制；
2. 有 image 块 → 逐块映射：image → `{type:'text', text: HANDLE_LINE}`；其余块原样；
3. `offloaded:true` 的块同样映射（但保留"可能读不到"的说明，见 11.3）。

`HANDLE_LINE` 的文案要求：**说明模型看不见 + 给出句柄 + 给出调用方式 + 说明可多次追问**。这四点是"模型会不会主动调工具"的关键，改动时要重新验收。

### 6.5 `ask_image` 实现要点

1. 解析句柄 → 附件引用；任一解析失败即返回说明文本（不抛错）。
2. 先查缓存（键排序句柄），命中直接返回。
3. 检查预算，超限返回提示。
4. 组装消息：`[image, ...] + text(prompt)`，**图片在前**；`prompt = 指令 + 历史问答 + Question:`。
5. 通过 `ctx.llm.stream` 调副模型，只收集 `text-delta`；`finish.error` 转抛。
6. 成功后写 `history`/`calls`；失败时把缓存里那条 rejected promise 删掉，允许重试。

### 6.6 注册与 reconcile

职责：把「当前所有 provider」同步成「每条 provider 一个双胞胎路由」。

```
reconcile():
  present = listProviders()
  撤销：routes 里 base 已不存在、或不再 allowed
  新增：present 中 allowed 且未注册、且 twin id 未被占用
  保护：reconciling 标志防止 registerAdapter 自己触发的 adapters-updated 造成递归
```

触发点：`apply` 时一次、`llm/adapters-updated` 时一次。`ctx.effect` 负责 fiber 销毁时撤干净（否则热重载会残留旧路由）。

### 6.7 配置 schema

```yaml
config:
  maxTokens: 2048                     # 可选：副模型一次回答的上限
  providers: [opencode-go, ctyun-codingplan]  # 省略 = 全部
  providerSuffix: -second-sight       # 可选，默认 -second-sight
  questions:
    maxPerImage: 12                   # 可选
    historyTurns: 6                   # 可选
```

**副模型没有全局默认值**（0.3.2 起）：`vision.provider` / `vision.model` 已从配置里移除，
副眼由每个会话在模型面板里现选，没选就没有。`resolveConfig` 只校验 `providerSuffix`
（不得含空白）；`maxTokens` 夹成正整数（兜底 2048）。

---

## 7. 安装与加载

> **实测结论（2026-11-21）**：本机 pnpm 建不了任何符号链接——`dsh plugin add <目录>` 得到
> `ERR_PNPM_PACKAGE_MANAGER_SYMLINK_FAILED`，`mklink /J` 与 `fs.symlinkSync(..., 'junction')`
> 都报 `Access is denied` / `EPERM`（进程缺 `SeCreateSymbolicLinkPrivilege`）。profile 用的是
> `nodeLinker: hoisted`（真目录），所以**走 tarball**：pnpm 把 tgz 解成
> `node_modules/dsh-second-sight/` 真目录，不需要任何链接权限。下面 7.1/7.2 的 `link:` 路线
> 在本机不可用，保留作参考。

### 7.1 放置

源码仓库就在工作区 `C:\data\projects\dsh-second-sight`（本目录）。不需要复制进 profile——
`npm pack` 会把 `files` 列出的文件打进 tarball，pnpm 再解到 profile 的 `node_modules`：

```powershell
cd C:\data\projects\dsh-second-sight
npm pack --pack-destination dist
dsh plugin --profile web add .\dist\dsh-second-sight-0.2.0.tgz
```

等价的一键脚本（跑测试 → 打包 → 安装 → 自检）：

```powershell
pwsh -NoProfile -File scripts\install-profile.ps1
```

> 开发时改的是工作区，profile 里是 **tarball 快照**；改完必须重新打包安装并重启宿主才生效。

### 7.2 链接到 profile（本机不可用）

```powershell
cd $root
dsh plugin add ./plugins/dsh-second-sight
```

`dsh plugin` 等价于把参数转发给 pnpm（见 `dsh plugin --help`），**若**能建符号链接，`package.json`
里会得到一条 `"dsh-second-sight": "link:plugins/dsh-second-sight"`。本机在此步失败，见上文。

### 7.3 让宿主加载它

编辑 `$root\package.json` 的 `dsh.profile.bundles`，追加一行：

```json
"dsh-second-sight"
```

`dsh plugin add` 装 dsh 插件时会**自动追加**到数组末尾（pnpm 读到了 `dsh.bundle.patch`）。
装好后复核一次：

```powershell
dsh --profile web --dump-config | Select-String -Pattern 'second-sight' -Context 0,8
```

`--dump-config` 只做 patch 合成、**不挂载**（所以它证明配置进了 composition，不证明 `apply` 跑过）；
`apply` 是否成立由 `scripts/verify-install.mjs` 负责。

### 7.4 重启与验证

```powershell
# 按本机既有方式重启 dsh web（Startup\dsh-web-lan.vbs 或 watcher 脚本）
node scripts\verify-install.mjs   # 装完就能跑，不需要先重启
```

验收顺序：

1. 日志出现 `dsh-second-sight: N 条双胞胎路由（-second-sight）+ ask_image → provider/model`；
2. 设置 → 模型里出现「xxx + 副眼」行（无地址、无密钥，正常）；
3. 新会话选双胞胎模型，粘贴一张截图，问「图里写了什么」；
4. 期望：回复里能看到 `ask_image` 工具调用，以及对图内容的准确回答；
5. 追问一个细节问题，期望第二次 `ask_image` 且答案正确；
6. 同一问题再问一次，期望 0 延迟（缓存命中）。

### 7.5 回滚

```powershell
cd "$env:USERPROFILE\.dsh\profiles\web"
dsh plugin remove dsh-second-sight
# 再从 package.json 的 bundles 中删掉 "dsh-second-sight"
# 若在 cordis.patch.yml 里加过覆盖块，一并删除
```

回滚后会话历史不受影响：原图一直在 durable 消息里，切回原生多模态模型即可直接看。

---

## 8. 验收测试

### 8.1 手工用例

| # | 场景 | 期望 |
|---|---|---|
| T1 | 纯文本请求（无双胞胎） | 行为零变化，日志无 `ask_image` |
| T2 | 选双胞胎，发纯文字 | 正常回答，无额外调用 |
| T3 | 选双胞胎，贴一张含文字的截图 | 出现 `ask_image`，文字被逐字读出 |
| T4 | 追问同一张图的细节 | 第二次调用，答案正确 |
| T5 | 同一问题重复 | 缓存命中，几乎无延迟 |
| T6 | 一次传两个句柄 | 单次调用带两张图，答案做对比 |
| T7 | 连续问 13 个不同问题 | 第 13 次返回"已达上限"提示而不是报错 |
| T8 | 副模型 key 失效 | 工具结果 isError，主模型能向用户说明 |
| T9 | 切回原生模型 | 图片正常显示，模型直接看图 |
| T10 | 重启 dsh web 后继续旧会话 | 句柄自动重建，`ask_image` 正常 |
| T11 | 在真·纯文本模型会话里贴图 | 仍被拒绝（闸 1 未被绕过） |
| T12 | 改 patch 增删 provider 后热更新 | 双胞胎路由自动增删（`llm/adapters-updated`） |

### 8.2 自动化

`npm test` 跑两套，都零依赖（`host-integration.mjs` 只在找不到 DSH 安装时跳过）：

**`test/smoke.mjs`（32 组，假宿主）**——假宿主刻意复刻了 `registerAdapter` / `listModels` / `tools.register` 三处校验，参考实现漏改 `provider` 的 bug 在这里会直接炸：

1. 配置：缺 `vision.*` 抛错、`providerSuffix` 冲突、数值夹取与兜底；
2. 双胞胎注册：每条 provider 一个、白名单/排除、已存在的同名路由让位、`llm/adapters-updated` 后自动补齐；
3. 元数据：`providerInfo` 满足 `id === provider`、`listModels` 回写 provider 并补 image、`resolveModel` 保留 id/name/context、基座路由缺失时回退；
4. 投影：image → 句柄文本（12 hex）、不外泄 `sha256:`/`attachmentId`、无图消息按引用透传、同图同句柄；
5. 转发：provider 换成 base、`finish.replayState` 剥离、符号键不外传；
6. 工具：`when` 只放行双胞胎（`visibility: always` 时不装）、图在前问在后、缓存命中、历史问答、gist 指令、多图一次问、未知句柄、空问题、预算上限、失败不进缓存、空回答报错、`presentCall`；
7. 生命周期：`ctx.effect` 一次性撤掉路由/工具/监听器，debug 日志；
8. 句柄：稳定性、长度、缺 id。

**`test/host-integration.mjs`（8 组，真实宿主）**——import 本机 `@deepseek-ai/*` 内部包，`new Context()` + `ctx.plugin(LlmRuntime)` + `ctx.plugin(ToolsService)` + `ctx.plugin(本插件)`，让真实实现去校验：

1. `registerAdapter` 接受双胞胎；2. 真实 `listModels` 通过 `INVALID_CATALOG`；3. 真实 `resolveModelInfo` 通过 `normalizeModelInfo`；4. 真实 `stream` 的投影/转发/`replayState`；5. 真实 `tools.resolve` 的可见性门控；6. 真实定义 + `execute` 全链路；7. 定义满足 schema/render 校验；8. 撤销 fiber 后路由与工具一起消失。

覆盖安装路径：`DSH_SECOND_SIGHT_DSH=<...>/@deepseek-ai node test/host-integration.mjs`。

落地新用例时按同样形态加：构造 `messages` → 直接调 `adapter.stream()` / `tool.execute()` → 断言 `seen.streams` 数组。

---

## 9. 成本与性能

| 项 | 估算 | 备注 |
|---|---|---|
| P1/P2 额外延迟 | ≈0 | 只多一层函数调用与消息数组映射 |
| 单次 `ask_image` | 2–5 s | 取决于副模型；`glm-5.3-flash` 偏慢，`sensenova-6.8-flash-lite` 较快 |
| 单次图片 token | 由副模型计 | 每问一次都要重传图片 |
| 重复提问 | 0 | 命中 `answers` |
| 历史问答 | `historyTurns × (问题+答案)` | 拼进 prompt，换前缀命中 |
| 主请求 token | 每张图 1 行句柄文本 | 比全量转写省得多 |

**待验证（11.2）**：供应商是否对「图片 + 相同前缀」做缓存；不同家的行为差异较大，直接影响第 2 次之后的图片 token 成本。

---

## 10. 设计决策记录（ADR）

**ADR-1 用双胞胎路由，不用 `agent/request` 重定向。**
`agent/request`（`dsh-agent/lib/types/runtime-types.d.ts:362`，已标 `@deprecated`）在准入闸之后才执行，而准入闸读的是 `agent.model.current()`（`dsh-api-session-controller/lib/index.js:844-849`），此时图片已被拒绝。重定向救不了准入，只会在"模型先被选中"这个前提上多一层 deprecated 依赖。→ 选择让双胞胎模型直接出现在选择器里。

**ADR-2 工具化追问，而不是请求内自动转写。**
自动转写（每轮把可见图全部翻一遍）实现最简单，但（a）prompt 是固定的通用指令，问不到重点；（b）每轮都付一次副模型调用；（c）无法回答"用户真正关心的那一点"。工具化把出题权交给主模型，且天然支持多步。代价是依赖模型主动调用（见风险 R1）。

**ADR-3 零依赖、鸭子类型。**
profile 的 `node_modules` 里**没有** `@deepseek-ai/*`（实测 `import('@deepseek-ai/dsh-llm')` 报 `ERR_MODULE_NOT_FOUND`）。因此不能 `import { LlmAdapter }`，也不能 import `schemastery` 写 `Config`。→ 手写 8 个适配器方法与工具定义对象；好处是包体极小、安装无网络依赖。

**ADR-4 副模型消息里图片在前、问题在后。**
同图多问时，前缀（图片）保持不变，问题在尾部变化，最大化供应商侧前缀缓存的机会。

**ADR-5 句柄由 `attachmentId` 派生。**
不用自增编号、不用消息 id：内容寻址天然跨消息/跨轮次/跨重启稳定，重建不需要持久化。

**ADR-6 转发时剥掉 `finish.replayState` 与符号键。**
`replayState` 属于产生它的适配器，跨适配器转发会导致回放错配；符号键里可能有 agent-loop 的 WeakSet 标记，带进内层会改变内层调用的语义。

**被否决的备选**

| 备选 | 否决理由 |
|---|---|
| B1：请求内让主模型先出题 | 主模型没见过图，只能盲问；延迟叠加、每图两次调用、缓存命中率差 |
| `agent/request` 自动升级模型 | 准入闸在其之前，救不回来（ADR-1） |
| 直接 patch 核心 `projectImagesForTextModel` | 侵入内核，升级即碎 |
| 只装 `see_image(path)` 工具 | 粘贴的图没有路径，占位符里只有 8 位 sha256 |

---

## 11. 未决问题

1. ~~**工具可见性范围**~~ **已解决**：`ctx.tools.register(def, { when })` 的第二参数实测可用，`when({ modelSelection })` 返回 false 时工具从声明与 dispatch 中移除（`dsh-agent-loop/lib/index.js:673`）。0.2.0 用它把 `ask_image` 限制在双胞胎路由下（`tool.visibility: twin`，可改 `always`）。
2. **token 计量归属**。双胞胎路由下主请求的 usage 来自 base provider；副模型调用是另一条独立流。是否会被会话成本重复计算，需要在 `dsh-llm` 的 meter 路径上实测。
3. **offload 后的可读性**。`offloaded: true` 的 image 块仍带 attachment 引用，但内容是否还能被副模型读取（取决于附件存储与 offload 语义）尚未实测。若不可读，句柄文案要改。0.2.0 仍按「attachment 引用照抄给副模型」处理，未做特殊分支。
4. ~~**句柄长度**~~ **已定**：默认 12 hex（48 bit），配置项 `handles.length`，夹在 8–32。
5. **模型不调工具**。句柄文案是第一道保险；若实测某些小模型仍直接说"我看不到图"，再考虑加 `gist` 预热（B3），代价是每张新图固定一次小调用。
6. **UI 认知差**。界面显示原图，模型只看到句柄；用户可能不理解模型为什么"要问"。可考虑在句柄文案里加一句面向用户的说明，或后续做客户端提示（需要 client.js，暂不做）。
7. **设置页多出无地址 provider 行**。与 autovision 同款现象，暂无解；若宿主提供"隐藏 provider"的 API 再处理。
8. **预算的会话隔离**（0.2.0 新增）。`calls` 计数挂在插件实例上，跨会话共享：同一张图在 A 会话问满 12 次，B 会话也会被挡。要按会话隔离得从 `exec.agent` 取 session id，目前刻意不做（句柄本来就是内容寻址、跨会话同一张图）。

---

## 12. 风险登记

| ID | 风险 | 影响 | 缓解 |
|---|---|---|---|
| R1 | 主模型不调用 `ask_image` | 功能形同虚设 | 句柄文案足够硬；可选 `gist` 预热；验收 T3/T4 覆盖 |
| R2 | 宿主升级改动适配器契约 | 插件加载失败 | 契约集中在第 5 节，升级后按清单复验；加载失败日志明确 |
| R3 | 副模型成本失控（反复问） | 费用 | `maxPerImage`、缓存、`gist` 档位 |
| R4 | 图片重传导致 token 变多 | 费用 | 前缀缓存 + `historyTurns` + `gist` |
| R5 | 双胞胎 provider 与别的插件重名 | 注册失败 | 已检查 `present.has(twin)` 让位 + 可配 `providerSuffix` |
| R6 | 热重载残留旧路由 | 选中旧配置 | `ctx.effect` 清理 + `reconcile` 兜底 |

---

## 13. 里程碑

| 阶段 | 内容 | 完成判据 |
|---|---|---|
| M1 骨架 | 包结构、双胞胎路由、选择器可见 | 设置页出现「+ 副眼」，能选中 |
| M2 投影 | 图→句柄、转发正确 | T2、T9 通过，纯文字请求零行为变化 |
| M3 工具 | `ask_image` 全链路 | T3、T4、T5 通过 |
| M4 预算与缓存 | 上限、LRU、历史问答 | T6、T7 通过 |
| M5 验收与打包 | 手工用例全绿、假 ctx 测试、README | T1–T12 通过 |

开发顺序建议：先把 M1/M2 跑通（能选中、能转发），再写工具——因为前两步不依赖副模型，调试成本低。

---

## 14. 参考实现

0.1.0 的 344 行参考实现已被 0.2.0 取代（`git`/备份里可查）。它当时的待改点与本轮的处置：

| 待改点 | 0.2.0 的处置 |
|---|---|
| 句柄长度 8 hex | 默认 12 hex，可配 `handles.length`（夹 8–32） |
| offload 处理 | 未做特殊分支：attachment 引用原样交给副模型（第 11.3 条仍待实测） |
| `execute` 只读 `exec.signal`，预算未按会话隔离 | 预算按句柄计数、跨会话共享；信号照旧透传（见第 11.8 条） |
| 只有 apply 一条日志 | 每次 `ask_image` 打 debug（`tool.log: true` 时输出 info），含句柄、档位、问题长度、答案长度、耗时、是否命中缓存 |
| **`listModels` 没回写 `provider`** | **必修 bug**：`LlmRuntime.listModels` 会校验 `model.provider === provider`，不回写直接 `INVALID_CATALOG`。已修，并由两套测试各断一次 |
| 副模型自身不挂双胞胎 | 改成照挂：双胞胎 → 基座是真实 provider，不构成递归；副模型也可能被用户选成主模型 |

---

## 15. 附录

### A. 已核对源码位置（DSH 0.2.2-rc.1）

| 位置 | 内容 |
|---|---|
| `dsh-llm/lib/index.js:1670` | `LlmAdapter` 基类与默认实现 |
| `dsh-llm/lib/index.js:1842` | `registerAdapter()`，含 DUPLICATE_ADAPTER 与 handle.replace |
| `dsh-llm/lib/index.js:2063` | `imageRequestTarget()` 运行时转发 |
| `dsh-llm/lib/index.js:2342` | 请求组装：按 `inputModalities` 决定是否投影图片 |
| `dsh-llm/lib/types/index.js:888-891` | 同上（`LlmRuntime.stream` 的投影分支） |
| `dsh-llm/lib/types/content.js:47` | `textOnlyImageText()`：占位符文本（8 位 sha256，无路径） |
| `dsh-llm/lib/types/content.js:240` | `projectImagesForTextModel()` |
| `dsh-api-session-controller/lib/index.js:844-849` | 准入闸：`MODEL_DOES_NOT_SUPPORT_IMAGES` |
| `dsh-tool-fs/lib/index.js:1685` | `read_image` 的模态检查 |
| `dsh-tools/lib/index.js:433` | `tools.register()`：强制要求 `output.render` |
| `dsh-llm-pi-ai/lib/index.js:1941` | `inputModalities` 如何从配置映射到模型信息 |
| `dsh-llm-pi-ai/lib/index.js`（文件尾） | 插件导出形态 `export { Config, apply, inject, name }` |
| `dsh-agent/lib/types/runtime-types.d.ts:362` | `agent/request` 瀑布（`@deprecated`） |
| `dsh-compaction-basic/lib/index.js:856` | 官方 `agent/request` 监听写法（参考，不采用） |

> 所有路径前缀：`C:\Users\win10\AppData\Local\Author Software\nvm\installs\v26.10.0\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\`

### B. 机制速查

**占位符（纯文本模型收到的原文）**
```
[image omitted because this model accepts text only; attachment sha256:xxxxxxxx]
```

**请求标记**：`markAgentLoopRequest()` 把请求对象放进模块内 `WeakSet`；因此 `{...options}` 得到的新对象**不再**被识别为 agent loop 请求。

**附件**：内容寻址存在 `~/.dsh/attachments/v1/objects/<前2位>/<sha256>`，`attachmentId` 形如 `sha256:<64hex>`。

**模型元数据继承**：`resolveModel` 返回的 `context?: {contextWindow}`、`defaultMaxTokens?`、`reasoning?` 会被压缩、UI、token 预算使用；双胞胎必须原样继承，否则最长上下文会算错。

### C. 常用命令

```powershell
# 语法检查
node --check .\index.js

# 测试（假宿主 32 组 + 真实宿主 8 组）
npm test

# 打包 + 装进 profile + 自检（本机不可用 link:，走 tarball）
pwsh -NoProfile -File .\scripts\install-profile.ps1

# 分步等价
npm pack --pack-destination dist
dsh plugin --profile web add .\dist\dsh-second-sight-0.2.0.tgz
node scripts\verify-install.mjs

# 复核 composition（不挂载，只看 patch 合成）
dsh --profile web --dump-config | Select-String -Pattern 'second-sight' -Context 0,8

# 列出已装插件（pnpm 视图）
dsh plugin ls --depth 0

# 回滚
dsh plugin remove dsh-second-sight
```

---

## 16. 实施记录（0.2.0，2026-11-21）

### 16.1 里程碑状态

| 阶段 | 状态 | 判据落地情况 |
|---|---|---|
| M1 骨架 | 完成 | 双胞胎路由注册、`providerInfo` 过 `id === provider` 校验、`llm/adapters-updated` 增量 reconcile |
| M2 投影 | 完成 | image → 句柄文本（12 hex）、无图消息零改动、转发回落 base、剥 `replayState`/符号键 |
| M3 工具 | 完成 | `ask_image` 全链路（图在前、问在后、gist/full 两档、`presentCall`/`presentResult`） |
| M4 预算与缓存 | 完成 | `maxPerImage`、答案 LRU(256)、历史问答、失败不占预算不进缓存 |
| M5 验收与打包 | 完成（自动化） | 40 组断言全绿；手工 T1–T12 待装进 profile 后由用户验收 |

### 16.2 相对第 6 节规格的偏离

1. **句柄文案是中文**，与对话语言一致；工具 `description` 用英文（模型面更稳）。文案四要素：看不到像素 / 句柄 / 调用写法 / 可多次追问 + "不要凭空猜测"。
2. **多图时不注入历史问答**：历史只对单句柄生效，否则 A 图的历史会污染 B 图的提问。
3. **`detail` 两档语义**写进 prompt 而非采样参数：`gist` = 至多两句；`full` = 穷尽、逐字引用、表格用 markdown。
4. **`ask_image` 的失败一律抛错**（含"空回答"）：工具执行器会把它标成 `isError`，主模型能向用户解释；缓存里失败 promise 会被 `catch` 清掉，可原样重试。
5. **`tool.visibility`** 新增：`twin`（默认，只在双胞胎会话暴露）/ `always`（任何会话都暴露）。
6. **`providers` / `excludeProviders`** 新增：白名单与排除，便于只给部分 provider 挂双胞胎。

### 16.3 关键实现点（维护者先看这几处）

- `allowed(id)`：`!isTwin && 白名单 && !排除`；双胞胎名被占用时让位（R5）。
- `listModels`：`{ ...model, provider, inputModalities: ['text','image', ...rest] }` —— **`provider` 必须回写**，否则真实宿主抛 `INVALID_CATALOG`。
- `resolveModel`：基座 `resolveModelInfo` 失败时回退成 `{provider, id, name:id}` 的最小元数据，保证 UI 选中不炸。
- `stream`：`Object.fromEntries(Object.entries(options))` 只复制字符串键；`provider` 改回 base；`finish.replayState` 剥掉。
- `rewriteMessages`：只改含 image 块的消息，其它消息按引用透传；同图多次出现得同一句柄。
- `runAsk`：未知句柄/空问题/超预算 → 返回**可恢复的中文说明**而非抛错（主模型能读懂并改口）；缓存键 `句柄集合|detail|问题`，命中即刷新 LRU。
- 生命周期：`ctx.effect` 一个 disposer 撤掉 `offAdapters()` + `unregisterTool()` + 全部路由 + 三张表。

### 16.4 测试与验证

```
node --check index.js            # 语法
npm test                         # 32 + 8 = 40 组断言
node scripts/verify-install.mjs  # 装进 profile 之后：从 profile 解析装好的那份再验一遍
```

`host-integration.mjs` 在找不到 DSH 安装时自动跳过；可用 `DSH_SECOND_SIGHT_DSH` 指定 `@deepseek-ai` 目录。
`verify-install.mjs` 可用 `DSH_SECOND_SIGHT_PROFILE` 指定 profile，默认 `~/.dsh/profiles/web`。

### 16.5 安装结果（2026-11-21）

- profile `web` 的 `package.json`：`"dsh-second-sight": "file:C:/data/projects/dsh-second-sight/dist/dsh-second-sight-0.2.0.tgz"`，
  `dsh.profile.bundles` 末尾自动追加了 `"dsh-second-sight"`（pnpm 读 `dsh.bundle.patch` 后自己加的）。
- `node_modules/dsh-second-sight/` 是真目录（hoisted linker），含 index.js / cordis.patch.yml / README / HANDOFF / package.json。
- `dsh --profile web --dump-config` 里能看到 `# == dsh-second-sight` 段与完整 config（`--dump-config` 不挂载，只证明 patch 合成）。
- `scripts/verify-install.mjs` 从 profile 解析到 `node_modules/dsh-second-sight/index.js`，导出、双胞胎路由、`listModels` 回写、`ask_image` 门控、撤销全部通过。
- **尚未重启宿主**（按 AGENTS.md 不代用户重启），所以运行中的 dsh web（PID 10072）还没加载它。

### 16.6 剩余工作

1. 重启宿主（`Startup\dsh-web-lan.vbs`），确认日志 `dsh-second-sight: N 条双胞胎路由…`；
2. 按 8.1 跑手工用例，重点：T3（句柄 → `ask_image` 真的被调用）、T5（缓存）、T10（重启后句柄重建）、T12（热更新增删 provider）；
3. 第 11.2 / 11.3 两条实测（成本归属、offload 可读性）；
4. 若确认可用，考虑把默认 config 里的 `tool.log` 保持关闭、按需打开排障。

---

## 17. 实施记录（0.3.0，2026-11-21）

### 17.1 需求变化

0.2.0 的用法是「在模型选择器里选 `xxx + 副眼` 那一行 provider」。用户认为这种交互不够友好，
要求：**在模型面板的「推理等级」下方直接加一个副眼选择项**——上方模型是纯文本模型时就能选
识图副模型，副模型也能设思考强度。

### 17.2 为什么没做成「弹窗里的一行」

模型面板弹窗是 `@deepseek-ai/dsh-client-ui-model-selection` 私有的 `ModelSelect` 组件，它注册
`conversation.input.model` 座位时只声明了一个 `label` 子槽（`single` / `inline` / **非交互**），
弹窗本体没有任何插槽。唯一的替代是**整席位替换**（`priority: -10` 重注册
`conversation.input.model`，`dsh-experimental-liveshare` 就这么干），那等于重写整个模型选择器。

所以落在 `conversation.input.right`——宿主源码注释原文是 "Compact action after the model
selector"。它是模型按钮在同一工具行里的紧邻兄弟，「看起来像一个按钮」而不是「面板里多一行」。

### 17.3 打开副眼 = 切双胞胎（不可省）

附件准入（闸 1）只看**当前选中模型**声明没声明 `image`。面板把副模型存到 Host 并不会让闸 1
放行，所以客户端在 `set` 成功后必须同时 `directory.select({ provider: '<base>-second-sight',
model, reasoningEffort })`。双胞胎的模型表照抄基座、名字相同，界面上的模型名不变。

### 17.4 远端通道（`remote.secondSight`）

- Host：`createRemoteClass(Base)` 返回继承 `TypertRemoteService` 的类，原型上挂
  `@deepseek-ai/dsh-typert-protocol/remote-methods` 描述符（`version: 1`，两个 direct 方法
  `state`/`set`），`new Remote(ctx, ops)` 即完成挂载；import 失败只记 debug，功能退化成
  配置默认。
- 参数**全部扁平字符串**（`sessionId, provider, model, reasoningEffort`），wire 上不传对象；
  `provider`/`model` 传空串表示「回落到配置默认」。
- 客户端 `ctx.remote.$mount(CONTRIBUTION)`（`codec: { mode: 'src-json' }`，免 zod），再用
  `ctx.get('remote.secondSight')` 拿服务；`RemoteResult` 要自己解包 `{ok, value|error}`。

### 17.5 状态与坑

- `state.sessions`（会话 → 副模型覆盖）+ `state.selections`（会话 → 最近一次主模型选择）。
  `set` 之后用 `report(id)` 按 `selections` 里的坐标回报，否则会把副模型 provider 当成主模型
  去算 `textOnly`，面板会把自己藏掉。
- 缓存键含 `<副模型 provider>/<model>`，换副模型不会命中旧答案。
- `ask_image` 的会话 id 取自 `exec.agent?.id`（`Agent.id === SessionId`）。
- 面板选完模型**不关闭**，方便紧接着调该模型的思考强度。
- `state.catalog` 30 秒缓存；只列 `inputModalities` 含 `image` 的模型。

### 17.6 验证

- 新增 `test/client.mjs`：自带最小 React（`useState`/`useEffect`/`useSyncExternalStore`/portal），
  把 `client.js` 挂载起来点击断言——11 组，覆盖可见性、面板内容、选模型→先 set 后 select、
  换 effort、关闭副眼、以及「客户端不许 require 第三方包」。
- `smoke.mjs` 40 组、`host-integration.mjs` 8 组继续保持绿色。
- 另做了一次性探测：把 `index.js` 复制到 DSH 安装目录内运行，确认真实解析域下
  `remote.secondSight` 能挂载、`remoteMethods()` 返回 `['state','set']`、`set` 后回带
  `source: 'session'` 与正确的 `reasoningEffort`。

### 17.7 0.3.0 与 0.2.0 的兼容性

双胞胎路由、`ask_image`、请求投影、预算/缓存、`tool.visibility` 全部不变；`remote.secondSight`
只是多一条可选通道。没装客户端半边（或宿主解析不到 typert 包）时，插件退化成 0.2.0 的行为。

---

## 18. 0.3.1 修复记录（2026-11-21）

### 18.1 线上表现

0.3.0 装进 profile、重启后，浏览器控制台：

```
[dsh-second-sight] 无法挂载 remote.secondSight: Error: client api: generated Remote
secondSight/state field "sessionId" has no strict codec
```

按钮因此不出现（apply 里 `$mount` 抛错 → 座位不注册）。

### 18.2 根因

`dsh-api-gateway/lib/client.browser.js` 的 `validateContribution` 在挂载贡献时，对**每个参数**
和结果调用 `requireStrictCodec`：

```js
function requireStrictCodec(codec, endpoint, field) {
  if (codec.mode !== "strict") throw new Error(`client api: generated Remote ${endpoint} field ${JSON.stringify(field)} has no strict codec`);
}
```

0.3.0 的 `client.js` 用的是 `{ mode: 'src-json' }`（当时以为免 zod 的逃生口可用——那是 **Host 端**
`srcDescriptor` 的派生路径，浏览器端的挂载校验不吃这套）。

### 18.3 修法

`strict` 只要求三样：`typeSymbol` 非空、`create()` 存在、`create()` 返回带 `.parse()` 的对象
（`dsh-typert-registry/lib/index.js:626` `validateCodec` 的检查项）。所以不需要拉 zod，
给一个只做边界检查的解析器即可：

```js
const jsonCodec = (type, typeSymbol, jsonSchema, optional = false) => ({
  mode: 'strict', typeSymbol, jsonSchema,
  create: () => ({ parse(value) { /* 类型相符就原样放行 */ } }),
})
const textCodec = (typeSymbol, optional) => jsonCodec('text', typeSymbol, { type: 'string' }, optional)
const objectCodec = (typeSymbol) => jsonCodec('object', typeSymbol, { type: 'object' })
```

- 每个参数一个唯一 `typeSymbol`（`dsh-second-sight#sessionId` 等），结果各一个。
- 可选参数（`provider`/`model`/`reasoningEffort`）的 `parse(undefined)` 返回 `undefined`，
  与 Host 侧「字段缺省 = 关闭副眼」的语义对齐。
- 语义校验仍然留在 Host 的 `ops`（空串→回落、未知句柄→提示），客户端只挡类型错。

### 18.4 回归防线

新增 `test/gateway-mount.mjs`（8 组）：拉起真实的 `@deepseek-ai/cordis` + `dsh-typert-registry`
+ `dsh-api-gateway/lib/client.node.js`，用假 `connection` 顶掉传输层，让网关自己的
`validateContribution` / `installNamespace` 把 `client.js` 的贡献真装一遍，再断言：

1. 挂载过程零警告（这正是 0.3.0 失败的地方）；
2. `ctx.get('remote.secondSight')` 有 `state`/`set`；
3. 两个端点进了 `ctx.typert.remotes.list()`；
4. 每个参数 `codec.mode === 'strict'`、`codec.typeSymbol === strictCodec.typeSymbol`；
5. `acceptsUndefined` 只在可选参数上；
6. 卸载后登记表清空。

`npm test` 现在是四套 89 组断言（50 + 23 + 8 + 8），全部离线可跑。

## 19. 实施记录（0.6.0，2026-11-23）

### 19.1 发布形态

- 仓库：`https://github.com/zp96324511/dsh-second-sight`（MIT）。
- 版本 0.6.0；`package.json` 补 `license` / `repository` / `homepage` / `bugs` /
  `publishConfig` / `keywords`，`files` 增加 `update.js`、`LICENSE`、`CHANGELOG.md`，
  exports 增加 `./update`。
- 安装有两条路：
  1. GitHub Release tarball（推荐）：`dsh plugin --profile web add https://github.com/zp96324511/dsh-second-sight/releases/download/v0.6.0/dsh-second-sight-0.6.0.tgz`；
  2. 本地 `dist/*.tgz`（开发形态，不支持在线升级）。
- `index.js` 的 `version` 改为 `update.js` 的 `LOADED_VERSION`，不再手写常量；
  `client.js` 保留 `CLIENT_VERSION` 供首帧显示，`scripts/check-manifest.mjs` 校验它与
  `package.json` 一致。

### 19.2 升级通道（`update.js`）

从 `dsh-fast-search` 的 `update.js` 适配，只改 `PACKAGE_NAME` 与默认路由前缀：
`/plugins/dsh-second-sight`（与 `dsh-active-sessions` / `dsh-context-control` 一致）。

- 每次 `GET /update` 读磁盘 `package.json` 作为 `current`，与通道 `latest` 比较；
  结果缓存 6 小时，`?force=1` 绕过。
- `resolveChannel`：GitHub Release tarball → `github`；其他 tarball → 同目录
  `channel.json`；`link:` / `file:` → `local`；git spec → `git`；registry → npm。
- GitHub 主路径：`https://github.com/<repo>/releases/latest/download/channel.json`；
  失败退回 `api.github.com/repos/<repo>/releases/latest`。
- 一键升级：`spawn(process.execPath, [launcher, 'plugin', '--profile', name, 'add', spec])`，
  cwd = profile 目录，env 带 `DSH_HOME`；stdout/stderr 进 job 日志（上限 48 KB），
  作业记录落 `~/.dsh/storages/dsh-second-sight-update.json`（24h 内可恢复）。
- 完成后读 profile `node_modules/dsh-second-sight/package.json` 实测版本；`restartRequired`
  由「磁盘版本 ≠ 运行版本」或「宿主无 HMR」决定。
- **不提供重启端点**：插件不接管宿主进程。

### 19.3 路由挂载（`index.js`）

```js
ctx.inject(['webServer'], (scoped) => {
  const webServer = scoped.get('webServer')
  const updater = createUpdater({ ctx, config: rawConfig, logger })
  const handle = createUpdateRoutes(updater)
  const dispose = webServer.register({ kind: 'prefix', path: '/plugins/dsh-second-sight', handler })
  scoped.effect(() => () => { dispose(); updater.dispose() })
})
```

- 纯 CLI 宿主没有 `webServer`，`ctx.inject` 不回调，`host.updateReady` 永远 pending；
  面板的升级行会显示 404 提示，副眼本体不受影响。
- 假宿主（`test/smoke.mjs`）没有 `ctx.inject`，所以挂载前先判
  `typeof ctx.inject === 'function'`；`host.updateReady` 立即 resolve(false)。
- 整段包在 try/catch 里：升级通道坏掉绝不能把 `apply` 拖崩（那会让整个宿主起不来）。

### 19.4 面板升级行（`client.js`）

- 位置：popover 底部，`panelFootStyle` 用 inset 阴影画分隔线（不用 `borderTop`，
  否则客户端测试会把底栏误认成 provider 分组头）。
- 版本显示：`loaded`（运行中模块）优先，其次 `current`（磁盘文件），最后
  `CLIENT_VERSION`；两者不同时显示 `旧 → 新`。
- 打开面板静默检查一次；按钮状态机：`idle → checking → current / available /
  unavailable / error → upgrading → upgraded`。
- `updateRequest` 先按 `document.baseURI` 拼 `/plugins/dsh-second-sight`，404 再退回
  根路径；成功一次后记住前缀。404 文案明确指向「宿主仍在跑旧版插件」。
- 升级后轮询 `GET /update/job`（1200 ms，上限 20 分钟），显示日志尾部 2 KB；
  `done` 显示「已升级，重启 dsh web 后生效」，不提供重启按钮。

### 19.5 发布工程

- `scripts/check-manifest.mjs`：清单/零依赖/ESM/patch/client id/CLIENT_VERSION/CHANGELOG
  一致性；`npm run check` = 自检 + 语法 + 全部测试。
- `scripts/make-channel.mjs`：从 tgz 算 sha256/size，生成 `channel.json`，同时登记
  带版本号 URL 与稳定名 URL。
- `.github/workflows/ci.yml`：push 任意分支 + PR + 手动，Node 22/24/26 跑 `npm run check`。
- `.github/workflows/publish.yml`：tag `v*` → 校验 tag == package.json → `npm run check`
  → 可选 npm publish → `npm pack` + 稳定名 → `make-channel.mjs` → `gh release upload`。
  升级通道读 `releases/latest/download/channel.json`，三个资产必须同属一个 release。
