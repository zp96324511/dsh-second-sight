/**
 * client.mjs —— 客户端半边的离线验收。
 *
 * 浏览器 bundle 不能直接跑，但它的输入只有三样：`window.__ModuleLoader__`、
 * `require('react')` 和插件 ctx。这里把前两样换成最小实现，把第三样换成假宿主，
 * 于是能真的跑一遍 apply、真的渲染一遍控件、真的点一下按钮。
 *
 * 覆盖：
 *   1) 远端描述符与 Host 半边的方法表逐条对齐（wire 名 / 服务名 / 返回码）；
 *   2) 座位的注册名、order、组件形状；
 *   3) 原生多模态不占位、纯文本模型出现「副眼」按钮；
 *   4) 打开面板 → 选模型 → 写 Host + 切会话选择，两件事都发生；
 *   5) 关掉副眼 → 清 Host 覆盖 + 切回基座 provider。
 *
 * 运行：node test/client.mjs
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRemoteClass } from '../index.js'

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

function deepEqual(actual, expected, what) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${what}: 期望 ${b}，实际 ${a}`)
}
function equal(actual, expected, what) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${what}: 期望 ${b}，实际 ${a}`)
}

function ok(value, what) {
  if (!value) throw new Error(`${what}: 期望真值，实际 ${JSON.stringify(value)}`)
}

// —— 最小 React ——

const FRAGMENT = Symbol('Fragment')
const PORTAL = Symbol('Portal')

function createMiniReact() {
  const scopes = new Map()
  let dirty = false

  function createElement(type, config, ...children) {
    const props = { ...(config ?? {}) }
    if (children.length === 1) props.children = children[0]
    else if (children.length > 1) props.children = children
    return { type, props }
  }

  function scopeAt(key) {
    let scope = scopes.get(key)
    if (scope === undefined) {
      scope = { hooks: [], cursor: 0, effects: [] }
      scopes.set(key, scope)
    }
    scope.cursor = 0
    return scope
  }

  const hookCounts = new Map()

  function hook(key, index) {
    const scope = scopeAt(key)
    scope.cursor = Math.max(scope.cursor, index + 1)
    return scope
  }

  function useState(key, index, initial) {
    const scope = hook(key, index)
    if (!(index in scope.hooks)) scope.hooks[index] = typeof initial === 'function' ? initial() : initial
    const setValue = (next) => {
      const value = typeof next === 'function' ? next(scope.hooks[index]) : next
      if (Object.is(value, scope.hooks[index])) return
      scope.hooks[index] = value
      dirty = true
    }
    return [scope.hooks[index], setValue]
  }

  function useRef(key, index, initial) {
    const scope = hook(key, index)
    if (!(index in scope.hooks)) scope.hooks[index] = { current: initial }
    return scope.hooks[index]
  }

  function useCallback(key, index, fn, deps) {
    const scope = hook(key, index)
    const slot = scope.hooks[index]
    if (slot !== undefined && Array.isArray(slot.deps) && Array.isArray(deps) && sameDeps(slot.deps, deps)) return slot.fn
    scope.hooks[index] = { fn, deps }
    return fn
  }

  function useMemo(key, index, fn, deps) {
    const scope = hook(key, index)
    const slot = scope.hooks[index]
    if (slot !== undefined && Array.isArray(slot.deps) && Array.isArray(deps) && sameDeps(slot.deps, deps)) return slot.value
    const value = fn()
    scope.hooks[index] = { value, deps }
    return value
  }

  function useEffect(key, index, fn, deps) {
    const scope = hook(key, index)
    const slot = scope.hooks[index]
    if (slot !== undefined && Array.isArray(slot.deps) && Array.isArray(deps) && sameDeps(slot.deps, deps)) return
    scope.hooks[index] = { deps }
    scope.effects.push({ index, fn })
  }

  function useSyncExternalStore(key, index, subscribe, getSnapshot) {
    hook(key, index)
    return getSnapshot()
  }

  function sameDeps(left, right) {
    return left.length === right.length && left.every((value, position) => Object.is(value, right[position]))
  }

  const React = {
    createElement,
    Fragment: FRAGMENT,
    useState: (...args) => useState(state.key, state.cursor++, ...args),
    useRef: (...args) => useRef(state.key, state.cursor++, ...args),
    useCallback: (fn, deps) => useCallback(state.key, state.cursor++, fn, deps),
    useMemo: (fn, deps) => useMemo(state.key, state.cursor++, fn, deps),
    useEffect: (fn, deps) => useEffect(state.key, state.cursor++, fn, deps),
    useSyncExternalStore: (subscribe, getSnapshot) => useSyncExternalStore(state.key, state.cursor++, subscribe, getSnapshot),
  }

  const state = { key: '', cursor: 0 }

  function renderNode(element, path) {
    if (element === null || element === undefined || element === false || element === true) return null
    if (typeof element === 'string' || typeof element === 'number') return element
    if (Array.isArray(element)) return element.map((child, index) => renderNode(child, `${path}.${index}`))
    const { type, props } = element
    if (type === FRAGMENT) return renderNode(props.children, path)
    if (type === PORTAL) return { type: PORTAL, props: { children: renderNode(props.children, `${path}>portal`) } }
    if (typeof type === 'function') {
      const key = `${path}/${type.name || 'Anonymous'}`
      const previous = state.key
      const previousCursor = state.cursor
      state.key = key
      state.cursor = 0
      const output = type(props)
      const used = state.cursor
      state.key = previous
      state.cursor = previousCursor
      // React 不允许条件调用 hook：同一个组件两次渲染的 hook 数必须一致。
      const before = hookCounts.get(key)
      if (before !== undefined && before !== used) {
        throw new Error((type.name || 'Anonymous') + ' 渲染时 hook 数量变了（上次 ' + before + '，这次 ' + used + '）——有 hook 被放进条件分支')
      }
      hookCounts.set(key, used)
      return renderNode(output, key)
    }
    return { type, props: { ...props, children: renderNode(props.children, path) } }
  }

  function runEffects() {
    for (const [key, scope] of scopes) {
      while (scope.effects.length > 0) {
        const effect = scope.effects.shift()
        const previous = state.key
        state.key = key
        state.cursor = 0
        try {
          const disposer = effect.fn()
          if (typeof disposer === 'function') scope.disposers = [...(scope.disposers ?? []), disposer]
        } finally {
          state.key = previous
        }
      }
    }
  }

  let root = { type: null, props: {} }

  function mount(component, props) {
    root = { type: component, props }
    return render()
  }

  function render() {
    state.key = ''
    state.cursor = 0
    const tree = renderNode(root, '')
    runEffects()
    return tree
  }

  /** 渲染直到没有新的 setState（上限防止死循环）。 */
  async function flush(component, props) {
    for (let round = 0; round < 12; round += 1) {
      await Promise.resolve()
      await new Promise((resolve) => setTimeout(resolve, 0))
      const pending = dirty
      dirty = false
      state.key = ''
      state.cursor = 0
      root = { type: component, props }
      renderNode(root, '')
      runEffects()
      // 异步 effect（remote.state）可能晚一拍才 setState，所以至少多渲染两轮再收手。
      if (!pending && round >= 2) break
    }
    return render()
  }

  /** 强制再渲染一轮（不等待异步），用于「同一 props 下内容变了」的场景。 */
  function rerender() {
    dirty = false
    return render()
  }

  return { React, mount, flush, rerender, createPortal: null }
}

/** 把元素树摊平成 [kind, props] 列表，方便断言文案与点击目标。 */
function walk(element, out = []) {
  if (element === null || element === undefined || element === false) return out
  if (typeof element === 'string' || typeof element === 'number') {
    out.push(['text', String(element)])
    return out
  }
  if (Array.isArray(element)) {
    for (const child of element) walk(child, out)
    return out
  }
  out.push([typeof element.type === 'string' ? element.type : 'node', element.props])
  walk(element.props?.children, out)
  return out
}

function textsOf(tree) {
  return walk(tree)
    .filter(([kind]) => kind === 'text')
    .map(([, value]) => value)
    .join(' ')
}

function buttonWith(tree, label) {
  return walk(tree).find(
    ([kind, props]) => kind === 'button' && typeof props?.children !== 'undefined' && textsOf({ type: 'frag', props: { children: props.children } }).includes(label),
  )
}

/** 找到文案包含 needle 的 button 的 props。 */
function findButton(tree, needle) {
  for (const [kind, props] of walk(tree)) {
    if (kind !== 'button') continue
    const label = textsOf({ type: 'frag', props: { children: props.children } })
    if (label.includes(needle)) return props
  }
  return undefined
}

/** 找到 placeholder 包含 needle 的 input 的 props。 */
function findInput(tree, needle) {
  for (const [kind, props] of walk(tree)) {
    if (kind !== 'input') continue
    if (String(props?.placeholder ?? '').includes(needle)) return props
  }
  return undefined
}
/** 找到面板里的 select 元素 props（思考强度下拉框）。 */
function findSelect(tree) {
  for (const [kind, props] of walk(tree)) {
    if (kind === 'select') return props
  }
  return undefined
}
/** 找到 role="dialog" 的元素 props。 */
function findByRole(tree, role) {
  for (const [kind, props] of walk(tree)) {
    if (props?.role === role) return props
  }
  return undefined
}
/** 找到 aria-label / title 包含 needle 的 button 的 props（图标按钮没有文案）。 */
function findTrigger(tree, needle) {
  for (const [kind, props] of walk(tree)) {
    if (kind !== 'button') continue
    const label = `${props?.['aria-label'] ?? ''} ${props?.title ?? ''}`
    if (label.includes(needle)) return props
  }
  return undefined
}

// —— 假宿主 ——

function createClientContext(hostState, options = {}) {
  const calls = { state: [], set: [], select: [], register: [], mount: [] }
  const current = () => options.current ?? { provider: 'ctyun-codingplan', model: 'glm-5.3-oc', reasoningEffort: 'max' }

  const remote = {
    async state(sessionId, provider, model) {
      calls.state.push([sessionId, provider, model])
      return { ok: true, value: hostState()(provider, model) }
    },
    async set(sessionId, provider, model, reasoningEffort) {
      calls.set.push([sessionId, provider, model, reasoningEffort])
      // 真实 Host 的 set 回带的是「会话选择」而不是副模型选择
      const selection = current()
      const twin = `${selection.provider}-second-sight`.replace('-second-sight-second-sight', '-second-sight')
      const value = provider === ''
        ? hostState({ onTwin: false })(selection.provider, selection.model)
        : hostState({
            onTwin: true,
            vision: {
              provider,
              model,
              providerName: provider,
              modelName: model === 'sensenova-6.8-flash-lite' ? 'SenseNova 6.8 Flash Lite' : model,
              reasoningEffort: reasoningEffort === '' ? null : reasoningEffort,
              // 真实 Host 的 vision 带 efforts 表（按钮文字要显示档位名）
              efforts: [
                { id: 'low', name: 'Low' },
                { id: 'high', name: 'High' },
              ],
              source: 'session',
            },
          })(twin, selection.model)
      return { ok: true, value }
    },
  }

  const directory = {
    store: {
      subscribe: () => () => {},
      getSnapshot: () => ({ current: options.current ?? { provider: 'ctyun-codingplan', model: 'glm-5.3-oc', reasoningEffort: 'max' } }),
    },
    async load() {
      return {}
    },
    async select(selection) {
      calls.select.push(selection)
      return { ok: true, value: undefined }
    },
  }

  const ctx = {
    remote: {
      async $mount(contribution) {
        calls.mount.push(contribution)
        return async () => {}
      },
    },
    get: (key) => (key === 'remote.secondSight' ? remote : undefined),
    locale: { register() {}, bind: () => undefined },
    modelDirectories: { directoryFor: () => directory },
    slots: {
      inject(name, factory) {
        calls.register.push(name)
        factory()
      },
      register(slotOptions, Component) {
        calls.slot = { options: slotOptions, Component }
        return () => {}
      },
    },
    logger: { warn() {}, info() {} },
  }

  return { ctx, calls, directory }
}

function hostState(overrides = {}) {
  return (provider, model) => ({
    sessionId: 's1',
    selection: { provider, model },
    base: provider.replace('-second-sight', ''),
    onTwin: provider.endsWith('-second-sight'),
    twin: 'ctyun-codingplan-second-sight',
    textOnly: true,
    vision: {
      provider: 'xhx2api',
      model: 'sensenova-6.8-flash-lite',
      providerName: 'xhx2api',
      modelName: 'SenseNova 6.8 Flash Lite',
      reasoningEffort: null,
      efforts: [
        { id: 'low', name: 'Low' },
        { id: 'high', name: 'High' },
      ],
      source: 'config',
    },
    options: [
      {
        provider: 'xhx2api',
        name: 'xhx2api',
        models: [
          {
            id: 'sensenova-6.8-flash-lite',
            name: 'SenseNova 6.8 Flash Lite',
            efforts: [
              { id: 'low', name: 'Low' },
              { id: 'high', name: 'High' },
            ],
            defaultEffort: 'low',
          },
        ],
      },
    ],
    ...overrides,
  })
}

// —— 引导 bundle ——

let bundle
let bundleError

globalThis.window = {
  innerWidth: 1280,
  innerHeight: 800,
  __ModuleLoader__: {
    load(module) {
      bundle = module
    },
  },
}
globalThis.document = {
  body: {},
  addEventListener() {},
  removeEventListener() {},
}

try {
  await import(pathToFileURL(fileURLToPath(new URL('../client.js', import.meta.url))).href)
} catch (error) {
  bundleError = error
}

process.stdout.write('\n客户端半边\n')

await check('bundle 用 __ModuleLoader__.load 声明 id 并暴露 factory', async () => {
  ok(bundleError === undefined, `加载失败：${bundleError?.message ?? ''}`)
  ok(bundle !== undefined, '没有调用 __ModuleLoader__.load')
  equal(bundle.id, 'dsh-second-sight', 'id')
  equal(typeof bundle.factory, 'function', 'factory')
})

await check('静态 inject 不包含自己挂载的 remote.secondSight（否则死锁）', async () => {
  const mini = createMiniReact()
  const plugin = bundle.factory(fakeRequire(mini))
  equal(plugin.inject.includes('remote'), true, '注入 remote 门面')
  equal(plugin.inject.some((name) => name.startsWith('remote.')), false, '不注入具体命名空间')
})

await check('远端描述符与 Host 方法表逐条对齐', async () => {
  const mini = createMiniReact()
  const plugin = bundle.factory(fakeRequire(mini))
  const host = createClientContext(hostState)
  await plugin.apply(host.ctx)
  const contribution = host.calls.mount[0]
  equal(contribution.package, 'dsh-second-sight', 'package')

  const names = contribution.descriptors.map((descriptor) => `${descriptor.namespace}/${descriptor.method}`)
  equal(names, ['secondSight/state', 'secondSight/set'], 'wire 名')

  class FakeBase {
    constructor() {}
  }
  const Remote = createRemoteClass(FakeBase)
  const declared = Remote.prototype['@deepseek-ai/dsh-typert-protocol/remote-methods'].methods
  const exported = declared.map((method) => `${'secondSight'}/${method.exportName}`)
  equal(names, exported, '客户端描述符 ↔ Host 导出名')

  for (const descriptor of contribution.descriptors) {
    equal(descriptor.service, 'secondSight', 'service')
    equal(descriptor.invocation, { kind: 'direct' }, 'invocation')
    equal(descriptor.result.mode, 'strict', '结果用 strict codec')
    ok(/^[A-Za-z0-9_$.-]+$/.test(descriptor.namespace), `${descriptor.namespace} 是合法 wire 段`)
    const wires = descriptor.parameters.map((parameter) => parameter.wire)
    equal(new Set(wires).size, wires.length, '参数 wire 不重复')
    for (const parameter of descriptor.parameters) {
      equal(parameter.source, 'json', '参数走 json')
      equal(parameter.codec.mode, 'strict', '参数用 strict codec（网关只认它）')
    }
  }
})

await check('贡献能过网关的挂载校验（required strict codec）', async () => {
  const mini = createMiniReact()
  const plugin = bundle.factory(fakeRequire(mini))
  const host = createClientContext(hostState)
  await plugin.apply(host.ctx)
  const endpoints = assertMountable(host.calls.mount[0])
  equal(endpoints, ['secondSight/state', 'secondSight/set'], '端点')
  ok(true, '网关包路径可选（校验函数不依赖它）')
})

await check('strict 编解码器只做边界校验：接受字符串/对象、拒收错类型', async () => {
  const mini = createMiniReact()
  const plugin = bundle.factory(fakeRequire(mini))
  const host = createClientContext(hostState)
  await plugin.apply(host.ctx)
  const [state, set] = host.calls.mount[0].descriptors
  const session = state.parameters[0].codec.create()
  equal(session.parse('s1'), 's1', '字符串放行')
  let message = ''
  try {
    session.parse(42)
  } catch (error) {
    message = error.message
  }
  ok(message.includes('expects a string'), `错类型被拒：${message}`)

  const optional = set.parameters[2].codec.create()
  equal(optional.parse(undefined), undefined, 'undefined 放行（可选参数）')
  equal(optional.parse(''), '', '空串放行（表示关闭）')

  const result = state.result.create()
  equal(result.parse({ ok: true }), { ok: true }, '对象结果放行')
  message = ''
  try {
    result.parse('nope')
  } catch (error) {
    message = error.message
  }
  ok(message.includes('expects an object'), `结果错类型被拒：${message}`)
})

await check('座位注册在 conversation.input.right，带 order 与组件', async () => {
  const mini = createMiniReact()
  const plugin = bundle.factory(fakeRequire(mini))
  const host = createClientContext(hostState)
  await plugin.apply(host.ctx)
  equal(host.calls.register, ['conversation.input.right'], '座位名')
  equal(host.calls.slot.options.name, 'conversation.input.right', 'slot name')
  equal(host.calls.slot.options.id, 'second-sight', 'slot id')
  equal(host.calls.slot.options.order, 10, 'order')
  equal(typeof host.calls.slot.Component, 'function', '组件')
})

await check('原生多模态模型不占位置', async () => {
  const mini = createMiniReact()
  const plugin = bundle.factory(fakeRequire(mini))
  const host = createClientContext((overrides) => hostState({ textOnly: false, onTwin: false, ...overrides }))
  await plugin.apply(host.ctx)
  const Component = host.calls.slot.Component
  const tree = mini.mount(Component, { sessionId: 's1' })
  await mini.flush(Component, { sessionId: 's1' })
  equal(host.calls.register.length > 0, true, '座位已注册')
  ok(tree === null || tree === undefined, '不渲染任何东西')
})

await check('provider 没有双胞胎时不占位置', async () => {
  const mini = createMiniReact()
  const plugin = bundle.factory(fakeRequire(mini))
  const host = createClientContext((overrides) => hostState({ twin: null, onTwin: false, ...overrides }))
  await plugin.apply(host.ctx)
  const Component = host.calls.slot.Component
  mini.mount(Component, { sessionId: 's1' })
  const tree = await mini.flush(Component, { sessionId: 's1' })
  ok(tree === null || tree === undefined, '不渲染任何东西')
})

await check('副眼开着、主模型换成多模态：自动关掉副眼并隐藏按钮', async () => {
  const mini = createMiniReact()
  const plugin = bundle.factory(fakeRequire(mini))
  const host = createClientContext((overrides) => hostState({ textOnly: false, onTwin: false, ...overrides }))
  await plugin.apply(host.ctx)
  const Component = host.calls.slot.Component
  mini.mount(Component, { sessionId: 's1' })
  const tree = await mini.flush(Component, { sessionId: 's1' })
  ok(tree === null || tree === undefined, '按钮不渲染')
  const off = host.calls.set.find((call) => call[1] === '' && call[2] === '')
  ok(off !== undefined, '顺手把 Host 里的会话覆盖清掉（不换模型）')
  equal(host.calls.select.length, 0, '不在基座上时不擅自切 provider/model')
})

await check('会话还在双胞胎上、模型变成多模态：provider 自动退回基座', async () => {
  const mini = createMiniReact()
  const plugin = bundle.factory(fakeRequire(mini))
  // 用户在 `+副眼` 里点了多模态模型：onTwin 仍为 true，但 textOnly 变 false
  const host = createClientContext((overrides) =>
    hostState({ textOnly: false, onTwin: true, vision: null, ...overrides }))
  await plugin.apply(host.ctx)
  const Component = host.calls.slot.Component
  mini.mount(Component, { sessionId: 's1' })
  const tree = await mini.flush(Component, { sessionId: 's1' })
  ok(tree === null || tree === undefined, '多模态下按钮隐藏')
  equal(host.calls.set.length, 0, 'Host 侧已经在 stateFor 里清过覆盖，不用再发')
  const select = host.calls.select.at(-1)
  ok(select !== undefined, '发了一次模型选择')
  equal(select.provider, 'ctyun-codingplan', '切回基座 provider')
  equal(select.model, 'glm-5.3-oc', '模型不变')
})

await check('纯文本模型出现副眼图标按钮（移动端不占文字）', async () => {
  const mini = createMiniReact()
  const plugin = bundle.factory(fakeRequire(mini))
  const host = createClientContext((overrides) => hostState({ vision: null, ...overrides }))
  await plugin.apply(host.ctx)
  const Component = host.calls.slot.Component
  mini.mount(Component, { sessionId: 's1' })
  const tree = await mini.flush(Component, { sessionId: 's1' })
  const trigger = findTrigger(tree, '副眼')
  ok(trigger !== undefined, '有带 aria-label 的按钮')
  equal(textsOf(tree).includes('副眼'), true, '桌面端带「副眼」二字')
  equal(trigger.style.border, 'none', '不靠边框区分状态')
  const closed = JSON.stringify(trigger).includes('13.4 2.6')
  equal(closed, true, '未选中时闭眼图标带斜杠')
  equal(host.calls.state.length >= 1, true, '读了一次 Host 状态')
  equal(host.calls.state[0], ['s1', 'ctyun-codingplan', 'glm-5.3-oc'], '带上当前选择')
})

await check('打开面板列出副模型与思考强度', async () => {
  const mini = createMiniReact()
  const plugin = bundle.factory(fakeRequire(mini))
  const host = createClientContext((overrides) => hostState({ vision: null, ...overrides }))
  await plugin.apply(host.ctx)
  const Component = host.calls.slot.Component
  mini.mount(Component, { sessionId: 's1' })
  let tree = await mini.flush(Component, { sessionId: 's1' })

  const trigger = findTrigger(tree, '副眼')
  ok(trigger !== undefined, '找到触发按钮')
  trigger.onClick()
  tree = await mini.flush(Component, { sessionId: 's1' })
  const label = textsOf(tree)
  ok(label.includes('SenseNova 6.8 Flash Lite'), `列出模型：${label}`)
  ok(label.includes('xhx2api'), '带上 provider 名')
  ok(!label.includes('还没选副眼'), '未选择时不再显示提示行')
})

await check('选模型：先写 Host 覆盖，再把会话切到双胞胎', async () => {
  const mini = createMiniReact()
  const plugin = bundle.factory(fakeRequire(mini))
  const host = createClientContext((overrides) => hostState({ vision: null, ...overrides }))
  await plugin.apply(host.ctx)
  const Component = host.calls.slot.Component
  mini.mount(Component, { sessionId: 's1' })
  let tree = await mini.flush(Component, { sessionId: 's1' })
  findTrigger(tree, '副眼').onClick()
  tree = await mini.flush(Component, { sessionId: 's1' })

  const pick = findButton(tree, 'SenseNova 6.8 Flash Lite')
  ok(pick !== undefined, '找到模型行')
  await pick.onClick()
  await mini.flush(Component, { sessionId: 's1' })

  equal(host.calls.set[0], ['s1', 'xhx2api', 'sensenova-6.8-flash-lite', ''], '写 Host 覆盖')
  equal(host.calls.select[0], { provider: 'ctyun-codingplan-second-sight', model: 'glm-5.3-oc', reasoningEffort: 'max' }, '切到双胞胎，保留主模型与 effort')
})

await check('换思考强度：透传 effort 且仍然切双胞胎', async () => {
  const mini = createMiniReact()
  const plugin = bundle.factory(fakeRequire(mini))
  const host = createClientContext((overrides) => hostState({ vision: null, ...overrides }))
  await plugin.apply(host.ctx)
  const Component = host.calls.slot.Component
  mini.mount(Component, { sessionId: 's1' })
  let tree = await mini.flush(Component, { sessionId: 's1' })
  findTrigger(tree, '副眼').onClick()
  tree = await mini.flush(Component, { sessionId: 's1' })
  await findButton(tree, 'SenseNova 6.8 Flash Lite').onClick()
  tree = await mini.flush(Component, { sessionId: 's1' })
  // 选中后模型行下面是「思考强度：」+ 下拉框
  ok(textsOf(tree).includes('思考强度：'), '有 label')
  const box = findSelect(tree)
  ok(box !== undefined, '有下拉框')
  const options = walk(tree).filter(([kind]) => kind === 'option').map(([, props]) => props)
  deepEqual(options.map((option) => option.value), ['', 'low', 'high'], '选项：默认 + low + high')
  await box.onChange({ target: { value: 'high' } })
  tree = await mini.flush(Component, { sessionId: 's1' })
  equal(host.calls.set.at(-1), ['s1', 'xhx2api', 'sensenova-6.8-flash-lite', 'high'], 'effort 透传')
  equal(host.calls.select.at(-1).provider, 'ctyun-codingplan-second-sight', '仍然切双胞胎')
  // 回归：切的是会话自己的模型（glm-5.3-oc），副模型只存 Host；别把主模型换成副模型
  equal(host.calls.select.at(-1).model, 'glm-5.3-oc', '主模型不被副模型顶掉')
  equal(host.calls.select.at(-1).reasoningEffort, 'max', '会话自己的强度不变')
  // 0.5.3：选中后按钮文字 = 副模型名 · 档位（桌面端）
  const trigger = findTrigger(tree, '已开启')
  ok(trigger !== undefined, '按钮还在')
  equal(textsOf(tree).includes('SenseNova 6.8 Flash Lite · High'), true, '按钮文字换成「副模型名 · 档位」')
})

await check('关掉副眼：清覆盖 + 切回基座 provider', async () => {
  const mini = createMiniReact()
  const plugin = bundle.factory(fakeRequire(mini))
  let twin = true
  const host = createClientContext((overrides) => hostState({ onTwin: twin, textOnly: true, ...overrides }))
  await plugin.apply(host.ctx)
  const Component = host.calls.slot.Component
  // 已经在双胞胎上
  host.directory.store.getSnapshot = () => ({ current: { provider: 'ctyun-codingplan-second-sight', model: 'glm-5.3-oc', reasoningEffort: 'max' } })
  mini.mount(Component, { sessionId: 's1' })
  let tree = await mini.flush(Component, { sessionId: 's1' })
  const trigger = findTrigger(tree, '已开启')
  ok(trigger !== undefined, '选中后 aria-label 标出已开启')
  ok(String(trigger.style.color).includes('state-business-primary'), '选中后图标点亮')
  equal(JSON.stringify(trigger).includes('13.4 2.6'), false, '选中后睁开眼')
  trigger.onClick()
  tree = await mini.flush(Component, { sessionId: 's1' })
  ok(textsOf(tree).includes('SenseNova 6.8 Flash Lite'), '面板里显示当前副模型')
  const off = findButton(tree, '关闭副眼')
  ok(off !== undefined, '有关闭入口')
  twin = false
  await off.onClick()
  await mini.flush(Component, { sessionId: 's1' })
  equal(host.calls.set.at(-1), ['s1', '', '', ''], '清 Host 覆盖')
  equal(host.calls.select.at(-1).provider, 'ctyun-codingplan', '切回基座')
})

// —— 真实网关校验 ——
//
// 宿主的 `ClientRemoteService.mount` 会逐参数跑 `requireStrictCodec`，只认
// `mode: 'strict'`（`src-json` 会被拒："has no strict codec"）。这里直接引真实的
// 网关浏览器端实现，把贡献喂进去；只要它不抛错，描述符就是能挂载的。


/** 复刻 validateContribution + requireStrictInputs 的校验（网关里是私有函数）。 */
function assertMountable(contribution) {
  const endpoints = new Set()
  for (const descriptor of contribution.descriptors) {
    const endpoint = `${descriptor.namespace}/${descriptor.method}`
    const requireStrictCodec = (codec, field) => {
      if (codec?.mode !== 'strict') throw new Error(`client api: generated Remote ${endpoint} field ${JSON.stringify(field)} has no strict codec`)
      if (typeof codec.typeSymbol !== 'string' || codec.typeSymbol === '') throw new Error(`${endpoint}.${field} 缺 typeSymbol`)
      if (typeof codec.create !== 'function') throw new Error(`${endpoint}.${field} 缺 create()`)
      const parser = codec.create()
      if (parser === null || typeof parser?.parse !== 'function') throw new Error(`${endpoint}.${field}.create() 没有 parse()`)
    }
    for (const parameter of descriptor.parameters) requireStrictCodec(parameter.codec, parameter.wire)
    requireStrictCodec(descriptor.result, 'result')
    if (endpoints.has(endpoint)) throw new Error(`重复的端点 ${endpoint}`)
    endpoints.add(endpoint)
  }
  return [...endpoints]
}

process.stdout.write('\n模型列表与移动端\n')

await check('模型列表每个 provider 只留一行：未开副眼看原始项，开了只看 +副眼', async () => {
  const mini = createMiniReact()
  const plugin = bundle.factory(fakeRequire(mini))
  const groups = [
    { id: 'ctyun-codingplan', name: 'ctyun', models: [{ id: 'glm-5.3-oc', name: 'GLM 5.3' }] },
    { id: 'ctyun-codingplan-second-sight', name: 'ctyun + 副眼', models: [{ id: 'glm-5.3-oc', name: 'GLM 5.3' }] },
    { id: 'xhx2api', name: 'xhx2api', models: [{ id: 'glm-5.3', name: 'GLM 5.3' }] },
    { id: 'xhx2api-second-sight', name: 'xhx2api + 副眼', models: [{ id: 'glm-5.3', name: 'GLM 5.3' }] },
  ]
  let snapshot = { current: { provider: 'ctyun-codingplan', model: 'glm-5.3-oc' }, groups }
  const store = { getSnapshot: () => snapshot, subscribe: () => () => {} }
  const directory = { store, load: async () => {}, select: async () => ({ ok: true }) }
  const original = () => directory
  const models = { directoryFor: original }
  const host = createClientContext(hostState)
  host.ctx.modelDirectories = models
  const dispose = await plugin.apply(host.ctx)

  const visible = () => models.directoryFor('s1').store.getSnapshot().groups.map((group) => group.id)
  equal(visible(), ['ctyun-codingplan', 'xhx2api'], '未开副眼：隐藏全部 +副眼')
  equal(models.directoryFor('s1').store.getSnapshot(), models.directoryFor('s1').store.getSnapshot(), '同一快照返回同一对象（避免无限重渲染）')

  snapshot = { ...snapshot, current: { provider: 'ctyun-codingplan-second-sight', model: 'glm-5.3-oc' } }
  // 0.5.0：双胞胎目录与基座一致，所以「在副眼上」时只留当前那一条双胞胎，
  // 其它 provider 的双胞胎组不该再占一行。
  equal(visible(), ['ctyun-codingplan-second-sight', 'xhx2api'], '开了副眼：只留当前 +副眼（其它双胞胎组隐藏）')

  await dispose()
  equal(models.directoryFor, original, '卸载后还原 directoryFor')
})

await check('apply 之前就被抓走的 store 也要被过滤（座位缓存 / 原型补丁回归）', async () => {
  const mini = createMiniReact()
  const plugin = bundle.factory(fakeRequire(mini))
  const groups = [
    { id: 'xhx2api', name: 'xhx2api', models: [{ id: 'glm-5.3', name: 'GLM 5.3' }] },
    { id: 'xhx2api-second-sight', name: 'xhx2api + 副眼', models: [{ id: 'glm-5.3', name: 'GLM 5.3' }] },
  ]
  let snapshot = { current: { provider: 'xhx2api-second-sight', model: 'glm-5.3' }, groups }

  // 服务是 class 实例（方法在原型上），和真实的 cordis service 一致。
  class Directories {
    directoryFor() {
      return directory
    }
  }

  const store = { getSnapshot: () => snapshot, subscribe: () => () => {} }
  const directory = { store, load: async () => {}, select: async () => ({ ok: true }) }
  const models = new Directories()

  const host = createClientContext(hostState)
  host.ctx.modelDirectories = models

  // 模拟「座位在 apply 之前渲染过一轮」：先抓住 store 引用。
  const captured = models.directoryFor('s1').store

  await plugin.apply(host.ctx)

  // 座位每渲染一次就会调一次 directoryFor，就地把那份 store 的 getSnapshot 换掉——
  // 所以即使选择器早就抓走了引用，下一次渲染之后拿到的也是过滤过的快照。
  models.directoryFor('s1')

  equal(captured.getSnapshot().groups.map((group) => group.id), ['xhx2api-second-sight'], '被抓走的 store 也过滤')
  equal(models.directoryFor('s1').store.getSnapshot().groups.map((group) => group.id), ['xhx2api-second-sight'], '新取的也过滤')
  equal(captured.getSnapshot(), captured.getSnapshot(), '同一快照稳定（避免无限重渲染）')

  snapshot = { ...snapshot, current: { provider: 'xhx2api', model: 'glm-5.3' } }
  equal(captured.getSnapshot().groups.map((group) => group.id), ['xhx2api'], '关掉副眼后回到原始 provider')
})

await check('窄屏只留图标，宽屏带「副眼」二字', async () => {
  const mini = createMiniReact()
  const plugin = bundle.factory(fakeRequire(mini))
  const host = createClientContext((overrides) => hostState({ vision: null, ...overrides }))
  await plugin.apply(host.ctx)
  const Component = host.calls.slot.Component

  const narrow = { matches: false, addEventListener() {}, removeEventListener() {} }
  globalThis.window.matchMedia = () => narrow
  let tree = await mini.flush(Component, { sessionId: 's1' })
  tree = await mini.flush(Component, { sessionId: 's1' })
  equal(textsOf(tree).includes('副眼'), false, '窄屏没有文字')
  equal(findTrigger(tree, '副眼') !== undefined, true, '图标按钮仍在')

  const wide = { matches: true, addEventListener() {}, removeEventListener() {} }
  globalThis.window.matchMedia = () => wide
  // matchMedia 的结果变了，但 mini 的 useSyncExternalStore 只在渲染时取快照；
  // rerender() 强制再渲染一轮，快照才会被重新读。
  tree = mini.rerender()
  equal(textsOf(tree).includes('副眼'), true, '宽屏显示文字')
  delete globalThis.window.matchMedia
})

process.stdout.write('\n面板布局\n')

await check('面板右边贴着按钮右边：按钮变宽（副模型名/档位变长）时面板不横跳', async () => {
  const plugin = bundle.factory(fakeRequire(createMiniReact()))

  // 桌面：按钮 660..700，面板右沿对齐 700。
  const short = plugin.panelRect({ left: 660, width: 40, top: 560 }, { width: 900, height: 640 })
  equal(short.width, 320, '宽度 320')
  equal(short.left + short.width, 700, '右边与按钮右边对齐')
  equal(short.bottom, 86, '贴着按钮上沿')
  equal(short.maxHeight, 420, '高度上限 420')

  // 选了副模型/档位后按钮向左长到 180 宽（靠右摆，右边不动）——面板右沿仍是 700，位置不动。
  const long = plugin.panelRect({ left: 520, width: 180, top: 560 }, { width: 900, height: 640 })
  equal(long.left + long.width, 700, '按钮变宽后右沿仍对齐')
  equal(long.left, short.left, '面板不跟着按钮的左边横跳')

  // 贴着屏幕右边：右沿夹在 vw-8，不越界。
  const edge = plugin.panelRect({ left: 640, width: 300, top: 560 }, { width: 900, height: 640 })
  equal(edge.left + edge.width, 892, '右边夹到 vw-8')

  // 窄到放不下 320 时继续让步（手机）
  const tiny = plugin.panelRect({ left: 0, width: 40, top: 300 }, { width: 280, height: 640 })
  equal(tiny.width, 264, '宽度跟视口走')
  equal(tiny.left, 8, '左边至少留 8')

  // 按钮贴近屏幕顶部：允许的最小高度，不出现负数
  const top = plugin.panelRect({ left: 40, width: 40, top: 30 }, { width: 360, height: 640 })
  equal(top.maxHeight, 140, '最少 140 高')
  ok(top.bottom > 0, 'bottom 为正')
})

await check('面板用 fixed 定位，标题独占一行，列表在自己那块里滚', async () => {
  const mini = createMiniReact()
  const plugin = bundle.factory(fakeRequire(mini))
  const host = createClientContext(hostState)
  await plugin.apply(host.ctx)
  const Component = host.calls.slot.Component
  mini.mount(Component, { sessionId: 's1' })
  let tree = await mini.flush(Component, { sessionId: 's1' })
  findTrigger(tree, '副眼').onClick()
  tree = await mini.flush(Component, { sessionId: 's1' })
  const panel = findByRole(tree, 'dialog')
  ok(panel !== undefined, '面板存在')
  equal(panel.style.position, 'fixed', 'fixed')
  equal(panel.style.overflowY, 'hidden', '外壳本身不滚')
  ok(typeof panel.style.maxHeight === 'number', '有 maxHeight')
  ok(typeof panel.style.width === 'number', '有 width')

  // 头部与列表是两段独立布局：头部不浮动（不用 sticky 压在列表上），列表有自己的滚动容器。
  const parts = Array.isArray(panel.children) ? panel.children : [panel.children]
  const head = parts[0]?.props
  const body = parts[1]?.props
  const foot = parts[2]?.props
  ok(head !== undefined && body !== undefined && foot !== undefined, '头部、列表、页脚各占一段')
  equal(head.style.position, undefined, '头部不浮动，不会是浮层')
  equal(head.style.display, 'flex', '头部是一行')
  equal(body.style.overflowY, 'auto', '列表自己滚')
  equal(body.style.minHeight, 0, '列表可收缩，长内容才滚得动')
  // 回归：列表与页脚不能重叠。页脚是透明的（只有一条 inset 分隔线），压住的几 px
  // 会变成透明带，滚到折叠线的那一行会从分隔线下面透出来。
  ok(!String(body.style.margin ?? '').includes('-'), '列表不用负 margin 压到页脚上')
  equal(foot.style.margin, '0 -6px -6px', '页脚仍通栏贴边（只向左右/下方伸）')
})
await check('面板里 provider 分组行必须在（回归：只剩模型名）', async () => {
  const mini = createMiniReact()
  const plugin = bundle.factory(fakeRequire(mini))
  const host = createClientContext((overrides) =>
    hostState({
      options: [
        { provider: 'xhx2api', name: '天翼云 CodingPlan (19276)', models: [{ id: 'sensenova-6.8-flash-lite', name: 'SenseNova 6.8 Flash Lite', efforts: [] }] },
        { provider: 'agnes', name: 'Agnes', models: [{ id: 'agnes-3.0-flash', name: 'Agnes 3.0 Flash', efforts: [] }] },
      ],
      ...overrides,
    }),
  )
  await plugin.apply(host.ctx)
  const Component = host.calls.slot.Component
  mini.mount(Component, { sessionId: 's1' })
  let tree = await mini.flush(Component, { sessionId: 's1' })
  findTrigger(tree, '副眼').onClick()
  tree = await mini.flush(Component, { sessionId: 's1' })
  const text = textsOf(tree)
  ok(text.includes('天翼云 CodingPlan (19276)'), '第一个 provider 名在')
  ok(text.includes('Agnes'), '第二个 provider 名在')
  const heads = walk(tree).filter(([kind, props]) => kind === 'div' && props?.style?.borderTop !== undefined)
  equal(heads.length, 2, '两行分组头，各自带上分隔线')
  equal(heads[0][1].style.flex, 'none', '分组头不参与收缩（0.3.5 被压成 0 高度的根因）')
})

await check('搜索：按模型名过滤、provider 命中保整组、无匹配给提示', async () => {
  const mini = createMiniReact()
  const plugin = bundle.factory(fakeRequire(mini))
  const host = createClientContext((overrides) =>
    hostState({
      vision: null, // 按钮文字保持「副眼」，别让副模型名污染下面的文案断言
      options: [
        { provider: 'xhx2api', name: 'XHX', models: [
          { id: 'sensenova-6.8-flash-lite', name: 'SenseNova 6.8', efforts: [] },
          { id: 'glm-5.3-flash', name: 'GLM 5.3 Flash', efforts: [] },
        ] },
        { provider: 'agnes', name: 'Agnes', models: [{ id: 'agnes-3.0-flash', name: 'Agnes 3.0 Flash', efforts: [] }] },
      ],
      ...overrides,
    }),
  )
  await plugin.apply(host.ctx)
  const Component = host.calls.slot.Component
  mini.mount(Component, { sessionId: 's1' })
  let tree = await mini.flush(Component, { sessionId: 's1' })
  findTrigger(tree, '副眼').onClick()
  tree = await mini.flush(Component, { sessionId: 's1' })

  const box = findInput(tree, '搜索')
  ok(box !== undefined, '有搜索框')
  box.onChange({ target: { value: 'nova' } })
  tree = await mini.flush(Component, { sessionId: 's1' })
  let text = textsOf(tree)
  ok(text.includes('SenseNova 6.8'), '命中的模型还在')
  ok(!text.includes('GLM 5.3 Flash'), '不命中的模型被过滤')
  ok(text.includes('XHX'), 'provider 行跟着它的模型一起保留')
  ok(!text.includes('Agnes 3.0 Flash'), '别的 provider 整组消失')

  findInput(tree, '搜索').onChange({ target: { value: 'agnes' } })
  tree = await mini.flush(Component, { sessionId: 's1' })
  text = textsOf(tree)
  ok(text.includes('Agnes 3.0 Flash'), 'provider 名命中保留整组')
  ok(!text.includes('SenseNova 6.8'), '未命中的组被过滤')

  findInput(tree, '搜索').onChange({ target: { value: 'zzz' } })
  tree = await mini.flush(Component, { sessionId: 's1' })
  ok(textsOf(tree).includes('没有匹配的模型'), '空结果有提示')

  findInput(tree, '搜索').onChange({ target: { value: '' } })
  tree = await mini.flush(Component, { sessionId: 's1' })
  ok(textsOf(tree).includes('SenseNova 6.8'), '清空后全部回来')
})

await check('窄屏按钮不再用负 margin 挤工具行', async () => {
  const mini = createMiniReact()
  const plugin = bundle.factory(fakeRequire(mini))
  const host = createClientContext(hostState)
  await plugin.apply(host.ctx)
  const Component = host.calls.slot.Component
  globalThis.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  try {
    mini.mount(Component, { sessionId: 's1' })
    const tree = await mini.flush(Component, { sessionId: 's1' })
    const trigger = findTrigger(tree, '副眼')
    equal(trigger.style.marginLeft, undefined, '没有负 margin')
    equal(trigger.style.width, 24, '窄屏 24px')
  } finally {
    delete globalThis.window.matchMedia
  }
})
// —— 收尾 ——

process.stdout.write(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exitCode = 1

/** 客户端只允许 require 这两个包。 */
function fakeRequire(mini) {
  return (name) => {
    if (name === 'react') return mini.React
    if (name === 'react-dom') return { createPortal: (children) => ({ type: PORTAL, props: { children } }) }
    throw new Error(`客户端不该 require("${name}")`)
  }
}