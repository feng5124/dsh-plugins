/**
 * dsh-smart-mail — durable state.
 *
 * Files under `<dsh home>/smart-mail/` (0600):
 *   accounts.json    - mailbox accounts (auth codes)
 *   threads.json     - thread tag <-> session binding, plus our own outgoing
 *                      Message-IDs -> tag, so a reply chain always resolves
 *   messages.json    - every inbound message the channel acted on, keyed by
 *                      Message-ID: which session it belongs to and how far it got
 *   last-config.json - the last effective config, so a restart can tell
 *                      "same config" from "the user changed something"
 *   seen-uids.json   - per-account UID watermark bookkeeping (read_emails unread)
 *   activity.log.jsonl        - current activity log
 *   activity-<stamp>.jsonl    - rotated archives (see LOG_ROTATION below)
 *
 * Log rotation policy (mirrored in the panel and README):
 *   - rotate when the current file reaches `logMaxBytes` (default 2 MiB), or
 *     when its UTC+local calendar day differs from today, or when its mtime is
 *     older than `logKeepDays` (a process that sat idle across midnight);
 *   - archives are pruned to at most `logKeepFiles` (default 20) and never
 *     older than `logKeepDays` (default 7);
 *   - reads span the current file plus archives, newest first, so the panel
 *     keeps showing history after a rotation.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

/** DSH home: honours DSH_HOME (the same override the Host uses), else ~/.dsh. */
function resolveDshHome() {
  const override = process.env.DSH_HOME
  if (typeof override === 'string' && override.trim() !== '') return override.trim()
  return path.join(homedir(), '.dsh')
}

export const STATE_DIR = path.join(resolveDshHome(), 'smart-mail')
const ACCOUNTS_FILE = path.join(STATE_DIR, 'accounts.json')
const SEEN_FILE = path.join(STATE_DIR, 'seen-uids.json')
const THREADS_FILE = path.join(STATE_DIR, 'threads.json')
const MESSAGES_FILE = path.join(STATE_DIR, 'messages.json')
const LAST_CONFIG_FILE = path.join(STATE_DIR, 'last-config.json')
const LOG_FILE = path.join(STATE_DIR, 'activity.log.jsonl')
const LOG_PREFIX = 'activity-'
const LOG_SUFFIX = '.jsonl'

/** Log rotation defaults, overridable from config. */
export const LOG_ROTATION = {
  maxBytes: 2 * 1024 * 1024,
  keepDays: 7,
  keepFiles: 20,
}

/** Provider presets: authorization-code IMAP/SMTP endpoints. */
export const PRESETS = {
  qq: {
    label: 'QQ 邮箱',
    imap: { host: 'imap.qq.com', port: 993, tls: true },
    smtp: { host: 'smtp.qq.com', port: 465, tls: true },
  },
  '163': {
    label: '网易 163 邮箱',
    imap: { host: 'imap.163.com', port: 993, tls: true },
    // 163 的 25 端口需要 STARTTLS，本客户端只实现隐式 TLS，必须用 465/SSL。
    smtp: { host: 'smtp.163.com', port: 465, tls: true },
  },
  '126': {
    label: '网易 126 邮箱',
    imap: { host: 'imap.126.com', port: 993, tls: true },
    smtp: { host: 'smtp.126.com', port: 465, tls: true },
  },
  gmail: {
    label: 'Gmail',
    imap: { host: 'imap.gmail.com', port: 993, tls: true },
    smtp: { host: 'smtp.gmail.com', port: 465, tls: true },
  },
  outlook: {
    label: 'Outlook / Microsoft 365',
    imap: { host: 'outlook.office365.com', port: 993, tls: true },
    // 587 是 STARTTLS 提交端口，本客户端只实现隐式 TLS（STARTTLS 升级会当场
    // 报错说明）。微软官方提交端口实为 587+STARTTLS；465 隐式 TLS 在部分租户
    // 可用。预设给 465（能用的形态），备注写明 587 需要本客户端不支持的能力。
    smtp: { host: 'smtp.office365.com', port: 465, tls: true },
    smtpNote: '若 465 被租户策略拒绝，需要 587+STARTTLS（本客户端暂不支持 STARTTLS 升级）',
  },
  custom: {
    label: '自定义 IMAP/SMTP',
    imap: { host: '', port: 993, tls: true },
    smtp: { host: '', port: 465, tls: true },
  },
}

function readJson(file, fallback) {
  if (!existsSync(file)) return fallback
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 })
}

/* ---------------------------------------------------------- attachment index */

const ATTACHMENTS_FILE = path.join(STATE_DIR, 'attachments.json')

/**
 * 附件下载索引（2026-11-07 删除机制）：`download_attachment` 每次落盘都记一条，
 * 清扫器按它删除过期文件——没有索引，插件就无法知道"哪些文件是我下载的"，
 * 也就不敢做任何清理（用户目录里可能有别人的文件）。
 *
 *   attachments[accountId][savedPath] = { uid, filename, size, savedAt }
 *
 * 只登记本插件写出的路径；`byPath` 反查用于防止重复记录覆盖旧行。
 */
export function loadAttachmentIndex() {
  const file = ATTACHMENTS_FILE
  if (!existsSync(file)) return { byPath: {}, version: 1 }
  let value
  try {
    value = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    // 损坏索引不能静默清零回写——登记全丢 = 孤儿文件永不清扫 + 面板清单
    // 凭空消失且用户无从察觉（复审 P3）。改名归档留证，从空索引重新开始。
    try {
      const backup = `${file}.corrupt-${Date.now()}`
      renameSync(file, backup)
      console.error(`[smart-mail] attachments.json 损坏，已归档为 ${path.basename(backup)}`)
    } catch { /* 归档失败也只能重来 */ }
    return { byPath: {}, version: 1 }
  }
  const index = value && typeof value === 'object' ? value : {}
  index.byPath = index.byPath && typeof index.byPath === 'object' ? index.byPath : {}
  index.version = 1
  return index
}

export function recordAttachment(accountId, savedPath, meta) {
  const index = loadAttachmentIndex()
  index.byPath[savedPath] = {
    account: accountId,
    uid: meta?.uid ?? null,
    filename: meta?.filename ?? path.basename(savedPath),
    size: meta?.size ?? null,
    savedAt: Date.now(),
  }
  writeJson(ATTACHMENTS_FILE, index)
}

export function forgetAttachment(savedPath) {
  const index = loadAttachmentIndex()
  delete index.byPath[savedPath]
  writeJson(ATTACHMENTS_FILE, index)
}

/**
 * 清扫过期附件：删除 `savedAt` 距今超过 `keepDays` 的已登记文件并从索引移除。
 *
 * 防御性约束（清扫器是会删用户文件的东西，必须多重护栏）：
 *   - 只碰**索引里登记过**的绝对路径，索引外文件一个不碰；
 *   - 删前 stat 校验路径仍指向普通文件（目录/符号链接/已消失都跳过）；
 *   - `keepDays <= 0` = 永久保留（关掉自动清理）。
 *
 * @param {number} keepDays 保留天数；0 或负数 = 不清扫
 * @returns {{removed: number, failed: number, kept: number}}
 */
export function sweepAttachments(keepDays) {
  const days = Number(keepDays)
  if (!Number.isFinite(days) || days <= 0) return { removed: 0, failed: 0, kept: 0 }
  const cutoff = Date.now() - days * 86_400_000
  const index = loadAttachmentIndex()
  let removed = 0
  let failed = 0
  let kept = 0
  for (const [file, meta] of Object.entries(index.byPath)) {
    const savedAt = meta?.savedAt ?? 0
    if (savedAt >= cutoff) { kept += 1; continue }
    try {
      // 索引可能带着旧机器/已删目录的路径：existsSync 不真再删。
      if (existsSync(file)) {
        const st = statSync(file)
        if (st.isFile()) {
          unlinkSync(file)
          removed += 1
        } else {
          failed += 1
          continue // 不是普通文件：留在索引里，不静默吞掉
        }
      }
      delete index.byPath[file]
    } catch {
      failed += 1
      continue // 删失败（占用/权限）：留下次再试
    }
  }
  writeJson(ATTACHMENTS_FILE, index)
  return { removed, failed, kept }
}

/* ------------------------------------------------------------------ accounts */
export function listAccounts() {
  return readJson(ACCOUNTS_FILE, [])
}

export function getAccount(id) {
  return listAccounts().find((a) => a.id === id) ?? null
}

export function saveAccount(input) {
  const accounts = listAccounts()
  const preset = PRESETS[input.preset] ?? PRESETS.custom
  const account = {
    id: input.id ?? `acct-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    label: input.label ?? input.address ?? '未命名',
    address: input.address,
    authCode: input.authCode,
    preset: input.preset ?? 'custom',
    imap: input.imap ?? { ...preset.imap },
    smtp: input.smtp ?? { ...preset.smtp },
    createdAt: Date.now(),
  }
  if (!account.address || !account.authCode) throw new Error('address and authCode are required')
  if (!account.imap.host || !account.smtp.host) throw new Error('imap/smtp host is required')
  const idx = accounts.findIndex((a) => a.id === account.id)
  if (idx >= 0) accounts[idx] = { ...accounts[idx], ...account }
  else accounts.push(account)
  writeJson(ACCOUNTS_FILE, accounts)
  return account
}

export function removeAccount(id) {
  const accounts = listAccounts().filter((a) => a.id !== id)
  writeJson(ACCOUNTS_FILE, accounts)
  return { removed: true }
}

/* -------------------------------------------------------------- seen UIDs */

/** Seen-UID bookkeeping: { [accountId]: { [uid]: {at, from, subject, woke} } } */
export function loadSeen() {
  return readJson(SEEN_FILE, {})
}

export function saveSeen(seen) {
  // Keep each account's map bounded to the newest 500 entries.
  for (const id of Object.keys(seen)) {
    const entries = Object.entries(seen[id] ?? {})
    if (entries.length > 500) {
      entries.sort((a, b) => (b[1]?.at ?? 0) - (a[1]?.at ?? 0))
      seen[id] = Object.fromEntries(entries.slice(0, 500))
    }
  }
  writeJson(SEEN_FILE, seen)
}

/* ---------------------------------------------------------------- threads */

/**
 * Thread bindings, both directions:
 *   byTag[tag]        = { sessionId, subject, createdAt, updatedAt, round }
 *   outgoing[msgId]   = tag        (our own Message-IDs)
 */
export function loadThreads() {
  const value = readJson(THREADS_FILE, null)
  const threads = value && typeof value === 'object' ? value : {}
  threads.byTag = threads.byTag && typeof threads.byTag === 'object' ? threads.byTag : {}
  threads.outgoing = threads.outgoing && typeof threads.outgoing === 'object' ? threads.outgoing : {}
  threads.version = 1
  return threads
}

export function saveThreads(threads) {
  const tags = Object.entries(threads.byTag ?? {})
  if (tags.length > 500) {
    tags.sort((a, b) => (b[1]?.updatedAt ?? 0) - (a[1]?.updatedAt ?? 0))
    threads.byTag = Object.fromEntries(tags.slice(0, 500))
  }
  const outgoing = Object.entries(threads.outgoing ?? {})
  if (outgoing.length > 2000) {
    threads.outgoing = Object.fromEntries(outgoing.slice(outgoing.length - 2000))
  }
  writeJson(THREADS_FILE, threads)
  return threads
}

export function sessionForTag(tag) {
  if (!tag) return undefined
  return loadThreads().byTag[tag]?.sessionId
}

export function tagForOutgoing(messageId) {
  if (!messageId) return undefined
  return loadThreads().outgoing[messageId]
}

export function tagForSession(sessionId) {
  if (!sessionId) return undefined
  const threads = loadThreads()
  for (const [tag, record] of Object.entries(threads.byTag)) {
    if (record?.sessionId === sessionId) return tag
  }
  return undefined
}

/**
 * Bind a thread tag to a session.
 *
 * `move: false` (the default) refuses to re-point an established binding and
 * reports the conflict instead: a tag is the thread's identity, so moving it
 * would split one conversation across two sessions.
 */
export function bindThread(tag, { sessionId, subject, move = false } = {}) {
  const threads = loadThreads()
  const previous = threads.byTag[tag]
  if (previous !== undefined && previous.sessionId !== sessionId && !move) {
    return { rebound: true, previousSessionId: previous.sessionId, sessionId: previous.sessionId }
  }
  threads.byTag[tag] = {
    sessionId,
    subject: subject ?? previous?.subject ?? null,
    createdAt: previous?.createdAt ?? Date.now(),
    updatedAt: Date.now(),
    round: previous?.round ?? 0,
  }
  saveThreads(threads)
  return { rebound: false, previousSessionId: previous?.sessionId, sessionId }
}

export function bumpThreadRound(tag) {
  const threads = loadThreads()
  const record = threads.byTag[tag]
  if (record === undefined) return 0
  record.round = (record.round ?? 0) + 1
  record.updatedAt = Date.now()
  saveThreads(threads)
  return record.round
}

/**
 * Pin (or clear) the model one thread's session should use.
 *
 * Stored on the thread rather than in config so a single conversation can be
 * moved to another model without changing every future mail session.
 *
 * @param {string} tag
 * @param {object|null} selection `{provider, model, reasoningEffort?}` or null to clear
 * @returns {{ok: boolean, tag: string, modelSelection: object|null, error?: string}}
 */
export function setThreadModel(tag, selection) {
  const threads = loadThreads()
  const record = threads.byTag[tag]
  if (record === undefined) return { ok: false, tag, modelSelection: null, error: 'unknown thread tag' }
  if (selection === null || selection === undefined) {
    delete record.modelSelection
  } else {
    record.modelSelection = {
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
    }
  }
  record.updatedAt = Date.now()
  saveThreads(threads)
  return { ok: true, tag, modelSelection: record.modelSelection ?? null }
}

/** Read one thread's pinned model, or `undefined`. */
export function threadModel(tag) {
  if (!tag) return undefined
  return loadThreads().byTag[tag]?.modelSelection
}

/** Record one of our own outgoing Message-IDs so replies to it resolve to the thread. */
export function recordOutgoing(messageId, tag) {
  if (!messageId || !tag) return
  const threads = loadThreads()
  threads.outgoing[messageId] = tag
  saveThreads(threads)
}

export function listThreads() {
  return loadThreads()
}

/* --------------------------------------------------------------- messages */

export function loadMessages() {
  const value = readJson(MESSAGES_FILE, null)
  const store = value && typeof value === 'object' ? value : {}
  store.items = store.items && typeof store.items === 'object' ? store.items : {}
  store.version = 1
  return store
}

export function saveMessages(store) {
  const entries = Object.entries(store.items ?? {})
  // Bound the document: keep unfinished records, then the newest completed ones.
  if (entries.length > 2000) {
    const cutoff = Date.now() - 90 * 86_400_000
    const kept = entries
      .filter(([, value]) => value?.stage !== 'done' || (value.updatedAt ?? 0) >= cutoff)
      .sort((a, b) => (b[1]?.updatedAt ?? 0) - (a[1]?.updatedAt ?? 0))
      .slice(0, 2000)
    store.items = Object.fromEntries(kept)
  }
  writeJson(MESSAGES_FILE, store)
  return store
}

export function getMessage(messageId) {
  if (!messageId) return undefined
  return loadMessages().items[messageId]
}

export function putMessage(messageId, patch) {
  const store = loadMessages()
  const previous = store.items[messageId] ?? {}
  const next = { ...previous, ...patch, messageId, updatedAt: Date.now() }
  store.items[messageId] = next
  saveMessages(store)
  return next
}

/* ---------------------------------------------------------- 邮件托管提问单 */

/**
 * 托管提问的持久化（`hosting.json`）。
 *
 * 为什么要落盘：一问可能就是一夜。进程重启、桌面端升级、插件 HMR 都会
 * 丢掉内存状态，而用户的回信第二天才来 —— 那时必须还能把答案对回原来的
 * 会话与问题。所以提问单（含完整 questions，平台要求答案批量必须逐题
 * 对应）必须落盘，且要在回信到达时仍然可读。
 *
 * 记录形状：
 *   tickets[ticket] = {
 *     ticket, callId, sessionId, sessionTitle,
 *     questions,           // ask_user_question 原始问题（回灌答案时要用）
 *     status,              // waiting | answered | expired | cancelled | failed
 *     messageId,           // 我方发出的邮件 Message-ID（回信 References 兜底）
 *     subject,
 *     askedAt, updatedAt,
 *     waitMs,              // 前台等待窗口
 *     answers,             // 已解析出的答案（answering 之后）
 *     deliveredVia,        // in-time | late | cancelled
 *     error,
 *   }
 *   byMessageId[<msgid>] = ticket   // 回信只带 References 时的反查表
 */
const HOSTING_FILE = path.join(STATE_DIR, 'hosting.json')

export function loadHosting() {
  const value = readJson(HOSTING_FILE, null)
  const store = value && typeof value === 'object' ? value : {}
  store.tickets = store.tickets && typeof store.tickets === 'object' ? store.tickets : {}
  store.byMessageId = store.byMessageId && typeof store.byMessageId === 'object' ? store.byMessageId : {}
  store.version = 1
  return store
}

export function saveHosting(store) {
  const entries = Object.entries(store.tickets ?? {})
  // 只保留还能被回信回答的、以及最近一周内结束的：更老的提问单回信也没用了。
  if (entries.length > 200) {
    const cutoff = Date.now() - 7 * 86_400_000
    const kept = entries
      .filter(([, value]) => value?.status === 'waiting' || value?.status === 'expired' || (value.updatedAt ?? 0) >= cutoff)
      .sort((a, b) => (b[1]?.updatedAt ?? 0) - (a[1]?.updatedAt ?? 0))
      .slice(0, 200)
    store.tickets = Object.fromEntries(kept)
    const live = new Set(kept.map(([ticket]) => ticket))
    store.byMessageId = Object.fromEntries(
      Object.entries(store.byMessageId ?? {}).filter(([, ticket]) => live.has(ticket)),
    )
  }
  writeJson(HOSTING_FILE, store)
  return store
}

export function getTicket(ticket) {
  if (!ticket) return undefined
  return loadHosting().tickets[ticket]
}

export function putTicket(ticket, patch) {
  const store = loadHosting()
  const previous = store.tickets[ticket] ?? {}
  const next = { ...previous, ...patch, ticket, updatedAt: Date.now() }
  if (previous.askedAt === undefined && next.askedAt === undefined) next.askedAt = Date.now()
  store.tickets[ticket] = next
  if (typeof next.messageId === 'string' && next.messageId !== '') store.byMessageId[next.messageId] = ticket
  saveHosting(store)
  return next
}

/** 回信只带 References 时，用我方发出的 Message-ID 反查提问单号。 */
export function ticketForHostedMessage(messageId) {
  if (!messageId) return undefined
  return loadHosting().byMessageId[messageId]
}

/** 某会话当前还在等的提问单（面板/胶囊用）。 */
export function ticketsForSession(sessionId) {
  if (!sessionId) return []
  return Object.values(loadHosting().tickets)
    .filter((record) => record?.sessionId === sessionId)
    .sort((a, b) => (b.askedAt ?? 0) - (a.askedAt ?? 0))
}

/** 全部提问单，最新在前（面板列表用）。 */
export function listTickets() {
  return Object.values(loadHosting().tickets).sort((a, b) => (b.askedAt ?? 0) - (a.askedAt ?? 0))
}

/**
 * 「这个会话是邮件唤醒出来的」标记。
 *
 * 为什么单独存：邮件托管对邮件唤醒的会话**默认开启**（用户 2026-11-11 指定），
 * 这个身份必须跨重启保留 —— 用户当天被邮件唤醒、第二天才在会话里被提问，
 * 那时进程早就重启过了，光靠内存记不住。
 *
 * 存成一个 id -> 时间戳 的字典（不是数组）：重复唤醒同一会话不会堆积，
 * 也便于按时间淘汰。
 */
export function loadMailWoken() {
  const store = loadHosting()
  const map = store.mailWoken
  return map !== null && typeof map === 'object' && !Array.isArray(map) ? map : {}
}

export function markMailWoken(sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return
  const store = loadHosting()
  if (store.mailWoken === null || typeof store.mailWoken !== 'object' || Array.isArray(store.mailWoken)) store.mailWoken = {}
  store.mailWoken[sessionId] = Date.now()
  // 上限 500：只留最近唤醒的，更老的会话托管已经回落到全局默认。
  const entries = Object.entries(store.mailWoken)
  if (entries.length > 500) {
    entries.sort((a, b) => b[1] - a[1])
    store.mailWoken = Object.fromEntries(entries.slice(0, 500))
  }
  saveHosting(store)
}

export function isMailWoken(sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return false
  return loadMailWoken()[sessionId] !== undefined
}

/* ----------------------------------------------------------- config memory */

export function loadLastConfig() {
  return readJson(LAST_CONFIG_FILE, null)
}

export function saveLastConfig(config) {
  writeJson(LAST_CONFIG_FILE, { savedAt: Date.now(), config })
}

/* -------------------------------------------------------------------- log */

function logStamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

function dayKey(date) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
}

/** Rotated archives, newest first. */
function archiveFiles() {
  if (!existsSync(STATE_DIR)) return []
  return readdirSync(STATE_DIR)
    .filter((name) => name.startsWith(LOG_PREFIX) && name.endsWith(LOG_SUFFIX))
    .map((name) => path.join(STATE_DIR, name))
    .sort((a, b) => {
      const left = statSafe(a)?.mtimeMs ?? 0
      const right = statSafe(b)?.mtimeMs ?? 0
      return right - left
    })
}

function statSafe(file) {
  try {
    return statSync(file)
  } catch {
    return null
  }
}

function unlinkSafe(file) {
  try {
    unlinkSync(file)
  } catch {
    // rotation must never break logging
  }
}

/**
 * Rotate the current log when it is too big, belongs to an earlier day, or is
 * simply stale; then prune archives past the retention window.
 *
 * @param {{maxBytes?: number, keepDays?: number, keepFiles?: number, now?: Date, reason?: string}} options
 * @returns {{rotated: boolean, file?: string, pruned: number}}
 */
export function rotateLog(options = {}) {
  const maxBytes = Number(options.maxBytes ?? LOG_ROTATION.maxBytes) || LOG_ROTATION.maxBytes
  const keepDays = Number(options.keepDays ?? LOG_ROTATION.keepDays) || LOG_ROTATION.keepDays
  const keepFiles = Number(options.keepFiles ?? LOG_ROTATION.keepFiles) || LOG_ROTATION.keepFiles
  const now = options.now ?? new Date()
  let rotated = false
  let file
  const info = statSafe(LOG_FILE)
  if (info !== null) {
    const tooBig = info.size >= maxBytes
    const otherDay = dayKey(info.mtime) !== dayKey(now)
    if (tooBig || otherDay) {
      let target = path.join(STATE_DIR, `${LOG_PREFIX}${logStamp(info.mtime)}${LOG_SUFFIX}`)
      if (existsSync(target)) target = path.join(STATE_DIR, `${LOG_PREFIX}${logStamp(info.mtime)}-${Date.now().toString(36)}${LOG_SUFFIX}`)
      try {
        renameSync(LOG_FILE, target)
        rotated = true
        file = target
        if (options.reason !== undefined) {
          // Written into the fresh file so the archive boundary is self-describing.
          appendFileSync(LOG_FILE, `${JSON.stringify({
            at: Date.now(),
            kind: 'log-rotate',
            reason: options.reason,
            previousFile: path.basename(target),
            previousBytes: info.size,
            maxBytes,
            keepDays,
            keepFiles,
          })}\n`, { encoding: 'utf8', mode: 0o600 })
        }
      } catch {
        // A failed rename leaves the log in place; the size check retries next append.
      }
    }
  }
  // Prune: age first, then count.
  let pruned = 0
  const cutoff = now.getTime() - keepDays * 86_400_000
  let archives = archiveFiles()
  for (const archive of archives) {
    const info2 = statSafe(archive)
    if (info2 === null) continue
    if (info2.mtimeMs < cutoff) {
      unlinkSafe(archive)
      pruned += 1
    }
  }
  archives = archiveFiles()
  if (archives.length > keepFiles) {
    for (const archive of archives.slice(keepFiles)) {
      unlinkSafe(archive)
      pruned += 1
    }
  }
  return { rotated, file, pruned }
}

/**
 * Append one activity record.
 *
 * Every record is a single JSON line whose first field is `at` (epoch ms) —
 * that is the shape the settings panel renders, so it must not change.
 * Rotation runs first, so a single huge record can never grow the file past
 * one rotation step.
 *
 * @param {object} record
 * @param {{maxBytes?: number, keepDays?: number, keepFiles?: number}} [rotation]
 */
export function appendLog(record, rotation = {}) {
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    rotateLog(rotation)
    appendFileSync(LOG_FILE, `${JSON.stringify({ at: Date.now(), ...record })}\n`, { encoding: 'utf8', mode: 0o600 })
  } catch {
    // logging must never break the poller
  }
}

function parseLines(text) {
  const out = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      const value = JSON.parse(trimmed)
      if (value && typeof value === 'object') out.push(value)
    } catch {
      // A torn last line after a crash is skipped, not fatal.
    }
  }
  return out
}

/**
 * Read the newest `limit` records across the current log and its archives.
 * @param {number} limit
 * @returns {object[]} newest first
 */
export function readLog(limit = 50) {
  const want = Math.max(1, Number(limit) || 50)
  const records = []
  const files = [LOG_FILE, ...archiveFiles()]
  for (const file of files) {
    if (records.length >= want) break
    if (!existsSync(file)) continue
    try {
      const parsed = parseLines(readFileSync(file, 'utf8'))
      for (let i = parsed.length - 1; i >= 0 && records.length < want; i -= 1) records.push(parsed[i])
    } catch {
      // unreadable archive: skip
    }
  }
  return records
}

/**
 * Log health for the panel: current size, archive count, retention window, and
 * the oldest record still readable.
 * @param {{maxBytes?: number, keepDays?: number, keepFiles?: number}} [rotation]
 */
export function logStats(rotation = {}) {
  const maxBytes = Number(rotation.maxBytes ?? LOG_ROTATION.maxBytes) || LOG_ROTATION.maxBytes
  const keepDays = Number(rotation.keepDays ?? LOG_ROTATION.keepDays) || LOG_ROTATION.keepDays
  const keepFiles = Number(rotation.keepFiles ?? LOG_ROTATION.keepFiles) || LOG_ROTATION.keepFiles
  const current = statSafe(LOG_FILE)
  const archives = archiveFiles()
  let oldest = null
  for (const archive of archives) {
    const info = statSafe(archive)
    if (info !== null && (oldest === null || info.mtimeMs < oldest)) oldest = info.mtimeMs
  }
  return {
    file: LOG_FILE,
    currentBytes: current?.size ?? 0,
    maxBytes,
    archives: archives.length,
    keepDays,
    keepFiles,
    oldestArchiveAt: oldest,
    policy: `按大小(${Math.round(maxBytes / 1024)}KiB)或跨天自动切分；保留最近 ${keepDays} 天、最多 ${keepFiles} 个归档`,
  }
}

/* --------------------------------------------------------------- matching */

/** Whether `from` matches the whitelist: exact address or @domain suffix. */
export function matchesAllowFrom(from, allowFrom) {
  if (!from) return false
  const lower = String(from).toLowerCase()
  return (allowFrom ?? []).some((rule) => {
    const r = String(rule).trim().toLowerCase()
    if (!r) return false
    if (r.startsWith('@')) return lower.endsWith(r)
    return lower === r
  })
}
