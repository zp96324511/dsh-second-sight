/**
 * dsh-second-sight（副眼）—— 给纯文本主模型补一层「看图」能力。
 *
 * 形态：双胞胎路由 + 工具化追问。
 *   1) 为每个 provider 注册 `<provider>-second-sight`，模型表照抄，只把
 *      inputModalities 加成 ['text','image']，让服务端的三道闸全部放行；
 *   2) 请求投影时把 image 块换成句柄提示（不转写），主模型据此知道自己有图；
 *   3) 注册 ask_image 工具，由主模型决定问什么、问几次；答案按
 *      (句柄集合, detail, 问题) 缓存，并可跨问复用历史问答。
 *
 * 零依赖：适配器与工具都用鸭子类型满足宿主契约（见 HANDOFF.md 第 5 节）。
 * 唯一的可选依赖是设置面板用的 Typert Gateway 基类，按需动态 import，
 * 拿不到就退化成「只用配置文件里的副模型」。
 *
 * 宿主契约（DSH 0.2.2-rc.1，均为实测确认）：
 *   - llm.registerAdapter(providers, adapter) → handle()/handle.replace()
 *   - adapter.providerInfo / providerRetryPolicy / imageRequestPricing /
 *     imageRequestTarget / listModels / resolveModel / prepareCall / stream
 *   - tools.register(definition, { when }) —— 必须有 output.render
 *   - ctx.effect(function* () { yield disposer })
 */

import { createUpdateRoutes, createUpdater, LOADED_VERSION } from './update.js'

export const name = 'dsh-second-sight'
export const version = LOADED_VERSION
export const inject = ['llm', 'tools']

/** 设置面板与升级接口共用的路由前缀（和 dsh-active-sessions 一致）。 */
const UPDATE_PREFIX = '/plugins/dsh-second-sight'

const DEFAULT_SUFFIX = '-second-sight'
const HANDLE_PREFIX = 'img-'
const DEFAULT_HANDLE_HEX = 12
const REF_LIMIT = 512
const ANSWER_LIMIT = 256
const HISTORY_LIMIT = 256
const SESSION_LIMIT = 128
/** 子智能体沿父会话链找副模型时最多往上爬几层（宿主默认的委派深度远小于这个数）。 */
const MAX_INHERIT_HOPS = 16
/** 设置面板的远端服务命名空间；客户端用 ctx.get('remote.secondSight') 取。 */
const REMOTE_NAMESPACE = 'secondSight'
/** Gateway 读取的可远程调用方法表（等价于 TS 的 @Remote 装饰器）。 */
const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods'
const REMOTE_MODULE = '@deepseek-ai/dsh-typert-protocol'
/**
 * 注册时打在 `when` 上的标记：别的插件据此在提示里点名注册者。
 *
 * DSH 的注册表只存 `{ definition, when }`，没有归属字段，所以 `when` 是唯一能
 * 跟着工具一起走、又不依赖加载顺序的对象。用 `Symbol.for` 是因为读它的代码在
 * 另一个插件里，没法 import 这个常量。
 */
const TOOL_OWNER_KEY = Symbol.for('dsh.tool.owner')

// —— 配置 ——

const blank = (value) => (typeof value === 'string' ? value.trim() : '')

const positiveInt = (value, fallback) =>
  Number.isInteger(value) && value > 0 ? value : fallback

const nonNegativeInt = (value, fallback) =>
  Number.isInteger(value) && value >= 0 ? value : fallback

/**
 * 把 profile 里的 config 节点归一成运行期配置。
 *
 * 副模型没有全局默认值：它是每个会话在模型面板里现选的（`remote.secondSight.set`）。
 * 配置里只剩与"选谁"无关的调参项，所以缺 `vision` 也不该拦插件加载。
 * @param {unknown} raw - `apply(ctx, config)` 收到的原始配置。
 * @returns {object} 归一后的配置。
 */
export function resolveConfig(raw) {
  const cfg = raw && typeof raw === 'object' ? raw : {}
  const vision = cfg.vision && typeof cfg.vision === 'object' ? cfg.vision : {}

  const suffix = blank(cfg.providerSuffix) || DEFAULT_SUFFIX
  if (/\s/.test(suffix)) {
    throw new Error(`dsh-second-sight: config.providerSuffix 不能包含空白字符（当前 "${suffix}"）`)
  }

  const questions = cfg.questions && typeof cfg.questions === 'object' ? cfg.questions : {}
  const handles = cfg.handles && typeof cfg.handles === 'object' ? cfg.handles : {}
  const tool = cfg.tool && typeof cfg.tool === 'object' ? cfg.tool : {}

  const hexLength = Number.isInteger(handles.length)
    ? Math.min(32, Math.max(8, handles.length))
    : DEFAULT_HANDLE_HEX

  const allow = Array.isArray(cfg.providers)
    ? cfg.providers.filter((id) => typeof id === 'string' && id.trim() !== '').map((id) => id.trim())
    : []
  const deny = Array.isArray(cfg.excludeProviders)
    ? cfg.excludeProviders.filter((id) => typeof id === 'string' && id.trim() !== '').map((id) => id.trim())
    : []

  return {
    // 副模型是会话级的；这里只剩与"选谁"无关的算力上限
    maxTokens: positiveInt(cfg.maxTokens ?? vision.maxTokens, 2048),
    providers: allow,
    excludeProviders: deny,
    providerSuffix: suffix,
    handleLength: hexLength,
    maxPerImage: positiveInt(questions.maxPerImage, 12),
    historyTurns: nonNegativeInt(questions.historyTurns, 6),
    toolVisibility: tool.visibility === 'always' ? 'always' : 'twin',
    logDebug: tool.log === true || cfg.log === true,
  }
}

// —— 句柄与状态 ——

/**
 * 由附件内容寻址 id 派生稳定句柄：`sha256:<hex>` → `img-<前 N 位 hex>`。
 * 用内容寻址而不是消息 id，同一张图跨消息/跨轮次/跨重启都指向同一句柄。
 * @param {{attachmentId?: string} | undefined} ref - 图片附件引用。
 * @param {number} [length] - 句柄里保留的十六进制字符数。
 * @returns {string} 句柄，取不到内容寻址 id 时返回空串。
 */
export function handleOf(ref, length = DEFAULT_HANDLE_HEX) {
  const id = typeof ref?.attachmentId === 'string' ? ref.attachmentId : ''
  if (id === '') return ''
  const digest = id.startsWith('sha256:') ? id.slice(7) : id
  const clean = digest.replace(/[^0-9a-zA-Z]/g, '')
  return clean === '' ? '' : `${HANDLE_PREFIX}${clean.slice(0, length)}`
}

function createState() {
  return {
    refs: new Map(),      // handle -> attachment ref（LRU，上限 REF_LIMIT）
    answers: new Map(),   // cacheKey -> Promise<string>（LRU，上限 ANSWER_LIMIT）
    history: new Map(),   // handle -> [{ question, answer }]
    calls: new Map(),     // handle -> 已成功发起的不同问题数（预算）
    sessions: new Map(),  // sessionId -> { provider, model, reasoningEffort? }（面板选的副模型）
    selections: new Map(), // sessionId -> 最近一次已知的会话模型选择（state 回带用）
    catalog: undefined,   // { at, value } 副模型目录缓存
    baseNames: new Map(), // provider id -> 显示名（双胞胎叫「<显示名> + 副眼」）
  }
}

function rememberRef(state, handle, ref) {
  state.refs.delete(handle)
  state.refs.set(handle, ref)
  while (state.refs.size > REF_LIMIT) state.refs.delete(state.refs.keys().next().value)
}

function rememberHistory(state, handle, question, answer, turns) {
  if (turns <= 0) return
  const list = state.history.get(handle) ?? []
  if (!state.history.has(handle)) {
    state.history.delete(handle)
    state.history.set(handle, list)
  }
  list.push({ question, answer })
  while (list.length > turns) list.shift()
  while (state.history.size > HISTORY_LIMIT) state.history.delete(state.history.keys().next().value)
}

/** 解析模型给的句柄列表：逗号、顿号、分号、空白都算分隔符。 */
function parseHandles(value) {
  if (typeof value !== 'string') return []
  return value.split(/[\s,，、;；]+/).map((part) => part.trim()).filter((part) => part !== '')
}

/** 一张图的占位提示。四要素缺一不可：看不见 + 句柄 + 调用方式 + 可多次追问。 */
function handleLine(handle) {
  if (handle === '') {
    return '[图片附件（未识别的引用）：你看不到它的像素。需要内容时让用户重新发送这张图。]'
  }
  return `[图片 ${handle}：你无法直接看到它的像素，这里只是占位。需要其中内容时调用 ask_image(image="${handle}", question="具体问题")；同一张图可多次追问不同问题，相同问题会命中缓存。不要凭空猜测图片内容。]`
}

// —— 视觉问答 ——

const reasonOf = (error) => (error instanceof Error ? error.message : String(error))

const modilitiesWithImage = (current) => [...new Set(['text', 'image', ...(Array.isArray(current) ? current : [])])]

/**
 * 副模型只被当作「看图并回答」的普通对话：请求里不带 tools，也没有 tool loop。
 * 但 agentic 模型看到附件旁那行 "Normalized copy … <path>"（宿主在图片前注入的
 * 只读副本路径）会顺手去调 bash/python。第一次就把「你没有工具」写死在指令里。
 */
const VISION_RULES = [
  'You are a vision describer called through a tool. You have no tools, no shell, and no filesystem access.',
  'Never emit tool calls, shell commands, or code meant to be executed; never repeat tool-call markup such as DSML.',
  'The image preamble may contain a "Normalized copy" path: it is host metadata, not something for you to open, inspect, copy, or modify.',
  'Answer only from what is visible in the image.',
].join(' ')

/** 第一次仍然把工具调用当正文时，第二次用这段更硬的约束（并点名上次的错误）。 */
const VISION_RULES_RETRY = [
  'IMPORTANT: your previous reply was a tool call, not an answer, and it was discarded.',
  'You cannot run tools, commands, or code, and you cannot read files. Do not mention or use the "Normalized copy" path.',
  'Answer the question in plain prose (a markdown table is fine) using only what you can see in the image.',
  'If the image does not show the requested detail, say so plainly instead of trying to inspect anything.',
].join(' ')

/**
 * 判断一段「答案」是不是工具调用文本。返回命中的特征名，没命中返回 ''。
 * 只认强特征，避免把「抄写图里代码」这种正常答案误判掉。
 */
function toolCallMarker(text) {
  if (/DSML/i.test(text)) return 'DSML 标记'
  if (/<\/?[｜|]{1,2}[^>\n]{0,40}[｜|]{1,2}>/.test(text)) return '特殊 token'
  if (/"(?:tool_calls?|tool_call_id|function_call)"\s*:/.test(text)) return 'tool_calls JSON'
  // 整段答案只有一个 shell 代码块：通常是想执行命令而不是回答。真在转写命令的答案
  // 一般会带一句说明，重试时会按约束补上。
  if (/^\s*```(?:bash|sh|shell|zsh|powershell|pwsh)\b[\s\S]*```\s*$/i.test(text)) return '整段命令'
  return ''
}

/** 与副模型跑一轮纯文本对话：拼出 text-delta，同时记下有没有结构化工具调用。 */
async function streamVision(host, refs, prompt, signal, pick) {
  const { ctx, cfg } = host
  const content = []
  for (const ref of refs) content.push({ type: 'image', attachment: ref })
  // 图片在前、问题在后：同一张图的多次提问共享可缓存前缀（ADR-4）。
  content.push({ type: 'text', text: prompt })

  const parts = []
  let failure
  let toolCall = false
  const options = {
    provider: pick.provider,
    model: pick.model,
    maxTokens: cfg.maxTokens,
    messages: [{ role: 'user', content }],
    ...(pick.reasoningEffort === undefined ? {} : { reasoningEffort: pick.reasoningEffort }),
    ...(signal === undefined ? {} : { signal }),
  }
  for await (const chunk of ctx.llm.stream(options)) {
    if (chunk instanceof Object && chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      parts.push(chunk.text)
    } else if (chunk instanceof Object && (chunk.type === 'tool-call-delta' || chunk.type === 'tool-call')) {
      // 结构化工具调用：没有 tool loop，同样没法执行，按「不是答案」处理。
      toolCall = true
    } else if (chunk instanceof Object && chunk.type === 'finish') {
      const reason = chunk.reason
      if (reason?.kind === 'error') failure = reason.failure
      else if (reason?.kind === 'aborted') throw signal?.reason ?? new Error('视觉问答被取消')
    }
  }
  if (signal?.aborted) throw signal.reason ?? new Error('视觉问答被取消')
  const text = parts.join('').trim()
  if (failure !== undefined) {
    throw new Error(`视觉模型调用失败：${failure?.message ?? failure?.code ?? 'unknown'}${text === '' ? '' : `（已收到 ${text.length} 字的部分输出）`}`)
  }
  if (text === '') {
    if (toolCall) return { text: '', toolCall: true }
    throw new Error('视觉模型没有返回任何文字')
  }
  return { text, toolCall }
}

async function askVision(host, refs, handles, question, detail, signal, pick) {
  const { state, log } = host
  const prior = handles.length === 1 ? state.history.get(handles[0]) ?? [] : []
  const brief = detail === 'gist'
    ? 'Answer in at most two sentences. Be factual; do not speculate.'
    : 'Answer exhaustively. Quote visible text verbatim. Use a markdown table for tabular data. Say plainly when something is not visible.'

  const buildPrompt = (rules) => [
    rules,
    brief,
    prior.length === 0
      ? ''
      : `Earlier exchanges about this image:\n${prior.map((item) => `Q: ${item.question}\nA: ${item.answer}`).join('\n\n')}`,
    handles.length > 1 ? `Images are supplied in this order: ${handles.join(', ')}` : '',
    `Question: ${question}`,
  ].filter((part) => part !== '').join('\n\n')

  const first = await streamVision(host, refs, buildPrompt(VISION_RULES), signal, pick)
  const marker = first.toolCall ? '结构化工具调用' : toolCallMarker(first.text)
  if (marker === '') return first.text

  // 工具调用没有执行者，返回给主模型只会变成一段看不懂的代码——重试一次，仍不行就报错。
  log.warn(`ask_image：副模型返回了工具调用（${marker}），按「无工具」约束重试一次`)
  const second = await streamVision(host, refs, buildPrompt(VISION_RULES_RETRY), signal, pick)
  const again = second.toolCall ? '结构化工具调用' : toolCallMarker(second.text)
  if (again !== '') {
    throw new Error(`视觉模型连续两次返回工具调用（${again}）而不是答案。建议换一个副模型，或换个问法后重试。`)
  }
  return second.text
}

function trimAnswers(state, keepKey) {
  while (state.answers.size > ANSWER_LIMIT) {
    const oldest = state.answers.keys().next().value
    if (oldest === keepKey) break
    state.answers.delete(oldest)
  }
}

/**
 * 子会话的直属父会话。宿主把创建元数据放在 `session.header.parentSession`：
 * 子智能体一定带，普通 fork 一般不写。取不到（老会话、服务缺席、未来改字段）
 * 就当没有父会话——继承是锦上添花，绝不能让它把 ask_image 弄挂。
 * @param ctx - 宿主 ctx（`sessions` 服务由 dsh-session 提供）。
 * @param sessionId - 任何会话 id。
 * @returns 父会话 id，或 undefined。
 */
function parentSessionOf(ctx, sessionId) {
  try {
    const header = ctx.get('sessions')?.get?.(sessionId)?.header
    const parent = header?.parentSession
    return typeof parent === 'string' && parent !== '' ? parent : undefined
  } catch {
    return undefined
  }
}

async function runAsk(host, args, signal, sessionId) {
  const { state, cfg, log } = host
  const handles = [...new Set(parseHandles(args?.image))]
  if (handles.length === 0) {
    return '没有给出图片句柄（形如 img-1a2b3c4d5e6f）。请看对话里的句柄提示行，按其中给出的写法调用。'
  }
  const question = typeof args?.question === 'string' ? args.question.trim() : ''
  if (question === '') return 'question 不能为空：请写一个具体的问题（读某段文字、描述布局、读某个数值、对比两张图等）。'
  const detail = args?.detail === 'gist' ? 'gist' : 'full'

  const refs = []
  const missing = []
  for (const handle of handles) {
    const ref = state.refs.get(handle)
    if (ref === undefined) missing.push(handle)
    else refs.push(ref)
  }
  if (missing.length > 0) {
    const known = [...state.refs.keys()]
    const hint = known.length === 0
      ? '当前进程还没有记录任何图片；请在对话里找形如 img-1a2b3c4d5e6f 的句柄提示行，确实没有就请用户重新发送这张图。'
      : `当前可用的句柄：${known.slice(-8).join('、')}`
    return `找不到图片 ${missing.join('、')}：它可能不在当前进程的投影记忆里。${hint}`
  }

  // 副模型只来自本会话在面板里的选择（子智能体还会沿父会话继承）；都没有就问不了。
  const pick = host.pickFor(sessionId)
  if (pick === null) {
    // 子智能体自己没有面板（宿主锁着它的模型接口），能选的只有父会话。
    return parentSessionOf(host.ctx, sessionId) === undefined
      ? '这个会话还没选副眼（识图模型）。请用户在模型按钮右边的眼睛图标里选一个能看图的模型，再重新问同一个问题。'
      : '这个子智能体会话还没有可用的副眼，它自己没有面板（宿主锁着子会话的模型选择）。请用户在父会话里用模型按钮右边的眼睛图标选一次，子智能体会继承父会话的选择；选好后再问同一个问题。'
  }
  const key = `${[...handles].sort().join('+')}|${detail}|${pick.provider}/${pick.model}/${pick.reasoningEffort ?? ''}|${question}`
  const cached = state.answers.get(key)
  if (cached !== undefined) {
    state.answers.delete(key)
    state.answers.set(key, cached) // 命中即刷新 LRU
    log.debug(`ask_image 命中缓存：${handles.join('+')}`)
    return await cached
  }

  for (const handle of handles) {
    if ((state.calls.get(handle) ?? 0) >= cfg.maxPerImage) {
      return `图片 ${handle} 的询问次数已达上限（${cfg.maxPerImage} 次）。请基于已有答案继续，必要时告诉用户哪一部分看不清。`
    }
  }

  const started = Date.now()
  const job = askVision(host, refs, handles, question, detail, signal, pick)
  job.catch(() => {
    if (state.answers.get(key) === job) state.answers.delete(key)
  })
  state.answers.set(key, job)
  trimAnswers(state, key)

  let answer
  try {
    answer = await job
  } catch (error) {
    log.warn(`ask_image 失败（${handles.join('+')}）：${reasonOf(error)}`)
    throw error
  }

  for (const handle of handles) state.calls.set(handle, (state.calls.get(handle) ?? 0) + 1)
  rememberHistory(state, handles[0], question, answer, cfg.historyTurns)
  log.debug(`ask_image ok：${handles.join('+')}｜${detail}｜${pick.provider}/${pick.model}${pick.reasoningEffort === undefined ? '' : `·${pick.reasoningEffort}`}｜${question.length} 字问题｜${answer.length} 字答案｜${Date.now() - started}ms`)
  return answer
}

// —— 工具定义 ——

function askImageTool(host) {
  const { cfg } = host
  const handlesHint = 'Handle of an image from this conversation, e.g. img-1a2b3c4d5e6f. Separate handles with commas to compare several images in one call.'
  return {
    name: 'ask_image',
    description: [
      'Ask a vision model about an image that appears earlier in this conversation.',
      'You cannot see images yourself: each image is represented by a placeholder line that names its handle.',
      'Whenever the user refers to an image, or you need its content to answer, call this tool with that handle instead of guessing.',
      'Ask one concrete question per call: read exact text, describe the layout, read a value, or compare two images.',
      'Answers are cached per (handles, detail, question), so repeating the same question costs nothing.',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        image: { type: 'string', description: handlesHint },
        question: { type: 'string', description: 'The specific thing to find out.' },
        detail: {
          type: 'string',
          enum: ['gist', 'full'],
          description: 'gist = at most two sentences; full = exhaustive transcription (default).',
        },
      },
      required: ['image', 'question'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    presentCall(args) {
      const list = parseHandles(args?.image)
      const question = typeof args?.question === 'string' ? args.question : ''
      const target = list.length === 0 ? '(无句柄)' : list.join(' + ')
      return {
        card: 'generic',
        title: `看图 ${target}${question === '' ? '' : `：${question.slice(0, 60)}`}`,
        kind: 'read',
      }
    },
    presentResult(args, result) {
      if (result?.isError) return undefined
      const list = parseHandles(args?.image)
      return { card: 'generic', title: `看图 ${list.length === 0 ? '' : list.join(' + ')}`.trim() }
    },
    execute: async (args, exec) => ({ text: await runAsk(host, args, exec?.signal, exec?.agent?.id) }),
  }
}

/**
 * 双胞胎选择器只在副模型路由下暴露：真多模态会话看不到 ask_image。
 *
 * 除了 provider 必须是双胞胎，模型还得是这条路由真正服务的纯文本模型。双胞胎
 * 目录照抄基座（0.5.0），多模态模型也能在「+副眼」里选中；选中后 stateFor 会清掉
 * 这个会话的副眼，但**会话的选择本身不会切回基座**（宿主没有替用户改选模型的
 * 通道），于是 provider 仍是双胞胎——只看 provider 的话，一个自己就能看图、也
 * 不会再投影图片的模型，请求里会一直挂着这个用不上的工具。
 * @param cfg - 归一后的配置。
 * @param routes - 已注册的双胞胎路由（base id → handle，handle.adapter.models 是纯文本模型集）。
 */
function toolWhen(cfg, routes) {
  if (cfg.toolVisibility === 'always') return undefined
  return ({ modelSelection }) => {
    const provider = modelSelection?.provider
    const model = modelSelection?.model
    if (typeof provider !== 'string' || typeof model !== 'string') return false
    if (!provider.endsWith(cfg.providerSuffix)) return false
    const base = provider.slice(0, provider.length - cfg.providerSuffix.length)
    const adapter = routes?.get(base)?.adapter
    return adapter !== undefined && adapter.models.has(model)
  }
}

/**
 * 在 `when` 上写下注册者的名字。
 *
 * 门控面板要显示「由谁按会话条件起停」，而宿主的注册表不记归属。名字挂在
 * `when` 上就跟着注册走：读写双方都不依赖「谁先 apply」，也不会因为包装接口
 * 失败而丢信息。没有 `when`（`tool.visibility: always`）时无可附着——那种情况
 * 下工具本来就是可手动开关的，不需要这句提示。
 * @param when - 门控谓词，或 undefined。
 * @param owner - 面板里该怎么称呼这个插件。
 * @returns 同一个谓词，已打上标记。
 */
function declareOwner(when, owner) {
  if (typeof when !== 'function') return when
  try {
    Object.defineProperty(when, TOOL_OWNER_KEY, { value: owner, configurable: true })
  } catch (error) {
    /* 冻结的谓词只丢一句提示，工具本身不受影响。 */
  }
  return when
}

/**
 * 本插件在提示里该叫什么：优先用宿主给的 fiber 名（挂载名改了也跟得上），
 * 拿不到（root / 测试的假 ctx）就退回包名。
 * @param ctx - 插件的上下文。
 * @returns 插件名。
 */
function pluginLabel(ctx) {
  const name = ctx?.fiber?.name
  return typeof name === 'string' && name !== '' && name !== 'root' ? name : 'dsh-second-sight'
}

// —— 设置面板：Host ↔ Client 的 Typert 远端服务 ——

/**
 * 生成远端服务类。基类由 Gateway 提供（宿主进程才能解析），测试可以注入假的。
 * @param {Function} Base - `TypertRemoteService` 或等价的 duck type。
 * @returns {Function} 可直接 `new` 的服务类。
 */
export function createRemoteClass(Base) {
  class SecondSightRemote extends Base {
    constructor(ctx, ops) {
      super(ctx, REMOTE_NAMESPACE)
      this.ops = ops
    }

    /** 面板打开时读一次：当前选择、是否走双胞胎、可选的副模型与思考强度。 */
    async remoteState(sessionId, provider, model, reasoningEffort) {
      return this.ops.state(sessionId, provider, model, reasoningEffort)
    }

    /** 面板改一次：provider/model 传空串 = 回落到配置默认。 */
    async remoteSet(sessionId, provider, model, reasoningEffort) {
      return this.ops.set(sessionId, provider, model, reasoningEffort)
    }
  }

  // @Remote() 的纯 JS 等价物：Gateway 的 source-mode 发现读这个原型描述符。
  Object.defineProperty(SecondSightRemote.prototype, REMOTE_METHOD_DESCRIPTOR, {
    configurable: true,
    value: Object.freeze({
      version: 1,
      methods: Object.freeze([
        Object.freeze({ method: 'remoteState', exportName: 'state', invocation: Object.freeze({ kind: 'direct' }) }),
        Object.freeze({ method: 'remoteSet', exportName: 'set', invocation: Object.freeze({ kind: 'direct' }) }),
      ]),
    }),
  })
  return SecondSightRemote
}

/** 远端方法的接线：把面板操作翻译成「本会话用哪个副模型」。 */
function createOps(host) {
  const { ctx, cfg, state, log } = host

  const baseOf = (provider) => {
    const id = typeof provider === 'string' ? provider : ''
    return id.endsWith(cfg.providerSuffix) ? id.slice(0, -cfg.providerSuffix.length) : id
  }

  /** 可选的副模型：所有真 provider 里声明了 image 的模型 + 各自的思考强度。 */
  async function catalog() {
    if (state.catalog !== undefined && Date.now() - state.catalog.at < 30_000) return state.catalog.value
    const options = []
    for (const entry of ctx.llm.listProviders()) {
      const id = entry?.id
      if (typeof id !== 'string' || id === '' || id.endsWith(cfg.providerSuffix)) continue
      let models
      try {
        models = await ctx.llm.listModels(id)
      } catch (error) {
        log.debug(`面板跳过 ${id}：${reasonOf(error)}`)
        continue
      }
      const vision = models.filter((model) => Array.isArray(model.inputModalities) && model.inputModalities.includes('image'))
      if (vision.length === 0) continue
      // 思考强度只有 resolveModelInfo 才给全（官方选择器也是这么取），listModels 里常常没有。
      const detailed = await Promise.all(vision.map(async (model) => {
        try {
          return await ctx.llm.resolveModelInfo(id, model.id)
        } catch (error) {
          log.debug(`面板跳过 ${id}/${model.id}：${reasonOf(error)}`)
          return undefined
        }
      }))
      const usable = vision
        .map((model, index) => ({ model, info: detailed[index] }))
        .filter((entry) => entry.info !== undefined)
      if (usable.length === 0) continue
      options.push({
        provider: id,
        name: typeof entry.name === 'string' && entry.name !== '' ? entry.name : id,
        models: usable.map(({ model, info }) => ({
          id: model.id,
          name: model.name,
          efforts: (info.reasoning?.efforts ?? []).map((effort) => ({ id: effort.id, name: effort.name })),
          defaultEffort: info.reasoning?.defaultEffort ?? null,
        })),
      })
    }
    const value = Object.freeze(options)
    state.catalog = { at: Date.now(), value }
    return value
  }

  /**
   * 宿主的 selectModel 会把这次选择顺手写成「全局默认模型」。于是把会话切到双胞胎时，
   * 默认值也变成了 `*-second-sight`——那个 provider 只有本插件加载后才存在：
   * 设置页会多出一行陌生 provider，插件没加载时解析失败还会掉回别的模型。
   * 这里在回报状态时顺手把默认值改回基座，只改双胞胎，不动用户自己的选择。
   */
  function healDefaultModel() {
    try {
      const service = ctx.get('agentDefaultModel')
      if (service === undefined || service === null) return
      const current = service.currentSelection()
      const provider = typeof current?.provider === 'string' ? current.provider : ''
      const base = baseOf(provider)
      if (base === '' || base === provider) return
      if (!host.routes().has(base)) return
      const model = typeof current.model === 'string' ? current.model : ''
      if (model === '') return
      const effort = typeof current.reasoningEffort === 'string' ? current.reasoningEffort : ''
      void Promise.resolve(
        service.saveSelection({
          provider: base,
          model,
          ...(effort === '' ? {} : { reasoningEffort: effort }),
        }),
      ).catch(() => {})
    } catch {
      // 没有 configEditor 或服务不可用时静默跳过：这只是顺手修，不影响主流程。
    }
  }

  async function stateFor(sessionId, provider, model, reasoningEffort) {
    healDefaultModel()
    const id = String(sessionId ?? '')
    const wanted = typeof provider === 'string' ? provider : ''
    const wantedModel = typeof model === 'string' ? model : ''
    if (wanted !== '' && wantedModel !== '') {
      // 记住这个会话最近一次的选择：set() 之后要按同一组参数回报状态，
      // 否则面板会拿副模型当成主模型去算 textOnly。
      touchSelection(id)
      state.selections.set(id, {
        provider: wanted,
        model: wantedModel,
        ...(typeof reasoningEffort === 'string' && reasoningEffort !== '' ? { reasoningEffort } : {}),
      })
    }
    const base = baseOf(wanted)
    const onTwin = wanted !== '' && wanted !== base

    let textOnly = true
    if (base !== '' && wantedModel !== '') {
      try {
        const info = await ctx.llm.resolveModelInfo(base, wantedModel)
        textOnly = Array.isArray(info.inputModalities) ? !info.inputModalities.includes('image') : true
      } catch {
        textOnly = true
      }
    }

    // 主模型换成多模态了：它自己就能看图，这个会话的副眼自动关掉（无需客户端参与）。
    if (!textOnly && state.sessions.has(id)) {
      state.sessions.delete(id)
      log.debug('dsh-second-sight: 主模型能看图，自动关掉这个会话的副眼')
    }

    const vision = state.sessions.get(id) ?? null
    const options = await catalog()
    const group = options.find((entry) => entry.provider === vision?.provider)
    const visionModel = group?.models.find((entry) => entry.id === vision?.model)
    return {
      sessionId: id,
      selection: {
        provider: wanted,
        model: wantedModel,
        ...(typeof reasoningEffort === 'string' && reasoningEffort !== '' ? { reasoningEffort } : {}),
      },
      base,
      onTwin,
      twin: host.routes().has(base) ? `${base}${cfg.providerSuffix}` : null,
      textOnly,
      // 没有全局默认：没在这个会话里选过就是 null，面板据此不点亮边框。
      vision:
        vision === null
          ? null
          : {
              provider: vision.provider,
              model: vision.model,
              providerName: group?.name ?? vision.provider,
              modelName: visionModel?.name ?? vision.model,
              reasoningEffort: vision.reasoningEffort ?? null,
              // 按钮文字要显示「模型名 · 档位名」，把档位表一并带上（客户端不重复拉目录）。
              efforts: visionModel?.efforts ?? [],
            },
      options,
    }
  }

  function touch(id) {
    state.sessions.delete(id)
    while (state.sessions.size >= SESSION_LIMIT) {
      state.sessions.delete(state.sessions.keys().next().value)
    }
  }

  function touchSelection(id) {
    state.selections.delete(id)
    while (state.selections.size >= SESSION_LIMIT) {
      state.selections.delete(state.selections.keys().next().value)
    }
  }

  /** 按本会话最近一次已知的选择回报状态（set 之后面板要能用同一组坐标继续渲染）。 */
  function report(id) {
    const last = state.selections.get(id)
    return stateFor(id, last?.provider ?? '', last?.model ?? '', last?.reasoningEffort ?? '')
  }

  return {
    state: (sessionId, provider, model, reasoningEffort) => stateFor(sessionId, provider, model, reasoningEffort),
    /** `provider`/`model` 都为空的字符串 = 关掉副眼、回落配置默认。 */
    async set(sessionId, provider, model, reasoningEffort) {
      const id = String(sessionId ?? '')
      const wanted = blank(provider)
      const wantedModel = blank(model)
      if (wanted === '' || wantedModel === '') {
        state.sessions.delete(id)
        log.debug('副模型 → 回落配置默认')
        return report(id)
      }
      const effort = blank(reasoningEffort)
      touch(id) // 先腾位置，再写入；顺序反了会把刚写的这条删掉
      state.sessions.set(id, {
        provider: wanted,
        model: wantedModel,
        ...(effort === '' ? {} : { reasoningEffort: effort }),
      })
      log.debug(`副模型 → ${wanted}/${wantedModel}${effort === '' ? '' : `·${effort}`}`)
      return report(id)
    },
  }
}

// —— 双胞胎适配器（鸭子类型满足 LlmAdapter 契约）——

/**
 * 一条双胞胎路由。只有「真的有纯文本模型」的 provider 才会被挂上；
 * `models` 是这台基座里声明为纯文本的模型 id（出场时快照，之后由 reconcile 更新）。
 */
class SecondSightAdapter {
  constructor(host, base, models) {
    this.host = host
    this.ctx = host.ctx
    this.base = base
    this.models = new Set(models)
  }

  providerInfo(provider) {
    const base = this.host.state.baseNames.get(this.base) ?? this.base
    return { id: provider, name: `${base} + 副眼` }
  }

  providerRetryPolicy() {
    return undefined
  }

  imageRequestPricing() {
    return undefined
  }

  imageRequestTarget(_provider, _model, image) {
    return { width: image.width, height: image.height, maxBytes: image.bytes }
  }

  async listModels(provider) {
    const models = await this.ctx.llm.listModels(this.base)
    // 目录里放**全部**模型（含多模态）：用户明确不要「+副眼 里只剩纯文本」那种残缺列表。
    // 多模态模型在双胞胎上也照常能选；选中之后 stateFor 会清掉这个会话的副眼，
    // 请求里也不再挂 ask_image（toolWhen 只放行这条路由真正服务的纯文本模型）。
    // provider 必须回写成双胞胎 id：LlmRuntime.listModels 会校验 model.provider === provider
    return models.map((model) => ({
      ...model,
      provider,
      inputModalities: modilitiesWithImage(model.inputModalities),
    }))
  }

  async resolveModel(provider, model, signal) {
    let info
    try {
      info = await this.ctx.llm.resolveModelInfo(this.base, model, signal)
    } catch (error) {
      this.host.log.debug(`resolveModel 回退（${this.base}/${model}）：${reasonOf(error)}`)
      info = { provider: this.base, id: model, name: model }
    }
    // 其余元数据（contextWindow / defaultMaxTokens / reasoning / toolUpdate）原样继承。
    // 双胞胎路由只服务纯文本模型，所以这里不再假装它会看图——只有 truly text 的模型
    // 才会走到这条路由上，声明 image 是为了让附件准入放行，如实保留基座的模态即可。
    return { ...info, provider, inputModalities: modilitiesWithImage(info.inputModalities) }
  }

  async prepareCall(provider, model, signal) {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options) => this.stream(options),
    }
  }

  async *stream(options) {
    // 只有纯文本模型才需要把图片换成句柄、逼模型去用 ask_image；
    // 多模态模型在双胞胎上也走原生附件（此时副眼本来就已经被自动关掉了）。
    const textOnly = this.models.has(options?.model)
    const messages = Array.isArray(options?.messages) && textOnly
      ? rewriteMessages(this.host.state, options.messages, this.host.cfg)
      : options?.messages
    // 只复制字符串键：符号键里可能有 agent-loop 的 WeakSet 标记（ADR-6）
    const forwarded = Object.fromEntries(Object.entries(options))
    forwarded.provider = this.base
    forwarded.messages = messages
    for await (const chunk of this.ctx.llm.stream(forwarded)) {
      if (chunk instanceof Object && chunk.type === 'finish' && chunk.replayState !== undefined) {
        // replayState 属于产生它的适配器，跨适配器转发必须剥掉（ADR-6）
        const { replayState: _ignored, ...rest } = chunk
        yield rest
        continue
      }
      yield chunk
    }
  }
}

/**
 * 请求投影：image 块 → 句柄提示文本；没有图的消息原样引用（不复制）。
 * @param {object} state - 插件实例状态（记录句柄 → 附件）。
 * @param {Array<object>} messages - 待发往 provider 的消息。
 * @param {object} cfg - 归一后的配置。
 * @returns {Array<object>} 投影后的消息数组。
 */
function rewriteMessages(state, messages, cfg) {
  let changed = false
  const out = []
  for (const message of messages) {
    const content = message?.content
    if (!Array.isArray(content) || !content.some((block) => block?.type === 'image')) {
      out.push(message)
      continue
    }
    const next = []
    for (const block of content) {
      if (block?.type !== 'image') {
        next.push(block)
        continue
      }
      const handle = handleOf(block.attachment, cfg.handleLength)
      if (handle !== '') rememberRef(state, handle, block.attachment)
      next.push({ type: 'text', text: handleLine(handle) })
    }
    changed = true
    out.push({ ...message, content: next })
  }
  return changed ? out : messages
}

// —— 插件入口 ——

export function apply(ctx, rawConfig, bag) {
  const cfg = resolveConfig(rawConfig)
  const state = createState()
  const routes = new Map()
  let reconciling = false
  let stopped = false
  /** 最近一次 reconcile 的 promise：注册是异步的（要拉目录），测试和面板都要能等它。 */
  let pending = Promise.resolve()
  let registered = 0
  let announced = false
  let retryTimer = null
  let retryIndex = 0
  // 实测（boot 全栈探针）：credentials 服务在官方栈里排在本插件 apply 之后才挂上，
  // 而 pi-ai 的 listModels 会把 MISSING_CREDENTIAL 静默吞成 []；一轮 reconcile
  // 撞上这个窗口就会得出「全都没有纯文本模型」并且再也没有事件触发补注册。
  // 所以 reconcile 落空且还有「未解析」的 provider 时按这个梯度退避重试
  //（测试用 bag.retryDelays 缩短，宿主不传 bag，用默认）。
  const retryDelays = Array.isArray(bag?.retryDelays) && bag.retryDelays.length > 0
    ? bag.retryDelays
    : [2_000, 5_000, 10_000, 20_000, 40_000]

  function scheduleRetry(reason) {
    if (stopped) return
    if (retryIndex >= retryDelays.length) {
      log.debug(`dsh-second-sight: 重试已达上限（${reason}），等待 adapters-updated 事件`)
      return
    }
    const delay = retryDelays[retryIndex]
    retryIndex += 1
    clearTimeout(retryTimer)
    log.debug(`dsh-second-sight: ${reason}，${Math.round(delay / 1000)}s 后重试（第 ${retryIndex}/${retryDelays.length} 次）`)
    retryTimer = setTimeout(() => {
      retryTimer = null
      void reconcile()
    }, delay)
    // 宿主进程由 webserver 撑着事件循环；测试进程别被 40s 的重试拖住不退出。
    retryTimer.unref?.()
  }

  const logger = ctx.logger
  const log = {
    info: (...args) => logger?.info?.(...args),
    warn: (...args) => logger?.warn?.(...args),
    debug: (...args) => {
      if (cfg.logDebug) logger?.info?.(...args)
    },
  }
  const host = {
    ctx,
    cfg,
    state,
    log,
    /** 当前已注册的双胞胎路由（provider id → base）。 */
    routes: () => routes,
    /** 等一次 reconcile 落定（注册要拉目录，是异步的）。 */
    ready: () => pending,
    /**
     * 本会话该用哪个副模型：只有面板选过的才有，没有全局默认。
     *
     * 子智能体的面板拿不到选择权（宿主的 addressed subagent session 直接禁掉模型
     * 接口），但它的 agent.id 就是自己的子会话 id，和父会话不是同一个键。所以没
     * 在自己会话里选过时沿 `header.parentSession` 往上找：同一段对话的识图模型
     * 跟着对话走，比「没选过」更符合直觉（fork 出来的会话同理）。链上有环或
     * 超过深度上限就停，返回 null。
     */
    pickFor: (sessionId) => {
      let id = String(sessionId ?? '')
      const seen = new Set()
      for (let hop = 0; hop <= MAX_INHERIT_HOPS && id !== '' && !seen.has(id); hop += 1) {
        const chosen = state.sessions.get(id)
        if (chosen !== undefined) return { ...chosen }
        seen.add(id)
        id = parentSessionOf(ctx, id) ?? ''
      }
      return null
    },
  }

  const isTwin = (id) => id.endsWith(cfg.providerSuffix)
  // 双胞胎路由 → 基座 = 真实 provider，永远不会指回双胞胎自己，所以 vision provider
  // 也照常拥有双胞胎（它同时可能被当成主模型的基座）。
  const allowed = (id) =>
    typeof id === 'string' && id !== '' &&
    !isTwin(id) &&
    (cfg.providers.length === 0 || cfg.providers.includes(id)) &&
    !cfg.excludeProviders.includes(id)

  function release(handle) {
    try {
      handle()
    } catch (error) {
      log.warn(`撤销双胞胎路由失败：${reasonOf(error)}`)
    }
  }

  /**
   * 一个 provider 的目录：`threw` 表示 listModels 抛错（provider 还没就绪），
   * 模型列表里只挑「纯文本」的（没声明 inputModalities 的也算，保守起见按纯文本处理）。
   */
  async function catalogOf(id) {
    try {
      return { threw: false, models: await ctx.llm.listModels(id) }
    } catch (error) {
      log.debug(`双胞胎跳过 ${id}：目录不可用（${reasonOf(error)}）`)
      return { threw: true, models: [] }
    }
  }

  async function textOnlyModelsOf(id) {
    const { threw, models } = await catalogOf(id)
    return {
      threw,
      models: models
        .filter((model) => typeof model?.id === 'string' && model.id !== '')
        .filter((model) => !Array.isArray(model.inputModalities) || !model.inputModalities.includes('image'))
        .map((model) => model.id),
    }
  }

  /**
   * 把「当前所有 provider」同步成「有纯文本模型的那几条各挂一个双胞胎路由」。
   *
   * 注册的门槛是该 provider **至少有一个纯文本模型**——只有纯文本模型才需要副眼。
   * 但目录里给的是**全部模型**（0.5.0 起，用户推翻「+副眼 只剩纯文本」）：双胞胎上
   * 也能选多模态模型，选中后 stateFor 会清掉副眼，toolWhen 也不再放行 ask_image。
   * 过滤只发生在「要不要挂这条路由」的判定上，请求阶段只有纯文本模型才投影图片。
   */
  function reconcile() {
    if (reconciling) return pending
    reconciling = true
    pending = (async () => {
      try {
        const listed = ctx.llm.listProviders()
        const present = new Set(listed.map((entry) => entry?.id).filter((id) => typeof id === 'string'))
        // 双胞胎的展示名用基座的显示名（`天翼云CodingPlan (19276) + 副眼`），
        // 直接用 provider id 会在模型菜单里露出一串内部名字。
        for (const entry of listed) {
          if (typeof entry?.id === 'string' && typeof entry.name === 'string' && entry.name !== '') {
            host.state.baseNames.set(entry.id, entry.name)
          }
        }
        // 先撤销：provider 消失、被排除、或已经没有纯文本模型了。
        const wanted = new Map()
        let threw = false
        let unresolved = 0
        for (const base of present) {
          if (!allowed(base)) continue
          const twin = `${base}${cfg.providerSuffix}`
          // 名字被占用就让位（R5）——但「占用者」是我们自己那条双胞胎不算，
          // 否则 reconcile 每次都会把自己的路由判成冲突、先撤销再永远补不回来。
          if (present.has(twin) && !routes.has(base)) continue
          const outcome = await textOnlyModelsOf(base)
          if (outcome.threw) threw = true
          if (outcome.models.length === 0) {
            unresolved += 1
            continue
          }
          wanted.set(base, outcome.models)
        }
        if (stopped) return
        for (const [base, handle] of [...routes]) {
          const models = wanted.get(base)
          const adapter = handle.adapter
          const same = models !== undefined && models.length === adapter.models.size &&
            models.every((model) => adapter.models.has(model))
          if (same) continue
          release(handle)
          routes.delete(base)
        }
        for (const [base, models] of wanted) {
          if (routes.has(base)) continue
          const twin = `${base}${cfg.providerSuffix}`
          try {
            const adapter = new SecondSightAdapter(host, base, models)
            const handle = ctx.llm.registerAdapter([twin], adapter)
            handle.adapter = adapter
            routes.set(base, handle)
          } catch (error) {
            log.warn(`注册 ${twin} 失败：${reasonOf(error)}`)
          }
        }
        if (routes.size !== registered) {
          const first = !announced && routes.size > 0
          registered = routes.size
          if (first) {
            announced = true
            log.info(`dsh-second-sight: ${registered} 条双胞胎路由（${cfg.providerSuffix}）+ ask_image（副模型按会话在面板里选）`)
          } else {
            log.debug(`dsh-second-sight: 双胞胎路由 → ${registered} 条`)
          }
        }
        if (routes.size > 0) retryIndex = 0
        // 还有「没解析出来」的 provider，而且 credentials 服务还没挂上（或目录报错）
        // ——这是 boot 早期的常态（服务迟到 + pi-ai 把缺 key 吞成空目录），要退避重试。
        if (unresolved > 0 && (threw || ctx.get('credentials') === undefined)) {
          scheduleRetry(`有 ${unresolved} 个 provider 目录还没解析`)
        }
      } finally {
        reconciling = false
      }
    })()
    return pending
  }

  reconcile()
  const offAdapters = ctx.on('llm/adapters-updated', reconcile)

  const unregisterTool = ctx.tools.register(askImageTool(host), {
    when: declareOwner(toolWhen(cfg, routes), pluginLabel(ctx)),
  })

  // 设置面板的 Host 半边：客户端通过 remote.secondSight 读写本会话的副模型。
  // 基类由宿主进程提供（Gateway 的模块解析只在宿主里有效），拿不到就静默退化成配置文件默认。
  host.ops = createOps(host)
  host.remoteReady = (async () => {
    try {
      const mod = await import(REMOTE_MODULE)
      const Remote = createRemoteClass(mod.TypertRemoteService)
      new Remote(ctx, host.ops)
      log.debug(`dsh-second-sight: 设置面板已挂载（remote.${REMOTE_NAMESPACE}）`)
      return true
    } catch (error) {
      log.debug(`dsh-second-sight: 设置面板不可用（${reasonOf(error)}），副模型只用配置默认`)
      return false
    }
  })()

  // —— 在线升级通道（可选，挂了也不影响副眼）——
  // 面板底部那一行版本号 / 检查更新 / 一键升级靠这组 HTTP 端点。插件从不重启宿主，
  // 升级完成后只提示用户自己重启 dsh web。webServer 单独 inject：纯 CLI 宿主没有它。
  let updater
  host.updateReady = new Promise((resolve) => {
    if (typeof ctx.inject !== 'function') {
      resolve(false)
      return
    }
    try {
      ctx.inject(['webServer'], (scoped) => {
        const webServer = scoped.get?.('webServer') ?? scoped.webServer
        if (webServer === undefined) {
          resolve(false)
          return
        }
        try {
          updater = createUpdater({
            ctx,
            config: rawConfig && typeof rawConfig === 'object' ? rawConfig : {},
            logger: (message) => log.warn(String(message)),
          })
          host.updater = updater
          const handle = createUpdateRoutes(updater)
          const handler = (req, res) => {
            let pathname = '/'
            try {
              pathname = new URL(req.url ?? '/', 'http://x').pathname
            } catch { /* 坏 URL 交给 handle 返回 404 */ }
            Promise.resolve(handle(req, res, pathname)).catch((error) => {
              log.warn(`dsh-second-sight: 升级接口异常（${reasonOf(error)}）`)
              try {
                res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
                res.end(JSON.stringify({ ok: false, error: String(error) }))
              } catch { /* 响应可能已经发完了 */ }
            })
          }
          const dispose = webServer.register({ kind: 'prefix', path: UPDATE_PREFIX, handler })
          scoped.effect(() => () => {
            try {
              dispose?.()
            } catch { /* 已经撤掉了 */ }
            try {
              updater?.dispose()
            } catch { /* 没有在跑的作业 */ }
            updater = undefined
            host.updater = undefined
          })
          log.debug(`dsh-second-sight: 升级接口已挂载（${UPDATE_PREFIX}）`)
          resolve(true)
        } catch (error) {
          log.warn(`dsh-second-sight: 升级通道不可用（${reasonOf(error)}）`)
          resolve(false)
        }
      })
    } catch (error) {
      log.warn(`dsh-second-sight: 升级通道不可用（${reasonOf(error)}）`)
      resolve(false)
    }
  })

  ctx.effect(function* () {
    yield () => {
      stopped = true
      clearTimeout(retryTimer)
      retryTimer = null
      try {
        updater?.dispose()
      } catch {}
      try {
        offAdapters()
      } catch {}
      try {
        unregisterTool()
      } catch {}
      for (const handle of routes.values()) release(handle)
      routes.clear()
      state.refs.clear()
      state.answers.clear()
      state.history.clear()
      state.calls.clear()
      state.sessions.clear()
      state.selections.clear()
      state.catalog = undefined
    }
  })

  if (announced) {
    log.debug(`dsh-second-sight: ask_image ${cfg.toolVisibility === 'always' ? '全局可见' : '仅在双胞胎会话可见'}`)
  } else {
    log.info(`dsh-second-sight: 已就绪，当前还没有 provider；它们注册后会自动挂双胞胎路由`)
  }

  // 测试用把手：cordis 只传两个参数，第三个参数留给单测拿内部状态。
  if (bag !== undefined && bag !== null && typeof bag === 'object') {
    bag.host = host
    bag.reconciled = () => pending
  }
}
