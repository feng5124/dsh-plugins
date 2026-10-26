/**
 * dsh-smart-mail — minimal IMAP4rev1 client over node:tls.
 *
 * Implements exactly what the poller and read_emails need: LOGIN, SELECT
 * INBOX, UID SEARCH SINCE, UID FETCH (headers + BODY.PEEK preview), LOGOUT.
 * IMAP literals ({n} byte blocks — how servers transmit UTF-8 subjects and
 * bodies) are assembled at the byte level before line parsing.
 */

import { extractBodyPreview } from './mime.mjs'

/** UTF-8 literal argument for command writing. */
function lit(value) {
  return { __literal: Buffer.from(String(value), 'utf8') }
}

/** Quoted ASCII argument (no server continuation round-trip needed). */
function quoted(value) {
  const s = String(value)
  if (!/^[\x20-\x7e]*$/.test(s)) return lit(s) // non-ASCII falls back to literal
  return { __quoted: `"${s.replace(/([\\"])/g, '\\$1')}"` }
}

/** One logical response line: header text with \u0000LITn\u0000 markers + literal buffers. */
export class Line {  constructor(text, literals) {
    this.text = text
    this.literals = literals
  }
}

/**
 * Byte-level response reader: assembles literals and yields Lines until a
 * tagged status line arrives. State machine over (pos, pendingLine).
 */
function createReader(socket) {
  const state = { buf: Buffer.alloc(0), pos: 0, pending: null }
  const waiters = []

  const advance = () => {
    while (waiters.length > 0) {
      const waiter = waiters[0]
      let outcome
      try {
        outcome = step(state, waiter.stop)
      } catch (error) {
        waiters.shift()
        clearTimeout(waiter.timer)
        waiter.reject(error)
        continue
      }
      if (outcome === null) return
      waiters.shift()
      clearTimeout(waiter.timer)
      // Drop the bytes this command consumed. Compaction happens only here,
      // between commands: `pending.end` is an absolute index into `buf`, so
      // re-basing the buffer mid-command (while a literal is still arriving)
      // would shift every index and corrupt the next literal's start — that is
      // exactly how messages with large bodies used to be lost.
      state.buf = state.buf.subarray(state.pos)
      state.pos = 0
      state.pending = null
      waiter.resolve(outcome)
    }
  }

  socket.on('data', (chunk) => {
    // Append only. Truncating here would invalidate the absolute offsets held
    // in `state.pending` while a literal spans several TCP chunks.
    state.buf = Buffer.concat([state.buf, chunk])
    advance()
  })
  socket.once('error', (err) => {
    for (const w of waiters.splice(0)) {
      clearTimeout(w.timer)
      w.reject(err)
    }
  })
  socket.once('close', () => {
    for (const w of waiters.splice(0)) {
      clearTimeout(w.timer)
      w.reject(new Error('IMAP socket closed'))
    }
  })

  /**
   * One assembly step: returns {lines, consumed} once a stop-tagged line
   * completed, or null when more bytes are needed.
   *
   * The state machine is deliberately small and index-based:
   *   - `pending.text` is the logical line assembled so far;
   *   - `pending.literals` are its literal byte blocks, in wire order;
   *   - `pending.end` is the absolute index in `buf` just past the last byte
   *     consumed for that line (the CRLF that ended the current segment);
   *   - `pos` is where the *next* segment starts.
   *
   * A segment ends at CRLF. If the segment ends with `{n}`, the next `n` bytes
   * are a literal (taken from `end + 2`, skipping that CRLF) and the segment
   * after it continues the same logical line. Nothing here ever re-bases `buf`,
   * so an absolute index stays valid across any number of TCP chunks.
   */
  function step(st, stop) {
    const lines = st.emitted ?? []
    st.emitted = lines
    while (true) {
      const pending = st.pending ?? { text: '', literals: [], end: st.pos - 2 }
      st.pending = null
      // Resume: the previous call stopped because a literal was incomplete.
      if (pending.wantLiteral !== undefined) {
        const want = pending.wantLiteral
        const litStart = pending.end + 2
        if (litStart + want > st.buf.length) {
          st.pending = pending
          return null
        }
        pending.literals.push(st.buf.subarray(litStart, litStart + want))
        pending.text += `\u0000LIT${pending.literals.length - 1}\u0000`
        let cursor = litStart + want
        if (st.buf.subarray(cursor, cursor + 2).toString('latin1') === '\r\n') cursor += 2
        pending.end = cursor - 2
        st.pos = cursor
        delete pending.wantLiteral
        // Fall through to read the continuation segment.
      }

      // Read one segment (up to CRLF).
      const idx = st.buf.indexOf('\r\n', st.pos)
      if (idx < 0) {
        // Segment incomplete: remember what we have so the next chunk appends.
        st.pending = pending
        return null
      }
      pending.text += st.buf.subarray(st.pos, idx).toString('utf8')
      pending.end = idx
      st.pos = idx + 2

      const marker = /\{(\d+)\}$/.exec(pending.text)
      if (marker !== null) {
        // The segment promised a literal: its bytes follow the CRLF.
        pending.wantLiteral = Number(marker[1])
        // Drop the `{n}` text itself; the marker position is kept as LITn.
        pending.text = pending.text.slice(0, marker.index)
        st.pending = pending
        // Loop again: the resume branch at the top consumes the literal.
        continue
      }

      lines.push(new Line(pending.text, pending.literals))
      const last = lines[lines.length - 1]
      if (last.text.startsWith(stop)) {
        const out = { lines, consumed: st.pos }
        st.emitted = undefined
        return out
      }
      if (st.pos >= st.buf.length) return null
      // Next segment belongs to the next logical line.
      st.pending = { text: '', literals: [], end: st.pos - 2 }
    }
  }

  return {
    readUntil: (stop) =>
      new Promise((resolve, reject) => {
        const waiter = {
          stop,
          resolve,
          reject,
          timer: setTimeout(() => {
            const i = waiters.indexOf(waiter)
            if (i >= 0) waiters.splice(i, 1)
            reject(new Error(`IMAP read timeout awaiting ${stop}`))
          }, 60_000),
        }
        waiters.push(waiter)
        advance()
      }),
  }
}

export class ImapSession {
  constructor(socket) {
    this.socket = socket
    this.reader = createReader(socket)
    this.tag = 0
  }

  /** Execute one command; literals sent with {n} continuation flow. */
  async exec(parts) {
    const tag = `A${String(++this.tag).padStart(4, '0')}`
    const pieces = [tag, ...parts]
    // Compute the wire line first; then decide the literal strategy. IMAP
    // literals in COMMANDS are permitted with LITERAL+ ({n+}: server never
    // sends a continuation), while the classic {n} form requires a `+ go
    // ahead` per literal. Many servers advertise LITERAL+; QQ/163 do. To
    // stay compatible with both, we send classic {n} and wait for the `+`
    // response. However some servers reject LOGIN literals entirely and
    // expect quoted strings — ASCII credentials are sent quoted instead.
    let line = ''
    const literalQueue = []
    const asciiSafe = (s) => /^[\x20-\x7e]*$/.test(s) && !/["\\]/.test(s)
    const rendered = []
    for (const part of pieces) {
      if (part && typeof part === 'object' && part.__literal) {
        rendered.push({ literal: part.__literal })
        literalQueue.push(part.__literal)
      } else if (part && typeof part === 'object' && part.__quoted) {
        rendered.push({ text: part.__quoted })
      } else {
        rendered.push({ text: String(part) })
      }
    }
    // Build final wire text: quoted strings inline, literals as {n}.
    line = ''
    for (let i = 0; i < rendered.length; i++) {
      const piece = rendered[i]
      if (i > 0) line += ' '
      line += piece.text ?? `{${piece.literal.length}}`
    }
    this.socket.write(line)
    for (const bytes of literalQueue) {
      const ok = await this.expectContinue()
      if (!ok) throw new Error('IMAP server refused literal continuation')
      this.socket.write(bytes)
    }
    this.socket.write('\r\n')
    const result = await this.reader.readUntil(`${tag} `)
    const lines = result.lines
    const status = lines[lines.length - 1].text
    if (!new RegExp(`^${tag} OK`, 'i').test(status)) {
      throw new Error(`IMAP command failed: ${status.slice(tag.length + 1).trim()}`)
    }
    return lines.slice(0, -1)
  }

  expectContinue() {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.socket.off('data', onData)
        resolve(false)
      }, 15_000)
      const onData = (chunk) => {
        clearTimeout(timer)
        this.socket.off('data', onData)
        resolve(chunk.toString('utf8').trim().startsWith('+'))
      }
      this.socket.once('data', onData)
    })
  }

  close() {
    try {
      this.socket.write('A999 LOGOUT\r\n')
    } catch {}
    setTimeout(() => this.socket.destroy(), 200)
  }
}

/**
 * Open a socket to the IMAP server.
 *
 * `tls: false` connects in the clear, which is only meaningful for a local
 * test server; every shipped preset sets `tls: true`. The default stays
 * `true` so an account written before the flag existed keeps its old,
 * encrypted behaviour.
 */
export async function connect({ host, port, tls: secure = true }) {
  if (secure === false) {
    const net = await import('node:net')
    return await new Promise((resolve, reject) => {
      const socket = net.connect({ host, port }, () => resolve(socket))
      socket.setTimeout(30_000, () => {
        socket.destroy()
        reject(new Error(`IMAP connect timeout: ${host}:${port}`))
      })
      socket.once('error', reject)
    })
  }
  const tls = await import('node:tls')
  return await new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, servername: host, rejectUnauthorized: true }, () => resolve(socket))
    socket.setTimeout(30_000, () => {
      socket.destroy()
      reject(new Error(`IMAP connect timeout: ${host}:${port}`))
    })
    socket.once('error', reject)
  })
}

/** Decode MIME encoded-words (=??B?/=??Q?) in a header value. */
export function decodeMimeWord(input) {
  if (input == null) return null
  return String(input).replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_, charset, enc, data) => {
    try {
      if (enc.toLowerCase() === 'b') return Buffer.from(data, 'base64').toString('utf8')
      const qp = data.replace(/_/g, ' ').replace(/=([0-9a-fA-F]{2})/g, (_, hx) => String.fromCharCode(parseInt(hx, 16)))
      return Buffer.from(qp, /gb/i.test(charset) ? 'latin1' : 'utf8').toString('utf8')
    } catch {
      return data
    }
  })
}

/** Extract an email address from a From header / address string. */
export function extractAddress(raw) {
  if (!raw) return null
  const m = /<([^>]+)>/.exec(raw) ?? /([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/.exec(raw)
  return m ? m[1].trim().toLowerCase() : null
}

/** Parse a FETCH response Line into {uid, fromAddress, fromName, subject, preview} or null. */
export function parseFetchLine(line) {
  if (!(line instanceof Line) || !/^\*\s+\d+\s+FETCH/i.test(line.text)) return null
  const out = { uid: null, from: null, fromAddress: null, fromName: null, subject: null, date: null, preview: null }
  const text = line.text
  const uidM = /UID\s+(\d+)/i.exec(text)
  if (uidM) out.uid = Number(uidM[1])
  const envStart = text.indexOf('ENVELOPE')
  if (envStart >= 0) {
    const env = text.slice(envStart)
    // From address list: the FIRST ("name-or-nil" ADL "local" "domain") run.
    const fromM = /\(\s*("(?:[^"\\]|\\.)*"|NIL)\s+("[^"]*"|NIL)\s+"([^"]*)"\s+"([^"]*)"/.exec(env)
    if (fromM) {
      const name = fromM[1] !== 'NIL' ? fromM[1].slice(1, -1).replace(/\\(.)/g, '$1') : null
      out.fromAddress = `${fromM[3]}@${fromM[4]}`.toLowerCase()
      out.fromName = decodeMimeWord(name)
    }
    // ENVELOPE = (date subject from sender reply-to to cc bcc in-reply-to message-id).
    // The subject is the SECOND field. The old fallback took the LAST quoted
    // string, which is the message-id — that is why NetEase service mails
    // showed "<...JavaMail...>" as the subject. Parse the head explicitly.
    const envHead = /ENVELOPE\s+\(\s*("(?:[^"\\]|\\.)*"|NIL)\s+("(?:[^"\\]|\\.)*"|NIL|\u0000LIT(\d+)\u0000)/i.exec(env)
    if (envHead) {
      if (envHead[3] !== undefined) {
        const bytes = line.literals[Number(envHead[3])]
        if (bytes) out.subject = decodeMimeWord(bytes.toString('utf8'))
      } else if (envHead[2] !== 'NIL') {
        out.subject = decodeMimeWord(envHead[2].slice(1, -1).replace(/\\(.)/g, '$1'))
      }
    }
  }
  // Preview: the LIT marker that sits after BODY[TEXT].
  const bodyM = /BODY\[TEXT\][^ ]*\s*\u0000LIT(\d+)\u0000/.exec(text)
  if (bodyM) {
    const bytes = line.literals[Number(bodyM[1])]
    if (bytes) out.preview = decodeBodyPreview(bytes)
  }
  return out
}

/**
 * Best-effort decode of BODY[TEXT] bytes into a short preview.
 *
 * Delegates to the MIME walker: a `multipart/alternative` body must be split on
 * its boundary and each part decoded by its own transfer encoding. The previous
 * version base64-decoded the whole body whenever that header appeared anywhere,
 * which turned every multipart mail (QQ, most clients) into an empty preview.
 */
function decodeBodyPreview(bytes) {
  return extractBodyPreview(bytes, 300)
}

/** Open a session and LOGIN. */
export async function openMailbox(account) {
  const socket = await connect(account.imap)
  const session = new ImapSession(socket)
  await session.reader.readUntil('* OK').catch(() => null)
  // Coremail servers (163/126/企业邮箱) refuse post-LOGIN commands with
  // "Unsafe Login" unless the client announces itself first (RFC 2971 ID).
  const isCoremail = /163|126|coremail|netease/i.test(`${account.imap.host} ${account.preset ?? ''}`)
  if (isCoremail) {
    await session.exec(['ID', 'NIL']).catch(() => null) // best-effort; not fatal if unsupported
  }
  await session.exec(['LOGIN', quoted(account.address), quoted(account.authCode)])
  return session
}

/** SELECT INBOX; returns {exists, uidvalidity, uidnext}. */
export async function selectInbox(session) {
  const lines = await session.exec(['SELECT', 'INBOX'])
  const info = { exists: 0, uidvalidity: null, uidnext: null }
  for (const line of lines) {
    let m = /(\d+)\s+EXISTS/i.exec(line.text)
    if (m) info.exists = Number(m[1])
    m = /UIDVALIDITY\s+(\d+)/i.exec(line.text)
    if (m) info.uidvalidity = Number(m[1])
    m = /UIDNEXT\s+(\d+)/i.exec(line.text)
    if (m) info.uidnext = Number(m[1])
  }
  return info
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** UID SEARCH for messages since `daysBack`; newest first, capped. */
export async function searchSince(session, daysBack, cap = 30) {
  const since = new Date(Date.now() - daysBack * 86_400_000)
  const date = `${String(since.getDate()).padStart(2, '0')}-${MONTHS[since.getMonth()]}-${since.getFullYear()}`
  const lines = await session.exec(['UID', 'SEARCH', 'SINCE', date])
  for (const line of lines) {
    const m = /^\*\s+SEARCH\s*(.*)$/i.exec(line.text)
    if (m) {
      const uids = m[1].trim().split(/\s+/).filter(Boolean).map(Number).filter((n) => Number.isFinite(n))
      return uids.slice(-cap).reverse()
    }
  }
  return []
}

/** UID FETCH ENVELOPE + small BODY.PEEK preview for the given UIDs. */
export async function fetchSummaries(session, uids) {
  if (uids.length === 0) return []
  const set = uids.join(',')
  const lines = await session.exec(['UID', 'FETCH', set, '(UID ENVELOPE BODY.PEEK[TEXT]<0.2048>)'])
  const out = []
  for (const line of lines) {
    const parsed = parseFetchLine(line)
    if (parsed && parsed.uid != null) out.push(parsed)
  }
  return out
}

/**
 * Decode every RFC 2047 encoded-word in a parsed header map.
 * @param {Map<string,string>} headers
 * @returns {Map<string,string>}
 */
export function decodeHeaderMap(headers) {
  const out = new Map()
  for (const [name, value] of headers) out.set(name, decodeMimeWord(value) ?? value)
  return out
}

/**
 * Parse one `UID FETCH (... BODY[HEADER.FIELDS (...)] ... BODY[TEXT]<0.n>)` line
 * into the header map plus a body preview.
 *
 * The reader keeps literals out of band and leaves `\0LIT<n>\0` markers in the
 * text, so the section a literal belongs to is decided by the text before it.
 *
 * @param {Line} line
 * @returns {{uid: number, headers: Map<string,string>, headerText: string, preview: string}|null}
 */
export function parseThreadedFetchLine(line) {
  if (!(line instanceof Line) || !/^\*\s+\d+\s+FETCH/i.test(line.text)) return null
  const text = line.text
  const uidMatch = /UID\s+(\d+)/i.exec(text)
  if (uidMatch === null) return null
  let headerText = ''
  let preview = ''
  const marker = /\u0000LIT(\d+)\u0000/g
  let match
  while ((match = marker.exec(text)) !== null) {
    const before = text.slice(0, match.index)
    const bytes = line.literals[Number(match[1])]
    if (bytes === undefined) continue
    if (/BODY\[HEADER\.FIELDS[^\]]*\]\s*$/i.test(before)) headerText = bytes.toString('utf8')
    else if (/BODY\[TEXT\][^ ]*\s*$/i.test(before)) preview = decodeBodyPreview(bytes)
  }
  return { uid: Number(uidMatch[1]), headers: parseHeaderText(headerText), headerText, preview }
}

/**
 * Parse a raw header block into a lower-cased map, joining folded lines.
 * @param {string} headerText
 * @returns {Map<string,string>}
 */
export function parseHeaderText(headerText) {
  const headers = new Map()
  let name = null
  let value = ''
  const commit = () => {
    if (name === null) return
    const trimmed = value.trim()
    if (headers.has(name)) headers.set(name, `${headers.get(name)} ${trimmed}`.trim())
    else headers.set(name, trimmed)
    name = null
    value = ''
  }
  for (const raw of String(headerText ?? '').split(/\r?\n/)) {
    if (/^[ \t]/.test(raw) && name !== null) {
      value += ` ${raw.trim()}`
      continue
    }
    const m = /^([!-9;-~]+):\s*(.*)$/.exec(raw)
    if (m === null) {
      commit()
      continue
    }
    commit()
    name = m[1].toLowerCase()
    value = m[2]
  }
  commit()
  return headers
}

/**
 * Fetch the threading headers and a body preview for the given UIDs.
 *
 * Headers are fetched with BODY.PEEK so polling never marks mail as read, and
 * the field list is explicit because ENVELOPE alone does not carry
 * `References` / `In-Reply-To` / `X-DSH-Session` — exactly what thread
 * resolution needs.
 *
 * @param {ImapSession} session
 * @param {number[]} uids
 * @param {string[]} fields header names to request
 * @returns {Promise<Array<{uid:number, headers:Map<string,string>, preview:string}>>}
 */
export async function fetchThreaded(session, uids, fields) {
  if (uids.length === 0) return []
  const list = fields.join(' ')
  const lines = await session.exec([
    'UID',
    'FETCH',
    uids.join(','),
    `(UID BODY.PEEK[HEADER.FIELDS (${list})] BODY.PEEK[TEXT]<0.4096>)`,
  ])
  const out = []
  for (const line of lines) {
    const parsed = parseThreadedFetchLine(line)
    if (parsed !== null) out.push(parsed)
  }
  return out
}
