/**
 * dsh-smart-mail — 邮件托管（mail hosting）核心。
 *
 * 让 `ask_user_question` 的提问可以走邮件：在 `user-questions/request`
 * 瀑布流里接管请求，把问题发成一封邮件，等你回信，再把答案作为
 * `answer_to_pending_question` 回灌原会话。
 *
 * 为什么能接管（2026-11-11 asar 取证）：`@deepseek-ai/dsh-user-questions`
 * 的 `ask()` 走 `ctx.waterfall("user-questions/request", request, noAnswerer)`，
 * 注册在瀑布流上的应答者只要 **返回答案** 就"认领"该请求，否则调用 `next()`
 * 让给下一个（最后是 web 客户端的弹窗应答者）。所以插件可以插在弹窗之前，
 * 决定"这次提问是弹窗还是发邮件"。
 *
 * 三种结局，对应三种语义：
 *   - 邮件方式与本次提问无关（没启用托管）→ `next()`，完全退回原生弹窗；
 *   - 用户回信了（正常）→ 返回 answers，模型原地拿到答案；
 *   - 等到 timed 窗口结束仍无回信 → 抛 `ASK_TIMED_OUT` 让上层返回
 *     `{pending:true, callId}`（问题挂起），晚到的回信再由 `answer()` 回灌。
 *
 * 本模块是纯逻辑（不碰网络/文件），邮件收发与状态持久化由 index.js 注入，
 * 这样"哪些问题该发信、回信怎么对回问题"可以脱离邮箱单测。
 */

/**
 * 一次托管提问的生命周期。
 * @readonly
 */
export const HostedStatus = {
  /** 邮件已发出，等待回信。 */
  waiting: 'waiting',
  /** 已收到回信并解析出答案。 */
  answered: 'answered',
  /** 超时挂起：会话拿到 pending，但问题随时可由晚到的回信回答。 */
  expired: 'expired',
  /**
   * 僵尸：插件以为还挂着，但**平台已经不接受这个 callId 的答案**。
   *
   * 与 `expired` 的区别：`expired` 表示"我们的前台等待结束了、回信仍能投进去"；
   * `stale` 表示平台投影里查不到它（timed 标记缺失年代产生的询问单、会话被重建、
   * 平台已清理等）。两者都不可答时行为一致，但**面板只把 `expired` 算作待答**，
   * 免得像 2026-11-11 那样把 4 个永远投不进去的旧单显示成"4 个待答"。
   */
  stale: 'stale',
  /** 用户回信要求取消/作废这条提问。 */
  cancelled: 'cancelled',
  /** 发信失败或回信无法解析。 */
  failed: 'failed',
}

/**
 * 生成一台提问的稳定标识。
 *
 * 它同时是回信识别的锚点：邮件主题里带 `[q-<ticket>]`、正文里也写明。
 * 用 callId 派生而不是随机，是为了同一 callId 重复发信时幂等（重发邮件
 * 不会产生两台记录，也就不会让"第一条回信"和"第二条回信"互相覆盖）。
 *
 * @param {string} callId 平台给的提问调用 id
 * @returns {string} 8 位十六进制 ticket
 */
export function ticketFor(callId) {
  return String(callId).replace(/[^A-Za-z0-9]/g, '').slice(-8).toLowerCase() || 'unknown'
}

/** 一个选项在邮件里怎么显示：`1. 标签`，标签里换行会破坏列表，压成一行。 */
function optionLine(option, index) {
  const label = String(option?.label ?? '').replace(/\s+/g, ' ').trim()
  const description = String(option?.description ?? '').replace(/\s+/g, ' ').trim()
  return `${index + 1}. ${label}${description === '' ? '' : ` —— ${description}`}`
}

/**
 * 把一次"任务完成"渲染成结果邮件（主题 + 纯文本）。
 *
 * 用户需求（2026-11-11）：托管开启时，会话把活干完了也发一封邮件告诉他结果，
 * 免得守着页面等。这是**通知**而非提问：不需要回复、不产生提问单、不占待答列表。
 *
 * 内容取舍：
 *   - 带会话标题与 ID，方便他对上是哪个任务；
 *   - 正文取该轮最后一条 assistant 文本，**去掉工具调用等噪声**，并截断到
 *     `maxChars`（默认 4000）避免超长回复把邮箱塞爆；
 *   - 明确写"这是完成通知，不需要回复"，否则用户会以为又要答题。
 *
 * @param {object} input
 * @param {string} input.sessionTitle
 * @param {string} input.sessionId
 * @param {string} input.summary 该轮的结果正文（可为空）
 * @param {number} [input.turn] 轮次，便于区分"第几次完成"
 * @param {number} [input.maxChars]
 * @returns {{subject: string, text: string}}
 */
export function renderResultMail({ sessionTitle, sessionId, summary, turn, maxChars = 4000 }) {
  const title = String(sessionTitle ?? '').trim()
  const heading = title === '' ? '会话任务已完成' : `任务完成：${title}`
  const body = String(summary ?? '').trim()
  const clipped = body.length > maxChars
    ? `${body.slice(0, maxChars)}\n\n……（内容过长已截断，完整结果请在会话里查看）`
    : body

  const lines = [
    '你好，',
    '',
    'DSH 的会话已经完成这一轮任务，按「邮件托管」的设置把结果发给你。',
    '**这是完成通知，不需要回复**；想继续聊请回到会话里说。',
    '',
    '──── 会话 ────',
    ...(title === '' ? [] : [`标题：${title}`]),
    ...(sessionId ? [`会话：${sessionId}`] : []),
    ...(typeof turn === 'number' && turn > 0 ? [`轮次：第 ${turn} 轮`] : []),
    `完成时间：${new Date().toLocaleString('zh-CN')}`,
    '',
    '──── 结果 ────',
    clipped === '' ? '（这一轮没有产生文字结果，可能只执行了工具或写入了文件。）' : clipped,
    '',
    '—— DeepSeek Harness · 邮件托管',
  ]
  return { subject: heading, text: lines.join('\n') }
}

/**
 * 把一次提问渲染成邮件（主题 + 纯文本正文）。
 *
 * 纯文本而不是 HTML：回信解析要读用户手打的答案，纯文本让"引用上一封"的
 * 客户端行为可预测，也让 `>` 引用行能可靠剥掉（见 stripQuotedReply）。
 *
 * 多问题：每个问题独立编号成一块，答案按 `问题编号. 答案` 逐行回复。
 * 单问题：额外给"直接回数字"的捷径，减少打字。
 *
 * @param {object} input
 * @param {string} input.ticket
 * @param {Array<object>} input.questions `ask_user_question` 的问题数组
 * @param {string} [input.sessionTitle] 会话标题，方便你认出是哪个会话
 * @param {string} [input.sessionId]
 * @param {number} [input.waitSeconds] 前端等待秒数（仅用于措辞）
 * @param {string} [input.tagPrefix]
 * @returns {{subject: string, text: string}}
 */
export function renderQuestionMail({ ticket, questions, sessionTitle, sessionId, waitSeconds, tagPrefix = '[dsh-' }) {
  const list = Array.isArray(questions) ? questions : []
  const title = String(sessionTitle ?? '').trim()
  const head = `[q-${ticket}] 需要你回答 ${list.length} 个问题`
  const lines = [
    '你好，',
    '',
    'DSH 有个会话在等你做决定，问题已按「邮件托管」转成这封邮件。',
    '**直接回复本邮件**即可，回复内容会作为答案送回那个会话。',
    '',
    '──── 会话 ────',
    ...(title === '' ? [] : [`标题：${title}`]),
    ...(sessionId ? [`会话：${sessionId}`] : []),
    `提问单号：${ticket}（主题里的 [q-${ticket}] 请保留，回信靠它找回原问题）`,
    ...(typeof waitSeconds === 'number' && waitSeconds > 0 ? [`当前等待：约 ${waitSeconds} 秒后转为挂起（挂起后仍可回信，只是会话先继续干别的）`] : ['当前等待：挂起状态，随时回信都能回答']),
    '',
  ]

  list.forEach((question, index) => {
    const number = index + 1
    const header = String(question?.header ?? '').replace(/\s+/g, ' ').trim()
    const body = String(question?.question ?? '').replace(/\s+/g, ' ').trim()
    lines.push(`──── 问题 ${number}${header === '' ? '' : ` · ${header}`}${question?.multiSelect === true ? '（可多选）' : ''} ────`)
    lines.push(body === '' ? '(无题干)' : body)
    const options = Array.isArray(question?.options) ? question.options : []
    if (options.length === 0) {
      lines.push('（本题没有预设选项，请直接写出你的答案）')
    } else {
      lines.push('选项：')
      options.forEach((option, optionIndex) => lines.push(`  ${optionLine(option, optionIndex)}`))
      if (question?.multiSelect === true) {
        lines.push(`回复格式：${number}. 选项号 选项号（例如 "${number}. 1 3"），也可写自定义答案`)
      } else {
        lines.push(`回复格式：${number}. 选项号或自定义答案（例如 "${number}. 2"）`)
      }
    }
    lines.push('')
  })

  lines.push('──── 怎么回答 ────')
  if (list.length === 1) {
    lines.push('只回一个数字就是选对应选项；回一段文字就是自定义答案。')
  } else {
    lines.push('每行一个答案，以问题编号开头，例如：')
    lines.push('  1. 2')
    lines.push('  2. 我自己写的答案')
    lines.push('也可以只回答其中几个问题，没回答的保持待定。')
  }
  lines.push('想取消这次提问：回复 "取消" 两个字即可。')
  lines.push('')
  lines.push('—— DeepSeek Harness · 邮件托管')

  return { subject: head, text: lines.join('\n') }
}

/**
 * 剥掉客户端自动带的引用部分，只留用户真正敲的字。
 *
 * 真实回信里有三层噪声，都必须去掉，否则解析会把上一封的选项行当成答案：
 *   1. `>` 引用块（Gmail/QQ/Foxmail 默认）；
 *   2. "在 2026/11/11，xxx 写道：" / "On ... wrote:" 之后整段；
 *   3. `-----原始邮件-----` / `----Original Message----` 分隔线之后整段；
 *   4. 我方可执行的行 `[q-xxxx]` 主题行若被嵌进正文，也当噪声。
 *
 * @param {string} text
 * @returns {string} 只剩用户输入的正文
 */
export function stripQuotedReply(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n')
  const out = []
  for (const raw of lines) {
    const line = raw.replace(/\u00a0/g, ' ')
    // 引用前缀（可能多层 `>`，也可能 `> ` 后面带空格变化）
    if (/^\s{0,3}>/.test(line)) continue
    if (/^\s*-{2,}\s*(原始邮件|Original Message|Forwarded message)\s*-{2,}\s*$/i.test(line)) break
    if (/^\s*在\s*.{4,80}\s*写道[:：]\s*$/.test(line)) break
    if (/^\s*On\s.+wrote:\s*$/i.test(line)) break
    if (/^\s*发自我的\s*(iPhone|iPad|Android|华为|小米)/i.test(line)) continue
    out.push(line)
  }
  // 去掉尾部空行，并压掉连续空行（不影响逐行解析）
  while (out.length > 0 && out[out.length - 1].trim() === '') out.pop()
  stripTailSignature(out)
  return out.join('\n')
}

/**
 * 剥掉尾部签名块（第七坑，2026-11-11 实证）。
 *
 * 常见邮箱客户端回信默认带「昵称 + 发件邮箱地址」两行签名，旧实现只剥引用，
 * 签名被并进答案：`1 昵称 sender@example.com`，纯数字判定失败 → 选项没被选中。
 *
 * 规则（从严到宽，全部只作用于**尾部**）：
 *   1. 标准签名分隔线 `-- `（RFC 3676 §6.4，usenet/email 惯例）之后整段扔掉；
 *   2. 末尾 3 行以内出现**含邮箱地址的行**才算签名（正文中间的邮箱绝不碰）；
 *      邮箱行及其后的行全扔，紧邻行若像人名/落款（短、无标点、不含选项号）
 *      也一并扔 —— 只针对"最后一两行是 QQ 签名"的最常见形态，不做更激进的猜测。
 */
function stripTailSignature(lines) {
  // 1) 显式签名分隔线
  const dashIndex = lines.findIndex((line) => /^--\s*$/.test(line))
  if (dashIndex >= 0) lines.length = dashIndex
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()

  // 2) 尾部邮箱行连带落款行（只把"尾块"当签名：从**最后一个非空行**往回数
  //    最多 3 行；邮箱行必须落在尾块里，正文中间的邮箱永远不碰）
  const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/
  let last = lines.length - 1
  while (last >= 0 && lines[last].trim() === '') last -= 1
  const tailStart = Math.max(0, last - 2)
  let cut = -1
  for (let i = last; i >= tailStart; i -= 1) {
    if (EMAIL.test(lines[i])) { cut = i; break }
  }
  if (cut >= 0) {
    lines.length = cut
    // 紧邻落款行：像人名（短、无标点、不含数字选项）就一并扔
    if (lines.length > 0) {
      const above = lines[lines.length - 1].trim()
      if (above !== '' && above.length <= 20 && !/[.。,，:：!！?？]/.test(above) && !/\d{1,2}/.test(above)) {
        lines.pop()
      }
    }
  }
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
}

/** 把一行答案拆成"问题编号 + 内容"；不是编号行则返回 undefined。 */
function splitNumbered(line) {
  const match = /^\s*(\d{1,2})\s*[.、:：)）]\s*(.*)$/.exec(line)
  if (match === null) return undefined
  return { number: Number(match[1]), body: match[2].trim() }
}

/** 选项编号列表：`1 3` / `1,3` / `1和3` 都认。 */
function parseOptionNumbers(body) {
  const numbers = []
  const re = /\d{1,2}/g
  let match
  while ((match = re.exec(body)) !== null) numbers.push(Number(match[0]))
  return numbers
}

/** 判断这次的回复是不是"取消"。 */
export function isCancelReply(text) {
  const cleaned = stripQuotedReply(text).replace(/[\s。.!！]/g, '')
  return /^(取消|作废|不用了|算了|cancel)$/i.test(cleaned)
}

/**
 * 把用户的回信解析成 `ask_user_question` 的答案批次。
 *
 * 解析规则（设计成"宽容进、严格出"）：
 *   - 先按问题编号匹配（`3. xxx`），编号越界或重复的行按普通文本处理；
 *   - 没写编号时：只有一个问题的场合，整段当答案；多个问题时，按出现顺序
 *     依次填进还没答的问题（这是大家最自然的写法）；
 *   - 单问题 + 选项：能整体解析成选项号就选选项，否则算自定义答案；
 *   - 多选：解析出多个选项号就全选；同时给了选项号又有额外文字，则把额外
 *     文字放进 `custom`（平台 schema 允许 selected + custom 并存）。
 *
 * 注意：**永远返回与 questions 等长的 answers**，没解析出内容的问题给
 * `{id, selected: []}`（= 跳过）。平台的答案校验要求每个问题恰好出现一次，
 * 少一项就会被判 BAD_ANSWER，所以这里不能省略。
 *
 * @param {string} replyText 用户的回信正文
 * @param {Array<object>} questions 原始问题数组
 * @returns {{answers: Array<{id: string, selected: string[], custom?: string}>, answeredCount: number, skipped: number}}
 */
export function parseAnswerReply(replyText, questions) {
  const list = Array.isArray(questions) ? questions : []
  const body = stripQuotedReply(replyText).trim()
  /** 每个问题的解析结果，先全空，最后再压成 answers。 */
  const slots = list.map(() => ({ selected: [], custom: undefined, touched: false }))

  if (body !== '' ) {
    const numbered = new Map()
    const loose = []
    for (const line of body.split('\n')) {
      if (line.trim() === '') continue
      const split = splitNumbered(line)
      if (split !== undefined && split.number >= 1 && split.number <= list.length && !numbered.has(split.number)) {
        numbered.set(split.number, split.body)
      } else {
        loose.push(line.trim())
      }
    }

    if (numbered.size > 0) {
      for (const [number, content] of numbered) {
        applyAnswer(slots[number - 1], list[number - 1], content)
      }
      // 带编号时，散落的非编号行只可能在"只有一个问题"时才有意义
      if (list.length === 1 && !slots[0].touched && loose.length > 0) {
        applyAnswer(slots[0], list[0], loose.join(' '))
      }
    } else if (loose.length > 0) {
      if (list.length === 1) {
        applyAnswer(slots[0], list[0], loose.join(' '))
      } else {
        // 没编号的多问题回复：按顺序填进还没答的问题
        let cursor = 0
        for (const line of loose) {
          while (cursor < slots.length && slots[cursor].touched) cursor += 1
          if (cursor >= slots.length) break
          applyAnswer(slots[cursor], list[cursor], line)
          cursor += 1
        }
      }
    }
  }

  const answers = list.map((question, index) => {
    const slot = slots[index]
    const answer = { id: String(question?.id ?? String(index + 1)), selected: slot.selected }
    if (slot.custom !== undefined) answer.custom = slot.custom
    return answer
  })
  const answeredCount = slots.filter((slot) => slot.touched).length
  return { answers, answeredCount, skipped: list.length - answeredCount }
}

/** 把一段内容落到某个问题上：命中选项就选，否则算自定义答案。 */
function applyAnswer(slot, question, content) {
  const text = String(content ?? '').trim()
  if (text === '') return
  slot.touched = true
  const options = Array.isArray(question?.options) ? question.options : []

  if (options.length === 0) {
    slot.custom = text
    return
  }

  const numbers = parseOptionNumbers(text)
  const hits = []
  for (const number of numbers) {
    if (number >= 1 && number <= options.length && !hits.includes(number)) hits.push(number)
  }
  // 纯选项号（可能还带标点/空白）才算"选择"；夹了别的字就是自定义答案
  const rest = text.replace(/\d{1,2}/g, '').replace(/[\s,，、;；和及/]+/g, '')
  const pureChoice = hits.length > 0 && rest === ''

  if (pureChoice) {
    slot.selected = hits.map((number) => options[number - 1].label)
    return
  }
  if (hits.length > 0 && question?.multiSelect === true) {
    // 多选 + 补充说明：选项照选，附言进 custom
    slot.selected = hits.map((number) => options[number - 1].label)
    slot.custom = text
    return
  }
  slot.custom = text
}

/**
 * 从回信里认出它回答的是哪一台提问。
 *
 * 三条线索，从严到宽：
 *   1. 主题里的 `[q-xxxx]`（最可靠，我方自己写的）；
 *   2. 正文里"提问单号：xxxx"备份行（用户把主题改掉的场合）；
 *   3. `In-Reply-To` / `References` 命中我方发出的 Message-ID（客户端保留
 *      引用时最准，用户连主题都改了也能对上）。
 *
 * @param {object} input
 * @param {string} [input.subject]
 * @param {string} [input.text] 正文
 * @param {Array<string>} [input.references] 引用链上的所有 Message-ID
 * @param {(messageId: string) => string|undefined} [input.ticketForMessageId]
 * @returns {string|undefined} ticket
 */
export function ticketFromReply({ subject, text, references, ticketForMessageId }) {
  const fromSubject = /\[\s*q-([0-9a-z]{4,16})\s*\]/i.exec(String(subject ?? ''))
  if (fromSubject !== null) return fromSubject[1].toLowerCase()

  const fromBody = /提问单号[:：]\s*([0-9a-z]{4,16})/i.exec(String(text ?? ''))
  if (fromBody !== null) return fromBody[1].toLowerCase()

  for (const id of references ?? []) {
    const ticket = ticketForMessageId?.(id)
    if (ticket !== undefined) return ticket
  }
  return undefined
}

/**
 * 这台提问现在还能不能被回答。
 *
 * `waiting` 与 `expired` 都能：前者模型还在前台等，后者已挂起但我们仍可
 * `answer()` 回灌 —— 这正是"搁一晚上"能成立的原因。
 */
export function isAnswerable(status) {
  return status === HostedStatus.waiting || status === HostedStatus.expired
}
