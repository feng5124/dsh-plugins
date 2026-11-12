// dsh-smart-mail — browser half.
//
// Contributes the 「智能邮箱」 management page under Settings → Plugins
// (settings.plugins.tab). 信息架构按使用频率重排（2026-11-07 UI 重整）：
//   ① 账号 + 白名单（含测试/拦截记录）→ ② 轮询间隔 → ③ 模型 → ④ 唤醒目标
//   → ⑤ 线程续接/附件/日志轮转等低频项（默认折叠，点开才展开）。
// All data flows through the Host half's same-origin routes under /smart-mail/*.
window.__ModuleLoader__.load({
  id: 'dsh-smart-mail',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef } = React
    const MAX_WIDTH = 1040

    const API = '/smart-mail'
    const TAB_ID = 'smart-mail'
    const TAB_LABEL = '智能邮箱'

    const COLOR = {
      surface: 'var(--dsw-alias-bg-base)',
      raised: 'var(--dsw-alias-bg-layer-1)',
      nested: 'var(--dsw-alias-bg-layer-2)',
      border: 'var(--dsw-alias-border-l1)',
      text: 'var(--dsw-alias-label-primary)',
      muted: 'var(--dsw-alias-label-secondary)',
      accent: 'var(--dsw-alias-brand-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      ok: 'var(--dsw-alias-state-success-primary)',
    }

    const styles = {
      page: {
        boxSizing: 'border-box', height: '100%', overflowY: 'auto', padding: '28px 28px 64px',
        background: COLOR.surface, color: COLOR.text,
        font: '13px/1.6 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif',
      },
      content: { maxWidth: MAX_WIDTH, margin: '0 auto' },
      title: { margin: '0 0 5px', fontSize: 22, fontWeight: 650, letterSpacing: '-0.02em' },
      subtitle: { color: COLOR.muted, fontSize: 13, margin: 0, lineHeight: 1.7 },
      section: {
        background: COLOR.raised, border: `1px solid ${COLOR.border}`, borderRadius: 12,
        padding: '20px', marginBottom: 16,
      },
      sectionTitle: { margin: 0, fontSize: 15, fontWeight: 600 },
      sectionHead: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, marginBottom: 16 },
      row: { display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 },
      label: { flex: '0 0 120px', color: COLOR.muted, fontSize: 12 },
      card: { background: COLOR.nested, border: `1px solid ${COLOR.border}`, borderRadius: 10, padding: '14px 16px' },
      input: {
        flex: '1 1 260px', minWidth: 0, boxSizing: 'border-box', padding: '8px 11px', borderRadius: 8,
        border: `1px solid ${COLOR.border}`, background: COLOR.nested, color: 'inherit', font: 'inherit',
      },
      button: {
        cursor: 'pointer', padding: '7px 13px', borderRadius: 8, border: `1px solid ${COLOR.border}`,
        background: COLOR.raised, color: 'inherit', font: 'inherit', whiteSpace: 'nowrap',
      },
      buttonPrimary: {
        cursor: 'pointer', padding: '7px 13px', borderRadius: 8, border: `1px solid ${COLOR.accent}`,
        background: COLOR.nested, color: COLOR.text, font: 'inherit', whiteSpace: 'nowrap',
      },
      notice: { padding: '8px 12px', borderRadius: 8, fontSize: 12, marginTop: 8, overflowWrap: 'anywhere' },
      noticeOk: { color: COLOR.ok, background: COLOR.nested },
      noticeError: { color: COLOR.error, background: COLOR.nested },
      accountRow: {
        display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 8,
        border: `1px solid ${COLOR.border}`, marginBottom: 8, background: COLOR.nested,
      },
      accountMain: { flex: '1 1 auto', minWidth: 0 },
      accountAddress: { fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      accountMeta: { color: COLOR.muted, fontSize: 11, fontFamily: 'ui-monospace, Consolas, monospace' },
      badge: (on) => ({
        flex: '0 0 auto', fontSize: 10, lineHeight: '16px', padding: '0 6px', borderRadius: 6,
        border: `1px solid ${on ? COLOR.ok : COLOR.border}`, color: on ? COLOR.ok : COLOR.muted,
      }),
      log: {
        fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 11, lineHeight: 1.7,
        maxHeight: 260, overflowY: 'auto', background: COLOR.nested, borderRadius: 8,
        border: `1px solid ${COLOR.border}`, padding: '8px 10px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
      },
      help: { color: COLOR.muted, fontSize: 11, lineHeight: 1.7, marginTop: 4 },
      switchWrap: { display: 'inline-flex', alignItems: 'center', gap: 8 },
      stepButton: {
        cursor: 'pointer', width: 28, height: 28, flex: '0 0 auto', padding: 0, borderRadius: 8,
        border: `1px solid ${COLOR.border}`, background: COLOR.nested, color: 'inherit',
        font: '14px/1 inherit', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      },
      /** 可折叠区块的标题行：整行可点，右侧箭头随开合转向。 */
      toggleRow: {
        display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', userSelect: 'none',
        margin: '0 0 10px', fontSize: 14, fontWeight: 600,
      },
      toggleArrow: { fontSize: 10, color: COLOR.muted, width: 12 },
      toggleHint: { fontWeight: 400, fontSize: 11, color: COLOR.muted },
    }

    async function api(path, init) {
      const response = await fetch(API + path, {
        ...init,
        headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
      })
      return await response.json()
    }

    function Field({ label, children }) {
      return h('div', { style: styles.row },
        h('div', { style: styles.label }, label),
        children)
    }

    function SectionHeading({ title, description, action }) {
      return h('div', { style: styles.sectionHead },
        h('div', null,
          h('h2', { style: styles.sectionTitle }, title),
          description ? h('div', { style: { ...styles.subtitle, marginTop: 4 } }, description) : null),
        action ?? null)
    }

    function Toggle({ on, onClick, label, disabled = false }) {
      return h('button', {
        type: 'button', role: 'switch', 'aria-checked': on, disabled,
        'aria-label': label,
        onClick,
        style: {
          position: 'relative', flex: '0 0 auto', width: 36, height: 20, padding: 0,
          borderRadius: 10, border: `1px solid ${on ? COLOR.accent : COLOR.border}`,
          background: on ? COLOR.accent : COLOR.nested,
          cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1,
        },
      }, h('span', {
        'aria-hidden': true,
        style: {
          position: 'absolute', top: 2, left: on ? 18 : 2, width: 14, height: 14,
          borderRadius: '50%', background: on ? COLOR.raised : COLOR.muted,
          transition: 'left 140ms ease',
        },
      }))
    }

    function SettingRow({ title, description, on, onToggle, disabled = false, children }) {
      return h('div', {
        style: {
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 18,
          padding: '14px 0', borderTop: `1px solid ${COLOR.border}`,
        },
      },
        h('div', { style: { flex: '1 1 auto', minWidth: 0 } },
          h('div', { style: { fontWeight: 500 } }, title),
          h('div', { style: { ...styles.help, marginTop: 3 } }, description),
          children ?? null),
        onToggle ? h(Toggle, { on, onClick: onToggle, label: title, disabled }) : null)
    }

    /**
     * 可折叠区块：低频高级设置用。折叠时只显示标题 + 一句提示。
     *
     * 用原生 `<button type="button">` 作标题行（而不是给 div 加 role=button）：
     * 原生按钮自带 Tab 焦点、Enter/Space 激活与屏幕阅读器语义，不需要再补
     * tabIndex 和键盘事件（2026-11-07 打回项 A4）。
     */
    function CollapsibleSection({ title, hint, defaultOpen = false, onOpen, children }) {
      const [open, setOpen] = useState(defaultOpen)
      const toggle = () => {
        setOpen((previous) => {
          const next = !previous
          if (next && onOpen !== undefined) onOpen()
          return next
        })
      }
      return h('div', { style: styles.section },
        h('button', {
          type: 'button',
          style: { ...styles.toggleRow, background: 'transparent', border: 0, padding: 0, width: '100%', textAlign: 'left', color: 'inherit', font: 'inherit' },
          'aria-expanded': open,
          onClick: toggle,
        },
          h('span', { style: styles.toggleArrow, 'aria-hidden': true }, open ? '▾' : '▸'),
          title,
          open ? null : h('span', { style: styles.toggleHint }, hint ?? '')),
        open ? children : null)
    }

    /**
     * Where a mail-triggered Session starts.
     *
     * The Workspace list comes from the Host's live registry (`/workspaces`), so
     * the panel offers exactly the groups this installation actually has — no
     * path is hardcoded here, which is what makes the same package work on any
     * machine. `未分组` is a real choice, not the absence of one: a Host with no
     * registered Workspace still has to place the Session somewhere.
     *
     * @param {object} props
     * @param {{workspaces: object[], defaultWorkspaceId: string|null}|null} props.catalog
     * @param {{mode: string, workspaceId?: string, cwd?: string}} props.value
     * @param {(next: object) => void} props.onChange
     */
    function WakeTargetPicker({ catalog, value, onChange }) {
      const mode = value?.mode ?? 'default'
      const workspaces = catalog?.workspaces ?? []
      const defaultName = workspaces.find((w) => w.id === catalog?.defaultWorkspaceId)?.title ?? workspaces[0]?.title
      const selectedWorkspace = value?.workspaceId !== undefined && workspaces.some((w) => w.id === value.workspaceId)
        ? value.workspaceId
        : (workspaces[0]?.id ?? '')

      const MODE_LABELS = [
        ['default', defaultName === undefined ? '默认工作区（Host 未登记工作区）' : `默认工作区（${defaultName}）`],
        ['workspace', '指定工作区'],
        ['ungrouped', '未分组（不加入任何工作区）'],
        ['cwd', '自定义目录（目录填在下方“唤醒工作目录”）'],
      ]

      // "未分组" is a membership answer, not a folder — say BOTH, so "where is
      // my file" has an answer before the first wake happens.
      const explained = catalog?.explained

      return h('div', null,
        h(Field, { label: '唤醒到' },
          h('select', {
            style: styles.input,
            value: mode,
            onChange: (e) => {
              const next = e.target.value
              if (next === 'workspace') onChange({ mode: next, workspaceId: selectedWorkspace || undefined })
              else onChange({ mode: next })
            },
          }, MODE_LABELS.map(([id, label]) => h('option', { key: id, value: id }, label)))),
        mode === 'workspace'
          ? h(Field, { label: '工作区' },
            workspaces.length === 0
              ? h('span', { style: styles.help }, '这台 Host 没有登记任何工作区；请在 DSH 侧栏新建一个，或改选其它模式。')
              : h('select', {
                style: styles.input,
                value: selectedWorkspace,
                onChange: (e) => onChange({ mode: 'workspace', workspaceId: e.target.value }),
              }, workspaces.map((w) => h('option', { key: w.id, value: w.id }, `${w.title} — ${w.path}`))))
          : null,
        h('div', { style: styles.row },
          h('div', { style: styles.label }),
          h('span', { style: styles.help },
            mode === 'default'
              ? '跟随 DSH 的默认工作区身份（首次使用登记的那个）；该身份缺失时用登记顺序里的第一个。'
              : mode === 'ungrouped'
                ? '会话不加入任何工作区，在侧栏「未分组」下出现；文件仍按 cwd 归档到 DSH 的 sessions 目录（见下方落点）。'
                : mode === 'cwd'
                  ? '用下面「唤醒工作目录」里填的绝对路径，工作区成员关系不参与。'
                  : '会话直接创建在所选工作区里，与会话页“新建会话”的位置一致。')),
        // Concrete landing spot: group + directory + the sessions subfolder.
        explained === undefined || explained === null
          ? null
          : h('div', { style: { ...styles.row, marginTop: -2 } },
            h('div', { style: styles.label }, '实际落点'),
            h('span', { style: styles.help },
              `分组：${explained.group}`,
              explained.directory === null || explained.directory === undefined ? null : h('br'),
              explained.directory === null || explained.directory === undefined ? null : `目录：${explained.directory}`,
              explained.projectDirectory === null || explained.projectDirectory === undefined ? null : h('br'),
              explained.projectDirectory === null || explained.projectDirectory === undefined ? null : `会话文件：%DSH_HOME%\\sessions\\${explained.projectDirectory}\\`)),
      )
    }

    /**
     * A number field that can actually be typed into.
     *
     * A plain controlled `<input type="number">` bound to a number cannot be
     * retyped: clearing it yields `''`, `Number('') || fallback` immediately
     * rewrites the fallback, and the periodic status refresh overwrites whatever
     * is in flight. The result is that the only usable gesture is the spinner
     * arrow, one step at a time.
     *
     * So the draft is kept as *text* while the user types, and only parsed and
     * clamped on commit (blur or Enter). While the field is focused the parent's
     * refresh value is ignored, so a poll landing mid-edit cannot clobber it.
     *
     * The pure rules live in ./number-field.mjs (and are unit-tested there); this
     * component is the DOM binding for them. The client bundle cannot import a
     * sibling .mjs, so the same few lines are repeated here — keep them in step.
     *
     * @param {object} props
     * @param {string} props.label field label
     * @param {number} props.value committed value
     * @param {(next: number) => void} props.onCommit called with the clamped value
     * @param {number} props.min minimum accepted value
     * @param {number} [props.max] maximum accepted value
     * @param {number} [props.step] step-button size
     * @param {string} [props.unit] suffix shown after the field
     * @param {string} [props.width] flex basis for the input
     */
    function NumberField({ label, value, onCommit, min, max, step = 1, unit, width = '0 0 100px' }) {
      const [draft, setDraft] = useState(String(value))
      const [editing, setEditing] = useState(false)

      // Follow the committed value only while the field is not being edited.
      useEffect(() => {
        if (!editing) setDraft(String(value))
      }, [value, editing])

      const parseDraft = (raw) => {
        const text = String(raw ?? '').trim()
        if (text === '') return null
        const parsed = Number(text)
        if (!Number.isFinite(parsed)) return null
        let next = Math.trunc(parsed)
        if (next < min) next = min
        if (max !== undefined && next > max) next = max
        return next
      }

      // Commit a resolved value: show it, and persist only when it changed.
      const apply = (next) => {
        setDraft(String(next))
        if (next !== value) onCommit(next)
      }

      const commit = () => {
        setEditing(false)
        const next = parseDraft(draft)
        if (next === null) {
          // Blank or not a number: restore the committed value, never guess.
          setDraft(String(value))
          return
        }
        apply(next)
      }

      const nudge = (direction) => {
        // Step from whatever is typed, and clamp *after* stepping: clamping the
        // partial draft first would turn "1" into min and then add the step.
        const text = String(draft ?? '').trim()
        const typed = text !== '' && Number.isFinite(Number(text)) ? Math.trunc(Number(text)) : null
        const base = typed ?? value
        let next = base + direction * step
        if (next < min) next = min
        if (max !== undefined && next > max) next = max
        apply(next)
      }

      return h(Field, { label },
        h('div', { style: styles.switchWrap },
          h('input', {
            style: { ...styles.input, flex: width, boxSizing: 'border-box' },
            // `text` + inputMode keeps mobile keyboards numeric while letting the
            // field hold a partial value like '' or '3' on the way to '300'.
            type: 'text',
            inputMode: 'numeric',
            value: draft,
            onFocus: () => setEditing(true),
            onChange: (e) => setDraft(e.target.value.replace(/[^\d]/g, '')),
            onBlur: commit,
            onKeyDown: (e) => {
              if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() }
              if (e.key === 'Escape') { setDraft(String(value)); e.currentTarget.blur() }
            },
          }),
          h('button', {
            type: 'button',
            style: styles.stepButton,
            'aria-label': `${label} 减少`,
            onClick: () => nudge(-1),
          }, '−'),
          h('button', {
            type: 'button',
            style: styles.stepButton,
            'aria-label': `${label} 增加`,
            onClick: () => nudge(1),
          }, '+'),
          unit === undefined ? null : h('span', { style: styles.help }, unit)))
    }

    // One log line per record. The record shape is unchanged (`at` first, then
    // `kind` plus event fields), so older lines still render; a few noisy kinds
    // are folded to a single readable sentence instead of raw JSON.
    function formatLogEntry(entry) {
      const time = new Date(entry.at).toLocaleTimeString('zh-CN')
      const rest = { ...entry, at: undefined, kind: undefined }
      const kind = entry.kind ?? 'event'
      let detail
      if (kind === 'plugin-start') {
        const d = entry.configDigest ?? {}
        detail = `v${entry.version ?? '?'} · allowFrom ${d.allowFromCount ?? 0} 条 · 轮询 ${d.pollIntervalSec ?? '?'}s · 配置${entry.configChanged === 'first-run' ? '首次记录' : entry.configChanged ? '有变化' : '无变化'}`
        if (Array.isArray(entry.changedFields) && entry.changedFields.length > 0) detail += ` · 变化: ${entry.changedFields.join(',')}`
      } else if (kind === 'mail-seen') {
        detail = `本轮 ${entry.fresh ?? 0} 封：非白名单 ${entry.blocked ?? 0}，其他跳过 ${entry.skipped ?? 0} · ${(entry.senders ?? []).map((s) => `${s.from}×${s.count}`).join(', ')}`
      } else if (kind === 'mail-wake') {
        detail = `${entry.ok ? '成功' : '失败'} · ${entry.route ?? '?'} · ${entry.from ?? '?'} · ${entry.subject ?? '(无主题)'}`
        if (entry.sessionId) detail += ` · 会话 ${entry.sessionId}`
        if (entry.mode) detail += ` · ${entry.mode}${entry.interrupted ? '(打断)' : ''}`
        if (entry.unarchivePath) detail += ` · 归档恢复 ${entry.unarchivePath}`
        if (entry.error) detail += ` · 错误 ${entry.error}`
      } else {
        detail = JSON.stringify(rest)
      }
      return `${time} [${kind}] ${detail}`
    }

    /**
     * Model picker, mirroring the session page's selector.
     *
     * The catalog comes from the Host (`/models` → `sessionController.modelCatalog()`),
     * so the options are exactly the routes a conversation could actually run:
     * provider groups, their models, and each model's reasoning efforts. An empty
     * value means "follow the deployment default", which is the previous behaviour.
     *
     * @param {object} props
     * @param {object|null} props.catalog `{ok, groups, failures, default}` or null while loading
     * @param {object|null} props.value current `{provider, model, reasoningEffort?}` or null
     * @param {(next: object|null) => void} props.onChange
     */
    function ModelPicker({ catalog, value, onChange }) {
      const groups = catalog?.groups ?? []
      // Flatten to `provider\u0000model` keys so a plain <select> can express both.
      const options = []
      for (const group of groups) {
        for (const model of group.models ?? []) {
          options.push({
            key: `${group.id}\u0000${model.id}`,
            provider: group.id,
            model: model.id,
            providerName: group.name ?? group.id,
            modelName: model.name ?? model.id,
            efforts: model.reasoning?.efforts ?? [],
            defaultEffort: model.reasoning?.defaultEffort,
          })
        }
      }
      const currentKey = value === null || value === undefined ? '' : `${value.provider}\u0000${value.model}`
      const current = options.find((option) => option.key === currentKey)
      const effortChoices = current?.efforts ?? []

      const pickModel = (key) => {
        if (key === '') { onChange(null); return }
        const option = options.find((candidate) => candidate.key === key)
        if (option === undefined) return
        onChange({
          provider: option.provider,
          model: option.model,
          // Carry the model's own default effort, exactly as the session page does.
          ...(option.defaultEffort === undefined ? {} : { reasoningEffort: option.defaultEffort }),
        })
      }

      const pickEffort = (effort) => {
        if (value === null || value === undefined) return
        const next = { provider: value.provider, model: value.model }
        if (effort !== '') next.reasoningEffort = effort
        onChange(next)
      }

      return h('div', null,
        h(Field, { label: '邮件会话模型' },
          h('select', {
            style: { ...styles.input, flex: '1 1 260px' },
            value: currentKey,
            disabled: catalog === null,
            onChange: (e) => pickModel(e.target.value),
          },
            h('option', { value: '' },
              catalog?.default === undefined || catalog?.default === null
                ? '跟随默认（不指定模型）'
                : `跟随默认（${catalog.default.provider}/${catalog.default.model}）`),
            groups.length === 0
              ? h('option', { value: '', disabled: true }, catalog === null ? '正在读取模型目录…' : '（没有可用模型）')
              : groups.map((group) => h('optgroup', { key: group.id, label: group.name ?? group.id },
                (group.models ?? []).map((model) => h('option', {
                  key: `${group.id}\u0000${model.id}`,
                  value: `${group.id}\u0000${model.id}`,
                }, model.name ?? model.id))))),
          effortChoices.length === 0 ? null : h('select', {
            style: { ...styles.input, flex: '0 0 110px' },
            value: value?.reasoningEffort ?? '',
            onChange: (e) => pickEffort(e.target.value),
          },
            h('option', { value: '' }, '默认档位'),
            effortChoices.map((effort) => h('option', { key: effort.id, value: effort.id }, effort.name ?? effort.id)))),
        h('div', { style: { ...styles.row, marginTop: -2 } },
          h('div', { style: styles.label }),
          h('span', { style: styles.help },
            catalog?.ok === false
              ? `模型目录不可用：${catalog.error}`
              : '选中的模型不可用时，本次唤醒自动改用默认模型，不会漏回邮件。')))
    }

    /**
     * 白名单测试 + 最近拦截记录。
     * 数据源：POST /allowfrom-test（纯本地判定，不发邮件）与 GET /blocked
     * （seen-uids 里 allowed=false 的最近条目）。两个接口都只读。
     *
     * 测试用的是**当前草稿**（allowText），不是已保存配置：用户改完名单还没
     * 离开输入框就点测试，也应该得到“按我眼前这份名单会不会放行”的答案。
     * 草稿只参与本次判定，后端不落盘（2026-11-07 打回项 A3）。
     *
     * @param {object} props
     * @param {string} props.allowText 白名单文本框里的当前草稿
     */
    function WhitelistTester({ allowText }) {
      const [probe, setProbe] = useState('')
      const [probeResult, setProbeResult] = useState(null)
      const [blocked, setBlocked] = useState(null)
      const [busy, setBusy] = useState(false)

      const runTest = async () => {
        setProbeResult(null)
        const address = probe.trim()
        if (address === '') {
          setProbeResult({ ok: false, error: '请先填写要测试的发件人地址' })
          return
        }
        setBusy(true)
        try {
          const draft = String(allowText ?? '').split('\n').map((line) => line.trim()).filter((line) => line !== '')
          const result = await api('/allowfrom-test', {
            method: 'POST',
            body: JSON.stringify({ address, allowFrom: draft }),
          })
          setProbeResult(result)
        } catch (cause) {
          setProbeResult({ ok: false, error: cause instanceof Error ? cause.message : String(cause) })
        } finally {
          setBusy(false)
        }
      }

      const loadBlocked = useCallback(async () => {
        try {
          const data = await api('/blocked?limit=10')
          setBlocked(data.ok ? data.blocked : [])
        } catch {
          setBlocked([])
        }
      }, [])

      // 挂载时拉一次 + 每 30 秒静默刷新（不抢编辑焦点，纯只读列表）。
      useEffect(() => {
        void loadBlocked()
        const timer = setInterval(() => { void loadBlocked() }, 30000)
        return () => clearInterval(timer)
      }, [loadBlocked])

      return h('div', null,
        // ---- 测试按钮：本地判定是否命中 allowFrom ----
        h(Field, { label: '测试地址' },
          h('div', { style: { ...styles.switchWrap, flexWrap: 'wrap', flex: '1 1 auto', minWidth: 0 } },
            h('input', {
              style: { ...styles.input, flex: '0 1 260px' },
              value: probe,
              placeholder: 'user@example.com',
              onChange: (e) => setProbe(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault(); void runTest() } },
            }),
            h('button', {
              type: 'button',
              style: styles.button,
              disabled: busy,
              onClick: () => { void runTest() },
            }, busy ? '判定中…' : '测试是否放行'))),
        probeResult === null ? null : h('div', { style: { ...styles.row, marginTop: -4 } },
          h('div', { style: styles.label }),
          h('span', {
            style: { ...styles.help, color: probeResult.ok ? (probeResult.allowlisted ? COLOR.ok : COLOR.error) : COLOR.error },
          },
            probeResult.ok === false
              ? `无法判定：${probeResult.error ?? '未知原因'}`
              : probeResult.allowlisted
                ? `✓ 会放行：${probeResult.address}${probeResult.matchedRule ? `（命中规则 ${probeResult.matchedRule}）` : ''}`
                : `✗ 不会唤醒：${probeResult.address} 不在白名单内`)),
        h('div', { style: { ...styles.row, marginTop: -2 } },
          h('div', { style: styles.label }),
          h('span', { style: styles.help }, '按上面文本框里的当前内容判定（草稿无需先保存），只做本地比对、不发任何邮件。')),
        // ---- 拦截记录：最近被白名单拦下的邮件 ----
        h(Field, { label: '拦截记录' },
          h('div', { style: { flex: '1 1 auto', minWidth: 0 } },
            blocked === null
              ? h('span', { style: styles.help }, '读取中…')
              : blocked.length === 0
                ? h('span', { style: styles.help }, '暂无拦截记录：还没有非白名单发件人来过。')
                : h('div', { style: { ...styles.log, maxHeight: 140 } },
                  blocked.map((entry, i) => h('div', { key: `${entry.account}-${entry.uid}-${i}` },
                    `${new Date(entry.at).toLocaleString('zh-CN')} · ${entry.from} · 非白名单拦截${entry.subject ? ` · 「${entry.subject}」` : ''}`))),
            h('span', { style: styles.help }, '被白名单挡下的邮件不会唤醒会话；这里显示最近 10 条（完整记录见活动日志的 mail-seen 行）。'))))
    }

    function SmartMailPage() {
      const [status, setStatus] = useState(null)
      const [notice, setNotice] = useState(null)
      const [draft, setDraft] = useState({ preset: 'qq', label: '', address: '', authCode: '', imapHost: '', imapPort: 993, smtpHost: '', smtpPort: 465 })
      const [allowText, setAllowText] = useState('')
      const [cfg, setCfg] = useState({
        pollIntervalSec: 120, wakePrompt: '', wakeCwd: '', enabled: true,
        continueThreads: true, interruptSameThread: true, autoUnarchive: true,
        modelSelection: null,
        logMaxBytes: 2097152, logKeepDays: 7, logKeepFiles: 20,
        attachmentDir: '', attachmentKeepDays: 7,
      })
      const [threads, setThreads] = useState(null)
      const [catalog, setCatalog] = useState(null)
      const [workspaceCatalog, setWorkspaceCatalog] = useState(null)
      // 慢数据（模型目录 / 工作区 / 线程）不随 8 秒心跳重拉：
      // - models / workspaces 只在首次挂载拉一次；
      // - threads 首次拉一次，之后由「进阶设置」展开时再拉。
      // 状态（/status）才是那个每 8 秒必须刷新的东西（2026-11-07 打回项 A5）。
      const slowLoadedRef = useRef(false)
      // 已存在的账号决定“添加邮箱”区默认展开还是折叠。
      const accounts = status?.accounts ?? []
      const [addOpen, setAddOpen] = useState(accounts.length === 0)
      // 首次拿到账号列表时校正一次默认展开状态（无账号=展开，有账号=折叠）。
      const addDefaultAppliedRef = useRef(false)
      useEffect(() => {
        if (addDefaultAppliedRef.current || status === null) return
        addDefaultAppliedRef.current = true
        setAddOpen(accounts.length === 0)
      }, [status, accounts.length])
      // 编辑中的文本域（wakePrompt/wakeCwd/allowFrom/attachmentDir）不被 8 秒
      // 轮询覆盖：聚焦期间冻结刷新回写，blur 后恢复（number-field 的同类修复，
      // 文本输入期间超过 8 秒会被服务端值冲掉）。
      const editingRef = useRef(false)
      // 邮件托管：一次返回配置、实际收件人和提问单，不再让页面拼多个接口。
      const [hosting, setHosting] = useState(null)
      const [hostingNotice, setHostingNotice] = useState(null)
      const [hostingBusy, setHostingBusy] = useState(false)
      const [activeView, setActiveView] = useState('overview')
      const hostingLoadedRef = useRef(false)

      /** 只刷新值得每 8 秒刷的：状态（开关、摘要、日志、轮询间隔）。 */
      const refreshStatus = useCallback(async () => {
        try {
          const data = await api('/status')
          setStatus(data)
          if (data.ok && !editingRef.current) {
            setAllowText((data.config.allowFrom ?? []).join('\n'))
            setCfg({
              enabled: data.config.enabled !== false,
              pollIntervalSec: data.config.pollIntervalSec ?? 120,
              wakePrompt: data.config.wakePrompt ?? '',
              wakeCwd: data.config.wakeCwd ?? '',
              continueThreads: data.config.continueThreads !== false,
              interruptSameThread: data.config.interruptSameThread !== false,
              autoUnarchive: data.config.autoUnarchive !== false,
              modelSelection: data.config.modelSelection ?? null,
              wakeTarget: data.config.wakeTarget ?? { mode: 'default' },
              logMaxBytes: data.config.logMaxBytes ?? 2097152,
              logKeepDays: data.config.logKeepDays ?? 7,
              logKeepFiles: data.config.logKeepFiles ?? 20,
              attachmentDir: data.config.attachmentDir ?? '',
              attachmentKeepDays: data.config.attachmentKeepDays ?? 7,
            })
          }
        } catch (cause) {
          setNotice({ ok: false, text: `面板连不上 Host 路由：${cause instanceof Error ? cause.message : String(cause)}` })
        }
      }, [])

      /** 慢数据：模型目录 + 工作区注册表，只需在页面生命周期里拉一次。 */
      const loadSlow = useCallback(async () => {
        if (slowLoadedRef.current) return
        slowLoadedRef.current = true
        try {
          // The same catalog the session page renders.
          const data = await api('/models')
          setCatalog(data.ok ? data : { ok: false, error: data.error ?? 'unavailable' })
        } catch (cause) {
          setCatalog({ ok: false, error: cause instanceof Error ? cause.message : String(cause) })
        }
        try {
          // Live Workspace registry: an install that never registered one
          // returns an empty list, which is a valid (and handled) answer.
          const data = await api('/workspaces')
          setWorkspaceCatalog(data.ok ? data : { ok: false, workspaces: [], error: data.error ?? 'unavailable' })
        } catch (cause) {
          setWorkspaceCatalog({ ok: false, workspaces: [], error: cause instanceof Error ? cause.message : String(cause) })
        }
      }, [])

      /** 线程映射：首次进入或展开「进阶设置」时拉取（不跟随 8 秒心跳）。 */
      const loadThreads = useCallback(async () => {
        try {
          const data = await api('/threads')
          if (data.ok) setThreads(data)
        } catch {
          setThreads(null)
        }
      }, [])

      useEffect(() => { void refreshStatus(); void loadSlow() }, [refreshStatus, loadSlow])
      useEffect(() => {
        // 心跳只刷状态：慢数据由上面的首次加载与展开事件负责（打回项 A5）。
        const timer = setInterval(() => { void refreshStatus() }, 8000)
        return () => clearInterval(timer)
      }, [refreshStatus])

      const loadHosting = useCallback(async () => {
        try {
          const data = await api('/hosting')
          if (data.ok === true) setHosting(data)
        } catch { /* 面板其余部分照常可用 */ }
      }, [])

      // 配置和活跃提问单只在进入页面时读取，不打断正在编辑的表单。
      useEffect(() => {
        if (hostingLoadedRef.current) return
        hostingLoadedRef.current = true
        void loadHosting()
      }, [loadHosting])

      const setDraftField = (key, value) => setDraft((d) => {
        const next = { ...d, [key]: value }
        if (key === 'preset') {
          const preset = (status?.presets ?? {})[value]
          if (preset) {
            next.imapHost = preset.imap.host; next.imapPort = preset.imap.port
            next.smtpHost = preset.smtp.host; next.smtpPort = preset.smtp.port
          }
        }
        return next
      })

      const saveAccount = async () => {
        setNotice(null)
        const body = {
          preset: draft.preset,
          label: draft.label || draft.address,
          address: draft.address.trim(),
          authCode: draft.authCode.trim(),
          imap: { host: draft.imapHost.trim(), port: Number(draft.imapPort) || 993, tls: true },
          smtp: { host: draft.smtpHost.trim(), port: Number(draft.smtpPort) || 465, tls: draft.smtpPort !== '25' && Number(draft.smtpPort) !== 25 },
        }
        const result = await api('/account', { method: 'POST', body: JSON.stringify(body) })
        setNotice(result.ok
          ? { ok: true, text: `账号已保存：${result.account.address}` }
          : { ok: false, text: `保存失败：${result.error}` })
        if (result.ok) setDraft((d) => ({ ...d, label: '', address: '', authCode: '' }))
        await refreshStatus()
      }

      const testAccount = async (id) => {
        setNotice({ ok: true, text: '正在测试 IMAP 连接…' })
        const result = await api('/test', { method: 'POST', body: JSON.stringify({ id }) })
        setNotice(result.ok
          ? { ok: true, text: `IMAP 连接成功，收件箱 ${result.inbox.exists} 封` }
          : { ok: false, text: `IMAP 失败：${result.error}` })
      }

      const removeOne = async (id) => {
        await api(`/account?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
        await refreshStatus()
      }

      const saveConfig = async (patch) => {
        const next = { ...cfg, ...patch }
        setCfg(next)
        const result = await api('/config', { method: 'POST', body: JSON.stringify(patch) })
        if (!result.ok) {
          setNotice({ ok: false, text: `配置保存失败：${result.error}` })
        } else if (result.persisted === false) {
          // The change is live for this run but could not be written to the
          // profile, so it would be lost on restart — say so instead of hiding it.
          setNotice({
            ok: false,
            text: `已生效，但没能写回 profile 配置（重启会丢失）：${result.persistError ?? '未知原因'}`,
          })
        } else if (result.changedFields !== undefined && result.changedFields.length > 0) {
          setNotice({ ok: true, text: '配置已保存（重启后仍生效）' })
        }
        await refreshStatus()
      }

      /**
       * 邮件托管的保存：走自己的 /hosting 路由（不是 /config）。
       *
       * 原因：/config 只在 changedFields 非空时写回 profile，而 hosting 是嵌套
       * 对象，panel 里的部分字段改动在旧口径下容易被判成"没变"。单独一条路由
       * 能把"改了哪一层、有没有落盘"直接回给界面。
       */
      const saveHosting = async (patch) => {
        if (hostingBusy) return
        setHostingBusy(true)
        setHostingNotice(null)
        try {
          const result = await api('/hosting', { method: 'POST', body: JSON.stringify(patch) })
          if (result.ok !== true) {
            setHostingNotice({ ok: false, text: `保存失败：${result.error ?? '未知原因'}` })
            return
          }
          await loadHosting()
          if (result.persisted === false) {
            setHostingNotice({ ok: false, text: `已生效，但没能写回 profile 配置（重启会丢失）：${result.persistError ?? '未知原因'}` })
          } else {
            setHostingNotice({ ok: true, text: '设置已保存' })
          }
        } catch (cause) {
          setHostingNotice({ ok: false, text: `保存失败：${cause instanceof Error ? cause.message : String(cause)}` })
        } finally {
          setHostingBusy(false)
        }
      }

      /** Pin (or clear) the model one thread's session should use. */      const saveThreadModel = async (tag, selection) => {
        const result = await api('/thread-model', {
          method: 'POST',
          body: JSON.stringify({ tag, selection }),
        })
        setNotice(result.ok
          ? {
            ok: true,
            text: selection === null
              ? `线程 ${tag} 已改回跟随默认模型`
              : `线程 ${tag} 模型已设为 ${selection.provider}/${selection.model}`,
          }
          : { ok: false, text: `线程模型保存失败：${result.error}` })
        await loadThreads()
      }

      const pollNow = async () => {
        setNotice({ ok: true, text: '手动轮询中…' })
        const result = await api('/poll-now', { method: 'POST' })
        setNotice({ ok: true, text: `轮询完成：${JSON.stringify(result.results?.map((r) => ({ account: r.account, fresh: r.fresh, woke: r.woke?.length ?? 0 })))}` })
        await refreshStatus()
      }

      const presets = status?.presets ?? {}

      const navigation = [
        ['overview', '收信与唤醒', '账号、白名单和自动收信'],
        ['hosting', '邮件托管', '离开页面也能回答问题、接收结果'],
      ]

      return h('div', { style: styles.page },
        h('div', { style: styles.content },
        h('h1', { style: styles.title }, '智能邮箱'),
        h('div', { style: styles.subtitle }, '用邮件接收任务、回复问题，让 DSH 在你离开页面后继续工作。'),
        h('div', {
          role: 'tablist', 'aria-label': '邮箱设置分类',
          style: { display: 'flex', gap: 6, margin: '22px 0 20px', borderBottom: `1px solid ${COLOR.border}` },
        }, navigation.map(([id, label, description]) => h('button', {
          key: id, type: 'button', role: 'tab', 'aria-selected': activeView === id,
          title: description,
          onClick: () => setActiveView(id),
          style: {
            padding: '9px 14px 11px', border: 0, borderBottom: `2px solid ${activeView === id ? COLOR.accent : 'transparent'}`,
            background: 'transparent', color: activeView === id ? COLOR.text : COLOR.muted,
            font: 'inherit', fontWeight: activeView === id ? 600 : 400, cursor: 'pointer',
          },
        }, label))),

        notice === null ? null : h('div', {
          style: { ...styles.notice, ...(notice.ok ? styles.noticeOk : styles.noticeError) },
        }, notice.text),

        activeView === 'hosting'
          ? h(HostingSection, {
            hosting: hosting?.hosting,
            owner: hosting?.owner,
            accounts: hosting?.accounts ?? [],
            active: hosting?.active ?? [],
            saveHosting,
            refresh: loadHosting,
            notices: hostingNotice === null ? [] : [hostingNotice],
            busy: hostingBusy,
          })
          : h(React.Fragment, null,

        // ---- ⓪ 自动收信总览：页面最顶上的“现在到底在不在自动收信” ------
        h('div', { style: styles.section },
          h('h2', { style: styles.sectionTitle }, '自动收信'),
          h('div', { style: styles.row },
            h('div', { style: styles.switchWrap, flex: '1 1 auto', minWidth: 0 },
              h('button', {
                type: 'button',
                style: cfg.enabled ? styles.buttonPrimary : styles.button,
                role: 'switch',
                'aria-checked': cfg.enabled,
                onClick: () => saveConfig({ enabled: !cfg.enabled }),
              }, cfg.enabled ? '● 已启用' : '○ 已停用'),
              h('span', { style: styles.help }, cfg.enabled
                ? `每 ${cfg.pollIntervalSec} 秒检查一次新邮件`
                : '已停止检查新邮件（收发工具不受影响）')),
            h('button', { type: 'button', style: styles.button, onClick: pollNow }, '立即检查新邮件')),
          h('div', { style: styles.help },
            `账号 ${accounts.length} 个 · 白名单 ${(status?.config?.allowFrom ?? []).length} 条 · 唤醒到「${cfg.wakeTarget?.mode === 'cwd' ? '自定义目录' : cfg.wakeTarget?.mode === 'ungrouped' ? '未分组' : cfg.wakeTarget?.mode === 'workspace' ? '指定工作区' : '默认工作区'}」`)),

        // ---- ① 账号：已有账号时“添加邮箱”默认折叠 ------------------------
        h('div', { style: styles.section },
          h('h2', { style: styles.sectionTitle }, '邮箱账号'),
          accounts.length === 0
            ? h('div', { style: styles.help }, '还没有账号：选服务商预设，填邮箱地址和授权码保存即可。')
            : h('div', null, accounts.map((a) =>
              h('div', { key: a.id, style: styles.accountRow },
                h('div', { style: styles.accountMain },
                  h('div', { style: styles.accountAddress }, `${a.label} · ${a.address}`),
                  h('div', { style: styles.accountMeta },
                    `${presets[a.preset]?.label ?? a.preset} · imap ${a.imap.host}:${a.imap.port} · smtp ${a.smtp.host}:${a.smtp.port} · 授权码 ${a.authCodeTail}`)),
                h('button', { type: 'button', style: styles.button, onClick: () => testAccount(a.id) }, '测试'),
                h('button', { type: 'button', style: styles.button, onClick: () => removeOne(a.id) }, '删除')))),
          // 有账号时默认折叠，少占首屏；没有账号时直接展开（否则用户找不到入口）。
          h('button', {
            type: 'button',
            style: { ...styles.toggleRow, background: 'transparent', border: 0, padding: 0, width: '100%', textAlign: 'left', color: 'inherit', font: 'inherit' },
            'aria-expanded': addOpen,
            onClick: () => setAddOpen((open) => !open),
          },
            h('span', { style: styles.toggleArrow, 'aria-hidden': true }, addOpen ? '▾' : '▸'),
            '添加邮箱'),
          addOpen
            ? h('div', { style: { marginTop: 8 } },
              h(Field, { label: '服务商' },
                h('select', {
                  style: styles.input, value: draft.preset,
                  onChange: (e) => setDraftField('preset', e.target.value),
                }, Object.entries(presets).map(([key, p]) => h('option', { key, value: key }, p.label)))),
              h(Field, { label: '邮箱地址' },
                h('input', { style: styles.input, value: draft.address, placeholder: 'you@example.com', onChange: (e) => setDraftField('address', e.target.value) })),
              h(Field, { label: '授权码' },
                h('input', { style: styles.input, type: 'password', value: draft.authCode, placeholder: 'IMAP/SMTP 授权码，不是登录密码', onChange: (e) => setDraftField('authCode', e.target.value) })),
              draft.preset === 'custom' ? h(React.Fragment, null,
                h(Field, { label: 'IMAP 服务器' },
                  h('input', { style: styles.input, value: draft.imapHost, placeholder: 'imap.example.com:993', onChange: (e) => setDraftField('imapHost', e.target.value) })),
                h(Field, { label: 'SMTP 服务器' },
                  h('input', { style: styles.input, value: draft.smtpHost, placeholder: 'smtp.example.com:465', onChange: (e) => setDraftField('smtpHost', e.target.value) }))) : null,
              presets[draft.preset]?.smtpNote ? h('div', { style: styles.row },
                h('div', { style: styles.label }),
                h('span', { style: styles.help }, presets[draft.preset].smtpNote)) : null,
              h(Field, { label: '备注名' },
                h('input', { style: styles.input, value: draft.label, placeholder: '可选，默认用邮箱地址', onChange: (e) => setDraftField('label', e.target.value) })),
              h('div', { style: styles.row },
                h('div', { style: styles.label }),
                h('button', { type: 'button', style: styles.buttonPrimary, onClick: saveAccount }, '保存账号')))
            : null),

        // ---- ② 白名单：谁可以唤醒 DSH ----------------------------------
        h('div', { style: styles.section },
          h('h2', { style: styles.sectionTitle }, '谁可以唤醒 DSH'),
          h('div', { style: styles.help },
            '只有名单里的发件人来新邮件，才会自动唤醒 DSH 会话。不在名单里的邮件仍可正常读取，只是不会自动唤醒。'),
          h(Field, { label: '允许的发件人' },
            h('textarea', {
              style: { ...styles.input, minHeight: 72, fontFamily: 'ui-monospace, Consolas, monospace' },
              value: allowText,
              placeholder: 'boss@company.com\n@trusted-domain.com',
              onFocus: () => { editingRef.current = true },
              onChange: (e) => setAllowText(e.target.value),
              onBlur: () => { editingRef.current = false; saveConfig({ allowFrom: allowText.split('\n').map((s) => s.trim()).filter(Boolean) }) },
            })),
          h('div', { style: { ...styles.row, marginTop: -2 } },
            h('div', { style: styles.label }),
            h('span', { style: styles.help }, '每行一条：完整地址 user@x.com，或域名后缀 @x.com。留空 = 永不自动唤醒。')),
          h(WhitelistTester, { allowText })),

        // ---- ③ 收到邮件后做什么（常用项）-------------------------------
        h('div', { style: styles.section },
          h('h2', { style: styles.sectionTitle }, '收到邮件后做什么'),
          h(Field, { label: '唤醒提示词' },
            h('input', {
              style: styles.input, value: cfg.wakePrompt,
              placeholder: '唤醒后新会话收到的任务说明',
              onFocus: () => { editingRef.current = true },
              onChange: (e) => setCfg((c) => ({ ...c, wakePrompt: e.target.value })),
              onBlur: () => { editingRef.current = false; saveConfig({ wakePrompt: cfg.wakePrompt }) },
            })),
          h(WakeTargetPicker, {
            catalog: workspaceCatalog,
            value: cfg.wakeTarget ?? { mode: 'default' },
            onChange: (next) => saveConfig({ wakeTarget: next }),
          }),
          cfg.wakeTarget?.mode === 'cwd' ? h(Field, { label: '唤醒工作目录' },
            h('input', {
              style: styles.input, value: cfg.wakeCwd, fontFamily: 'ui-monospace, Consolas, monospace',
              placeholder: '绝对路径，例如 E:\\work\\inbox',
              onFocus: () => { editingRef.current = true },
              onChange: (e) => setCfg((c) => ({ ...c, wakeCwd: e.target.value })),
              onBlur: () => { editingRef.current = false; saveConfig({ wakeCwd: cfg.wakeCwd }) },
            })) : null),

        // ---- ④ 高级唤醒设置（低频，默认折叠）---------------------------
        h(CollapsibleSection, {
          title: '高级唤醒设置',
          hint: '轮询频率、模型、线程续接、归档恢复',
        },
          h(NumberField, {
            label: '轮询间隔(秒)',
            value: cfg.pollIntervalSec,
            min: 30,
            step: 30,
            unit: '秒，最小 30',
            onCommit: (next) => saveConfig({ pollIntervalSec: next }),
          }),
          h(ModelPicker, {
            catalog,
            value: cfg.modelSelection,
            onChange: (next) => saveConfig({ modelSelection: next }),
          }),
          h(Field, { label: '续接同一会话' },
            h('div', { style: styles.switchWrap },
              h('button', {
                type: 'button',
                style: cfg.continueThreads ? styles.buttonPrimary : styles.button,
                role: 'switch', 'aria-checked': cfg.continueThreads,
                onClick: () => saveConfig({ continueThreads: !cfg.continueThreads }),
              }, cfg.continueThreads ? '已启用' : '已停用'))),
          h(Field, { label: '同线程打断' },
            h('div', { style: styles.switchWrap },
              h('button', {
                type: 'button',
                style: cfg.interruptSameThread ? styles.buttonPrimary : styles.button,
                role: 'switch', 'aria-checked': cfg.interruptSameThread,
                onClick: () => saveConfig({ interruptSameThread: !cfg.interruptSameThread }),
              }, cfg.interruptSameThread ? '已启用' : '已停用'))),
          h(Field, { label: '归档会话拉回' },
            h('div', { style: styles.switchWrap },
              h('button', {
                type: 'button',
                style: cfg.autoUnarchive ? styles.buttonPrimary : styles.button,
                role: 'switch', 'aria-checked': cfg.autoUnarchive,
                onClick: () => saveConfig({ autoUnarchive: !cfg.autoUnarchive }),
              }, cfg.autoUnarchive ? '已启用' : '已停用'))),
          h('div', { style: { ...styles.row, marginTop: -2 } },
            h('div', { style: styles.label }),
            h('span', { style: styles.help },
              '同线程回复续接原会话；该会话正在运行时先打断当前轮次再注入；已归档的会话自动拉回继续用（不新建）。'))),

        // ---- ⑤ 进阶设置（附件 / 日志 / 诊断，默认折叠）------------------
        h(CollapsibleSection, {
          title: '进阶设置',
          hint: '附件保存与清理、日志轮转',
        },
          h(Field, { label: '附件保存目录' },
            h('input', {
              style: { ...styles.input, fontFamily: 'ui-monospace, Consolas, monospace' },
              value: cfg.attachmentDir ?? '',
              placeholder: '留空 = DSH 主进程工作目录下的 mail-attachments/',
              onFocus: () => { editingRef.current = true },
              onChange: (e) => setCfg((c) => ({ ...c, attachmentDir: e.target.value })),
              onBlur: () => { editingRef.current = false; saveConfig({ attachmentDir: cfg.attachmentDir }) },
            })),
          h(NumberField, {
            label: '附件保留(天)',
            value: cfg.attachmentKeepDays ?? 7,
            min: 0,
            step: 1,
            width: '0 0 120px',
            unit: '天，0 = 永久保留',
            onCommit: (next) => saveConfig({ attachmentKeepDays: next }),
          }),
          h(NumberField, {
            label: '日志上限(KiB)',
            value: Math.round(cfg.logMaxBytes / 1024),
            min: 64,
            step: 64,
            width: '0 0 120px',
            unit: 'KiB，最小 64',
            onCommit: (next) => saveConfig({ logMaxBytes: next * 1024 }),
          }),
          h(NumberField, {
            label: '日志保留(天)',
            value: cfg.logKeepDays,
            min: 1,
            step: 1,
            unit: '天',
            onCommit: (next) => saveConfig({ logKeepDays: next }),
          }),
          h(NumberField, {
            label: '日志归档数',
            value: cfg.logKeepFiles,
            min: 1,
            step: 1,
            unit: '个',
            onCommit: (next) => saveConfig({ logKeepFiles: next }),
          })),

        // ---- ⑥ 运行诊断（只读，展开才拉线程数据）-----------------------
        h(CollapsibleSection, {
          title: '运行诊断',
          hint: '活动日志、邮件线程映射',
          onOpen: () => { void loadThreads() },
        },
          h('div', { style: styles.help },
            `日志 ${Math.round((status?.logHealth?.currentBytes ?? 0) / 1024)} KiB / 上限 ${Math.round((status?.logHealth?.maxBytes ?? 0) / 1024)} KiB · 归档 ${status?.logHealth?.archives ?? 0} 个`),
          h('div', { style: styles.log },
            (status?.log ?? []).length === 0
              ? '（暂无记录）'
              : status.log.map(formatLogEntry).join('\n')),
          h('div', { style: { ...styles.help, marginTop: 12 } },
            `共 ${threads?.count ?? 0} 个邮件线程（显示最近 50 个）。回复这些线程会续接对应会话；每行下拉可单独钉住该线程用的模型。`),
          threads === null
            ? h('div', { style: styles.help }, '展开即加载…')
            : (threads.threads ?? []).length === 0
              ? h('div', { style: styles.help }, '（还没有线程）')
              : h('div', null, threads.threads.map((t) => renderThreadRow(t, {
                groups: catalog?.groups ?? [],
                onSave: (tag, selection) => saveThreadModel(tag, selection),
              })))))
        ))
    }

    /** One thread row: identity, the session it maps to, and its model pin. */
    function renderThreadRow(t, { groups, onSave }) {
      const current = t.modelSelection === undefined || t.modelSelection === null
        ? ''
        : `${t.modelSelection.provider}\u0000${t.modelSelection.model}`
      const label = t.modelSelection === undefined || t.modelSelection === null
        ? '模型跟随默认'
        : `模型 ${t.modelSelection.provider}/${t.modelSelection.model}${t.modelSelection.reasoningEffort === undefined ? '' : `@${t.modelSelection.reasoningEffort}`}`

      return h('div', { key: t.tag, style: styles.accountRow },
        h('div', { style: styles.accountMain },
          h('div', { style: styles.accountAddress }, `${t.tag} · 第 ${t.round ?? 0} 轮 · ${t.subject ?? '(无主题)'}`),
          h('div', { style: styles.accountMeta }, `会话 ${t.sessionId} · ${label}`)),
        h('select', {
          style: { ...styles.input, flex: '0 0 190px' },
          value: current,
          onChange: (e) => {
            const key = e.target.value
            const selection = key === '' ? null : (() => {
              const [provider, model] = key.split('\u0000')
              return { provider, model }
            })()
            void onSave(t.tag, selection)
          },
        },
          h('option', { value: '' }, '跟随默认'),
          groups.map((group) => h('optgroup', { key: group.id, label: group.name ?? group.id },
            (group.models ?? []).map((model) => h('option', {
              key: `${group.id}\u0000${model.id}`,
              value: `${group.id}\u0000${model.id}`,
            }, model.name ?? model.id))))))
    }

    /* ------------------------------------------------- 会话内：邮件托管胶囊 */

    /**
     * composer 左侧的「邮件托管」开关胶囊。
     *
     * 位置选择（2026-11-11 与用户确认）：`conversation.input.left`，和
     * 「Computer Use」同一排。Computer Use 占 order 24，所以这里用 25 紧跟其后，
     * 不与它抢位；也不用 `sidebar.right.pane.tab`（上下文洞察在用，且点开才看得见，
     * 启用态不够一目了然）。
     *
     * 视觉（2026-11-12 用户指定，替换旧的"边框+底色"方案）：
     *   - 无外框、无底色，只有一个 ✉ 图标 + 「邮件托管」四个字；
     *   - 关闭：灰黑色（次级文字色）常规字重；
     *   - 开启：加粗黑色（主文字色）。
     * 状态只靠字重/颜色区分，右侧不再带「已开/已关」字样。
     */
    const PILL_SLOT = 'conversation.input.left'
    const PILL_ID = 'smart-mail-hosting'
    const PILL_ORDER = 25

    function HostingPill(props) {
      const sessionId = typeof props === 'string' ? props : (props?.sessionId ?? null)
      const [state, setState] = useState(null)
      const [busy, setBusy] = useState(false)
      const [hover, setHover] = useState(false)

      const load = useCallback(async () => {
        try {
          const data = await api(`/hosting${sessionId === null ? '' : `?sessionId=${encodeURIComponent(sessionId)}`}`)
          setState(data)
        } catch {
          setState(null)
        }
      }, [sessionId])

      useEffect(() => { void load() }, [load])
      // 12 秒一次：胶囊要能反映"刚被提问、邮件已发出"，但不能太吵。
      useEffect(() => {
        const timer = setInterval(() => { void load() }, 12000)
        return () => clearInterval(timer)
      }, [load])

      if (sessionId === null || state === null || state.ok !== true) return null

      const hosting = state.hosting ?? {}
      const override = hosting.sessions?.[sessionId]
      // 与宿主同口径：显式覆盖 > 邮件唤醒(默认开) > 全局默认
      const mailWoken = state.mailWoken === true
      const enabled = override === true || (override === undefined && (mailWoken || hosting.defaultEnabled === true))
      const fromMail = override === undefined && mailWoken

      const toggle = async () => {
        if (busy) return
        setBusy(true)
        try {
          await api('/hosting', {
            method: 'POST',
            body: JSON.stringify({ sessionId, sessionEnabled: !enabled }),
          })
          await load()
        } catch { /* 下一次轮询会纠正 UI */ } finally { setBusy(false) }
      }

      const pill = {
        display: 'inline-flex', alignItems: 'center', gap: 5,
        height: 28, padding: '0 6px', borderRadius: 8,
        cursor: busy ? 'progress' : 'pointer', userSelect: 'none',
        font: '12px/1 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif',
        background: 'transparent',
        border: 'none',
        color: enabled ? COLOR.text : COLOR.muted,
        fontWeight: enabled ? 700 : 400,
        opacity: busy ? 0.6 : 1,
        transition: 'color 120ms',
        ...(hover ? { color: COLOR.text } : {}),
      }

      const icon = h('span', {
        'aria-hidden': 'true',
        style: { fontSize: 13, lineHeight: 1 },
      }, '✉')

      const label = '邮件托管'

      return h('button', {
        type: 'button',
        style: pill,
        role: 'switch',
        'aria-checked': enabled,
        'aria-label': `邮件托管：${enabled ? '已启用' : '未启用'}${fromMail ? '（邮件唤醒会话默认开启）' : ''}，点击${enabled ? '关闭' : '开启'}`,
        title: enabled
          ? `邮件托管已启用：这个会话向你提问时会发邮件给你${fromMail ? '（邮件唤醒的会话默认开启）' : ''}。点击可关闭。`
          : '邮件托管已关闭：提问只在本页面弹窗。点击可开启，之后提问会发邮件给你，你回信即作答。',
        onClick: toggle,
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
      }, icon, h('span', null, label))
    }

    /* --------------------------------------------------- 设置页：邮件托管区块 */

    /**
     * 设置页的「邮件托管」区块。
     *
     * 三层开关（用户 2026-11-11 指定）：
     *   ① 总开关 —— 关掉后任何会话都不发托管邮件（一票否决）；
     *   ② 默认值 —— **非**邮件唤醒的会话默认开还是关；
     *   ③ 单会话覆盖 —— 会话内胶囊里的开关，写进 hosting.sessions。
     * 另外明确展示「邮件唤醒的会话默认开启」这条规则，免得用户以为它跟随②。
     */
    function HostingSection({ hosting, owner, accounts, active = [], saveHosting, refresh, notices, busy = false }) {
      const [ownerDraft, setOwnerDraft] = useState(null)
      if (hosting === null || hosting === undefined) {
        return h('div', { style: styles.section }, '正在读取邮件托管设置…')
      }

      const cfg = hosting
      const enabled = cfg.enabled !== false
      const overrideCount = Object.keys(cfg.sessions ?? {}).length
      const actualOwner = owner || cfg.owner || '尚未配置'
      const toggle = (field) => () => void saveHosting({ [field]: !cfg[field] })
      const steps = [
        ['1', 'DSH 发邮件', '遇到需要你决定的问题时，发到你的邮箱。'],
        ['2', '直接回复邮件', '回选项编号或文字，不必回到这个页面。'],
        ['3', '任务自动继续', '答案送回原来的会话；超时挂起后也能回信。'],
      ]

      return h(React.Fragment, null,
        h(SectionHeading, {
          title: '邮件托管',
          description: '不守着会话页面，也能通过邮件回答问题、接收任务结果。',
          action: h('span', { style: styles.badge(enabled) }, enabled ? '功能已开启' : '功能已关闭'),
        }),

        // 第一屏只回答“开没开、发给谁、怎么用”，不再直接堆叠技术参数。
        h('div', { style: styles.card },
          h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 18 } },
            h('div', null,
              h('div', { style: { fontSize: 15, fontWeight: 600 } }, '允许通过邮件与我沟通'),
              h('div', { style: { ...styles.help, marginTop: 4 } },
                enabled ? '适用于已开启托管的会话；关闭后，所有提问都回到页面弹窗。' : '当前不会发送托管提问或任务结果邮件。')),
            h(Toggle, { on: enabled, onClick: toggle('enabled'), label: '邮件托管总开关', disabled: busy })),
          h('div', {
            style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 14, paddingTop: 12, borderTop: `1px solid ${COLOR.border}` },
          },
            h('span', { style: styles.help }, `接收邮箱：${actualOwner}`),
            h('span', { style: styles.help }, '·'),
            h('span', { style: styles.help }, `发信账号：${accounts.length > 0 ? accounts.map((a) => a.address).join('、') : '尚未配置'}`)),
          enabled ? null : h('div', { style: { ...styles.help, marginTop: 8, color: COLOR.error } },
            '总开关已关闭。下面的单独设置会保留，重新开启后恢复生效。')),

        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 10, margin: '14px 0 20px' } },
          steps.map(([number, title, description]) => h('div', { key: number, style: { ...styles.card, padding: '12px 14px' } },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600 } },
              h('span', { style: { ...styles.badge(true), minWidth: 18, textAlign: 'center' } }, number), title),
            h('div', { style: { ...styles.help, marginTop: 6 } }, description)))),

        h('div', { style: styles.section },
          h(SectionHeading, {
            title: `等待回复${active.length > 0 ? `（${active.length}）` : ''}`,
            description: active.length > 0 ? '到邮箱找到对应邮件，直接回复即可。' : '当前没有需要你回答的问题。',
            action: h('button', { type: 'button', style: styles.button, onClick: () => { void refresh() } }, '刷新'),
          }),
          active.length === 0 ? null : active.slice(0, 10).map((ticket) => h('div', {
            key: ticket.ticket, style: { ...styles.card, marginBottom: 8 },
          },
            h('div', { style: { fontWeight: 600 } }, ticket.sessionTitle ?? ticket.sessionId ?? '未命名会话'),
            h('div', { style: { ...styles.help, margin: '3px 0 6px' } },
              `${ticket.questionCount} 个问题 · ${ticket.askedAtLocal ?? ''} · ${ticket.status === 'waiting' ? '会话正在等待' : '已挂起，仍可回复'} · 单号 ${ticket.ticket}`),
            (ticket.questions ?? []).map((q, i) => h('div', { key: q.id ?? i, style: { marginTop: 3 } }, `${i + 1}. ${q.question}`))))),

        h('div', { style: styles.section },
          h(SectionHeading, { title: '通知与适用范围', description: '决定哪些会话使用托管，以及是否额外发送完成通知。' }),
          h(SettingRow, {
            title: '任务完成后发送结果邮件', on: cfg.notifyResult === true, onToggle: toggle('notifyResult'), disabled: !enabled || busy,
            description: cfg.notifyResult === true ? '每轮完成后发送结果，相同内容不会重复发送。' : '只发送需要回答的问题，不发送完成通知。',
          },
            cfg.notifyResult === true ? h('div', { style: { marginTop: 10 } },
              h(Field, { label: '结果正文上限' }, h(NumberField, {
                value: cfg.resultMaxChars ?? 4000, min: 200, step: 500, unit: '字；超出后截断',
                onCommit: (next) => void saveHosting({ resultMaxChars: Math.max(200, Number(next) || 4000) }),
              }))) : null),
          h(SettingRow, {
            title: '普通会话默认开启', on: cfg.defaultEnabled === true, onToggle: toggle('defaultEnabled'), disabled: !enabled || busy,
            description: cfg.defaultEnabled === true
              ? '新建的页面会话默认使用邮件托管。'
              : '页面会话默认不使用；可在会话输入框左侧单独开启「邮件托管」。',
          }),
          h(SettingRow, {
            title: '邮件唤醒的会话默认开启',
            description: '通过来信启动的会话会自动使用邮件托管，不受上一项影响；仍可在单个会话里关闭。',
          }),
          h('div', { style: { ...styles.help, paddingTop: 10, borderTop: `1px solid ${COLOR.border}` } },
            `已单独设置 ${overrideCount} 个会话。单个会话的设置优先于这里的默认规则。`)),

        h('div', { style: styles.section },
          h(SectionHeading, { title: '投递设置', description: '保存后立即生效，并写入本机配置。' }),
          h(Field, { label: '接收邮箱' },
            h('input', {
              style: styles.input, type: 'email', value: ownerDraft ?? (cfg.owner ?? ''),
              placeholder: '留空则使用白名单中的第一个完整邮箱地址',
              onFocus: () => { if (ownerDraft === null) setOwnerDraft(cfg.owner ?? '') },
              onChange: (e) => setOwnerDraft(e.target.value),
              onBlur: () => {
                if (ownerDraft !== null && ownerDraft.trim() !== (cfg.owner ?? '')) void saveHosting({ owner: ownerDraft.trim() })
                setOwnerDraft(null)
              },
            })),
          h('div', { style: { ...styles.help, margin: '-4px 0 12px 132px' } },
            `这是你的收件地址，不是发信账号。当前实际发送到：${actualOwner}。`),
          h(Field, { label: '前台等待时间' },
            h(NumberField, {
              value: Math.round((cfg.waitMs ?? 60000) / 1000), min: 5, step: 15, unit: '秒',
              onCommit: (next) => void saveHosting({ waitMs: Math.max(5, Number(next) || 60) * 1000 }),
            })),
          h('div', { style: { ...styles.help, margin: '-4px 0 0 132px' } },
            '不是回信截止期限。到点后问题转为挂起，之后回复仍然有效。'),
          h('details', { style: { marginTop: 16, color: COLOR.muted } },
            h('summary', { style: { cursor: 'pointer' } }, '回信格式说明'),
            h('div', { style: { ...styles.help, marginTop: 8 } },
              '单个问题：直接回复选项编号或文字。多个问题：每行以问题编号开头，例如“1. 2”。回复“取消”可作废提问；邮件客户端自动附带的引用内容会被忽略。'))),

        notices?.length > 0
          ? h('div', { style: { ...styles.notice, ...(notices.every((n) => n.ok) ? styles.noticeOk : styles.noticeError) } },
            notices.map((n) => n.text).join(' '))
          : null)
    }

    function apply(ctx) {
      ctx.effect(() => ctx.slots.inject(PILL_SLOT, () => ctx.slots.register({
        name: PILL_SLOT,
        id: PILL_ID,
        order: PILL_ORDER,
        label: () => '邮件托管',
        inject: (sessionId) => ({ sessionId }),
      }, HostingPill)), 'smart-mail: hosting pill')

      ctx.effect(() => ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
        name: 'settings.plugins.tab',
        id: TAB_ID,
        order: 30,
        label: () => TAB_LABEL,
      }, SmartMailPage)), 'smart-mail: settings tab')
    }

    return { inject: ['slots'], apply }
  },
})
