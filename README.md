# dsh-app-panel

DSH（DeepSeek Harness）Web GUI 右侧栏的「应用面板」：把**本会话真正装上、真正花 token 的东西**列成一张表，逐项开关。

每一行是一个应用，四列：

```
名称                          类型    简介                消耗
☑ rea                        MCP    二进制逆向分析        426 KB · 170 工具
☑ godot-ai                   MCP    Godot 编辑器联动      98 KB · 47 工具
☐ dsh-doc-standards          技能   文档规范              412 B 目录 · 正文 6.5 KB
☐ subagent                   工具   ——                    3.1 KB · 1 工具
```

勾掉哪一行，**这个会话的请求里就不再出现它的工具定义** —— 不是隐藏，是真的不发。

## 它解决什么

MCP 服务器和插件的工具 schema 是**每个请求都要重发一遍**的固定成本。在作者的机器上实测：

| 应用 | 每请求体积 | 约合 token |
|---|---|---|
| rea（REA 逆向 MCP，170 个工具） | 426 KB | ≈ 12 万 |
| godot-ai（47 个工具） | 98 KB | ≈ 2.7 万 |
| 全部 22 条技能目录 | 8 KB | ≈ 2.3 千 |

不需要逆向的会话里，那 426 KB 是纯浪费。面板的作用就是把这类浪费变成一次点击。

## 交互

- **勾选**：按会话开关，立即生效（不需要重启）。
- **拖列宽**：拖动表头列边界调整宽度，相邻列互补（总宽不变）；双击边界复原该列；宽度记在浏览器本地。
- **悬停**：名称与简介被截断时，悬停看全文。
- **刷新**：面板顶部「刷新」按钮重新读取（打开面板时也会自动读一次，所以**新装的应用会自动出现**）。

## 安装

本地目录（开发/自用）：

```bash
dsh plugin --profile <profile> add link:C:\path\to\dsh-app-panel
```

或直接改 profile 的 `package.json`：

```json
{
  "dependencies": { "dsh-app-panel": "link:C:\\path\\to\\dsh-app-panel" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-app-panel"] } }
}
```

发布到 npm 之后：

```bash
dsh plugin --profile <profile> add dsh-app-panel
```

装完**重启应用**（profile 层的 bundle 变化不会被热加载），右侧栏会多出「应用」标签。

## 工作原理

| 关掉的东西 | 实际做了什么 | 生效时机 |
|---|---|---|
| MCP 服务器、插件、单个工具 | 对该会话的 agent 调 `agent.ctx.tools.restrict({ deny })`，按**工具名前缀**或**精确工具名**屏蔽 | 勾选后立即；下一条消息起请求里不再出现 |
| 技能 | ① 把 `<available_skills>` 目录消息里这一条**删掉**（每轮都在发的就是它）② 拦 `skill` 工具的调用，防止误载入 | 勾选后下一步 |
| — | 选择存 `~/.dsh/app-panel.json`，按会话记录被关闭的项 | 重启后自动重新施加 |

同步点（任何一条都会把当前选择重新施加到 agent 上）：`agent/created`、`agent/session-start`、`agent/inbox/claimed`（每步）、打开面板、每次勾选。

> 提示词里的系统 section（persona、指令、压缩策略等）**关闭不了** —— DSH 的 `systemPrompt` waterfall 明确规定监听者不能替换别的插件注册的 section。

## 应用是怎么被发现的

面板不依赖任何硬编码清单，三类来源：

1. **patch 行**：`~/.dsh/cordis.patch.yml` 与当前 profile 的 `cordis.patch.yml`（MCP 行、插件行）。
2. **profile bundle 清单**：`profiles/<name>/package.json` 的 `dsh.profile.bundles`。
3. **技能**：`ctx.skills.list()` 注册表（权威，含 bundle / 远程 provider 来源）+ `~/.dsh/skills`、`~/.agents/skills` 磁盘目录（用来补正文体积），并读取 `dsh-skill-hub.json` 的 `disabled`。

工具归属顺序：**自己声明的前缀 → 按应用名推断 → 兜底逐个工具成行**。最后那条是关键：认不出归属的工具不会消失，而是各自成一行 —— 所以**任何新装的工具都必然可关**，不需要为它改代码。

## 诚实的边界

- **提示词 section 关不掉**（见上），这类应用在表里标为「无工具」。
- **进程不省**：关掉 rea 只是不发它的工具定义，REA 的 MCP 进程照旧在跑（省 token，不省内存/CPU）。
- **已被载入过的技能正文留在对话历史里**，关掉它不会让历史变短。
- **只影响该会话**：别的会话按自己的选择付账。
- 表头合计 = 工具定义 + 技能目录项，**不含对话历史**，也不含上面那类提示词 section。
- 只在带 `webServer` / `tools` / `agents` 服务的 profile（web / desktop）里可用。

## HTTP 接口

仅在 loopback 可达：

| 路径 | 说明 |
|---|---|
| `GET /api/app-panel/list?session=<id>` | 表数据（`apps[]` + `total` + `liveSessions`） |
| `POST /api/app-panel/toggle` | `{ session, key, enabled }`，写状态并立刻施加 |
| `POST /api/app-panel/client-log` | 浏览器半边自报（挂载/渲染/失败），落 `~/.dsh/app-panel.client.log` |
| `GET /api/app-panel/debug` | 诊断：服务可用性、活动 agent、已施加的签名、提示词消息概况、每请求体积探针 |

`key` 的形态：`mcp:<server>`、`plugin:<rowId>`、`skill:<name>`、`tool:<工具名>`。

## 排查

- `~/.dsh/app-panel.boot.json`：宿主装载本插件时的心跳（profile、可见工具数、注册表规模、同步结果）。
- `~/.dsh/app-panel.client.log`：浏览器半边的自报，面板空白时先看这个。
- `GET /api/app-panel/debug` 里的 `lastApplyError` / `stepEvents` / `skillsStripped` / `lastStepMessages` / `promptProbe`。

## 测试

```bash
npm test
```

两个 harness，都不需要真的启动 DSH：

- `test/host.test.mjs`：假 ctx 驱动 host 半边 —— 发现（patch / bundle / 技能注册表 / 技能中心开关）、勾选、`deny` 掩码（前缀与精确名）、按会话隔离、落盘、自动发现新装 MCP 与技能、技能目录消息裁剪、体积口径。
- `test/client.test.mjs`：假 window + 假 React 驱动浏览器半边 —— 信封注册、标签与槽、三种会话 id 情形、四列表格、置灰逻辑、列宽拖拽的互补与夹取。

## 许可

MIT
