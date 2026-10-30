// Offline smoke test for dsh-plugin-headless-sessions-panel's browser half.
//
// It loads lib/client.js inside a fake `window.__ModuleLoader__`, drives the
// plugin with a fake Cordis context plus a mini React runtime (state, effects,
// refs) and a fake `fetch`, and asserts:
//   1. the two seats are registered under the ids the sidebar and layout dispatch;
//   2. the panel polls GET /headless-sessions/status, puts running headless
//      sessions first and labels them as running;
//   3. opening a row (and the automatic first open) fetches
//      GET /headless-sessions/dump and renders the returned Markdown;
//   4. a failing host route is reported in the UI instead of throwing;
//   5. the Markdown parser handles the constructs the panel claims to support.
//
// Run: node test/smoke.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

// ---- mini React ----------------------------------------------------------
const Fragment = Symbol('Fragment')
let cells = []
let cursor = 0
let dirty = false
let pendingEffects = []

function createElement(type, props, ...children) {
  return {
    type,
    props: {
      ...(props ?? {}),
      children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false),
    },
  }
}

function useState(initial) {
  const index = cursor++
  if (cells.length <= index) cells[index] = typeof initial === 'function' ? initial() : initial
  const set = (next) => {
    const value = typeof next === 'function' ? next(cells[index]) : next
    if (value !== cells[index]) {
      cells[index] = value
      dirty = true
    }
  }
  return [cells[index], set]
}

function sameDeps(left, right) {
  if (left === undefined || right === undefined) return false
  if (left.length !== right.length) return false
  return left.every((value, position) => value === right[position])
}

function useEffect(callback, deps) {
  const index = cursor++
  const previous = cells[index]
  if (previous === undefined || !sameDeps(previous.deps, deps)) {
    cells[index] = { deps }
    pendingEffects.push(callback)
  }
}

const React = {
  Fragment,
  createElement,
  useState,
  useEffect,
  useRef: (initial) => {
    const index = cursor++
    if (cells[index] === undefined) cells[index] = { current: initial }
    return cells[index]
  },
  useMemo: (factory, deps) => {
    const index = cursor++
    const previous = cells[index]
    if (previous === undefined || !sameDeps(previous.deps, deps)) cells[index] = { deps, value: factory() }
    return cells[index].value
  },
  useCallback: (callback, deps) => {
    const index = cursor++
    const previous = cells[index]
    if (previous === undefined || !sameDeps(previous.deps, deps)) cells[index] = { deps, value: callback }
    return cells[index].value
  },
}

// ---- browser globals the panel touches -----------------------------------
let loaded = null
globalThis.window = {
  __ModuleLoader__: { load: (definition) => { loaded = definition } },
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle),
}
globalThis.document = {
  visibilityState: 'visible',
  addEventListener: () => {},
  removeEventListener: () => {},
}

// ---- fake host routes ----------------------------------------------------
const REQUESTS = []
let statusBody = {
  ok: true,
  all: false,
  scope: '正在运行的无头会话 + 最近 5 分钟内活动过的会话',
  script: 'E:/ws/dsh-session-forensics/find-headless.mjs',
  generatedAt: Date.parse('2026-10-07T17:00:00+08:00'),
  sessions: [
    {
      id: 'session-idle-2222', cwd: 'E:\\冯诺依曼工作区', createdAt: Date.parse('2026-10-07T16:00:00+08:00'),
      lastWrite: Date.parse('2026-10-07T16:50:00+08:00'), size: 1024, pid: null, running: false,
      activeRecently: true, title: '已结束的会话', goal: null, lastText: '收尾', lastTool: 'bash',
    },
    {
      id: 'session-run-1111', cwd: 'E:\\deepseek-harness\\default-workspace', createdAt: Date.parse('2026-10-07T16:30:00+08:00'),
      lastWrite: Date.parse('2026-10-07T17:00:00+08:00'), size: 2048, pid: 12345, running: true,
      activeRecently: true, title: null, goal: null, lastText: '正在扫描', lastTool: 'grep',
    },
    {
      id: 'session-foreign-3333', cwd: 'E:\\冯诺依曼工作区', createdAt: Date.parse('2026-10-07T15:00:00+08:00'),
      lastWrite: Date.parse('2026-10-07T15:30:00+08:00'), size: 512, pid: null, running: false,
      activeRecently: false, title: '外部无头会话', goal: null, lastText: null, lastTool: null,
    },
    {
      // The 2026-10-30 regression shape: present in session/list AND archived.
      id: 'session-both-4444', cwd: 'E:\\deepseek-harness\\default-workspace', createdAt: Date.parse('2026-10-07T14:00:00+08:00'),
      lastWrite: Date.parse('2026-10-07T14:30:00+08:00'), size: 640, pid: null, running: false,
      activeRecently: false, title: null, firstText: '帮我修复这个归档 bug', displayTitle: '帮我修复这个归档 bug',
      goal: null, lastText: null, lastTool: null,
    },
  ],
}
let dumpBody = {
  ok: true,
  id: 'session-run-1111',
  markdown: '# DSH 会话 session-run-1111\n\n## USER (user)\n\n跑一下 **forensics**\n\n## ASSISTANT\n\n```text\ndone\n```\n',
  truncated: false,
}
let failNext = false

globalThis.fetch = async (url) => {
  REQUESTS.push(String(url))
  if (failNext) return { ok: false, status: 502, text: async () => JSON.stringify({ ok: false, error: 'scanner exploded' }) }
  const body = String(url).startsWith('/headless-sessions/dump') ? dumpBody : statusBody
  return { ok: true, status: 200, text: async () => JSON.stringify(body) }
}

new Function('window', source)(globalThis.window)
assert.ok(loaded, 'client.js must call window.__ModuleLoader__.load')
assert.equal(loaded.id, 'dsh-plugin-headless-sessions-panel')

const plugin = loaded.factory((name) => {
  if (name === 'react') return React
  throw new Error(`unexpected require(${name})`)
})
assert.deepEqual(plugin.inject, ['slots'])

// ---- fake client context -------------------------------------------------
const registrations = []
const openedSessions = []
const unarchivedSessions = []
let refreshCalls = 0
let archivedIds = ['session-idle-2222', 'session-both-4444']
const ctx = {
  slots: {
    inject: (slot, factory) => factory(),
    register: (options, component) => { registrations.push({ options, component }); return () => {} },
  },
  effect: (callback) => callback(),
  get: (name) => {
    if (name === 'uiWorkspace') return { openSession: (id) => openedSessions.push(id) }
    // `session-both-4444` reproduces the 2026-10-30 bug: the Host's session/list
    // does NOT filter archived Sessions, so it is in the catalogue AND in the
    // archive set at the same time. `session-idle-2222` is archived and absent
    // from the catalogue; `session-foreign-3333` stands for a session another
    // process/profile created.
    if (name === 'sessions') {
      return {
        list: {
          getSnapshot: () => ({
            byId: {
              'session-run-1111': { id: 'session-run-1111' },
              'session-both-4444': { id: 'session-both-4444' },
            },
          }),
        },
        manager: { refreshList: async () => { refreshCalls += 1 } },
      }
    }
    if (name === 'workspaces') {
      return {
        // The archive set lives on the client workspace model, not the service.
        model: { archivedSessionIds: [...archivedIds] },
        unarchiveSession: async (id) => {
          unarchivedSessions.push(id)
          // The real client installs the Host's new archive set on the reply.
          const at = archivedIds.indexOf(id)
          if (at >= 0) archivedIds.splice(at, 1)
          return { ok: true, value: { archivedSessionIds: [...archivedIds] } }
        },
      }
    }
    return undefined
  },
}

plugin.apply(ctx)
const panellist = registrations.find((entry) => entry.options.name === 'sidebar.panellist')
const main = registrations.find((entry) => entry.options.name === 'main')
assert.ok(panellist, 'sidebar.panellist must be registered')
assert.equal(panellist.options.id, 'headless-sessions')
assert.equal(panellist.options.label(), '无头会话')
assert.ok(main, 'main must be registered')
assert.equal(main.options.key, 'headless-sessions')

const icon = panellist.component({ size: 16, active: false })
assert.equal(icon.type, 'svg')
assert.equal(icon.props.width, 16)

async function settle(Component, props) {
  let tree
  for (let pass = 0; pass < 24; pass += 1) {
    cursor = 0
    pendingEffects = []
    dirty = false
    tree = Component(props)
    for (const effect of pendingEffects) effect()
    await new Promise((resolve) => setTimeout(resolve, 0))
    if (!dirty) return tree
  }
  throw new Error('panel did not settle')
}

function textOf(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const child of node) textOf(child, out); return out }
  if (typeof node === 'object') { textOf(node.props?.children, out); return out }
  return out
}

function findAll(node, predicate, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (Array.isArray(node)) { for (const child of node) findAll(child, predicate, out); return out }
  if (typeof node === 'object') {
    if (predicate(node)) out.push(node)
    findAll(node.props?.children, predicate, out)
  }
  return out
}

const tree = await settle(main.component, {})
const text = textOf(tree).join('\n')

assert.ok(REQUESTS.some((url) => url === '/headless-sessions/status'), 'the panel must poll the status route')
assert.ok(text.includes('运行中的无头会话 1 个'), `subtitle counts running sessions: ${text.slice(0, 200)}`)
assert.ok(text.includes('运行中 pid=12345'), 'the running session carries a running badge with its pid')
assert.ok(text.includes('最近活动'), 'the non-running session is labelled as recently active')
assert.ok(text.includes('E:\\deepseek-harness\\default-workspace'), 'the cwd is shown')
// Running sessions sort first, and the first row is auto-opened.
assert.ok(REQUESTS.some((url) => url.startsWith('/headless-sessions/dump?id=session-run-1111')), 'the first running session is auto-opened')
assert.ok(text.includes('跑一下'), 'the exported transcript is rendered')
assert.ok(text.includes('done'), 'a fenced block keeps its body')
assert.ok(findAll(tree, (node) => node.type === 'strong').length >= 1, 'bold text renders as <strong>')
assert.equal(findAll(tree, (node) => node.type === 'a').length, 0, 'links must not be anchors')

// The panel can hand the session to the workspace service (open it for real).
const openButton = findAll(tree, (node) => node.type === 'button' && textOf(node).join('') === '打开会话')[0]
assert.ok(openButton, 'the panel offers an open-session action')
openButton.props.onClick()
assert.deepEqual(openedSessions, ['session-run-1111'], 'the open action targets the selected session')

// Clicking the second row reads *its* session.
const secondRow = findAll(tree, (node) => node.type === 'button' && textOf(node).join('').includes('已结束的会话'))[0]
assert.ok(secondRow, 'the second session row exists')
dumpBody = { ok: true, id: 'session-idle-2222', markdown: '# 已结束会话\n\n收尾完成。', truncated: true }
secondRow.props.onClick()
await new Promise((resolve) => setTimeout(resolve, 0))
const tree2 = await settle(main.component, {})
assert.ok(REQUESTS.some((url) => url.startsWith('/headless-sessions/dump?id=session-idle-2222')), 'clicking a row reads that session')
assert.ok(textOf(tree2).join('\n').includes('收尾完成。'), 'the clicked transcript replaces the preview')
assert.ok(textOf(tree2).join('\n').includes('转录很长'), 'a truncated transcript is called out')
// Archived session: membership kept, catalogue dropped it — offer unarchive, not a dead button.
assert.ok(textOf(tree2).join('\n').includes('取消归档并打开'), 'an archived session offers unarchive-and-open')
assert.equal(findAll(tree2, (node) => node.type === 'button' && textOf(node).join('') === '打开会话').length, 0,
  'no plain open button while the session is archived')
const unarchiveButton = findAll(tree2, (node) => node.type === 'button' && textOf(node).join('') === '取消归档并打开')[0]
unarchiveButton.props.onClick()
await new Promise((resolve) => setTimeout(resolve, 800))
assert.deepEqual(unarchivedSessions, ['session-idle-2222'], 'unarchive targets the selected session')

// ---- 2026-10-30 regression: archived AND in the catalogue ------------------
// The Host's session/list does not filter archived Sessions, so an archived
// row is also "known". Classifying "known" first produced a plain 「打开会话」
// button: it opened, then the client's clearArchivedCurrent() dropped the main
// view again ~30s later. Archived must win over known.
const bothRow = findAll(tree2, (node) => node.type === 'button' && textOf(node).join('').includes('帮我修复这个归档 bug'))[0]
assert.ok(bothRow, 'the archived-but-known session row exists')
assert.ok(!textOf(bothRow).join('').includes('session-both'), 'the row shows its name, not just the id')
bothRow.props.onClick()
await new Promise((resolve) => setTimeout(resolve, 0))
const treeBoth = await settle(main.component, {})
const bothText = textOf(treeBoth).join('\n')
assert.ok(bothText.includes('取消归档并打开'),
  `an archived session that is ALSO in the catalogue still offers unarchive-and-open: ${bothText.slice(0, 300)}`)
assert.equal(findAll(treeBoth, (node) => node.type === 'button' && textOf(node).join('') === '打开会话').length, 0,
  'no plain open button for an archived session, even when the catalogue knows it')
const bothUnarchive = findAll(treeBoth, (node) => node.type === 'button' && textOf(node).join('') === '取消归档并打开')[0]
assert.ok(bothUnarchive, 'the archived-but-known row exposes the unarchive action')
const openedBeforeBoth = openedSessions.length
bothUnarchive.props.onClick()
await new Promise((resolve) => setTimeout(resolve, 800))
assert.ok(unarchivedSessions.includes('session-both-4444'), 'unarchive targets the archived-but-known session')
assert.ok(openedSessions.length > openedBeforeBoth, 'after unarchiving, the session is opened')
assert.equal(openedSessions.filter((id) => id === 'session-both-4444').length, 1,
  'the session is opened exactly once (no unarchive/open loop)')

// A session from another process/profile is offered read-only instead of a broken button.
const foreignRow = findAll(tree2, (node) => node.type === 'button' && textOf(node).join('').includes('外部无头会话'))[0]
assert.ok(foreignRow, 'the foreign session row exists')
foreignRow.props.onClick()
await new Promise((resolve) => setTimeout(resolve, 0))
const tree3 = await settle(main.component, {})
const text3 = textOf(tree3).join('\n')
assert.ok(text3.includes('暂时只读'), 'a session missing from the catalogue is labelled read-only')
const retryButton = findAll(tree3, (node) => node.type === 'button' && textOf(node).join('') === '刷新目录并打开')[0]
assert.ok(retryButton, 'such a session still offers refresh-and-open')
const refreshBefore = refreshCalls
retryButton.props.onClick()
await new Promise((resolve) => setTimeout(resolve, 50))
assert.ok(refreshCalls > refreshBefore, 'the retry asks the client to re-pull the catalogue')
await new Promise((resolve) => setTimeout(resolve, 0))
const tree4 = await settle(main.component, {})
assert.ok(textOf(tree4).join('\n').includes('宿主 session/list 里仍然没有这个会话'), 'a still-unknown session explains itself')
assert.equal(findAll(tree3, (node) => node.type === 'button' && textOf(node).join('') === '打开会话').length, 0,
  'no plain open button for a session the client cannot retain')

// A failing host route is surfaced, not thrown.
failNext = true
const refresh = findAll(tree2, (node) => node.type === 'button' && textOf(node).join('') === '刷新')[0]
assert.ok(refresh, 'the panel offers a refresh action')
refresh.props.onClick()
await new Promise((resolve) => setTimeout(resolve, 0))
const failingTree = await settle(main.component, {})
const failingText = textOf(failingTree).join('\n')
assert.ok(failingText.includes('scanner exploded') || failingText.includes('上次刷新失败'),
  `a failing route is reported to the user: ${failingText.slice(0, 200)}`)
failNext = false

// ---- parser unit checks --------------------------------------------------
const { parseBlocks, clockOf, agoOf, formatSize } = plugin.__internals
assert.equal(clockOf(Date.parse('2026-10-07T05:04:05+08:00')), '05:04:05')
assert.equal(clockOf(null), '—')
assert.ok(/分钟前$|秒前$|小时前$/.test(agoOf(Date.now() - 5 * 60 * 1000)))
assert.equal(formatSize(2048), '2.0 KB')
assert.equal(formatSize(undefined), '')
assert.deepEqual(parseBlocks('> 引用\n> 续行').map((block) => block.kind), ['quote'])
assert.deepEqual(parseBlocks('| a | b |\n| --- | --- |\n| 1 | 2 |').map((block) => block.kind), ['table'])
assert.deepEqual(parseBlocks('1. 一\n2. 二').map((block) => block.kind), ['ol'])
assert.deepEqual(parseBlocks('---').map((block) => block.kind), ['hr'])
assert.deepEqual(parseBlocks('## 标题').map((block) => ({ kind: block.kind, level: block.level })), [{ kind: 'heading', level: 2 }])

console.log('smoke: OK — seats registered, status polled, running headless session listed and its transcript previewed')
// The panel's real poll interval outlives the shim; end the run deterministically.
process.exit(0)
