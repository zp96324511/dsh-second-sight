/**
 * smoke.mjs —— 零依赖单测：用「契约精确的假宿主」跑 index.js 的全部行为。
 *
 * 假宿主刻意复刻了 LlmRuntime / ToolsService 的三处校验，参考实现里的 bug
 * （listModels 不改写 provider）在这里会直接炸：
 *   1) registerAdapter 校验 providerInfo(provider).id === provider；
 *   2) listModels 校验每条的 provider === 请求的 provider、id/name 非空；
 *   3) tools.register 要求 output.render 是函数。
 *
 * 运行：node test/smoke.mjs
 */

import { readFileSync } from 'node:fs'
import { apply, createRemoteClass, handleOf, name as pluginName, resolveConfig, version } from '../index.js'

// 版本号的唯一来源是 package.json，测试读它而不是写死，免得每次发版都红。
const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

const SUFFIX = '-second-sight'
const TWIN = `xhx2api${SUFFIX}`

let passed = 0
let failed = 0
const failures = []

async function check(title, run) {
  try {
    await run()
    passed += 1
    process.stdout.write(`  ok  ${title}\n`)
  } catch (error) {
    failed += 1
    failures.push(`${title}\n    ${error instanceof Error ? error.message : String(error)}`)
    process.stdout.write(`FAIL  ${title}\n    ${error instanceof Error ? error.message : String(error)}\n`)
  }
}

function equal(actual, expected, what) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${what}: 期望 ${b}，实际 ${a}`)
}

function ok(value, what) {
  if (!value) throw new Error(`${what}: 期望真值，实际 ${JSON.stringify(value)}`)
}

function throws(run, pattern) {
  try {
    run()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (pattern instanceof RegExp && !pattern.test(message)) {
      throw new Error(`抛错信息不匹配：${message}`)
    }
    return message
  }
  throw new Error('期望抛错，但没有抛')
}

// —— 假宿主 ——

const MODEL_TEXT_ONLY = {
  id: 'glm-5.3',
  name: 'GLM 5.3',
  inputModalities: ['text'],
  context: { contextWindow: 128000 },
  defaultMaxTokens: 8192,
}

const MODEL_VISION = {
  id: 'sensenova-6.8-flash-lite',
  name: 'SenseNova 6.8 Flash Lite',
  inputModalities: ['text', 'image'],
  context: { contextWindow: 256000 },
  defaultMaxTokens: 63999,
  // resolveModelInfo 才带思考强度（listModels 里没有），面板按它渲染档位。
  reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' },
}

/** 一个「真」适配器（真宿主 = pi-ai，这里只回固定内容）。 */
function baseAdapter(id, models, reply) {
  const catalog = new Map(models.map((model) => [model.id, { ...model, provider: id }]))
  return {
    providerInfo: (provider) => ({ id: provider, name: id }),
    providerRetryPolicy: () => undefined,
    async listModels(provider) {
      return [...catalog.values()].map((model) => ({ ...model, provider }))
    },
    async resolveModel(provider, model) {
      const found = catalog.get(model)
      if (found === undefined) throw new Error(`UNKNOWN_MODEL ${id}/${model}`)
      return { ...found, provider }
    },
    async prepareCall(provider, model) {
      return { model: await this.resolveModel(provider, model), stream: (options) => this.stream(options) }
    },
    async *stream(options) {
      yield { type: 'text-delta', text: reply }
      yield { type: 'finish', reason: { kind: 'stop' }, replayState: { from: id } }
    },
  }
}

function createHost({ providers = ['xhx2api', 'opencode-go'], reply = '图里写的是 hello', credentials } = {}) {
  const adapters = new Map()
  const listeners = new Map()
  const tools = []
  const effects = []
  const logs = []
  const seen = { streams: [], registered: [], unregistered: [] }

  const llm = {
    listProviders: () => [...adapters.keys()].map((id) => ({ id })),
    registerAdapter(ids, adapter) {
      for (const id of ids) {
        if (adapters.has(id)) throw new Error(`DUPLICATE_ADAPTER ${id}`)
        const info = adapter.providerInfo(id)
        if (info?.id !== id || typeof info.name !== 'string' || info.name === '') {
          throw new Error(`INVALID_ADAPTER ${id}: providerInfo 必须回 { id: "${id}", name }`)
        }
      }
      for (const id of ids) adapters.set(id, adapter)
      seen.registered.push(ids)
      emit('llm/adapters-updated')
      const dispose = () => {
        for (const id of ids) adapters.delete(id)
        emit('llm/adapters-updated')
      }
      dispose.replace = () => {}
      return dispose
    },
    async listModels(provider) {
      const adapter = adapters.get(provider)
      if (adapter === undefined) throw new Error(`NO_ADAPTER ${provider}`)
      const models = await adapter.listModels(provider)
      const ids = new Set()
      for (const model of models) {
        // 复刻 LlmRuntime.listModels 的 INVALID_CATALOG 校验
        if (model.provider !== provider) throw new Error(`INVALID_CATALOG: provider ${model.provider} !== ${provider}`)
        if (typeof model.id !== 'string' || model.id === '') throw new Error('INVALID_CATALOG: id')
        if (typeof model.name !== 'string' || model.name === '') throw new Error('INVALID_CATALOG: name')
        if (ids.has(model.id)) throw new Error('INVALID_CATALOG: duplicate id')
        ids.add(model.id)
      }
      return models
    },
    async resolveModelInfo(provider, model) {
      const adapter = adapters.get(provider)
      if (adapter === undefined) throw new Error(`NO_ADAPTER ${provider}`)
      const info = await adapter.resolveModel(provider, model)
      // 复刻 normalizeModelInfo 的校验
      if (info.provider !== provider) throw new Error(`INVALID_MODEL_INFO: provider ${info.provider} !== ${provider}`)
      if (info.id !== model) throw new Error(`INVALID_MODEL_INFO: id ${info.id} !== ${model}`)
      if (typeof info.name !== 'string' || info.name === '') throw new Error('INVALID_MODEL_INFO: name')
      return info
    },
    stream(options) {
      seen.streams.push(options)
      const adapter = adapters.get(options.provider)
      if (adapter === undefined) throw new Error(`NO_ADAPTER ${options.provider}`)
      return adapter.stream(options)
    },
  }

  const toolsSvc = {
    register(definition, options) {
      if (typeof definition?.output?.render !== 'function') throw new Error('tool output.render 必须是函数')
      if (typeof definition?.execute !== 'function') throw new Error('tool execute 必须是函数')
      tools.push({ definition, options })
      return () => {
        const index = tools.findIndex((entry) => entry.definition === definition)
        if (index >= 0) tools.splice(index, 1)
        seen.unregistered.push(definition.name)
      }
    },
  }

  function emit(event, ...args) {
    for (const fn of [...(listeners.get(event) ?? [])]) fn(...args)
  }

  const defaultModel = {
    current: { provider: '', model: '' },
    saved: [],
    currentSelection() {
      return { ...this.current }
    },
    async saveSelection(next) {
      this.saved.push(next)
      this.current = { ...next }
    },
  }

  const ctx = {
    llm,
    tools: toolsSvc,
    get: (name) =>
      name === 'agentDefaultModel' ? defaultModel
        : name === 'credentials' ? credentials
          : undefined,
    logger: {
      info: (...args) => logs.push(['info', ...args]),
      warn: (...args) => logs.push(['warn', ...args]),
      debug: (...args) => logs.push(['debug', ...args]),
    },
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(fn)
      return () => {
        const list = listeners.get(event) ?? []
        const index = list.indexOf(fn)
        if (index >= 0) list.splice(index, 1)
      }
    },
    effect(generator) {
      const iterator = generator()
      const step = iterator.next()
      if (step.done !== false || typeof step.value !== 'function') {
        throw new Error('ctx.effect 必须 yield 一个 disposer')
      }
      effects.push(step.value)
    },
  }

  // 预置「真」provider
  const real = {
    xhx2api: baseAdapter('xhx2api', [MODEL_TEXT_ONLY, MODEL_VISION], reply),
    'opencode-go': baseAdapter('opencode-go', [MODEL_TEXT_ONLY], reply),
  }
  for (const id of providers) adapters.set(id, real[id])

  return {
    ctx,
    logs,
    seen,
    tools,
    effects,
    llm,
    defaultModel,
    addProvider(id) {
      adapters.set(id, baseAdapter(id, [MODEL_TEXT_ONLY], reply))
      emit('llm/adapters-updated')
    },
    provider(id) {
      return adapters.get(id)
    },
    emits: emit,
  }
}

function config(overrides = {}) {
  return {
    maxTokens: 1024,
    questions: { maxPerImage: 12, historyTurns: 6 },
    ...overrides,
  }
}

const imageBlock = (hex) => ({ type: 'image', attachment: { attachmentId: `sha256:${hex}`, mediaType: 'image/png', bytes: 128, width: 8, height: 8 } })
const textBlock = (text) => ({ type: 'text', text })

/** 构造一次「主模型请求」：走双胞胎路由。 */
function request(host, messages, extra = {}) {
  const adapter = host.provider(TWIN)
  if (adapter === undefined) throw new Error('双胞胎路由未注册')
  return adapter.stream({ provider: TWIN, model: 'glm-5.3', messages, ...extra })
}

/** 轮询等到条件成立（重试是真实 setTimeout 驱动的，只能等它）。 */
async function waitFor(predicate, timeoutMs = 2000, stepMs = 5) {
  const start = Date.now()
  for (;;) {
    if (await predicate()) return
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时：条件一直不成立')
    await new Promise((resolve) => setTimeout(resolve, stepMs))
  }
}

async function drain(iterable) {
  const chunks = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}

function toolOf(host) {
  const entry = host.tools.find((item) => item.definition.name === 'ask_image')
  if (entry === undefined) throw new Error('ask_image 未注册')
  return entry
}

async function callAsk(host, args, sessionId = 's1') {
  return toolOf(host).definition.execute(args, { signal: undefined, agent: { id: sessionId } })
}

/** 应用插件并留一个内部把手（面板写覆盖、按会话读状态都要走它）。 */
async function bootstrap(host, overrides = {}) {
  // 默认关闭退避重试（真实 setTimeout 会拖慢/串台别的用例），要测重试的用例自己传。
  const bag = { retryDelays: overrides.retryDelays ?? [] }
  apply(host.ctx, config(overrides), bag)
  host.host = bag.host
  await bag.host.ready()
  return host
}

/** 在面板里选副模型 = 写本会话的覆盖（没有全局默认）。 */
async function pickVision(host, provider = 'xhx2api', model = 'sensenova-6.8-flash-lite', effort = '', sessionId = 's1') {
  await host.host.ops.set(sessionId, provider, model, effort)
}

// —— 用例 ——

process.stdout.write('\n配置\n')

await check('没有 vision 配置也能加载（副模型是会话级的）', async () => {
  const host = createHost()
  const bag = { retryDelays: [] }

  apply(host.ctx, {}, bag)

  await bag.host.ready()
  ok(host.provider(TWIN) !== undefined, '不带 config 也挂了双胞胎')
})

await check('providerSuffix 不能带空白', async () => {
  throws(() => resolveConfig(config({ providerSuffix: 'a b' })), /空白/)
})

await check('resolveConfig 归一：句柄长度夹到 8..32、预算取正数', async () => {
  equal(resolveConfig(config({ handles: { length: 2 }, questions: { maxPerImage: 0, historyTurns: -1 } })).handleLength, 8, 'handleLength 下限')
  equal(resolveConfig(config({ handles: { length: 99 } })).handleLength, 32, 'handleLength 上限')
  equal(resolveConfig(config()).handleLength, 12, 'handleLength 默认')
  equal(resolveConfig(config({ questions: { maxPerImage: 0 } })).maxPerImage, 12, 'maxPerImage 默认')
  equal(resolveConfig(config({ questions: { historyTurns: -1 } })).historyTurns, 6, 'historyTurns 默认')
  equal(resolveConfig(config({ tool: { visibility: 'always' } })).toolVisibility, 'always', 'visibility')
  equal(resolveConfig(config({ tool: { visibility: 'nope' } })).toolVisibility, 'twin', 'visibility 兜底')
})

await check('导出名与版本', async () => {
  equal(pluginName, 'dsh-second-sight', 'name')
  equal(version, PKG.version, 'version 与 package.json 一致')
})

process.stdout.write('\n双胞胎路由\n')

await check('每个 provider 注册一条双胞胎；已存在的同名路由让位', async () => {
  const host = createHost({ providers: ['xhx2api', 'opencode-go'] })
  // 先占一个双胞胎名字，模拟冲突
  host.ctx.llm.registerAdapter([`opencode-go${SUFFIX}`], baseAdapter('x', [MODEL_TEXT_ONLY], 'x'))
  const bag = { retryDelays: [] }

  apply(host.ctx, config(), bag)

  await bag.host.ready()
  const ids = host.llm.listProviders().map((entry) => entry.id).sort()
  equal(ids, [`opencode-go${SUFFIX}`, TWIN, 'opencode-go', 'xhx2api'].sort(), 'provider 列表')
  ok(host.provider(TWIN) !== undefined, 'vision provider 也有双胞胎（投影对所有 provider 生效）')
})

await check('provider 列表变化后自动补齐，撤销的 provider 连带撤销双胞胎', async () => {
  const host = createHost({ providers: ['xhx2api'] })
  const bag = { retryDelays: [] }

  apply(host.ctx, config(), bag)

  await bag.host.ready()
  equal(host.llm.listProviders().length, 2, '初始 1 真 + 1 双胞胎')
  host.addProvider('deepseek')
  await bag.host.ready() // reconcile 要拉目录，是异步的
  equal(host.llm.listProviders().length, 4, '新增后 2 真 + 2 双胞胎')
  ok(host.provider(`deepseek${SUFFIX}`) !== undefined, '新 provider 有双胞胎')
})

await check('providers 白名单与 excludeProviders 生效', async () => {
  const host = createHost({ providers: ['xhx2api', 'opencode-go', 'deepseek'] })
  const bag = { retryDelays: [] }

  apply(host.ctx, config({ providers: ['xhx2api', 'deepseek'], excludeProviders: ['deepseek'] }), bag)

  await bag.host.ready()
  equal(host.llm.listProviders().map((e) => e.id).sort(), ['xhx2api', 'xhx2api-second-sight', 'opencode-go', 'deepseek'].sort(), 'provider 列表')
})

await check('providerInfo 满足 id === provider、name 非空', async () => {
  const host = createHost()
  const bag = { retryDelays: [] }

  apply(host.ctx, config(), bag)

  await bag.host.ready()
  const info = host.provider(TWIN).providerInfo(TWIN)
  equal(info.id, TWIN, 'info.id')
  ok(typeof info.name === 'string' && info.name.length > 0, 'info.name')
})

await check('listModels 回写 provider 并补 image 模态（参考实现漏改 provider 会在这里炸）', async () => {
  const host = createHost()
  const bag = { retryDelays: [] }

  apply(host.ctx, config(), bag)

  await bag.host.ready()
  const models = await host.llm.listModels(TWIN)
  // 0.5.0 起目录照抄基座：多模态模型也在，选中后靠自动关副眼兜底。
  equal(models.map((model) => model.id), ['glm-5.3', 'sensenova-6.8-flash-lite'], '目录与基座一致')
  equal(models.map((model) => model.provider), [TWIN, TWIN], 'provider 回写')
  equal(models[0].inputModalities, ['text', 'image'], '纯文本模型被声明为可看图')
  equal(models[0].id, 'glm-5.3', 'id 保留')
  equal(models[0].context, { contextWindow: 128000 }, '其余元数据继承')
})

await check('resolveModel 改 provider 但保留 id/name/上下文', async () => {
  const host = createHost()
  const bag = { retryDelays: [] }

  apply(host.ctx, config(), bag)

  await bag.host.ready()
  const info = await host.provider(TWIN).resolveModel(TWIN, 'glm-5.3')
  equal(info.provider, TWIN, 'provider')
  equal(info.id, 'glm-5.3', 'id')
  equal(info.name, 'GLM 5.3', 'name')
  equal(info.context, { contextWindow: 128000 }, 'context')
  equal(info.inputModalities, ['text', 'image'], 'inputModalities')
})

await check('resolveModel 在基座路由缺失时回退成最小可用元数据', async () => {
  const host = createHost()
  const bag = { retryDelays: [] }

  apply(host.ctx, config(), bag)

  await bag.host.ready()
  const info = await host.provider(TWIN).resolveModel(TWIN, 'ghost-model')
  equal(info.id, 'ghost-model', 'id')
  equal(info.name, 'ghost-model', 'name 兜底')
  equal(info.provider, TWIN, 'provider')
})

process.stdout.write('\n请求投影\n')

await check('image 块换成句柄提示，附件本体不外泄；文本原样', async () => {
  const host = createHost()
  const bag = { retryDelays: [] }

  apply(host.ctx, config(), bag)

  await bag.host.ready()
  const hex = 'a'.repeat(64)
  const messages = [{ role: 'user', content: [textBlock('这是什么？'), imageBlock(hex)] }]
  await drain(request(host, messages))
  const forwarded = host.seen.streams.at(-1)
  equal(forwarded.provider, 'xhx2api', '内层 provider 回落基座')
  const content = forwarded.messages[0].content
  equal(content.length, 2, '块数不变')
  equal(content[0], { type: 'text', text: '这是什么？' }, '文本块原样')
  equal(content[1].type, 'text', '图片块变文本')
  ok(content[1].text.includes('img-aaaaaaaaaaaa'), '句柄 = 12 位 hex')
  ok(!JSON.stringify(forwarded.messages).includes('sha256:'), '不转写、不外泄附件 id')
  ok(!JSON.stringify(forwarded.messages).includes('attachmentId'), '不含附件字段')
})

await check('没有图的消息按引用透传，不复制', async () => {
  const host = createHost()
  const bag = { retryDelays: [] }

  apply(host.ctx, config(), bag)

  await bag.host.ready()
  const plain = [{ role: 'user', content: [textBlock('纯文本')] }, { role: 'user', content: '字符串内容' }]
  await drain(request(host, plain))
  const forwarded = host.seen.streams.at(-1).messages
  equal(forwarded.length, 2, '消息数')
  ok(forwarded[0].content[0] === plain[0].content[0], '文本块不复制')
})

await check('同一张图在同一请求里出现两次 → 句柄相同', async () => {
  const host = createHost()
  const bag = { retryDelays: [] }

  apply(host.ctx, config(), bag)

  await bag.host.ready()
  const hex = 'b'.repeat(64)
  await drain(request(host, [{ role: 'user', content: [imageBlock(hex)] }, { role: 'user', content: [imageBlock(hex)] }]))
  const forwarded = host.seen.streams.at(-1).messages
  equal(forwarded[0].content[0].text, forwarded[1].content[0].text, '同一句柄')
})

await check('finish 里的 replayState 被剥掉，其它 chunk 原样', async () => {
  const host = createHost()
  const bag = { retryDelays: [] }

  apply(host.ctx, config(), bag)

  await bag.host.ready()
  const chunks = await drain(request(host, [{ role: 'user', content: [textBlock('hi')] }]))
  equal(chunks.map((chunk) => chunk.type), ['text-delta', 'finish'], 'chunk 序列')
  ok(!('replayState' in chunks[1]), 'replayState 已剥离')
  equal(chunks[1].reason, { kind: 'stop' }, 'reason 保留')
})

await check('符号键（agent-loop 的 WeakSet 标记）不外传给内层', async () => {
  const host = createHost()
  const bag = { retryDelays: [] }

  apply(host.ctx, config(), bag)

  await bag.host.ready()
  const marker = Symbol('agent-loop')
  const options = { provider: TWIN, model: 'glm-5.3', messages: [{ role: 'user', content: [textBlock('hi')] }], [marker]: new WeakSet() }
  await drain(host.provider(TWIN).stream(options))
  const forwarded = host.seen.streams.at(-1)
  equal(Object.getOwnPropertySymbols(forwarded).length, 0, '内层无符号键')
})

process.stdout.write('\n工具与门控\n')

await check('ask_image 注册成功，when 只放行双胞胎路由', async () => {
  const host = createHost()
  const bag = { retryDelays: [] }

  apply(host.ctx, config(), bag)

  await bag.host.ready()
  const entry = toolOf(host)
  ok(typeof entry.options.when === 'function', 'when 是函数')
  equal(await entry.options.when({ modelSelection: { provider: TWIN, model: 'glm-5.3' } }), true, '双胞胎放行')
  equal(await entry.options.when({ modelSelection: { provider: 'xhx2api', model: 'glm-5.3' } }), false, '真多模态会话隐藏')
  equal(
    await entry.options.when({ modelSelection: { provider: TWIN, model: MODEL_VISION.id } }),
    false,
    '多模态模型即使在双胞胎 provider 上也不放行（副眼已自动关掉）',
  )
  equal(await entry.options.when({ modelSelection: { provider: TWIN } }), false, '没有模型名时隐藏')
  equal(await entry.options.when({}), false, '没有选择时隐藏')
  equal(entry.definition.parameters.required, ['image', 'question'], '必填参数')
  equal(entry.definition.output.render({}, { text: 'x' }), [{ type: 'text', text: 'x' }], 'render')
  equal(
    entry.options.when[Symbol.for('dsh.tool.owner')],
    'dsh-second-sight',
    'when 带上注册者名（门控面板提示用）',
  )
})

await check('when 上的注册者名优先取 fiber 名', async () => {
  const host = createHost()
  host.ctx.fiber = { name: 'second-sight-canary' }
  const bag = { retryDelays: [] }

  apply(host.ctx, config(), bag)

  await bag.host.ready()
  equal(
    toolOf(host).options.when[Symbol.for('dsh.tool.owner')],
    'second-sight-canary',
    '挂载名改了提示也跟着改',
  )
})

await check('tool.visibility: always 时不装 when', async () => {
  const host = createHost()
  const bag = { retryDelays: [] }

  apply(host.ctx, config({ tool: { visibility: 'always' } }), bag)

  await bag.host.ready()
  equal(toolOf(host).options.when, undefined, '无 when')
})

await check('工具 execute 走视觉模型：图片在前、问题在后', async () => {
  const host = createHost({ reply: '答案是 42' })
  bootstrap(host)
  await pickVision(host)
  await drain(request(host, [{ role: 'user', content: [imageBlock('c'.repeat(64))] }]))
  const handle = 'img-' + 'c'.repeat(12)
  const result = await callAsk(host, { image: handle, question: '图里的数字是多少？' })
  equal(result, { text: '答案是 42' }, '工具结果')
  const vision = host.seen.streams.at(-1)
  equal(vision.provider, 'xhx2api', 'vision provider')
  equal(vision.model, 'sensenova-6.8-flash-lite', 'vision model')
  equal(vision.maxTokens, 1024, 'maxTokens')
  equal(vision.messages[0].content.map((block) => block.type), ['image', 'text'], '图片在前')
  ok(vision.messages[0].content[1].text.includes('图里的数字是多少？'), '问题带上')
  ok(vision.messages[0].content[1].text.includes('Quote visible text verbatim'), 'full 指令')
})

await check('相同问题命中缓存，只调用一次视觉模型', async () => {
  const host = createHost()
  bootstrap(host)
  await pickVision(host)
  await drain(request(host, [{ role: 'user', content: [imageBlock('d'.repeat(64))] }]))
  const handle = 'img-' + 'd'.repeat(12)
  const before = host.seen.streams.length
  const first = await callAsk(host, { image: handle, question: '标题是什么？' })
  const second = await callAsk(host, { image: handle, question: '标题是什么？' })
  equal(first, second, '答案一致')
  equal(host.seen.streams.length - before, 1, '只打了一次')
})

await check('第二次追问带上历史问答，gist 换成两句以内的指令', async () => {
  const host = createHost()
  bootstrap(host)
  await pickVision(host)
  await drain(request(host, [{ role: 'user', content: [imageBlock('e'.repeat(64))] }]))
  const handle = 'img-' + 'e'.repeat(12)
  await callAsk(host, { image: handle, question: '标题是什么？' })
  await callAsk(host, { image: handle, question: '副标题呢？', detail: 'gist' })
  const prompt = host.seen.streams.at(-1).messages[0].content[1].text
  ok(prompt.includes('Earlier exchanges about this image'), '带历史')
  ok(prompt.includes('Q: 标题是什么？'), '历史问题')
  ok(prompt.includes('at most two sentences'), 'gist 指令')
  ok(!prompt.includes('Quote visible text verbatim'), 'gist 不要求逐字')
})

await check('多图一次问：一次调用、图片按顺序、历史不注入', async () => {
  const host = createHost()
  bootstrap(host)
  await pickVision(host)
  const hexes = ['1'.repeat(64), '2'.repeat(64)]
  await drain(request(host, [{ role: 'user', content: hexes.map(imageBlock) }]))
  const handles = hexes.map((hex) => 'img-' + hex.slice(0, 12))
  await callAsk(host, { image: handles.join(','), question: '两张图有什么不同？' })
  const vision = host.seen.streams.at(-1)
  equal(vision.messages[0].content.filter((block) => block.type === 'image').length, 2, '两张图')
  ok(vision.messages[0].content.at(-1).text.includes('Images are supplied in this order'), '标注顺序')
  ok(!vision.messages[0].content.at(-1).text.includes('Earlier exchanges'), '多图不带历史')
})

await check('未知句柄给可恢复的提示，不调用视觉模型', async () => {
  const host = createHost()
  bootstrap(host)
  await pickVision(host)
  const before = host.seen.streams.length
  const result = await callAsk(host, { image: 'img-000000000000', question: '这是什么？' })
  ok(result.text.includes('找不到图片'), '提示找不到')
  ok(result.text.includes('重新发送'), '提示怎么恢复')
  equal(host.seen.streams.length, before, '没有打视觉模型')
})

await check('空问题被挡下', async () => {
  const host = createHost()
  bootstrap(host)
  await pickVision(host)
  await drain(request(host, [{ role: 'user', content: [imageBlock('f'.repeat(64))] }]))
  const result = await callAsk(host, { image: 'img-' + 'f'.repeat(12), question: '   ' })
  ok(result.text.includes('question 不能为空'), '提示')
})

await check('超过 maxPerImage 后拒绝继续追问', async () => {
  const host = createHost()
  bootstrap(host, { questions: { maxPerImage: 2, historyTurns: 0 } })
  await pickVision(host)
  await drain(request(host, [{ role: 'user', content: [imageBlock('9'.repeat(64))] }]))
  const handle = 'img-' + '9'.repeat(12)
  await callAsk(host, { image: handle, question: '一' })
  await callAsk(host, { image: handle, question: '二' })
  const result = await callAsk(host, { image: handle, question: '三' })
  ok(result.text.includes('已达上限'), '提示上限')
})

await check('失败的调用不进缓存、不占预算', async () => {
  const host = createHost()
  bootstrap(host)
  await pickVision(host)
  await drain(request(host, [{ role: 'user', content: [imageBlock('8'.repeat(64))] }]))
  const handle = 'img-' + '8'.repeat(12)
  const vision = host.provider('xhx2api')
  const original = vision.stream
  vision.stream = async function* (options) {
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'upstream', message: '上游 502' } } }
  }
  let message = ''
  try {
    await callAsk(host, { image: handle, question: '会失败' })
  } catch (error) {
    message = error.message
  } finally {
    vision.stream = original
  }
  ok(message.includes('上游 502'), '错误透出')
  const answer = await callAsk(host, { image: handle, question: '会失败' })
  ok(answer.text.length > 0, '重试成功（没被缓存的 rejection 卡住）')
})

await check('空回答视为失败', async () => {
  const host = createHost()
  bootstrap(host)
  await pickVision(host)
  await drain(request(host, [{ role: 'user', content: [imageBlock('7'.repeat(64))] }]))
  const vision = host.provider('xhx2api')
  const original = vision.stream
  vision.stream = async function* () {
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  let message = ''
  try {
    await callAsk(host, { image: 'img-' + '7'.repeat(12), question: '空' })
  } catch (error) {
    message = error.message
  } finally {
    vision.stream = original
  }
  ok(message.includes('没有返回任何文字'), '提示空回答')
})

await check('presentCall 展示句柄与问题', async () => {
  const host = createHost()
  const bag = { retryDelays: [] }

  apply(host.ctx, config(), bag)

  await bag.host.ready()
  const call = toolOf(host).definition.presentCall({ image: 'img-abc, img-def', question: '标题是什么？' })
  ok(call.title.includes('img-abc + img-def'), '标题含句柄')
  ok(call.title.includes('标题是什么？'), '标题含问题')
  equal(call.kind, 'read', '只读')
})

process.stdout.write('\n生命周期\n')

await check('ctx.effect 撤销：路由、工具、监听器全清', async () => {
  const host = createHost()
  const bag = { retryDelays: [] }

  apply(host.ctx, config(), bag)

  await bag.host.ready()
  equal(host.effects.length, 1, '注册了一个 effect')
  equal(host.llm.listProviders().length, 4, '撤销前 2 真 + 2 双胞胎')
  host.effects[0]()
  equal(host.llm.listProviders().map((e) => e.id).sort(), ['opencode-go', 'xhx2api'], '双胞胎已撤销')
  equal(host.tools.length, 0, '工具已注销')
  equal(host.seen.unregistered, ['ask_image'], '注销记录')
  host.addProvider('late') // 监听器若没解绑会在这里重建路由
  equal(host.llm.listProviders().length, 3, '监听器已解绑（无新建双胞胎）')
})

await check('每次 reconcile 对外输出一条 info 日志', async () => {
  const host = createHost()
  const bag = { retryDelays: [] }

  apply(host.ctx, config(), bag)

  await bag.host.ready()
  ok(host.logs.some(([level, message]) => level === 'info' && message.includes('双胞胎路由')), 'apply 日志')
})

await check('log: true 时 ask_image 输出 debug 级信息', async () => {
  const host = createHost()
  bootstrap(host, { log: true })
  await pickVision(host)
  await drain(request(host, [{ role: 'user', content: [imageBlock('6'.repeat(64))] }]))
  await callAsk(host, { image: 'img-' + '6'.repeat(12), question: '问题' })
  ok(host.logs.some(([level, message]) => level === 'info' && message.includes('ask_image ok')), 'debug 日志')
})

process.stdout.write('\n设置面板\n')

await check('远端服务把 state/set 转发到 ops，方法表符合 Gateway 的发现格式', async () => {
  const seen = []
  class FakeBase {
    constructor(ctx, key) {
      seen.push(['construct', key])
    }
  }
  const Remote = createRemoteClass(FakeBase)
  const remote = new Remote({}, {
    state: async (sessionId, provider, model, effort) => ({ echoed: ['state', sessionId, provider, model, effort] }),
    set: async (sessionId, provider, model, effort) => ({ echoed: ['set', sessionId, provider, model, effort] }),
  })
  equal(seen, [['construct', 'secondSight']], '注册到 secondSight 命名空间')
  equal(await remote.remoteState('s1', 'p', 'm', 'high'), { echoed: ['state', 's1', 'p', 'm', 'high'] }, 'state 转发（扁平参数）')
  equal(await remote.remoteSet('s1', '', '', ''), { echoed: ['set', 's1', '', '', ''] }, 'set 转发（扁平参数）')
  const descriptor = remote.constructor.prototype['@deepseek-ai/dsh-typert-protocol/remote-methods']
  equal(descriptor.methods.map((method) => method.exportName), ['state', 'set'], '导出名')
  equal(descriptor.methods[0].invocation.kind, 'direct', '直接调用')
})

await check('state 报告纯文本模型、双胞胎可用、目录只列带 image 的模型', async () => {
  const host = createHost()
  const bag = { retryDelays: [] }

  apply(host.ctx, config(), bag)

  await bag.host.ready()
  const state = await bag.host.ops.state('s1', 'xhx2api', 'glm-5.3')
  equal(state.textOnly, true, '纯文本模型')
  equal(state.base, 'xhx2api', 'base')
  equal(state.onTwin, false, '还没在双胞胎上')
  equal(state.twin, TWIN, '双胞胎可用')
  equal(state.vision, null, '没有全局默认，没选就是 null')
  equal(state.options.map((group) => group.provider), ['xhx2api'], '只有 xhx2api 有视觉模型')
  equal(state.options[0].models.map((model) => model.id), ['sensenova-6.8-flash-lite'], '过滤掉纯文本模型')
  equal(state.options[0].models[0].efforts.map((effort) => effort.id), ['low', 'high'], '思考强度取自 resolveModelInfo')
})

await check('state 在双胞胎上时 onTwin=true，多模态模型 textOnly=false', async () => {
  const host = createHost()
  const bag = { retryDelays: [] }

  apply(host.ctx, config(), bag)

  await bag.host.ready()
  const twin = await bag.host.ops.state('s1', TWIN, 'glm-5.3')
  equal(twin.onTwin, true, 'onTwin')
  equal(twin.base, 'xhx2api', '剥掉后缀')
  equal(twin.textOnly, true, '基座仍是纯文本')
  const native = await bag.host.ops.state('s1', 'xhx2api', 'sensenova-6.8-flash-lite')
  equal(native.textOnly, false, '原生多模态')
})

await check('全局默认模型被写成双胞胎时改回基座', async () => {
  const host = createHost()
  const bag = { retryDelays: [] }

  apply(host.ctx, config(), bag)

  await bag.host.ready()
  // 宿主的 selectModel 会在切到双胞胎后把默认模型一起写成双胞胎
  host.defaultModel.current = { provider: TWIN, model: 'glm-5.3', reasoningEffort: 'high' }
  await bag.host.ops.state('s1', TWIN, 'glm-5.3')
  equal(host.defaultModel.saved.at(-1), { provider: 'xhx2api', model: 'glm-5.3', reasoningEffort: 'high' }, '改回基座，保留 model 与 effort')

  // 默认值本来就是基座时不要乱写（用户自己在设置里改的不能被覆盖）
  host.defaultModel.current = { provider: 'xhx2api', model: 'glm-5.3' }
  const before = host.defaultModel.saved.length
  await bag.host.ops.state('s1', 'xhx2api', 'glm-5.3')
  equal(host.defaultModel.saved.length, before, '不是双胞胎就不动')
})

await check('set 之后本会话改用面板选的副模型，ask_image 带上 reasoningEffort', async () => {
  const host = createHost()
  const bag = { retryDelays: [] }

  apply(host.ctx, config(), bag)

  await bag.host.ready()
  await drain(request(host, [{ role: 'user', content: [imageBlock('4'.repeat(64))] }]))
  const state = await bag.host.ops.set('s1', 'opencode-go', 'vis-x', 'high')
  equal(state.vision.provider, 'opencode-go', '会话覆盖 provider')
  equal(state.vision.model, 'vis-x', '会话覆盖 model')
  equal(state.vision.reasoningEffort, 'high', '会话覆盖 effort')
  equal(bag.host.pickFor('s1'), { provider: 'opencode-go', model: 'vis-x', reasoningEffort: 'high' }, 'pickFor')

  const result = await toolOf(host).definition.execute(
    { image: `img-${'4'.repeat(12)}`, question: '图里是什么？' },
    { signal: undefined, agent: { id: 's1' } },
  )
  ok(result.text.length > 0, '有答案')
  const vision = host.seen.streams.at(-1)
  equal([vision.provider, vision.model, vision.reasoningEffort], ['opencode-go', 'vis-x', 'high'], '视觉调用走会话覆盖')
})

await check('没选副眼时 ask_image 提示去面板里选，不调用视觉模型', async () => {
  const host = createHost()
  const bag = { retryDelays: [] }

  apply(host.ctx, config(), bag)

  await bag.host.ready()
  await drain(request(host, [{ role: 'user', content: [imageBlock('5'.repeat(64))] }]))
  const before = host.seen.streams.length
  const result = await toolOf(host).definition.execute(
    { image: `img-${'5'.repeat(12)}`, question: '读一下标题' },
    { agent: { id: 'other' } },
  )
  ok(result.text.includes('还没选副眼'), '提示去选副眼')
  equal(host.seen.streams.length, before, '没有打视觉模型')
})

await check('空 provider/model = 关掉副眼、回落配置默认', async () => {
  const host = createHost()
  const bag = { retryDelays: [] }

  apply(host.ctx, config(), bag)

  await bag.host.ready()
  await bag.host.ops.set('s1', 'opencode-go', 'vis-x')
  const back = await bag.host.ops.set('s1', '', '', '')
  equal(back.vision, null, '回落为未选择')
  equal(bag.host.pickFor('s1'), null, 'pickFor 为 null')
})

await check('主模型换成多模态 → 自动关掉这个会话的副眼', async () => {
  const host = createHost()
  const bag = { retryDelays: [] }

  apply(host.ctx, config(), bag)

  await bag.host.ready()
  await bag.host.ops.set('s1', 'xhx2api', 'sensenova-6.8-flash-lite')
  equal(bag.host.pickFor('s1')?.model, 'sensenova-6.8-flash-lite', '先开着')

  // 用户在模型列表里换到多模态主模型（xhx2api 的另一个模型）
  const after = await bag.host.ops.state('s1', 'xhx2api', 'sensenova-6.8-flash-lite')
  equal(after.textOnly, false, '主模型是多模态')
  equal(after.vision, null, '副眼被自动关掉')
  equal(bag.host.pickFor('s1'), null, 'Host 里也没了')

  // 再切回纯文本模型：不会「复活」上次的选择
  const back = await bag.host.ops.state('s1', 'xhx2api', 'glm-5.3')
  equal(back.textOnly, true, '纯文本模型')
  equal(back.vision, null, '不复活')
})

await check('主模型一直是多模态时不因 state 调用反复写/删覆盖', async () => {
  const host = createHost()
  const bag = { retryDelays: [] }

  apply(host.ctx, config(), bag)

  await bag.host.ready()
  const first = await bag.host.ops.state('s1', 'xhx2api', 'sensenova-6.8-flash-lite')
  const second = await bag.host.ops.state('s1', 'xhx2api', 'sensenova-6.8-flash-lite')
  equal(first.vision, null, '无副眼')
  equal(second.vision, null, '仍然无副眼')
  equal(bag.host.pickFor('s1'), null, 'pickFor 一直是 null')
})

await check('面板回带 providerName / modelName 供 UI 显示', async () => {
  const host = createHost()
  const bag = { retryDelays: [] }

  apply(host.ctx, config(), bag)

  await bag.host.ready()
  await bag.host.ops.set('s1', 'xhx2api', 'sensenova-6.8-flash-lite')
  const state = await bag.host.ops.state('s1', 'xhx2api', 'glm-5.3')

  equal(state.vision.providerName, 'xhx2api', 'providerName 兜底为 id')
  equal(state.vision.modelName, 'SenseNova 6.8 Flash Lite', 'modelName 来自目录')
  equal(state.options[0].models[0].efforts.map((effort) => effort.name), ['Low', 'High'], 'efforts 带名字')
})

await check('相同问题在不同副模型下不共用缓存', async () => {
  const host = createHost()
  const bag = { retryDelays: [] }

  apply(host.ctx, config(), bag)

  await bag.host.ready()
  await drain(request(host, [{ role: 'user', content: [imageBlock('3'.repeat(64))] }]))
  const handle = `img-${'3'.repeat(12)}`
  await toolOf(host).definition.execute({ image: handle, question: '标题？' }, { agent: { id: 'a' } })
  const before = host.seen.streams.length
  await bag.host.ops.set('a', 'opencode-go', 'vis-x')
  await toolOf(host).definition.execute({ image: handle, question: '标题？' }, { agent: { id: 'a' } })
  equal(host.seen.streams.length - before, 1, '换了副模型要重新问')
})


await check('只有存在纯文本模型的 provider 才挂双胞胎（多模态 provider 不挂）', async () => {
  const host = createHost({ providers: ['xhx2api', 'opencode-go'] })
  // opencode-go 的目录里只有多模态模型
  host.provider('opencode-go').listModels = async (provider) => [
    { provider, id: 'vision-only', name: 'Vision Only', inputModalities: ['text', 'image'] },
  ]
  const bag = { retryDelays: [] }
  apply(host.ctx, config(), bag)
  await bag.host.ready()
  const ids = host.llm.listProviders().map((entry) => entry.id).sort()
  equal(ids, ['opencode-go', 'xhx2api', 'xhx2api-second-sight'], '多模态 provider 不挂双胞胎')
})

await check('纯文本模型消失后，双胞胎连路由一起撤掉', async () => {
  const host = createHost({ providers: ['xhx2api'] })
  const bag = { retryDelays: [] }
  apply(host.ctx, config(), bag)
  await bag.host.ready()
  ok(host.provider(TWIN) !== undefined, '先有双胞胎')
  host.provider('xhx2api').listModels = async (provider) => [
    { provider, id: 'sensenova-6.8-flash-lite', name: 'SenseNova', inputModalities: ['text', 'image'] },
  ]
  host.emits('llm/adapters-updated')
  await bag.host.ready()
  equal(host.provider(TWIN), undefined, '没有纯文本模型了 → 撤销双胞胎')
})

await check('双胞胎的模型表包含全部模型（含多模态）', async () => {
  const host = createHost()
  const bag = { retryDelays: [] }
  apply(host.ctx, config(), bag)
  await bag.host.ready()
  const models = await host.llm.listModels(TWIN)
  // 0.5.0：用户推翻了「+副眼 只剩纯文本」，目录照抄基座（含多模态）；
  // 多模态模型在双胞胎上被选中时，副眼会被自动关掉、切回基座。
  equal(models.map((model) => model.id).sort(), ['glm-5.3', 'sensenova-6.8-flash-lite'], '目录与基座一致')
  equal(models.every((model) => model.provider === TWIN), true, 'provider 回写成双胞胎')
  equal(
    models.find((model) => model.id === 'sensenova-6.8-flash-lite').inputModalities.includes('image'),
    true,
    '多模态模型照样声明 image',
  )
})

await check('双胞胎上的多模态模型不投影图片（走原生附件）', async () => {
  const host = createHost()
  const bag = { retryDelays: [] }
  apply(host.ctx, config(), bag)
  await bag.host.ready()
  const digest = 'a'.repeat(64)
  const messages = [{ role: 'user', content: [imageBlock(digest)] }]
  const adapter = host.provider(TWIN)
  const stream = adapter.stream({ provider: TWIN, model: 'sensenova-6.8-flash-lite', messages })
  for await (const _chunk of stream) { /* 走完 */ }
  const forwarded = host.seen.streams.at(-1).messages
  equal(forwarded[0].content[0].type, 'image', '图片原样转发，没有换成句柄')
})

// —— boot 竞速回归：credentials 服务迟到 → 退避重试补注册（真宿主 0.4.0 图标消失的根因）——

await check('credentials 迟到（listModels 吞成空目录）→ 退避重试把双胞胎补上', async () => {
  const host = createHost({ providers: ['xhx2api'] })
  let settled = false
  host.provider('xhx2api').listModels = async (provider) =>
    settled
      ? [{ provider, id: 'glm-5.3', name: 'GLM 5.3', inputModalities: ['text'] }]
      : [] // pi-ai 在 MISSING_CREDENTIAL 时静默回 []
  const bag = { retryDelays: [5, 10] }
  apply(host.ctx, config(), bag)
  await bag.host.ready()
  equal(host.provider(TWIN), undefined, '初始 reconcile 撞上空目录，没注册双胞胎')
  settled = true // credentials 服务挂上了，目录能拉出来了
  await waitFor(() => host.provider(TWIN) !== undefined)
  equal(host.llm.listProviders().map((entry) => entry.id).sort(), ['xhx2api', TWIN], '重试后双胞胎在册')
})

await check('重试达上限就放弃，不再无限循环', async () => {
  const host = createHost({ providers: ['xhx2api'] })
  let pulls = 0
  host.provider('xhx2api').listModels = async (provider) => {
    pulls += 1
    return []
  }
  const bag = { retryDelays: [5] }
  apply(host.ctx, config(), bag)
  await bag.host.ready()
  await new Promise((resolve) => setTimeout(resolve, 40))
  equal(pulls, 2, '初始一次 + 重试一次，之后放弃（不无限拉目录）')
})

await check('credentials 已挂上且目录为空（合法的全多模态 provider）→ 不安排重试', async () => {
  const host = createHost({
    providers: ['opencode-go'],
    credentials: { resolve: async () => ({ value: 'k'.repeat(16), source: 'file' }) },
  })
  let pulls = 0
  host.provider('opencode-go').listModels = async (provider) => {
    pulls += 1
    return [{ provider, id: 'vision-only', name: 'Vision Only', inputModalities: ['text', 'image'] }]
  }
  const bag = { retryDelays: [5] }
  apply(host.ctx, config(), bag)
  await bag.host.ready()
  await new Promise((resolve) => setTimeout(resolve, 30))
  equal(pulls, 1, '空目录是合法终态（credentials 在），不该重试')
})
process.stdout.write('\n句柄\n')

await check('handleOf 稳定、截断到指定长度、无 id 时返回空串', async () => {
  const ref = { attachmentId: `sha256:${'AB12'.repeat(16)}` }
  equal(handleOf(ref), 'img-AB12AB12AB12', '默认 12 位')
  equal(handleOf(ref, 8), 'img-AB12AB12', '8 位')
  equal(handleOf({ attachmentId: 'sha256:zz' }), 'img-zz', '非 hex 也给出稳定值')
  equal(handleOf({}), '', '无 id')
  equal(handleOf(undefined), '', 'undefined')
})

// —— 汇总 ——

process.stdout.write(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) {
  process.stdout.write(`\n失败详情：\n${failures.map((item) => `- ${item}`).join('\n')}\n`)
  process.exitCode = 1
}
