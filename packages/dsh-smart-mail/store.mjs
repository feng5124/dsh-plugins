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
    smtp: { host: 'smtp.office365.com', port: 587, tls: true },
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
