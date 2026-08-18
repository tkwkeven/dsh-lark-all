import { createHash } from 'node:crypto'
import type { NormalizedMessage } from '@larksuiteoapi/node-sdk'

/** Deterministic, non-identifying DSH session id for one Lark conversation. */
export function sessionIdFor(
  accountId: string,
  message: Pick<NormalizedMessage, 'chatType' | 'chatId' | 'threadId'>,
  threadSessions = false,
): string {
  const scope = message.chatType === 'group' ? 'group' : 'single'
  const thread = threadSessions && message.threadId ? `\0${message.threadId}` : ''
  if (message.chatId.length === 0) throw new Error(`Lark ${scope} message has no chat identifier`)
  const digest = createHash('sha256')
    .update(`${accountId}\0${scope}\0${message.chatId}${thread}`)
    .digest('hex')
    .slice(0, 32)
  return `lark-v1-${scope}-${digest}`
}

/**
 * Deterministic DSH session id for one task. A task is anchored at the
 * message that started it (the thread root): the anchor is the task message's
 * own id, and every follow-up message inside the task's thread resolves the
 * same anchor from `rootId` (falling back to the stable `threadId`).
 */
export function taskSessionIdFor(accountId: string, chatId: string, anchorId: string): string {
  if (chatId.length === 0) throw new Error('Lark task message has no chat identifier')
  if (anchorId.length === 0) throw new Error('Lark task message has no anchor identifier')
  const digest = createHash('sha256')
    .update(`${accountId}\0task\0${chatId}\0${anchorId}`)
    .digest('hex')
    .slice(0, 24)
  return `lark-v1-task-${digest}`
}

/**
 * The stable anchor that identifies the task a message belongs to: the thread
 * root message id when the message lives in a thread, otherwise the message
 * itself (a fresh task starts at its own message).
 */
export function taskAnchorFor(message: Pick<NormalizedMessage, 'messageId' | 'rootId' | 'threadId'>): string {
  return message.rootId ?? message.threadId ?? message.messageId
}

/** Built-in task prefixes: keyword → agent-preset id ('' = web default). */
export const BUILTIN_TASK_PRESETS: Readonly<Record<string, string>> = Object.freeze({
  ptc: 'code',
  标准: 'standard',
  极简: 'minimal',
  创造: 'cordis',
})

/**
 * Parse a task-mode prefix from an inbound message.
 * Accepts `ptc任务：`/`ptc任务:` (also `标准`/`极简`/`创造` as the mode word)
 * and the bare `任务：`/`任务:`, each with an ASCII or full-width colon and
 * optional spacing. Returns the configured preset id ('' = web default) and
 * the remaining task content, or undefined when the message carries no task
 * prefix.
 */
export function parseTaskPrefix(
  text: string,
  presets: Record<string, string> = {},
  defaultPreset = '',
): { preset: string; content: string; keyword: string } | undefined {
  const match = /^\s*(?:(ptc|标准|极简|创造)\s*)?任务\s*[:：]\s*([\s\S]*)$/.exec(text)
  if (match === null) return undefined
  const keyword = match[1] ?? '任务'
  const content = match[2] ?? ''
  if (keyword === '任务') return { preset: defaultPreset, content, keyword }
  const configured = presets[keyword]
  const preset = configured === undefined ? (BUILTIN_TASK_PRESETS[keyword] ?? '') : configured
  return { preset: preset === 'default' ? '' : preset, content, keyword }
}

/** Human-readable mode label for a parsed task prefix (for cards/notices). */
export function taskModeLabel(keyword: string): string {
  switch (keyword) {
    case 'ptc': return 'PTC 模式'
    case '标准': return '标准模式'
    case '极简': return '极简模式'
    case '创造': return '创造模式'
    default: return '默认模式'
  }
}

/**
 * Split one long report into pages of at most `limit` characters. Breaks at
 * line boundaries, prefers heading boundaries when a page is near full, and
 * never cuts inside a fenced code block (an open fence is closed at the page
 * break and reopened at the start of the next page). A single line longer
 * than `limit` is hard-split so every page fits the limit.
 *
 * The boundary logic mirrors the bundled SDK's markdown splitter so the
 * pages produced here match what the SDK would send on its own — with one
 * difference: the SDK keeps over-long lines whole (and then chunks them via
 * a non-thread path), while this helper guarantees every page fits.
 */
export function splitReportPages(text: string, limit: number): string[] {
  if (limit <= 0) return [text]
  if (text.length <= limit) return [text]
  // Hard-split pathological single lines first so no page can exceed limit.
  const lines: string[] = []
  for (const line of text.split('\n')) {
    if (line.length < limit) {
      lines.push(line)
      continue
    }
    for (let start = 0; start < line.length; start += limit) {
      lines.push(line.slice(start, start + limit))
    }
  }
  const pages: string[] = []
  let buf: string[] = []
  let bufLen = 0
  let fenceLang: string | null = null
  const flush = (): void => {
    if (buf.length === 0) return
    let chunk = buf.join('\n')
    if (fenceLang !== null) chunk += '\n```'
    pages.push(chunk)
    buf = []
    bufLen = 0
    if (fenceLang !== null) {
      buf.push(`\`\`\`${fenceLang}`)
      bufLen = buf[0]?.length ?? 0
    }
  }
  for (const line of lines) {
    const fence = /^```(\w*)$/.exec(line)
    const lineLen = line.length + (buf.length > 0 ? 1 : 0) // +1 for '\n'
    const isHeading = /^#{1,6}\s/.test(line)
    const nearFull = bufLen > limit * 0.75
    if (bufLen + lineLen > limit || (isHeading && nearFull && buf.length > 0)) {
      flush()
    }
    buf.push(line)
    bufLen += lineLen
    if (fence !== null) {
      // entering or leaving a fence
      fenceLang = fenceLang === null ? (fence[1] || '') : null
    }
  }
  flush()
  return pages
}

/** Bound Unicode text to a character limit without splitting a code point. */
export function truncateText(text: string, maxChars: number, suffix = '\n\n[回复已截断]'): string {
  const normalized = text.trim()
  const points = [...normalized]
  if (points.length <= maxChars) return normalized
  const suffixPoints = [...suffix]
  const available = Math.max(0, maxChars - suffixPoints.length)
  return points.slice(0, available).join('') + (suffixPoints.length <= maxChars ? suffix : '')
}

/** Promise timeout with a stable, caller-facing label. */
export async function withTimeout<T>(task: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      task,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
