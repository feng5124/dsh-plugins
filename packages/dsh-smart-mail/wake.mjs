/**
 * dsh-smart-mail — session bridge.
 *
 * A whitelisted mail either wakes a fresh Session or continues the Session its
 * thread is already bound to. Everything here goes through the Host's public
 * services, never through an external CLI:
 *
 *   ctx.sessionController.create({ cwd })              -> new Session
 *   ctx.sessionController.prompt(req, signal)          -> admit a prompt
 *   ctx.sessionController.cancel({ sessionId })        -> stop the running turn
 *   ctx.sessionController.inspect(sessionId)           -> is the Session known?
 *   ctx.workspaceRegistry.unarchiveSession(sessionId)  -> lift the archive gate
 *
 * Interrupt semantics (mirrors how the reference dsh-mail channel does it):
 *   1. a reply whose thread maps to a *running* Session is delivered with
 *      `mode: 'steer'` when the Host accepts it — the running turn is replaced
 *      at the next step boundary;
 *   2. if steering is refused, the prompt is queued and the active turn is
 *      cancelled with `cancel({ sessionId })`, which keeps the inbox
 *      (`keepInbox: true`), so the queued prompt is picked up immediately
 *      instead of after the abandoned work finishes.
 * The returned record states which path was taken, so the log never claims a
 * hard interrupt that did not happen.
 *
 * Archived Sessions: `ArchivedSessionGate` rejects every model step of an
 * archived Session, and there is no public "unarchive" Remote — but the
 * Workspace registry exposes `unarchiveSession()`, the same durable write
 * `archiveSession()` uses. When that method is absent (older Host), the
 * equivalent path is the registry's own mutation queue
 * (`enqueueOperation` + `requireState` + `setState`) dropping the id from
 * `archivedSessionIds`. Both paths are attempted in that order and the one
 * that worked is reported.
 */

import { randomUUID } from 'node:crypto'

/** How a prompt should be admitted into a Session. */
export const DeliveryMode = {
  /** Replace the active turn (a reply inside the same thread). */
  interrupt: 'interrupt',
  /** Append behind the running turn and let it finish. */
  queue: 'queue',
}

/** Admission modes the Host's `prompt` understands. */
const PROMPT_MODES = new Set(['queue', 'steer'])

function errorText(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/** Whether the Host currently runs a turn for this Session. */
export async function isRunning(ctx, sessionId) {
  const sc = ctx.get('sessionController')
  if (sc === undefined) return false
  try {
    const value = await sc.list({}, AbortSignal.timeout(5000))
    for (const item of value?.items ?? []) {
      if (String(item.sessionId) === String(sessionId)) return item.running === true
    }
    return false
  } catch {
    // Fall back to the live Agent registry when the list is unavailable.
    const agent = ctx.get('agents')?.get?.(sessionId)
    return agent?.status === 'running'
  }
}

/**
 * Whether the Session still exists at all (live or durable).
 * @returns {Promise<'live'|'cold'|'missing'>}
 */
export async function sessionState(ctx, sessionId) {
  const sessions = ctx.get('sessions')
  if (sessions?.get?.(sessionId) !== undefined) return 'live'
  const sc = ctx.get('sessionController')
  if (sc === undefined) return 'missing'
  try {
    await sc.inspect(sessionId)
    return 'cold'
  } catch {
    return 'missing'
  }
}

/** Whether the Session is in the registry's archive set. */
export function isArchived(ctx, sessionId) {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined) return false
  try {
    const ids = registry.archivedSessionIds ?? []
    return ids.includes(sessionId)
  } catch {
    return false
  }
}

/**
 * Lift the archive gate for one Session.
 *
 * Path A (preferred): `workspaceRegistry.unarchiveSession(id)` — the durable
 * write the Host's own `workspace/unarchiveSession` Remote calls.
 * Path B (fallback): the registry's mutation queue, dropping the id from
 * `archivedSessionIds` exactly like `archiveSession()` adds it.
 *
 * @returns {Promise<{ok: boolean, path: string, wasArchived: boolean, error?: string}>}
 */
export async function ensureUnarchived(ctx, sessionId) {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined) return { ok: false, path: 'none', wasArchived: false, error: 'workspaceRegistry service unavailable' }
  const wasArchived = isArchived(ctx, sessionId)
  if (!wasArchived) return { ok: true, path: 'not-archived', wasArchived: false }

  if (typeof registry.unarchiveSession === 'function') {
    try {
      await registry.unarchiveSession(sessionId)
      if (!isArchived(ctx, sessionId)) return { ok: true, path: 'registry.unarchiveSession', wasArchived: true }
    } catch (error) {
      // Fall through to the queue path below.
      const first = errorText(error)
      const queued = await unarchiveViaQueue(ctx, registry, sessionId)
      return queued.ok
        ? { ok: true, path: 'registry.enqueueOperation', wasArchived: true }
        : { ok: false, path: 'registry.unarchiveSession', wasArchived: true, error: `${first}; fallback: ${queued.error}` }
    }
  }

  const queued = await unarchiveViaQueue(ctx, registry, sessionId)
  return queued.ok
    ? { ok: true, path: 'registry.enqueueOperation', wasArchived: true }
    : { ok: false, path: 'registry.enqueueOperation', wasArchived: true, error: queued.error }
}

async function unarchiveViaQueue(ctx, registry, sessionId) {
  if (typeof registry.enqueueOperation !== 'function' || typeof registry.requireState !== 'function' || typeof registry.setState !== 'function') {
    return { ok: false, error: 'workspace registry exposes no unarchiveSession and no enqueueOperation/requireState/setState trio' }
  }
  try {
    await registry.enqueueOperation(async () => {
      const state = registry.requireState()
      if (!(state.archivedSessionIds ?? []).includes(sessionId)) return
      await registry.setState({
        ...state,
        archivedSessionIds: state.archivedSessionIds.filter((id) => id !== sessionId),
      })
    })
    return { ok: !isArchived(ctx, sessionId) }
  } catch (error) {
    return { ok: false, error: errorText(error) }
  }
}

/** Admit one prompt through the Host controller, with its own timeout. */
async function admit(sc, { sessionId, text, mode, requestId }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('dsh-smart-mail: prompt admission timed out')), 30_000)
  timer.unref?.()
  try {
    await sc.prompt({
      requestId: requestId ?? `smart-mail-${randomUUID()}`,
      sessionId,
      mode: PROMPT_MODES.has(mode) ? mode : 'queue',
      content: [{ type: 'text', text }],
    }, controller.signal)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Deliver one prompt into an existing Session, interrupting its running turn
 * first when the caller asked for that.
 *
 * @param {object} ctx Host context
 * @param {object} input
 * @param {string} input.sessionId
 * @param {string} input.text
 * @param {'interrupt'|'queue'} [input.mode]
 * @param {string} [input.requestId]
 * @returns {Promise<{ok: boolean, mode?: string, interrupted?: boolean, unarchivePath?: string, error?: string}>}
 */
export async function deliverToSession(ctx, { sessionId, text, mode = DeliveryMode.interrupt, requestId }) {
  const sc = ctx.get('sessionController')
  if (sc === undefined) return { ok: false, error: 'sessionController service unavailable' }

  // An archived Session rejects every step, so it must come back first.
  const unarchive = await ensureUnarchived(ctx, sessionId)
  if (!unarchive.ok) {
    return { ok: false, unarchivePath: unarchive.path, error: `cannot restore archived session: ${unarchive.error ?? 'unknown'}` }
  }

  const running = await isRunning(ctx, sessionId)
  const wantInterrupt = mode === DeliveryMode.interrupt && running
  let admitted = null
  let usedCancel = false

  if (wantInterrupt) {
    try {
      await admit(sc, { sessionId, text, mode: 'steer', requestId })
      admitted = 'steer'
    } catch {
      admitted = null // steering refused: fall back to queue + cancel
    }
  }

  if (admitted === null) {
    try {
      await admit(sc, { sessionId, text, mode: 'queue', requestId })
      admitted = 'queue'
    } catch (error) {
      return { ok: false, unarchivePath: unarchive.path, error: errorText(error) }
    }
  }

  // Queue-then-cancel: cancelling keeps the inbox (keepInbox: true), so the
  // prompt admitted above is picked up now instead of after the stale turn.
  if (wantInterrupt && admitted !== 'steer') {
    try {
      sc.cancel({ sessionId })
      usedCancel = true
    } catch {
      usedCancel = false
    }
  }

  return {
    ok: true,
    mode: admitted,
    interrupted: wantInterrupt,
    cancelUsed: usedCancel,
    wasRunning: running,
    unarchivePath: unarchive.wasArchived ? unarchive.path : undefined,
  }
}

/**
 * Wake DSH with one prompt in a brand-new Session.
 * @param ctx Host Cordis context carrying sessionController.
 * @param mail {from, subject, preview, account, at}
 * @param cfg {wakePrompt, wakeCwd, model}
 * @returns {Promise<{ok: boolean, sessionId?: string, error?: string}>}
 */
export async function wakeWithMail(ctx, mail, cfg) {
  const sc = ctx.get('sessionController')
  if (!sc) return { ok: false, error: 'sessionController service unavailable' }
  const text = [
    `[dsh-smart-mail 唤醒] ${cfg.wakePrompt ?? ''}`.trim(),
    `邮箱账号：${mail.account}`,
    `发件人（白名单命中）：${mail.from}`,
    `主题：${mail.subject ?? '(无主题)'}`,
    `时间：${new Date(mail.at || Date.now()).toLocaleString('zh-CN')}`,
    `正文预览：${mail.preview || '(空)'}`,
    '请处理这封邮件；如需回信，先确认收件人意图，再调用 send_email 工具发送。',
  ].join('\n')
  try {
    const created = await sc.create({ cwd: cfg.wakeCwd })
    const sessionId = created.sessionId
    await admit(sc, { sessionId, text, mode: 'queue' })
    return { ok: true, sessionId }
  } catch (error) {
    return { ok: false, error: errorText(error) }
  }
}
