/**
 * dsh-app-panel — 浏览器半边（Web GUI 右侧栏的「应用」标签页）。
 *
 * 浏览器 bundle 的约定（照第三方 dsh-skill-hub / 一方 sidebar-files 的产物）：
 * 整份文件就是一次 window.__ModuleLoader__.load({ id, factory })，id 用包名，
 * 工厂里拿到 require，正文按 CommonJS 写，最后 return module.exports。
 * 这个信封不能省：少了它，脚本加载时不会注册模块（并在 require 未定义处报错）。
 *
 * 只做两件事：把 host 半边的 /api/app-panel/list 画成表；复选框点击 POST 回
 * /api/app-panel/toggle。发现逻辑全在 host 侧。
 * apply 内不抛错：Web 外壳在插件 apply 抛错时会整体启动失败。
 */
window.__ModuleLoader__.load({
  id: 'dsh-app-panel',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    const PANEL_ID = 'dsh-app-panel' // 标签类型的 id：照一方约定用包名（全局唯一键）
    const PANEL_KIND = 'app-panel' // 短类型名，和 id 分开
    const API = '/api/app-panel'
    const h = React.createElement

    /** 会话 id 从哪来都行：槽位 props 优先（一方 FilesBody 就是靠注入的 sessionId），
     *  其次 ctx.session，最后从地址栏里捞 UUID。
     * 注意：Cordis 的 ctx 读**未 inject 的服务属性会直接抛**（"cannot get property
     * "x" without inject"），所以任何 ctx.<service> 访问都必须包在 try 里 ——
     * `ctx.session && …` 这种"防御式"写法根本防不住，属性访问本身就炸。 */
    function safe(fn, fallback = null) {
      try {
        const value = fn()
        return value === undefined ? fallback : value
      } catch {
        return fallback
      }
    }

    function sessionIdOf(props, ctx) {
      const fromUrl = safe(() => {
        const hit = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(
          location.pathname + location.search + location.hash,
        )
        return hit ? hit[1] : null
      })
      const candidates = [
        safe(() => props && props.sessionId),
        safe(() => props && props.session && props.session.id),
        safe(() => props && props.tab && props.tab.sessionId),
        safe(() => {
          const session = ctx && ctx.session
          return (session && session.current && session.current.id) || (session && session.id) || null
        }),
        fromUrl,
      ]
      for (const c of candidates) if (typeof c === 'string' && c) return c
      return 'unknown'
    }

    async function fetchList(sessionId) {
      const res = await fetch(`${API}/list?session=${encodeURIComponent(sessionId)}`)
      if (!res.ok) throw new Error(`读取失败 ${res.status}`)
      return res.json()
    }

    async function postToggle(sessionId, key, enabled) {
      const res = await fetch(`${API}/toggle`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session: sessionId, key, enabled }),
      })
      if (!res.ok) throw new Error(`写入失败 ${res.status}`)
      return res.json()
    }

    const KIND_COLOR = { MCP: '#3b6ea5', 插件: '#7a5aa5', 技能: '#4a7a52', 工具: '#8a6d3b' }

    /**
     * 单元格自己负责裁剪：固定布局下 td 有了确定宽度，ellipsis 才会按**单元格实际宽度**
     * 收尾。之前把省略号放在内层 inline-block 上并写死 maxWidth，列拖窄时文字不跟着缩，
     * 就直接压到隔壁列上去了。
     */
    function Cell(props) {
      return h(
        'td',
        {
          title: props.title,
          style: {
            padding: '3px 6px',
            verticalAlign: 'top',
            fontSize: 12,
            lineHeight: 1.35,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            boxSizing: 'border-box',
          },
        },
        props.children,
      )
    }

    /** 四列宽度：表头可拖拽、双击复原、存 localStorage（下次打开还是你拉的宽度）。 */
    const COL_DEFAULTS = [190, 56, 170, 132]
    // 最小宽度压得较小：类型/消耗这类窄列，如果下限贴近默认值，往左拖两下就到头，
    // 手感就是"拖不动"（类型 56 → 44 只有 12px 余量）。
    const COL_MIN = [80, 32, 56, 56]
    const COL_KEY = 'dsh-app-panel.widths'

    function loadWidths() {
      try {
        const raw = localStorage.getItem(COL_KEY)
        const parsed = raw ? JSON.parse(raw) : null
        if (Array.isArray(parsed) && parsed.length === COL_DEFAULTS.length) {
          return parsed.map((n, i) => (typeof n === 'number' && n >= COL_MIN[i] ? n : COL_DEFAULTS[i]))
        }
      } catch {
        /* 读不到就用默认 */
      }
      return COL_DEFAULTS.slice()
    }

    function useColumnWidths() {
      const [widths, setWidths] = React.useState(loadWidths)
      const drag = React.useRef(null)
      React.useEffect(() => {
        try {
          localStorage.setItem(COL_KEY, JSON.stringify(widths))
        } catch {
          /* 存不了也无所谓 */
        }
      }, [widths])
      React.useEffect(() => {
        const onMove = (e) => {
          const d = drag.current
          if (!d) return
          const delta = Math.round(e.clientX - d.x)
          const next = d.start.slice()
          const i = d.index
          const j = i + 1
          if (j < next.length) {
            // **相邻互补**：这一列宽多少，右边那一列就窄多少 → 总宽恒定，
            // 于是 width:100% 下其余列的换算比例不变，看起来它们原地不动。
            // 两边都按最小宽度夹住，免得把某一列挤没。
            const maxGrow = d.start[j] - COL_MIN[j] // 邻居最多能让出多少
            const maxShrink = d.start[i] - COL_MIN[i] // 自己最多能缩多少
            const grow = Math.max(-maxShrink, Math.min(delta, maxGrow))
            next[i] = d.start[i] + grow
            next[j] = d.start[j] - grow
          } else {
            next[i] = Math.max(COL_MIN[i], d.start[i] + delta)
          }
          setWidths(next)
        }
        const onUp = () => {
          drag.current = null
          try {
            document.body.style.userSelect = ''
            document.body.style.cursor = ''
          } catch {
            /* 忽略 */
          }
        }
        window.addEventListener('mousemove', onMove)
        window.addEventListener('mouseup', onUp)
        return () => {
          window.removeEventListener('mousemove', onMove)
          window.removeEventListener('mouseup', onUp)
        }
      }, [])
      const start = (index) => (e) => {
        if (e && typeof e.preventDefault === 'function') e.preventDefault()
        drag.current = { index, x: (e && e.clientX) || 0, start: widths }
        try {
          document.body.style.userSelect = 'none'
          document.body.style.cursor = 'col-resize'
        } catch {
          /* 忽略 */
        }
      }
      const reset = (index) => {
        setWidths((prev) => {
          const next = prev.slice()
          next[index] = COL_DEFAULTS[index]
          return next
        })
      }
      return { widths, start, reset }
    }

    function Row(props) {
      const app = props.app
      const [busy, setBusy] = React.useState(false)
      const affects = app.affects !== false
      const onToggle = async () => {
        if (busy || !affects) return
        setBusy(true)
        try {
          const next = await postToggle(props.sessionId, app.key, !app.enabled)
          props.onData(next)
        } catch (e) {
          props.onError(String((e && e.message) || e))
        } finally {
          setBusy(false)
        }
      }
      return h(
        'tr',
        { style: { borderTop: '1px solid rgba(128,128,128,.25)', opacity: app.enabled ? 1 : 0.5 } },
        h(
          Cell,
          null,
          h('input', {
            type: 'checkbox',
            checked: Boolean(app.enabled),
            disabled: busy || !affects,
            onChange: onToggle,
            style: { marginRight: 6, verticalAlign: 'middle' },
            title:
              (affects
                ? '勾上=本会话启用；取消=本会话不带它的工具（省 token）'
                : '当前没有属于它的工具可屏蔽（应用没启动，或它不向模型暴露工具）') +
              (app.expect ? `\n已知体量：${app.expect}` : ''),
          }),
          h('span', { title: app.title, style: { fontWeight: 600 } }, app.title),
        ),
        h(Cell, null, h('span', { style: { color: KIND_COLOR[app.kind] || 'inherit' } }, app.kind)),
        h(
          Cell,
          { title: app.summaryFull || app.summary || '' },
          app.summary || h('span', { style: { opacity: 0.5 } }, '—'),
        ),
        h(Cell, { title: app.cost || '' }, app.cost || '—'),
      )
    }

    function Panel(props) {
      const ctx = props && props.ctx
      const [sessionId, setSessionId] = React.useState(() => sessionIdOf(props, ctx))
      const [data, setData] = React.useState(null)
      const [note, setNote] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [loading, setLoading] = React.useState(true)

      const load = React.useCallback(async () => {
        try {
          setError(null)
          const next = await fetchList(sessionId)
          const live = Array.isArray(next.liveSessions) ? next.liveSessions : []
          if (!live.includes(sessionId)) {
            if (live.length === 1) {
              // 槽位没给会话 id（或给的形状不对），而宿主只认识一个活动会话：就用它，
              // 免得勾选写进一个没人读的桶里、看起来毫无作用。
              setSessionId(live[0])
              setNote(`宿主只有一个活动会话，面板按它记账：${live[0]}`)
              const adopted = await fetchList(live[0])
              setData(adopted)
              reportRendered(live[0], adopted)
              return
            }
            if (live.length > 1) {
              setNote(
                `面板记的会话 id（${sessionId}）不在宿主的活动会话里：${live.join('、')} —— 勾选可能不会生效`,
              )
            }
          } else {
            setNote(null)
          }
          setData(next)
          reportRendered(sessionId, next)
        } catch (e) {
          const message = String((e && e.message) || e)
          setError(message)
          report('panel-fetch-failed', { sessionId, message })
        } finally {
          setLoading(false)
        }
      }, [sessionId])

      React.useEffect(() => {
        load()
      }, [load])

      // 组件真的跑起来的证据（哪怕 fetch 失败、哪怕下面渲染炸了）。
      React.useEffect(() => {
        if (reportedMount) return
        reportedMount = true
        report('panel-first-render', {
          sessionId,
          hadPropSessionId: Boolean(props && props.sessionId),
          href: (() => {
            try {
              return location.href
            } catch {
              return null
            }
          })(),
        })
      }, [sessionId])

      const col = useColumnWidths()
      const headCell = (key, index, label) =>
        h(
          'th',
          {
            key,
            style: {
              position: 'relative',
              textAlign: 'left',
              fontWeight: 400,
              padding: '3px 6px',
              borderBottom: '1px solid currentColor',
            },
          },
          label,
          /**
           * 拖拽热区：12px 宽、跨在边界两侧，并 zIndex 抬到上层 —— 否则探出去的那半
           * 会被右边那个 th 盖住（th 是定位元素，后画的在上层），有效热区只剩 4px，
           * 手感就是"抓不住/拖不动"。中间那条 1px 线让边界看得见。
           * 最后一列右边不画线（那里是表格边缘），但仍可拖动。
           */
          h(
            'span',
            {
              onMouseDown: col.start(index),
              onDoubleClick: () => col.reset(index),
              title: '拖动改列宽，双击复原',
              style: {
                position: 'absolute',
                top: 0,
                right: -6,
                width: 12,
                height: '100%',
                cursor: 'col-resize',
                userSelect: 'none',
                zIndex: 3,
                display: 'flex',
                justifyContent: 'center',
              },
            },
            index < 3
              ? h('span', {
                  style: { width: 1, background: 'rgba(128,128,128,.45)', pointerEvents: 'none' },
                })
              : null,
          ),
        )
      const head = h('tr', null, [
        headCell('h1', 0, '名称'),
        headCell('h2', 1, '类型'),
        headCell('h3', 2, '简介'),
        headCell('h4', 3, '消耗'),
      ])

      return h(
        'div',
        { style: { padding: '8px 10px', fontSize: 12, overflow: 'auto', height: '100%' } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 } },
          h('strong', { style: { fontSize: 13 } }, '应用'),
          h('span', { style: { opacity: 0.6, fontSize: 11 } }, `会话 ${sessionId}`),
          h('button', { onClick: load, style: { marginLeft: 'auto', fontSize: 11 }, title: '重新读取' }, '刷新'),
        ),
        note ? h('div', { style: { opacity: 0.7, marginBottom: 6, fontSize: 11 } }, note) : null,
        error ? h('div', { style: { color: '#c0392b', marginBottom: 6 } }, error) : null,
        loading && !data ? h('div', { style: { opacity: 0.6 } }, '读取中…') : null,
        data
          ? h(
              'div',
              null,
              h(
                'div',
                { style: { opacity: 0.75, marginBottom: 6 } },
                `本会话每次请求约 ${(data.total && data.total.text) || '—'}。勾掉即省：工具类整份定义不再发送，技能类目录条目会被删掉。新装的应用会自动出现在这里（打开面板即刷新）；只在提示词里注入文字的应用，按 DSH 的设计无法按会话关闭。`,
              ),
              h(
                'table',
                { style: { borderCollapse: 'collapse', width: '100%', tableLayout: 'fixed' } },
                h(
                  'colgroup',
                  null,
                  col.widths.map((w, i) => h('col', { key: `c${i}`, style: { width: w } })),
                ),
                h('thead', null, head),
                h(
                  'tbody',
                  null,
                  (data.apps || []).map((app) =>
                    h(Row, { key: app.key, app, sessionId, onData: setData, onError: setError }),
                  ),
                ),
              ),
            )
          : null,
      )
    }

    /** 自报一行到宿主（挂载成功/失败、首次渲染、画出行都报），出问题不用开控制台也能定位。 */
    let reportedRender = false
    let reportedMount = false

    function report(event, detail) {
      try {
        fetch(`${API}/client-log`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ event, detail }),
        }).catch(() => {})
      } catch {
        /* 自报失败无所谓 */
      }
    }

    function reportRendered(sessionId, payload) {
      if (reportedRender) return
      reportedRender = true
      report('panel-rendered', {
        sessionId,
        apps: Array.isArray(payload && payload.apps) ? payload.apps.length : 0,
        total: payload && payload.total && payload.total.text,
      })
    }

    /** 渲染期抛错会被 React 掀掉整棵子树（表现就是面板空白），这里兜住并自报原因。 */
    class PanelBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { err: null }
      }
      static getDerivedStateFromError(err) {
        return { err }
      }
      componentDidCatch(err, info) {
        report('panel-render-failed', {
          message: String((err && err.message) || err),
          stack: String((err && err.stack) || '').slice(0, 600),
          componentStack: String((info && info.componentStack) || '').slice(0, 600),
        })
      }
      render() {
        if (this.state.err) {
          return h(
            'div',
            { style: { padding: 8, fontSize: 12, color: '#c0392b' } },
            '应用面板渲染出错：' + String((this.state.err && this.state.err.message) || this.state.err),
          )
        }
        return this.props.children
      }
    }

    function Title() {
      return h('span', null, '应用')
    }

    /** 空面板引导里用的小图标（纯 SVG，不引第三方图标包）。 */
    function PanelGlyph({ size = 16, className } = {}) {
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 16 16', className, fill: 'none', stroke: 'currentColor' },
        h('rect', { key: 'a', x: 2, y: 3, width: 12, height: 10, rx: 2 }),
        h('path', { key: 'b', d: 'M2 6.5h12M6.5 6.5V13' }),
      )
    }

    function apply(ctx) {
      try {
        ctx.effect(
          () =>
            ctx.sidebarRightTabs.register({
              id: PANEL_ID,
              kind: PANEL_KIND,
              priority: 'builtin',
              title: () => '应用',
              guide: [
                {
                  order: 50,
                  title: () => '应用面板',
                  description: () => '按会话开关应用，看各自的 token 消耗',
                  icon: PanelGlyph,
                },
              ],
            }),
          'app-panel: tab type',
        )
        ctx.effect(
          () =>
            ctx.slots.inject('sidebar.right.pane.tab', () =>
              ctx.slots.register({ name: 'sidebar.right.pane.tab', key: PANEL_ID }, (props) =>
                h(PanelBoundary, null, h(Panel, Object.assign({}, props, { ctx }))),
              ),
            ),
          'app-panel: tab body',
        )
        ctx.effect(
          () =>
            ctx.slots.inject('sidebar.right.pane.tab.title', () =>
              ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: PANEL_ID }, Title),
            ),
          'app-panel: tab title',
        )
        report('client-mounted', {
          hasSlots: Boolean(ctx.slots),
          hasTabs: Boolean(ctx.sidebarRightTabs),
          panelId: PANEL_ID,
          panelKind: PANEL_KIND,
        })
      } catch (e) {
        report('client-mount-failed', {
          message: String((e && e.message) || e),
          stack: String((e && e.stack) || '').slice(0, 800),
          hasSlots: Boolean(ctx && ctx.slots),
          hasTabs: Boolean(ctx && ctx.sidebarRightTabs),
        })
        try {
          console.warn('[app-panel] mount failed:', e)
        } catch {
          /* 忽略 */
        }
      }
    }

    const inject = ['slots', 'sidebarRightTabs']

    exports.apply = apply
    exports.inject = inject
    exports.PANEL_ID = PANEL_ID
    exports.PANEL_KIND = PANEL_KIND
    return module.exports
  },
})
