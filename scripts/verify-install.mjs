/**
 * verify-install.mjs —— 装完之后的自检：**从 profile 里解析装好的那份**，
 * 挂到真实的 LlmRuntime + ToolsService 上跑一遍。
 *
 * 和 test/host-integration.mjs 的区别：那个测的是工作区里的 `../index.js`，
 * 这个测的是 profile 的 node_modules 里那份（能抓到「tarball 少文件 / 导出坏了 /
 * 依赖装漏了」这类只有装完才会暴露的问题）。
 *
 * 运行：node scripts/verify-install.mjs
 *   DSH_SECOND_SIGHT_PROFILE  —— profile 目录，默认 ~/.dsh/profiles/web
 *   DSH_SECOND_SIGHT_DSH      —— @deepseek-ai 内部包目录，默认按本机安装路径找
 */

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const PROFILE = process.env.DSH_SECOND_SIGHT_PROFILE ?? join(homedir(), '.dsh', 'profiles', 'web')
const DSH = process.env.DSH_SECOND_SIGHT_DSH ?? 'C:/Users/win10/AppData/Local/Author Software/nvm/installs/v26.10.0/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'

const fail = (message) => {
  process.stdout.write(`FAIL  ${message}\n`)
  process.exitCode = 1
}

if (!existsSync(join(PROFILE, 'package.json'))) {
  process.stdout.write(`跳过：profile 不存在（${PROFILE}）\n`)
  process.exit(0)
}
if (!existsSync(join(DSH, 'cordis/lib/index.js'))) {
  process.stdout.write(`跳过：找不到 DSH 内部包（${DSH}）\n`)
  process.exit(0)
}

process.stdout.write(`profile: ${PROFILE}\n宿主:    ${DSH}\n\n`)

// 1) 从 profile 里解析装好的插件（走的正是宿主 PluginPackages 的那条路径）
const require = createRequire(join(PROFILE, 'package.json'))
let entry
try {
  entry = require.resolve('dsh-second-sight')
} catch (error) {
  fail(`profile 里解析不到 dsh-second-sight：${error.message}`)
  process.exit(1)
}
process.stdout.write(`入口:    ${entry}\n\n`)

const plugin = await import(pathToFileURL(entry).href)
for (const key of ['name', 'version', 'inject', 'apply']) {
  if (plugin[key] === undefined) fail(`导出缺 ${key}`)
}
if (plugin.name !== 'dsh-second-sight') fail(`name 不是 dsh-second-sight（${plugin.name}）`)
process.stdout.write(`导出 ok：name=${plugin.name} version=${plugin.version} inject=${JSON.stringify(plugin.inject)}\n\n`)

// 1.5) 浏览器半边必须跟着 tarball 走，且宿主能发现它的 client 声明
const { readFileSync } = await import('node:fs')
const { dirname } = await import('node:path')
const packageRoot = dirname(entry)
if (!existsSync(join(packageRoot, 'client.js'))) {
  fail('装好的包里没有 client.js')
} else {
  const clientSource = readFileSync(join(packageRoot, 'client.js'), 'utf8')
  if (!clientSource.includes('__ModuleLoader__.load')) fail('client.js 不是 __ModuleLoader__ 模块')
  else process.stdout.write('客户端半边 ok：client.js 就位\n')
}
const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
if (manifest.dsh?.client?.platform !== 'web') fail('package.json 缺 dsh.client.platform = web')
else process.stdout.write(`dsh.client ok：platform=${manifest.dsh.client.platform} immediately=${manifest.dsh.client.immediately}\n`)

// 1.6) 远端方法描述符要能被真实的 Typert 读取器认出来
{
  const { TypertRemoteService, remoteMethods } = await import(`${pathToFileURL(DSH).href}/dsh-typert-protocol/lib/index.js`)
  const Remote = plugin.createRemoteClass(TypertRemoteService)
  const exports_ = remoteMethods(Object.create(Remote.prototype)).map((method) => method.exportName)
  if (exports_.join(',') !== 'state,set') fail(`远端方法表不对（${exports_.join(',')}）`)
  else process.stdout.write(`remote.secondSight ok：${exports_.join(' / ')}\n`)
}

// 2) 挂到真实 LlmRuntime + ToolsService 上
const ROOT = pathToFileURL(DSH).href
const { Context } = await import(`${ROOT}/cordis/lib/index.js`)
const { LlmRuntime } = await import(`${ROOT}/dsh-llm/lib/index.js`)
const { ToolsService } = await import(`${ROOT}/dsh-tools/lib/index.js`)

class FakeBase {
  providerInfo(provider) {
    return { id: provider, name: `fake ${provider}` }
  }
  providerRetryPolicy() {}
  imageRequestPricing() {}
  imageRequestTarget(_p, _m, image) {
    return { width: image.width, height: image.height, maxBytes: image.bytes }
  }
  async listModels(provider) {
    return [{ provider, id: 'text-model', name: 'Text Model', inputModalities: ['text'], context: { contextWindow: 1000 }, defaultMaxTokens: 100 }]
  }
  async resolveModel(provider, model) {
    return { provider, id: model, name: 'Text Model', inputModalities: ['text'], context: { contextWindow: 1000 }, defaultMaxTokens: 100 }
  }
  async prepareCall(provider, model) {
    return { model: await this.resolveModel(provider, model), stream: (options) => this.stream(options) }
  }
  async *stream() {
    yield { type: 'text-delta', index: 0, text: 'ok' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const ctx = new Context()
await ctx.plugin(LlmRuntime)
ctx.provide('systemPrompt', { tools: () => () => {} })
await ctx.plugin(ToolsService)
const disposeBase = ctx.llm.registerAdapter(['verifybase'], new FakeBase())

const fiber = await ctx.plugin(plugin, {
  maxTokens: 512,
  questions: { maxPerImage: 3, historyTurns: 1 },
})

const ids = ctx.llm.listProviders().map((entry) => entry.id).sort()
if (!ids.includes('verifybase-second-sight')) fail(`双胞胎路由没注册上（providers: ${ids.join(',')}）`)
else process.stdout.write(`双胞胎路由 ok：${ids.join(', ')}\n`)

const models = await ctx.llm.listModels('verifybase-second-sight')
if (models[0]?.provider !== 'verifybase-second-sight') fail('listModels 没回写 provider')
else if (!models[0].inputModalities.includes('image')) fail('listModels 没补 image 模态')
else process.stdout.write(`listModels ok：${models[0].id} → ${models[0].inputModalities.join('+')}\n`)

const resolved = await ctx.llm.resolveModelInfo('verifybase-second-sight', 'text-model')
if (resolved.provider !== 'verifybase-second-sight') fail('resolveModelInfo 的 provider 不对')
else process.stdout.write(`resolveModelInfo ok：${resolved.provider}/${resolved.id}\n`)

const agent = { id: 'verify-agent' }
const toolSet = await ctx.tools.resolve({
  agent,
  modelSelection: { provider: 'verifybase-second-sight', model: 'text-model' },
  signal: new AbortController().signal,
})
const visible = [...toolSet.view(agent).keys()]
toolSet.dispose()
if (!visible.includes('ask_image')) fail(`双胞胎会话里看不到 ask_image（可见：${visible.join(',')}）`)
else process.stdout.write(`ask_image 门控 ok（双胞胎会话可见）\n`)

await fiber.dispose()
const after = ctx.llm.listProviders().map((entry) => entry.id)
if (after.includes('verifybase-second-sight')) fail('撤销后双胞胎路由仍在')
else process.stdout.write('撤离 ok：fiber 处置后双胞胎路由已撤销\n')

disposeBase()
await ctx.fiber.dispose()

process.stdout.write(process.exitCode === 1 ? '\n自检失败\n' : '\n自检通过\n')
