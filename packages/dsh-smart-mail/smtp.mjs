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

/** Read one SMTP reply (possibly multiline 250-xxx), returns {code, text}. */
function readReply(socket) {
  return new Promise((resolve, reject) => {
    let buf = ''
    const onData = (chunk) => {
      buf += chunk.toString('utf8')
      const lines = buf.split(CRLF)
      while (lines.length > 1) {
        const line = lines.shift()
        const m = /^(\d{3})([ -])?(.*)$/.exec(line)
        if (m && m[2] === '-') continue // continuation line
        if (m) {
          socket.off('data', onData)
          socket.off('error', onErr)
          resolve({ code: Number(m[1]), text: buf })
          return
        }
      }
    }
    const onErr = (err) => {
      socket.off('data', onData)
      reject(err)
    }
    socket.on('data', onData)
    socket.once('error', onErr)
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

function foldHeader(name, value) {
  return `${name}: ${headerValue(value)}`
}

/** Build a complete MIME message. */
export function buildMessage({ from, fromName, to, cc, subject, text, html }) {
  const date = new Date().toUTCString()
  const messageId = `<${Date.now()}.${Math.random().toString(36).slice(2)}@dsh-smart-mail>`
  const headers = [
    foldHeader('From', fromName ? `${headerValue(fromName)} <${from}>` : from),
    foldHeader('To', to),
    cc ? foldHeader('Cc', cc) : null,
    foldHeader('Subject', subject ?? ''),
    `Date: ${date}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
    html
      ? 'Content-Type: multipart/alternative; boundary="dsh-smart-mail-alt"'
      : 'Content-Type: text/plain; charset=UTF-8',
    !html ? 'Content-Transfer-Encoding: base64' : null,
  ].filter(Boolean)

  let body
  if (html) {
    const encode = (s) => Buffer.from(s ?? '', 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n')
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
 */
export async function sendMail(account, message) {
  const smtp = account.smtp
  const { socket } = await connect({ host: smtp.host, port: smtp.port, tls: smtp.tls !== false })
  socket.setTimeout(0)
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
