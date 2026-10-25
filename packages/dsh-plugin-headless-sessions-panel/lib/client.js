// dsh-plugin-headless-sessions-panel — browser half.
//
// Contributes two seats to the shipped UI, without replacing anything:
//   * `sidebar.panellist` (id `headless-sessions`) -> the 「无头会话」 sidebar row
//   * `main` (key `headless-sessions`)            -> the panel that row opens
//
// The panel answers one question: which headless sessions are running on this
// machine right now? The host half runs this workspace's `dsh-session-forensics`
// scanner and serves two same-origin routes; this half polls one and renders the
// other:
//   GET /headless-sessions/status[?all=1]   -> the running/recent session rows
//   GET /headless-sessions/dump?id=<prefix> -> one session as readable Markdown
//
// Plain JavaScript only: no JSX, no TypeScript, no module imports. `React` comes
// from the platform seed table through the factory's `require`.
window.__ModuleLoader__.load({
  id: 'dsh-plugin-headless-sessions-panel',
  factory: (require) => {
    const React = require('react')
    const module = { exports: {} }
    const exports = module.exports

    /** Sidebar entry id; the `main` panel is registered under the same key. */
    const PANEL_ID = 'headless-sessions'
    const ENTRY_LABEL = '无头会话'
    const PANEL_TITLE = '无头会话'
    const STATUS_URL = '/headless-sessions/status'
    const DUMP_URL = '/headless-sessions/dump'
    /** Poll cadence for the session list, in milliseconds. */
    const POLL_MS = 4000

    const COLOR = {
      surface: 'var(--dsw-alias-bg-base)',
      raised: 'var(--dsw-alias-bg-layer-1)',
      nested: 'var(--dsw-alias-bg-layer-2)',
      border: 'var(--dsw-alias-border-l1)',
      borderStrong: 'var(--dsw-alias-border-l2)',
      text: 'var(--dsw-alias-label-primary)',
      muted: 'var(--dsw-alias-label-secondary)',
      accent: 'var(--dsw-alias-brand-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      ok: 'var(--dsw-alias-state-success-primary)',
    }

    const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

    const styles = {
      page: {
        boxSizing: 'border-box', height: '100%', minHeight: 0, display: 'flex',
        flexDirection: 'column', background: COLOR.surface, color: COLOR.text,
        font: '13px/1.55 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif',
      },
      header: {
        flex: '0 0 auto', display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between',
        gap: 16, padding: '18px 22px 12px', borderBottom: `1px solid ${COLOR.border}`,
      },
      headerMain: { minWidth: 0 },
      title: { margin: 0, fontSize: 18, fontWeight: 600, lineHeight: '26px' },
      subtitle: { marginTop: 4, color: COLOR.muted, fontSize: 12, overflowWrap: 'anywhere' },
      toolbar: { flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 8 },
      button: {
        cursor: 'pointer', padding: '6px 12px', borderRadius: 8, border: `1px solid ${COLOR.border}`,
        background: COLOR.raised, color: 'inherit', font: 'inherit',
      },
      buttonActive: {
        cursor: 'pointer', padding: '6px 12px', borderRadius: 8, color: COLOR.text,
        border: `1px solid ${COLOR.accent}`, background: COLOR.nested, font: 'inherit',
      },
      body: { flex: '1 1 auto', minHeight: 0, display: 'flex' },
      list: {
        flex: '0 0 400px', maxWidth: '48%', minWidth: 0, overflowY: 'auto',
        borderRight: `1px solid ${COLOR.border}`, padding: '6px 0',
      },
      row: (active) => ({
        display: 'block', width: '100%', boxSizing: 'border-box', textAlign: 'left',
        padding: '9px 14px', border: 0, cursor: 'pointer', color: 'inherit', font: 'inherit',
        background: active ? COLOR.nested : 'transparent',
        borderLeft: `2px solid ${active ? COLOR.accent : 'transparent'}`,
      }),
      rowTop: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 },
      rowTitle: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 500 },
      badge: (running) => ({
        flex: '0 0 auto', fontSize: 10, lineHeight: '16px', padding: '0 6px', borderRadius: 6,
        border: `1px solid ${running ? COLOR.ok : COLOR.border}`,
        color: running ? COLOR.ok : COLOR.muted,
        background: 'transparent',
      }),
      rowMeta: {
        display: 'block', marginTop: 2, color: COLOR.muted, fontSize: 11, fontFamily: MONO,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      },
      rowLine: {
        display: 'block', marginTop: 2, color: COLOR.muted, fontSize: 11,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      },
      notice: { padding: '12px 16px', color: COLOR.muted, fontSize: 12, lineHeight: 1.7 },
      noticeError: { padding: '12px 16px', color: COLOR.error, fontSize: 12, lineHeight: 1.7, overflowWrap: 'anywhere' },
      preview: { flex: '1 1 auto', minWidth: 0, overflowY: 'auto', padding: '16px 24px 48px' },
      docHead: {
        display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12,
        paddingBottom: 10, marginBottom: 14, borderBottom: `1px solid ${COLOR.border}`,
      },
      docPath: { fontFamily: MONO, fontSize: 12, color: COLOR.muted, overflowWrap: 'anywhere' },
      docActions: { flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 10 },
      docMeta: { flex: '0 0 auto', color: COLOR.muted, fontSize: 11 },
      markdown: { maxWidth: 820 },
      h: (level) => ({
        margin: level <= 2 ? '22px 0 10px' : '18px 0 8px',
        fontSize: level === 1 ? 22 : level === 2 ? 18 : level === 3 ? 15 : 13.5,
        fontWeight: 600, lineHeight: 1.35,
      }),
      p: { margin: '0 0 10px', overflowWrap: 'break-word' },
      list_: { margin: '0 0 10px', paddingLeft: 22 },
      li: { margin: '2px 0' },
      quote: {
        margin: '0 0 10px', padding: '2px 12px', color: COLOR.muted,
        borderLeft: `3px solid ${COLOR.borderStrong}`,
      },
      hr: { margin: '16px 0', border: 0, borderTop: `1px solid ${COLOR.border}` },
      codeBlock: {
        margin: '0 0 12px', padding: '10px 12px', borderRadius: 8, background: COLOR.raised,
        border: `1px solid ${COLOR.border}`, fontFamily: MONO, fontSize: 12,
        lineHeight: 1.55, whiteSpace: 'pre', overflowX: 'auto',
      },
      inlineCode: {
        padding: '1px 5px', borderRadius: 5, background: COLOR.nested,
        fontFamily: MONO, fontSize: 12,
      },
      link: { color: COLOR.accent, textDecoration: 'underline' },
      bold: { fontWeight: 600 },
      table: { margin: '0 0 12px', borderCollapse: 'collapse', fontSize: 12 },
      th: { padding: '5px 10px', border: `1px solid ${COLOR.border}`, background: COLOR.raised, textAlign: 'left' },
      td: { padding: '5px 10px', border: `1px solid ${COLOR.border}`, verticalAlign: 'top' },
      eofNote: { marginTop: 16, color: COLOR.muted, fontSize: 11 },
    }

    /** Narrow a thrown value to display text. */
    function messageOf(cause) {
      if (cause instanceof Error) return cause.message
      if (cause && typeof cause === 'object' && typeof cause.message === 'string') return cause.message
      return String(cause)
    }

    /** `HH:mm:ss` for one timestamp, or a dash. */
    function clockOf(value) {
      const time = typeof value === 'number' ? value : Date.parse(String(value ?? ''))
      if (!Number.isFinite(time) || time <= 0) return '—'
      const date = new Date(time)
      const pad = (n) => String(n).padStart(2, '0')
      return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    }

    /** Compact "how long ago" text. */
    function agoOf(value) {
      const time = typeof value === 'number' ? value : Date.parse(String(value ?? ''))
      if (!Number.isFinite(time) || time <= 0) return '—'
      const seconds = Math.max(0, Math.round((Date.now() - time) / 1000))
      if (seconds < 90) return `${seconds} 秒前`
      if (seconds < 5400) return `${Math.round(seconds / 60)} 分钟前`
      return `${(seconds / 3600).toFixed(1)} 小时前`
    }

    /** Human byte size. */
    function formatSize(size) {
      if (typeof size !== 'number' || !Number.isFinite(size)) return ''
      if (size < 1024) return `${size} B`
      if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
      return `${(size / 1024 / 1024).toFixed(1)} MB`
    }

    /** Same-origin GET returning JSON, folding every failure into a value. */
    async function getJson(url, signal) {
      let response
      try {
        response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', signal })
      } catch (cause) {
        if (cause && cause.name === 'AbortError') return { ok: false, aborted: true, error: 'aborted' }
        return { ok: false, error: `请求失败：${messageOf(cause)}` }
      }
      let text = ''
      try {
        text = await response.text()
      } catch (cause) {
        return { ok: false, error: `读取响应失败：${messageOf(cause)}` }
      }
      let body = null
      try {
        body = JSON.parse(text)
      } catch {
        body = null
      }
      if (!response.ok) {
        const detail = body && typeof body.error === 'string' ? body.error : text.slice(0, 200)
        return { ok: false, error: `HTTP ${response.status}${detail === '' ? '' : ` — ${detail}`}` }
      }
      if (body === null) return { ok: false, error: '宿主返回的不是 JSON（路由未就绪？）' }
      return { ok: true, value: body }
    }

    // ---------------------------------------------------------------------
    // A very small Markdown renderer: headings, fenced code, lists, quotes,
    // rules, tables, and inline code/bold/italic/links. It intentionally does
    // not aim at CommonMark parity — it renders the exported transcripts well
    // and shows raw text for anything it does not understand.
    // ---------------------------------------------------------------------

    /** Split one table row on `|`, dropping the optional edge bars. */
    function splitRow(line) {
      return String(line).replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((cell) => cell.trim())
    }

    /** Inline spans: `code`, **bold**, *italic*, [text](href), bare URLs. */
    function inlineNodes(text, keyPrefix) {
      const nodes = []
      const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*\n]+\*)|(\[[^\]]+\]\([^)\s]+\))|\bhttps?:\/\/\S+/g
      let cursor = 0
      let index = 0
      let match
      while ((match = pattern.exec(text)) !== null) {
        if (match.index > cursor) nodes.push(text.slice(cursor, match.index))
        const token = match[0]
        const key = `${keyPrefix}#${index++}`
        if (token.startsWith('`')) {
          nodes.push(React.createElement('code', { key, style: styles.inlineCode }, token.slice(1, -1)))
        } else if (token.startsWith('**') || token.startsWith('__')) {
          nodes.push(React.createElement('strong', { key, style: styles.bold }, token.slice(2, -2)))
        } else if (token.startsWith('*')) {
          nodes.push(React.createElement('em', { key }, token.slice(1, -1)))
        } else if (token.startsWith('[')) {
          const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token)
          // No href: an in-app preview must not navigate the shell away.
          nodes.push(React.createElement('span', {
            key, style: styles.link, title: link ? link[2] : '',
          }, link ? link[1] : token))
        } else {
          nodes.push(React.createElement('span', { key, style: styles.link, title: token }, token))
        }
        cursor = match.index + token.length
      }
      if (cursor < text.length) nodes.push(text.slice(cursor))
      return nodes
    }

    /** Block structure of one Markdown document. */
    function parseBlocks(text) {
      const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n')
      const blocks = []
      const blank = (line) => /^\s*$/.test(line)
      const listItem = /^\s*(?:[-*+]|\d+[.)])\s+/
      let i = 0
      while (i < lines.length) {
        const line = lines[i]
        if (blank(line)) { i += 1; continue }

        const fence = /^\s*(`{3,}|~{3,})\s*(.*)$/.exec(line)
        if (fence) {
          const marker = fence[1][0]
          const info = fence[2].trim()
          const body = []
          i += 1
          const closing = new RegExp(`^\\s*${marker}{3,}\\s*$`)
          while (i < lines.length && !closing.test(lines[i])) { body.push(lines[i]); i += 1 }
          if (i < lines.length) i += 1
          blocks.push({ kind: 'code', info, text: body.join('\n') })
          continue
        }

        const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
        if (heading) {
          blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2] })
          i += 1
          continue
        }

        if (/^\s*(?:[-*_]\s*){3,}$/.test(line)) { blocks.push({ kind: 'hr' }); i += 1; continue }

        if (/^\s*>/.test(line)) {
          const body = []
          while (i < lines.length && /^\s*>/.test(lines[i])) {
            body.push(lines[i].replace(/^\s*>\s?/, ''))
            i += 1
          }
          blocks.push({ kind: 'quote', text: body.join('\n') })
          continue
        }

        if (listItem.test(line)) {
          const ordered = /^\s*\d+[.)]\s+/.test(line)
          const items = []
          while (i < lines.length && listItem.test(lines[i])) {
            items.push(lines[i].replace(listItem, ''))
            i += 1
            while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !listItem.test(lines[i])) {
              items[items.length - 1] += ` ${lines[i].trim()}`
              i += 1
            }
          }
          blocks.push({ kind: ordered ? 'ol' : 'ul', items })
          continue
        }

        if (line.includes('|') && i + 1 < lines.length
          && /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(lines[i + 1])) {
          const header = splitRow(line)
          i += 2
          const rows = []
          while (i < lines.length && !blank(lines[i]) && lines[i].includes('|')) {
            rows.push(splitRow(lines[i]))
            i += 1
          }
          blocks.push({ kind: 'table', header, rows })
          continue
        }

        const paragraph = [line]
        i += 1
        while (i < lines.length && !blank(lines[i])
          && !/^\s*(?:#{1,6}\s|>|`{3,}|~{3,})/.test(lines[i]) && !listItem.test(lines[i])) {
          paragraph.push(lines[i])
          i += 1
        }
        blocks.push({ kind: 'paragraph', text: paragraph.join('\n') })
      }
      return blocks
    }

    /** Render parsed blocks as React children. */
    function renderMarkdown(text) {
      return parseBlocks(text).map((block, index) => {
        const key = `b${index}`
        if (block.kind === 'heading') {
          return React.createElement(`h${Math.min(block.level + 1, 6)}`, {
            key, style: styles.h(block.level),
          }, inlineNodes(block.text, key))
        }
        if (block.kind === 'code') {
          return React.createElement('pre', { key, style: styles.codeBlock },
            React.createElement('code', null, block.text))
        }
        if (block.kind === 'hr') return React.createElement('hr', { key, style: styles.hr })
        if (block.kind === 'quote') {
          return React.createElement('blockquote', { key, style: styles.quote },
            React.createElement('p', { style: { ...styles.p, margin: 0 } }, inlineNodes(block.text, key)))
        }
        if (block.kind === 'ul' || block.kind === 'ol') {
          return React.createElement(block.kind === 'ul' ? 'ul' : 'ol', { key, style: styles.list_ },
            block.items.map((item, itemIndex) => React.createElement('li', {
              key: `${key}-${itemIndex}`, style: styles.li,
            }, inlineNodes(item, `${key}-${itemIndex}`))))
        }
        if (block.kind === 'table') {
          return React.createElement('table', { key, style: styles.table },
            React.createElement('thead', null,
              React.createElement('tr', null, block.header.map((cell, cellIndex) => React.createElement('th', {
                key: `${key}-h${cellIndex}`, style: styles.th,
              }, inlineNodes(cell, `${key}-h${cellIndex}`))))),
            React.createElement('tbody', null, block.rows.map((row, rowIndex) => React.createElement('tr', {
              key: `${key}-r${rowIndex}`,
            }, row.map((cell, cellIndex) => React.createElement('td', {
              key: `${key}-r${rowIndex}c${cellIndex}`, style: styles.td,
            }, inlineNodes(cell, `${key}-r${rowIndex}c${cellIndex}`)))))))
        }
        return React.createElement('p', { key, style: styles.p }, inlineNodes(block.text, key))
      })
    }

    /** Decorative sidebar glyph: a terminal window. */
    function PanelIcon({ size }) {
      const edge = typeof size === 'number' ? size : 18
      return React.createElement('svg', {
        width: edge, height: edge, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
      },
        React.createElement('rect', { x: 3, y: 4.5, width: 18, height: 15, rx: 2.5 }),
        React.createElement('path', { d: 'M7 9.5l2.5 2.5L7 14.5' }),
        React.createElement('path', { d: 'M12.5 15h4.5' }))
    }

    const inject = ['slots']

    /** Report one JSON blob to the host, which stores it for terminal-side debugging. */
    function reportDiag(payload) {
      const send = () => {
        try {
          const url = `/headless-sessions/diag?data=${encodeURIComponent(JSON.stringify(payload))}`
          const pending = fetch(url, { credentials: 'same-origin', cache: 'no-store' })
          if (pending && typeof pending.catch === 'function') pending.catch(() => {})
        } catch {
          // Diagnostics must never break the panel.
        }
      }
      send()
      // The host records one request per second; send twice so a probe cannot be
      // throttled away by the status poll.
      try {
        setTimeout(send, 1300)
      } catch {
        // No timer (unlikely): the first send already happened.
      }
    }

    function apply(ctx) {
      // The workspace service is what can put a session into the main column.
      // Capture it two ways: synchronously if it is already there, and through
      // `inject` in case this plugin activated before it (or it is replaced later).
      let uiWorkspace
      const readUiWorkspace = () => {
        if (uiWorkspace !== undefined) return uiWorkspace
        try {
          if (typeof ctx.get === 'function') uiWorkspace = ctx.get('uiWorkspace')
          else if (ctx.uiWorkspace !== undefined) uiWorkspace = ctx.uiWorkspace
        } catch {
          uiWorkspace = undefined
        }
        return uiWorkspace
      }
      readUiWorkspace()
      if (typeof ctx.inject === 'function') {
        ctx.inject(['uiWorkspace'], (scoped) => {
          uiWorkspace = scoped.uiWorkspace ?? (typeof scoped.get === 'function' ? scoped.get('uiWorkspace') : undefined)
          return () => { uiWorkspace = undefined }
        })
      }

      /** What this plugin can actually see, for the host-side diag stamp. */
      const probeServices = () => {
        const probe = (name) => {
          try {
            if (typeof ctx.get !== 'function') return 'no-ctx.get'
            const service = ctx.get(name)
            if (service === undefined || service === null) return null
            return Object.keys(service).slice(0, 12)
          } catch (cause) {
            return `throw:${messageOf(cause)}`
          }
        }
        return {
          kind: 'client-probe',
          hasGet: typeof ctx.get,
          uiWorkspaceFound: uiWorkspace !== undefined && uiWorkspace !== null,
          hasInject: typeof ctx.inject,
          probes: {
            uiWorkspace: probe('uiWorkspace'),
            slots: probe('slots'),
            layout: probe('layout'),
            sessions: probe('sessions'),
            workspaces: probe('workspaces'),
            locale: probe('locale'),
          },
          // The client's own view of the world: which sessions it can retain and
          // which workspaces/archives it knows. Handy when a session "cannot open".
          catalogue: catalogueProbe(),
          href: String(globalThis.location?.href ?? ''),
          origin: String(globalThis.location?.origin ?? ''),
        }
      }

      /** Snapshot of the client's session catalogue + workspace registry view. */
      const catalogueProbe = () => {
        const out = {}
        try {
          const sessionsService = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
          const snapshot = sessionsService?.list?.getSnapshot?.() ?? null
          const ids = Array.isArray(snapshot?.ids) ? snapshot.ids : []
          out.sessionCount = ids.length
          out.sessionIds = ids.slice(0, 120)
          out.listPhase = snapshot?.phase ?? null
        } catch (cause) {
          out.sessionsError = messageOf(cause)
        }
        try {
          const workspacesService = typeof ctx.get === 'function' ? ctx.get('workspaces') : undefined
          const archived = workspacesService?.model?.archivedSessionIds ?? workspacesService?.archivedSessionIds
          out.archived = Array.isArray(archived) ? archived.slice(0, 20) : null
          const items = workspacesService?.list?.getSnapshot?.()?.items ?? []
          out.workspaces = items.slice(0, 10).map((item) => ({
            workspaceId: item?.workspaceId ?? null,
            path: item?.path ?? null,
            sessions: Array.isArray(item?.sessionIds) ? item.sessionIds.length : null,
          }))
        } catch (cause) {
          out.workspacesError = messageOf(cause)
        }
        return out
      }
      reportDiag(probeServices())

      /**
       * Make one folder a real workspace — the same call the GUI's "添加工作区"
       * makes (`workspaces.create({ path })`). Sessions created in that folder
       * afterwards get a workspaceId (and stop landing in the ungrouped bucket).
       */
      const normalizePath = (value) => String(value ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
      const workspaceList = (service) => (service?.list?.getSnapshot?.()?.items ?? [])
        .map((item) => ({ id: item?.workspaceId ?? null, path: item?.path ?? null }))
      const ensureWorkspaceFor = async (targetPath) => {
        const service = typeof ctx.get === 'function' ? ctx.get('workspaces') : undefined
        if (service === undefined || typeof service.create !== 'function') {
          reportDiag({ kind: 'ensure-workspace', path: targetPath, error: 'workspaces.create unavailable' })
          return null
        }
        const before = workspaceList(service)
        const existing = before.find((item) => normalizePath(item.path) === normalizePath(targetPath))
        if (existing !== undefined) {
          reportDiag({ kind: 'ensure-workspace', path: targetPath, alreadyExists: true, workspaceId: existing.id, workspaces: before })
          return existing.id
        }
        try {
          const created = await service.create({ path: targetPath })
          reportDiag({ kind: 'ensure-workspace', path: targetPath, created: created?.workspaceId ?? null, workspaces: workspaceList(service) })
          return created?.workspaceId ?? null
        } catch (cause) {
          reportDiag({ kind: 'ensure-workspace', path: targetPath, error: messageOf(cause), workspaces: workspaceList(service) })
          return null
        }
      }
      // NOTE (2026-10-07): a one-shot `ensureWorkspaceFor(...)` ran here once
      // during development. The plugin no longer creates workspaces on its own
      // — the panel exposes the same action as a button on any session whose
      // folder has no workspace.

      /** True when the client's own catalogue already lists this session id. */
      const knownInCatalogue = (sessionId) => {
        try {
          const service = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
          return service?.list?.getSnapshot?.()?.byId?.[sessionId] !== undefined
        } catch {
          return false
        }
      }

      /**
       * Ask the client to re-pull the host's `session/list`. A session created by
       * another process (a headless run) after this app started is missing from the
       * catalogue until the client re-asks, so this is the difference between
       * "read-only forever" and "openable".
       */
      const refreshCatalogue = async () => {
        const service = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
        const manager = service?.manager
        if (manager === undefined || typeof manager.refreshList !== 'function') return false
        try {
          await Promise.resolve(manager.refreshList())
          return true
        } catch {
          return false
        }
      }

      // Temporary one-shot diagnostic: does a catalogue refresh pick up a session
      // created by another process? (id = the 21:30 report run of 2026-10-08)
      // Verified 2026-10-08 21:35: before=true refreshed=true after=true count=74,
      // i.e. the client learns such sessions shortly after creation — the panel now
      // retries the refresh on its own instead of leaving the row read-only.
      // (2026-10-08 21:4x — same behaviour re-verified against a *running* foreign
      // session created by the 21:37 fused report/XXT chain.)

      function Panel() {
        const [list, setList] = React.useState({ phase: 'loading', data: null, error: null })
        const [showAll, setShowAll] = React.useState(false)
        const [selectedId, setSelectedId] = React.useState(null)
        const [doc, setDoc] = React.useState({ status: 'idle', id: null, markdown: '', error: null, truncated: false })
        const [notice, setNotice] = React.useState(null)
        const [manualTick, setManualTick] = React.useState(0)
        const docToken = React.useRef(0)
        const listController = React.useRef(null)
        // If the main column really switched to that session, this panel unmounts.
        const panelAlive = React.useRef(true)
        React.useEffect(() => () => { panelAlive.current = false }, [])

        /**
         * Is this session in the client's own catalogue? The client session
         * controller refuses `retain` for anything else ("unknown session"), and
         * its catalogue only holds sessions this profile created or that are live
         * in this Host process — a headless run is a *different* process/profile,
         * so its sessions are never in there.
         */
        const isKnownSession = (sessionId) => {
          try {
            const service = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
            const snapshot = service?.list?.getSnapshot?.() ?? null
            return snapshot?.byId?.[sessionId] !== undefined
          } catch {
            return false
          }
        }

        /**
         * Archived sessions keep their workspace membership but are dropped from
         * the catalogue the client will retain from — so they need unarchiving
         * first. The client's workspace service owns that registry-global set.
         */
        const isArchivedSession = (sessionId) => {
          try {
            const service = typeof ctx.get === 'function' ? ctx.get('workspaces') : undefined
            // The archive set lives on the client's workspace *model*
            // (`ClientWorkspaceModel.archivedSessionIds`), not on the service itself.
            const archived = service?.model?.archivedSessionIds ?? service?.archivedSessionIds
            return Array.isArray(archived) && archived.includes(sessionId)
          } catch {
            return false
          }
        }

        /** 'known' can open now, 'archived' needs unarchiving first, else foreign. */
        const classifySession = (sessionId) => {
          if (isKnownSession(sessionId)) return 'known'
          if (isArchivedSession(sessionId)) return 'archived'
          return 'foreign'
        }

        /** Refresh the catalogue, then open (or explain exactly why not). */
        const refreshAndOpen = (sessionId, cwd) => {
          setNotice('正在让客户端重新拉取会话列表…')
          Promise.resolve(refreshCatalogue()).then((refreshed) => {
            const known = isKnownSession(sessionId)
            const archived = isArchivedSession(sessionId)
            reportDiag({ kind: 'catalogue-refresh', sessionId, refreshed, known, archived })
            if (archived) {
              unarchiveAndOpen(sessionId, cwd)
              return
            }
            if (!known) {
              setNotice('宿主 session/list 里仍然没有这个会话：外部进程（无头/计划任务）刚建的会话要等宿主重新扫描才会进目录，暂时只能只读预览。')
              return
            }
            openSession(sessionId, cwd)
          })
        }

        /** Unarchive, refresh the catalogue, then open. */
        const unarchiveAndOpen = (sessionId, cwd) => {
          const workspacesService = typeof ctx.get === 'function' ? ctx.get('workspaces') : undefined
          if (workspacesService === undefined || typeof workspacesService.unarchiveSession !== 'function') {
            setNotice('客户端没有 workspaces.unarchiveSession，无法取消归档。')
            return
          }
          setNotice(`正在取消归档 ${sessionId} …`)
          Promise.resolve(workspacesService.unarchiveSession(sessionId)).then((result) => {
            const failed = result !== undefined && result !== null && result.ok === false
            reportDiag({ kind: 'unarchive', sessionId, ok: !failed, error: failed ? result.error : undefined })
            if (failed) {
              setNotice(`取消归档失败：${result.error?.message ?? String(result.error)}`)
              return
            }
            const sessionsService = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
            const refresh = sessionsService?.manager?.refreshList
            const settle = () => openSession(sessionId, cwd)
            try {
              if (typeof refresh === 'function') Promise.resolve(refresh.call(sessionsService.manager)).then(settle, settle)
              else setTimeout(settle, 500)
            } catch {
              setTimeout(settle, 500)
            }
          }).catch((cause) => {
            reportDiag({ kind: 'unarchive', sessionId, ok: false, error: messageOf(cause) })
            setNotice(`取消归档失败：${messageOf(cause)}`)
          })
        }

        /** The workspace whose folder owns this session's cwd, if the client knows it. */
        const findWorkspaceId = (cwd) => {
          const normalized = String(cwd ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
          if (normalized === '') return undefined
          try {
            const service = typeof ctx.get === 'function' ? ctx.get('workspaces') : undefined
            const snapshot = service?.list?.getSnapshot?.()
            for (const item of snapshot?.items ?? []) {
              const path = String(item?.path ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
              if (path !== '' && (normalized === path || normalized.startsWith(`${path}/`))) return item.workspaceId
            }
          } catch {
            return undefined
          }
          return undefined
        }

        /** Did the main view really take this session? Report it, and fall back. */
        const verifyOpen = (sessionId, cwd) => {
          const finish = () => {
            const service = readUiWorkspace()
            // `mainReference` is the workspace service's own pointer at the
            // session shown in the main column — the exact thing to check.
            let mainSessionId = null
            try {
              mainSessionId = service?.mainReference?.sessionId ?? null
            } catch (cause) {
              mainSessionId = `throw:${messageOf(cause)}`
            }
            reportDiag({ kind: 'open-session-result', sessionId, cwd: cwd ?? null, mainSessionId, panelReplaced: panelAlive.current === false })
            if (mainSessionId === sessionId || panelAlive.current === false) {
              setNotice(`已在主视图打开 ${sessionId}`)
              return
            }
            const workspaceId = findWorkspaceId(cwd)
            reportDiag({ kind: 'open-session-fallback', sessionId, cwd: cwd ?? null, workspaceId: workspaceId ?? null })
            if (workspaceId === undefined || service === undefined || typeof service.openWorkspace !== 'function') {
              setNotice('打开未生效：该会话不属于当前工作区，客户端也没找到它的工作区。')
              return
            }
            Promise.resolve(service.openWorkspace(workspaceId)).then(() => {
              service.openSession(sessionId)
              setNotice('已切到该会话所属工作区并打开。')
              reportDiag({ kind: 'open-session-fallback-done', sessionId, workspaceId })
            }).catch((cause) => {
              reportDiag({ kind: 'open-session-fallback-failed', sessionId, workspaceId, error: messageOf(cause) })
              setNotice(`切换工作区失败：${messageOf(cause)}`)
            })
          }
          try {
            setTimeout(finish, 1200)
          } catch {
            finish()
          }
        }

        /** Put one session into the main column (the same call the sidebar uses). */
        const openSession = (sessionId, cwd) => {
          if (!isKnownSession(sessionId)) {
            reportDiag({ kind: 'open-session-unknown', sessionId, cwd: cwd ?? null })
            setNotice('这个会话不在本 GUI 的会话目录里：无头进程是另一个进程 / 另一个 profile 拉起的，DSH 客户端只肯打开自己目录里的会话（sessions.retain: unknown session）。这里只能只读预览。')
            return
          }
          const service = readUiWorkspace()
          if (service === undefined || service === null || typeof service.openSession !== 'function') {
            reportDiag({ kind: 'open-session-missing-service', sessionId, ...probeServices() })
            setNotice('当前客户端没有 uiWorkspace 服务，只能只读预览。')
            return
          }
          try {
            service.openSession(sessionId)
            reportDiag({ kind: 'open-session', sessionId, ok: true })
            setNotice(`已请求在主视图打开 ${sessionId}`)
            verifyOpen(sessionId, cwd)
          } catch (cause) {
            reportDiag({ kind: 'open-session', sessionId, ok: false, error: messageOf(cause) })
            setNotice(`打开失败：${messageOf(cause)}`)
          }
        }

        const loadList = React.useCallback(async (all, signal) => {
          const url = all ? `${STATUS_URL}?all=1` : STATUS_URL
          const result = await getJson(url, signal)
          if (result.aborted) return
          if (!result.ok) {
            setList((current) => ({ phase: current.data === null ? 'error' : 'stale', data: current.data, error: result.error }))
            return
          }
          const value = result.value
          const sessions = Array.isArray(value.sessions) ? value.sessions : []
          setList({
            phase: value.ok === false ? 'stale' : 'ready',
            data: { sessions, generatedAt: value.generatedAt ?? Date.now(), scope: value.scope ?? '', script: value.script ?? '', all: Boolean(value.all) },
            error: value.ok === false ? String(value.error ?? '扫描失败') : null,
          })
        }, [])

        const loadDump = React.useCallback(async (sessionId) => {
          setSelectedId(sessionId)
          const token = docToken.current + 1
          docToken.current = token
          setDoc({ status: 'loading', id: sessionId, markdown: '', error: null, truncated: false })
          const result = await getJson(`${DUMP_URL}?id=${encodeURIComponent(sessionId)}`, undefined)
          if (docToken.current !== token) return
          if (!result.ok) {
            setDoc({ status: 'error', id: sessionId, markdown: '', error: result.error, truncated: false })
            return
          }
          const value = result.value
          if (value.ok === false) {
            setDoc({ status: 'error', id: sessionId, markdown: '', error: String(value.error ?? '导出失败'), truncated: false })
            return
          }
          setDoc({
            status: 'ready', id: sessionId,
            markdown: String(value.markdown ?? ''),
            error: null, truncated: value.truncated === true,
          })
        }, [])

        // Poll the host while the panel is open; pause when the page is hidden.
        React.useEffect(() => {
          const run = async () => {
            if (listController.current !== null) listController.current.abort()
            const controller = new AbortController()
            listController.current = controller
            await loadList(showAll, controller.signal)
          }
          run()
          const timer = window.setInterval(() => {
            if (document.visibilityState === 'hidden') return
            run()
          }, POLL_MS)
          const onVisible = () => { if (document.visibilityState === 'visible') run() }
          document.addEventListener('visibilitychange', onVisible)
          return () => {
            window.clearInterval(timer)
            document.removeEventListener('visibilitychange', onVisible)
            if (listController.current !== null) listController.current.abort()
          }
        }, [showAll, manualTick, loadList])

        const sessions = list.data === null ? [] : list.data.sessions
        const running = sessions.filter((session) => session && session.running === true)
        const others = sessions.filter((session) => !session || session.running !== true)
        const ordered = [...running, ...others]

        // Show the first (running) session's transcript on arrival, once per
        // list identity, so the panel is never an empty box.
        const autoOpened = React.useRef('')
        const lastCatalogueRefresh = React.useRef(0)
        const unknownIds = ordered
          .filter((session) => session && typeof session.id === 'string'
            && !isKnownSession(session.id) && !isArchivedSession(session.id))
          .map((session) => session.id)
        // A headless run's session only enters the client catalogue once the host
        // re-answers `session/list`; ask at most every 15s so those rows turn from
        // "read-only" into a working 「打开会话」 on their own.
        React.useEffect(() => {
          if (unknownIds.length === 0) return
          const now = Date.now()
          if (now - lastCatalogueRefresh.current < 15000) return
          lastCatalogueRefresh.current = now
          reportDiag({ kind: 'auto-catalogue-refresh', unknown: unknownIds.slice(0, 10) })
          refreshCatalogue()
        }, [unknownIds.join(',')])
        React.useEffect(() => {
          if (list.phase === 'loading' || ordered.length === 0) return
          const first = ordered[0]
          if (first === undefined || typeof first.id !== 'string') return
          const key = `${showAll ? 'all' : 'live'}\u0000${first.id}`
          if (autoOpened.current === key) return
          autoOpened.current = key
          loadDump(first.id)
        }, [list, ordered.length, showAll, loadDump])

        const subtitleParts = []
        if (list.data === null) subtitleParts.push('正在读取无头会话…')
        else {
          subtitleParts.push(`运行中的无头会话 ${running.length} 个`)
          if (others.length > 0) subtitleParts.push(`另有 ${others.length} 个最近活动/已结束`)
          subtitleParts.push(`更新于 ${clockOf(list.data.generatedAt)}`)
          if (showAll) subtitleParts.push('范围：最近 50 个会话（按更新时间）')
        }

        let listBody
        if (list.phase === 'error') {
          listBody = React.createElement('div', { style: styles.noticeError },
            `无法读取会话列表：${list.error}`,
            React.createElement('div', { style: { marginTop: 6, color: COLOR.muted } },
              '宿主路由为 GET /headless-sessions/status；若持续失败，检查宿主半是否加载、以及 dsh-session-forensics/find-headless.mjs 是否存在。'))
        } else if (ordered.length === 0) {
          listBody = React.createElement('div', { style: styles.notice },
            showAll ? '没有任何会话记录。' : '当前没有正在运行的无头会话，也没有最近 5 分钟内活动过的会话。')
        } else {
          listBody = ordered.map((session) => {
            const id = typeof session.id === 'string' ? session.id : ''
            const isRunning = session.running === true
            const title = typeof session.title === 'string' && session.title !== '' ? session.title : `${id.slice(0, 8)}…`
            const detail = session.lastTool
              ? `最近动作：${session.lastTool}${session.lastText ? ` — ${String(session.lastText).slice(0, 80)}` : ''}`
              : session.lastText
                ? `最近内容：${String(session.lastText).slice(0, 110)}`
                : session.goal
                  ? `目标：${String(session.goal).slice(0, 110)}`
                  : null
            return React.createElement('button', {
              key: id === '' ? `${session.cwd ?? 'session'}-${session.createdAt ?? ''}` : id,
              type: 'button',
              style: styles.row(id === selectedId),
              title: id,
              onClick: () => loadDump(id),
            },
            React.createElement('span', { style: styles.rowTop },
              React.createElement('span', { style: styles.badge(isRunning) }, isRunning ? `运行中${session.pid ? ` pid=${session.pid}` : ''}` : '最近活动'),
              React.createElement('span', { style: styles.rowTitle }, title)),
            React.createElement('span', { style: styles.rowMeta }, session.cwd ?? '?'),
            React.createElement('span', { style: styles.rowLine },
              `起于 ${clockOf(session.createdAt)} · 更新 ${agoOf(session.lastWrite)}${isRunning ? '' : '（无运行中的无头进程）'}`),
            detail === null ? null : React.createElement('span', { style: styles.rowLine }, detail))
          })
        }

        let previewBody
        if (doc.status === 'idle') {
          previewBody = React.createElement('div', { style: styles.notice },
            '从左侧选择一个会话查看导出的转录。运行中的无头会话排在最前面。')
        } else if (doc.status === 'loading') {
          previewBody = React.createElement('div', { style: styles.notice }, '正在导出该会话…')
        } else if (doc.status === 'error') {
          previewBody = React.createElement('div', { style: styles.noticeError }, `导出失败：${doc.error}`)
        } else {
          previewBody = React.createElement(React.Fragment, null,
            React.createElement('div', { style: styles.markdown }, renderMarkdown(doc.markdown)),
            doc.truncated
              ? React.createElement('div', { style: styles.eofNote }, '转录很长，这里只显示前一部分；完整导出在 dsh-session-forensics/out/ 下。')
              : null)
        }

        const selected = ordered.find((session) => session && session.id === selectedId)

        return React.createElement('div', { style: styles.page },
          React.createElement('header', { style: styles.header },
            React.createElement('div', { style: styles.headerMain },
              React.createElement('h2', { style: styles.title }, PANEL_TITLE),
              React.createElement('div', { style: styles.subtitle }, subtitleParts.join(' · '))),
            React.createElement('div', { style: styles.toolbar },
              React.createElement('button', {
                type: 'button',
                style: showAll ? styles.buttonActive : styles.button,
                title: showAll ? '只看运行中/最近活动' : '列出最近 50 个会话',
                onClick: () => {
                  setShowAll((value) => !value)
                  setSelectedId(null)
                  setDoc({ status: 'idle', id: null, markdown: '', error: null, truncated: false })
                },
              }, showAll ? '全部会话' : '仅运行中/近期'),
              React.createElement('button', {
                type: 'button', style: styles.button,
                onClick: () => setManualTick((value) => value + 1),
              }, '刷新'))),
          list.phase === 'stale' && list.error !== null
            ? React.createElement('div', { style: styles.noticeError }, `上次刷新失败（显示缓存结果）：${list.error}`)
            : null,
          React.createElement('div', { style: styles.body },
            React.createElement('aside', { style: styles.list }, listBody),
            React.createElement('section', { style: styles.preview },
              doc.status === 'idle' || selected === undefined ? null : React.createElement('div', { style: styles.docHead },
                React.createElement('span', { style: styles.docPath }, selected.title ? `${selected.title} · ${selected.id}` : selected.id),
                React.createElement('span', { style: styles.docActions },
                  React.createElement('span', { style: styles.docMeta },
                    `${selected.running === true ? '运行中' : '未运行'} · ${clockOf(selected.createdAt)} · ${formatSize(selected.size)}`),
                  classifySession(selected.id) === 'known'
                    ? React.createElement('button', {
                      type: 'button', style: styles.button,
                      title: '把这个会话放进主视图，等同于点侧栏里的会话',
                      onClick: () => openSession(selected.id, selected.cwd),
                    }, '打开会话')
                    : classifySession(selected.id) === 'archived'
                      ? React.createElement('button', {
                        type: 'button', style: styles.button,
                        title: '该会话已归档：归档后客户端目录里就没有它了，先取消归档再打开',
                        onClick: () => unarchiveAndOpen(selected.id, selected.cwd),
                      }, '取消归档并打开')
                      : React.createElement('span', { style: styles.docActions },
                        React.createElement('span', {
                          style: styles.docMeta,
                          title: '该会话不在本 GUI 的会话目录里：DSH 客户端拒绝 retain 不认识的会话。可能是外部进程刚建、宿主还没重新扫描。',
                        }, '暂时只读'),
                        React.createElement('button', {
                          type: 'button', style: styles.button,
                          title: '让客户端重新拉取宿主会话列表；若宿主已经认识它，就能打开',
                          onClick: () => refreshAndOpen(selected.id, selected.cwd),
                        }, '刷新目录并打开')),
                  selected.cwd !== undefined && findWorkspaceId(selected.cwd) === undefined
                    ? React.createElement('button', {
                      type: 'button', style: styles.button,
                      title: '把这个目录登记成工作区（等同桌面端「添加工作区」），之后在该目录新建的会话会带 workspaceId',
                      onClick: () => {
                        setNotice(`正在把 ${selected.cwd} 登记成工作区…`)
                        ensureWorkspaceFor(selected.cwd).then((workspaceId) => {
                          setNotice(workspaceId === null
                            ? `建工作区失败：${selected.cwd}（详见诊断回报）`
                            : `已把 ${selected.cwd} 登记成工作区（${workspaceId}）`)
                        })
                      },
                    }, '把这个目录建成工作区')
                    : null)),
              notice === null ? null : React.createElement('div', { style: styles.notice }, notice),
              previewBody)))
      }

      // ---- seats --------------------------------------------------------

      ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 20,
        label: () => ENTRY_LABEL,
      }, PanelIcon)), 'headless-sessions: sidebar entry')

      ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
      }, Panel)), 'headless-sessions: main panel')
    }

    exports.PANEL_ID = PANEL_ID
    exports.apply = apply
    exports.inject = inject
    // Pure helpers kept reachable for the offline smoke test.
    exports.__internals = { parseBlocks, renderMarkdown, clockOf, agoOf, formatSize }

    return module.exports
  },
})
