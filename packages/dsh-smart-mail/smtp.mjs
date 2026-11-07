/**
 * dsh-smart-mail — SMTP client over node:tls sockets.
 *
 * Plain-protocol implementation chosen deliberately: the DSH Host process
 * ships no mail library (nodemailer/imapflow are absent from app.asar), and
 * the requirement is "no extra software". AUTH LOGIN with an authorization
 * code covers QQ/163/Gmail/Outlook SMTP endpoints; message bodies are MIME
 * 1.0 with UTF-8 base64 encoding and standard header folding.
 */

const CRLF = '\r\n'

/** Connect and upgrade to TLS, or connect over TLS directly. */
async function connect({ host, port, tls }) {
  const net = await import('node:net')
  const tlsMod = await import('node:tls')
  return await new Promise((resolve, reject) => {
    const socket = tls
      ? tlsMod.connect({ host, port, servername: host, rejectUnauthorized: true }, () => resolve({ socket, log: [] }))
      : net.connect({ host, port }, () => resolve({ socket, log: [] }))
    socket.setTimeout(30_000, () => {
      socket.destroy()
      reject(new Error(`SMTP connect timeout: ${host}:${port}`))
    })
    socket.once('error', reject)
  })
}

/** Read one SMTP reply (possibly multiline 250-xxx), returns {code, text}.
 * 服务器 accept 后不发应答（或半开连接）时必须能退出：60s 无应答 / socket
 * close 都要 reject，否则 send_email 永久挂起（P2，2026-11-07）。 */
const REPLY_TIMEOUT_MS = 60_000

function readReply(socket) {
  return new Promise((resolve, reject) => {
    let buf = ''
    let timer = null
    const cleanup = () => {
      if (timer !== null) clearTimeout(timer)
      socket.off('data', onData)
      socket.off('error', onErr)
      socket.off('close', onClose)
    }
    const fail = (error) => {
      if (timer === null) return // already settled
      clearTimeout(timer)
      timer = null
      socket.off('data', onData)
      socket.off('error', onErr)
      socket.off('close', onClose)
      reject(error)
    }
    timer = setTimeout(() => fail(new Error(`SMTP reply timeout after ${REPLY_TIMEOUT_MS / 1000}s`)), REPLY_TIMEOUT_MS)
    const onData = (chunk) => {
      buf += chunk.toString('utf8')
      const lines = buf.split(CRLF)
      while (lines.length > 1) {
        const line = lines.shift()
        const m = /^(\d{3})([ -])?(.*)$/.exec(line)
        if (m && m[2] === '-') continue // continuation line
        if (m) {
          if (timer !== null) clearTimeout(timer)
          timer = null
          cleanup()
          resolve({ code: Number(m[1]), text: buf })
          return
        }
      }
    }
    const onErr = (err) => fail(err)
    const onClose = () => fail(new Error('SMTP connection closed before a reply arrived'))
    socket.on('data', onData)
    socket.once('error', onErr)
    socket.once('close', onClose)
  })
}

/** Send one command and await its reply. */
async function command(socket, line) {
  const replyPromise = readReply(socket)
  socket.write(line + CRLF)
  const reply = await replyPromise
  return reply
}

/** Encode one header value per RFC 2047 if it is not pure ASCII. */
function headerValue(value) {
  if (/^[\x20-\x7e]*$/.test(value)) return value.replace(/[\r\n]/g, ' ')
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`
}

/**
 * 头部注入防护（P1，2026-11-07）：`In-Reply-To`/`X-DSH-Session` 不走
 * headerValue 的 ASCII 检查，而唤醒场景下这些值可能被不可信邮件内容驱动
 * （模型转发邮件里的 Message-ID / threadTag）。值里只允许 angle-addr / token
 * 字符，含 CR/LF/空白的注入载荷直接剥掉。
 */
function headerToken(value) {
  return String(value ?? '').replace(/[^\x21-\x7e]/g, '')
}

function foldHeader(name, value) {
  return `${name}: ${headerValue(value)}`
}

/**
 * Content-Disposition 的 filename 参数串（含 `filename=` 前缀）：
 * ASCII 名直接放 quoted-string；非 ASCII 名（中文附件名）用 RFC 2047 编码词
 * + RFC 2231 `filename*`（percent-encoded）双写，客户端二选一。
 */
function contentDispositionName(name) {
  const clean = String(name ?? 'file').replace(/["\\\r\n]/g, '_').trim() || 'file'
  if (/^[\x20-\x7e]+$/.test(clean)) return `filename="${clean}"`
  const encoded = `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=`
  return `filename=${encoded}; filename*=UTF-8''${encodeURIComponent(clean)}`
}

/** Guess a MIME type from a filename extension (small map, good-enough). */
export function mimeTypeOf(name) {
  const ext = (/\.([A-Za-z0-9]+)$/.exec(String(name ?? ''))?.[1] ?? '').toLowerCase()
  const map = {
    txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', log: 'text/plain',
    html: 'text/html', htm: 'text/html',
    json: 'application/json', xml: 'application/xml', yaml: 'application/yaml', yml: 'application/yaml',
    pdf: 'application/pdf', zip: 'application/zip', gz: 'application/gzip', tar: 'application/x-tar',
    '7z': 'application/x-7z-compressed', rar: 'application/vnd.rar',
    doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
    mp3: 'audio/mpeg', wav: 'audio/wav', mp4: 'video/mp4', mov: 'video/quicktime',
    js: 'text/javascript', mjs: 'text/javascript', py: 'text/x-python', ps1: 'text/plain', bat: 'text/plain', cmd: 'text/plain',
  }
  return map[ext] ?? 'application/octet-stream'
}

/** Build one MIME attachment part (base64, 76-col wrapped). */
function attachmentPart({ filename, contentBase64, contentType }) {
  const safe = String(filename ?? 'file').replace(/["\\\r\n]/g, '_')
  // RFC 5322 头必须 ASCII：name= 不带裸非 ASCII——中文名用 RFC 2047 编码词
  // （与 Content-Disposition 的双写同规）。复审 P2 实证裸 name= 可被严格
  // 网关拒收。
  const asciiName = /^[\x20-\x7e]+$/.test(safe)
    ? `; name="${safe}"`
    : `; name="=?UTF-8?B?${Buffer.from(safe, 'utf8').toString('base64')}?="`
  return [
    `--dsh-smart-mail-mixed`,
    `Content-Type: ${contentType || mimeTypeOf(filename)}${asciiName}`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment; ${contentDispositionName(filename)}`,
    '',
    contentBase64,
    '',
  ].join(CRLF)
}

/** Build a complete MIME message. */
export function buildMessage({ from, fromName, to, cc, subject, text, html, attachments, messageId, inReplyTo, references, tag, receipt }) {
  const date = new Date().toUTCString()
  const id = messageId ?? `<${Date.now()}.${Math.random().toString(36).slice(2)}@dsh-smart-mail>`
  const headers = [
    foldHeader('From', fromName ? `${headerValue(fromName)} <${from}>` : from),
    foldHeader('To', to),
    cc ? foldHeader('Cc', cc) : null,
    foldHeader('Subject', subject ?? ''),
    `Date: ${date}`,
    `Message-ID: ${id}`,
    inReplyTo ? `In-Reply-To: ${headerToken(inReplyTo)}` : null,
    Array.isArray(references) && references.length > 0 ? `References: ${references.map(headerToken).join(' ')}` : null,
    // Thread tag + receipt let a reply be attributed even when the client
    // drops References; both are ours, and clients simply carry them along.
    tag ? `X-DSH-Session: ${headerToken(tag)}` : null,
    receipt ? `X-DSH-Receipt: ${headerToken(receipt)}` : null,
    'Auto-Submitted: no',
    'MIME-Version: 1.0',
    // 有附件时必须是 multipart/mixed 包 body+附件（multipart/alternative 装不下附件）。
    Array.isArray(attachments) && attachments.length > 0
      ? 'Content-Type: multipart/mixed; boundary="dsh-smart-mail-mixed"'
      : html
        ? 'Content-Type: multipart/alternative; boundary="dsh-smart-mail-alt"'
        : 'Content-Type: text/plain; charset=UTF-8',
    !(html || (Array.isArray(attachments) && attachments.length > 0)) ? 'Content-Transfer-Encoding: base64' : null,
  ].filter(Boolean)

  const encode = (s) => Buffer.from(s ?? '', 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n')
  let body
  if (Array.isArray(attachments) && attachments.length > 0) {
    const textPart = html
      ? [
        '--dsh-smart-mail-mixed',
        'Content-Type: multipart/alternative; boundary="dsh-smart-mail-alt"',
        '',
        '--dsh-smart-mail-alt',
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: base64',
        '',
        encode(text ?? ''),
        '--dsh-smart-mail-alt',
        'Content-Type: text/html; charset=UTF-8',
        'Content-Transfer-Encoding: base64',
        '',
        encode(html),
        '--dsh-smart-mail-alt--',
        '',
      ].join(CRLF)
      : [
        '--dsh-smart-mail-mixed',
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: base64',
        '',
        encode(text ?? ''),
        '',
      ].join(CRLF)
    body = textPart
      + attachments.map((a) => attachmentPart({
        filename: a.filename,
        contentBase64: Buffer.isBuffer(a.content) ? a.content.toString('base64').replace(/(.{76})/g, '$1\r\n') : encode(String(a.content ?? '')),
        contentType: a.contentType,
      })).join(CRLF)
      + `--dsh-smart-mail-mixed--` + CRLF
  } else if (html) {
    body = [
      '--dsh-smart-mail-alt',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      encode(text ?? ''),
      '--dsh-smart-mail-alt',
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      encode(html),
      '--dsh-smart-mail-alt--',
      '',
    ].join(CRLF)
  } else {
    body = Buffer.from(text ?? '', 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n') + CRLF
  }
  return headers.join(CRLF) + CRLF + CRLF + body + CRLF
}

/**
 * Send one email over SMTP with AUTH LOGIN.
 * @param account resolved account {address, authCode, smtp:{host,port,tls}}
 * @param message {to, cc?, subject, text, html?, messageId?, inReplyTo?, references?, tag?, receipt?}
 * @returns {Promise<{ok: true, messageId: string}>}
 */
export async function sendMail(account, message) {
  const smtp = account.smtp
  const { socket } = await connect({ host: smtp.host, port: smtp.port, tls: smtp.tls !== false })
  // 不再 setTimeout(0)：connect 阶段的 30s 超时保留为 socket 级兜底，
  // readReply 自身另有 60s 应答超时（服务器不应答时 send_email 必须能退出）。
  socket.setTimeout(300_000, () => socket.destroy(new Error('SMTP socket idle timeout')))
  const transcript = []
  const say = async (line) => {
    const reply = await command(socket, line)
    transcript.push(`> ${line.replace(/AUTH LOGIN.*/, 'AUTH LOGIN [redacted]').replace(/^[A-Za-z0-9+/=]+$/, '[b64 secret]')}`)
    transcript.push(`< ${reply.text.trim()}`)
    return reply
  }
  try {
    await readReply(socket) // greeting
    let reply = await say(`EHLO dsh-smart-mail`)
    if (reply.code !== 250) throw new Error(`EHLO failed: ${reply.text.trim()}`)
    if (smtp.tls === false && smtp.starttls !== false) {
      reply = await say('STARTTLS')
      if (reply.code !== 220) throw new Error(`STARTTLS refused: ${reply.text.trim()}`)
      throw new Error('plain-socket STARTTLS upgrade not supported; use port 465 (implicit TLS)')
    }
    reply = await say('AUTH LOGIN')
    if (reply.code !== 334) throw new Error(`AUTH LOGIN refused: ${reply.text.trim()}`)
    await say(Buffer.from(account.address).toString('base64'))
    reply = await say(Buffer.from(account.authCode).toString('base64'))
    if (reply.code !== 235) throw new Error(`auth failed (${reply.code}): ${reply.text.trim()}`)
    reply = await say(`MAIL FROM:<${account.address}>`)
    if (reply.code !== 250) throw new Error(`MAIL FROM rejected: ${reply.text.trim()}`)
    for (const one of message.to.split(/[,;]\s*/).filter(Boolean)) {
      reply = await say(`RCPT TO:<${one}>`)
      if (reply.code !== 250 && reply.code !== 251) throw new Error(`RCPT rejected for ${one}: ${reply.text.trim()}`)
    }
    if (message.cc) {
      for (const one of message.cc.split(/[,;]\s*/).filter(Boolean)) {
        reply = await say(`RCPT TO:<${one}>`)
        if (reply.code !== 250 && reply.code !== 251) throw new Error(`RCPT rejected for ${one}: ${reply.text.trim()}`)
      }
    }
    reply = await say('DATA')
    if (reply.code !== 354) throw new Error(`DATA rejected: ${reply.text.trim()}`)
    const mime = buildMessage({ ...message, from: account.address })
    // Dot-stuff per RFC 5321: a leading "." on a line must be doubled.
    const stuffed = mime.replace(/(^|\r\n)\./g, '$1..')
    socket.write(stuffed)
    reply = await say('.')
    if (reply.code !== 250) throw new Error(`message rejected: ${reply.text.trim()}`)
    await say('QUIT')
    return { ok: true, messageId: /Message-ID: (\S+)/.exec(mime)?.[1] ?? null }
  } finally {
    socket.destroy()
  }
}
