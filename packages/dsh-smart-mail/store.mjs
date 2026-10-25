/**
 * dsh-smart-mail — account store.
 *
 * Accounts live in ~/.dsh/smart-mail/accounts.json (0600). Each account:
 *   { id, label, address, authCode, imap:{host,port,tls}, smtp:{host,port,tls} }
 * `preset` names a provider preset; custom keeps user-entered hosts.
 *
 * Config (from cordis.patch.yml, editable via panel routes): enabled,
 * pollIntervalSec, allowFrom[], model, wakePrompt, wakeCwd.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

export const STATE_DIR = path.join(homedir(), '.dsh', 'smart-mail')
const ACCOUNTS_FILE = path.join(STATE_DIR, 'accounts.json')
const SEEN_FILE = path.join(STATE_DIR, 'seen-uids.json')
const LOG_FILE = path.join(STATE_DIR, 'activity.log.jsonl')

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

/** Seen-UID bookkeeping: { [accountId]: { [uid]: {at, from, subject, woke} } } */
export function loadSeen() {
  return readJson(SEEN_FILE, {})
}

export function saveSeen(seen) {
  // Keep each account's map bounded to the newest 500 entries.
  for (const id of Object.keys(seen)) {
    const entries = Object.entries(seen[id])
    if (entries.length > 500) {
      entries.sort((a, b) => b[1].at - a[1].at)
      seen[id] = Object.fromEntries(entries.slice(0, 500))
    }
  }
  writeJson(SEEN_FILE, seen)
}

export function appendLog(record) {
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(LOG_FILE, JSON.stringify({ at: Date.now(), ...record }) + '\n', { flag: 'a' })
  } catch {
    // logging must never break the poller
  }
}

export function readLog(limit = 50) {
  if (!existsSync(LOG_FILE)) return []
  try {
    const lines = readFileSync(LOG_FILE, 'utf8').trim().split('\n').filter(Boolean)
    return lines.slice(-limit).map((l) => JSON.parse(l)).reverse()
  } catch {
    return []
  }
}

/** Whether `from` matches the whitelist: exact address or @domain suffix. */
export function matchesAllowFrom(from, allowFrom) {
  if (!from) return false
  const lower = from.toLowerCase()
  return allowFrom.some((rule) => {
    const r = String(rule).trim().toLowerCase()
    if (!r) return false
    if (r.startsWith('@')) return lower.endsWith(r)
    return lower === r
  })
}
