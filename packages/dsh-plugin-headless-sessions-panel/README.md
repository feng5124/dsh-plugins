# dsh-plugin-headless-sessions-panel

在 DSH 侧栏加一个「无头会话」入口：点开后列出**本机正在运行的无头会话**（`cli.js headless …` 拉起的那些）。
每条可以：

- **看** —— 点行，右侧把该会话导出成可读 Markdown 预览（只读快照，来自 `dsh-session-forensics/out/`）；
- **进** —— 会话在**本 GUI 的会话目录**里时显示「打开会话」，走 `uiWorkspace.openSession(sessionId)`
  把它放进主视图。不在目录里时不会给一个点了就报错的按钮，而是按状态给不同出路（见下表）。

| 会话状态 | 面板右侧 |
|---|---|
| **已归档**（**优先判断**，哪怕它同时也在目录里） | **「取消归档并打开」**：`workspaces.unarchiveSession(id)` → 刷新目录 → `openSession(id)` |
| 在客户端目录里、未归档 | **「打开会话」** |
| 目录里还没有（外部进程刚建） | 「暂时只读」+ **「刷新目录并打开」**：先让客户端重拉 `session/list`，宿主认识了就打开 |

> **2026-10-30 修的归档 bug**：归档判断必须排在最前。宿主 `session/list` **不**过滤归档会话
> （只有 GUI 的分组界面才隐藏它们），所以已归档的会话几乎总是同时"known"。旧代码先判断 `known`，
> 于是归档会话被渲染成普通的「打开会话」：点下去**看起来打开了**，但 id 仍留在 `archivedSessionIds` 里，
> 客户端 `ui-workspace` 的 `clearArchivedCurrent()`（`dsh-client-ui-workspace/lib/client.js`）在下一个
> Workspace 帧到达时把主视图清掉 —— 表现就是「打开成功，几十秒后自己消失」。
> 本机实测：156 条归档会话里 **77 条**同时还在工作区 `sessionIds` 里，这 77 条全都会踩到。
> 修法：`classifySession` 先判归档；`openSession` 增加兜底重定向（除 `afterUnarchive` 重试外一律先取消归档）。

**行标题（2026-10-30）**：无头会话的文件名全是 `session-<uuid>`，只看 id 无法分辨。扫描器现在
**总是**解析首部，输出 `title` / `titleSource` / `firstText` / `displayTitle`：

- `displayTitle` = 真标题（用户改名、模型生成）；DSH 自己那个 `source.kind === 'fallback'` 的标题
  是**按字节截断的前缀**（`fallbackSessionTitle`，中文没空格等于硬截，例如「用无头会话插件打开一个已归」），
  所以遇到 fallback 就改用**用户首句话**。两者都没有才回落到短 id。
- 首句取自第一条 `user/message`（`source.kind === 'user'`），跳过注入的 `<system-reminder>` /
  `Current runtime context` 之类上下文。

归档集合读的是 `workspaces.model.archivedSessionIds`（**不是服务本身的属性**）——2026-10-08 修过一次：
读错属性会恒为 `undefined`，导致归档会话也被显示成"只读"且没有取消归档入口。

**目录里为什么"还没有"**（2026-10-08 实测）：宿主在启动时扫一遍会话目录建立目录，之后**别的进程**
（21:30 的日报无头任务）新建的会话，要等客户端重新拉一次 `remote.session.list({})` 才进目录 ——
这是**暂时**状态，不是"永久打不开"。实测 21:32:17 全机 73 条会话里只有 21:30:06 那条无头会话
`session-989ade16…` 不在目录里；21:36:04 它已进目录（`sessionCount: 74`，且排在列表第一位）。
面板因此会在轮询时**自动重拉**（最多 15 秒一次），这种行会自己变成可点的「打开会话」。

归档集合读的是 `workspaces.model.archivedSessionIds`（**不是服务本身的属性**）——2026-10-08 修过一次：
读错属性会恒为 `undefined`，导致归档会话也被显示成"只读"且没有取消归档入口。

## 为什么无头会话打不开（2026-10-07 实测结论）

DSH 客户端**只肯 retain 自己目录里的会话**，别人进程创建的会话会被拒绝：

| 证据 | 位置 |
|---|---|
| `throw new Error('sessions.retain: unknown session ' + id)`：id 既不在活着的会话里、也不在 summaries 里就拒绝 | `@deepseek-ai/dsh-api-session-controller/lib/client.js:2385` |
| 客户端的 summaries 由 `remote.session.list({})` 全量刷新而来 | 同上 `:2603` |
| 宿主的目录来自 workspace registry + 本进程活着的会话 | `@deepseek-ai/dsh-api-session-controller/lib/index.js`（`workspaceRegistry.list()` / `ctx.sessions.list()`） |
| 磁盘对照：`~/.dsh/storages/workspace.json` 里有本 GUI 会话 `session-a74e300b…`，没有无头会话 `session-82101393…`、`session-8615d74a…` | 本机实测 |
| `session/openWorkspacePath` 只是让桌面打开路径（资源管理器 / 外部程序），不会把会话收编进目录 | `…/dsh-api-session-controller/lib/index.js:3031` |

根因：`cli.js headless` 是**另一个进程**（通常还是另一个 profile：`~/.dsh/profiles/headless`）拉起的，
它的会话从来不会写进本 profile 的 workspace registry，所以本 GUI 既列不出来、也 retain 不了。

想要"能进"，得让那个会话进入同一个 profile 的 registry（例如改掉无头任务的启动方式，让它走桌面 profile 的
会话控制器），或者等 DSH 提供"导入/接管外部会话"的 API——现在没有。

## 它由两半组成

| 半 | 文件 | 做什么 |
|---|---|---|
| 宿主半 | `lib/host.mjs` | 在 DSH 自己的 HTTP 服务上注册两条路由；调用同工作区的取证脚本 `dsh-session-forensics/find-headless.mjs`（现成的、已核对的工具） |
| 浏览器半 | `lib/client.js` | 注册 `sidebar.panellist`（侧栏行）与 `main`（面板）；轮询 status、渲染列表与转录；「打开会话」调 `ctx.get('uiWorkspace').openSession`（服务不存在时自动退化为只读） |

路由：

```
GET /headless-sessions/status[?all=1]     正在运行的无头会话 + 最近 5 分钟内活动过的会话（?all=1 = 按更新时间前 50 条）
GET /headless-sessions/dump?id=<id前缀>   把某个会话导出成 Markdown（取自 dsh-session-forensics/out/）
```

浏览器半用同源 `fetch` 取这两条路由——这正是官方客户端插件用的通道，且只有已通过会话 HTTP 鉴权的页面能读。

## 「正在运行」是怎么判定的

判定逻辑不在本插件里，而在 `dsh-session-forensics/find-headless.mjs`（其 README 有完整说明）：

- 会话文件 `~/.dsh/sessions/<工作区编码>/session-<uuid>/session.v4.jsonl.zstd` 是**多帧追加** zstd；
- 无头进程 = 命令行匹配 `cli\.js"?\s+headless\b` 的 `DeepSeek Harness.exe`；
- 进程启动时间与会话首行 `createdAt` 对齐（20s 容差）后，`running: true` 才是真·正在跑的无头会话。

宿主半优先用捆绑 node 跑脚本（脚本需要 `zlib.zstd*`，Electron 宿主进程不保证有）；
可用 `DSH_HEADLESS_FORENSICS` 覆盖脚本路径、`DSH_BUNDLED_NODE` 覆盖解释器。

## 诊断戳（排障用）

宿主半会在 `~/.dsh/headless-sessions/` 写两个小文件：

- `host-stamp.json` —— 每次宿主半加载时写一次（含 `hostNode` / `electron` / 脚本路径），用来确认"新代码有没有真的加载"；
- `last-request.json` —— 路由被访问时写（1 秒节流），用来确认"页面有没有真的连上宿主"。

## 安装（本机 desktop profile）

```powershell
# 用插件管理器装（等价于 pnpm add + 选入 dsh.profile.bundles）
#   plugin_manager install_bundle target=dsh-plugin-headless-sessions-panel
```

装完检查：

```powershell
Get-Content "$env:USERPROFILE\.dsh\profiles\desktop\package.json" -Raw   # dependencies + dsh.profile.bundles
Get-Content "$env:USERPROFILE\.dsh\headless-sessions\host-stamp.json" -Raw
```

## 本机踩到的两条加载器限制（2026-10-07 实测）

1. **profile 安装的包，子路径 specifier 解析不了**：
   `name: 'dsh-plugin-headless-sessions-panel/host'` → `failed to import`
   （同一个 specifier 用普通 node 能解析；官方包能用的 `/startup`、`/tools` 等子路径在这里不行）。
   → 所以宿主代码挂在 `package.json#main` 上，入口只用裸包名。
2. **同一 specifier 的模块 URL 不会重跑**：改完 `lib/host.mjs` 后，禁用/启用 bundle、甚至 `pnpm remove` + 重装，
   还是加载旧模块（`package.json` 解析结果与 ESM 模块都在进程内缓存）。
   → 改宿主半要么**重启 DSH**，要么换一个**新的包名**（本插件名字里带 `-panel` 就是这个原因）。
   客户端半不受影响：它走 HTTP 里的 bundle 版本号，改完自动热更新。

## 测试

```powershell
# 零依赖：注册、轮询、列表排序、转录预览、错误分支、Markdown 解析
node test/smoke.mjs

```

`package.json` 只声明 `dsh.bundle` 与 `dsh.client`，没有依赖；`lib/index.mjs` 是历史兼容 shim。
