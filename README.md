# dsh-second-sight（副眼）

给 DSH 里的**纯文本主模型**补一层看图能力：在模型面板里打开「副眼」后，图片不再被拒绝
或替换成占位符，而是变成**可引用的句柄**；主模型用 `ask_image` 工具向一个真正的多模态
副模型提问，可以一问再问。副模型和它的思考强度都在模型面板里现选，按会话记住。

零依赖、零构建：Host 半边是单个 ESM 文件，浏览器半边是单个 `__ModuleLoader__` 模块。
从 GitHub Release 安装时，面板底部还带一条在线升级通道（检查更新 / 一键升级）。

---

## 为什么需要它

DSH 有三道闸都基于同一条信息——**模型声明的输入模态**：

| # | 闸门 | 纯文本模型下的表现 |
|---|---|---|
| 1 | 准入（服务端） | 贴图直接 `MODEL_DOES_NOT_SUPPORT_IMAGES`，图根本发不出去 |
| 2 | 投影（请求组装） | 把图片换成 `[image omitted because this model accepts text only; attachment sha256:xxxxxxxx]`，**不含路径**，事后无法找回 |
| 3 | 工具（`read_image`） | 报错 "switch to an image-capable model" |

与其在三道闸上各打一次补丁，不如让「用户选中的模型」本身就声明能收图。

## 它怎么做

```
用户贴图 ──► 会话历史（原图，durable）
                │
                ▼  面板上打开「副眼」（自动切到 xhx2api-second-sight/glm-5.3）
        ┌───────────────────────────────┐
        │ 双胞胎适配器：请求投影         │
        │ image 块 → [图片 img-1a2b…]    │
        └───────────────┬───────────────┘
                        │  主模型看到"有图，句柄是 img-1a2b…"
                        ▼
              ask_image(image="img-1a2b…", question="第三行为什么报错？")
                        │
                        ▼
              副模型（真多模态，如 sensenova-6.8-flash-lite）
                        │
                        ▼
                 答案回填 → 主模型继续推理
```

1. **双胞胎路由**：为每个 provider 注册 `<provider>-second-sight`，模型表照抄，只把
   `inputModalities` 加成 `['text','image']` → 三道闸全部放行，且**不动持久会话**：
   切回真多模态模型，历史里还是原图。
2. **投影不转写**：请求发往 provider 前，`image` 块被换成一行句柄提示，只花十来个 token。
3. **工具化追问**：出题权在主模型（它看过用户原话），答案按 `(句柄, 档位, 问题)` 缓存，
   同一张图可反复追问，相同问题不再花钱。

## 安装

### 从 GitHub Release 安装（推荐，支持在线升级）

```powershell
dsh plugin --profile web add https://github.com/zp96324511/dsh-second-sight/releases/download/v0.6.0/dsh-second-sight-0.6.0.tgz
```

装完**重启 dsh web**（本机是 `Startup\dsh-web-lan.vbs`；不要用
`--from-default-profile`，那会重建 profile）。重启后模型按钮右边会出现一枚眼睛图标
（纯文本模型下才有）。点开选一个能看图的模型，这个会话就能贴图了。

这种装法的 profile 依赖是一条 GitHub Release tarball URL，面板底部的「检查更新」
会顺着它找到本仓库的 `releases/latest/download/channel.json`，因此可以在面板里一键升级。

### 从本地 tarball 安装（开发形态）

本机 pnpm 建不了符号链接（`link:` / junction 都报 `Access is denied`，进程缺
`SeCreateSymbolicLinkPrivilege`），所以开发时也走 **hoisted + tarball**：

```powershell
# 一键：跑测试 → 打包 → 装进 web profile → 自检
pwsh -NoProfile -File scripts/install-profile.ps1

# 或者分步
npm test
npm pack --pack-destination dist
dsh plugin --profile web add .\dist\dsh-second-sight-0.6.0.tgz
node scripts/verify-install.mjs
```

`file:` 安装是本地 checkout 的快照，**不提供在线升级**（面板会明确显示「本地安装，
不提供在线升级」），避免把工作区覆盖掉。改完代码必须重新 `install-profile.ps1`。

pnpm 装完会自动把 `dsh-second-sight` 追加进 profile `package.json` 的
`dsh.profile.bundles`；确认一下它在那儿再重启。

### 在线升级

副眼面板底部有一行版本信息：

```
v0.6.0   已是最新版本                    [检查更新]
v0.6.0   有新版本 v0.6.1                 [一键升级]
v0.6.0   升级中…                         [升级中…]
v0.5.3 → v0.6.0   已升级，重启 dsh web 后生效
```

- 打开面板时**静默检查一次**；宿主端缓存 6 小时，点「检查更新」会强制刷新。
- 「一键升级」跑的是和手敲一样的
  `dsh plugin --profile <profile> add <release-tarball>`，因此继承插件管理器的清单锁、
  失败回滚和兼容性检查；不会先卸载再装。
- 安装日志（尾部 2 KB）会在按钮下方展开，失败时保留诊断。
- 升级完成后插件**不会替你重启宿主**——面板只显示「重启 dsh web 后生效」。
  宿主可能由外部脚本带自定义参数、端口和环境变量拉起，重启这件事交给用户。
- 想显式指定通道（例如换了 fork），可在 profile 的 `cordis.patch.yml` 里加：

  ```yaml
  - id: second-sight
    config:
      update:
        github: owner/repo        # 默认从 package.json 的 repository 推断
        checkIntervalMs: 21600000 # 6 小时
  ```

### 装完自检

```powershell
node scripts/verify-install.mjs
```

它会从 profile 里解析装好的那份，挂到真实的 `LlmRuntime` + `ToolsService` 上，验证
双胞胎路由、`listModels` 的 provider 回写、`ask_image` 门控与撤销。

### 回滚

```powershell
cd "$env:USERPROFILE\.dsh\profiles\web"
dsh plugin remove dsh-second-sight
# 再从 package.json 的 dsh.profile.bundles 里删掉 "dsh-second-sight"，重启宿主
```

## 配置

`cordis.patch.yml` 里给默认值，profile 的 `cordis.patch.yml` 可用
`- id: second-sight` + `config:` 覆盖：

```yaml
maxTokens: 2048                     # 副模型一次回答的 token 上限
providers: []                       # 空 = 给所有 provider 挂双胞胎
excludeProviders: []                # 不想挂的 provider
providerSuffix: -second-sight       # 双胞胎路由后缀（别和现有 provider 撞）
questions:
  maxPerImage: 12                   # 单张图的提问预算
  historyTurns: 6                   # 同图追问时带几轮历史（0 = 不带）
handles:
  length: 12                        # 句柄保留的 sha256 前缀位数（8–32）
tool:
  visibility: twin                  # twin = 只在双胞胎会话暴露；always = 全都暴露
  log: false                        # true = 每次 ask_image 打 info 日志
```

**没有全局默认副模型**，也没有 `vision.provider` / `vision.model`：副眼是会话级的，
在每个会话的模型面板里现选。没选就没有副眼——不会悄悄退回到某个配置默认值。

## 面板

模型面板（弹窗）的标题和推理等级是官方组件私有渲染的，没有插槽，所以副眼开关落在
**模型选择器右边的同一行工具行**（`conversation.input.right`，宿主注释原文就是
"Compact action after the model selector"）。它是模型按钮的一个紧邻兄弟，看起来就像
面板底部那一行的延伸：

```
[ 模型：GLM 5.3 › ] [ 👁 副眼 ]   ← 同一个工具行；手机窄屏只留图标
```

- 当前模型本来就声明了 image → 不占位置（不需要副眼）。双胞胎路由只挂给**至少有一个纯文本模型**的 provider：一个 provider 里全是多模态模型时，它连双胞胎都不会有。
- 双胞胎的模型表**照抄基座**（0.5.0 起）：`+副眼` 那一行里多模态模型也在；选中多模态模型时会**自动关掉副眼并把 provider 退回基座**（0.5.2，模型菜单里 `+ 副眼` 那行随之消失），图片重新走原生附件。
- 当前 provider 没有双胞胎路由 → 不占位置。
- 纯文本模型 → 出现眼睛按钮：**睁眼 = 副眼开着，闭眼（带斜杠）= 关着**，不画边框；桌面端按钮文字：未开副眼显示「副眼」，开了显示「副模型名 · 思考档位」（0.5.3 起），窄屏（< 641px）只留 24px 图标（不缩边距、不挤工具行）。
  点开是「副模型（按 provider 分组，只列真声明 image 的）」；**再点一次已选中的模型 =
  关掉副眼**（与「关闭副眼」按钮等价）。选中后模型名下面是「思考强度：」+ 下拉框
  （选项 = 默认 + 该模型声明的档位），面板不关，随手就能换。未选副眼时不再显示提示行。
  面板按视口量着长：宽度夹在 min(320, 视口-16)，高度只占按钮上方真正剩下的空间。
  **标题行（「副眼模型」）、搜索框、关闭入口同处一行，独占一块**，下面是独立滚动的
  列表：滚的只有列表，内容不会从标题背后穿过（标题行不是浮层，也不做半透明遮罩）；
  搜索框占剩余宽度，窄面板下自动收缩；配色/圆角/阴影全部用宿主主题 token
  （--dsw-specific-menu、--dsw-alias-border-l2、--dsw-elevation-prominent、--dsw-alias-label-*），
  和 dsh-context-control 的面板同一套观感。

打开副眼会同时做两件事：把选择写进 Host（`remote.secondSight.set`，按会话存），
并把会话模型切到 `<provider>-second-sight`。第二步不是可选项——附件准入只看
「当前模型声明没声明 image」，纯文本模型会在那一步被直接拒收。切换后模型名不变
（双胞胎的模型表照抄基座），界面上几乎看不出切换。

缓存键里带着所选副模型与思考强度，换一个副模型问同一个问题会真的重新问。`ask_image` 调用时把思考档位作为 `reasoningEffort` 传给副模型。

模型列表里每个 provider 只显示一行（0.5.1 起）：没开副眼时只列原始 provider（所有 `+ 副眼` 组都藏起来）；开了副眼就只显示当前那条 `<provider> + 副眼`，它的原始 provider 行和其它 provider 的 `+ 副眼` 组都不出现——系统全会话只有一行代表当前视角。

## 用法

打开副眼后，正常贴图提问。模型看到的是：

```
[图片 img-1a2b3c4d5e6f：你无法直接看到它的像素，这里只是占位。需要其中内容时调用
 ask_image(image="img-1a2b3c4d5e6f", question="具体问题")；同一张图可多次追问不同问题，
 相同问题会命中缓存。不要凭空猜测图片内容。]
```

`ask_image` 的参数：

| 参数 | 说明 |
|---|---|
| `image` | 一个或多个句柄，逗号分隔（多图一次问 = 对比） |
| `question` | 具体问题：读某段文字、描述布局、读某个数值、对比两张图 |
| `detail` | `full`（默认，穷尽、逐字引用）/ `gist`（至多两句） |

## 测试

```powershell
npm test                 # 假宿主 50 + 客户端 23 + 真实网关 8 + 真实宿主 8 = 89 组断言，
                         # 另加 update.js 冒烟（版本比较 / 通道分类 / 路由 / 本地拒绝升级）
npm run check            # 清单自检 + 语法 + 上面全部测试（CI 跑的就是这个）
```

`test/smoke.mjs` 用**契约精确的假宿主**（复刻 `registerAdapter` / `listModels` / `tools.register`
的校验），`test/client.mjs` 把 `client.js` 塞进一个最小 React（`useState`/`useEffect`/
`useSyncExternalStore` 都实现）里挂载、点击、断言真实产出，`test/gateway-mount.mjs` 拉起
**真实的 Typert 网关客户端**让 `validateContribution` 亲自验收贡献，`test/host-integration.mjs`
直接 import 本机 `@deepseek-ai/*` 拉起真实的 `LlmRuntime` + `ToolsService` 跑同一批契约，
`test/update.mjs` 用桩 fetch 走一遍 GitHub / 本地两种通道。找不到 DSH 安装时中间两个自动跳过。

> `gateway-mount.mjs` 是 0.3.0 那次线上故障的回归防线：网关挂载贡献时对每个参数跑
> `requireStrictCodec`，只认 `codec.mode === 'strict'`。用 `src-json` 会在浏览器里报
> `client api: generated Remote secondSight/state field "sessionId" has no strict codec`
> ——离线假宿主看不出来，只有真网关会拒。

## 设计取舍

- **不做 OCR/裁剪/取色/描摹**：副模型就是用户已配好的多模态 provider，问什么由主模型决定。
- **不绕过闸 1**：在真·纯文本模型下贴图仍然被拒绝。想看图就显式选双胞胎——是选择，不是偷改路由。
- **面板不改写官方选择器**：弹窗内部没有插槽，整席位替换意味着重写整个模型选择器，所以
  副眼做成模型按钮的紧邻兄弟；打开副眼时由它替用户切到双胞胎，界面上的模型名不变。
- **句柄由内容寻址派生**（`sha256:<hex>` 的前 12 位）：跨消息、跨轮次、跨重启都指向同一张图，
  重建不需要持久化；但**投影记忆活在进程里**，重启后旧会话需要重新贴一张图才会重建句柄。
- **预算按句柄计数、跨会话共享**：同一张图问满 12 次就停，防止主模型把图问烂。

## 已知限制

- 双胞胎路由会出现在设置页的 provider 列表里（无地址行），与同类插件现象一致。
- 面板的选择是**按会话、进程内**的：宿主重启后回到「未选副眼」，图片会重新被拒收，重新选一次即可。
- 面板依赖宿主的 Typert 网关（`remote.secondSight`）。宿主解析不到
  `@deepseek-ai/dsh-typert-protocol` 时按钮会提示读取失败，贴图 + `ask_image` 仍可用，
  但没法在面板里选副模型。
- 在线升级依赖 GitHub 可达；网络不通时版本行显示「检查更新失败」，不影响副眼本体。
  升级接口由宿主进程提供，页面在旧宿主上会看到「升级接口 404」——重启 dsh web 后消失。
- `ask_image` 只在双胞胎会话可见（`tool.visibility: twin`），而且只对这条路由真正服务的
  纯文本模型放行：主模型是多模态时（哪怕选择还停在「+副眼」上——副眼已经自动关掉），
  它自己就能看图，工具表里不挂 `ask_image`。想让所有会话都能问，改成 `always`，但要接受
  真多模态会话里多一个工具。
- 副模型调用的 token 是否计入会话成本，取决于宿主的计量路径，尚未实测。

## 文件

| 文件 | 内容 |
|---|---|
| `index.js` | 插件本体（零依赖）：双胞胎路由 + `ask_image` + `remote.secondSight` + 升级路由挂载 |
| `client.js` | 浏览器半边（零依赖）：副眼按钮、选择面板、底部版本/升级行 |
| `update.js` | 宿主半边升级通道：检查、缓存、一键升级、安装日志（零依赖） |
| `cordis.patch.yml` | 加载补丁与默认配置 |
| `CHANGELOG.md` | 用户可见的版本变化 |
| `HANDOFF.md` | 方案交接文档（契约、ADR、验收用例、实施记录） |
| `test/smoke.mjs` | 假宿主单测（50） |
| `test/client.mjs` | 客户端挂载单测（23） |
| `test/gateway-mount.mjs` | 真实 Typert 网关校验（8） |
| `test/host-integration.mjs` | 真实宿主契约测试（8） |
| `test/update.mjs` | 升级通道冒烟（通道分类 / 版本比较 / 路由 / 本地拒绝升级） |

## 发布（维护者）

```powershell
# 1. 改 package.json 与 client.js 的 CLIENT_VERSION，补 CHANGELOG，然后：
npm run check

# 2. 提交并打 tag（tag 必须等于 package.json 的版本）
git tag v0.6.0
git push origin main --tags
```

`publish.yml` 会在 tag 上跑自检、打 tarball（`dsh-second-sight-0.6.0.tgz` 与稳定名
`dsh-second-sight.tgz`）、生成 `channel.json`，再上传到同一次 GitHub Release。
有 `NPM_TOKEN` 时额外发布到 npm，没有就跳过。
