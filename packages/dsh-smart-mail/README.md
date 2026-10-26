# dsh-smart-mail

DSH 本地插件：**一站式邮件收发 + 白名单智能唤醒 + 同一邮件线程续接原会话**。（v0.2.0，2026-10-26）

- 纯 Node 实现（`node:tls`），**不需要额外安装任何软件**（无 nodemailer/imapflow/Python）。
- 账号密码使用各邮箱的**授权码**（不是登录密码）。
- 唤醒与续接全部走 DSH 进程内公开服务：`sessionController.create / prompt / cancel / inspect`
  与 `workspaceRegistry`（归档恢复），零外部 CLI、零弹窗、零额外窗口。

## 功能

### 1. 多邮箱
内置预设（授权码开箱即用）：

| 预设 | IMAP | SMTP |
|---|---|---|
| QQ | imap.qq.com:993 | smtp.qq.com:465 |
| 163 / 126 | imap.163.com / imap.126.com:993 | smtp.*.com:465（SSL，25 需 STARTTLS，本插件不支持） |
| Gmail | imap.gmail.com:993 | smtp.gmail.com:465 |
| Outlook | outlook.office365.com:993 | smtp.office365.com:587 |
| 自定义 | 任意 IMAP/SMTP 服务器 | |

账号保存在 `~/.dsh/smart-mail/accounts.json`（0600）。

### 2. 收发工具（给 Agent）
- `send_email(to, subject, text, cc?, html?, account?, inReplyTo?, threadTag?)`
  - 传 `inReplyTo`（被回复的 Message-ID）或 `threadTag` 时，自动把 `[dsh-xxxx]` 写回主题，
    并设置 `In-Reply-To` / `References` / `X-DSH-Session`，**让对方的回复落回同一会话**。
- `read_emails(account?, daysBack?=3, limit?=10, unreadOnly?)`

### 3. 白名单唤醒（最高优先级）
- Host 内置 IMAP 轮询（默认 120s，可调 ≥30s）。
- `allowFrom` 白名单：精确地址 `user@x.com` 或域名后缀 `@x.com`；**为空 = 永不唤醒**。
- 白名单发件人的**新线程**邮件 → 创建全新 DSH 会话并注入处理提示词（无头、无弹窗）。
- 非白名单邮件只做**每轮一条**汇总记录，**绝不唤醒**。

### 4. 同一邮件线程续接原会话
1. **发信时记录线程标识**：每封外发邮件都有独立 `Message-ID`，写入 `threads.json` 的
   `outgoing[messageId] = tag`，并在主题前加 `[dsh-<tag>]`、加 `X-DSH-Session: <tag>`。
2. **收信时识别回复归属**（顺序即判定优先级，与 secondlgn/dsh-mail 一致）：
   1. `References` / `In-Reply-To` 命中我方 `Message-ID` → 取到 tag → 取到会话；
   2. `X-DSH-Session` 头（客户端若保留）；
   3. 主题里的 `[dsh-xxxx]` 标签（容错 `Re:`/`回复:`、大小写、丢右括号、编码重写）。
   只有命中**自己的线程表**才会续接，未知标签一律当作新线程。
3. **续接前打断**：目标会话正在运行 → 先 `prompt(mode:'steer')`（当前轮次被替换）；
   若 Host 拒绝 steer，则 `prompt(mode:'queue')` 后立刻 `cancel({sessionId})`
   —— `cancel` 保留 inbox（`keepInbox: true`），所以刚排队的回复会**立即**被拾起，
   而不是等被放弃的那一轮跑完。返回记录里的 `mode` / `cancelUsed` 会如实写明走了哪条路。
4. **归档会话拉回**：`ArchivedSessionGate` 会拒绝已归档会话的每一次模型步骤。
   续接前调用 `workspaceRegistry.unarchiveSession(id)`（Host 的
   `workspace/unarchiveSession` Remote 用的就是这一条写链路）；
   若该版本没有此方法，退到同一套 `enqueueOperation + requireState + setState`
   把 id 从 `archivedSessionIds` 里摘掉。实际走哪条路记在日志的 `unarchivePath` 里。
   拉回失败才降级（并明确记 `error`），不会假装成功。

### 5. 模型
续接会话沿用**该会话自己**的模型；新建会话不写死模型（不记录 `model/selection`），
请求装配回落到 `agentDefaultModel`（DSH 当前默认模型）。

## 活动日志

文件：`~/.dsh/smart-mail/activity.log.jsonl`（每行一条 JSON，首字段 `at`）。
轮转文件：`~/.dsh/smart-mail/activity-<YYYYMMDD-HHmmss>.jsonl`。

### 事件类型

| kind | 何时写 | 内容 |
|---|---|---|
| `plugin-start` | 每次启动，1 条 | 版本、pid、配置**摘要**（allowFrom 数量/前 3 条、轮询间隔、提示词长度等），`configChanged` |
| `config-change` | 仅当有效配置**实际变化**（首次运行也算） | `changedFields`、`before`、`after`（完整 config） |
| `mail-seen` | 每轮轮询**最多 1 条**，且仅当本轮有被忽略的邮件 | `fresh`/`blocked`/`skipped`、`reasons`、`senders`（前 5）、`decisions`（每个发件人的 allowlisted 判定）、`sample`（前 3 封） |
| `mail-wake` | 每封被处理的白名单邮件 1 条，成功/失败都写 | 完整邮件头（from/to/cc/subject/Message-ID/In-Reply-To/References 计数/uid）、`threadVia`、`tag`、`route`、`sessionId`、`mode`、`interrupted`、`cancelUsed`、`unarchivePath`；失败另带完整 `error` |
| `send` | 每次发信 | `messageId`、`tag`、`inReplyTo`、`sessionId`、成功/失败 |
| `poll-error` | IMAP 轮询异常 | 账号 + 完整 error |
| `log-rotate` | 每次切分 | 切分原因、归档文件名、旧文件大小、当前策略 |

### 轮转策略（面板「日志轮转」区与 `/smart-mail/status` 的 `logHealth` 均可查）

- 触发：当前文件 **≥ `logMaxBytes`（默认 2 MiB）**，或 **跨天**（mtime 与今天的日历日不同）。
- 保留：归档按 **`logKeepDays`（默认 7 天）** 与 **`logKeepFiles`（默认 20 个）** 双上限裁剪。
- 切分发生在**写入之前**，单条超大记录也不会让文件无限增长。
- 读取（面板/接口）会**跨当前文件 + 归档**取最新 N 条，切分后历史仍可查。
- 配置项：`logMaxBytes` / `logKeepDays` / `logKeepFiles`（cordis.patch.yml 或面板）。

## 面板

设置 → 插件 → 「智能邮箱」：
账号增删改 + IMAP 测试、白名单编辑、轮询间隔、唤醒提示词/工作目录、手动轮询、
**邮件线程续接开关**（续接同一会话 / 同线程打断 / 归档会话拉回）、
**日志轮转参数与健康度**、活动日志、**线程→会话映射表**。

## 提示词形态

新线程：

```
[dsh-smart-mail] 新邮件（已为该线程创建新会话）
邮箱账号：<label>(<address>)
发件人：<from>   主题：<subject>   线程标识：<tag>   Message-ID：<...>
时间：<locale time>

正文：
<body>

<wakePrompt>
如需回信，直接调用 send_email（带上 inReplyTo 或 threadTag 以保持同一线程）。
```

同线程续接：首行改为 `同一邮件线程的续接（第 N 轮）`，并在正文后追加
`这是同一邮件线程的后续邮件，请沿用该会话已有的上下文继续处理，不要从头重述。`

## 安装

从插件市场安装（Plugins → Discover），或把本目录作为本地 bundle 安装：

```
plugin_manager install_bundle target=dsh-smart-mail
```

开发时也可以让 profile 直接用 `link:` 指向本目录，改完重启 DSH 即生效。

## 维护

- 排错先看 `mail-wake`（`ok:false` 带完整 `error` 与邮件头），再看 `poll-error`。
- 线程表在 `~/.dsh/smart-mail/threads.json`；`/smart-mail/threads` 可查最近 50 条。
- 去重靠 `messages.json`（按 Message-ID）与 `seen-uids.json`（按账号 UID），重启后仍有效。
