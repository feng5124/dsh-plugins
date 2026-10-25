/**
 * dsh-smart-mail — wake bridge.
 *
 * A whitelisted new mail wakes a fresh headless-style session IN-PROCESS:
 *   1. ctx.sessionController.create({ cwd })           -> new session
 *   2. ctx.sessionController.prompt({ ..., mode:'queue' }) -> inject the mail
 * No external CLI, no extra window. Model: the new session records no
 * model/selection, so prompt assembly falls back to agentDefaultModel
 * (the user's current DSH default) — exactly "follow the default model".
 */

import { randomUUID } from 'node:crypto'

/**
 * Wake DSH with one prompt about a whitelisted mail.
 * @param ctx Host Cordis context carrying sessionController.
 * @param mail {from, subject, preview, account, at}
 * @param cfg {wakePrompt, wakeCwd, model}
 * @returns {ok, sessionId?, error?}
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
    await sc.prompt({
      requestId: `smart-mail-${randomUUID()}`,
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
    }, new AbortController().signal) // Remote entry requires a signal arg
    return { ok: true, sessionId }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
