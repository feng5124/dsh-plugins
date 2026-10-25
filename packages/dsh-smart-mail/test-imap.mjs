// IMAP reader integration test against a scripted plaintext server.
// Run: node test-imap.mjs
import net from 'node:net'
import assert from 'node:assert/strict'
import { ImapSession, parseFetchLine } from './imap.mjs'

const subject = Buffer.from('重要：项目评审通过', 'utf8')
const body = Buffer.from('你好，\r\n项目已通过评审。\r\n', 'utf8')

const server = net.createServer((socket) => {
  socket.write('* OK ready\r\n')
  socket.on('data', (chunk) => {
    const text = chunk.toString('utf8')
    if (text.includes('LOGIN')) { socket.write('A0001 OK LOGIN done\r\n'); return }
    if (text.includes('SELECT')) {
      socket.write('* 3 EXISTS\r\n* OK [UIDVALIDITY 123]\r\nA0002 OK [READ-WRITE] SELECT done\r\n')
      return
    }
    if (text.includes('SEARCH')) { socket.write('* SEARCH 100 101 102\r\nA0003 OK SEARCH done\r\n'); return }
    if (text.includes('FETCH')) {
      const payload = Buffer.concat([
        Buffer.from('* 1 FETCH (UID 102 ENVELOPE ("Mon, 24 Oct 2026 10:00:00 +0800" (("Sender" NIL "boss" "company.com")) NIL NIL NIL NIL NIL ', 'utf8'),
        Buffer.from(`{${subject.length}}\r\n`, 'utf8'), subject,
        Buffer.from(') BODY[TEXT]<0> ', 'utf8'),
        Buffer.from(`{${body.length}}\r\n`, 'utf8'), body,
        Buffer.from(')\r\nA0004 OK FETCH done\r\n', 'utf8'),
      ])
      // Deliver in two chunks to exercise incremental assembly.
      socket.write(payload.subarray(0, 60))
      setTimeout(() => socket.write(payload.subarray(60)), 20)
      return
    }
    if (text.includes('LOGOUT')) { socket.write('* BYE\r\nA999 OK LOGOUT\r\n'); socket.end() }
  })
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const session = new ImapSession(net.createConnection({ host: '127.0.0.1', port }))
const timer = setTimeout(() => { console.error('TIMEOUT'); process.exit(2) }, 15000)
await session.reader.readUntil('* OK')
await session.exec(['LOGIN', 'a@b.c', 'pass'])
await session.exec(['SELECT', 'INBOX'])
const searchLines = await session.exec(['UID SEARCH SINCE 24-Oct-2026'])
assert.ok(searchLines.map((l) => l.text).join('|').includes('102'), 'SEARCH finds 102')

const fetchLines = await session.exec(['UID FETCH 102 (UID ENVELOPE BODY.PEEK[TEXT]<0.2048>)'])
const row = fetchLines.map(parseFetchLine).find(Boolean)
assert.ok(row, 'parsed fetch row')
assert.equal(row.uid, 102)
assert.equal(row.fromAddress, 'boss@company.com')
assert.equal(row.fromName, 'Sender')
assert.equal(row.subject, '重要：项目评审通过')
assert.ok(row.preview.includes('项目已通过评审'), `preview: ${row.preview}`)
console.log('IMAP literal integration tests OK')
clearTimeout(timer)
session.close()
server.close()
process.exit(0)
