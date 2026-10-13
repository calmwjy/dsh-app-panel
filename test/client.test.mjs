// 用假 window + 假 React 跑 dsh-app-panel 的浏览器半边：信封是否能注册、apply
// 是否挂上标签类型与槽、表面能否画出「名称/类型/简介/消耗」和带勾选的行，
// 以及三种会话 id 情形（槽位给了 / 没给但宿主只有一个活动会话 / 给了多个对不上）。
import { readFile } from 'node:fs/promises'

let definition = null
const listeners = {}
const fakeWindow = {
  __ModuleLoader__: { load: (d) => (definition = d) },
  addEventListener: (type, fn) => {
    ;(listeners[type] = listeners[type] || []).push(fn)
  },
  removeEventListener: (type, fn) => {
    listeners[type] = (listeners[type] || []).filter((f) => f !== fn)
  },
  localStorage: { getItem: () => null, setItem: () => {} },
}

let store = []
let cursor = 0
let effects = []
class StubComponent {
  constructor(props) {
    this.props = props || {}
    this.state = {}
  }
  setState(next) {
    this.state = Object.assign({}, this.state, typeof next === 'function' ? next(this.state) : next)
  }
}
const stubReact = {
  Component: StubComponent,
  createElement: (type, props, ...children) => {
    const merged = Object.assign({}, props)
    if (children.length === 1) merged.children = children[0]
    else if (children.length > 1) merged.children = children
    return {
      type: typeof type === 'function' ? type.name || 'fn' : type,
      fn: typeof type === 'function' ? type : null,
      props: merged,
      children: merged.children,
    }
  },
  useState: (init) => {
    const i = cursor++
    if (!(i in store)) store[i] = typeof init === 'function' ? init() : init
    return [
      store[i],
      (v) => {
        store[i] = typeof v === 'function' ? v(store[i]) : v // React 支持函数式更新
      },
    ]
  },
  useEffect: (fn) => effects.push(fn),
  useCallback: (fn) => fn,
  useRef: (init) => ({ current: init === undefined ? null : init }),
}

const requireStub = (name) => {
  if (name === 'react') return stubReact
  throw new Error('unexpected require: ' + name)
}

const src = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
new Function('window', 'require', 'console', src)(fakeWindow, requireStub, console)

console.log('bundle id      :', definition && definition.id)
const exportsObj = definition.factory(requireStub)
console.log('exports keys   :', Object.keys(exportsObj).join(', '))
console.log('inject         :', JSON.stringify(exportsObj.inject))

const tabs = []
const slots = []
const calls = []
let currentPayload = { sessionId: 'sess-A', total: { bytes: 0, text: '' }, apps: [] }
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), method: (init && init.method) || 'GET', body: init && init.body })
  return { ok: true, status: 200, json: async () => currentPayload }
}
let effectCount = 0
const ctxBase = {
  effect: (fn) => {
    effectCount += 1
    fn()
  },
  sidebarRightTabs: { register: (def) => tabs.push(def) },
  slots: { inject: (name, fn) => fn(), register: (spec, component) => slots.push({ spec, component }) },
}
// 模拟 Cordis：读没 inject 的服务属性直接抛。修好 sessionIdOf 之前，面板会因此整块空白
// （线上就是这么炸的：cannot get property "session" without inject）。
const ctx = new Proxy(ctxBase, {
  get(target, prop) {
    if (prop === 'session') throw new Error('cannot get property "session" without inject')
    return target[prop]
  },
})
exportsObj.apply(ctx)
console.log('effects ran    :', effectCount)
console.log('tab types      :', tabs.map((t) => `${t.id}/${t.kind}/${t.priority}`).join(', '))
console.log('guide 条目     :', JSON.stringify((tabs[0] && tabs[0].guide && tabs[0].guide.length) || 0))
console.log('挂载自报       :', JSON.stringify(calls.find((c) => c.url.includes('client-log')) || null))
console.log('slots          :', slots.map((s) => `${s.spec.name}#${s.spec.key}`).join(', '))

const apps = [
  { key: 'mcp:rea', kind: 'MCP', title: 'rea', summary: '逆向工程 MCP', enabled: false, cost: '357 KB · 170 工具', affects: true },
  { key: 'plugin:misakanet', kind: '插件', title: 'misakanet', summary: '失败经验库', enabled: true, cost: '7 工具', affects: true },
  { key: 'plugin:ui-chat', kind: '插件', title: 'ui-chat', summary: '聊天界面', enabled: true, cost: '—', affects: false },
  { key: 'skill:ponytail', kind: '技能', title: 'ponytail', summary: '最懒解法', enabled: true, cost: '942 B 目录项', affects: true },
]
const bodyEntry = slots.find((s) => s.spec.name === 'sidebar.right.pane.tab')

const kidsOf = (node) => (node.children == null ? [] : Array.isArray(node.children) ? node.children : [node.children])
function expand(node, depth = 0) {
  if (node == null || typeof node !== 'object' || depth > 24) return node
  if (Array.isArray(node)) return node.map((n) => expand(n, depth + 1))
  if (node.fn) {
    const fn = node.fn
    // 类组件（错误边界）要用 new 调用
    if (fn.prototype && typeof fn.prototype.render === 'function') {
      const instance = new fn(node.props)
      return expand(instance.render(), depth + 1)
    }
    return expand(fn(node.props), depth + 1)
  }
  return { ...node, children: kidsOf(node).map((n) => expand(n, depth + 1)) }
}
function collect(node, out = { texts: [], inputs: [], rows: 0 }) {
  if (node == null) return out
  if (Array.isArray(node)) {
    for (const n of node) collect(n, out)
    return out
  }
  if (typeof node === 'string') {
    out.texts.push(node)
    return out
  }
  if (typeof node !== 'object') return out
  if (node.type === 'tr') out.rows += 1
  if (node.type === 'input') out.inputs.push({ checked: node.props.checked, disabled: node.props.disabled })
  for (const c of kidsOf(node)) collect(c, out)
  return out
}

/** 跑一个场景：给定槽位 props 与 /list 响应，渲染两轮后把 DOM 收成文本。 */
async function scenario(label, props, payload) {
  store = []
  cursor = 0
  effects = []
  currentPayload = payload
  const root = bodyEntry.component(props)
  const render = () => {
    cursor = 0
    effects = []
    const tree = expand(root)
    for (const fn of effects) fn()
    return tree
  }
  render()
  await new Promise((r) => setTimeout(r, 30))
  const found = collect(render())
  const flat = found.texts.join(' | ')
  console.log(`\n【${label}】`)
  console.log('  表头四列 :', ['名称', '类型', '简介', '消耗'].every((x) => flat.includes(x)), '| 行数:', found.rows)
  console.log('  应用齐全 :', ['rea', 'misakanet', 'ponytail'].every((x) => flat.includes(x)))
  console.log('  消耗列   :', ['357 KB · 170 工具', '7 工具', '942 B 目录项'].every((x) => flat.includes(x)))
  console.log('  复选框   :', JSON.stringify(found.inputs))
  console.log('  置灰的    :', JSON.stringify(found.inputs.filter((i) => i.disabled).length), '个（应为 1：ui-chat 无工具）')
  console.log('  会话行    :', found.texts.find((t) => t.startsWith('会话 ')) || '(无)')
  const note = found.texts.find((t) => t.includes('活动会话') || t.includes('不在宿主'))
  console.log('  提示      :', note || '(无)')
}

const base = { sessionId: 'sess-A', total: { bytes: 418000, text: '408 KB ≈ 116,111 tok/请求' }, apps }
await scenario('槽位给了 sessionId', { sessionId: 'sess-A' }, { ...base, liveSessions: ['sess-A'] })
await scenario('槽位没给，宿主只有一个活动会话', {}, { ...base, liveSessions: ['sess-X'] })
await scenario('槽位没给，宿主有多个会话', {}, { ...base, liveSessions: ['a', 'b'] })

// ── 列宽拖拽：相邻互补、总宽恒定（否则其余列会被按比例重算，看着像"没反应"）──
const COL_DEFAULTS = [190, 56, 170, 132]
console.log('\n【列宽拖拽】')
store = []
cursor = 0
effects = []
currentPayload = { ...base, liveSessions: ['sess-A'] }
const root2 = bodyEntry.component({ sessionId: 'sess-A' })
const render2 = () => {
  cursor = 0
  effects = []
  const tree = expand(root2)
  for (const fn of effects) fn()
  return tree
}
const colWidths = (tree, out = []) => {
  if (!tree || typeof tree !== 'object') return out
  if (Array.isArray(tree)) {
    for (const n of tree) colWidths(n, out)
    return out
  }
  if (tree.type === 'col' && tree.props && tree.props.style) out.push(tree.props.style.width)
  for (const c of kidsOf(tree)) colWidths(c, out)
  return out
}
render2()
await new Promise((r) => setTimeout(r, 30))
const before = colWidths(render2())
// 找到"简介"表头那个拖拽手柄，按下去
const handles = []
const findHandles = (tree) => {
  if (!tree || typeof tree !== 'object') return
  if (Array.isArray(tree)) return tree.forEach(findHandles)
  if (tree.props && typeof tree.props.onMouseDown === 'function' && tree.props.cursor === undefined && tree.props.onDoubleClick) {
    handles.push(tree)
  }
  for (const c of kidsOf(tree)) findHandles(c)
}
findHandles(render2())
console.log('  手柄数量 :', handles.length, '(每列表头一个)')
handles[2].props.onMouseDown({ clientX: 300, preventDefault() {} }) // 拖"简介"右边界
for (const fn of listeners.mousemove || []) fn({ clientX: 340 }) // +40px
const after = colWidths(render2())
console.log('  拖前    :', JSON.stringify(before))
console.log('  拖后    :', JSON.stringify(after))
console.log('  简介 +40 :', after[2] === before[2] + 40, `(${before[2]} → ${after[2]})`)
console.log('  消耗 -40 :', after[3] === before[3] - 40, `(${before[3]} → ${after[3]})`)
console.log('  名称/类型不动 :', after[0] === before[0] && after[1] === before[1])
console.log('  总宽恒定 :', after.reduce((a, b) => a + b, 0) === before.reduce((a, b) => a + b, 0))
for (const fn of listeners.mouseup || []) fn({})
const resetAll = () => {
  for (let i = 0; i < 4; i += 1) handles[i].props.onDoubleClick()
  for (const fn of listeners.mouseup || []) fn({})
}
const drag = (i, delta) => {
  handles[i].props.onMouseDown({ clientX: 300, preventDefault() {} })
  for (const fn of listeners.mousemove || []) fn({ clientX: 300 + delta })
  for (const fn of listeners.mouseup || []) fn({})
  return colWidths(render2())
}
console.log('  拖前    :', JSON.stringify(before))
// 每个边界都要能拖（用户报的是"类型|简介 拖不动"）。
// 断言"互补"：这一列涨多少，右邻居就跌多少（邻居到下限时幅度自然小），总宽恒定。
for (const i of [0, 1, 2]) {
  resetAll()
  const w = drag(i, 40)
  const gained = w[i] - COL_DEFAULTS[i]
  const neighbourLost = COL_DEFAULTS[i + 1] - w[i + 1]
  const ok =
    gained > 0 && gained === neighbourLost && w.reduce((a, b) => a + b, 0) === before.reduce((a, b) => a + b, 0)
  console.log(
    `  边界${i}（${['名称|类型', '类型|简介', '简介|消耗'][i]}）+40 :`,
    ok,
    JSON.stringify(w),
    `互补 ${gained}/${neighbourLost}`,
  )
}
resetAll()
// 往左拖到底：老实现里"类型"只有 12px 余量，看着就像拖不动
const left = drag(1, -400)
console.log('  类型往左拖到底 :', JSON.stringify(left), '| 类型到达下限', left[1] === 32, '| 简介补足', left[2] === COL_DEFAULTS[2] + (COL_DEFAULTS[1] - 32))
console.log('  总宽恒定 :', left.reduce((a, b) => a + b, 0) === before.reduce((a, b) => a + b, 0))
resetAll()
// 夹住：把"简介"往左拖过头，不能把邻居挤到 0 以下
const clamped = drag(2, -5000)
console.log('  极限夹住 :', JSON.stringify(clamped), '总量不变:', clamped.reduce((a, b) => a + b, 0) === before.reduce((a, b) => a + b, 0))
resetAll()
console.log('  双击复原  :', JSON.stringify(colWidths(render2())), '=== 默认', JSON.stringify(COL_DEFAULTS))

