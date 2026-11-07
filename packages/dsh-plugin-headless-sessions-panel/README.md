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

### 扫描器读取范围（2026-11-07 第二轮；验收打回后按「活文件优先」重写）

扫描器从 1.0.2 起**内置在本插件**（`lib/find-headless.mjs`），host.mjs 候选顺序里排在
工作区 `dsh-session-forensics` 那份之前（后者现在是**同一实现的镜像**，作 CLI 兜底；
`DSH_HEADLESS_FORENSICS` 环境变量仍最优先）。

契约（已由 `test/scanner-mtime.test.mjs` 用 metrics 计数钉住）：

- **先 stat，再决定读谁**：枚举 `session.v4.jsonl.zstd` 只做 stat；默认视图只整读
  `mtime` 在 **LIVE_MS（默认 5 分钟）** 内的文件——那正是面板要显示的「运行中 + 最近活动」。
  冷文件一个字节都不读，也没有 `STALE` 占位这种半成品行（早期版本的 7 天窗口已废除）。
- **运行中但很久没写的会话不漏**：先用 `birthtime` ≈ 无头进程启动时间做**零读取**匹配；
  仍有未匹配进程时，才对冷文件做**首帧前缀探测**（`openSync` + 从 64KB 起倍增读，
  解出第一帧拿 `createdAt`），命中才整读。两条分支都有独立用例。
- **`--all --limit N` 真的省 I/O**：先按 stat 的 mtime 新→旧排序，**只读前 N 个**；
  无 `--limit` 时取前 50。
- **`--dump` 不整读全库**：按目录名 `session-<id>` 先筛（精确优先，其次唯一前缀），
  只读命中的那一个；多义时 `exit 2` 并列出候选，且**不整读任何候选**。
- **id 形态统一（2026-11-07 真机回归）**：`--json` 的 `id`、面板行、`--dump` 接受的键
  **一律是 `session-<uuid>`**。磁盘目录名不带 `session-` 前缀、首帧里的 `id` 也不保证带，
  所以 `readSession` 出口统一补前缀、`--dump` 入口两种写法都接受。
  ⚠ 曾经只按目录名比对 ⇒ 面板列表能显示、点“导出”却永远“没有匹配 / 导出失败”。
  回归用例：`--dump 接受带 session- 前缀的完整 id（面板的真实调用形态）`，含
  「`--json` 给出的 id 必须能直接 `--dump`」的闭环断言。
- `--max-age-days N` 可显式放宽默认窗口（N>0 生效）；`--json` 每条都是完整解析行。
- 单文件损坏/被删只跳过它自己，不影响整次扫描。

实测对比（2026-11-07 22:2x，同一台机、同一份真实 `~/.dsh/sessions`，232 个会话文件；
基线 = 上一版 7 天窗口实现，副本在 `tmp/`，两边都注入 `DSH_PROCS_JSON=[]` 排除进程枚举抖动）：

| 模式 | 版本 | 整读文件 | 读取字节 | 耗时 |
| --- | --- | --- | --- | --- |
| 默认 `--json` | 基线（7 天窗口） | 42 | 19,697,477 | ~100 ms |
| 默认 `--json` | 本轮 | **2** | **1,483,140** | ~84 ms |
| `--json --all --limit 50` | 基线 | 232（先全读再切） | 97,746,091 | ~90 ms |
| `--json --all --limit 50` | 本轮 | **50** | **29,661,437** | ~89 ms |
| `--dump <id 前缀>` | 基线 | 232（全读后筛） | 全库 | — |
| `--dump <id 前缀>` | 本轮 | **1** | **18,708** | — |

> 耗时对小文件不敏感（差异主要是字节量）；真正被省掉的是每次轮询的 18 MB 级整读与解压。
> 数字由 `DSH_SCAN_METRICS=1` 输出，可随时复跑复核。

- 测试：`test/scanner-mtime.test.mjs`（11 条：metrics 级「冷文件零读取」、`--all --limit`、
  `--dump` 精确/唯一前缀/多义不整读、birthtime 找回挂起会话、首帧前缀探测分支、
  `--max-age-days` 放宽、损坏文件容错）。跑法：`node --test "test/*.test.mjs"`，
  再单独 `node test/smoke.mjs`（文件名不带 `.test.`，glob 匹配不到）。
- 离线测试用 `DSH_SESSIONS_ROOT` / `DSH_FIND_HEADLESS_OUT` / `DSH_PROCS_JSON` 注入。

### 历史浏览与检索（2026-11-07 晚新增）

面板不再只给 50 个会话：

- **全部历史**：`status?all=1` 走 `--json --all --limit 0`（`0` = 不限量）。当前机器 **234 个**会话
  全部可列出，列表按 50 行分页渲染，「加载更多」追加。
  ⚠ `--limit` 语义：**不给 = 默认 50 行**、`0 = 不限量`、`N>0 = 前 N 个`。三者必须分开，
  曾经把 `0` 当“未指定”，导致「全部会话」永远只有 50 条。
- **时间段**：界面上给「从 / 到」两个 `date` 输入，`YYYY-MM-DD` 语义是**当天 00:00 起 /
  当天 23:59:59.999 止**。传 `--since` / `--until`，按文件 mtime 在**读取前**筛，
  所以查一个月只读那一个月的文件（实测查 11-01~11-07 只读 44/234）。
- **关键词检索**，两档：
  | 档位 | 搜什么 | 代价（本机 234 会话） |
  | --- | --- | --- |
  | 默认（浅） | 标题 / 显示名 / 首句 / cwd | ~0.3 s，只解首帧 |
  | 勾选「连正文一起搜」 | 再加上**整份会话正文** | ~4 s（3.15 亿字符全解） |
  结果行标注「标题命中 / 正文命中」并给命中片段。
- **检索不受 50 条默认上限截断**：搜索与时间段查询返回完整结果集（否则“搜出来了却被悄悄截掉”）。
- 路由：`GET /headless-sessions/search?q=&since=&until=&deep=1`（全空 = 列全部历史）。
- 测试：`test/panel-search.test.mjs`（5 条 UI 冒烟）+ `test/scanner-mtime.test.mjs` 里的
  时间段/搜索/`--limit 0` 用例，合计 **23 个**用例。

### 时间窗口策略（2026-11-07 定稿）

**取舍：记录永久保留，单次查询限跨度。** 两者互不影响：

| 概念 | 值 | 说明 |
| --- | --- | --- |
| 会话记录保留 | **永久** | DSH 不清理 `sessions`；面板「全部会话」能翻到最早一条（本机最早 2026-09-30） |
| 单次查询跨度上限 | **31 天** | 超限**不报错、不丢数据**，自动收窄并在结果里回报 `rangeClamped` / `nextAnchor` |
| 无端点时的默认窗口 | **最近 30 天** | 检索时不填日期就只覆盖 30 天；想看更早显式给 `since` 或点「更早一段」 |

- 为什么是 31 天而不是 30：**整整一个自然月**（如 10-01~10-31）必须能一次查完，不能被切断。
- 为什么默认 30 天而不是全库：默认检索不扫全库（本机全库 234 个会话 / 99 MB）。
- **时间判定依据 = 文件最后更新时间（mtime）**：会话在时间段内**有过更新**就算命中。
  这与“按创建日期分组”不同——一个 10 月创建、11 月还在更新的长会话会出现在 11 月的查询里，
  这是**有意为之**（用户口径：时间段内有更新就算）。
- 收窄锚点：两端都给时锚在 `until`（最近端）往回取；只给一端时向另一端推满一个窗口。
  ⚠ 两端都给且**未超限**时窗口原样保留——单日查询必须精确命中那一天，不能被扩成 31 天。
- 关闭限制：`--max-span-days 0`（取证/全量排查）。
- 边界：`--since`/`--until` 收 `YYYY-MM-DD`，语义为本地时区当天 `00:00:00.000` ~ `23:59:59.999`。
  ⚠ 测试造日期时**不能用 `toISOString().slice(0,10)`**——那是 UTC 日期，UTC+8 下与本地日界差 8 小时，
  会在日界上假失败（本轮踩过）。

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
