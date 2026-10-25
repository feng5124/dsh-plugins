/**
 * Host half of dsh-plugin-headless-sessions-panel.
 *
 * The sidebar entry itself is browser-side (`./client`), but finding "the
 * headless sessions running on this machine" needs Node: the session files are
 * multi-frame zstd, and liveness comes from matching `cli.js headless` processes
 * against session files. That logic already exists as a reviewed tool in this
 * workspace — `dsh-session-forensics/find-headless.mjs` — so this half runs that
 * script rather than reimplementing it:
 *
 *   GET /headless-sessions/status[?all=1]  -> the script's `--json` rows
 *   GET /headless-sessions/dump?id=<prefix> -> one session exported as Markdown
 *
 * The browser half reaches these through plain same-origin `fetch`, the same
 * carrier the shipped client plugins use. Routes are served on DSH's own web
 * server, so only a client that already passed the session's HTTP authentication
 * can read them.
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Route prefix owned by this package. */
const ROUTE_PREFIX = '/headless-sessions'
/** Plugin-owned state directory, also used for the load/request stamps below. */
const STATE_DIR = path.join(homedir(), '.dsh', 'headless-sessions')
/** Reuse a recent answer instead of re-spawning the scanner on every poll. */
const STATUS_TTL_MS = 2000
const DUMP_TTL_MS = 3000
/** Keep one exported transcript bounded; the panel is a preview, not an archive. */
const MAX_DUMP_BYTES = 400 * 1024
const MAX_LINES = 4000
const RUN_TIMEOUT_MS = 60_000

/**
 * Write one diagnostic JSON file. The panel's data comes from HTTP, but these
 * stamps make "did the host half load / did the page reach it" checkable from a
 * terminal without a browser, which is how this plugin is verified here.
 */
function writeStamp(name, value) {
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(path.join(STATE_DIR, name), `${JSON.stringify(value, null, 2)}\n`)
  } catch {
    // Diagnostics must never break the plugin.
  }
}

function json(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function run(file, args, env) {
  return new Promise((resolve) => {
    execFile(file, args, {
      encoding: 'utf8',
      timeout: RUN_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
      env: env === undefined ? process.env : { ...process.env, ...env },
    }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr ?? '').trim().split('\n').slice(-2).join(' ')
        resolve({ ok: false, error: detail === '' ? error.message : `${error.message} :: ${detail}` })
        return
      }
      resolve({ ok: true, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
  })
}

/**
 * The forensic scanner, best candidate first. Since 1.0.0 the script ships
 * inside this package (`lib/find-headless.mjs`), so npm installs work out of
 * the box; workspace/neighbour and user-level copies still win when present.
 * @returns candidate absolute paths, best first.
 */
function scriptCandidates() {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [
    process.env.DSH_HEADLESS_FORENSICS,
    // bundled fallback: shipped inside this package (npm installs resolve here)
    path.join(here, 'find-headless.mjs'),
    // <workspace>/dsh-local-bundles/dsh-plugin-headless-sessions-panel/lib -> <workspace>/dsh-session-forensics
    path.resolve(here, '..', '..', '..', 'dsh-session-forensics', 'find-headless.mjs'),
    path.join(homedir(), '.dsh', 'headless-sessions', 'find-headless.mjs'),
  ]
  return candidates.filter((candidate) => typeof candidate === 'string' && candidate !== '' && existsSync(candidate))
}

/**
 * Node interpreters to try, best first. The scanner needs `zlib.zstd*`, which the
 * Electron host process may not expose, so prefer the bundled runtimes.
 * @returns `{ file, env }` candidates.
 */
function nodeCandidates() {
  const found = []
  const runtimeRoot = path.join(homedir(), '.dsh', 'dsh-runtimes')
  if (existsSync(runtimeRoot)) {
    for (const entry of readdirSync(runtimeRoot)) {
      const candidate = path.join(runtimeRoot, entry, 'dependencies', 'node', 'bin', 'node.exe')
      if (existsSync(candidate)) found.push({ file: candidate, env: {} })
    }
  }
  const bundled = process.env.DSH_BUNDLED_NODE
  if (typeof bundled === 'string' && bundled !== '' && existsSync(bundled)) {
    found.push({ file: bundled, env: {} })
  }
  // Electron can act as plain Node; last resort when no bundled runtime exists.
  found.push({ file: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } })
  return found
}

const plugin = {
  name: 'headless-sessions',
  inject: ['webServer'],

  apply(ctx) {
    const scripts = scriptCandidates()
    const nodes = nodeCandidates()
    let statusCache = null
    const dumpCache = new Map()
    let lastRequestStamp = 0

    writeStamp('host-stamp.json', {
      loadedAt: Date.now(),
      loadedAtLocal: new Date().toLocaleString('sv-SE'),
      plugin: 'headless-sessions-panel',
      revision: 'scanner-routes-v2',
      module: import.meta.url,
      hostPid: process.pid,
      hostNode: process.versions.node,
      electron: process.versions.electron ?? null,
      forensicsScript: scripts[0] ?? null,
      interpreters: nodes.map((node) => node.file),
    })

    /** Run the scanner with `args`, trying each interpreter until one starts. */
    const scan = async (args) => {
      if (scripts.length === 0) {
        return { ok: false, error: 'find-headless.mjs not found (set DSH_HEADLESS_FORENSICS to its path)' }
      }
      let last = { ok: false, error: 'no node interpreter available' }
      for (const script of scripts) {
        for (const node of nodes) {
          const result = await run(node.file, [script, ...args], node.env)
          if (result.ok) return { ok: true, stdout: result.stdout, script }
          last = result
          // A missing interpreter is worth another candidate; a script failure is not.
          if (!/ENOENT|not recognized|spawn/i.test(result.error)) break
        }
      }
      return last
    }

    const status = async (all) => {
      const key = all ? 'all' : 'live'
      const now = Date.now()
      if (statusCache !== null && statusCache.key === key && now - statusCache.at < STATUS_TTL_MS) {
        return { ...statusCache.payload, cached: true }
      }
      const args = all ? ['--json', '--all', '--limit', '50'] : ['--json']
      const result = await scan(args)
      let payload
      if (!result.ok) {
        // Keep the last good answer so the panel does not blank out on one failure.
        payload = {
          ok: false,
          error: result.error,
          sessions: statusCache?.payload?.sessions ?? [],
          stale: statusCache !== null,
          generatedAt: statusCache?.payload?.generatedAt ?? null,
        }
      } else {
        let sessions = null
        try {
          const parsed = JSON.parse(result.stdout)
          if (Array.isArray(parsed)) sessions = parsed
        } catch (cause) {
          payload = {
            ok: false,
            error: `cannot parse scanner output: ${cause instanceof Error ? cause.message : String(cause)}`,
            sessions: statusCache?.payload?.sessions ?? [],
            stale: statusCache !== null,
            generatedAt: statusCache?.payload?.generatedAt ?? null,
          }
        }
        if (sessions !== null) {
          payload = {
            ok: true,
            all: Boolean(all),
            scope: all ? '按更新时间排列的前 50 个会话' : '正在运行的无头会话 + 最近 5 分钟内活动过的会话',
            script: result.script,
            generatedAt: Date.now(),
            sessions,
          }
        }
      }
      statusCache = { key, at: now, payload }
      return { ...payload, cached: false }
    }

    const dump = async (id) => {
      const now = Date.now()
      const cached = dumpCache.get(id)
      if (cached !== undefined && now - cached.at < DUMP_TTL_MS) return { ...cached.payload, cached: true }
      const result = await scan(['--dump', id])
      let payload
      if (!result.ok) {
        payload = { ok: false, id, error: result.error }
      } else {
        const match = /导出完成[：:]\s*(.+\.md)\s*$/m.exec(result.stdout)
        const file = match === null ? null : match[1].trim()
        if (file === null || !existsSync(file)) {
          payload = { ok: false, id, error: `scanner produced no export for "${id}"` }
        } else {
          let text = readFileSync(file, 'utf8')
          let truncated = false
          if (Buffer.byteLength(text) > MAX_DUMP_BYTES) {
            text = Buffer.from(text, 'utf8').subarray(0, MAX_DUMP_BYTES).toString('utf8')
            truncated = true
          }
          const lines = text.split('\n')
          if (lines.length > MAX_LINES) {
            text = lines.slice(0, MAX_LINES).join('\n')
            truncated = true
          }
          payload = { ok: true, id, file, markdown: text, truncated, generatedAt: Date.now() }
        }
      }
      dumpCache.set(id, { at: now, payload })
      return { ...payload, cached: false }
    }

    ctx.effect(() => {
      const dispose = ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: async (req, res) => {
          try {
            if (Date.now() - lastRequestStamp > 1000) {
              lastRequestStamp = Date.now()
              writeStamp('last-request.json', {
                at: Date.now(),
                atLocal: new Date().toLocaleString('sv-SE'),
                method: req.method ?? '?',
                url: req.url ?? '?',
              })
            }
            if (req.method !== 'GET' && req.method !== 'HEAD') {
              json(res, 405, { ok: false, error: 'method-not-allowed' })
              return
            }
            const url = new URL(req.url ?? '/', 'http://localhost')
            if (url.pathname === `${ROUTE_PREFIX}/status`) {
              json(res, 200, await status(url.searchParams.get('all') === '1'))
              return
            }
            if (url.pathname === `${ROUTE_PREFIX}/dump`) {
              const id = url.searchParams.get('id') ?? ''
              if (id.trim() === '') {
                json(res, 400, { ok: false, error: 'missing-id' })
                return
              }
              const result = await dump(id.trim())
              json(res, result.ok ? 200 : 502, result)
              return
            }
            if (url.pathname === `${ROUTE_PREFIX}/diag`) {
              // The browser half reports what it can see (services, origin) so the
              // panel can be debugged from a terminal instead of by screenshot.
              const raw = url.searchParams.get('data') ?? ''
              let data = null
              try {
                data = JSON.parse(raw)
              } catch {
                data = { unparsed: raw.slice(0, 1000) }
              }
              writeStamp('client-diag.json', {
                at: Date.now(),
                atLocal: new Date().toLocaleString('sv-SE'),
                data,
              })
              json(res, 200, { ok: true })
              return
            }
            json(res, 404, { ok: false, error: 'not-found', path: url.pathname })
          } catch (cause) {
            json(res, 500, { ok: false, error: cause instanceof Error ? cause.message : String(cause) })
          }
        },
      })
      return () => { dispose() }
    }, 'headless-sessions: scanner routes')
  },
}

export { ROUTE_PREFIX, scriptCandidates }
export default plugin
