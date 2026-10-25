// dsh-smart-mail — browser half.
//
// Contributes the 「智能邮箱」 management page under Settings → Plugins
// (settings.plugins.tab): accounts CRUD with provider presets, whitelist
// (allowFrom) editing, poll interval, wake prompt/cwd, IMAP test, manual
// poll, and the activity log. All data flows through the Host half's
// same-origin routes under /smart-mail/*.
window.__ModuleLoader__.load({
  id: 'dsh-smart-mail',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback } = React

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
        boxSizing: 'border-box', height: '100%', overflowY: 'auto', padding: '20px 24px 60px',
        background: COLOR.surface, color: COLOR.text,
        font: '13px/1.6 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif',
      },
      title: { margin: '0 0 4px', fontSize: 18, fontWeight: 600 },
      subtitle: { color: COLOR.muted, fontSize: 12, marginBottom: 18 },
      section: {
        background: COLOR.raised, border: `1px solid ${COLOR.border}`, borderRadius: 10,
        padding: '14px 16px', marginBottom: 14,
      },
      sectionTitle: { margin: '0 0 10px', fontSize: 14, fontWeight: 600 },
      row: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 },
      label: { flex: '0 0 110px', color: COLOR.muted, fontSize: 12 },
      input: {
        flex: '1 1 220px', minWidth: 0, boxSizing: 'border-box', padding: '6px 10px', borderRadius: 8,
        border: `1px solid ${COLOR.border}`, background: COLOR.nested, color: 'inherit', font: 'inherit',
      },
      button: {
        cursor: 'pointer', padding: '6px 14px', borderRadius: 8, border: `1px solid ${COLOR.border}`,
        background: COLOR.raised, color: 'inherit', font: 'inherit',
      },
      buttonPrimary: {
        cursor: 'pointer', padding: '6px 14px', borderRadius: 8, border: `1px solid ${COLOR.accent}`,
        background: COLOR.nested, color: COLOR.text, font: 'inherit',
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

    function SmartMailPage() {
      const [status, setStatus] = useState(null)
      const [notice, setNotice] = useState(null)
      const [draft, setDraft] = useState({ preset: 'qq', label: '', address: '', authCode: '', imapHost: '', imapPort: 993, smtpHost: '', smtpPort: 465 })
      const [allowText, setAllowText] = useState('')
      const [cfg, setCfg] = useState({ pollIntervalSec: 120, wakePrompt: '', wakeCwd: '', enabled: true })

      const refresh = useCallback(async () => {
        try {
          const data = await api('/status')
          setStatus(data)
          if (data.ok) {
            setAllowText((data.config.allowFrom ?? []).join('\n'))
            setCfg({
              enabled: data.config.enabled !== false,
              pollIntervalSec: data.config.pollIntervalSec ?? 120,
              wakePrompt: data.config.wakePrompt ?? '',
              wakeCwd: data.config.wakeCwd ?? '',
            })
          }
        } catch (cause) {
          setNotice({ ok: false, text: `面板连不上 Host 路由：${cause instanceof Error ? cause.message : String(cause)}` })
        }
      }, [])

      useEffect(() => { void refresh() }, [refresh])
      useEffect(() => {
        const timer = setInterval(() => { void refresh() }, 8000)
        return () => clearInterval(timer)
      }, [refresh])

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
        await refresh()
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
        await refresh()
      }

      const saveConfig = async (patch) => {
        const next = { ...cfg, ...patch }
        setCfg(next)
        const result = await api('/config', { method: 'POST', body: JSON.stringify(patch) })
        if (!result.ok) setNotice({ ok: false, text: `配置保存失败：${result.error}` })
        await refresh()
      }

      const pollNow = async () => {
        setNotice({ ok: true, text: '手动轮询中…' })
        const result = await api('/poll-now', { method: 'POST' })
        setNotice({ ok: true, text: `轮询完成：${JSON.stringify(result.results?.map((r) => ({ account: r.account, fresh: r.fresh, woke: r.woke?.length ?? 0 })))}` })
        await refresh()
      }

      const presets = status?.presets ?? {}

      return h('div', { style: styles.page },
        h('h1', { style: styles.title }, '智能邮箱 dsh-smart-mail'),
        h('div', { style: styles.subtitle },
          '多账号收发 + 白名单唤醒：只有 allowFrom 内发件人的新邮件会唤醒 DSH 会话，其余只静默记录。'),

        notice === null ? null : h('div', {
          style: { ...styles.notice, ...(notice.ok ? styles.noticeOk : styles.noticeError) },
        }, notice.text),

        // ---- accounts ------------------------------------------------
        h('div', { style: styles.section },
          h('h2', { style: styles.sectionTitle }, '邮箱账号'),
          (status?.accounts ?? []).map((a) =>
            h('div', { key: a.id, style: styles.accountRow },
              h('div', { style: styles.accountMain },
                h('div', { style: styles.accountAddress }, `${a.label} · ${a.address}`),
                h('div', { style: styles.accountMeta },
                  `${presets[a.preset]?.label ?? a.preset} · imap ${a.imap.host}:${a.imap.port} · smtp ${a.smtp.host}:${a.smtp.port} · 授权码 ${a.authCodeTail}`)),
              h('span', { style: styles.badge(true) }, presets[a.preset]?.label ?? a.preset),
              h('button', { style: styles.button, onClick: () => testAccount(a.id) }, '测试'),
              h('button', { style: styles.button, onClick: () => removeOne(a.id) }, '删除'))),
          h('div', { style: { height: 10 } }),
          h(Field, { label: '预设' },
            h('select', {
              style: styles.input, value: draft.preset,
              onChange: (e) => setDraftField('preset', e.target.value),
            }, Object.entries(presets).map(([key, p]) => h('option', { key, value: key }, p.label)))),
          h(Field, { label: '邮箱地址' },
            h('input', { style: styles.input, value: draft.address, placeholder: 'you@example.com', onChange: (e) => setDraftField('address', e.target.value) })),
          h(Field, { label: '备注名' },
            h('input', { style: styles.input, value: draft.label, placeholder: '可选', onChange: (e) => setDraftField('label', e.target.value) })),
          h(Field, { label: '授权码' },
            h('input', { style: styles.input, type: 'password', value: draft.authCode, placeholder: 'IMAP/SMTP 授权码，不是登录密码', onChange: (e) => setDraftField('authCode', e.target.value) })),
          draft.preset === 'custom' ? h(React.Fragment, null,
            h(Field, { label: 'IMAP 服务器' },
              h('input', { style: styles.input, value: draft.imapHost, placeholder: 'imap.example.com:993', onChange: (e) => setDraftField('imapHost', e.target.value) })),
            h(Field, { label: 'SMTP 服务器' },
              h('input', { style: styles.input, value: draft.smtpHost, placeholder: 'smtp.example.com:465', onChange: (e) => setDraftField('smtpHost', e.target.value) }))) : null,
          h('div', { style: styles.row },
            h('div', { style: styles.label }),
            h('button', { style: styles.buttonPrimary, onClick: saveAccount }, '保存账号'),
            h('span', { style: styles.help }, '预设账号的服务器已自动填好，自定义预设需手填 IMAP/SMTP。'))),

        // ---- wake whitelist -------------------------------------------
        h('div', { style: styles.section },
          h('h2', { style: styles.sectionTitle }, '白名单唤醒（最高优先级）'),
          h(Field, { label: '启用轮询' },
            h('div', { style: styles.switchWrap },
              h('button', {
                style: cfg.enabled ? styles.buttonPrimary : styles.button,
                role: 'switch', 'aria-checked': cfg.enabled,
                onClick: () => saveConfig({ enabled: !cfg.enabled }),
              }, cfg.enabled ? '已启用' : '已停用'))),
          h(Field, { label: '轮询间隔(秒)' },
            h('input', {
              style: { ...styles.input, flex: '0 0 100px' }, type: 'number', min: 30, value: cfg.pollIntervalSec,
              onChange: (e) => setCfg((c) => ({ ...c, pollIntervalSec: Number(e.target.value) || 120 })),
              onBlur: () => saveConfig({ pollIntervalSec: cfg.pollIntervalSec }),
            })),
          h(Field, { label: 'allowFrom' },
            h('textarea', {
              style: { ...styles.input, minHeight: 72, fontFamily: 'ui-monospace, Consolas, monospace' },
              value: allowText,
              placeholder: 'boss@company.com\n@trusted-domain.com',
              onChange: (e) => setAllowText(e.target.value),
              onBlur: () => saveConfig({ allowFrom: allowText.split('\n').map((s) => s.trim()).filter(Boolean) }),
            })),
          h('div', { style: { ...styles.row, marginTop: -2 } },
            h('div', { style: styles.label }),
            h('span', { style: styles.help }, '每行一条：精确地址 user@x.com 或域名后缀 @x.com。列表为空 = 永不唤醒。')),
          h(Field, { label: '唤醒提示词' },
            h('input', {
              style: styles.input, value: cfg.wakePrompt,
              placeholder: '唤醒后新会话收到的任务说明',
              onChange: (e) => setCfg((c) => ({ ...c, wakePrompt: e.target.value })),
              onBlur: () => saveConfig({ wakePrompt: cfg.wakePrompt }),
            })),
          h(Field, { label: '唤醒工作目录' },
            h('input', {
              style: styles.input, value: cfg.wakeCwd, fontFamily: 'ui-monospace, Consolas, monospace',
              placeholder: '新无头会话的工作目录',
              onChange: (e) => setCfg((c) => ({ ...c, wakeCwd: e.target.value })),
              onBlur: () => saveConfig({ wakeCwd: cfg.wakeCwd }),
            })),
          h('div', { style: styles.row },
            h('div', { style: styles.label }),
            h('button', { style: styles.button, onClick: pollNow }, '立即轮询一次'),
            h('span', { style: styles.help }, '唤醒模型跟随 DSH 当前默认模型（会话不写死 model/selection），无需在此选择。'))),

        // ---- log ------------------------------------------------------
        h('div', { style: styles.section },
          h('h2', { style: styles.sectionTitle }, '活动日志'),
          h('div', { style: styles.log },
            (status?.log ?? []).length === 0
              ? '（暂无记录）'
              : status.log.map((entry, i) => `${new Date(entry.at).toLocaleTimeString('zh-CN')} [${entry.kind}] ${JSON.stringify({ ...entry, at: undefined })}`).join('\n'))))
    }

    function apply(ctx) {
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
