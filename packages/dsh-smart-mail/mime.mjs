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

/** Decode quoted-printable (`=3D`, `=20`, soft line breaks). */
export function decodeQuotedPrintable(text) {
  return String(text)
    // Soft breaks: `=\r\n` / `=\n` join the lines.
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
}

/** Decode base64, ignoring whitespace and stray non-alphabet characters. */
export function decodeBase64(text) {
  const clean = String(text).replace(/[^A-Za-z0-9+/=]/g, '')
  if (clean === '') return ''
  try {
    return Buffer.from(clean, 'base64').toString('utf8')
  } catch {
    return ''
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
  if (encoding === 'base64') return decodeBase64(body)
  if (encoding === 'quoted-printable') return decodeQuotedPrintable(body)
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
    const decoded = parts.map((part) => ({
      type: (part.headers.get('content-type') ?? 'text/plain').toLowerCase(),
      text: decodePart(part),
    }))
    const plain = decoded.find((part) => part.type.startsWith('text/plain') && part.text.trim() !== '')
    const html = decoded.find((part) => part.type.startsWith('text/html') && part.text.trim() !== '')
    const chosen = plain ?? html ?? decoded.find((part) => part.text.trim() !== '')
    if (chosen === undefined) return ''
    const text = chosen.type.startsWith('text/html') ? htmlToText(chosen.text) : chosen.text
    return tidy(text, limit)
  }

  // Single part: decode with the declared encoding, then strip HTML if needed.
  const { headers, body } = splitPart(raw)
  const decoded = decodePart({ headers, body })
  const type = (headers.get('content-type') ?? '').toLowerCase()
  const text = type.startsWith('text/html') ? htmlToText(decoded) : decoded
  return tidy(text, limit)
}
