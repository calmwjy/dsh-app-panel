/**
 * dsh-app-panel — host half.
 *
 * 目的：把「这台机器给 DSH 挂了哪些应用、各自吃多少 token」变成可见、可控的东西。
 * 面板（浏览器半边）读这里的 /api/app-panel/*；勾选状态按会话存盘，并用
 * @deepseek-ai/dsh-tools 的 per-agent 工具限制真正生效：没勾的应用，它的工具
 * 不会出现在那个会话的模型请求里（连带它的 schema token 一起省掉）。
 *
 * 设计取舍：
 *  - 只做「按 agent 屏蔽工具」这一种执行手段。它不改任何 patch／不动别人的挂载，
 *    默认全开 = 与今天完全一致，取消勾选才是减法，随时可逆。
 *  - 发现是读文件（~/.dsh 下的 patch 与 profile 清单 + skills 目录），所以新装的
 *    应用下次装载就自动出现在表里，不需要改本插件。
 *  - apply 内部全部 try/catch：外部插件在 apply 里抛错会让整个 Web 外壳启动失败。
 */

import { readFile, writeFile, appendFile, mkdir, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { load as loadYaml } from 'js-yaml'

export const name = 'app-panel'
/**
 * webServer: 注册 /api 路由；tools: 按 agent 限制工具可见性；
 * agents: dsh-agent 的注册表（ctx.agents.list()）—— 没有它我就只能靠事件覆盖
 * "插件装载之后"创建的会话，装载前就存在的会话（比如启动时恢复的那个）会漏掉，
 * 表现就是"勾了没反应"。**访问未 inject 的服务属性会直接抛**，所以这个必须写上，
 * 光靠 try/catch 兜住是不够的（那样只会静默拿到空列表）。
 */
export const inject = ['webServer', 'tools', 'agents']

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const STATE_FILE = join(DSH_HOME, 'app-panel.json')
/** 每次装载写一份心跳：不用认证就能从磁盘确认"宿主真的把这个插件载进来了"。 */
const BOOT_FILE = join(DSH_HOME, 'app-panel.boot.json')
/** 浏览器半边自报的行（挂载成功/失败都写），用于在 GUI 里出问题时不用开控制台也能定位。 */
const CLIENT_LOG = join(DSH_HOME, 'app-panel.client.log')
const API = '/api/app-panel'

/**
 * 已知应用的简介与工具名前缀。未知应用照样登记（类型按来源推），只是简介留空、
 * 前缀从 id 猜。加一条不需要改代码以外的东西，纯属让表好看。
 */
const KNOWN = {
  rea: {
    summary: '逆向工程 MCP（CLI+MCP，170 个工具）：原生二进制/JS/Electron/APK/.NET/固件取证',
    toolPrefix: 'mcp__rea__',
    cost: '≈119k tok/请求（inputSchema 357 KB）',
  },
  unity: { summary: 'Unity 编辑器 MCP：场景/对象/资源/测试操作', toolPrefix: 'mcp__unity__', cost: '≈25k tok/请求' },
  'godot-ai': { summary: 'Godot 编辑器 MCP：节点/脚本/场景操作（需编辑器在跑）', toolPrefix: 'mcp__godot-ai__', cost: '22 个工具，未测' },
  blender: { summary: 'Blender MCP：建模/材质/渲染操作', toolPrefix: 'mcp__blender__', cost: '≈3.9k tok/请求' },
  misakanet: { summary: 'MisakaNet 失败经验库 MCP：检索/提交工程踩坑教训', toolPrefix: 'mcp__misakanet__', cost: '7 个工具' },
  hindsight: { summary: 'Hindsight 记忆插件：知识页 + 每轮注入记忆块', toolPrefix: 'hindsight_', cost: '工具 schema + ≈3 KB/轮注入' },
}

// ── 状态：{ sessions: { [sessionId]: { disabled: [appKey] } } } ──────────────
async function readState() {
  try {
    const raw = await readFile(STATE_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && parsed.sessions && typeof parsed.sessions === 'object') return parsed
  } catch {
    /* 首次运行或文件损坏：当作空 */
  }
  return { sessions: {} }
}

async function writeState(state) {
  try {
    await mkdir(DSH_HOME, { recursive: true })
    await writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf8')
    return true
  } catch {
    return false
  }
}

function disabledOf(state, sessionId) {
  const entry = state.sessions?.[sessionId]
  return new Set(Array.isArray(entry?.disabled) ? entry.disabled : [])
}

// ── 发现：这台机器挂了什么 ───────────────────────────────────────────────────
/** 插件行的工具名前缀只能猜：取包名末段，非字母数字折成下划线。猜错只会屏蔽不到，不会误伤。 */
function guessPrefix(title) {
  const tail = String(title).split('/').pop() ?? ''
  const cleaned = tail.replace(/^dsh-/, '').replace(/[^A-Za-z0-9]+/g, '_')
  return cleaned ? `${cleaned}_` : null
}

/** 把模块说明符归一成包名：'@scope/pkg/sub' -> '@scope/pkg'，'pkg/sub' -> 'pkg'。 */
function packageOf(spec) {
  const s = String(spec ?? '')
  if (s.startsWith('@')) return s.split('/').slice(0, 2).join('/')
  return s.split('/')[0]
}

function classify(item) {
  const id = String(item?.id ?? '')
  const mod = String(item?.name ?? '')
  const config = item?.config && typeof item.config === 'object' ? item.config : {}
  if (mod === '@deepseek-ai/dsh-mcp-client') {
    const server = String(config.serverName ?? id.replace(/^mcp-/, ''))
    return {
      key: `mcp:${server}`,
      kind: 'MCP',
      server,
      title: server,
      toolPrefix: `mcp__${server}__`,
      module: `mcp-client:${server}`,
      config,
    }
  }
  return { key: `plugin:${id}`, kind: '插件', server: null, title: id || mod, toolPrefix: null, module: packageOf(mod), config }
}

/** 读一个 cordis patch 文件里的 insert 行；解析失败（比如 !!js 标签）返回 []。 */
async function readPatchFile(path) {
  try {
    const text = await readFile(path, 'utf8')
    const doc = loadYaml(text)
    if (!Array.isArray(doc)) return []
    const out = []
    for (const row of doc) {
      if (!row || typeof row !== 'object') continue
      if (Array.isArray(row.insert)) {
        for (const item of row.insert) if (item && typeof item === 'object') out.push({ ...item, _from: path })
      } else if (typeof row.id === 'string' && typeof row.name === 'string') {
        out.push({ ...row, _from: path })
      }
    }
    return out
  } catch {
    return []
  }
}

async function discoverFromPatches() {
  const files = [join(DSH_HOME, 'cordis.patch.yml')]
  for (const dir of await profileDirs()) files.push(join(dir, 'cordis.patch.yml'))
  const apps = new Map()
  for (const file of files) {
    if (!existsSync(file)) continue
    for (const item of await readPatchFile(file)) {
      const app = classify(item)
      if (!apps.has(app.key)) apps.set(app.key, { ...app, sources: [item._from] })
    }
  }
  return apps
}

/**
 * 当前 profile 的目录。宿主进程的命令行里带着 profiles\<name> 这段（Electron 拉起
 * 宿主时传的），优先用它；没有就用 DSH_PROFILE；再不行才扫全部。别的 profile 挂的
 * 插件不在本会话里，混进表会误导。
 */
async function activeProfileName() {
  const fromArgv = (process.argv ?? [])
    .map((a) => /[\\/]profiles[\\/]([^\\/]+)[\\/]?$/i.exec(String(a)))
    .find(Boolean)
  if (fromArgv) return fromArgv[1]
  return process.env.DSH_PROFILE ?? null
}

async function profileDirs() {
  const profilesDir = join(DSH_HOME, 'profiles')
  const all = process.env.DSH_APP_PANEL_PROFILES === 'all'
  const active = await activeProfileName()
  try {
    const entries = await readdir(profilesDir, { withFileTypes: true })
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => join(profilesDir, e.name))
    if (all || !active) return dirs
    const mine = dirs.filter((d) => d.toLowerCase().endsWith(`\\${String(active).toLowerCase()}`))
    return mine.length > 0 ? mine : dirs
  } catch {
    return []
  }
}

/** profile 清单里的 bundle（Cordis 插件）也算应用。 */
async function discoverFromBundles() {
  const apps = new Map()
  try {
    for (const dir of await profileDirs()) {
      const pkgPath = join(dir, 'package.json')
      if (!existsSync(pkgPath)) continue
      const pkg = JSON.parse(await readFile(pkgPath, 'utf8'))
      const bundles = pkg?.dsh?.profile?.bundles
      if (!Array.isArray(bundles)) continue
      for (const b of bundles) {
        if (typeof b !== 'string' || b.startsWith('@deepseek-ai/dsh-')) continue
        const key = `bundle:${b}`
        if (!apps.has(key)) {
          apps.set(key, { key, kind: '插件', title: b, toolPrefix: null, module: packageOf(b), sources: [pkgPath] })
        }
      }
    }
  } catch {
    /* 忽略 */
  }
  return apps
}

/**
 * 技能中心（dsh-skill-hub）自己的开关文件。被它关掉的技能不会进目录消息 —— 面板必须读它，
 * 否则还会把那些技能的目录体积算进合计（虚高），和"技能中心已关"的事实打架。
 */
async function hubDisabledSkills() {
  try {
    const doc = JSON.parse(await readFile(join(DSH_HOME, 'dsh-skill-hub.json'), 'utf8'))
    return new Set((Array.isArray(doc?.disabled) ? doc.disabled : []).map(String))
  } catch {
    return new Set()
  }
}

/** 技能：开关在面板里（关掉 = 从目录消息里删掉 + 正文不可载入）。 */
async function discoverSkills() {
  const out = []
  const roots = [join(DSH_HOME, 'skills'), join(homedir(), '.agents', 'skills')]
  for (const root of roots) {
    try {
      for (const entry of await readdir(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const skillFile = join(root, entry.name, 'SKILL.md')
        if (!existsSync(skillFile)) continue
        let text = ''
        try {
          text = await readFile(skillFile, 'utf8')
        } catch {
          continue
        }
        const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
        const nameMatch = fm ? /^name:\s*(.+)$/m.exec(fm[1]) : null
        const descMatch = fm ? /^description:\s*(.+)$/m.exec(fm[1]) : null
        const unquote = (s) => String(s ?? '').trim().replace(/^["']|["']$/g, '')
        const title = unquote(nameMatch ? nameMatch[1] : entry.name) || entry.name
        const summary = unquote(descMatch ? descMatch[1] : '').slice(0, 200)
        out.push({
          key: `skill:${title}`,
          kind: '技能',
          title,
          skillName: title,
          summary,
          cost: `${fm ? fm[1].length : 0} B 目录项`,
          // 技能和工具的成本结构完全不同，分开存：
          //  目录项（name+description）是**每轮都在**的系统消息，勾掉也拿不掉（DSH 的
          //  技能目录可见性由注册作用域决定，没有 per-agent 运行时过滤器）；
          //  正文（SKILL.md 剩下的部分）只在被调用时注入 —— 勾掉才真正省下这块。
          catalogBytes: fm ? fm[1].length : 0,
          bodyBytes: Math.max(0, text.length - (fm ? fm[0].length : 0)),
          readonly: false,
          toolPrefix: null,
        })
      }
    } catch {
      /* 没有这个 root */
    }
  }
  return out
}

/**
 * 技能的**权威来源**：ctx.skills 注册表（含 bundle 自带、远程 provider 提供的技能，
 * 不只是磁盘上的目录）。新装一个技能后，磁盘扫描可能扫不到（比如它由某个 bundle 或
 * provider 提供），这里补上 —— 这样"装了就在表里、就能关"不需要每次改代码。
 * 合并规则：注册表为准（名字/描述），磁盘那份只用来补正文体积。
 */
async function discoverSkillsFromRegistry(ctx) {
  const out = []
  try {
    const list = await ctx?.skills?.list?.({})
    if (!Array.isArray(list)) return out
    for (const s of list) {
      const title = String(s?.name ?? '').trim()
      if (!title) continue
      const summary = String(s?.description ?? '').slice(0, 200)
      // 目录里那一行大致是 "- `name`: description"（加换行与反引号）
      const catalogBytes = title.length + summary.length + 8
      const body = typeof s?.content === 'string' ? s.content.length : 0
      out.push({
        key: `skill:${title}`,
        kind: '技能',
        title,
        skillName: title,
        summary,
        cost: `${catalogBytes} B 目录项`,
        catalogBytes,
        bodyBytes: body,
        invocation: s?.invocation ?? null,
        fromRegistry: true,
        readonly: false,
        toolPrefix: null,
      })
    }
  } catch (e) {
    lastDiscoveryError = `skills: ${String((e && e.message) || e)}`
  }
  return out
}

// ── 当前可见工具 → 每个应用的实时 token 体积 ─────────────────────────────────
function visibleToolNames(ctx) {
  const names = []
  try {
    const schemas = ctx.tools?.schemas?.()
    if (Array.isArray(schemas)) {
      for (const s of schemas) {
        const n = s?.name ?? s?.function?.name
        if (typeof n === 'string') names.push({ name: n, bytes: JSON.stringify(s).length })
      }
    }
  } catch {
    /* 拿不到就当空 */
  }
  return names
}

/** 应用对应的工具名前缀：已知表 → 自身声明 → 按名字猜。 */
function prefixOf(app) {
  return app.toolPrefix ?? KNOWN[app.title]?.toolPrefix ?? KNOWN[app.server]?.toolPrefix ?? guessPrefix(app.title)
}

/**
 * 前缀认不出来时，拿应用名自己的词去工具表里试（hindsight-coding-agents → hindsight_）。
 * 认前缀是为了把工具**归到应用那一行**；归不上的工具不会消失，会各自成行（见 listPayload）。
 */
function inferPrefix(app, tools) {
  const words = String(app?.title ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3)
  for (const w of words) {
    if (tools.some((t) => t.name.startsWith(`mcp__${w}__`) || t.name.startsWith(`${w}_`) || t.name === w)) {
      return tools.some((t) => t.name.startsWith(`mcp__${w}__`)) ? `mcp__${w}__` : `${w}_`
    }
  }
  return null
}

/** 真正用于归属与屏蔽的前缀（认得出来才有）。 */
function effectivePrefix(app, tools) {
  return prefixOf(app) ?? inferPrefix(app, tools)
}

function costForApp(app, tools, prefixOverride) {
  const prefix = prefixOverride !== undefined ? prefixOverride : prefixOf(app)
  if (!prefix) return { tools: 0, bytes: 0 }
  let count = 0
  let bytes = 0
  for (const t of tools) {
    if (t.name.startsWith(prefix)) {
      count += 1
      bytes += t.bytes
    }
  }
  return { tools: count, bytes }
}

function kb(n) {
  if (n >= 1024 * 1024) return `${(n / 1048576).toFixed(1)} MB`
  if (n >= 1024) return `${Math.round(n / 1024)} KB`
  return `${n} B`
}

/**
 * 简介缩到一小句。技能的 description 是写给模型判断"什么时候该用我"的，惯例是
 * "是什么" + "用于…/Use when…"触发条件 —— 后半段对看表的人是噪音，切掉。
 * 全文不放这里，进 hover 提示（客户端 title）。
 */
function shortSummary(text, max = 42) {
  const s = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!s) return ''
  const head = s.split(/(?:[。；;]|\.\s|Use when|Use on|Use for|用于|适用于|適用)/i)[0].trim()
  const base = head.length >= 6 ? head : s
  return base.length > max ? `${base.slice(0, max - 1)}…` : base
}

// ── 执行：按 agent 屏蔽工具 ─────────────────────────────────────────────────
const live = new Map() // sessionId -> { agent, disposer }

/** 记下最近一次失败原因：这类错误以前被静默吞掉，害我查了好几轮。 */
let lastApplyError = null
/** 每步同步事件被调用过几次（证明事件面到底通不通）。 */
let stepEvents = 0
/** 技能目录被裁剪过几次（证明"关掉技能"真的少发了东西）。 */
let skillsStripped = 0
/** 最近一次发现失败的原因（比如技能注册表读不到）。 */
let lastDiscoveryError = null
/** 技能中心关掉的技能名（这些不进目录消息，也不该算进合计）。 */
let hubDisabled = new Set()
/**
 * 最近一步的提示词消息概况：谁注入了什么、多大。
 * 用途是**通用排障**：将来新装一个会往提示词里塞东西的应用，看一眼就知道它走哪条通道、
 * 占多少 —— 不用再为它单独调一次代码。
 */
let lastStepMessages = null

/**
 * 取会话 id。**逐个候选惰性求值**，每个都单独兜住：急着把候选放进数组里
 * （agent?.ctx?.scope?.key 这种）会先算一遍，而 Cordis 上访问未 inject 的服务
 * 属性会直接抛 —— 一抛整个函数就炸，注册表路径与每步事件路径会一起静默失效。
 */
function firstString(...getters) {
  for (const get of getters) {
    try {
      const value = get()
      if (typeof value === 'string' && value) return value
    } catch {
      /* 这个取法在这个 agent 上不可用，换下一个 */
    }
  }
  return null
}

function sessionIdOf(agent) {
  return (
    firstString(
      () => agent?.id,
      () => agent?.sessionId,
      () => agent?.session?.id,
      () => agent?.record?.id,
      () => agent?.agent?.id,
    ) ?? 'unknown'
  )
}

/** 每个会话当前已施加的选择签名：一样就不重复施加（事件很频繁）。 */
const appliedSignature = new Map()

function signatureOf(sessionId) {
  return [...disabledOf(state, sessionId)].sort().join('|')
}

function applyRestriction(agent, state, ctx) {
  const sessionId = sessionIdOf(agent)
  const disabled = disabledOf(state, sessionId)
  const tools = visibleToolNames(ctx)
  const deny = new Set()
  const deniedSkills = []
  for (const [key, app] of registry.entries()) {
    if (!disabled.has(key)) continue
    if (app.kind === '技能') {
      const name = app.skillName ?? app.title.replace(/^"|"$/g, '')
      if (name) deniedSkills.push(name)
      continue
    }
    const prefix = effectivePrefix(app, tools)
    if (!prefix) continue
    for (const t of tools) if (t.name.startsWith(prefix)) deny.add(t.name)
  }
  // 逐个关掉的内置工具：key 就是精确名字
  for (const key of disabled) if (key.startsWith('tool:')) deny.add(key.slice(5))
  const prev = live.get(sessionId)
  if (prev?.disposer) {
    try {
      prev.disposer()
    } catch {
      /* 已经失效 */
    }
  }
  if (prev?.skillDisposer) {
    try {
      prev.skillDisposer()
    } catch {
      /* 已经失效 */
    }
  }
  let disposer
  let skillDisposer
  try {
    if (deny.size > 0) disposer = agent.ctx.tools.restrict({ deny: [...deny] })
  } catch {
    disposer = undefined
  }
  // 技能没有独立工具，只能拦 skill 工具的调用参数：勾掉哪个就拒哪个。
  try {
    if (deniedSkills.length > 0 && typeof agent.ctx.tools.guard === 'function') {
      const blocked = new Set(deniedSkills)
      skillDisposer = agent.ctx.tools.guard((execution) => {
        const toolName = execution?.name ?? execution?.tool ?? execution?.definition?.name
        if (toolName !== 'skill') return undefined
        const args = execution?.arguments ?? execution?.args ?? execution?.input ?? {}
        const wanted = args?.name ?? args?.skill ?? args?.id
        return typeof wanted === 'string' && blocked.has(wanted) ? `该技能在本会话被关闭（应用面板）` : undefined
      })
    }
  } catch {
    skillDisposer = undefined
  }
  live.set(sessionId, { agent, disposer, skillDisposer })
  appliedSignature.set(sessionId, signatureOf(sessionId))
  return { sessionId, denied: deny.size, deniedSkills: deniedSkills.length }
}

/**
 * 技能目录那条系统消息（<available_skills>）在 agent/pre-step 的 waterfall 上，
 * 谁都能改 `decision.messages`。把已关闭技能的条目从**文本**里删掉：
 *  1) 那一行本来每轮都在发，删掉才是真省；
 *  2) 否则模型会照着目录去调 skill，撞上守卫报错，白烧一轮。
 * 只改文本、不动 `source.entries`：entries 是宿主用来判断"目录有没有变"的摘要，
 * 动了它宿主下一步就会按完整目录重渲染，把这里删掉的又加回来。
 */
function stripSkillEntries(message, blocked) {
  try {
    const content = message?.content
    if (!Array.isArray(content)) return message
    let changed = false
    const nextContent = content.map((part) => {
      if (!part || typeof part.text !== 'string') return part
      const lines = part.text.split('\n')
      const kept = lines.filter((line) => {
        const m = /^\s*[-*]\s*`?([^`:\s]+)`?\s*:/.exec(line)
        if (!m || !blocked.has(m[1])) return true
        changed = true
        return false
      })
      return changed ? { ...part, text: kept.join('\n') } : part
    })
    return changed ? { ...message, content: nextContent } : message
  } catch {
    return message
  }
}

// ── 路由 ────────────────────────────────────────────────────────────────────
let registry = new Map()
let state = { sessions: {} }

function isLoopback(req) {
  const addr = req?.socket?.remoteAddress ?? ''
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

function send(res, status, payload) {
  const body = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}

async function readBody(req) {
  const chunks = []
  for await (const c of req) {
    chunks.push(c)
    if (chunks.reduce((n, b) => n + b.length, 0) > 256 * 1024) break
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  } catch {
    return {}
  }
}

/** 活着的 agent：dsh-agent 的服务键是 ctx.agents，list() 拿全部、get(id) 拿一个。
 *  没 inject 就访问会抛（Cordis 行为），所以一律兜住。 */
function agentListOf(ctx) {
  try {
    const reg = ctx?.agents
    if (!reg) return []
    if (typeof reg.list === 'function') return reg.list() ?? []
    if (typeof reg.roots === 'function') return reg.roots() ?? []
  } catch {
    /* 拿不到就当没有 */
  }
  return []
}

/**
 * 提示词体积探针（只诊断，不进面板合计）。
 * 系统提示词的 persona/规则/指令这些文字是**每轮都在花**的，而且按 DSH 的设计，
 * agent/pre-step 的 waterfall 不允许替换别人注册的完整 section —— 也就是**关不掉**。
 * 这里先量出来，量准了再决定要不要进面板的表头。
 * 只算 sections/contexts/variables：assemble() 里也含 tools，算进去就重复计数了。
 */
async function promptProbe() {
  try {
    const sp = activeCtx?.reflect?.get?.('systemPrompt')
    if (!sp || typeof sp.assemble !== 'function') return { available: false }
    const assembly = await sp.assemble()
    const parts = [assembly?.sections, assembly?.contexts, assembly?.variables].filter(Boolean)
    const bytes = parts.reduce((n, p) => n + JSON.stringify(p).length, 0)
    return {
      available: true,
      bytes,
      kb: Math.round(bytes / 1024),
      shape: Object.keys(assembly ?? {}),
    }
  } catch (e) {
    return { available: false, error: String((e && e.message) || e) }
  }
}

function listPayload(sessionId) {
  const all = visibleToolNames(activeCtx)
  const disabled = disabledOf(state, sessionId)
  // 本会话真正会发出去的工具 = 全局可见 − 本会话被屏蔽的。勾掉之后数字要真的掉，
  // 否则面板就是在骗人（之前只显示全局视图，勾了数字不动）。
  const prefixOfApp = new Map()
  for (const [key, app] of registry.entries()) {
    prefixOfApp.set(key, effectivePrefix(app, all))
  }
  const deniedPrefixes = []
  const deniedNames = new Set()
  for (const [key, app] of registry.entries()) {
    if (!disabled.has(key)) continue
    if (app.kind === '技能') continue
    const prefix = prefixOfApp.get(key)
    if (prefix) deniedPrefixes.push(prefix)
  }
  // 单独关掉的一个工具（key = tool:<名字>）走精确名字
  for (const key of disabled) if (key.startsWith('tool:')) deniedNames.add(key.slice(5))
  const tools = all.filter(
    (t) => !deniedNames.has(t.name) && !deniedPrefixes.some((p) => t.name.startsWith(p)),
  )
  const apps = []
  for (const app of registry.values()) {
    // 两份成本，别混用：
    //  session 这份 = 本会话当前真发出去的量（用来显示"消耗"和合计）
    //  global  这份 = 这台宿主里它到底有没有工具（用来决定复选框能不能点）
    // 混用过的后果很蠢：勾掉之后它在会话视图里就"没有工具"了 → 复选框被置灰 →
    // 变成单向开关，关掉再也勾不回来。
    const prefix = prefixOfApp.get(app.key)
    const sessionCost = costForApp(app, tools, prefix)
    const globalCost = costForApp(app, all, prefix)
    const meta = KNOWN[app.title] ?? KNOWN[app.server] ?? {}
    const isSkill = app.kind === '技能'
    const affects = isSkill || globalCost.tools > 0
    const fullSummary = String(app.summary ?? meta.summary ?? '').replace(/\s+/g, ' ').trim()
    apps.push({
      key: app.key,
      kind: app.kind,
      title: app.title,
      summary: shortSummary(fullSummary),
      summaryFull: fullSummary, // hover 看全文
      enabled: !disabled.has(app.key),
      readonly: app.readonly === true,
      affects,
      tools: sessionCost.tools,
      cost: isSkill
        ? hubDisabled.has(app.skillName ?? app.title)
          ? '技能中心已关' // 它自己就没进目录，别再按占目录算钱
          : disabled.has(app.key)
            ? '关 · 目录已移除' // 目录条目在 pre-step 里被删掉了，不再每轮发
            : `${kb(app.catalogBytes ?? 0)} 目录 · 正文 ${kb(app.bodyBytes ?? 0)}`
        : sessionCost.tools > 0
          ? `${kb(sessionCost.bytes)} · ${sessionCost.tools} 工具`
          : globalCost.tools > 0
            ? `关（勾上 +${kb(globalCost.bytes)}）`
            : app.kind === 'MCP'
              ? '服务器未连'
              : isSkill
                ? '无'
                : '无工具', // 别再写"未装载"：插件装着，只是它不注册工具（可能只在提示词里花）
      expect: meta.cost ?? null,
      costBytes: isSkill
        ? hubDisabled.has(app.skillName ?? app.title) || disabled.has(app.key)
          ? 0
          : (app.catalogBytes ?? 0)
        : sessionCost.bytes,
      sources: app.sources ?? [],
    })
  }
  // 没被任何应用认领的工具各自成行 —— 内置工具（read/pwsh/subagent/workflow…）没有统一
  // 前缀，靠前缀归不进任何一行；以前它们干脆不出现在面板里，等于"关不掉"。现在逐个可关。
  const claimed = new Set()
  for (const prefix of prefixOfApp.values()) {
    if (!prefix) continue
    for (const t of tools) if (t.name.startsWith(prefix)) claimed.add(t.name)
  }
  for (const t of tools) {
    if (claimed.has(t.name)) continue
    apps.push({
      key: `tool:${t.name}`,
      kind: '工具',
      title: t.name,
      summary: '单个工具：关掉后它不进本会话的请求',
      enabled: !disabled.has(`tool:${t.name}`),
      readonly: false,
      affects: true,
      tools: 1,
      cost: `${kb(t.bytes)} · 1 工具`,
      expect: null,
      costBytes: t.bytes,
      sources: [],
    })
  }
  apps.sort((a, b) => a.kind.localeCompare(b.kind) || a.title.localeCompare(b.title))
  const toolBytes = tools.reduce((n, t) => n + t.bytes, 0)
  // 技能目录项是每轮都在的系统消息。**关掉的技能其条目已被 pre-step 删掉**，
  // 所以这里只累加还开着的；技能正文不计（只在被调用时才进上下文）。
  const skillBytes = [...registry.values()]
    .filter((a) => a.kind === '技能' && !disabled.has(a.key) && !hubDisabled.has(a.skillName ?? a.title))
    .reduce((n, a) => n + (a.catalogBytes ?? 0), 0)
  const totalBytes = toolBytes + skillBytes
  return {
    sessionId,
    apps,
    total: {
      bytes: totalBytes,
      toolBytes,
      skillBytes,
      text: `${kb(totalBytes)} ≈ ${Math.round(totalBytes / 3.6).toLocaleString()} tok/请求（工具 ${kb(toolBytes)} + 技能目录 ${kb(skillBytes)}）`,
    },
    liveSessions: [...live.keys()],
  }
}

let activeCtx = null

export function apply(ctx) {
  activeCtx = ctx
  const disposers = []

  const refresh = async () => {
    hubDisabled = await hubDisabledSkills()
    // 技能：注册表（权威，含 bundle/远程来源）+ 磁盘（用来补正文体积）。
    // 注册表里有的以注册表为准；只在磁盘上的（老式手装目录）也保留。
    const registrySkills = await discoverSkillsFromRegistry(ctx)
    const diskByName = new Map((await discoverSkills()).map((s) => [s.skillName, s]))
    const mergedSkills = registrySkills.map((s) => {
      const disk = diskByName.get(s.skillName)
      if (!disk) return s
      diskByName.delete(s.skillName)
      return { ...s, bodyBytes: s.bodyBytes || disk.bodyBytes, onDisk: true }
    })
    const found = [
      ...(await discoverFromPatches()).values(),
      ...(await discoverFromBundles()).values(),
      ...mergedSkills,
      ...diskByName.values(),
    ]
    // 同一个包可能同时出现在 patch 行和 profile 清单里（比如本插件自己）：
    // 按包名归一后合并成一行，保留信息更多的那条（MCP/带工具前缀的优先）。
    const byModule = new Map()
    for (const app of found) {
      const id = app.module ?? app.key
      const prev = byModule.get(id)
      if (!prev) {
        byModule.set(id, app)
        continue
      }
      const better = prev.kind !== '插件' || prev.toolPrefix ? prev : app
      const other = better === prev ? app : prev
      byModule.set(id, {
        ...better,
        sources: [...new Set([...(prev.sources ?? []), ...(app.sources ?? [])])],
        summary: better.summary ?? other.summary,
      })
    }
    registry = new Map([...byModule.values()].map((a) => [a.key, a]))
    state = await readState()
  }

  // 会话创建/启动：把该会话的选择变成实际的工具限制。
  // 事件签名是 (payload: { agent }) —— 不是 agent 本身（dsh-agent 类型：
  // 'agent/created'(this: Scoped<Agent>, payload: { agent: Agent })）。原来直接当
  // agent 用，结果每个 agent 的 id 都读成 'unknown'，按会话限制形同虚设。
  const onAgent = (payload) => {
    try {
      const agent = payload?.agent ?? payload
      if (agent) applyRestriction(agent, state, ctx)
    } catch (e) {
      lastApplyError = `agent-event: ${String((e && e.message) || e)}`
    }
  }
  try {
    ctx.on('agent/created', onAgent)
    ctx.on('agent/session-start', onAgent)
  } catch {
    /* 事件面不可用就退化成"只记录不生效" */
  }

  /**
   * 技能目录消息的过滤（每步一次）。pre-step 是 waterfall，**必须调 next()**，
   * 我们只在拿回 decision 之后改写消息文本，出错就原样返回，绝不拦截这一步。
   */
  try {
    ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next()
      try {
        if (!decision || decision.kind === 'reject' || !Array.isArray(decision.messages)) return decision
        // 记下这一步的消息概况（谁注入、多大）—— 通用排障，不针对任何具体应用。
        lastStepMessages = decision.messages.slice(0, 12).map((m) => {
          let bytes = 0
          try {
            bytes = JSON.stringify(m?.content ?? '').length
          } catch {
            /* 忽略 */
          }
          return { source: m?.source?.kind ?? null, role: m?.role ?? null, bytes }
        })
        const sessionId = sessionIdOf(payload?.agent)
        const blocked = new Set(
          [...disabledOf(state, sessionId)]
            .filter((k) => k.startsWith('skill:'))
            .map((k) => k.slice(6)),
        )
        if (blocked.size === 0) return decision
        let changed = false
        const messages = decision.messages.map((m) => {
          if (m?.source?.kind !== 'skill-catalog') return m
          const filtered = stripSkillEntries(m, blocked)
          if (filtered !== m) changed = true
          return filtered
        })
        if (!changed) return decision
        skillsStripped += 1
        return { ...decision, messages }
      } catch {
        return decision
      }
    })
  } catch {
    /* 事件面不可用 */
  }

  /**
   * 把选择重新施加到**所有活着的 agent**。事件只覆盖"插件装载之后"创建的会话，
   * 而用户要取消勾选的往往正是当前这个会话（它可能比插件先存在）——不做这一步，
   * 勾选就只能等下次开会话才生效，看起来像没用。
   */
  const syncLiveAgents = () => {
    const agents = agentListOf(ctx)
    let applied = 0
    for (const agent of agents) {
      try {
        applyRestriction(agent, state, ctx)
        applied += 1
      } catch (e) {
        lastApplyError = `sync: ${String((e && e.message) || e)}`
      }
    }
    return { liveAgents: agents.length, applied, error: lastApplyError }
  }

  /**
   * 不依赖注册表的同步点：`agent/inbox/claimed` 是普通 emit（不是 waterfall，
   * 不会卡住 agent 循环），每步都带 `payload.agent` —— 包括插件装载之前就存在的
   * 会话。于是即便 ctx.agents 拿不到（desktop 宿主那边就是这样），用户在面板里
   * 取消勾选后，该会话的**下一条消息**就会按新选择重新施加限制。
   */
  const onStepSync = (payload) => {
    try {
      stepEvents += 1
      const agent = payload?.agent ?? payload
      if (!agent) return
      const sessionId = sessionIdOf(agent)
      if (appliedSignature.get(sessionId) !== signatureOf(sessionId)) {
        applyRestriction(agent, state, ctx)
      }
    } catch (e) {
      lastApplyError = `step: ${String((e && e.message) || e)}`
    }
  }
  try {
    ctx.on('agent/inbox/claimed', onStepSync)
  } catch {
    /* 事件面不可用 */
  }

  const route = (path, methods, handler) => {
    try {
      disposers.push(ctx.webServer.register({ kind: 'exact', path, handler }))
    } catch {
      /* 路由注册失败不该拖垮插件 */
    }
  }

  route(`${API}/list`, ['GET'], async (req, res) => {
    if (!isLoopback(req)) return send(res, 403, { error: 'loopback only' })
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      await refresh()
      syncLiveAgents()
      send(res, 200, listPayload(url.searchParams.get('session') ?? 'unknown'))
    } catch (e) {
      send(res, 500, { error: String(e?.message ?? e) })
    }
  })

  route(`${API}/toggle`, ['POST'], async (req, res) => {
    if (!isLoopback(req)) return send(res, 403, { error: 'loopback only' })
    try {
      const body = await readBody(req)
      const sessionId = String(body.session ?? 'unknown')
      const key = String(body.key ?? '')
      const enabled = body.enabled !== false
      if (!sessionId || !key) return send(res, 400, { error: 'session and key are required' })
      state = await readState()
      const entry = state.sessions[sessionId] ?? (state.sessions[sessionId] = { disabled: [] })
      const set = new Set(Array.isArray(entry.disabled) ? entry.disabled : [])
      if (enabled) set.delete(key)
      else set.add(key)
      entry.disabled = [...set]
      const saved = await writeState(state)
      // 先直接推给已跟踪的那个 agent，再把所有活着的 agent 同步一遍
      const agent = live.get(sessionId)?.agent
      const direct = agent ? applyRestriction(agent, state, ctx) : null
      const sync = syncLiveAgents()
      send(res, 200, {
        ok: true,
        saved,
        applied: direct,
        sync,
        liveKeys: [...live.keys()],
        disabledNow: [...disabledOf(state, sessionId)],
        ...listPayload(sessionId),
      })
    } catch (e) {
      send(res, 500, { error: String(e?.message ?? e) })
    }
  })

  // 浏览器半边的自报行：挂载成功/失败都落盘，GUI 里出问题时我能直接读文件定位。
  route(`${API}/client-log`, ['POST'], async (req, res) => {
    if (!isLoopback(req)) return send(res, 403, { error: 'loopback only' })
    try {
      const body = await readBody(req)
      const line = `${new Date().toISOString()} ${String(body.event ?? 'event')} ${JSON.stringify(body.detail ?? {})}\n`
      await mkdir(DSH_HOME, { recursive: true })
      await appendFile(CLIENT_LOG, line, 'utf8')
      send(res, 200, { ok: true })
    } catch (e) {
      send(res, 500, { error: String(e?.message ?? e) })
    }
  })

  // 诊断：重启后我先看这个，确认事件面/工具面真的挂上了。
  route(`${API}/debug`, ['GET'], async (req, res) => {
    if (!isLoopback(req)) return send(res, 403, { error: 'loopback only' })
    try {
      await refresh()
      const tools = visibleToolNames(ctx)
      send(res, 200, {
        plugin: 'dsh-app-panel',
        dshHome: DSH_HOME,
        stateFile: STATE_FILE,
        hasWebServer: Boolean(ctx.webServer),
        hasTools: Boolean(ctx.tools),
        hasSchemas: typeof ctx.tools?.schemas === 'function',
        hasRestrict: typeof ctx.tools?.restrict === 'function',
        toolCount: tools.length,
        sampleTools: tools.slice(0, 8).map((t) => t.name),
        registrySize: registry.size,
        kinds: [...registry.values()].map((a) => `${a.kind}:${a.title}`),
        liveSessions: [...live.entries()].map(([id, v]) => ({ id, denied: v.disposer ? 'yes' : 'no' })),
        appliedSignatures: [...appliedSignature.entries()].map(([id, sig]) => ({ id, sig })),
        stepEvents,
        skillsStripped,
        lastDiscoveryError,
        lastStepMessages,
        promptProbe: await promptProbe(),
        lastApplyError,
        agentRegistry: (() => {
          try {
            const list = agentListOf(ctx)
            return { available: Boolean(ctx.agents), count: list.length, ids: list.map((a) => sessionIdOf(a)) }
          } catch {
            return { available: false, count: 0, ids: [] }
          }
        })(),
        // 服务可达性探针：ctx.agents 到底是"没 inject 就抛"还是"根本没这个服务"，
        // 以及能不能从 reflect（不抛的取法）或 root 拿回来。
        serviceProbe: (() => {
          const out = {}
          const attempt = (label, fn) => {
            try {
              out[label] = fn()
            } catch (e) {
              out[label] = 'throw: ' + String(e?.message ?? e)
            }
          }
          attempt('typeofCtxAgents', () => typeof ctx.agents)
          attempt('reflectAgents', () => {
            const v = ctx.reflect?.get?.('agents')
            return v ? 'ok' : String(v)
          })
          attempt('rootReflectAgents', () => {
            const v = ctx.root?.reflect?.get?.('agents')
            return v ? 'ok' : String(v)
          })
          attempt('rootCtxAgents', () => typeof ctx.root?.agents)
          attempt('injectList', () => JSON.stringify(inject))
          return out
        })(),
      })
    } catch (e) {
      send(res, 500, { error: String(e?.message ?? e) })
    }
  })

  // 启动即预热一次，避免首屏空白。
  void refresh()

  // 心跳：证明宿主载入了本插件，并记录这次装载看到的东西（排查用，不参与逻辑）。
  void (async () => {
    try {
      await refresh()
      // 装载瞬间就同步一次：把选择施加到**已经存在**的会话上（事件覆盖不到它们）。
      const synced = syncLiveAgents()
      const tools = visibleToolNames(ctx)
      const kinds = {}
      for (const app of registry.values()) kinds[app.kind] = (kinds[app.kind] ?? 0) + 1
      const costs = [...registry.values()]
        .map((a) => ({ key: a.key, kind: a.kind, ...costForApp(a, tools) }))
        .filter((c) => c.tools > 0)
        .sort((x, y) => y.bytes - x.bytes)
        .slice(0, 12)
      await writeFile(
        BOOT_FILE,
        JSON.stringify(
          {
            plugin: 'dsh-app-panel',
            loadedAt: new Date().toISOString(),
            pid: process.pid,
            dshHome: DSH_HOME,
            profile: process.env.DSH_PROFILE ?? null,
            activeProfile: await activeProfileName(),
            hasTools: Boolean(ctx.tools),
            hasSchemas: typeof ctx.tools?.schemas === 'function',
            hasRestrict: typeof ctx.tools?.restrict === 'function',
            hasGuard: typeof ctx.tools?.guard === 'function',
            visibleTools: tools.length,
            toolSchemaBytes: tools.reduce((n, t) => n + t.bytes, 0),
            registry: { total: registry.size, kinds },
            syncedAgents: synced,
            lastApplyError,
            topCosts: costs.map((c) => ({ key: c.key, tools: c.tools, kb: Math.round(c.bytes / 1024) })),
            apps: [...registry.values()].map((a) => a.key),
          },
          null,
          2,
        ),
        'utf8',
      )
    } catch {
      /* 心跳写不了也不能影响启动 */
    }
  })()

  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* 忽略 */
      }
    }
    for (const [, v] of live) {
      try {
        v.disposer?.()
      } catch {
        /* 忽略 */
      }
      try {
        v.skillDisposer?.()
      } catch {
        /* 忽略 */
      }
    }
    live.clear()
  }
}
