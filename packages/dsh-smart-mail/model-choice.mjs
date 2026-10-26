/**
 * dsh-smart-mail — per-thread model selection.
 *
 * A mail thread may pin the model its session should use, exactly like the
 * session page's model selector does. Two rules make this safe:
 *
 * 1. **The global default is never touched.** `sessionController.selectModel()`
 *    writes the choice into the deployment default as a side effect, which for a
 *    mail wake would silently change what every other conversation uses. This
 *    module therefore resolves the route through `ctx.llm.resolveCallConfig()`
 *    and appends the resulting `model/selection` to *that session only*.
 *
 * 2. **An unavailable model falls back to the default for this call.** The
 *    configured selection is checked against `sessionController.modelCatalog()`
 *    (the same catalog the session page renders). If the provider is not
 *    routable, or the exact model is gone, or the reasoning effort is no longer
 *    supported, the wake proceeds with the deployment default and records why.
 *    It never fails the wake just because a pinned model disappeared.
 *
 * Resolution order for one wake:
 *   thread's own model  ->  config default model  ->  deployment default
 *
 * @module dsh-smart-mail/model-choice
 */

/** A selection is `{provider, model, reasoningEffort?}`; this validates the shape. */
export function isSelection(value) {
  return value !== null && typeof value === 'object'
    && typeof value.provider === 'string' && value.provider !== ''
    && typeof value.model === 'string' && value.model !== ''
    && (value.reasoningEffort === undefined || typeof value.reasoningEffort === 'string')
}

/** Render a selection for logs: `provider/model@effort`. */
export function describeSelection(selection) {
  if (!isSelection(selection)) return '(none)'
  return `${selection.provider}/${selection.model}${selection.reasoningEffort === undefined ? '' : `@${selection.reasoningEffort}`}`
}

/**
 * Flatten a `modelCatalog()` result into `{ [provider]: { [model]: entry } }`.
 * @param {{groups?: Array<{id: string, models: Array<object>}>}} catalog
 */
export function indexCatalog(catalog) {
  const index = new Map()
  for (const group of catalog?.groups ?? []) {
    const models = new Map()
    for (const model of group.models ?? []) models.set(model.id, model)
    index.set(group.id, models)
  }
  return index
}

/**
 * Why a selection cannot be used, or `null` when it can.
 *
 * @param {object} selection
 * @param {{catalog: object}} input the live `modelCatalog()` result
 * @returns {string|null} a short machine-ish reason, suitable for a log field
 */
export function unavailableReason(selection, { catalog }) {
  if (!isSelection(selection)) return 'invalid-selection'
  const index = indexCatalog(catalog)
  const models = index.get(selection.provider)
  if (models === undefined) {
    // The catalog reports whole-provider failures separately (e.g. a missing API
    // key); surface that rather than a bare "unknown provider".
    const failure = (catalog?.failures ?? []).find((entry) => entry.id === selection.provider)
    return failure === undefined ? 'provider-not-routable' : `provider-unavailable: ${failure.message}`
  }
  const entry = models.get(selection.model)
  if (entry === undefined) return 'model-not-in-catalog'
  const effort = selection.reasoningEffort
  if (effort !== undefined) {
    const efforts = entry.reasoning?.efforts ?? []
    if (!efforts.some((candidate) => candidate.id === effort)) return `reasoning-effort-unsupported: ${effort}`
  }
  return null
}

/**
 * Choose the selection to use for one wake.
 *
 * @param {object} input
 * @param {object} input.catalog live `modelCatalog()` result
 * @param {object} [input.thread] the thread's pinned selection, if any
 * @param {object} [input.configured] the plugin config's `modelSelection`, if any
 * @param {object} [input.deployment] `catalog.default`, the deployment default
 * @returns {{selection: object|undefined, source: string, fallback?: string}}
 *   `source` is `thread` | `config` | `default`; `fallback` explains a downgrade.
 */
export function chooseSelection({ catalog, thread, configured, deployment }) {
  const defaultSelection = isSelection(deployment) ? deployment : (isSelection(catalog?.default) ? catalog.default : undefined)

  for (const [source, candidate] of [['thread', thread], ['config', configured]]) {
    if (candidate === undefined || candidate === null) continue
    const reason = unavailableReason(candidate, { catalog })
    if (reason === null) return { selection: candidate, source }
    // Remember the downgrade so the log can say why the pinned model was ignored.
    return { selection: defaultSelection, source: 'default', fallback: `${source}: ${reason}` }
  }

  return { selection: defaultSelection, source: 'default' }
}

/**
 * Apply a selection to one session without touching the global default.
 *
 * @param {object} ctx Host context (`llm`, `sessionController`)
 * @param {string} sessionId
 * @param {object} selection
 * @returns {Promise<{ok: boolean, applied?: object, error?: string}>}
 */
export async function applySessionModel(ctx, sessionId, selection) {
  if (!isSelection(selection)) return { ok: false, error: 'invalid selection' }
  const llm = ctx.get('llm')
  if (llm === undefined) return { ok: false, error: 'llm service unavailable' }
  const sc = ctx.get('sessionController')
  if (sc === undefined) return { ok: false, error: 'sessionController service unavailable' }

  let applied
  try {
    // Validate and normalize the route the same way the session page does.
    const resolved = await llm.resolveCallConfig({
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
    })
    applied = {
      provider: resolved.provider,
      model: resolved.model,
      ...(resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort }),
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }

  try {
    const found = await sc.resolveAgent(sessionId)
    const agent = found?.agent ?? found
    if (agent?.session === undefined) return { ok: false, error: found?.error?.message ?? 'session not resolvable' }
    // Session-scoped only: `selectModel()` would also persist the global default.
    agent.session.append('model/selection', applied)
    return { ok: true, applied }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Fetch the live catalog, tolerating a Host that cannot build one.
 * @param {object} ctx
 * @returns {Promise<object|null>}
 */
export async function readCatalog(ctx) {
  const sc = ctx.get('sessionController')
  if (sc === undefined || typeof sc.modelCatalog !== 'function') return null
  try {
    return await sc.modelCatalog()
  } catch {
    return null
  }
}
