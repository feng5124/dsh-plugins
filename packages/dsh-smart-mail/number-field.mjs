/**
 * dsh-smart-mail — numeric field behaviour, kept free of React.
 *
 * The panel's number inputs used to bind a *number* directly to a controlled
 * `<input type="number">` and re-parse it on every keystroke:
 *
 *     onChange: (e) => setCfg(c => ({ ...c, pollIntervalSec: Number(e.target.value) || 120 }))
 *
 * That makes the field impossible to type into. Clearing it yields `''`,
 * `Number('') || 120` immediately writes 120 back, so the next digit lands
 * after "120" instead of starting a new number; the periodic status refresh
 * overwrites whatever was in flight; and the only gesture that works is the
 * spinner arrow, one step at a time.
 *
 * The fix is the ordinary one: keep the draft as *text* while the user types and
 * only parse, clamp, and commit on blur/Enter. These functions are the whole of
 * that behaviour, so it can be tested without a DOM.
 *
 * @module dsh-smart-mail/number-field
 */

/**
 * Keep only digits, so a pasted "1 200" or "30秒" becomes a number the user
 * meant. An empty result is valid: it is the intermediate state of clearing the
 * field before typing the real value.
 * @param {string} raw
 * @returns {string}
 */
export function sanitizeDigits(raw) {
  return String(raw ?? '').replace(/[^\d]/g, '')
}

/**
 * Parse a draft into a committed value.
 *
 * @param {string} draft text currently in the field
 * @param {{min: number, max?: number}} bounds
 * @returns {number|null} the clamped integer, or `null` when the draft is not a number
 */
export function parseDraft(draft, { min, max }) {
  const text = String(draft ?? '').trim()
  if (text === '') return null
  const parsed = Number(text)
  if (!Number.isFinite(parsed)) return null
  let next = Math.trunc(parsed)
  if (next < min) next = min
  if (max !== undefined && next > max) next = max
  return next
}

/**
 * What the field should show after a commit attempt.
 *
 * A blank or unparseable draft restores the last committed value rather than
 * guessing — silently substituting a default is what made the old field feel
 * like it "fought back".
 *
 * @param {{draft: string, value: number, min: number, max?: number}} input
 * @returns {{display: string, commit: number|null}} the text to show and the value to persist (null = nothing to save)
 */
export function resolveCommit({ draft, value, min, max }) {
  const next = parseDraft(draft, { min, max })
  if (next === null) return { display: String(value), commit: null }
  return { display: String(next), commit: next === value ? null : next }
}

/**
 * One click of the step buttons.
 *
 * Stepping starts from whatever is currently typed when that is a number, so
 * "+" after typing "1" gives "31" for a 30-second step rather than jumping from
 * the stale committed value. The step is applied *before* clamping: clamping the
 * partial draft first would turn "1" into 30 and then add 30, giving 60 — not
 * what the user asked for.
 *
 * @param {{draft: string, value: number, min: number, max?: number, step: number, direction: 1|-1}} input
 * @returns {{display: string, commit: number|null}}
 */
export function resolveStep({ draft, value, min, max, step, direction }) {
  const text = String(draft ?? '').trim()
  const typed = text !== '' && Number.isFinite(Number(text)) ? Math.trunc(Number(text)) : null
  const base = typed ?? value
  let next = base + direction * step
  if (next < min) next = min
  if (max !== undefined && next > max) next = max
  return { display: String(next), commit: next === value ? null : next }
}

/**
 * Whether a background refresh may overwrite the field.
 *
 * A poll that lands while the user is typing must not clobber the draft; this is
 * the rule that made the old field lose keystrokes.
 *
 * @param {{editing: boolean}} input
 * @returns {boolean}
 */
export function shouldSyncFromServer({ editing }) {
  return !editing
}
