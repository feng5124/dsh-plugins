/**
 * dsh-smart-mail — Host plugin.
 *
 * One row contributes:
 *   - send_email / read_emails tools for the agent (SMTP/IMAP over the
 *     accounts configured in <dsh home>/smart-mail/accounts.json or the panel);
 *   - a background IMAP poller that, for whitelisted senders only, either
 *     wakes a fresh DSH session or **continues the session its mail thread is
 *     already bound to** (interrupting that session's running turn first);
 *   - same-origin HTTP routes under /smart-mail/* used by the settings panel
 *     (accounts CRUD, config, log, test, thread table, log health).
 *
 * Thread continuation in one line: every message this plugin sends carries a
 * thread tag in the subject plus a recorded Message-ID; an inbound reply is
 * resolved back to that tag (References/In-Reply-To first, then the
 * X-DSH-Session header, then the subject tag) and therefore back to its
 * session — see threads.mjs for the resolution order and wake.mjs for the
 * delivery/interrupt/archive-restore semantics.
 *
 * Logging is deliberately quiet: a start summary (full config only when it
 * changed), one aggregate line per poll round for ignored mail, and a
 * complete record for every wake attempt — including the mail headers needed
 * to debug a failure. See store.mjs for the rotation policy.
 */

import { readFileSync } from 'node:fs'

import {
  PRESETS,
  LOG_ROTATION,
  listAccounts,
  getAccount,
  saveAccount,
  removeAccount,
  loadSeen,
  saveSeen,
  appendLog,
  readLog,
  logStats,
  rotateLog,
  loadThreads,
  bindThread,
  bumpThreadRound,
  setThreadModel,
  recordOutgoing,
  tagForOutgoing,
  tagForSession,
  sessionForTag,
  getMessage,
  putMessage,
  loadLastConfig,
  saveLastConfig,
  matchesAllowFrom,
} from './store.mjs'
import { sendMail } from './smtp.mjs'
import { openMailbox, selectInbox, searchSince, fetchSummaries, fetchThreaded, extractAddress, decodeMimeWord } from './imap.mjs'
import {
  THREAD_HEADER_FIELDS,
  DEFAULT_TAG_PREFIX,
  addressesIn,
  headerValue,
  messageIdsIn,
  newMessageId,
  newTag,
  tagFromSubject,
  tagSubject,
  detectLoop,
  resolveThread,
  IgnoreReason,
} from './threads.mjs'
import { DeliveryMode, deliverToSession, sessionState, wakeWithMail } from './wake.mjs'
import { applySessionModel, chooseSelection, describeSelection, isSelection, readCatalog } from './model-choice.mjs'

const ROUTE = '/smart-mail'
/**
 * Reported version. Read from package.json so it can never drift from the
 * published artifact — it said 0.2.0 while the package was already 0.3.0.
 */
const PLUGIN_VERSION = (() => {
  try {
    const here = new URL('./package.json', import.meta.url)
    return JSON.parse(readFileSync(here, 'utf8')).version ?? 'unknown'
  } catch {
    return 'unknown'
  }
})()

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

/* ------------------------------------------------------------------ config */

/** Effective config from the profile patch plus defaults. */
function normalizeConfig(config) {
  return {
    enabled: config?.enabled !== false,
    pollIntervalSec: Math.max(30, Number(config?.pollIntervalSec ?? 120)),
    allowFrom: Array.isArray(config?.allowFrom) ? config.allowFrom.map(String) : [],
    model: config?.model ?? 'default',
    wakePrompt: config?.wakePrompt ?? '处理这封新邮件并按需回复。',
    wakeCwd: config?.wakeCwd ?? process.cwd(),
    tagPrefix: typeof config?.tagPrefix === 'string' && config.tagPrefix.length > 0 ? config.tagPrefix : DEFAULT_TAG_PREFIX,
    // A reply inside a known thread replaces that session's running turn.
    interruptSameThread: config?.interruptSameThread !== false,
    // Continue the bound session instead of starting a new one.
    continueThreads: config?.continueThreads !== false,
    // Restore an archived thread session instead of abandoning the thread.
    autoUnarchive: config?.autoUnarchive !== false,
    /**
     * Model for mail-triggered sessions, same shape as the session page's
     * selector: `{provider, model, reasoningEffort?}`. Unset means "follow the
     * deployment default", which is the behaviour before this option existed.
     */
    modelSelection: isSelection(config?.modelSelection)
      ? {
        provider: config.modelSelection.provider,
        model: config.modelSelection.model,
        ...(config.modelSelection.reasoningEffort === undefined ? {} : { reasoningEffort: String(config.modelSelection.reasoningEffort) }),
      }
      : null,
    logMaxBytes: Math.max(64 * 1024, Number(config?.logMaxBytes ?? LOG_ROTATION.maxBytes)),
    logKeepDays: Math.max(1, Number(config?.logKeepDays ?? LOG_ROTATION.keepDays)),
    logKeepFiles: Math.max(1, Number(config?.logKeepFiles ?? LOG_ROTATION.keepFiles)),
  }
}

/** The rotation knobs `appendLog` takes. */
function rotationOf(cfg) {
  return { maxBytes: cfg.logMaxBytes, keepDays: cfg.logKeepDays, keepFiles: cfg.logKeepFiles }
}

/** Fields compared to decide whether the effective config really changed. */
const CONFIG_FIELDS = [
  'enabled',
  'pollIntervalSec',
  'allowFrom',
  'model',
  'wakePrompt',
  'wakeCwd',
  'tagPrefix',
  'interruptSameThread',
  'continueThreads',
  'autoUnarchive',
  'modelSelection',
  'logMaxBytes',
  'logKeepDays',
  'logKeepFiles',
]

/** Which config fields differ between two effective configs. */
function configDiff(previous, next) {
  if (previous === null || previous === undefined) return null
  const changed = []
  for (const field of CONFIG_FIELDS) {
    const left = previous[field]
    const right = next[field]
    const same = JSON.stringify(left) === JSON.stringify(right)
    if (!same) changed.push(field)
  }
  return changed
}

/**
 * A compact config digest for the start summary — never the whole config.
 * Secrets are absent by construction (accounts live elsewhere), and the long
 * wake prompt is reduced to its length.
 */
function configDigest(cfg) {
  return {
    enabled: cfg.enabled,
    pollIntervalSec: cfg.pollIntervalSec,
    allowFromCount: cfg.allowFrom.length,
    allowFromSample: cfg.allowFrom.slice(0, 3),
    model: cfg.model,
    wakeCwd: cfg.wakeCwd,
    wakePromptChars: String(cfg.wakePrompt ?? '').length,
    tagPrefix: cfg.tagPrefix,
    interruptSameThread: cfg.interruptSameThread,
    continueThreads: cfg.continueThreads,
    autoUnarchive: cfg.autoUnarchive,
    log: { maxBytes: cfg.logMaxBytes, keepDays: cfg.logKeepDays, keepFiles: cfg.logKeepFiles },
  }
}

/* ------------------------------------------------------------- prompt text */

/** Model-facing prompt for one inbound message. */
function renderPrompt(mail, cfg, extra) {
  const lines = [
    `[dsh-smart-mail] ${extra.isNew ? '新邮件（已为该线程创建新会话）' : `同一邮件线程的续接（第 ${extra.round} 轮）`}`,
    `邮箱账号：${mail.account}`,
    `发件人：${mail.from}`,
    ...(mail.to ? [`收件人：${mail.to}`] : []),
    ...(mail.cc ? [`抄送：${mail.cc}`] : []),
    `主题：${mail.subject || '(无主题)'}`,
    `线程标识：${mail.tag}`,
    ...(mail.messageId ? [`Message-ID：${mail.messageId}`] : []),
    ...(mail.inReplyTo ? [`In-Reply-To：${mail.inReplyTo}`] : []),
    `时间：${new Date(mail.at || Date.now()).toLocaleString('zh-CN')}`,
  ]
  if (extra.interrupted) lines.push('（该会话上一轮正在运行，已按同线程回复规则打断，本封邮件优先处理。）')
  lines.push('', `正文：`, mail.body || mail.preview || '(空)')
  if (!extra.isNew) {
    lines.push(
      '',
      '这是同一邮件线程的后续邮件，请沿用该会话已有的上下文继续处理，不要从头重述。',
    )
  }
  lines.push(
    '',
    cfg.wakePrompt,
    '如需回信，直接调用 send_email（带上 inReplyTo 或 threadTag 以保持同一线程）。',
  )
  return lines.join('\n')
}

/**
 * Persist the effective config back into the profile patch layer.
 *
 * The panel edits `liveConfig` in memory, which survives until the Host restarts
 * and then reverts to whatever the profile says — so a poll interval or model
 * chosen in the panel silently reset on every reboot. `configEditor.edit()` is
 * the same durable write `agentDefaultModel.saveSelection()` uses: it validates
 * the config, rewrites this entry's row in the profile's `cordis.patch.yml`, and
 * reconciles the loader.
 *
 * The row is written under this plugin's own entry id, so it becomes an ordinary
 * user override that the bundle layer sits beneath. A failed save is reported to
 * the caller but never loses the in-memory change for the current run.
 *
 * @param {object} ctx Host context
 * @param {object} nextConfig the config to persist (the whole effective config)
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function persistConfig(ctx, nextConfig) {
  const editor = ctx.get('configEditor')
  if (editor === undefined) return { ok: false, error: 'configEditor service unavailable (this Host has no profile editor)' }
  const entry = ctx.fiber?.entry
  if (entry === undefined) return { ok: false, error: 'this plugin has no loader entry to write' }

  const { modelSelection, ...rest } = nextConfig
  const payload = {
    ...rest,
    ...(modelSelection === null || modelSelection === undefined ? {} : { modelSelection }),
  }

  try {
    await editor.edit(entry, () => payload)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/* ------------------------------------------------------------------ polling */

/** Sender summary for the batched mail-seen line: at most 5 entries. */
function senderSummary(entries) {
  const counts = new Map()
  for (const entry of entries) {
    const key = entry.from ?? '(unknown)'
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([from, count]) => ({ from, count }))
}

/**
 * Poll one account: fetch new mail, resolve threads, wake or continue.
 *
 * Logging contract:
 *   - non-allowlisted / duplicate / loop mail is aggregated into at most ONE
 *     `mail-seen` line per poll round (and none at all when nothing arrived);
 *   - every whitelisted message that is acted on produces one `mail-wake`
 *     line with its full outcome and the headers needed to debug it.
 */
async function pollAccount(ctx, account, cfg, log) {
  const session = await openMailbox(account)
  try {
    await selectInbox(session)
    const uids = await searchSince(session, 2)
    if (uids.length === 0) return { ok: true, fresh: 0, woke: [] }
    const fetched = await fetchThreaded(session, uids, THREAD_HEADER_FIELDS)
    const seen = loadSeen()
    const seenMap = seen[account.id] ?? {}
    const fresh = []
    for (const mail of fetched) {
      if (seenMap[mail.uid] !== undefined) continue
      const headers = mail.headers
      const from = addressesIn(headerValue(headers, 'from') ?? '')[0] ?? null
      const subject = decodeMimeWord(headerValue(headers, 'subject') ?? '') ?? null
      const messageId = messageIdsIn(headerValue(headers, 'message-id') ?? '')[0] ?? null
      const inReplyTo = messageIdsIn(headerValue(headers, 'in-reply-to') ?? '')[0] ?? null
      const allowed = matchesAllowFrom(from, cfg.allowFrom)
      seenMap[mail.uid] = { at: Date.now(), from, subject, allowed, messageId }
      fresh.push({ uid: mail.uid, headers, from, subject, messageId, inReplyTo, preview: mail.preview, allowed })
    }
    seen[account.id] = seenMap
    saveSeen(seen)

    if (fresh.length === 0) return { ok: true, fresh: 0, woke: [] }

    const ignored = []
    const acted = []
    for (const mail of fresh) {
      if (!mail.allowed) {
        ignored.push({ ...mail, reason: IgnoreReason.notAllowlisted })
        continue
      }
      const loopReason = detectLoop(mail.headers, { selfAddresses: [account.address], sender: mail.from })
      if (loopReason !== undefined) {
        ignored.push({ ...mail, reason: loopReason })
        continue
      }
      // Duplicate detection is by Message-ID: a re-poll, a UIDVALIDITY reset,
      // or the same mail delivered to two folders must not run twice.
      const previous = mail.messageId === null ? undefined : getMessage(mail.messageId)
      if (previous !== undefined && previous.stage === 'done') {
        ignored.push({ ...mail, reason: 'duplicate', previousSessionId: previous.sessionId })
        continue
      }
      acted.push(mail)
    }

    // One aggregate line per round; skipped entirely when nothing was ignored.
    if (ignored.length > 0) {
      const blocked = ignored.filter((entry) => entry.reason === IgnoreReason.notAllowlisted).length
      log({
        kind: 'mail-seen',
        account: account.id,
        address: account.address,
        fresh: fresh.length,
        blocked,
        skipped: ignored.length - blocked,
        reasons: [...new Set(ignored.map((entry) => entry.reason))],
        senders: senderSummary(ignored),
        // Verifiability: the allowlist decision for each distinct sender is
        // kept, so "was this sender really not whitelisted?" stays answerable.
        decisions: [...new Map(ignored.map((entry) => [entry.from, entry.allowed])).entries()]
          .slice(0, 5)
          .map(([from, allowed]) => ({ from, allowlisted: allowed === true })),
        sample: ignored.slice(0, 3).map((entry) => ({
          from: entry.from,
          subject: entry.subject,
          uid: entry.uid,
          messageId: entry.messageId,
          reason: entry.reason,
        })),
      })
    }

    const woke = []
    for (const mail of acted) {
      const result = await handleMail(ctx, account, mail, cfg)
      woke.push({
        from: mail.from,
        subject: mail.subject,
        route: result.route,
        ok: result.ok,
        sessionId: result.sessionId ?? null,
      })
    }
    return { ok: true, fresh: fresh.length, woke }
  } finally {
    session.close()
  }
}

/**
 * Act on one allowlisted message: resolve its thread, then continue that
 * session (interrupting it if needed) or start a new one.
 *
 * Always emits exactly one `mail-wake` record — success carries the session
 * id and the delivery mode, failure carries the complete error plus the mail
 * headers, which is what makes a failure debuggable after the fact.
 */
/**
 * Decide which model this wake should use, and apply it to the session.
 *
 * Order: the thread's own pinned model, then the plugin config's model, then the
 * deployment default. A pinned model that is no longer routable downgrades to the
 * default *for this wake* — a mail must never go unanswered because a model was
 * renamed or a provider lost its key.
 *
 * @returns {Promise<{model: string, modelSource: string, modelFallback?: string, modelError?: string}>}
 *   fields ready to merge into a `mail-wake` log record
 */
async function applyModelChoice(ctx, sessionId, threadRecord, cfg) {
  const catalog = await readCatalog(ctx)
  const configured = cfg.modelSelection ?? undefined
  const threadSelection = threadRecord?.modelSelection ?? undefined

  // With no catalog the Host cannot tell us what is routable; keep the
  // deployment default rather than guessing.
  if (catalog === null) {
    return { model: 'deployment-default', modelSource: 'default', modelFallback: 'catalog-unavailable' }
  }

  const choice = chooseSelection({
    catalog,
    thread: threadSelection,
    configured,
    deployment: catalog.default,
  })

  if (choice.selection === undefined) {
    // Nothing to apply: the session keeps whatever the deployment default is,
    // which is exactly the behaviour before this feature existed.
    return {
      model: 'deployment-default',
      modelSource: choice.source,
      ...(choice.fallback === undefined ? {} : { modelFallback: choice.fallback }),
    }
  }

  const applied = await applySessionModel(ctx, sessionId, choice.selection)
  if (!applied.ok) {
    // Applying failed (session vanished, adapter rejected the route). Fall back
    // to the deployment default and say so; the wake still proceeds.
    return {
      model: describeSelection(choice.selection),
      modelSource: choice.source,
      modelFallback: `apply-failed: ${applied.error}`,
    }
  }
  return {
    model: describeSelection(applied.applied),
    modelSource: choice.source,
    ...(choice.fallback === undefined ? {} : { modelFallback: choice.fallback }),
  }
}

async function handleMail(ctx, account, mail, cfg) {
  const lookupOutgoing = (messageId) => tagForOutgoing(messageId)
  const lookupTag = (tag) => sessionForTag(tag)
  const thread = resolveThread({
    headers: mail.headers,
    lookupOutgoing,
    lookupTag,
    tagPrefix: cfg.tagPrefix,
  })

  const base = {
    kind: 'mail-wake',
    account: account.id,
    address: account.address,
    from: mail.from,
    to: (addressesIn(headerValue(mail.headers, 'to') ?? '') ?? []).slice(0, 5).join(',') || null,
    cc: (addressesIn(headerValue(mail.headers, 'cc') ?? '') ?? []).slice(0, 5).join(',') || null,
    subject: mail.subject,
    messageId: mail.messageId,
    inReplyTo: mail.inReplyTo,
    referenceCount: messageIdsIn(headerValue(mail.headers, 'references') ?? '').length,
    uid: mail.uid,
    threadVia: thread.via,
    tag: thread.tag ?? null,
  }

  let sessionId = cfg.continueThreads ? thread.sessionId : undefined
  let route = 'new-session'
  let rebind = null
  let tag = thread.tag ?? tagFromSubject(mail.subject ?? '', cfg.tagPrefix)

  // The thread resolved to a tag whose session is gone: rebind the tag to the
  // new session deliberately (and say so) instead of silently splitting.
  if (cfg.continueThreads && thread.sessionId !== undefined) {
    const state = await sessionState(ctx, thread.sessionId)
    if (state === 'missing') {
      rebind = { reason: 'session-missing', previousSessionId: thread.sessionId }
      sessionId = undefined
    } else {
      route = 'continue'
    }
  }

  if (route === 'continue') {
    const round = bumpThreadRound(tag)
    // Pin the model on the session *before* the prompt, so this turn runs on it.
    const modelInfo = await applyModelChoice(ctx, sessionId, loadThreads().byTag[tag], cfg)
    const result = await deliverToSession(ctx, {
      sessionId,
      text: renderPrompt(mail, cfg, { isNew: false, round: round || 1, interrupted: false }),
      mode: cfg.interruptSameThread ? DeliveryMode.interrupt : DeliveryMode.queue,
    })
    if (result.ok) {
      putMessage(mail.messageId ?? `uid:${account.id}:${mail.uid}`, {
        ...base,
        sessionId,
        tag,
        stage: 'done',
        route,
        mode: result.mode,
        interrupted: result.interrupted === true,
        cancelUsed: result.cancelUsed === true,
        unarchivePath: result.unarchivePath,
        ...modelInfo,
      })
      appendLog({
        ...base,
        ok: true,
        route,
        sessionId,
        mode: result.mode,
        interrupted: result.interrupted === true,
        cancelUsed: result.cancelUsed === true,
        wasRunning: result.wasRunning === true,
        unarchivePath: result.unarchivePath ?? null,
        round: round || 1,
        ...modelInfo,
      }, rotationOf(cfg))
      return { ok: true, sessionId, route }
    }
    appendLog({ ...base, ok: false, route, sessionId, error: result.error ?? 'unknown delivery failure', ...modelInfo }, rotationOf(cfg))
    return { ok: false, sessionId, route }
  }

  // ---- new session -------------------------------------------------------
  // A brand-new thread needs its own tag now: it is the reply anchor, so the
  // record, the prompt, and the outgoing mail must agree on it.
  if (tag === undefined) tag = newTag(mail.messageId ?? `${account.id}:${mail.uid}`)
  const wake = await wakeWithMail(ctx, {
    account: `${account.label}(${account.address})`,
    from: mail.from,
    subject: mail.subject,
    preview: mail.preview,
    at: Date.now(),
  }, { ...cfg, wakePrompt: renderPrompt(mail, cfg, { isNew: true, round: 1 }) })

  if (!wake.ok) {
    appendLog({
      ...base,
      tag,
      ok: false,
      route,
      error: wake.error ?? 'session creation failed',
      rebind,
    }, rotationOf(cfg))
    return { ok: false, route }
  }

  // A brand-new session follows the deployment default unless a model is
  // configured; apply it before the first prompt so the very first turn uses it.
  const modelInfo = await applyModelChoice(ctx, wake.sessionId, null, cfg)

  const bound = bindThread(tag, { sessionId: wake.sessionId, subject: mail.subject })
  if (bound.rebound) {
    // Keep the established binding; the new session is left unreferenced and
    // the conflict is recorded instead of moving the thread.
    appendLog({
      ...base,
      tag,
      ok: true,
      route,
      sessionId: bound.previousSessionId,
      rebind: { reason: 'tag-already-bound', previousSessionId: bound.previousSessionId, orphanSessionId: wake.sessionId },
      warning: 'thread tag was already bound to another session; kept the original binding',
      ...modelInfo,
    }, rotationOf(cfg))
    return { ok: true, sessionId: bound.previousSessionId, route: 'continue-fallback' }
  }

  putMessage(mail.messageId ?? `uid:${account.id}:${mail.uid}`, {
    ...base,
    sessionId: wake.sessionId,
    tag,
    stage: 'done',
    route,
    rebind,
    ...modelInfo,
  })
  appendLog({
    ...base,
    ok: true,
    route,
    sessionId: wake.sessionId,
    tag,
    rebind,
    ...modelInfo,
  }, rotationOf(cfg))
  return { ok: true, sessionId: wake.sessionId, route }
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
  // `llm` is required for the model picker: it resolves and validates a
  // selection exactly as the session page does. `configEditor` is required so
  // panel changes can be written back to the profile instead of resetting on
  // restart.
  inject: ['tools', 'webServer', 'sessionController', 'llm', 'configEditor'],

  Config: undefined,

  apply(ctx, config) {
    let liveConfig = normalizeConfig(config)

    const log = (record) => appendLog(record, rotationOf(liveConfig))

    /**
     * Apply a rotation-policy change to the file that already exists.
     *
     * Rotation normally happens right before a write, but lowering the limit
     * from the panel must take effect immediately — otherwise an oversized log
     * would sit there until the next mail arrives. `rotateLog` writes its own
     * `log-rotate` record into the fresh file, so the archive boundary stays
     * self-describing.
     */
    const applyRotationNow = (reason) => rotateLog({ ...rotationOf(liveConfig), reason })

    /** Resolve one account by id / label / address, or the only account. */
    const pickAccount = (key) => {
      const accounts = listAccounts()
      if (accounts.length === 0) return { error: 'no account configured; add one in Settings → 智能邮箱', accounts }
      if (key) {
        const needle = String(key).toLowerCase()
        const found = accounts.find((a) => a.id.toLowerCase() === needle || String(a.label).toLowerCase() === needle || a.address.toLowerCase() === needle) ?? null
        return { account: found, accounts }
      }
      return { account: accounts.length === 1 ? accounts[0] : null, accounts }
    }

    /* ------------------------------------------------------- start summary */
    // Rotate before the first line so a restart after a long pause still
    // starts a fresh file, then record one line with a digest; the full
    // config is written only when it changed.
    rotateLog({ ...rotationOf(liveConfig), reason: 'startup' })
    const previous = loadLastConfig()
    const changed = configDiff(previous?.config ?? null, liveConfig)
    log({
      kind: 'plugin-start',
      version: PLUGIN_VERSION,
      pid: process.pid,
      configDigest: configDigest(liveConfig),
      configChanged: changed === null ? 'first-run' : changed.length > 0,
      ...(changed !== null && changed.length > 0 ? { changedFields: changed } : {}),
    })
    if (changed === null || changed.length > 0) {
      log({
        kind: 'config-change',
        reason: changed === null ? 'first-run' : 'startup',
        changedFields: changed ?? CONFIG_FIELDS.slice(),
        before: previous?.config ?? null,
        after: liveConfig,
      })
    }
    saveLastConfig(liveConfig)

    const applyTools = () => {
      ctx.effect(() => ctx.tools.register({
        name: 'send_email',
        description:
          'Send an email through a configured dsh-smart-mail account (SMTP, authorization-code auth). ' +
          'Use it whenever the user asks to send mail; pick the account by id or label, or let the only configured account be the default. ' +
          'To answer inside an existing mail thread, pass inReplyTo (the Message-ID you are replying to) or threadTag: the subject tag, ' +
          'In-Reply-To and References headers are then set automatically so the reply continues that DSH session.',
        parameters: {
          type: 'object',
          properties: {
            account: { type: 'string', description: 'Account id or label (optional when only one account is configured).' },
            to: { type: 'string', description: 'Recipient addresses, comma-separated.' },
            cc: { type: 'string', description: 'Optional Cc addresses, comma-separated.' },
            subject: { type: 'string', description: 'Email subject.' },
            text: { type: 'string', description: 'Plain-text body.' },
            html: { type: 'string', description: 'Optional HTML body (sent as alternative part).' },
            inReplyTo: { type: 'string', description: 'Message-ID being answered, e.g. <abc@x.com>. Keeps the reply in the same thread.' },
            threadTag: { type: 'string', description: 'Thread tag (e.g. a3f9). Defaults to the tag of the current session.' },
          },
          required: ['to', 'subject', 'text'],
        },
        output: jsonOut(),
        async execute(args, exec) {
          const picked = pickAccount(args.account)
          if (picked.error) return { ok: false, error: picked.error }
          const account = picked.account
          if (!account) {
            return { ok: false, error: `account not found: ${args.account}`, accounts: picked.accounts.map((a) => ({ id: a.id, label: a.label, address: a.address })) }
          }

          // Thread identity: explicit tag, else the tag of this very session,
          // else the tag our own outgoing table knows for the parent id.
          const sessionId = exec?.agent?.id
          const tag = args.threadTag
            ? String(args.threadTag).trim().toLowerCase().replace(/^\[?dsh-?/i, '').replace(/\]$/, '')
            : (tagForSession(sessionId) ?? tagForOutgoing(args.inReplyTo) ?? undefined)
          const messageId = newMessageId(account.address)
          const references = messageIdsIn(args.inReplyTo)
          const subject = tag ? tagSubject(args.subject, tag, liveConfig.tagPrefix) : args.subject

          try {
            const result = await sendMail(account, {
              to: args.to,
              cc: args.cc,
              subject,
              text: args.text,
              html: args.html,
              messageId,
              inReplyTo: args.inReplyTo,
              references,
              tag,
            })
            if (tag) recordOutgoing(messageId, tag)
            log({
              kind: 'send',
              account: account.id,
              to: args.to,
              cc: args.cc ?? null,
              subject,
              ok: true,
              messageId,
              tag: tag ?? null,
              inReplyTo: args.inReplyTo ?? null,
              sessionId: sessionId ?? null,
            })
            return { ok: true, ...result, account: account.address, tag: tag ?? null, inReplyTo: args.inReplyTo ?? null }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            log({ kind: 'send', account: account.id, to: args.to, subject, ok: false, error: message, tag: tag ?? null })
            return { ok: false, error: message }
          }
        },
      }), 'smart-mail: send_email tool')

      ctx.effect(() => ctx.tools.register({
        name: 'read_emails',
        description:
          'Read recent emails from a configured dsh-smart-mail account over IMAP (headers plus short body previews). ' +
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
          const picked = pickAccount(args.account)
          if (picked.error) return { ok: false, error: picked.error }
          const account = picked.account
          if (!account) {
            return { ok: false, error: `account not found: ${args.account}`, accounts: picked.accounts.map((a) => ({ id: a.id, label: a.label, address: a.address })) }
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

    /**
     * Background poller.
     *
     * `ctx.effect(execute)` calls `execute()` and keeps *its return value* as the
     * cleanup. Passing `applyPoller()` — which already returns a cleanup — made
     * cordis invoke that cleanup immediately: it set `disposed = true` and
     * cleared the timer it had just created, so the poller never ran and only
     * the manual `/poll-now` route worked. The factory is therefore passed as the
     * execute function, not its result.
     */
    const startPoller = () => {
      let disposed = false
      let busy = false
      let timer = null
      let firstCheck = null
      let periodSec = 0

      const tick = async () => {
        if (disposed || busy) return
        // A disabled poller keeps its timer but does no work, so re-enabling it
        // from the panel takes effect on the next beat without a restart.
        if (!liveConfig.enabled) return
        busy = true
        try {
          for (const account of listAccounts()) {
            try {
              await pollAccount(ctx, account, liveConfig, log)
            } catch (error) {
              log({
                kind: 'poll-error',
                account: account.id,
                error: error instanceof Error ? error.message : String(error),
              })
            }
          }
        } finally {
          // Always release the guard: a throw above must not wedge the poller.
          busy = false
        }
      }

      /** (Re)create the interval for the current period. */
      const schedule = () => {
        if (timer !== null) clearInterval(timer)
        periodSec = liveConfig.pollIntervalSec
        timer = setInterval(() => { void tick() }, periodSec * 1000)
        timer.unref?.()
      }

      schedule()
      firstCheck = setTimeout(() => { void tick() }, 8000) // first check shortly after boot
      firstCheck.unref?.()

      return {
        /** Apply a changed interval without waiting for a restart. */
        rearm() {
          if (disposed) return
          if (liveConfig.pollIntervalSec === periodSec) return
          log({ kind: 'poller-rearm', fromSec: periodSec, toSec: liveConfig.pollIntervalSec })
          schedule()
        },
        dispose() {
          disposed = true
          if (timer !== null) clearInterval(timer)
          if (firstCheck !== null) clearTimeout(firstCheck)
        },
      }
    }

    /** Handle to the running poller, so the panel can re-arm it. */
    let poller = null

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
              json(res, 200, {
                ok: true,
                version: PLUGIN_VERSION,
                config: liveConfig,
                presets: PRESETS,
                accounts,
                log: readLog(60),
                logHealth: logStats(rotationOf(liveConfig)),
              })
              return
            }
            if (route === '/threads' && req.method === 'GET') {
              const threads = loadThreads()
              json(res, 200, {
                ok: true,
                count: Object.keys(threads.byTag).length,
                outgoingCount: Object.keys(threads.outgoing).length,
                threads: Object.entries(threads.byTag)
                  .sort((a, b) => (b[1]?.updatedAt ?? 0) - (a[1]?.updatedAt ?? 0))
                  .slice(0, 50)
                  .map(([tag, record]) => ({ tag, ...record })),
              })
              return
            }
            if (route === '/models' && req.method === 'GET') {
              // The same catalog the session page renders, so the panel offers
              // exactly the models a conversation could actually run.
              const catalog = await readCatalog(ctx)
              json(res, 200, {
                ok: catalog !== null,
                ...(catalog === null ? { error: 'model catalog unavailable on this Host' } : {
                  default: catalog.default ?? null,
                  groups: catalog.groups ?? [],
                  failures: catalog.failures ?? [],
                  configured: liveConfig.modelSelection,
                }),
              })
              return
            }
            if (route === '/thread-model' && req.method === 'POST') {
              const body = await readBody(req)
              const tag = String(body.tag ?? '').trim().toLowerCase()
              if (tag === '') { json(res, 400, { ok: false, error: 'missing tag' }); return }
              const selection = body.selection === null || body.selection === undefined
                ? null
                : {
                  provider: String(body.selection.provider ?? ''),
                  model: String(body.selection.model ?? ''),
                  ...(body.selection.reasoningEffort === undefined ? {} : { reasoningEffort: String(body.selection.reasoningEffort) }),
                }
              if (selection !== null && (!selection.provider || !selection.model)) {
                json(res, 400, { ok: false, error: 'selection needs provider and model' })
                return
              }
              const result = setThreadModel(tag, selection)
              if (!result.ok) { json(res, 404, result); return }
              log({ kind: 'thread-model', tag, modelSelection: result.modelSelection })
              json(res, 200, result)
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
              const before = { ...liveConfig }
              liveConfig = normalizeConfig({
                ...liveConfig,
                ...(body.enabled !== undefined ? { enabled: Boolean(body.enabled) } : {}),
                ...(body.pollIntervalSec !== undefined ? { pollIntervalSec: body.pollIntervalSec } : {}),
                ...(Array.isArray(body.allowFrom) ? { allowFrom: body.allowFrom.map(String) } : {}),
                ...(body.model !== undefined ? { model: String(body.model) } : {}),
                ...(body.wakePrompt !== undefined ? { wakePrompt: String(body.wakePrompt) } : {}),
                ...(body.wakeCwd !== undefined ? { wakeCwd: String(body.wakeCwd) } : {}),
                ...(body.tagPrefix !== undefined ? { tagPrefix: String(body.tagPrefix) } : {}),
                ...(body.interruptSameThread !== undefined ? { interruptSameThread: Boolean(body.interruptSameThread) } : {}),
                ...(body.continueThreads !== undefined ? { continueThreads: Boolean(body.continueThreads) } : {}),
                ...(body.autoUnarchive !== undefined ? { autoUnarchive: Boolean(body.autoUnarchive) } : {}),
                ...(body.modelSelection !== undefined ? { modelSelection: body.modelSelection } : {}),
                ...(body.logMaxBytes !== undefined ? { logMaxBytes: body.logMaxBytes } : {}),
                ...(body.logKeepDays !== undefined ? { logKeepDays: body.logKeepDays } : {}),
                ...(body.logKeepFiles !== undefined ? { logKeepFiles: body.logKeepFiles } : {}),
              })
              const changedNow = configDiff(before, liveConfig) ?? []
              // A rotation-policy change applies to the existing file at once,
              // before this call's own record is written under the new limit.
              const rotationChanged = changedNow.some((field) => field.startsWith('log'))
              if (rotationChanged) applyRotationNow('config-panel')
              // A new interval must take effect now, not at the next restart.
              if (changedNow.includes('pollIntervalSec')) poller?.rearm()
              if (changedNow.length > 0) {
                log({
                  kind: 'config-change',
                  reason: 'panel',
                  changedFields: changedNow,
                  before,
                  after: liveConfig,
                })
                saveLastConfig(liveConfig)
              }
              // Write it back to the profile, or the change dies with this process.
              let persisted = { ok: true }
              if (changedNow.length > 0) {
                persisted = await persistConfig(ctx, liveConfig)
                log({
                  kind: 'config-persist',
                  ok: persisted.ok,
                  ...(persisted.ok ? {} : { error: persisted.error }),
                  fields: changedNow,
                })
              }
              json(res, 200, {
                ok: true,
                config: liveConfig,
                changedFields: changedNow,
                persisted: persisted.ok,
                ...(persisted.ok ? {} : { persistError: persisted.error }),
              })
              return
            }
            if (route === '/poll-now' && req.method === 'POST') {
              const results = []
              for (const account of listAccounts()) {
                try {
                  results.push({ account: account.id, ...(await pollAccount(ctx, account, liveConfig, log)) })
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
    // Pass the factory, not its result: ctx.effect calls `execute()` and keeps
    // the return value as the cleanup.
    ctx.effect(() => {
      poller = startPoller()
      return () => poller?.dispose()
    }, 'smart-mail: poller')
    applyRoutes()
  },
}

export default plugin
export { PRESETS, ROUTE, LOG_ROTATION }
