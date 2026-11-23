/**
 * host-integration.mjs —— 拿**真实的宿主实现**跑一遍契约。
 *
 * smoke.mjs 用的是契约精确的假宿主，会随契约一起漂移；这里直接 import 本机
 * 安装的 DSH 内部包（cordis + dsh-llm 的 LlmRuntime + dsh-tools 的 ToolsService），
 * 让真实的 registerAdapter / listModels / resolveModelInfo / tools.resolve 去校验
 * 我们的鸭子类型适配器与工具定义。找不到 DSH 安装时自动跳过（退出码 0）。
 *
 * 运行：node test/host-integration.mjs
 * 覆盖安装路径：DSH_SECOND_SIGHT_DSH=<...>/@deepseek-ai
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import * as plugin from '../index.js'

const SUFFIX = '-second-sight'
const BASE = 'fakebase'
const TWIN = `${BASE}${SUFFIX}`

let passed = 0
let failed = 0

async function check(title, run) {
  try {
    await run()
    passed += 1
    process.stdout.write(`  ok  ${title}\n`)
  } catch (error) {
    failed += 1
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

const CANDIDATES = [
  process.env.DSH_SECOND_SIGHT_DSH,
  'C:/Users/win10/AppData/Local/Author Software/nvm/installs/v26.10.0/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai',
  join(process.env.APPDATA ?? '', 'npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'),
].filter((path) => typeof path === 'string' && path !== '')

const internals = CANDIDATES.find((path) => existsSync(join(path, 'dsh-llm/lib/index.js')))

if (internals === undefined) {
  process.stdout.write('\nhost-integration: 未找到 DSH 安装，跳过（设置 DSH_SECOND_SIGHT_DSH 指向 @deepseek-ai 目录可强制运行）\n')
  process.exit(0)
}

const ROOT = pathToFileURL(internals).href
const { Context } = await import(`${ROOT}/cordis/lib/index.js`)
const { LlmRuntime } = await import(`${ROOT}/dsh-llm/lib/index.js`)
const { ToolsService } = await import(`${ROOT}/dsh-tools/lib/index.js`)

process.stdout.write(`\nhost-integration: 使用 ${internals}\n\n启动真实宿主\n`)

const TEXT_MODEL = {
  id: 'text-model',
  name: 'Text Model',
  inputModalities: ['text'],
  context: { contextWindow: 1000 },
  defaultMaxTokens: 100,
}

const VIS_MODEL = {
  id: 'vis-model',
  name: 'Vision Model',
  inputModalities: ['text', 'image'],
  context: { contextWindow: 2000 },
  defaultMaxTokens: 200,
}

const seen = []

/** 冒充 pi-ai 适配器：只记下收到的请求，回固定内容。 */
class BaseAdapter {
  constructor() {
    this.models = new Map([TEXT_MODEL, VIS_MODEL].map((model) => [model.id, model]))
  }

  providerInfo(provider) {
    return { id: provider, name: `fake ${provider}` }
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
    return [...this.models.values()].map((model) => ({ ...model, provider }))
  }

  async resolveModel(provider, model) {
    const found = this.models.get(model)
    if (found === undefined) throw new Error(`UNKNOWN_MODEL ${model}`)
    return { ...found, provider }
  }

  async prepareCall(provider, model) {
    return { model: await this.resolveModel(provider, model), stream: (options) => this.stream(options) }
  }

  async *stream(options) {
    seen.push(options)
    yield { type: 'text-delta', index: 0, text: 'ok' }
    // 故意带 replayState：双胞胎必须剥掉（ADR-6）
    yield { type: 'finish', reason: { kind: 'stop' }, replayState: { adapter: 'fake' } }
  }
}

const ctx = new Context()
await ctx.plugin(LlmRuntime)
ctx.provide('systemPrompt', { tools: () => () => {} })
await ctx.plugin(ToolsService)

const baseHandle = ctx.llm.registerAdapter([BASE], new BaseAdapter())
equal(ctx.llm.listProviders().map((entry) => entry.id), [BASE], '基座就绪')

const config = {
  vision: { provider: BASE, model: 'vis-model', maxTokens: 512 },
  questions: { maxPerImage: 4, historyTurns: 2 },
  tool: { visibility: 'twin' },
}

// 走一遍真实的 cordis 加载路径，同时拿内部把手（面板写覆盖要用）
const bag = { retryDelays: [] }
const fiber = await ctx.plugin({ name: plugin.name, inject: plugin.inject, apply: (c, cfg) => plugin.apply(c, cfg, bag) }, config)

const agent = { id: 'integration-agent' }
const signal = new AbortController().signal
const definition = () => {
  const found = ctx.tools.definitions(agent).find((entry) => entry.name === 'ask_image')
  if (found === undefined) throw new Error('ask_image 不在 definitions 里')
  return found
}

await check('真实 LlmRuntime 接受双胞胎注册', async () => {
  equal(ctx.llm.listProviders().map((entry) => entry.id).sort(), [BASE, TWIN].sort(), 'provider 列表')
})

await check('真实 LlmRuntime.listModels 通过 INVALID_CATALOG 校验并补 image', async () => {
  const models = await ctx.llm.listModels(TWIN)
  // 0.5.0 起目录照抄基座：多模态模型也在，选中后靠自动关副眼兜底。
  equal(models.map((model) => model.id), ['text-model', 'vis-model'], '目录与基座一致')
  equal(models.map((model) => model.provider), [TWIN, TWIN], 'provider 回写（参考实现在这里会炸）')
  equal(models[0].inputModalities, ['text', 'image'], '纯文本模型声明可看图')
})

await check('真实 resolveModelInfo 通过 normalizeModelInfo 校验', async () => {
  const info = await ctx.llm.resolveModelInfo(TWIN, 'text-model')
  equal(info.provider, TWIN, 'provider')
  equal(info.id, 'text-model', 'id')
  equal(info.name, 'Text Model', 'name')
  equal(info.defaultMaxTokens, 100, 'defaultMaxTokens 继承')
})

await check('真实 stream：图片被换成句柄、replayState 被剥掉、内层回落到基座', async () => {
  const content = [
    { type: 'text', text: '看图' },
    {
      type: 'image',
      attachment: { attachmentId: `sha256:${'ab'.repeat(32)}`, mediaType: 'image/png', bytes: 64, width: 4, height: 4 },
    },
  ]
  const chunks = []
  for await (const chunk of ctx.llm.stream({ provider: TWIN, model: 'text-model', messages: [{ role: 'user', content }] })) {
    chunks.push(chunk)
  }
  equal(chunks.map((chunk) => chunk.type), ['text-delta', 'finish'], 'chunk 序列')
  ok(!('replayState' in chunks.at(-1)), 'replayState 已剥离')

  const forwarded = seen.at(-1)
  equal(forwarded.provider, BASE, '内层 provider')
  const projected = forwarded.messages[0].content
  equal(projected.map((block) => block.type), ['text', 'text'], '没有 image 块漏到基座')
  ok(projected[1].text.includes(`img-${'ab'.repeat(6)}`), '句柄 = sha256 前 12 位')
  ok(!JSON.stringify(forwarded.messages).includes('sha256:'), '不转写附件')
})

await check('真实 ToolsService：双胞胎会话可见 ask_image，基座会话不可见', async () => {
  const twinSet = await ctx.tools.resolve({ agent, modelSelection: { provider: TWIN, model: 'text-model' }, signal })
  ok([...twinSet.view(agent).keys()].includes('ask_image'), '双胞胎可见')
  twinSet.dispose()

  const plainSet = await ctx.tools.resolve({ agent, modelSelection: { provider: BASE, model: 'text-model' }, signal })
  ok(![...plainSet.view(agent).keys()].includes('ask_image'), '基座不可见')
  plainSet.dispose()
})

await check('真实定义 + execute：句柄能换回附件并问到答案', async () => {
  const hex = 'cd'.repeat(32)
  for await (const _chunk of ctx.llm.stream({
    provider: TWIN,
    model: 'text-model',
    messages: [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: `sha256:${hex}`, mediaType: 'image/png', bytes: 8, width: 2, height: 2 } }] }],
  })) {
    // 只为让双胞胎记下句柄
  }
  const handle = `img-${hex.slice(0, 12)}`
  // 没有全局默认：先在这个会话的副眼面板里选一个副模型
  await bag.host.ops.set(agent.id, BASE, 'vis-model')
  const result = await definition().execute({ image: handle, question: '图里有什么？', detail: 'gist' }, { signal, agent })
  equal(typeof result.text, 'string', '返回文本')
  ok(result.text.length > 0, '答案非空')

  const vision = seen.at(-1)
  equal(vision.provider, BASE, 'vision provider')
  equal(vision.model, 'vis-model', 'vision model')
  equal(vision.maxTokens, 512, 'maxTokens')
  equal(vision.messages[0].content.map((block) => block.type), ['image', 'text'], '图片在前')
  ok(vision.messages[0].content[1].text.includes('at most two sentences'), 'gist')
})

await check('真实定义满足 host 的 schema/render 校验', async () => {
  const found = definition()
  equal(typeof found.output.render, 'function', 'render')
  ok(Array.isArray(found.presentCall) === false, 'presentCall 不进模型面 schema')
})

await check('撤销 fiber 后双胞胎与工具一起消失', async () => {
  await fiber.dispose()
  equal(ctx.llm.listProviders().map((entry) => entry.id), [BASE], '只剩基座')
  equal(ctx.tools.definitions(agent).filter((entry) => entry.name === 'ask_image').length, 0, '工具已注销')
})

baseHandle()
await ctx.fiber.dispose()

process.stdout.write(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exitCode = 1
