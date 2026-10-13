// 用假 ctx 驱动 dsh-app-panel 的 host 半边：发现 → 列表 → 勾选 → 限制 → 落盘。
// 测试自带 fixture（自己造的临时 DSH_HOME 里的 patch + profile 清单），既隔离又确定。
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = await mkdtemp(join(tmpdir(), 'app-panel-test-'))
// 插件在 import 时读 DSH_HOME，所以必须在 import 之前设好 —— 否则测试会去动真的 ~/.dsh
process.env.DSH_HOME = HOME
await mkdir(`${HOME}/profiles/desktop`, { recursive: true })
await writeFile(
  `${HOME}/cordis.patch.yml`,
  [
    '- insert:',
    "    - id: mcp-rea",
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        serverName: rea',
    '        transport: stdio',
    "        command: 'node'",
    "    - id: mcp-other",
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        serverName: unity',
    "    - id: hindsight",
    "      name: '@vectorize-io/hindsight-coding-agents'",
    "    - id: tool-pwsh",
    "      name: '@deepseek-ai/dsh-tool-pwsh'",
    '',
  ].join('\n'),
)
await writeFile(
  `${HOME}/profiles/desktop/package.json`,
  JSON.stringify({ dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'misakanet'] } } }, null, 2),
)
process.argv.push(join(HOME, 'profiles', 'desktop'))

const mod = await import(new URL('../lib/index.js', import.meta.url).href)

const routes = new Map()
const restricted = []
const handlers = {}
const fakeTools = [
  { name: 'mcp__rea__binary_session' },
  { name: 'mcp__rea__analyze_function' },
  { name: 'mcp__unity__manage_scene' },
  { name: 'hindsight_search_knowledge_pages' },
  { name: 'pwsh' },
]

/**
 * 把 agent 的 ctx 做成"只有 tools 可用、其它属性一律抛"—— 复刻 Cordis 在线上的
 * 行为（访问未 inject 的服务属性会抛）。修 sessionIdOf 之前，agent.ctx.scope 这种
 * 候选会被急切求值并炸掉整个函数，于是限制静默失效。
 */
function guardedCtx(label) {
  const base = {
    tools: {
      restrict(filter) {
        restricted.push({ agent: label, filter })
        return () => {}
      },
    },
  }
  return new Proxy(base, {
    get(target, prop) {
      if (prop in target) return target[prop]
      throw new Error(`cannot get property "${String(prop)}" without inject`)
    },
  })
}

const restrictedAgent = { id: 'sess-A', ctx: guardedCtx('sess-A') }

// 插件装载**之前**就存在的会话：它不会收到任何 agent/* 事件，只能靠 syncLiveAgents 兜住。
const preExistingAgent = { id: 'sess-A', ctx: guardedCtx('sess-A(pre)') }

const ctx = {
  webServer: { register: (r) => (routes.set(r.path, r.handler), () => {}) },
  tools: { schemas: () => fakeTools, restrict: () => () => {} },
  on: (ev, fn) => (handlers[ev] = fn),
  agents: { list: () => [preExistingAgent] },
  // 只在注册表里、磁盘上没有的技能：模拟"由 bundle / 远程 provider 提供的新技能"，
  // 面板必须自动认出来（不需要为它改代码）。
  skills: {
    list: async () => [
      {
        name: 'registry-only-skill',
        description: '只在注册表里，不在磁盘上。用于验证表格里只显示一小句，全文进 hover 提示。',
      },
      { name: 'hindsight-coding-agent', description: '磁盘上也有，注册表为准' },
    ],
  },
}

const dispose = mod.apply(ctx)
await new Promise((r) => setTimeout(r, 300))

function call(path, { url, body } = {}) {
  return new Promise((resolve) => {
    const req = {
      url: url ?? path,
      socket: { remoteAddress: '127.0.0.1' },
      async *[Symbol.asyncIterator]() {
        if (body) yield Buffer.from(JSON.stringify(body))
      },
    }
    const res = {
      statusCode: 0,
      setHeader() {},
      end(payload) {
        resolve({ status: this.statusCode, json: JSON.parse(payload) })
      },
    }
    routes.get(path)(req, res)
  })
}

console.log('routes:', [...routes.keys()].join(', '))
console.log('events hooked:', Object.keys(handlers).join(', '))

const list1 = await call('/api/app-panel/list', { url: '/api/app-panel/list?session=sess-A' })
console.log('\n--- /list (sess-A, 默认全开) ---')
console.log('apps:', list1.json.apps.map((a) => `${a.kind}|${a.title}|${a.enabled ? 'ON' : 'off'}|${a.cost}`).join('\n      '))
console.log('total:', list1.json.total.text)
console.log('合计拆分:', `工具 ${list1.json.total.toolBytes} B + 技能目录 ${list1.json.total.skillBytes} B = ${list1.json.total.bytes} B`)
console.log('技能行   :', list1.json.apps.filter((a) => a.kind === '技能').map((a) => `${a.title}: ${a.cost}`).join(' | ') || '(夹具无技能)')
// 前缀识别不出来的插件，靠应用名自己推（hindsight-coding-agents → hindsight_）
const hs = list1.json.apps.find((a) => a.title === 'hindsight')
console.log('hindsight 归前缀:', hs ? `${hs.cost} affects=${hs.affects}` : '(缺)')
// 内置工具（无统一前缀）各自成行，否则它们根本关不掉
const toolRows = list1.json.apps.filter((a) => a.kind === '工具')
console.log('工具行   :', toolRows.length, '→', toolRows.map((a) => `${a.title}(${a.cost})`).join(', ') || '(无)')
// 注册表里独有的技能（磁盘上没有）也要自动在表里、能关
const regSkill = list1.json.apps.find((a) => a.title === 'registry-only-skill')
console.log('注册表独有技能 :', regSkill ? `${regSkill.kind}/${regSkill.cost}/affects=${regSkill.affects}/key=${regSkill.key}` : '(缺)')
// 简介：表里只留一小句，全文进 hover
console.log('简介（短） :', JSON.stringify(regSkill?.summary), '长度', (regSkill?.summary ?? '').length)
console.log('简介（全） :', JSON.stringify(regSkill?.summaryFull))
console.log('短简介已切掉"用于…" :', !(regSkill?.summary ?? '').includes('用于') && (regSkill?.summaryFull ?? '').includes('用于'))

// 会话创建 → 默认没有任何 deny
handlers['agent/created']?.(restrictedAgent)
console.log('\nagent/created (默认):', JSON.stringify(restricted.at(-1) ?? null), '| restricted 条数:', restricted.length)

// 勾掉 rea
const toggle = await call('/api/app-panel/toggle', {
  url: '/api/app-panel/toggle',
  body: { session: 'sess-A', key: 'mcp:rea', enabled: false },
})
console.log('\n--- toggle mcp:rea off ---')
console.log('status:', toggle.status, 'saved:', toggle.json.saved)
console.log('rea row:', JSON.stringify(toggle.json.apps.find((a) => a.title === 'rea')))
console.log('toggle 后 restricted 条数:', restricted.length)
console.log('agent 限制:', JSON.stringify(restricted.at(-1)?.filter))

// 重新触发一次 session-start，确认限制按会话隔离
const agentB = { id: 'sess-B', ctx: { tools: { restrict: (f) => (restricted.push({ agent: 'sess-B', filter: f }), () => {}) } } }
handlers['agent/session-start']?.(agentB)
console.log('sess-B 限制（应为空/不调制）:', JSON.stringify(restricted.at(-1)))

const debug = await call('/api/app-panel/debug', { url: '/api/app-panel/debug?x=1' })
console.log('\n--- /debug ---')
console.log(JSON.stringify({ registrySize: debug.json.registrySize, hasRestrict: debug.json.hasRestrict, toolCount: debug.json.toolCount, kinds: debug.json.kinds }, null, 1))

// ── 自动发现：不重启、不改插件，新装的 MCP 行与新技能要出现在下一次 /list 里 ──
console.log('\n--- 自动发现（新装即进表）---')
const before = (await call('/api/app-panel/list', { url: '/api/app-panel/list?session=sess-A' })).json
const beforeKeys = before.apps.map((a) => a.key)
await writeFile(
  `${HOME}/cordis.patch.yml`,
  [
    '- insert:',
    "    - id: mcp-rea",
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        serverName: rea',
    "    - id: mcp-brandnew",
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        serverName: brandnew',
    "    - id: hindsight",
    "      name: '@vectorize-io/hindsight-coding-agents'",
    "    - id: tool-pwsh",
    "      name: '@deepseek-ai/dsh-tool-pwsh'",
    '',
  ].join('\n'),
)
await mkdir(`${HOME}/skills/fresh-skill`, { recursive: true })
await writeFile(
  `${HOME}/skills/fresh-skill/SKILL.md`,
  '---\nname: fresh-skill\ndescription: 刚装上的技能，应该自动出现在表里\n---\n\nbody\n',
)
const after = (await call('/api/app-panel/list', { url: '/api/app-panel/list?session=sess-A' })).json
const afterKeys = after.apps.map((a) => a.key)
console.log('新增：', afterKeys.filter((k) => !beforeKeys.includes(k)).join(', ') || '(无)')
console.log('新 MCP 进表   :', afterKeys.includes('mcp:brandnew'))
console.log('新技能进表    :', afterKeys.includes('skill:fresh-skill'))
console.log('旧条目没丢    :', beforeKeys.every((k) => afterKeys.includes(k) || k === 'mcp:unity'))

// ── 关键：插件装载之前就存在的会话（preExistingAgent，从不触发事件），
//    取消勾选后必须也被施加限制，并且 /list 的合计要真的掉下来 ──
console.log('\n--- 装载前已存在的会话（无事件，只能靠 syncLiveAgents）---')
const beforeLive = (await call('/api/app-panel/list', { url: '/api/app-panel/list?session=sess-A' })).json
console.log('勾选前合计 :', beforeLive.total.text)
const reaBefore = beforeLive.apps.find((a) => a.key === 'mcp:rea')
console.log('rea 行     :', reaBefore ? `${reaBefore.cost} / affects=${reaBefore.affects}` : '(缺)')
const toggle2 = await call('/api/app-panel/toggle', {
  url: '/api/app-panel/toggle',
  body: { session: 'sess-A', key: 'mcp:rea', enabled: false },
})
const reaAfter = toggle2.json.apps.find((a) => a.key === 'mcp:rea')
console.log('勾掉 rea 后 :', toggle2.json.total.text, '| rea 行:', reaAfter ? `${reaAfter.cost} / affects=${reaAfter.affects}` : '(缺)')
// 关掉之后复选框必须还能点（否则就是单向开关：关了就再也勾不回来）
console.log('关掉后仍可勾选(affects) :', reaAfter?.affects === true, '| 提示勾上能加多少:', /勾上 \+\d+/.test(reaAfter?.cost ?? '') || /勾上 \+[\d.]+ (KB|MB)/.test(reaAfter?.cost ?? ''))
console.log('syncLiveAgents:', JSON.stringify(toggle2.json.sync))
console.log('未触发事件的会话是否被限制: ' + JSON.stringify(restricted.filter((r) => r.agent === 'sess-A(pre)').length > 0))
// 合计随勾选真的动：开 rea → 变大；关 rea → 变小
const onRea = await call('/api/app-panel/toggle', {
  url: '/api/app-panel/toggle',
  body: { session: 'sess-A', key: 'mcp:rea', enabled: true },
})
const offRea = await call('/api/app-panel/toggle', {
  url: '/api/app-panel/toggle',
  body: { session: 'sess-A', key: 'mcp:rea', enabled: false },
})
console.log('开 rea 合计 :', onRea.json.total.text, '| rea 行:', onRea.json.apps.find((a) => a.key === 'mcp:rea')?.cost)
console.log('关 rea 合计 :', offRea.json.total.text, '| rea 行:', offRea.json.apps.find((a) => a.key === 'mcp:rea')?.cost)
console.log('合计随勾选下降 :', onRea.json.total.bytes > offRea.json.total.bytes)

// ── 不依赖注册表的路径：一个不在 agents.list() 里的会话，靠 agent/inbox/claimed 兜住 ──
const eventOnlyAgent = {
  id: 'sess-E',
  ctx: {
    tools: {
      restrict(filter) {
        restricted.push({ agent: 'sess-E', filter })
        return () => {}
      },
    },
  },
}
await call('/api/app-panel/toggle', {
  url: '/api/app-panel/toggle',
  body: { session: 'sess-E', key: 'mcp:rea', enabled: false },
})
console.log('\n--- 注册表拿不到的会话（desktop 就是这种），靠每步事件同步 ---')
console.log('同步前受限 :', restricted.some((r) => r.agent === 'sess-E'))
handlers['agent/inbox/claimed']?.({ agent: eventOnlyAgent })
console.log('事件后受限 :', restricted.some((r) => r.agent === 'sess-E'), JSON.stringify(restricted.filter((r) => r.agent === 'sess-E').at(-1)?.filter))
const beforeRepeat = restricted.filter((r) => r.agent === 'sess-E').length
handlers['agent/inbox/claimed']?.({ agent: eventOnlyAgent })
console.log('重复事件不重复施加 :', restricted.filter((r) => r.agent === 'sess-E').length === beforeRepeat)

// ── 单个工具（内置、无统一前缀）也能关，走精确名字 ──
console.log('\n--- 单个工具（tool:<名字>）---')
const pwshRow = list1.json.apps.find((a) => a.kind === '工具' && a.title === 'pwsh')
console.log('pwsh 成行 :', pwshRow ? `${pwshRow.cost} affects=${pwshRow.affects} key=${pwshRow.key}` : '(缺)')
const offPwsh = await call('/api/app-panel/toggle', {
  url: '/api/app-panel/toggle',
  body: { session: 'sess-A', key: 'tool:pwsh', enabled: false },
})
const mask = restricted.filter((r) => r.agent === 'sess-A(pre)').at(-1)?.filter
console.log('deny 里有精确名 pwsh :', Array.isArray(mask?.deny) && mask.deny.includes('pwsh'), JSON.stringify(mask?.deny?.slice(0, 4)))
console.log('合计随之下降 :', offPwsh.json.total.toolBytes < onRea.json.total.toolBytes)

// ── 技能目录消息里的条目会被删掉（真省 + 免得模型白撞守卫）──
console.log('\n--- 技能目录裁剪（agent/pre-step）---')
await call('/api/app-panel/toggle', {
  url: '/api/app-panel/toggle',
  body: { session: 'sess-K', key: 'skill:blocked-skill', enabled: false },
})
const catalogMessage = {
  id: 'm1',
  source: { kind: 'skill-catalog', form: 'catalog', entries: [{ name: 'blocked-skill' }, { name: 'kept-skill' }] },
  content: [
    {
      type: 'text',
      text: [
        '<system-reminder>',
        '<available_skills>',
        '- `blocked-skill`: 不该再出现在目录里',
        '- `kept-skill`: 保留',
        '</available_skills>',
        '</system-reminder>',
      ].join('\n'),
    },
  ],
}
const decision = { kind: 'ok', messages: [catalogMessage, { id: 'm2', content: [{ type: 'text', text: '用户消息' }] }] }
const out = await handlers['agent/pre-step']({ agent: { id: 'sess-K' }, messages: [], signal: undefined }, async () => decision)
const outText = JSON.stringify(out)
console.log('blocked-skill 已从目录文本消失 :', !outText.includes('不该再出现在目录里'))
console.log('保留的条目还在 :', outText.includes('kept-skill'))
console.log('entries 摘要未动（否则宿主会重渲染）:', JSON.stringify(out.messages[0].source.entries).includes('blocked-skill'))
console.log('其它消息未被破坏 :', out.messages.length === 2 && out.messages[1].content[0].text === '用户消息')

// 关掉的技能，其目录体积要从合计里精确扣掉（否则又是自相矛盾的数字）
const sessS = 'sess-S'
const b1 = (await call('/api/app-panel/list', { url: `/api/app-panel/list?session=${sessS}` })).json
const target = b1.apps.find((a) => a.kind === '技能')
if (target) {
  await call('/api/app-panel/toggle', {
    url: '/api/app-panel/toggle',
    body: { session: sessS, key: target.key, enabled: false },
  })
  const b2 = (await call('/api/app-panel/list', { url: `/api/app-panel/list?session=${sessS}` })).json
  const row = b2.apps.find((a) => a.key === target.key)
  console.log('\n--- 技能关掉后的数字 ---')
  console.log('技能行文案 :', row.cost)
  console.log(
    '技能目录体积精确扣除 :',
    b1.total.skillBytes - b2.total.skillBytes === target.costBytes,
    `(${b1.total.skillBytes} → ${b2.total.skillBytes}，该技能 ${target.costBytes} B)`,
  )
}

// 通用排障：一步走过之后，应该能看到这步的消息是从哪来的、多大
const dbg = (await call('/api/app-panel/debug')).json
console.log('\n--- 通用排障（新装应用不用再改代码）---')
console.log('lastStepMessages :', JSON.stringify(dbg.lastStepMessages))
console.log('skillsStripped   :', dbg.skillsStripped, '| stepEvents:', dbg.stepEvents, '| lastDiscoveryError:', dbg.lastDiscoveryError)

// 技能中心自己关掉的技能：不进目录、也不该算进合计
await writeFile(
  `${HOME}/dsh-skill-hub.json`,
  JSON.stringify({ version: 4, disabled: ['hindsight-coding-agent'], config: {}, tags: [] }),
)
const hubList = (await call('/api/app-panel/list', { url: '/api/app-panel/list?session=sess-H' })).json
const hubRow = hubList.apps.find((a) => a.title === 'hindsight-coding-agent')
console.log('\n--- 技能中心已关的技能 ---')
console.log('行文案     :', hubRow?.cost)
console.log('不计入合计 :', hubRow?.costBytes === 0, '| 技能目录体积:', hubList.total.skillBytes)

dispose()
await rm(HOME, { recursive: true, force: true })
console.log('\nOK')
