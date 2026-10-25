/**
 * dsh-smart-mail — Host plugin.
 *
 * One row contributes:
 *   - send_email / read_emails tools for the agent (SMTP/IMAP over the
 *     accounts configured in ~/.dsh/smart-mail/accounts.json or the panel);
 *   - a background IMAP poller that wakes a fresh DSH session ONLY for
 *     whitelisted (allowFrom) senders — everything else stays silent;
 *   - same-origin HTTP routes under /smart-mail/* used by the settings
 *     panel (accounts CRUD, config, log, test).
 *
 * Wake = in-process sessionController.create + prompt (queue mode): no
 * external CLI, no window, and the new session follows DSH's current
 * default model because no model/selection is recorded for it.
 */

import {
  PRESETS,
  listAccounts,
  getAccount,
  saveAccount,
  removeAccount,
  loadSeen,
  saveSeen,
  appendLog,
  readLog,
  matchesAllowFrom,
} from './store.mjs'
import { sendMail } from './smtp.mjs'
import { openMailbox, selectInbox, searchSince, fetchSummaries, extractAddress } from './imap.mjs'
import { wakeWithMail } from './wake.mjs'

const ROUTE = '/smart-mail'

function json(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return {}
  }
}

/** Poll one account: fetch recent mails, dedupe by UID, wake on whitelist hits. */
async function pollAccount(ctx, account, cfg) {
  const session = await openMailbox(account)
  try {
    await selectInbox(session)
    const uids = await searchSince(session, 2)
    const summaries = await fetchSummaries(session, uids)
    const seen = loadSeen()
    const seenMap = seen[account.id] ?? {}
    const fresh = []
    for (const mail of summaries) {
      if (seenMap[mail.uid] !== undefined) continue
      const allowed = matchesAllowFrom(mail.fromAddress, cfg.allowFrom ?? [])
      seenMap[mail.uid] = {
        at: Date.now(),
        from: mail.fromAddress,
        subject: mail.subject,
        woke: allowed,
      }
      fresh.push({ ...mail, allowed })
    }
    seen[account.id] = seenMap
    saveSeen(seen)
    const woke = []
    for (const mail of fresh) {
      if (!mail.allowed) {
        appendLog({ kind: 'mail-seen', account: account.id, from: mail.fromAddress, subject: mail.subject, woke: false })
        continue
      }
      const result = await wakeWithMail(ctx, {
        account: `${account.label}(${account.address})`,
        from: mail.fromAddress,
        subject: mail.subject,
        preview: mail.preview,
        at: Date.now(),
      }, cfg)
      appendLog({
        kind: 'mail-wake',
        account: account.id,
        from: mail.fromAddress,
        subject: mail.subject,
        ok: result.ok,
        sessionId: result.sessionId ?? null,
        error: result.error ?? null,
      })
      woke.push({ from: mail.fromAddress, subject: mail.subject, ok: result.ok, sessionId: result.sessionId ?? null })
    }
    return { ok: true, fresh: fresh.length, woke }
  } finally {
    session.close()
  }
}

/** Untrained JSON out: render the value as one text block. */
function jsonOut() {
  return {
    schema: { type: 'object' },
    render: (_args, value) => [
      { type: 'text', text: JSON.stringify(value, null, 2) ?? String(value) },
    ],
  }
}

const plugin = {
  name: 'smart-mail',
  inject: ['tools', 'webServer', 'sessionController'],

  Config: undefined,

  apply(ctx, config) {
    const cfg = {
      enabled: config?.enabled !== false,
      pollIntervalSec: Math.max(30, Number(config?.pollIntervalSec ?? 120)),
      allowFrom: Array.isArray(config?.allowFrom) ? config.allowFrom : [],
      model: config?.model ?? 'default',
      wakePrompt: config?.wakePrompt ?? '处理这封新邮件并按需回复。',
      wakeCwd: config?.wakeCwd ?? process.cwd(),
    }
    let liveConfig = { ...cfg }

    const applyTools = () => {
      ctx.effect(() => ctx.tools.register({
        name: 'send_email',
        description:
          'Send an email through a configured dsh-smart-mail account (SMTP, authorization-code auth). ' +
          'Use it whenever the user asks to send mail; pick the account by id or label, or let the only configured account be the default.',
        parameters: {
          type: 'object',
          properties: {
            account: { type: 'string', description: 'Account id or label (optional when only one account is configured).' },
            to: { type: 'string', description: 'Recipient addresses, comma-separated.' },
            cc: { type: 'string', description: 'Optional Cc addresses, comma-separated.' },
            subject: { type: 'string', description: 'Email subject.' },
            text: { type: 'string', description: 'Plain-text body.' },
            html: { type: 'string', description: 'Optional HTML body (sent as alternative part).' },
          },
          required: ['to', 'subject', 'text'],
        },
        output: jsonOut(),
        async execute(args) {
          const accounts = listAccounts()
          if (accounts.length === 0) {
            return { ok: false, error: 'no account configured; add one in Settings → 智能邮箱' }
          }
          let account = null
          if (args.account) {
            const key = String(args.account).toLowerCase()
            account = accounts.find((a) => a.id.toLowerCase() === key || String(a.label).toLowerCase() === key || a.address.toLowerCase() === key) ?? null
          } else if (accounts.length === 1) {
            account = accounts[0]
          }
          if (!account) {
            return { ok: false, error: `account not found: ${args.account}`, accounts: accounts.map((a) => ({ id: a.id, label: a.label, address: a.address })) }
          }
          try {
            const result = await sendMail(account, {
              to: args.to, cc: args.cc, subject: args.subject, text: args.text, html: args.html,
              fromName: account.label,
            })
            appendLog({ kind: 'send', account: account.id, to: args.to, subject: args.subject, ok: true })
            return { ok: true, ...result, account: account.address }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            appendLog({ kind: 'send', account: account.id, to: args.to, subject: args.subject, ok: false, error: message })
            return { ok: false, error: message }
          }
        },
      }), 'smart-mail: send_email tool')

      ctx.effect(() => ctx.tools.register({
        name: 'read_emails',
        description:
          'Read recent emails from a configured dsh-smart-mail account over IMAP (ENVELOPE summaries plus short body previews). ' +
          'Returns newest first; use account id/label to pick a mailbox and daysBack/query to narrow.',
        parameters: {
          type: 'object',
          properties: {
            account: { type: 'string', description: 'Account id or label (optional when only one account is configured).' },
            daysBack: { type: 'number', description: 'How many days back to search (default 3, max 30).' },
            limit: { type: 'number', description: 'Maximum messages to return (default 10, max 30).' },
            unreadOnly: { type: 'boolean', description: 'Only messages not yet fetched by this plugin (default false).' },
          },
        },
        output: jsonOut(),
        async execute(args) {
          const accounts = listAccounts()
          if (accounts.length === 0) {
            return { ok: false, error: 'no account configured; add one in Settings → 智能邮箱' }
          }
          let account = null
          if (args.account) {
            const key = String(args.account).toLowerCase()
            account = accounts.find((a) => a.id.toLowerCase() === key || String(a.label).toLowerCase() === key || a.address.toLowerCase() === key) ?? null
          } else if (accounts.length === 1) {
            account = accounts[0]
          }
          if (!account) {
            return { ok: false, error: `account not found: ${args.account}`, accounts: accounts.map((a) => ({ id: a.id, label: a.label, address: a.address })) }
          }
          const daysBack = Math.min(30, Math.max(1, Number(args.daysBack ?? 3)))
          const limit = Math.min(30, Math.max(1, Number(args.limit ?? 10)))
          try {
            const session = await openMailbox(account)
            try {
              await selectInbox(session)
              let uids = await searchSince(session, daysBack, 30)
              if (args.unreadOnly) {
                const seen = loadSeen()[account.id] ?? {}
                uids = uids.filter((uid) => seen[uid] === undefined)
              }
              const summaries = (await fetchSummaries(session, uids.slice(0, limit))).map((m) => ({
                uid: m.uid,
                from: m.fromAddress,
                fromName: m.fromName,
                subject: m.subject,
                date: m.date,
                preview: m.preview,
              }))
              return { ok: true, account: account.address, count: summaries.length, emails: summaries }
            } finally {
              session.close()
            }
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) }
          }
        },
      }), 'smart-mail: read_emails tool')
    }

    const applyPoller = () => {
      if (!liveConfig.enabled) return () => {}
      let disposed = false
      let busy = false
      const tick = async () => {
        if (disposed || busy) return
        busy = true
        for (const account of listAccounts()) {
          try {
            await pollAccount(ctx, account, liveConfig)
          } catch (error) {
            appendLog({
              kind: 'poll-error',
              account: account.id,
              error: error instanceof Error ? error.message : String(error),
            })
          }
        }
        busy = false
      }
      const timer = setInterval(() => { void tick() }, liveConfig.pollIntervalSec * 1000)
      setTimeout(() => { void tick() }, 8000) // first check shortly after boot
      return () => {
        disposed = true
        clearInterval(timer)
      }
    }

    const applyRoutes = () => {
      ctx.effect(() => ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE,
        handler: async (req, res) => {
          try {
            const url = new URL(req.url ?? '/', 'http://localhost')
            const route = url.pathname.slice(ROUTE.length) || '/'
            if (route === '/status' && req.method === 'GET') {
              const accounts = listAccounts().map((a) => ({
                id: a.id, label: a.label, address: a.address, preset: a.preset,
                imap: a.imap, smtp: a.smtp, authCodeTail: a.authCode ? `${a.authCode.slice(0, 2)}***(${a.authCode.length})` : '',
              }))
              json(res, 200, { ok: true, config: liveConfig, presets: PRESETS, accounts, log: readLog(60) })
              return
            }
            if (route === '/account' && req.method === 'POST') {
              const body = await readBody(req)
              const account = saveAccount(body)
              json(res, 200, { ok: true, account: { ...account, authCode: undefined } })
              return
            }
            if (route === '/account' && req.method === 'DELETE') {
              const id = url.searchParams.get('id') ?? ''
              if (!id) { json(res, 400, { ok: false, error: 'missing id' }); return }
              removeAccount(id)
              json(res, 200, { ok: true })
              return
            }
            if (route === '/test' && req.method === 'POST') {
              const body = await readBody(req)
              const account = body.id ? getAccount(body.id) : saveAccount(body)
              if (!account) { json(res, 404, { ok: false, error: 'account not found' }); return }
              try {
                const session = await openMailbox(account)
                const info = await selectInbox(session)
                session.close()
                json(res, 200, { ok: true, inbox: info })
              } catch (error) {
                json(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
              }
              return
            }
            if (route === '/config' && req.method === 'POST') {
              const body = await readBody(req)
              liveConfig = {
                ...liveConfig,
                ...(body.enabled !== undefined ? { enabled: Boolean(body.enabled) } : {}),
                ...(body.pollIntervalSec !== undefined ? { pollIntervalSec: Math.max(30, Number(body.pollIntervalSec) || 120) } : {}),
                ...(Array.isArray(body.allowFrom) ? { allowFrom: body.allowFrom.map(String) } : {}),
                ...(body.model !== undefined ? { model: String(body.model) } : {}),
                ...(body.wakePrompt !== undefined ? { wakePrompt: String(body.wakePrompt) } : {}),
                ...(body.wakeCwd !== undefined ? { wakeCwd: String(body.wakeCwd) } : {}),
              }
              json(res, 200, { ok: true, config: liveConfig })
              return
            }
            if (route === '/poll-now' && req.method === 'POST') {
              const results = []
              for (const account of listAccounts()) {
                try {
                  results.push({ account: account.id, ...(await pollAccount(ctx, account, liveConfig)) })
                } catch (error) {
                  results.push({ account: account.id, ok: false, error: error instanceof Error ? error.message : String(error) })
                }
              }
              json(res, 200, { ok: true, results })
              return
            }
            json(res, 404, { ok: false, error: `unknown route ${req.method} ${route}` })
          } catch (cause) {
            json(res, 500, { ok: false, error: cause instanceof Error ? cause.message : String(cause) })
          }
        },
      }), 'smart-mail: panel routes')
    }

    applyTools()
    ctx.effect(applyPoller(), 'smart-mail: poller')
    applyRoutes()

    appendLog({ kind: 'plugin-start', config: { ...liveConfig } })
  },
}

export default plugin
export { PRESETS, ROUTE }
