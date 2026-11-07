/**
 * dsh-smart-mail — mail threading: identities, tags, and header parsing.
 *
 * Two identities travel with every message this plugin sends:
 *
 *   - a **thread tag** in the subject (`[dsh-a3f9]`), mirrored in the
 *     `X-DSH-Session` header, so a human can keep the thread alive even when
 *     their client drops `References`;
 *   - a **Message-ID** recorded against that tag, so `In-Reply-To` /
 *     `References` resolve the thread exactly.
 *
 * Resolution order on inbound (the order matters — exact evidence first,
 * human-visible fallback last):
 *   1. `References` / `In-Reply-To` matched against our own outgoing IDs;
 *   2. the `X-DSH-Session` header a client may have kept;
 *   3. the subject tag, tolerantly matched (clients rewrite `Re:`/`回复:`,
 *      re-encode the subject, drop the closing bracket, or upper-case it).
 *
 * The subject tag is only ever compared against our own thread table, so a
 * permissive match cannot bind a message to the wrong conversation: an
 * unknown tag simply starts a new thread.
 *
 * This module is pure (no I/O) so the decisions are testable without a
 * mailbox; `store.mjs` owns persistence.
 */

import { createHash, randomUUID } from 'node:crypto'

/** Default subject tag prefix; the closing bracket is added when tagging. */
export const DEFAULT_TAG_PREFIX = '[dsh-'

/** Domain part of an address, falling back to a stable placeholder. */
export function domainOf(address) {
  const at = String(address ?? '').lastIndexOf('@')
  return at === -1 ? 'dsh.local' : String(address).slice(at + 1)
}

/** A Message-ID that identifies this plugin's traffic. */
export function newMessageId(from) {
  const random = randomUUID().replace(/-/g, '').slice(0, 16)
  return `<dsh.${random}@${domainOf(from)}>`
}

/** Stable short id derived from a string, used for thread tags. */
export function shortId(input, length = 4) {
  return createHash('sha1').update(String(input)).digest('hex').slice(0, length)
}

function escapePrefix(prefix) {
  return String(prefix).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Strip an existing thread tag so a re-tagged subject never stacks tags. */
export function stripSubjectTag(subject, prefix = DEFAULT_TAG_PREFIX) {
  if (typeof subject !== 'string') return ''
  const escaped = escapePrefix(prefix)
  return subject
    .replace(new RegExp(`\\s*${escaped}\\s*[0-9a-fA-F]{3,16}\\]?`, 'g'), ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/** Prefix a subject with the thread tag, keeping any existing `Re:` markers. */
export function tagSubject(subject, tag, prefix = DEFAULT_TAG_PREFIX) {
  const base = stripSubjectTag(subject, prefix)
  const rePrefix = base.match(/^((?:Re|RE|回复|答复|返信)\s*:\s*)+/)?.[0] ?? ''
  const rest = base.slice(rePrefix.length).trim()
  return `${rePrefix}${prefix}${tag}]${rest.length > 0 ? ` ${rest}` : ''}`
}

/**
 * Extract the thread tag from a subject, or `undefined` when absent.
 * @param {string} subject
 * @param {string} [prefix]
 * @returns {string|undefined} lower-cased tag
 */
export function tagFromSubject(subject, prefix = DEFAULT_TAG_PREFIX) {
  if (typeof subject !== 'string' || subject.length === 0) return undefined
  const escaped = escapePrefix(prefix)
  const prefixed = subject.match(new RegExp(`${escaped}\\s*([0-9a-fA-F]{3,16})\\]?`, 'i'))
  if (prefixed !== null) return prefixed[1].toLowerCase()
  // Fallback for a client that dropped the prefix but kept the bracket. Narrow
  // on purpose: our exact tag widths and at least one letter, so `[12345]`,
  // `[2024]`, `[1]` in someone's subject are never read as a session.
  const bracketed = subject.match(/\[([0-9a-f]{4}|[0-9a-f]{6})\]/i)
  if (bracketed === null || !/[a-f]/i.test(bracketed[1])) return undefined
  return bracketed[1].toLowerCase()
}

/** A fresh tag for a brand-new thread. */
export function newTag(seed) {
  return shortId(`${seed}:${Date.now()}:${Math.random()}`, 4)
}

/* ------------------------------------------------------------- header text */

/** Split a raw message into its header block and body. */
export function splitHeaders(raw) {
  const text = String(raw ?? '')
  const match = /\r?\n\r?\n/.exec(text)
  if (match === null) return { headerText: text, bodyText: '' }
  return { headerText: text.slice(0, match.index), bodyText: text.slice(match.index + match[0].length) }
}

/**
 * Parse a header block into a Map of lower-cased name -> unfolded value.
 * Repeated headers keep the first occurrence except for the threading set,
 * where every occurrence is joined with a space (which is how `References`
 * spans lines anyway).
 */
export function parseHeaderBlock(headerText) {
  const headers = new Map()
  const lines = String(headerText ?? '').split(/\r?\n/)
  let currentName = null
  let currentValue = ''
  const commit = () => {
    if (currentName === null) return
    const value = currentValue.trim()
    if (headers.has(currentName)) headers.set(currentName, `${headers.get(currentName)} ${value}`.trim())
    else headers.set(currentName, value)
    currentName = null
    currentValue = ''
  }
  for (const line of lines) {
    if (/^[ \t]/.test(line) && currentName !== null) {
      currentValue += ` ${line.trim()}`
      continue
    }
    const match = /^([!-9;-~]+):\s*(.*)$/.exec(line)
    if (match === null) {
      commit()
      continue
    }
    commit()
    currentName = match[1].toLowerCase()
    currentValue = match[2]
  }
  commit()
  return headers
}

/** Read one header value, or `undefined`. */
export function headerValue(headers, name) {
  if (headers === undefined || headers === null) return undefined
  const map = headers instanceof Map ? headers : parseHeaderBlock(String(headers))
  return map.get(String(name).toLowerCase())
}

/** Every `<...>` message id in a header value. */
export function messageIdsIn(value) {
  if (value === undefined || value === null) return []
  const out = []
  const re = /<[^<>\s]+>/g
  let match
  while ((match = re.exec(String(value))) !== null) out.push(match[0])
  return out
}

/**
 * Canonical `<id@host>` from whatever a caller passed as the parent Message-ID.
 *
 * 真机教训（2026-11-07 22:33 验收线程）：Agent 从唤醒 prompt 里抄 Message-ID
 * 时把它写成了 HTML 实体 `&lt;tencent_…&gt;`。旧实现原样塞进 `In-Reply-To`，
 * 头部于是变成 `In-Reply-To: &lt;tencent_…&gt;`——**不是合法 msg-id**，收件端
 * 只能当成新会话，于是"同线程回信"静默失效（本地 threads.json 却已按 tag 记了
 * 一笔，看起来是成功的）。这里先解实体再取第一个 `<...>`；取不到就返回
 * `undefined`，由调用方决定报错，绝不把脏值写进头部。
 *
 * @param {unknown} value
 * @returns {string|undefined}
 */
export function normalizeMessageId(value) {
  if (typeof value !== 'string') return undefined
  const decoded = value
    .replace(/&#0*6[02];/g, (m) => (m === '&#60;' ? '<' : '>'))
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&amp;/gi, '&')
  return messageIdsIn(decoded)[0]
}

/**
 * Every bare address in an address header value.
 *
 * 安全语义：RFC 5322 的 `From: "显示名" <路由地址>` 中，引号内是**任意文本**
 * （发件人随便写），只有 `<...>` 里的是真实路由地址。白名单判定若扫整行，
 * `"boss@trusted.example" <attacker@evil.com>` 就会提取出显示名里的地址，
 * 任何人把显示名设成白名单地址即可过闸（2026-11-07 P0 实证）。因此按逗号
 * 分段处理：段内有 `<...>` 只认尖括号地址；否则剥掉引号显示名再扫裸地址
 * （裸地址头与多地址头都保持兼容）。
 *
 * 分段必须**引号感知**：`"Doe, John" <john@x.com>` 的引号里就有逗号，
 * 朴素 split 会把它切成脏段（2026-11-07 复审指出的变体）。调用方（白名单
 * 判定）只应使用返回值的**第一个**地址作为发件身份——多地址 From 的其余
 * 地址仅作审计，绝不参与放行判定。
 */
export function addressesIn(value) {
  if (value === undefined || value === null) return []
  const segments = splitQuoted(String(value), ',')
  const out = []
  const bare = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/
  const angled = /<([^<>\s]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})>/
  for (const segment of segments) {
    const match = angled.exec(segment) ?? bare.exec(segment.replace(/"[^"]*"/g, ' '))
    if (match !== null) {
      const address = (match[1] ?? match[0]).toLowerCase()
      if (!out.includes(address)) out.push(address)
    }
  }
  return out
}

/** Split on `sep`, ignoring separators inside double-quoted strings. */
function splitQuoted(text, sep) {
  const out = []
  let current = ''
  let inQuotes = false
  for (const ch of text) {
    if (ch === '"') inQuotes = !inQuotes
    if (ch === sep && !inQuotes) {
      out.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  out.push(current)
  return out
}

/* ------------------------------------------------------------ loop guards */

/** Verdict reasons for mail that must never start a turn. */
export const IgnoreReason = {
  notAllowlisted: 'not-allowlisted',
  noSender: 'no-sender',
  selfSent: 'self-sent',
  autoSubmitted: 'auto-submitted',
  autoReplied: 'auto-replied',
  bulk: 'bulk',
  list: 'list',
  deliveryReport: 'delivery-report',
  noContent: 'no-content',
  foreignSender: 'thread-sender-not-allowlisted',
}

/**
 * Detect machine-generated traffic and anything that could bounce back into
 * the channel and loop.
 *
 * @param {Map<string,string>} headers
 * @param {{selfAddresses?: string[], sender?: string}} context
 * @returns {string|undefined} the ignore reason, or `undefined` when the message may proceed
 */
export function detectLoop(headers, context = {}) {
  const autoSubmitted = headerValue(headers, 'auto-submitted')
  if (autoSubmitted !== undefined && !/^no$/i.test(autoSubmitted.trim())) return IgnoreReason.autoSubmitted

  const precedence = headerValue(headers, 'precedence')
  if (precedence !== undefined && /^(bulk|junk|list|auto_reply)$/i.test(precedence.trim())) return IgnoreReason.bulk

  if (headerValue(headers, 'x-autoreply') !== undefined || headerValue(headers, 'x-autorespond') !== undefined) {
    return IgnoreReason.autoReplied
  }

  if (headers instanceof Map && (headers.has('list-id') || headers.has('list-unsubscribe') || headers.has('list-post'))) {
    return IgnoreReason.list
  }

  const returnPath = headerValue(headers, 'return-path')
  if (returnPath !== undefined && /<>/.test(returnPath)) return IgnoreReason.selfSent

  const contentType = headerValue(headers, 'content-type') ?? ''
  if (/^multipart\/report\b/i.test(contentType.trim())) return IgnoreReason.deliveryReport

  const sender = context.sender
  const selfAddresses = new Set((context.selfAddresses ?? []).map((address) => String(address).toLowerCase()))
  if (sender !== undefined && selfAddresses.has(String(sender).toLowerCase())) return IgnoreReason.selfSent

  return undefined
}

/**
 * Resolve which thread (and therefore which session) an inbound message
 * belongs to, following the documented order.
 *
 * @param {object} input
 * @param {Map<string,string>} input.headers
 * @param {(messageId: string) => string|undefined} input.lookupOutgoing
 * @param {(tag: string) => string|undefined} input.lookupTag
 * @param {string} [input.tagPrefix]
 * @returns {{tag?: string, sessionId?: string, via: string}}
 */
export function resolveThread({ headers, lookupOutgoing, lookupTag, tagPrefix = DEFAULT_TAG_PREFIX }) {
  const references = [
    ...messageIdsIn(headerValue(headers, 'references')),
    ...messageIdsIn(headerValue(headers, 'in-reply-to')),
  ]
  for (const reference of references) {
    const tag = lookupOutgoing(reference)
    if (tag === undefined) continue
    const sessionId = lookupTag(tag)
    if (sessionId !== undefined) return { tag, sessionId, via: 'references' }
    // Known tag, unknown session: report the tag so the caller can rebind it
    // deliberately instead of silently starting an unrelated conversation.
    return { tag, sessionId: undefined, via: 'references-orphan' }
  }

  const declared = headerValue(headers, 'x-dsh-session')
  if (declared !== undefined && declared.trim() !== '') {
    const tag = declared.trim().toLowerCase()
    const sessionId = lookupTag(tag)
    if (sessionId !== undefined) return { tag, sessionId, via: 'header' }
    return { tag, sessionId: undefined, via: 'header-orphan' }
  }

  const subjectTag = tagFromSubject(headerValue(headers, 'subject') ?? '', tagPrefix)
  if (subjectTag !== undefined) {
    const sessionId = lookupTag(subjectTag)
    if (sessionId !== undefined) return { tag: subjectTag, sessionId, via: 'subject' }
    return { tag: subjectTag, sessionId: undefined, via: 'subject-orphan' }
  }

  return { via: 'none' }
}

/** Header names fetched for classification (kept in one place for IMAP). */
export const THREAD_HEADER_FIELDS = [
  'From',
  'To',
  'Cc',
  'Subject',
  'Date',
  'Message-ID',
  'In-Reply-To',
  'References',
  'X-DSH-Session',
  'X-DSH-Receipt',
  'Auto-Submitted',
  'Precedence',
  'List-Id',
  'List-Unsubscribe',
  'List-Post',
  'Return-Path',
  'Content-Type',
  'X-Autoreply',
  'X-Autorespond',
]
