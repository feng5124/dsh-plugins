/**
 * dsh-smart-mail — MIME body extraction.
 *
 * The old `decodeBodyPreview` looked for `Content-Transfer-Encoding: base64`
 * anywhere in the first 800 bytes of `BODY[TEXT]` and, if found, base64-decoded
 * the *whole* body. That works only for a single-part message. A
 * `multipart/alternative` message (what QQ and most clients send) begins with
 * `This is a multi-part message in MIME format.` followed by boundaries and
 * per-part headers, so the "body" is not base64 at all — decoding it yields
 * nothing, and every such mail arrived with an empty preview even though the
 * text was right there.
 *
 * This module does the small amount of real MIME work needed for a preview:
 * split on the boundary, walk the parts, prefer `text/plain`, and decode each
 * part with *its own* transfer encoding (base64 / quoted-printable / 7bit).
 *
 * It is deliberately not a full RFC 5322 implementation: no nested-multipart
 * recursion beyond one level, no charset conversion other than UTF-8 (with a
 * latin1 fallback), no attachment extraction. It exists to turn
 * `BODY[TEXT]` bytes into readable text.
 *
 * @module dsh-smart-mail/mime
 */

/**
 * Decode quoted-printable (`=3D`, `=20`, soft line breaks).
 *
 * 字节还原：QP 是**字节级**编码——`=E4=BD=A0` 是 UTF-8 的三个字节，不是三个
 * latin1 字符。先按字节收进 latin1 字符串，再按部件声明的 charset 一次性
 * 解回文本；直接 fromCharCode 会让所有非 ASCII 正文变 mojibake
 * （`你好` → `ä½ å¥½`，2026-11-07 P1 实证）。charset 缺省 utf-8；
 * 无 TextDecoder 支持的 charset 退回 utf-8。
 */
export function decodeQuotedPrintable(text, charset) {
  const bytes = Buffer.from(
    String(text)
      // Soft breaks: `=\r\n` / `=\n` join the lines.
      .replace(/=\r?\n/g, '')
      .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))),
    'latin1',
  )
  const label = String(charset ?? 'utf-8').toLowerCase()
  try {
    return new TextDecoder(label).decode(bytes)
  } catch {
    return bytes.toString('utf8')
  }
}

/** Decode base64, ignoring whitespace and stray non-alphabet characters. */
export function decodeBase64(text, charset) {
  const clean = String(text).replace(/[^A-Za-z0-9+/=]/g, '')
  if (clean === '') return ''
  const bytes = Buffer.from(clean, 'base64')
  const label = String(charset ?? 'utf-8').toLowerCase()
  try {
    return new TextDecoder(label).decode(bytes)
  } catch {
    return bytes.toString('utf8')
  }
}

/**
 * Split `header: value` lines from a part body.
 * @returns {{headers: Map<string,string>, body: string}}
 */
export function splitPart(part) {
  const text = String(part ?? '')
  const match = /\r?\n\r?\n/.exec(text)
  if (match === null) return { headers: new Map(), body: text }
  const headerText = text.slice(0, match.index)
  const body = text.slice(match.index + match[0].length)
  const headers = new Map()
  let name = null
  let value = ''
  const commit = () => {
    if (name === null) return
    headers.set(name, value.trim())
    name = null
    value = ''
  }
  for (const line of headerText.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && name !== null) { value += ` ${line.trim()}`; continue }
    const m = /^([!-9;-~]+):\s*(.*)$/.exec(line)
    if (m === null) { commit(); continue }
    commit()
    name = m[1].toLowerCase()
    value = m[2]
  }
  commit()
  return { headers, body }
}

/** Decode one part's body according to its own Content-Transfer-Encoding. */
export function decodePart({ headers, body }) {
  const encoding = (headers.get('content-transfer-encoding') ?? '').toLowerCase().trim()
  const charset = /charset\s*=\s*"?([\w-]+)"?/i.exec(headers.get('content-type') ?? '')?.[1]
  if (encoding === 'base64') return decodeBase64(body, charset)
  if (encoding === 'quoted-printable') return decodeQuotedPrintable(body, charset)
  return body
}

/**
 * Split a multipart body into its parts.
 * @param {string} body full multipart body
 * @param {string} boundary the boundary token (without the leading `--`)
 * @returns {string[]}
 */
export function splitMultipart(body, boundary) {
  const text = String(body ?? '')
  if (boundary === '') return []
  const marker = `--${boundary}`
  const segments = text.split(marker)
  // segments[0] is the preamble; the last one is the closing `--`.
  const parts = []
  for (let i = 1; i < segments.length; i += 1) {
    let segment = segments[i]
    if (/^--/.test(segment)) break // closing boundary
    segment = segment.replace(/^\r?\n/, '')
    parts.push(segment)
  }
  return parts
}

/** Read the boundary token out of a Content-Type value. */
export function boundaryOf(contentType) {
  const value = String(contentType ?? '')
  const match = /boundary\s*=\s*("([^"]*)"|[^;\s]+)/i.exec(value)
  if (match === null) return ''
  return (match[2] ?? match[1]).trim()
}

/**
 * Infer a MIME boundary from the body when the top-level Content-Type is absent.
 *
 * A multipart body opens with `--<boundary>` on its own line. The token itself
 * may start with `-` (QQ uses `--=_NextPart_…`, so the wire line is
 * `----=_NextPart_…`), which is why the character class here allows dashes and
 * only rejects an empty token.
 *
 * @param {string} raw body bytes as text
 * @returns {string} the boundary token, or '' when the body is not multipart
 */
export function inferBoundary(raw) {
  const text = String(raw ?? '')
  // Find the first line that is exactly `--<token>`; a preamble such as
  // "This is a multi-part message in MIME format." is skipped naturally.
  const match = /(?:^|\r?\n)--([^\r\n]+?)\r?\n/.exec(text)
  if (match === null) return ''
  const token = match[1].trim()
  // A closing delimiter is `--<token>--`; strip that suffix if it matched it.
  const candidate = token.endsWith('--') ? token.slice(0, -2) : token
  if (candidate === '') return ''
  // Only trust a token that actually delimits more than one part.
  const occurrences = text.split(`--${candidate}`).length - 1
  return occurrences >= 2 ? candidate : ''
}

/** Strip HTML to readable text without leaving tag soup or entities behind. */
export function htmlToText(html) {
  return String(html)
    // Drop non-content blocks wholesale: style/script/head metadata are the
    // reason a marketing mail's "text" used to be a wall of CSS.
    .replace(/<(script|style|head|title)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&amp;/gi, '&')
}

/** Collapse whitespace and trim to a preview length. */
function tidy(text, limit) {
  let value = String(text ?? '')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .replace(/^\s+|\s+$/g, '')
  // Some marketing mail leaks a bare CSS rule block into the text (a `<style>`
  // body outside its tag). Skip leading rules so the preview starts at prose
  // instead of `* { -webkit-font-smoothing: … }`.
  value = stripLeadingCss(value)
  return value.slice(0, limit)
}

/**
 * Drop leading CSS-looking noise from a text preview.
 *
 * Only a *leading* run of selector/declaration blocks is removed: a message that
 * genuinely starts with prose is untouched, and CSS later in the body is left
 * alone because cutting it out could remove real content.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripLeadingCss(text) {
  let value = String(text ?? '')
  // A CSS block: `selector { … }`, possibly repeated, possibly multi-line.
  const cssBlock = /^\s*(?:@media[^{]*\{[\s\S]*?\}\s*\}|[^{}\n]{0,120}\{[^{}]*\})\s*/
  let guard = 0
  while (guard < 20 && cssBlock.test(value)) {
    const next = value.replace(cssBlock, '')
    if (next === value) break
    value = next
    guard += 1
  }
  return value.replace(/^\s+/, '')
}

/**
 * Extract a readable preview from `BODY[TEXT]` bytes.
 *
 * Selection order for multipart messages: the first `text/plain` part, then the
 * first `text/html` part, then any part that decodes to something readable.
 * For single-part messages the body is decoded by its own transfer encoding.
 *
 * @param {Buffer|string} bytes
 * @param {number} [limit] preview length
 * @returns {string}
 */
export function extractBodyPreview(bytes, limit = 300) {
  const raw = Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes ?? '')
  if (raw === '') return ''

  // Is the whole body a multipart container? Look at the top-level headers only
  // (the first blank line ends them).
  const headEnd = raw.search(/\r?\n\r?\n/)
  const topHeaders = headEnd === -1 ? raw : raw.slice(0, headEnd)
  const contentType = /content-type:\s*([^\r\n]+)/i.exec(topHeaders)?.[1] ?? ''

  // A multipart body normally declares itself, but some servers return only the
  // part list (the `--boundary` lines) with no top-level Content-Type — QQ does
  // this. Detect that shape from the body itself instead of trusting the header.
  const declaredMultipart = /^multipart\//i.test(contentType.trim())
  const inferredBoundary = declaredMultipart ? '' : inferBoundary(raw)
  const boundary = declaredMultipart ? boundaryOf(contentType) : inferredBoundary

  if ((declaredMultipart && boundary !== '') || inferredBoundary !== '') {
    const parts = splitMultipart(raw, boundary).map(splitPart)
    // 嵌套 multipart（mixed 里套 alternative——Gmail/Outlook 带附件邮件的
    // 标准结构，本插件 text+html+附件的自产结构同款）：首层切分选中的
    // "部件"是容器本身，边界汤会污染唤醒 prompt。对 multipart/* 容器下钻
    // 一层再选正文（复审 P2 实证）。
    const flatten = (parts) => parts.flatMap((part) => {
      const type = (part.headers.get('content-type') ?? 'text/plain').toLowerCase()
      if (type.startsWith('multipart/')) {
        const innerBoundary = boundaryOf(part.headers.get('content-type') ?? '')
        return innerBoundary === '' ? [{ headers: part.headers, text: '' }] : flatten(splitMultipart(part.body, innerBoundary).map(splitPart))
      }
      return [{ headers: part.headers, text: decodePart(part) }]
    })
    const decoded = flatten(parts)
    const plain = decoded.find((part) => (part.headers.get('content-type') ?? 'text/plain').toLowerCase().startsWith('text/plain') && part.text.trim() !== '')
    const html = decoded.find((part) => (part.headers.get('content-type') ?? '').toLowerCase().startsWith('text/html') && part.text.trim() !== '')
    const chosen = plain ?? html ?? decoded.find((part) => part.text.trim() !== '')
    if (chosen === undefined) return ''
    const chosenType = (chosen.headers.get('content-type') ?? '').toLowerCase()
    const text = chosenType.startsWith('text/html') ? htmlToText(chosen.text) : chosen.text
    return tidy(text, limit)
  }

  // Single part: decode with the declared encoding, then strip HTML if needed.
  const { headers, body } = splitPart(raw)
  const decoded = decodePart({ headers, body })
  const type = (headers.get('content-type') ?? '').toLowerCase()
  const text = type.startsWith('text/html') ? htmlToText(decoded) : decoded
  return tidy(text, limit)
}

/**
 * Extract attachment metadata (and bytes) from a full raw MIME message.
 *
 * 与 extractBodyPreview 同一套解析器，但目标是**二进制安全**的附件：
 * base64/QP 按字节解进 Buffer，binary/8bit 原样取。只在调用方明确要附件时
 * 才走（全文 FETCH 体量大）；返回 `content` 为 Buffer，`size` 字节数。
 * 嵌套 multipart 只走一层（与 extractBodyPreview 一致，报告/附件客户端
 * 极少嵌套，遇到时附件取不到但正文预览不受影响）。
 *
 * @param {Buffer|string} raw full message body (BODY[TEXT] bytes)
 * @returns {Array<{filename: string, contentType: string, size: number, content: Buffer}>}
 */
export function extractAttachments(raw) {
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw ?? ''), 'utf8')
  const bodyText = bytes.toString('utf8')
  const headEnd = bodyText.search(/\r?\n\r?\n/)
  const topHeaders = headEnd === -1 ? bodyText : bodyText.slice(0, headEnd)
  const contentType = /content-type:\s*([^\r\n]+)/i.exec(topHeaders)?.[1] ?? ''
  // IMAP 的 BODY[TEXT] 从顶层正文的第一个字节开始，**不含顶层 MIME 头**——
  // multipart 声明看不到，和 extractBodyPreview 一样按正文形态推断边界。
  const declaredMultipart = /^multipart\/mixed/i.test(contentType.trim())
  const boundary = declaredMultipart ? boundaryOf(contentType) : inferBoundary(bodyText)
  if (boundary === '') return []
  const out = []
  for (const part of splitMultipart(bodyText, boundary).map(splitPart)) {
    const disposition = (part.headers.get('content-disposition') ?? '').toLowerCase()
    const type = (part.headers.get('content-type') ?? '').toLowerCase()
    // 附件判定：Content-Disposition: attachment 优先；其次有 name= 参数的
    // 非 text/ 常规正文部分。inline 的附件（有些客户端这么发）也算。
    const hasName = /name\s*=\s*("[^"]*"|[^\s;]+)/i.test(part.headers.get('content-type') ?? '')
    const isAttachment = disposition.startsWith('attachment') || (hasName && !type.startsWith('text/'))
    if (!isAttachment) continue
    // 文件名提取：无引号分支的捕获在**组 2**（组 1 是 quoted 形式专属），只取
    // 组 1 会让 `filename=report.csv` 全落 attachment.bin；RFC 2231 的
    // filename*=charset'lang'%E9%99%84 需 percent-decode（复审 P2 实证）。
    const extractName = (header, param) => {
      const quoted = new RegExp(`${param}\\*?\\s*=\\s*"([^"]*)"`, 'i').exec(header)
      if (quoted !== null) return quoted[1]
      const ext = new RegExp(`${param}\\*\\s*=\\s*([^;\\s]+)`, 'i').exec(header)
      if (ext !== null) return decodeRfc2231(ext[1])
      const bare = new RegExp(`${param}\\s*=\\s*([^;\\s]+)`, 'i').exec(header)
      if (bare !== null) return bare[1]
      return undefined
    }
    const rawName = extractName(part.headers.get('content-disposition') ?? '', 'filename')
      ?? extractName(part.headers.get('content-type') ?? '', 'name')
    const filename = rawName === undefined ? 'attachment.bin' : decodeMimeWordIfNeeded(rawName.trim().replace(/^"|"$/g, ''))
    const encoding = (part.headers.get('content-transfer-encoding') ?? '').toLowerCase().trim()
    const body = part.body.replace(/\r?\n/g, '')
    let content
    if (encoding === 'base64') content = Buffer.from(body, 'base64')
    else if (encoding === 'quoted-printable') content = Buffer.from(
      body.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))),
      'latin1',
    )
    else content = Buffer.from(part.body, 'utf8')
    out.push({
      filename,
      contentType: (part.headers.get('content-type') ?? '').split(';')[0].trim() || 'application/octet-stream',
      size: content.length,
      content,
    })
  }
  return out
}

/**
 * RFC 2231 扩展参数值：`UTF-8''%E5%AD%A3...`（charset'lang'percent-encoded）。
 * 仅处理 percent 部分；charset 非 utf-8 时 best-effort utf-8 解。
 */
function decodeRfc2231(value) {
  const m = /^([\w-]*)'[^']*'(.*)$/.exec(value)
  if (m === null) return value
  const [, charset, encoded] = m
  try {
    const bytes = Buffer.from(encoded.replace(/%([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))), 'latin1')
    try { return new TextDecoder(charset === '' ? 'utf-8' : charset.toLowerCase()).decode(bytes) } catch { return bytes.toString('utf8') }
  } catch {
    return encoded
  }
}

/** RFC 2047 encoded-word in an attachment filename, decoded best-effort. */
function decodeMimeWordIfNeeded(name) {
  if (!/=\?/.test(name)) return name
  try {
    // 避免循环依赖：imap.mjs 的 decodeMimeWord 与本模块互不导入，这里
    // 复制最小实现（仅 B/Q base64/qp 的 UTF-8 情况，附件名足够）。
    return name.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_, charset, enc, data) => {
      try {
        const bytes = enc.toLowerCase() === 'b'
          ? Buffer.from(data, 'base64')
          : Buffer.from(data.replace(/_/g, ' ').replace(/=([0-9a-fA-F]{2})/g, (_, hx) => String.fromCharCode(parseInt(hx, 16))), 'latin1')
        try { return new TextDecoder(String(charset).toLowerCase()).decode(bytes) } catch { return bytes.toString('utf8') }
      } catch { return data }
    })
  } catch { return name }
}
