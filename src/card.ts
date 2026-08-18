/**
 * Streaming task card for Feishu/Lark — implements the interactive-card
 * layout, status mapping, tool labels, argument briefs and throttling
 * constants specified by the channel's card format template.
 *
 * One card is created per task turn, updated in place (same message) while
 * the turn runs, and frozen in its final state when the turn settles. The
 * final answer is delivered as a separate report message and never written
 * into the card.
 */

/** Card lifecycle status (drives header template and status line). */
export type TaskCardStatus = 'created' | 'running' | 'done' | 'error'

/** One todo-list entry rendered on the card. */
export interface TaskCardTodo {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

/** Accumulated streaming state rendered onto one task card. */
export interface TaskCardState {
  status: TaskCardStatus
  /** Current turn's user message summary (truncated when rendered). */
  title: string
  /** Human-readable mode label, e.g. `PTC 模式`. */
  modeLabel: string
  /** Short chat/session id shown next to the mode label. */
  sessionShortId: string
  /** Turn start timestamp (ms) — drives the elapsed-time line. */
  startAt: number
  /** Task round number (1-based). */
  turn: number
  /** Current step within the turn; 0 when no step has started yet. */
  step: number
  /** Most recent tool name (English id, mapped on render). */
  toolName: string
  /** Most recent tool arguments (raw JSON string, briefed on render). */
  toolArgs: string
  /** Accumulated reasoning text; display trims to a tail window. */
  thinking: string
  thinkingChars: number
  /** Latest todo-list snapshot (whole-list replace on `todo/write`). */
  todos: TaskCardTodo[]
}

/** Card layout constants (tunable). */
export const CARD_MIN_UPDATE_MS = 1_000
export const CARD_TITLE_MAX = 24
export const CARD_THINKING_MAX = 240
export const CARD_ANSWER_MAX = 320
export const CARD_ARGS_MAX = 60
export const CARD_ARGS_VALUE_MAX = 40
export const CARD_TODO_MAX = 3
export const CARD_THINKING_CAP = 4_000

/** Tool name → Chinese label map (unknown names render verbatim). */
const TOOL_LABELS: Readonly<Record<string, string>> = Object.freeze({
  bash: '执行命令',
  pwsh: '执行命令(PowerShell)',
  read: '读取文件',
  write: '写入文件',
  edit: '编辑文件',
  glob: '查找文件',
  grep: '搜索内容',
  web_search: '网络搜索',
  subagent: '子代理',
  subagent_fork: '子代理(延续)',
  workflow: '工作流',
  job_output: '后台任务输出',
  job_kill: '停止后台任务',
  job_list: '后台任务列表',
  skill: '加载技能',
  ask_user_question: '询问用户',
  todo_write: '任务清单',
  create_goal: '创建目标',
  get_goal: '读取目标',
  update_goal: '更新目标',
  cordis_define: '定义插件',
  cordis_run: '运行插件',
  cordis_stop: '停止插件',
  cordis_undefine: '删除插件',
  cordis_inspect_list: '检查能力',
  cordis_inspect_query: '查询能力',
  cordis_inspect_self: '检查插件',
  ralph: 'Ralph 循环',
})

/** The Chinese label for one tool name; unknown names render verbatim. */
export function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name
}

/**
 * Brief tool-call arguments for the card's `工具` line.
 * Prefers the `command` / `query` / `pattern` / `name` / `path` /
 * `file_path` field (truncated to 60 chars); falls back to the first
 * `key=value` pair (value truncated to 40 chars); on parse failure the
 * raw string is truncated to 60 chars.
 */
export function briefArgs(raw: string): string {
  const PRIORITY = ['command', 'query', 'pattern', 'name', 'path', 'file_path']
  try {
    const parsed = JSON.parse(raw)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const key of PRIORITY) {
        const value = parsed[key]
        if (value === undefined) continue
        const rendered = typeof value === 'string' ? value : JSON.stringify(value)
        if (rendered !== '' && rendered !== 'undefined') return truncateCardText(rendered, CARD_ARGS_MAX)
      }
      const firstKey = Object.keys(parsed)[0]
      if (firstKey !== undefined) {
        const value = parsed[firstKey]
        const rendered = typeof value === 'string' ? value : JSON.stringify(value)
        return `${firstKey}=${truncateCardText(rendered, CARD_ARGS_VALUE_MAX)}`
      }
    }
  } catch {
    // fall through to the raw-string truncation below
  }
  return truncateCardText(raw, CARD_ARGS_MAX)
}

/** Bound text to a character limit (code-point safe), appending `…` when cut. */
export function truncateCardText(text: string, maxChars: number): string {
  const points = [...text]
  if (points.length <= maxChars) return text
  return points.slice(0, maxChars).join('') + '…'
}

/** Render an elapsed duration as `X 分 Y 秒` (seconds only below one minute). */
export function formatDuration(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.round(elapsedMs / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes > 0) return `${minutes} 分 ${seconds} 秒`
  return `${seconds} 秒`
}

/** Status → header template / title mapping (card format template §3). */
const HEADER_BY_STATUS: Readonly<Record<TaskCardStatus, { template: string; title: string }>> = Object.freeze({
  created: { template: 'blue', title: '🧠 任务执行中' },
  running: { template: 'blue', title: '🧠 任务执行中' },
  done: { template: 'green', title: '✅ 任务完成' },
  error: { template: 'red', title: '⚠️ 任务失败' },
})

/** Status text rendered on the `**状态：**` line (card format template §3). */
const STATUS_TEXT: Readonly<Record<TaskCardStatus, string>> = Object.freeze({
  done: '✅ 已完成',
  error: '⚠️ 失败',
  running: '🟦 思考中…',
  created: '🟦 已创建，等待执行…',
})

/** Todo status → emoji prefix (card format template §4 item 8). */
const TODO_EMOJI: Readonly<Record<TaskCardTodo['status'], string>> = Object.freeze({
  completed: '✅',
  in_progress: '🟦',
  pending: '⬜',
})

interface CardTextElement {
  tag: 'div'
  text: { tag: 'lark_md'; content: string }
}

interface CardNoteElement {
  tag: 'note'
  elements: [{ tag: 'plain_text'; content: string }]
}

/** The rendered interactive-card JSON for one task turn (template §2). */
export interface TaskCard {
  config: { wide_screen_mode: true }
  header: { template: string; title: { tag: 'plain_text'; content: string } }
  elements: Array<CardTextElement | { tag: 'hr' } | CardNoteElement>
}

/**
 * Build the card JSON for the current state. Rows render in template order
 * (§4) and rows without data are skipped; the trailing `<hr>` + note are
 * always present.
 */
export function buildCard(state: TaskCardState): TaskCard {
  const header = HEADER_BY_STATUS[state.status] ?? HEADER_BY_STATUS.running
  const elements: TaskCard['elements'] = []

  const pushRow = (content: string): void => {
    if (content === '') return
    elements.push({ tag: 'div', text: { tag: 'lark_md', content } })
  }

  // 1. 任务： current turn's user message summary (24 chars max).
  const title = state.title.trim().replace(/\s+/g, ' ')
  if (title !== '') pushRow(`**任务：** ${truncateCardText(title, CARD_TITLE_MAX)}`)

  // 2. 模式： mode label · session `<short id>`.
  if (state.modeLabel !== '') {
    const session = state.sessionShortId === '' ? '' : ` · 会话 \`${state.sessionShortId}\``
    pushRow(`**模式：** ${state.modeLabel}${session}`)
  }

  // 3. 状态： status text.
  pushRow(`**状态：** ${STATUS_TEXT[state.status] ?? STATUS_TEXT.running}`)

  // 4. 耗时： elapsed time, only while running.
  if (state.status === 'running') {
    pushRow(`**耗时：** ${formatDuration(Date.now() - state.startAt)}`)
  }

  // 5. 进度： round N · step M (round always; step once it has started).
  if (state.turn > 0) {
    const step = state.step > 0 ? ` · 步骤 ${state.step}` : ''
    pushRow(`**进度：** 第 ${state.turn} 轮${step}`)
  }

  // 6. 工具： Chinese tool label — argument brief (most recent call).
  if (state.toolName !== '') {
    const args = briefArgs(state.toolArgs).trim()
    pushRow(args === '' ? `**工具：** ${toolLabel(state.toolName)}` : `**工具：** ${toolLabel(state.toolName)} — ${args}`)
  }

  // 7. 思考： reasoning tail window (240 chars, scroll-over).
  const thinking = state.thinking.replace(/\s+/g, ' ').trim()
  if (thinking !== '') {
    const points = [...thinking]
    const shown = points.length <= CARD_THINKING_MAX ? thinking : `…${points.slice(-CARD_THINKING_MAX).join('')}`
    pushRow(`**思考：** ${shown}`)
  }

  // 8. 任务清单： up to 3 todo items, one per line.
  if (state.todos.length > 0) {
    const items = state.todos.slice(0, CARD_TODO_MAX)
      .map(todo => `${TODO_EMOJI[todo.status] ?? '⬜'} ${todo.content.replace(/\n/g, ' ')}`)
      .join('\n')
    pushRow(`**任务清单：**\n${items}`)
  }

  // 9–10. divider + footer note.
  elements.push({ tag: 'hr' })
  elements.push({
    tag: 'note',
    elements: [{ tag: 'plain_text', content: '🧠 思考过程实时更新 · 任务完成报告将作为单独消息发送到本话题' }],
  })

  return {
    config: { wide_screen_mode: true },
    header: { template: header.template, title: { tag: 'plain_text', content: header.title } },
    elements,
  }
}

/** Create the initial (created) state for one task turn. */
export function createTaskCardState(init: {
  title: string
  modeLabel: string
  sessionShortId: string
  turn: number
}): TaskCardState {
  return {
    status: 'created',
    title: init.title,
    modeLabel: init.modeLabel,
    sessionShortId: init.sessionShortId,
    startAt: Date.now(),
    turn: init.turn,
    step: 0,
    toolName: '',
    toolArgs: '',
    thinking: '',
    thinkingChars: 0,
    todos: [],
  }
}

/** Append a reasoning delta, keeping the rolling tail window capped. */
export function appendThinking(state: TaskCardState, delta: string): void {
  state.thinking += delta
  state.thinkingChars += delta.length
  if (state.thinkingChars > CARD_THINKING_CAP) {
    const excess = state.thinkingChars - CARD_THINKING_CAP
    const points = [...state.thinking]
    state.thinking = points.slice(excess).join('')
    state.thinkingChars = [...state.thinking].length
  }
}
