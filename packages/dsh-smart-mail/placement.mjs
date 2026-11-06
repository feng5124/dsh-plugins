/**
 * dsh-smart-mail — wake placement.
 *
 * A mail-triggered Session has to start somewhere, and "somewhere" is a
 * Workspace decision the user makes in the panel — not a path baked into this
 * plugin. This module owns that decision as a pure resolution step, so the
 * whole feature is testable without a Host:
 *
 *   { mode: 'default' }               -> the Workspace the Host calls default
 *   { mode: 'workspace', id }          -> one registered Workspace, chosen by id
 *   { mode: 'cwd', path }              -> a plain directory (the pre-existing
 *                                         `wakeCwd` behaviour; keeps working
 *                                         when a deployment registers no
 *                                         Workspaces at all)
 *   { mode: 'ungrouped' }              -> no Workspace: the Session stays out of
 *                                         every group, which is what the GUI
 *                                         calls 未分组
 *
 * Two facts shape the design:
 *
 * 1. **Workspace ids are the portable identity.** A path is not: it is
 *    machine-specific, and the npm package must not ship one. So the panel
 *    offers the Host's live Workspace list and stores the id; `wakeCwd` stays
 *    as the fallback for Hosts that have no registry (headless-only installs).
 *
 * 2. **The Host validates `realpath(header.cwd) === workspace.path` before it
 *    attaches a Session to a Workspace.** Choosing a Workspace therefore means
 *    asking `sessionController.create({ workspaceId })`, which lets the Host do
 *    that validation and the attach in one step; only a Host without
 *    `workspaceRegistry` needs the `cwd` form.
 *
 * The default Workspace is resolved through the *live list* the panel also
 * shows (`workspaceController.follow` publishes `defaultWorkspaceId`), and it
 * falls back to the first registered Workspace when the Host publishes no
 * first-use identity — a Session is never created into an arbitrary directory
 * just because the identity was absent.
 */

import { homedir } from 'node:os'

/**
 * Where the Host stores a session whose cwd is `directory`.
 *
 * DSH groups session files by their header cwd, one directory per project:
 * `sessions/--<encoded cwd>--/session-<uuid>/session.v4.jsonl.zstd`, where a
 * non-ASCII character becomes `~` + its 4-digit uppercase hex code and
 * separators become `-`. Reproducing that here lets the panel answer "my file
 * is where?" with a real path instead of a description.
 *
 * @param {string} directory absolute cwd
 * @returns {string} the project directory name under `<dsh home>/sessions`
 */
export function sessionProjectDirectory(directory) {
  // The drive colon is dropped (`E:\...` -> `E-...`), every separator becomes
  // `-`, and the whole thing is wrapped in `--`. Verified against the real
  // directories: `--E-deepseek-harness-default-workspace--`.
  const body = directory
    .replace(/^([A-Za-z]):/, '$1')
    .replace(/[\\/]/g, '-')
    .replace(/[^\x20-\x7e]/g, (character) => '~' + character.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0'))
  return `--${body}--`
}

/** Placement modes, as stored in the profile row's `wakeTarget.mode`. */
export const WakePlacement = {  /** The Host's own default Workspace (首次使用身份), else the first registered one. */
  default: 'default',
  /** One registered Workspace, addressed by its stable id. */
  workspace: 'workspace',
  /** A plain directory outside the Workspace registry. */
  cwd: 'cwd',
  /** Deliberately no Workspace: the Session shows up under 未分组. */
  ungrouped: 'ungrouped',
}

const MODES = new Set(Object.values(WakePlacement))

/** A trimmed non-empty string, or undefined. */
function nonEmpty(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * Normalize the stored placement from the profile row.
 *
 * Unknown or incomplete values degrade to {@link WakePlacement.default} instead
 * of failing a wake: an unreadable placement must never be the reason a
 * whitelisted mail goes unanswered. A stale directory keeps, because the cwd
 * mode is the historical behaviour and silently dropping it would move an
 * existing installation's Sessions somewhere else.
 *
 * @param {unknown} raw `wakeTarget` from the config
 * @param {string} [legacyCwd] the old flat `wakeCwd`
 * @returns {{mode: string, workspaceId?: string, cwd?: string}}
 */
export function normalizePlacement(raw, legacyCwd) {
  const record = raw !== null && typeof raw === 'object' ? raw : {}
  const mode = nonEmpty(record.mode)
  const workspaceId = nonEmpty(record.workspaceId)
  const cwd = nonEmpty(record.cwd) ?? nonEmpty(legacyCwd)

  if (mode !== undefined && MODES.has(mode)) {
    if (mode === WakePlacement.workspace) {
      return workspaceId === undefined ? { mode: WakePlacement.default } : { mode, workspaceId }
    }
    if (mode === WakePlacement.cwd) {
      return cwd === undefined ? { mode: WakePlacement.default } : { mode, cwd }
    }
    return { mode }
  }

  // No usable mode: honour a stored workspace id, then a stored directory, and
  // only then fall back to the Host default.
  if (workspaceId !== undefined) return { mode: WakePlacement.workspace, workspaceId }
  if (cwd !== undefined) return { mode: WakePlacement.cwd, cwd }
  return { mode: WakePlacement.default }
}

/**
 * Normalize the list of Workspaces a Host publishes to the panel.
 *
 * Titles are display-only and may be empty; `id` and `path` are what matter.
 * Anything without both is dropped rather than offered as a broken option.
 *
 * @param {unknown} list value of `workspaceRegistry.list()` (entity array)
 * @param {unknown} [defaultWorkspaceId] the Host's first-use identity
 * @returns {{workspaces: {id: string, title: string, path: string}[], defaultWorkspaceId: string|null}}
 */
export function normalizeWorkspaceList(list, defaultWorkspaceId) {
  const workspaces = []
  for (const entry of Array.isArray(list) ? list : []) {
    const id = nonEmpty(entry?.id)
    const path = nonEmpty(entry?.path)
    if (id === undefined || path === undefined) continue
    workspaces.push({ id, title: nonEmpty(entry?.title) ?? path, path })
  }
  const wanted = nonEmpty(defaultWorkspaceId)
  const resolved = workspaces.find((item) => item.id === wanted)?.id ?? null
  return { workspaces, defaultWorkspaceId: resolved }
}

/**
 * Resolve a placement against the Host's live Workspace list.
 *
 * Returns the argument for `sessionController.create()` plus the human-readable
 * target used in the log, so a wake record always says where the Session
 * actually went. `ok: false` means the requested target no longer exists; the
 * caller decides whether to fall back (a missing Workspace must not silently
 * become some other directory).
 *
 * @param {{mode: string, workspaceId?: string, cwd?: string}} placement
 * @param {{workspaces: {id: string, title: string, path: string}[], defaultWorkspaceId: string|null}} catalog
 * @returns {{ok: boolean, request?: object, target?: string, reason?: string}}
 */
export function resolvePlacement(placement, catalog) {
  const workspaces = catalog?.workspaces ?? []

  if (placement.mode === WakePlacement.ungrouped) {
    // No workspaceId and no cwd: the Session joins no group, and the Host picks
    // the directory. That is deliberate — the user asked for "跟随 DSH 自己的
    // 默认值" — but the resulting path is *not* guessable on its own:
    // `SessionCommandController`'s `defaultCwd` is `process.cwd()` of the host
    // process (DSH never calls chdir), i.e. the launch directory, which is the
    // user's home in the desktop app but the install dir for a web/headless
    // host. So the resolved value carries `landing` — the directory the Host
    // will actually use — for the panel and the log to SHOW, without ever
    // passing it as a location (passing it would freeze one host's choice).
    return { ok: true, request: {}, target: 'ungrouped', landing: process.cwd() }
  }

  if (placement.mode === WakePlacement.workspace) {
    const found = workspaces.find((item) => item.id === placement.workspaceId)
    if (found === undefined) {
      return { ok: false, reason: `workspace ${placement.workspaceId} is not registered on this Host` }
    }
    return { ok: true, request: { workspaceId: found.id }, target: `workspace:${found.title}` }
  }

  if (placement.mode === WakePlacement.cwd) {
    return { ok: true, request: { cwd: placement.cwd }, target: `cwd:${placement.cwd}` }
  }

  // default: the Host's first-use identity, else the first registered Workspace.
  const id = catalog?.defaultWorkspaceId ?? workspaces[0]?.id
  const found = workspaces.find((item) => item.id === id)
  if (found === undefined) {
    return { ok: false, reason: 'this Host registers no Workspace to default to' }
  }
  return { ok: true, request: { workspaceId: found.id }, target: `default:${found.title}` }
}

/**
 * Read the Host's Workspace catalog.
 *
 * `workspaceRegistry` is the durable owner; `defaultWorkspaceId` lives in its
 * global state, which is not part of the public entity surface, so it is read
 * defensively and simply stays null when unavailable (the resolver then uses
 * the first registered Workspace, matching the GUI's ordering).
 *
 * @param {object} ctx Host context
 * @returns {{workspaces: {id: string, title: string, path: string}[], defaultWorkspaceId: string|null}}
 */
export function readWorkspaceCatalog(ctx) {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined || typeof registry.list !== 'function') {
    return { workspaces: [], defaultWorkspaceId: null }
  }
  let list = []
  try {
    list = registry.list()
  } catch {
    return { workspaces: [], defaultWorkspaceId: null }
  }
  let defaultId = null
  try {
    // Not part of the documented entity surface: present on current Hosts,
    // absent on older ones. Never a hard dependency.
    const state = typeof registry.requireState === 'function' ? registry.requireState() : undefined
    defaultId = state?.defaultWorkspaceId ?? registry.defaultWorkspaceId ?? null
  } catch {
    defaultId = null
  }
  return normalizeWorkspaceList(list, defaultId)
}

/** One-line description of a placement for logs and the panel. */
export function describePlacement(placement, catalog) {
  const resolved = resolvePlacement(placement, catalog)
  if (!resolved.ok) return `unresolved(${placement.mode}: ${resolved.reason})`
  return resolved.target
}

/**
 * Where a placement will physically put its sessions, spelled out for a human.
 *
 * "未分组" is a membership answer, not a directory, so the honest answer needs
 * both halves: which group (none) and which directory (the Host's default).
 * The directory is the Host's own `defaultCwd` when known, otherwise the
 * process cwd that Host derives it from — labelled as such, never presented as
 * a promise about some other host.
 *
 * @param {{mode: string, workspaceId?: string, cwd?: string}} placement
 * @param {{workspaces: object[], defaultWorkspaceId: string|null}} catalog
 * @returns {{group: string, directory: string|null, membership: string}}
 */
export function explainPlacement(placement, catalog) {
  const resolved = resolvePlacement(placement, catalog)
  if (!resolved.ok) {
    return { group: '（未解析）', directory: null, membership: `无法落点：${resolved.reason}`, projectDirectory: null }
  }
  if (placement.mode === WakePlacement.ungrouped) {
    const directory = resolved.landing ?? null
    return {
      group: '未分组',
      directory,
      membership: '不加入任何工作区；文件按 cwd 归档到 DSH 的 sessions 目录',
      projectDirectory: directory === null ? null : sessionProjectDirectory(directory),
    }
  }
  if (placement.mode === WakePlacement.cwd) {
    const directory = placement.cwd ?? null
    return {
      group: '（不加入工作区）',
      directory,
      membership: '按指定目录建会话，不挂工作区',
      projectDirectory: directory === null ? null : sessionProjectDirectory(directory),
    }
  }
  const found = (catalog?.workspaces ?? []).find((item) => item.id === (resolved.request?.workspaceId))
  return {
    group: found?.title ?? '（未知工作区）',
    directory: found?.path ?? null,
    membership: '会话加入该工作区，出现在侧栏该组下',
    projectDirectory: found?.path === undefined ? null : sessionProjectDirectory(found.path),
  }
}
