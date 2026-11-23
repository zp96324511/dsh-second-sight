/**
 * gateway-mount.mjs —— 用**真实的** Typert 网关客户端校验 client.js 的贡献。
 *
 * 这条测试是 0.3.0 那次线上故障的回归防线：网关在挂载贡献时对**每个参数**跑
 * `requireStrictCodec`，只认 `codec.mode === 'strict'`；`src-json` 会被当场拒掉：
 *
 *   client api: generated Remote secondSight/state field "sessionId" has no strict codec
 *
 * 离线假宿主看不出这个问题（它只检查形状），所以这里直接拉起
 * `@deepseek-ai/cordis` + `dsh-typert-registry` + `dsh-api-gateway/lib/client.node.js`，
 * 让网关自己的 `validateContribution` / `installNamespace` 把贡献装一遍。
 * 只有传输层（WebSocket）是假的——校验发生在它之前。
 *
 * 运行：node test/gateway-mount.mjs
 * 覆盖安装路径：DSH_SECOND_SIGHT_DSH=<...>/@deepseek-ai
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

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

const DSH = CANDIDATES.find((path) => existsSync(join(path, 'dsh-api-gateway/lib/client.node.js')))

if (DSH === undefined) {
  process.stdout.write('\ngateway-mount: 未找到 DSH 安装，跳过（设置 DSH_SECOND_SIGHT_DSH 指向 @deepseek-ai 目录可强制运行）\n')
  process.exit(0)
}

const ROOT = pathToFileURL(DSH).href
const { Context } = await import(`${ROOT}/cordis/lib/index.js`)
const { TypertRegistry } = await import(`${ROOT}/dsh-typert-registry/lib/index.js`)
const gateway = await import(`${ROOT}/dsh-api-gateway/lib/client.node.js`)

process.stdout.write(`\ngateway-mount: 使用 ${DSH}\n\n真实网关挂载\n`)

// 浏览器 bundle 入口：把 window.__ModuleLoader__ 换成收集器。
const loaded = {}
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      loaded.id = definition.id
      loaded.factory = definition.factory
    },
  },
}
await import(pathToFileURL(fileURLToPath(new URL('../client.js', import.meta.url))).href)

/** 够 client.js 渲染用的 React 桩（这里只关心 apply 阶段）。 */
const React = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
  useEffect: () => {},
  useMemo: (factory) => factory(),
  useCallback: (fn) => fn,
  useRef: (value) => ({ current: value }),
  useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
  Fragment: 'Fragment',
}

function createGateway() {
  const ctx = new Context()
  // 传输层是假的：网关的校验发生在 openWebSocket 之前。
  ctx.provide('connection', {
    interactions: 'none',
    rpc: { open: undefined, call: async () => ({ ok: false, error: { code: 'probe' } }) },
    openWebSocket() {
      throw new Error('probe: 传输层不该被调用')
    },
    start() {
      return { stop() {} }
    },
  })
  return ctx
}

function createPluginCtx(ctx, sink) {
  const warnings = []
  const pluginCtx = {
    remote: {
      async $mount(contribution) {
        sink.contribution = contribution
        return ctx.remote.$mount(contribution)
      },
    },
    get: (key) => ctx.get(key),
    locale: { register() {}, bind: () => undefined },
    modelDirectories: { directoryFor: () => undefined },
    slots: {
      inject(name, factory) {
        sink.slot = name
        factory()
      },
      register(options) {
        sink.registration = options
        return () => {}
      },
    },
    logger: { warn: (...args) => warnings.push(args.join(' ')), info() {} },
  }
  return { pluginCtx, warnings }
}

async function mountPlugin() {
  const ctx = createGateway()
  await ctx.plugin(TypertRegistry)
  await ctx.plugin({ inject: ['typert', 'connection'], apply: gateway.apply })
  const sink = {}
  const { pluginCtx, warnings } = createPluginCtx(ctx, sink)
  const plugin = loaded.factory((name) => {
    if (name === 'react') return React
    if (name === 'react-dom') return { createPortal: (children) => children }
    throw new Error(`客户端不该 require("${name}")`)
  })
  await plugin.apply(pluginCtx)
  return { ctx, sink, warnings }
}

const mounted = await mountPlugin()

await check('client.js 是 __ModuleLoader__ 模块', async () => {
  equal(loaded.id, 'dsh-second-sight', 'id')
  ok(typeof loaded.factory === 'function', 'factory')
})

await check('真实网关接受贡献（曾经在这里报 "has no strict codec"）', async () => {
  ok(mounted.sink.contribution !== undefined, '贡献被 $mount 收到')
  equal(mounted.warnings, [], `不该有警告：${mounted.warnings.join(' | ')}`)
})

await check('命名空间服务真的挂上了，且能按方法名取到', async () => {
  const service = mounted.ctx.get('remote.secondSight')
  ok(service !== undefined, 'remote.secondSight 存在')
  ok(typeof service.state === 'function', 'state 方法')
  ok(typeof service.set === 'function', 'set 方法')
})

await check('描述符进了 Typert 的远端登记表', async () => {
  const endpoints = mounted.ctx.typert.remotes
    .list()
    .map((descriptor) => `${descriptor.namespace}/${descriptor.method}`)
    .sort()
  equal(endpoints, ['secondSight/set', 'secondSight/state'], '登记表')
})

await check('参数都带 strict codec 且 typeSymbol 唯一', async () => {
  const { descriptors } = mounted.sink.contribution
  const symbols = []
  for (const descriptor of descriptors) {
    for (const parameter of descriptor.parameters) {
      equal(parameter.codec.mode, 'strict', `${descriptor.method}.${parameter.wire} codec`)
      equal(parameter.codec.typeSymbol, parameter.strictCodec.typeSymbol, `${parameter.wire} 两处 typeSymbol 一致`)
      symbols.push(parameter.codec.typeSymbol)
    }
    equal(descriptor.result.mode, 'strict', `${descriptor.method} result`)
  }
  equal(new Set(symbols).size < symbols.length, true, '同义参数共用 typeSymbol（provider/model 各出现两次）')
})

await check('可选参数声明了 acceptsUndefined，必填参数没有', async () => {
  const state = mounted.sink.contribution.descriptors.find((descriptor) => descriptor.method === 'state')
  const set = mounted.sink.contribution.descriptors.find((descriptor) => descriptor.method === 'set')
  equal(state.parameters.map((parameter) => parameter.acceptsUndefined ?? false), [false, false, false], 'state 全必填')
  equal(set.parameters.map((parameter) => parameter.acceptsUndefined ?? false), [false, true, true, true], 'set 后三个可选')
})

await check('座位仍然注册在 conversation.input.right', async () => {
  equal(mounted.sink.slot, 'conversation.input.right', '座位名')
  equal(mounted.sink.registration?.id, 'second-sight', '座位 id')
})

await check('卸载后登记表一起清空', async () => {
  const typert = mounted.ctx.typert
  await mounted.ctx.fiber.dispose()
  equal(typert.remotes.list().length, 0, '登记表已空')
})

process.stdout.write(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exitCode = 1
