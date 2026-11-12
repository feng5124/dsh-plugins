/**
 * dsh-smart-mail - mail hosting (host side).
 *
 * Wires the pure logic in `hosting.mjs` to a live Host:
 *   1. shadow `ask_user_question` so a hosted question becomes an email;
 *   2. render + send that mail, persist the ticket;
 *   3. wait up to `waitMs` for a reply (in-time) or let the platform record a
 *      pending question that a late reply can still answer;
 *   4. when a reply arrives (routed here by the poller), parse the answers and
 *      feed them back with `userQuestions.answer(agent, callId, batch)`.
 *
 * Why shadowing instead of the `user-questions/request` waterfall
 * (2026-11-11, six live attempts):
 *   `userQuestions.ask()` dispatches on `scopeTarget(agent, agent)`, and
 *   `@deepseek-ai/dsh-api-remotes` already listens on that event to forward it
 *   to the Web client, whose `answerQuestion` claims the request and never
 *   calls `next()`. A plugin-level listener - even with `{ global: true,
 *   prepend: true }`, verified to sit first in the hook list - is never
 *   reached. The community-blessed route (omdsh-dev/dsh-better-ask-user) is to
 *   shadow the tool itself: read the registered definition with
 *   `tools.get('ask_user_question', agent)` and re-register the same name with
 *   our own `execute`. That is official tool shadowing and does not depend on
 *   event ordering. The waterfall listener is kept as a best-effort fallback.
 *
 * Platform facts this file depends on (`@deepseek-ai/dsh-user-questions`):
 *   - returning an answer batch claims the request; `{pending: true, callId}`
 *     is the shape that keeps a timed-out question answerable later;
 *   - `answer()` requires the exact live agent and one answer per question
 *     (BAD_ANSWER otherwise), which is why `parseAnswerReply` always returns a
 *     batch as long as the question list.
 */

import {
  HostedStatus,
  isAnswerable,
  isCancelReply,
  parseAnswerReply,
  renderQuestionMail,
  renderResultMail,
  ticketFor,
  ticketFromReply,
} from './hosting.mjs'
import {
  bindThread,
  getAccount,
  getTicket,
  isMailWoken,
  listAccounts,
  listTickets,
  putTicket,
  recordOutgoing,
  tagForSession,
  ticketForHostedMessage,
} from './store.mjs'
import { sendMail } from './smtp.mjs'
import { newMessageId, newTag, tagSubject } from './threads.mjs'

/** Error code the platform maps onto a pending (still answerable) question. */
const ASK_TIMED_OUT = 'ASK_TIMED_OUT'

/** Same shape as the platform error: only `code` is inspected upstream. */
class HostedTimeout extends Error {
  constructor(message) {
    super(message)
    this.name = 'UserQuestionError'
    this.code = ASK_TIMED_OUT
  }
}

function errorText(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Add the `timeout` parameter to a cloned schema (the "timed" marker).
 *
 * 这是**晚到回信能不能回灌**的开关，不是可选装饰（2026-11-11 从 projection 取证）：
 *   `@deepseek-ai/dsh-user-questions` 的 fold 在 `request/header` 时判定
 *   `timed = tools.some(t => t.name === 'ask_user_question'
 *                          && 'timeout' in t.parameters.properties)`；
 *   `fold.timed === false` 时 `tool/call` 分支**直接 return fold** —— 这次提问
 *   根本不会登记进 projection 的 active 列表，于是 `answer()` 永远找不到它、
 *   返回 false，用户第二天回的那封信只能"暂存"，永远投不进去。
 *
 * 默认部署跑 legacy 模式，schema 里没有 timeout；我们遮蔽工具时继承的正是这份
 * legacy 定义，所以必须自己补上这个键，否则「超时后仍可回复」是假的。
 *
 * 只加 schema 键、不改行为：实际等待时长由 `hosting.waitMs` 决定，参数说明也
 * 明确告诉模型"不用传"。
 *
 * @param {{parameters?: object}} base 原工具定义
 * @returns {object|undefined} 参数表的副本（不修改入参）
 */
export function parametersWithTimedMarker(base) {
  let parameters
  try {
    parameters = structuredClone(base?.parameters)
  } catch {
    return base?.parameters
  }
  if (parameters === null || typeof parameters !== 'object') return base?.parameters
  if (parameters.properties === null || typeof parameters.properties !== 'object') {
    parameters.properties = {}
  }
  if (parameters.properties.timeout === undefined) {
    parameters.properties.timeout = {
      type: 'integer',
      description: '无需传；由插件设置决定前台等待时长。此参数存在本身用于把本次提问标记为可续答（超时后仍能用回信作答）。',
    }
  }
  return parameters
}

/**
 * 把原工具的 output schema 扩成 `oneOf: [pending, 原分支...]`。
 *
 * 为什么必须扩（2026-11-11 定位到最后一层根因）：
 *   平台投影 `isPendingResult()` 判定"问题是否可续答"**只认结果文本顶层
 *   `pending === true`**：
 *     `return typeof parsed === 'object' && parsed.pending === true`
 *   于是有两个条件同时成立才行：
 *     ① 工具真的返回 `{pending:true, callId, message}`；
 *     ② 输出 schema 允许这个形状，否则校验先报
 *        'missing required property "value.answers"' 把结果打回。
 *
 *   之前我试过 oneOf 但被拒：`unsupported JSON schema: schema.oneOf[1]...`。
 *   根因是写法不合规——我把 `required: true` 塞进了 **property 内部**。平台自己的
 *   timed 定义是 `properties:{pending:{type:'boolean',enum:[true]}}` +
 *   **schema 级 `required:['pending']`**。照它写就通过。
 */
export function outputWithPending(base) {
  const output = base?.output
  if (output === undefined || output === null) return output
  let existing
  try {
    existing = structuredClone(output.schema)
  } catch {
    return output
  }
  if (existing === undefined || existing === null) return output
  const branches = Array.isArray(existing.oneOf) ? existing.oneOf : [existing]
  // 部署跑的就是 timed 模式：已经含 pending 分支，原样保留。
  if (branches.some((branch) => branch?.required?.includes?.('pending'))) return output
  return {
    ...output,
    schema: {
      oneOf: [
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            pending: { type: 'boolean', enum: [true] },
            callId: { type: 'string' },
            message: { type: 'string' },
          },
          // required 必须在 schema 级（平台 timed 定义同款），放进 property 会被拒
          required: ['pending', 'callId', 'message'],
        },
        ...branches,
      ],
    },
  }
}

/**
 * One in-flight question waiting for its answer.
 *
 * A reply resolves it; the wait deadline rejects it. `settled` guarantees a
 * reply that arrives after the deadline never resolves an abandoned promise -
 * that case goes through `deliverLateAnswer` instead.
 */
class Waiter {
  constructor(ticket, waitMs) {
    this.ticket = ticket
    this.settled = false
    this.promise = new Promise((resolve, reject) => {
      this._resolve = resolve
      this._reject = reject
    })
    this.timer = setTimeout(() => {
      if (this.settled) return
      this.settled = true
      this._reject(new HostedTimeout('ask_user_question timed out before the user answered by mail'))
    }, Math.max(1, waitMs))
    // A parked timer must never keep the Host process alive.
    this.timer.unref?.()
  }

  resolve(batch) {
    if (this.settled) return false
    this.settled = true
    clearTimeout(this.timer)
    this._resolve(batch)
    return true
  }

  dispose() {
    this.settled = true
    clearTimeout(this.timer)
  }
}

/**
 * Create the mail-hosted question bridge.
 *
 * @param {object} deps
 * @param {object} deps.ctx Host context
 * @param {() => object} deps.config live config reader
 * @param {(record: object) => void} deps.log activity log
 * @param {(sessionId: string) => Promise<{ok: boolean, title?: string, agent?: object}>} deps.sessionInfo
 *   session title plus the live agent (late answers need the instance)
 * @returns {{install: Function, deliverReply: Function, flushParked: Function, parked: Function, running: Function}}
 */
export function createHosting({ ctx, config, log, sessionInfo }) {
  /** ticket -> Waiter, only for questions currently in a foreground wait. */
  const waiters = new Map()
  /** Answers that arrived while their session had no live agent. */
  const lateAnswers = new Map()
  /** 每会话最近一次"结果邮件"的指纹，用于去重（见 notifyTurnResult）。 */
  const lastNotified = new Map()
  /** 每会话当前这一轮已产生的助手文本（turn/end 时取最后一条）。 */
  const turnBuffers = new Map()
  let disposed = false

  const cfgNow = () => config()

  /**
   * Extract a session id from whatever the caller handed us.
   *
   * `agent.session` is a Session *object* on some Host versions, not a string.
   * Using it directly as an object key silently misses the per-session override
   * and falls through to `defaultEnabled: false` - which looks exactly like
   * "hosting does nothing" (2026-11-11). Accept every plausible shape and only
   * return a non-empty string.
   */
  function sessionIdOf(agent) {
    if (agent === undefined || agent === null) return undefined
    const candidates = [
      agent.session,
      agent.sessionId,
      agent.id,
      agent.session?.id,
      agent.session?.sessionId,
    ]
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate !== '') return candidate
    }
    return undefined
  }

  /**
   * 托管对某个会话是否生效（提问与"结果通知"共用同一套判定）。
   *
   * Precedence: explicit per-session override > mail-woken session (default on)
   * > global `defaultEnabled`. A global `enabled: false` vetoes everything.
   *
   * @param {string} sessionId
   * @param {'ask'|'result'} purpose 只影响返回的 reason 文案，判定完全同源
   */
  function hostingStateFor(sessionId, purpose = 'ask') {
    const cfg = cfgNow()
    if (cfg.hosting?.enabled === false) return { ok: false, reason: 'disabled-globally', cfg }
    if (typeof sessionId !== 'string' || sessionId === '') return { ok: false, reason: 'no-session', cfg }
    const override = cfg.hosting?.sessions?.[sessionId]
    const mailWoken = isMailWoken(sessionId)
    const effective = override === undefined
      ? (mailWoken ? true : cfg.hosting?.defaultEnabled === true)
      : override === true
    if (!effective) {
      return { ok: false, reason: mailWoken ? 'disabled-for-session' : 'not-enabled-for-session', cfg, mailWoken }
    }
    // 结果通知另有开关：托管开着也不代表用户想收完成邮件。
    if (purpose === 'result' && cfg.hosting?.notifyResult !== true) {
      return { ok: false, reason: 'result-notify-off', cfg, mailWoken }
    }
    return { ok: true, cfg, mailWoken, override }
  }

  function shouldHost(request) {
    const sessionId = sessionIdOf(request?.agent) ?? request?.sessionId
    const state = hostingStateFor(sessionId, 'ask')
    if (!state.ok) return { host: false, reason: state.reason, sessionId, mailWoken: state.mailWoken }

    const cfg = state.cfg
    const account = pickAccount(cfg)
    if (account === null) return { host: false, reason: 'no-usable-account', sessionId }
    const owner = pickOwner(cfg)
    if (owner === null) return { host: false, reason: 'no-owner-address', sessionId }
    return { host: true, sessionId, account, owner }
  }

  function pickAccount(cfg) {
    const wanted = cfg.hosting?.account
    if (typeof wanted === 'string' && wanted !== '') {
      const found = getAccount(wanted)
      if (found !== undefined) return found
      const byLabel = listAccounts().find((item) => item.label === wanted)
      if (byLabel !== undefined) return byLabel
    }
    const accounts = listAccounts()
    return accounts.length === 1 ? accounts[0] : (accounts[0] ?? null)
  }

  /**
   * Recipient: the first allowlisted address, i.e. the user's own mailbox.
   *
   * Never `accounts[].address`: that is our sending identity, not the user
   * (the user corrected this explicitly on 2026-11-11).
   */
  function pickOwner(cfg) {
    const explicit = cfg.hosting?.owner
    if (typeof explicit === 'string' && explicit.trim() !== '') return explicit.trim()
    const first = (cfg.allowFrom ?? []).map(String).find((address) => address.trim() !== '')
    return first?.trim() ?? null
  }

  /**
   * Email one question batch and wait for the reply.
   *
   * Shared by both entry points (tool shadow and waterfall listener). Returns
   * the answer batch, or `undefined` when hosting does not apply so the caller
   * can fall back to the built-in prompt.
   *
   * @returns {Promise<{batch?: object, handled: boolean}>}
   */
  async function hostQuestion({ questions, callId, decision, signal }) {
    const ticket = ticketFor(callId)
    const cfg = cfgNow()
    const waitMs = Math.max(0, Number(cfg.hosting?.waitMs ?? 60_000))
    const info = await sessionInfo(decision.sessionId).catch(() => ({ ok: false }))

    const { subject, text } = renderQuestionMail({
      ticket,
      questions,
      sessionTitle: info?.title,
      sessionId: decision.sessionId,
      waitSeconds: Math.round(waitMs / 1000),
      tagPrefix: cfg.tagPrefix,
    })

    const messageId = newMessageId(decision.account.address)
    const waiter = new Waiter(ticket, waitMs)
    waiters.set(ticket, waiter)
    putTicket(ticket, {
      callId,
      sessionId: decision.sessionId,
      sessionTitle: info?.title ?? null,
      questions: questions ?? [],
      status: HostedStatus.waiting,
      messageId,
      subject,
      waitMs,
      owner: decision.owner,
      account: decision.account.id,
      answers: undefined,
      error: undefined,
    })

    try {
      await sendMail(decision.account, {
        to: decision.owner,
        subject,
        text,
        messageId,
        references: [],
        tag: null,
      })
      log({ kind: 'hosting', ok: true, stage: 'asked', ticket, callId, sessionId: decision.sessionId, to: decision.owner, subject, messageId, waitMs })
    } catch (error) {
      waiter.dispose()
      waiters.delete(ticket)
      putTicket(ticket, { status: HostedStatus.failed, error: errorText(error) })
      log({ kind: 'hosting', ok: false, stage: 'ask', ticket, callId, error: errorText(error) })
      // Sending failed: fall back to the built-in prompt rather than wedging.
      return { handled: false, reason: 'send-failed' }
    }

    if (signal?.aborted === true) {
      waiter.dispose()
      waiters.delete(ticket)
      putTicket(ticket, { status: HostedStatus.cancelled, error: 'caller aborted' })
      log({ kind: 'hosting', ok: false, stage: 'aborted', ticket, callId })
      throw signal.reason instanceof Error ? signal.reason : new Error('ask_user_question aborted')
    }

    try {
      const batch = await waiter.promise
      waiters.delete(ticket)
      putTicket(ticket, { status: HostedStatus.answered, answers: batch.answers, deliveredVia: 'in-time' })
      log({ kind: 'hosting', ok: true, stage: 'answered-in-time', ticket, callId })
      return { handled: true, batch }
    } catch (error) {
      waiters.delete(ticket)
      if (error instanceof HostedTimeout) {
        // The ticket stays answerable: a late reply goes through answer().
        putTicket(ticket, { status: HostedStatus.expired, expiredAt: Date.now() })
        log({ kind: 'hosting', ok: true, stage: 'expired', ticket, callId, waitMs })
      } else {
        putTicket(ticket, { status: HostedStatus.failed, error: errorText(error) })
        log({ kind: 'hosting', ok: false, stage: 'wait', ticket, callId, error: errorText(error) })
      }
      throw error
    }
  }

  /**
   * Tool-shadow entry: mirror the platform's timed path but email the question.
   *
   * The base tool's own `execute` stays available for the not-hosted case, so
   * a session without hosting behaves exactly like the stock tool.
   */
  async function executeShadowed({ args, exec, base, decision }) {
    const callId = exec?.callId
    log({ kind: 'hosting-enter', via: 'tool-shadow', callId: callId ?? null, sessionId: decision.sessionId })
    if (typeof callId !== 'string' || callId === '') return base.execute(args, exec)
    const result = await hostQuestion({
      questions: args?.questions ?? [],
      callId,
      decision,
      signal: exec?.signal,
    }).catch((error) => {
      // 只有"等到超时"才转成挂起语义；其它错误必须如实抛出，
      // 不能伪装成"没人回答"（那会让模型误以为用户跳过了问题）。
      if (error instanceof HostedTimeout) return { handled: true, pending: true, callId }
      throw error
    })
    if (result?.pending === true) {
      // 必须返回**真正的 pending 形状**：平台投影只认顶层 pending===true 才会把
      // 这个问题登记为"可续答"，否则用户日后回信时 answer() 返回 false，
      // 答案永远投不进去（2026-11-11 实证：用 answers 形状伪装挂起 → 全部失败）。
      log({ kind: 'hosting', ok: true, stage: 'pending', ticket: ticketFor(callId) })
      return {
        pending: true,
        callId: result.callId ?? callId,
        message: 'No answer arrived before the timeout. This is pending, not a skipped answer: the question is still answerable, and a reply by mail will be delivered as answer_to_pending_question. Continue other useful work and do not treat this as permission.',
      }
    }
    if (result?.batch !== undefined) return result.batch
    // Not hosted after all (send failed): let the stock tool ask in-app.
    return base.execute(args, exec)
  }

  /**
   * Waterfall listener (fallback path).
   *
   * Kept because it is the documented seam, and it costs nothing to try: if a
   * Host ever reaches plugin-level listeners, hosting works without shadowing.
   */
  async function answerByMail(request, next) {
    const decision = shouldHost(request)
    if (!decision.host) return next()
    const callId = request?.wait?.callId ?? request?.callId
    if (typeof callId !== 'string' || callId === '') return next()
    const result = await hostQuestion({
      questions: request?.questions ?? [],
      callId,
      decision,
      signal: request?.signal,
    }).catch((error) => {
      if (error instanceof HostedTimeout) return { handled: true, pending: true, callId }
      throw error
    })
    if (result?.pending === true) return { pending: true, callId: result.callId }
    if (result?.batch !== undefined) return result.batch
    return next()
  }

  /**
   * Route one inbound mail: recognise the ticket, parse, deliver.
   *
   * `{handled: true}` means "this was an answer, not ordinary mail" - the
   * poller must not also wake the session with it, or the session receives two
   * contradictory instructions.
   */
  async function deliverReply(mail) {
    const references = Array.isArray(mail.references) && mail.references.length > 0
      ? mail.references
      : [mail.inReplyTo].filter((id) => typeof id === 'string' && id !== '')
    const ticket = ticketFromReply({
      subject: mail.subject,
      text: mail.text,
      references,
      ticketForMessageId: ticketForHostedMessage,
    })
    if (ticket === undefined) return { handled: false, reason: 'not-a-hosted-reply' }

    const record = getTicket(ticket)
    if (record === undefined) {
      log({ kind: 'hosting', ok: false, stage: 'reply', ticket, error: 'unknown ticket' })
      return { handled: false, ticket, reason: 'unknown-ticket' }
    }
    if (!isAnswerable(record.status)) {
      log({ kind: 'hosting', ok: false, stage: 'reply', ticket, error: `question is ${record.status}` })
      return { handled: true, ticket, reason: `not-answerable:${record.status}` }
    }

    if (isCancelReply(mail.text ?? '')) {
      putTicket(ticket, { status: HostedStatus.cancelled, cancelledAt: Date.now(), deliveredVia: 'cancelled' })
      const waiter = waiters.get(ticket)
      if (waiter !== undefined) {
        waiter.dispose()
        waiters.delete(ticket)
      }
      log({ kind: 'hosting', ok: true, stage: 'cancelled', ticket })
      return { handled: true, ticket, reason: 'cancelled' }
    }

    const parsed = parseAnswerReply(mail.text ?? '', record.questions ?? [])
    putTicket(ticket, {
      answers: parsed.answers,
      answeredCount: parsed.answeredCount,
      skipped: parsed.skipped,
      answerSubject: mail.subject,
      answerMessageId: mail.messageId,
    })

    const waiter = waiters.get(ticket)
    if (waiter !== undefined && waiter.resolve({ answers: parsed.answers })) {
      log({ kind: 'hosting', ok: true, stage: 'answered', ticket, answeredCount: parsed.answeredCount, via: 'in-time' })
      return { handled: true, ticket, delivered: 'in-time' }
    }

    const late = await deliverLateAnswer(record, ticket, parsed)
    return { handled: true, ticket, delivered: late.ok ? 'late' : `failed:${late.error}` }
  }

  /**
   * Feed answers to a question whose foreground wait already ended.
   *
   * `answer()` needs the live agent; when the session is archived, not running,
   * or the Host restarted, the answers are parked and retried - never dropped.
   */
  async function deliverLateAnswer(record, ticket, parsed) {
    const service = ctx.get('userQuestions')
    if (service === undefined || typeof service.answer !== 'function') {
      lateAnswers.set(ticket, { answers: parsed.answers, at: Date.now() })
      log({ kind: 'hosting', ok: false, stage: 'late-answer', ticket, error: 'userQuestions unavailable; parked' })
      return { ok: false, error: 'service-unavailable' }
    }
    const info = await sessionInfo(record.sessionId).catch(() => ({ ok: false }))
    const agent = info?.agent
    if (agent === undefined || agent === null) {
      lateAnswers.set(ticket, { answers: parsed.answers, at: Date.now() })
      log({ kind: 'hosting', ok: false, stage: 'late-answer', ticket, error: 'no live agent; parked', sessionId: record.sessionId })
      return { ok: false, error: 'no-live-agent' }
    }
    try {
      const accepted = service.answer(agent, record.callId, { answers: parsed.answers })
      if (accepted === false) {
        lateAnswers.set(ticket, { answers: parsed.answers, at: Date.now() })
        log({ kind: 'hosting', ok: false, stage: 'late-answer', ticket, error: 'not pending on the platform', sessionId: record.sessionId })
        return { ok: false, error: 'not-pending' }
      }
      putTicket(ticket, { status: HostedStatus.answered, answeredAt: Date.now(), deliveredVia: 'late' })
      log({ kind: 'hosting', ok: true, stage: 'late-answer', ticket, sessionId: record.sessionId })
      return { ok: true }
    } catch (error) {
      lateAnswers.set(ticket, { answers: parsed.answers, at: Date.now() })
      log({ kind: 'hosting', ok: false, stage: 'late-answer', ticket, error: errorText(error), sessionId: record.sessionId })
      return { ok: false, error: errorText(error) }
    }
  }

  /** Retry answers that were parked because their session had no live agent. */
  async function flushParked(sessionId) {
    const entries = [...lateAnswers.entries()]
    if (entries.length === 0) return { ok: true, flushed: 0 }
    let flushed = 0
    for (const [ticket, parked] of entries) {
      const record = getTicket(ticket)
      if (record === undefined || record.sessionId !== sessionId) continue
      const parsed = {
        answers: parked.answers,
        answeredCount: parked.answers.filter((answer) => answer.selected.length > 0 || answer.custom !== undefined).length,
        skipped: 0,
      }
      const result = await deliverLateAnswer(record, ticket, parsed)
      if (result.ok) {
        lateAnswers.delete(ticket)
        flushed += 1
      }
    }
    return { ok: true, flushed }
  }

  /**
   * Shadow `ask_user_question` for every agent.
   *
   * Reads the registered definition and re-registers the same name with our
   * `execute`, preserving parameters/output so the model sees one schema.
   */
  function shadowAskTool() {
    const tools = ctx.get('tools')
    if (tools === undefined || typeof tools.register !== 'function' || typeof tools.get !== 'function') {
      log({ kind: 'hosting-shadow', ok: false, error: 'tools service unavailable' })
      return () => {}
    }
    const disposers = new Map()

    const mountFor = (agent) => {
      if (agent === undefined || agent === null || disposers.has(agent)) return
      let base
      try {
        base = tools.get('ask_user_question', agent)
      } catch {
        base = undefined
      }
      if (base === undefined) return
      // 必须通过 `agent.ctx` 注册（第一次尝试在插件根 ctx 上 register 直接被拒：
      // 'tool "ask_user_question" is already registered (for a per-agent variant,
      //  register through that agent's `agent.ctx` instead)'）。错误信息本身就
      // 指明了正确做法：同名覆盖是**按 agent 作用域**的，所以要在该 agent 的
      // 上下文里注册，才能遮蔽它自己那份定义。这也正是社区插件的做法。
      const toolsCtx = agent.ctx?.get?.('tools') ?? tools
      if (toolsCtx === undefined || typeof toolsCtx.register !== 'function') return
      try {
        const dispose = toolsCtx.register({
          ...base,
          // 让 projection 把本次提问登记为"可续答"（见 parametersWithTimedMarker 注释）
          parameters: parametersWithTimedMarker(base),
          // 让"超时挂起"的返回值能通过校验（见 outputWithPending 注释）
          output: outputWithPending(base),
          async execute(args, exec) {
            const decision = shouldHost({
              agent: exec?.agent ?? agent,
              wait: { callId: exec?.callId },
              questions: args?.questions,
            })
            // 判定结果必须留痕：否则"没发邮件"和"根本没走到这层"在日志里
            // 完全一样，只能靠猜（2026-11-11 为此空跑了六轮）。
            log({
              kind: 'hosting-check',
              via: 'tool-shadow',
              host: decision.host,
              reason: decision.reason ?? null,
              sessionId: decision.sessionId ?? null,
              sessionType: typeof (exec?.agent ?? agent)?.session,
              hasAgent: (exec?.agent ?? agent) !== undefined,
            })
            if (!decision.host) return base.execute(args, exec)
            return executeShadowed({ args, exec, base, decision })
          },
        })
        disposers.set(agent, typeof dispose === 'function' ? dispose : () => {})
        log({ kind: 'hosting-shadow', ok: true, agentId: agent.id ?? null })
      } catch (error) {
        log({ kind: 'hosting-shadow', ok: false, agentId: agent?.id ?? null, error: errorText(error) })
      }
    }

    const unmountFor = (agent) => {
      const dispose = disposers.get(agent)
      if (dispose === undefined) return
      try { dispose() } catch { /* teardown must not throw */ }
      disposers.delete(agent)
    }

    const offs = []
    try {
      offs.push(ctx.on('agent/created', ({ agent }) => mountFor(agent)))
      offs.push(ctx.on('agent/disposed', ({ agent }) => unmountFor(agent)))
      for (const agent of ctx.get('agents')?.list?.() ?? []) mountFor(agent)
    } catch (error) {
      log({ kind: 'hosting-shadow', ok: false, error: errorText(error) })
    }

    return () => {
      for (const off of offs) {
        try { off?.() } catch { /* teardown must not throw */ }
      }
      for (const agent of [...disposers.keys()]) unmountFor(agent)
    }
  }

  /**
   * 探测一台提问单在平台上是否**仍然可答**。
   *
   * 为什么需要（2026-11-11 用户指出"显示 4 个待答"）：插件的 `expired` 只表示
   * "我们的前台等待结束了"，不等于"平台仍然收得下答案"。平台侧的真相在
   * `userQuestions.continued(agent)` —— 它列出投影里 `state === 'continued'`
   * 的调用。timed 标记修好之前发出的提问**从来没被登记**，那些提问单永远
   * 投不进去，却仍以 `expired` 出现在面板"等待你回信"里，造成"4 个待答"
   * 这种假象。
   *
   * @returns {'answerable'|'not-answerable'|'no-agent'|'unavailable'}
   */
  function probeAnswerable(record) {
    const service = ctx.get('userQuestions')
    if (service === undefined || typeof service.continued !== 'function') return 'unavailable'
    let agent = null
    try {
      agent = ctx.get('agents')?.get?.(record.sessionId) ?? null
    } catch {
      agent = null
    }
    if (agent === null || agent === undefined) return 'no-agent'
    try {
      const list = service.continued(agent) ?? []
      return list.some((item) => item?.callId === record.callId) ? 'answerable' : 'not-answerable'
    } catch {
      return 'unavailable'
    }
  }

  /**
   * 把平台已经不再接受的提问单标成 `stale`，让面板不再把它们算作"待答"。
   *
   * @returns {{checked: number, staled: number}}
   */
  function pruneStaleTickets() {
    if (disposed) return { checked: 0, staled: 0 }
    let checked = 0
    let staled = 0
    for (const record of listTickets()) {
      if (record?.status !== HostedStatus.expired) continue
      checked += 1
      const verdict = probeAnswerable(record)
      // 只在平台明确说"不再可答"时才动它；服务或 agent 不可用时保持原状，
      // 宁可多显示一条，也不要误标用户还能回答的问题。
      if (verdict !== 'not-answerable') continue
      putTicket(record.ticket, {
        status: HostedStatus.stale,
        staleAt: Date.now(),
        staleReason: 'platform no longer accepts answers for this call',
      })
      staled += 1
    }
    if (staled > 0) log({ kind: 'hosting-prune', ok: true, checked, staled })
    return { checked, staled }
  }

  /**
   * 一轮结束后，把结果作为邮件发给用户。
   *
   * 触发点：`session/event` 里的 `turn/end`（平台已知事件类型，见
   * `@deepseek-ai/dsh-session/known-event-types`）。
   *
   * 去重与降噪是本函数的主要难点：
   *   - 邮件唤醒的会话**每收到一封邮件就会 turn/end 一次**，如果每轮都发结果，
   *     用户会被自己的来信循环轰炸。所以用 `lastNotified` 记"每个会话最近一次
   *     通知的 turn + 内容指纹"，内容没变就不重复发。
   *   - 只发**有正文**的结果；纯工具轮、空回复直接跳过。
   *   - 单独 try/catch：通知失败绝不能影响会话本身。
   */
  async function notifyTurnResult(sessionId, turn, summary) {
    const state = hostingStateFor(sessionId, 'result')
    if (!state.ok) return { ok: false, reason: state.reason }

    const text = String(summary ?? '').trim()
    if (text === '') return { ok: false, reason: 'empty-result' }

    // 去重：同一会话、同样的内容，不重复发（轮次不同但内容相同也算重复）。
    const fingerprint = `${text.length}:${text.slice(0, 80)}`
    const previous = lastNotified.get(sessionId)
    if (previous !== undefined && previous.fingerprint === fingerprint) {
      return { ok: false, reason: 'duplicate' }
    }

    const cfg = state.cfg
    const account = pickAccount(cfg)
    const owner = pickOwner(cfg)
    if (account === null || owner === null) return { ok: false, reason: 'no-account-or-owner' }

    const info = await sessionInfo(sessionId).catch(() => ({ ok: false }))
    const mail = renderResultMail({
      sessionTitle: info?.title,
      sessionId,
      summary: text,
      turn,
      maxChars: cfg.hosting?.resultMaxChars ?? 4000,
    })

    try {
      const messageId = newMessageId(account.address)
      // 关键修复（2026-11-12）：结果邮件必须带**会话的线程标识**，否则用户
      // 直接回复它时线程解析（References/X-DSH-Session/主题 tag）全部落空，
      // 只会新开一个会话 —— 用户实测就是这样丢了上下文。
      //   ① 会话已有 tag 就用它；没有就 mint 一个并绑定（send_email 同理）；
      //   ② 主题加 [dsh-xxxx] 前缀 + 带 X-DSH-Session，让客户端丢弃 References
      //      时仍能归位；
      //   ③ 记录 outgoing，让 In-Reply-To/References 这条最硬的路也能命中。
      let tag = tagForSession(sessionId)
      if (tag === undefined) tag = newTag(sessionId)
      try {
        bindThread(tag, { sessionId, subject: mail.subject })
      } catch { /* 绑定失败不影响发信，最多回复时退回新会话 */ }
      const subject = tagSubject(mail.subject, tag, cfg.tagPrefix)
      await sendMail(account, {
        to: owner,
        subject,
        text: mail.text,
        messageId,
        references: [],
        tag,
      })
      try { recordOutgoing(messageId, tag) } catch { /* 记账失败不致命 */ }
      lastNotified.set(sessionId, { fingerprint, turn, at: Date.now() })
      log({ kind: 'hosting-result', ok: true, sessionId, turn, to: owner, subject, messageId, tag, chars: text.length })
      return { ok: true }
    } catch (error) {
      log({ kind: 'hosting-result', ok: false, sessionId, turn, error: errorText(error) })
      return { ok: false, error: errorText(error) }
    }
  }

  /**
   * 从一轮的助手消息里提炼可发的正文。
   *
   * 只要 text block，丢掉 reasoning / tool-call（那些是过程不是结果）；
   * 多段文本按顺序拼接。
   */
  function turnSummaryFromEvents(events) {
    const texts = []
    for (const event of events) {
      if (event?.type !== 'assistant/message') continue
      const content = event?.data?.message?.content
      if (!Array.isArray(content)) continue
      const parts = content
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text.trim())
        .filter((part) => part !== '')
      if (parts.length > 0) texts.push(parts.join('\n'))
    }
    // 取最后一段：一轮里可能有多步，最后一步的总结才是用户想看的。
    return texts.length > 0 ? texts[texts.length - 1] : ''
  }

  /** 安装工具遮蔽（主）与 waterfall 监听（兜底）。 */
  function install() {
    if (disposed) return () => {}
    const offShadow = shadowAskTool()
    const stop = ctx.effect(() => {
      const off = ctx.on('user-questions/request', (request, next) => answerByMail(request, next), { global: true, prepend: true })
      // 「任务完成 -> 结果邮件」：监听会话事件，turn/end 时把这一轮的文字结果发出去。
      // 同样要 global:true —— 不加会被作用域过滤掉（见文件头那段说明）。
      const offTurn = ctx.on('session/event', (session, event) => {
        try {
          const sessionId = sessionIdOf(session)
          // 诊断：turn/end 是否真的到达本监听器。结果邮件"没发"和"没收到事件"
          // 在日志里长得一样，所以只在这一种事件上留一条轻量痕迹。
          if (event?.type === 'turn/end') {
            log({ kind: 'hosting-turn', ok: true, sessionId: sessionId ?? null, turn: event?.data?.turn ?? null, buffered: (turnBuffers.get(sessionId) ?? '').length })
          }
          if (typeof sessionId !== 'string' || sessionId === '') return
          if (event?.type === 'assistant/message') {
            const summary = turnSummaryFromEvents([event])
            if (summary !== '') turnBuffers.set(sessionId, summary)
            return
          }
          if (event?.type !== 'turn/end') return
          const buffered = turnBuffers.get(sessionId) ?? ''
          turnBuffers.delete(sessionId)
          if (buffered === '') return
          // 不 await：事件监听必须同步返回；发送在后台跑，失败只记日志。
          void notifyTurnResult(sessionId, event?.data?.turn, buffered).catch(() => {})
        } catch { /* 通知链路绝不能影响会话事件派发 */ }
      }, { global: true })
      log({ kind: 'hosting-install', ok: true, mode: 'tool-shadow+waterfall+result-mail' })
      // 启动时清一次历史僵尸提问单，之后随面板轮询定期清（见 sweepStale）。
      try { pruneStaleTickets() } catch { /* 清理失败不影响提问功能 */ }
      return () => {
        try { off?.() } catch { /* teardown must not throw */ }
        try { offTurn?.() } catch { /* teardown must not throw */ }
      }
    }, 'smart-mail: mail-hosting answerer')
    return () => {
      disposed = true
      for (const waiter of waiters.values()) waiter.dispose()
      waiters.clear()
      lastNotified.clear()
      turnBuffers.clear()
      try { stop?.() } catch { /* teardown must not throw */ }
      try { offShadow() } catch { /* teardown must not throw */ }
    }
  }

  return {
    install,
    deliverReply,
    flushParked,
    /** 探测＋标记僵尸提问单（启动时与面板轮询都会调）。 */
    sweepStale: () => pruneStaleTickets(),
    parked: () => lateAnswers.size,
    running: () => [...waiters.keys()],
  }
}
