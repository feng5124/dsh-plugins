# dsh-smart-mail

DSH 本地单一插件：**一站式邮件收发 + 白名单智能唤醒**。（v0.1.0，2026-10-24 安装验证通过）

- 纯 Node 实现（`node:tls`），**不需要额外安装任何软件**（无 nodemailer/imapflow/Python）。
- 账号密码使用各邮箱的**授权码**（不是登录密码）。
- 吸收了 galvanize-dsh（事件→唤醒无头会话）与 dsh-mailbox（工具+面板一体）的设计，但唤醒走
  DSH 进程内 `sessionController.create + prompt`，零外部依赖、零弹窗、零额外窗口。

> 验证记录（2026-10-24）：安装 `application: applied`；`send_email` / `read_emails`
> 已出现在 Agent 工具列表（cordis_inspect Tool.listTools）；`GET /smart-mail/status`
> 在当前 GUI 端口返回配置+预设+日志；IMAP 字面量解析（中文主题/正文预览/发件人）
> 通过模拟服务器集成测试（`test-imap.mjs`）。面板视觉效果需浏览器刷新后人工确认。

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
- `send_email(to, subject, text, cc?, html?, account?)`
- `read_emails(account?, daysBack?=3, limit?=10, unreadOnly?)`

### 3. 白名单唤醒（最高优先级）
- Host 内置 IMAP 轮询（默认 120s，可调 ≥30s）。
- `allowFrom` 白名单：精确地址 `user@x.com` 或域名后缀 `@x.com`；**为空 = 永不唤醒**。
- 白名单发件人的新邮件 → 立即创建全新 DSH 会话并注入处理提示词（无头、无弹窗）。
- 非白名单邮件只记入 seen 与活动日志，**绝不唤醒**。
- 已处理 UID 记录在 `~/.dsh/smart-mail/seen-uids.json`，重启不重复唤醒。

### 4. 模型
唤醒会话**不写死模型**：不记录 `model/selection`，请求装配回落到
`agentDefaultModel`（DSH 当前默认模型）。改 DSH 默认模型即可换唤醒模型。

## 面板
设置 → 插件 → 「智能邮箱」标签页：账号增删改 + IMAP 测试、白名单编辑、
轮询间隔、唤醒提示词/工作目录、手动轮询、活动日志。

## 唤醒后新会话收到的提示词形态

```
[dsh-smart-mail 唤醒] <wakePrompt>
邮箱账号：<label>(<address>)
发件人（白名单命中）：<from>
主题：<subject>
时间：<locale time>
正文预览：<preview>
请处理这封邮件；如需回信，先确认收件人意图，再调用 send_email 工具发送。
```

## 安装

**方式一（npm 包名）**：

```
plugin_manager install_bundle target=dsh-smart-mail
```

**方式二（本地目录）**：克隆/下载本仓库后安装目录：

```
plugin_manager install_bundle target=<path-to>/dsh-smart-mail
```

装完后在面板（设置 → 插件 → 智能邮箱）里添加邮箱账号，并把要唤醒的白名单地址
写进 `allowFrom`（默认为空 = 永不唤醒）。

## 维护
- 活动日志：`~/.dsh/smart-mail/activity.log.jsonl`（面板「活动日志」可视化）。
- 排错：先看面板日志里 `poll-error` / `mail-wake` 条目。
