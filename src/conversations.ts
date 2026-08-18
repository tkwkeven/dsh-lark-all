import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection, type Agent, type AgentHandle, type AgentSetup, type ModelSelection } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { NormalizedMessage } from '@larksuiteoapi/node-sdk'
import type { LarkChannelPort } from './channel-port.js'
import type { Config } from './config.js'
import {
  appendThinking,
  buildCard,
  CARD_MIN_UPDATE_MS,
  createTaskCardState,
  type TaskCardState,
} from './card.js'
import { inboundContent, type InboundMediaHandlers } from './inbound.js'
import { sessionIdFor, taskAnchorFor, taskSessionIdFor, withTimeout } from './util.js'

/** Completed response from one Lark-triggered Harness turn. */
export interface ConversationReply {
  text: string
  images: Array<{ data: Uint8Array; mediaType: string; name?: string }>
}

/** Upper bound on remembered task-related message ids (oldest evicted first). */
const MAX_TASK_MESSAGE_IDS = 10_000

/** Owns deterministic Lark conversation agents and persisted resume lifecycle. */
export class ConversationManager {
  private readonly log
  private readonly handles = new Map<string, AgentHandle>()
  private readonly creations = new Map<string, Promise<AgentHandle>>()
  private readonly queues = new Map<string, Promise<unknown>>()
  /** task session id → human-readable mode label (set when the task starts). */
  private readonly taskModes = new Map<string, string>()
  /**
   * Message id → task session id for every message that belongs to a task:
   * the task text, each follow-up, each streaming card and each report page.
   * Feishu p2p reply chains and some topic setups deliver follow-ups without
   * `root_id`/`thread_id`, so `parent_id` against this registry is the only
   * reliable way to route them back to their task.
   */
  private readonly taskMessageIds = new Map<string, string>()
  /** task session id → number of turns processed (for the per-turn card label). */
  private readonly taskTurns = new Map<string, number>()
  /** task session id → report prefix entry {date, seq} (assigned at task creation). */
  private readonly taskSeq = new Map<string, { date: string; seq: number }>()
  private persistedIds = new Set<string>()

  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
    private readonly mediaFactory?: (message: NormalizedMessage) => InboundMediaHandlers,
  ) {
    this.log = ctx.logger('deepseek-harness-lark')
  }

  /** Snapshot persisted identities once before accepting traffic. */
  async initialize(): Promise<void> {
    const headers = await this.ctx.sessionPersistence.list()
    this.persistedIds = new Set(headers.map(header => String(header.id)))
  }

  /**
   * The task session id a message belongs to. Thread messages resolve the
   * thread-root anchor; `create` anchors at the message itself (a fresh task
   * in the main chat). When a follow-up carries no thread context (Feishu p2p
   * reply chains, some topic setups), it is still routed when it replies to
   * (`parent_id`) a known task-related message (task text, card, report or an
   * earlier follow-up). Returns undefined when the task system is disabled or
   * the message cannot be associated with any task.
   */
  taskIdFor(message: NormalizedMessage, create = false): string | undefined {
    if (!this.config.taskSessions) return undefined
    if (!create && message.threadId === undefined && message.rootId === undefined) {
      const parentTaskId = message.replyToMessageId === undefined
        ? undefined
        : this.taskMessageIds.get(message.replyToMessageId)
      if (parentTaskId !== undefined) {
        this.rememberTaskMessage(message.messageId, parentTaskId)
        return parentTaskId
      }
      return undefined
    }
    const anchor = create && message.threadId === undefined && message.rootId === undefined
      ? message.messageId
      : taskAnchorFor(message)
    const id = taskSessionIdFor(this.config.accountId || this.config.appId, message.chatId, anchor)
    this.rememberTaskMessage(message.messageId, id)
    return id
  }

  /** The task session id an inbound or outbound message id belongs to, if any. */
  taskMessageIdOf(messageId: string): string | undefined {
    return this.taskMessageIds.get(messageId)
  }

  /** Register outbound message ids (report pages / images) under a task session. */
  registerOutboundMessage(result: { messageId?: string; chunkIds?: string[] } | undefined, taskId: string): void {
    if (!result?.messageId) return
    this.rememberTaskMessage(result.messageId, taskId)
    for (const id of result.chunkIds ?? []) this.rememberTaskMessage(id, taskId)
  }

  /** Remember one task-related message id, evicting the oldest when capped. */
  private rememberTaskMessage(messageId: string, taskId: string): void {
    this.taskMessageIds.set(messageId, taskId)
    if (this.taskMessageIds.size > MAX_TASK_MESSAGE_IDS) {
      const oldest = this.taskMessageIds.keys().next().value
      if (oldest !== undefined) this.taskMessageIds.delete(oldest)
    }
  }

  /** Process one inbound message after earlier work in the same Lark conversation. */
  process(message: NormalizedMessage, channel: LarkChannelPort): Promise<ConversationReply> {
    const id = sessionIdFor(this.config.accountId || this.config.appId, message)
    // Preempt any busy agent BEFORE queueing: a previous message whose turn
    // is stuck (e.g. waiting on a Web-only question) holds this serial queue
    // via its `whenIdle`, so this message would wait behind it indefinitely.
    this.preemptQueued(id)
    const previous = this.queues.get(id) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(() => this.processNow(id, message, channel))
    const tracked = current.finally(() => {
      if (this.queues.get(id) === tracked) this.queues.delete(id)
    })
    // The queue bookkeeping promise is derived from `current` and nobody
    // awaits it, so a failed turn must not surface as an unhandled rejection.
    tracked.catch(() => undefined)
    this.queues.set(id, tracked)
    return current
  }

  /**
   * Process one task message (a fresh task in the main chat or a follow-up
   * inside the task's thread). Streams the thinking process to a Feishu
   * streaming card inside the thread and returns the final report, which the
   * caller sends as a separate thread message.
   * @param preset - agent preset id for a NEW task ('' = web default);
   *   undefined on thread follow-ups (the stored preset is reused).
   * @param taskContent - stripped task text (fresh tasks only).
   * @param modeLabel - display label for the streaming card.
   */
  processTask(
    message: NormalizedMessage,
    channel: LarkChannelPort,
    taskId: string,
    preset: string | undefined,
    taskContent: string | undefined,
    modeLabel: string,
  ): Promise<ConversationReply> {
    // See `process`: preempt any busy agent before this message queues, so a
    // stuck in-flight turn cannot hold the serial queue indefinitely.
    this.preemptQueued(taskId)
    const previous = this.queues.get(taskId) ?? Promise.resolve()
    const current = previous.catch(() => undefined)
      .then(() => this.processTaskNow(message, channel, taskId, preset, taskContent, modeLabel))
    const tracked = current.finally(() => {
      if (this.queues.get(taskId) === tracked) this.queues.delete(taskId)
    })
    tracked.catch(() => undefined)
    this.queues.set(taskId, tracked)
    return current
  }

  /** Cancel active work for one Lark conversation or task thread. */
  cancel(message: NormalizedMessage): boolean {
    const id = this.taskIdFor(message) ?? sessionIdFor(this.config.accountId || this.config.appId, message)
    const agent = this.handles.get(id)?.agent ?? this.ctx.agents.get(SessionId(id))
    if (agent === undefined || agent.status === 'idle') return false
    agent.cancel({ kind: 'user' })
    return true
  }

  /**
   * Preempt a busy agent before queueing a new inbound message. A running
   * agent only latches a follow-up as a wake request (agent-loop `send`), so
   * without this the message would sit in the inbox until the current turn
   * ends — which never happens when that turn waits on a Web-only
   * interaction such as `ask_user_question` (no answerer exists on the Lark
   * side, so the agent stays busy forever and later messages are stranded).
   * `cancel` with `keepInbox` aborts the in-flight turn without discarding
   * already queued messages; the subsequent `followup` re-arms the driver,
   * so the new message is consumed by a fresh turn as soon as the aborted
   * turn settles.
   */
  private preemptRunning(agent: Agent): void {
    if (agent.status !== 'idle') {
      agent.cancel({ kind: 'user' }, { keepInbox: true })
    }
  }

  /**
   * Preempt the busy agent of one conversation/task before a new message is
   * queued for it. Without this, a stuck in-flight turn keeps its `whenIdle`
   * (and therefore the serial queue head) occupied, and every later message
   * waits behind it until the turn settles — potentially forever. Aborting
   * the turn releases the queue; the follow-up then runs a fresh turn.
   */
  private preemptQueued(id: string): void {
    const agent = this.handles.get(id)?.agent ?? this.ctx.agents.get(SessionId(id))
    if (agent !== undefined) this.preemptRunning(agent)
  }

  /** Dispose every bridge-owned Agent after queued message work settles. */
  async dispose(): Promise<void> {
    await Promise.allSettled(this.queues.values())
    await Promise.allSettled([...this.handles.values()].map(handle => handle.dispose()))
    this.handles.clear()
  }

  private async processNow(
    id: string,
    message: NormalizedMessage,
    channel: LarkChannelPort,
  ): Promise<ConversationReply> {
    const handle = await this.getOrCreate(id, undefined)
    const agent = handle.agent
    const start = agent.session.events.length
    const content = await inboundContent(
      this.ctx, this.config, channel, message, await this.includeImages(agent), undefined,
      this.mediaFactory?.(message),
    )
    // A busy agent (e.g. waiting on a Web-only question) must not strand
    // this message in the inbox: cancel the in-flight turn first, then the
    // follow-up below is consumed by a fresh turn.
    this.preemptRunning(agent)
    agent.followup(createUserMessage({ content, source: { kind: 'user' } }))
    await withTimeout(agent.whenIdle(), this.config.responseTimeoutMs, 'DeepSeek Harness response')
    return this.collectReply(agent, agent.session.events.slice(start))
  }

  private async processTaskNow(
    message: NormalizedMessage,
    channel: LarkChannelPort,
    taskId: string,
    preset: string | undefined,
    taskContent: string | undefined,
    modeLabel: string,
  ): Promise<ConversationReply> {
    const handle = await this.getOrCreate(taskId, preset)
    this.assignTaskSeq(taskId)
    const agent = handle.agent
    const start = agent.session.events.length
    const includeImages = await this.includeImages(agent)
    const content = await inboundContent(
      this.ctx, this.config, channel, message, includeImages, taskContent,
      this.mediaFactory?.(message),
    )
    this.taskModes.set(taskId, modeLabel)
    this.taskTurns.set(taskId, (this.taskTurns.get(taskId) ?? 0) + 1)
    const turn = this.taskTurns.get(taskId) ?? 1
    const label = () => this.taskModes.get(taskId) ?? modeLabel

    // One fresh card per turn (card format template §1): created header,
    // streamed in place while the turn runs, frozen on the final state.
    const state: TaskCardState = createTaskCardState({
      title: (taskContent ?? message.content).trim() || message.content.trim(),
      modeLabel: label(),
      sessionShortId: taskId.slice(-8),
      turn,
    })

    // The streaming card is best-effort: a card failure must never fail the
    // task itself, so the turn keeps running and the report still arrives.
    let streamResult: { messageId?: string; chunkIds?: string[] } | undefined
    // The turn starts inside the card producer — after the initial card is
    // sent and the session-event listener is registered — so the card
    // lifecycle follows the template order (send card, then stream events).
    let turnPromise: Promise<void> | undefined
    try {
      streamResult = await channel.stream(message.chatId, { card: {
        initial: buildCard(state),
        producer: async controller => {
          // Throttle (template §1/§8): updates closer than the minimum
          // interval merge into one pending push; terminal states push
          // immediately, bypassing the throttle.
          let lastPushAt = 0
          let pendingTimer: ReturnType<typeof setTimeout> | undefined
          const push = async (force: boolean): Promise<void> => {
            if (force) {
              if (pendingTimer !== undefined) {
                clearTimeout(pendingTimer)
                pendingTimer = undefined
              }
              lastPushAt = Date.now()
              await controller.update(buildCard(state))
              return
            }
            const now = Date.now()
            if (now - lastPushAt >= CARD_MIN_UPDATE_MS) {
              lastPushAt = now
              await controller.update(buildCard(state))
              return
            }
            if (pendingTimer === undefined) {
              pendingTimer = setTimeout(() => {
                pendingTimer = undefined
                void push(false)
              }, CARD_MIN_UPDATE_MS - (now - lastPushAt))
            }
          }
          const unsubscribe = this.ctx.on('session/event', (session, event) => {
            if (String(session.id) !== taskId) return
            const immediate = this.applyStreamEvent(state, event)
            void push(immediate)
          })
          // Keep the card's elapsed-time display ticking: push once per
          // second while the turn runs (throttle merges closer updates).
          let clockTimer: ReturnType<typeof setInterval> | undefined
          const stopClock = () => {
            if (clockTimer !== undefined) {
              clearInterval(clockTimer)
              clockTimer = undefined
            }
          }
          const startClock = () => {
            if (clockTimer !== undefined) return
            clockTimer = setInterval(() => {
              void push(false).catch(() => {})
            }, 1000)
          }
          startClock()
          turnPromise = (async () => {
            // A busy agent (e.g. waiting on a Web-only question) must not
            // strand this message in the inbox: cancel the in-flight turn
            // first, then the follow-up is consumed by a fresh turn.
            this.preemptRunning(agent)
            agent.followup(createUserMessage({ content, source: { kind: 'user' } }))
            await withTimeout(agent.whenIdle(), this.config.responseTimeoutMs, 'DeepSeek Harness response')
          })()
          try {
            await turnPromise
            // Freeze the card on its final state: turn/end may already have
            // set it, but an explicit assignment guarantees the terminal
            // state even if the last event was lost (template §1).
            state.status = 'done'
            await push(true)
          } catch (error) {
            state.status = 'error'
            await push(true)
            throw error
          } finally {
            if (pendingTimer !== undefined) clearTimeout(pendingTimer)
            stopClock()
            unsubscribe?.()
          }
        },
      } }, { replyTo: message.messageId, replyInThread: true })
    } catch (error) {
      this.log.warn('Lark task streaming card failed (task continues): %s', String(error))
    }
    // Remember the streaming card message(s) so later replies to the card
    // itself are routed back to this task even without thread context.
    this.registerOutboundMessage(streamResult, taskId)
    // When the card stream failed before the producer ran, the turn never
    // started: run it here so the task still completes without a card.
    if (turnPromise === undefined) {
      turnPromise = (async () => {
        this.preemptRunning(agent)
        agent.followup(createUserMessage({ content, source: { kind: 'user' } }))
        await withTimeout(agent.whenIdle(), this.config.responseTimeoutMs, 'DeepSeek Harness response')
      })()
    }
    await turnPromise
    return this.withReportPrefix(taskId, await this.collectReply(agent, agent.session.events.slice(start)))
  }

  /**
   * Fold one session event into the streaming card state (card format
   * template §6). Returns `true` when the event demands an immediate push
   * that bypasses the throttle (terminal error).
   */
  private applyStreamEvent(state: TaskCardState, event: SessionEvent): boolean {
    switch (event.type) {
      case 'turn/start':
        state.status = 'running'
        break
      case 'step/start':
        state.status = 'running'
        state.step = event.data.step
        break
      case 'assistant/chunk': {
        const chunk = event.data.chunk
        switch (chunk.type) {
          case 'block-start':
            if (chunk.blockType === 'reasoning' || chunk.blockType === 'tool-call') state.status = 'running'
            break
          case 'reasoning-delta':
            state.status = 'running'
            appendThinking(state, chunk.text)
            break
          case 'tool-call-delta':
            state.status = 'running'
            if (chunk.name !== undefined && chunk.name !== '') state.toolName = chunk.name
            if (chunk.argumentsDelta !== '') state.toolArgs += chunk.argumentsDelta
            break
          default:
            break
        }
        break
      }
      case 'assistant/message': {
        // Assembled blocks: reasoning → thinking summary; tool-call →
        // tool label + argument brief; text/image stay out of the card
        // (the final report message carries the answer and images).
        for (const block of event.data.message.content) {
          if (block.type === 'reasoning') {
            state.status = 'running'
            state.thinking = block.text
            state.thinkingChars = [...block.text].length
          } else if (block.type === 'tool-call') {
            state.status = 'running'
            state.toolName = block.name
            state.toolArgs = block.arguments
          }
        }
        break
      }
      case 'tool/call': {
        state.status = 'running'
        state.toolName = event.data.name
        state.toolArgs = event.data.arguments
        break
      }
      case 'todo/write':
        state.todos = event.data.todos
        break
      case 'turn/end':
        if (event.data.reason.kind === 'error') {
          state.status = 'error'
          return true
        }
        state.status = 'done'
        break
      default:
        break
    }
    return false
  }

  private async includeImages(agent: Agent): Promise<boolean> {
    if (this.config.imageInputMode === 'always') return true
    if (this.config.imageInputMode === 'never') return false
    const { provider, model } = agent.options
    if (provider === undefined || model === undefined) return false
    const info = await this.ctx.llm.resolveModelInfo(provider, model)
    return info.inputModalities?.includes('image') ?? false
  }

  private async getOrCreate(id: string, preset: string | undefined): Promise<AgentHandle> {
    const existing = this.handles.get(id)
    if (existing !== undefined) return existing
    const pending = this.creations.get(id)
    if (pending !== undefined) return pending
    const creation = this.createOrResume(id, preset).finally(() => this.creations.delete(id))
    this.creations.set(id, creation)
    const handle = await creation
    this.handles.set(id, handle)
    return handle
  }

  /**
   * Compose the preset mount for an agent setup hook and the preset id to
   * record on a fresh session header. `preset` undefined resolves the web
   * default (`settings.yaml` `agent-presets.default`). Returns an empty
   * composition when the roster is absent or the preset is unknown.
   */
  private async presetSetup(
    preset: string | undefined,
  ): Promise<{ agentPreset: string | undefined; setup: AgentSetup | undefined }> {
    const presets = this.ctx.get('agentPresets')
    if (presets === undefined) return { agentPreset: undefined, setup: undefined }
    try {
      const resolvedId = (await presets.resolve(preset)).id
      return {
        agentPreset: resolvedId,
        setup: async agentCtx => {
          await presets.mount(agentCtx, resolvedId)
        },
      }
    } catch (error) {
      this.log.warn('Lark preset resolve failed (%s), falling back to no preset: %s', preset ?? 'default', String(error))
      return { agentPreset: undefined, setup: undefined }
    }
  }

  /** The preset a persisted session was last composed with (header or event). */
  private async storedPreset(id: string): Promise<string | undefined> {
    try {
      const inspection = await this.ctx.sessionPersistence.load(SessionId(id))
      for (let index = inspection.events.length - 1; index >= 0; index -= 1) {
        const event: SessionEvent | undefined = inspection.events[index]
        const type = (event?.type as string | undefined)
        if (type === 'agent-preset/selected') {
          return (event as unknown as { data: { agentPreset: string } }).data.agentPreset
        }
      }
      return inspection.meta.agentPreset
    } catch (error) {
      this.log.warn('Lark stored preset read failed for %s: %s', id, String(error))
      return undefined
    }
  }

  private async createOrResume(id: string, preset: string | undefined): Promise<AgentHandle> {
    const sessionId = SessionId(id)
    const current = this.ctx.agentDefaultModel.currentSelection()
    const agentOptions = { provider: current.provider, model: current.model }
    if (this.persistedIds.has(id)) {
      const stored = await this.storedPreset(id)
      const composed = await this.presetSetup(stored)
      return this.ctx.agents.resume({ resumeSessionId: sessionId, agentOptions, ...(composed.setup === undefined ? {} : { setup: composed.setup }) })
    }

    const composed = await this.presetSetup(preset === undefined ? this.config.taskDefaultPreset || undefined : preset)
    // Fresh task sessions run with the pinned reasoning effort (default max)
    // via the agent-scoped model selection, independent of the deployment
    // default; plain (non-task) sessions keep the global default selection.
    // The requested effort is clamped to what the active provider/model
    // actually supports through the reasoning-effort-auto service: DeepSeek
    // keeps max, while MiMo Token Plan (mimo-*, whose catalog offers no max)
    // is lowered to its highest supported level instead of failing the
    // session with UNSUPPORTED_REASONING_EFFORT. When the service is absent
    // or its capability lookup fails, the requested effort is kept as-is so
    // agent creation never breaks on the adaptation itself.
    const effort = id.startsWith('lark-v1-task-') ? this.config.taskReasoningEffort || 'max' : current.reasoningEffort
    const selection: ModelSelection = { provider: current.provider, model: current.model }
    if (effort !== undefined) {
      const auto = this.ctx.get('reasoningEffortAuto') as
        | { clamp(selection: ModelSelection, desired: string): Promise<string | undefined> }
        | undefined
      const adapted = auto === undefined ? effort : await auto.clamp(selection, effort)
      if (adapted === undefined) {
        this.log.info('Lark model selection for %s keeps no reasoning effort (requested %s)', id, effort)
      } else {
        if (adapted !== effort) {
          this.log.info(
            'Lark reasoning effort for %s clamped %s -> %s (%s/%s)',
            id, effort, adapted, selection.provider, selection.model,
          )
        }
        selection.reasoningEffort = adapted as NonNullable<ModelSelection['reasoningEffort']>
      }
    }
    const setup: AgentSetup = async agentCtx => {
      if (composed.setup !== undefined) await composed.setup(agentCtx)
      installModelSelection(agentCtx, { current: selection, assembled: undefined })
    }
    const handle = await this.ctx.agents.create({
      sessionId,
      meta: {
        cwd: this.config.cwd,
        ...(composed.agentPreset === undefined ? {} : { agentPreset: composed.agentPreset }),
      },
      agentOptions,
      setup,
    })
    this.persistedIds.add(id)
    handle.agent.inject(createUserMessage({
      content: [{ type: 'text', text: this.config.systemPrompt }],
      source: { kind: 'plugin', plugin: 'deepseek-harness-lark', form: 'instructions' },
    }))
    // Feishu-raised tasks run with Full access by default: pin the
    // danger-full-access preset (sandbox + approval) on every fresh task
    // session, independent of the deployment-wide default.
    if (id.startsWith('lark-v1-task-')) this.pinFullAccess(handle)
    return handle
  }

  /**
   * Pin a freshly created task session to the Full access preset
   * (`danger-full-access` sandbox + `never` approval) so tasks proposed in
   * Feishu conversations never inherit a narrower deployment default.
   * Best-effort: a missing permissionPresets service or a failed preset
   * switch only logs a warning; the task itself still runs.
   */
  private pinFullAccess(handle: AgentHandle): void {
    const presets = this.ctx.get('permissionPresets') as
      | { set(session: Session, name: string): void }
      | undefined
    if (presets === undefined) {
      this.log.warn('Lark task Full access pin skipped: permissionPresets service unavailable')
      return
    }
    try {
      presets.set(handle.agent.session, 'danger-full-access')
    } catch (error) {
      this.log.warn('Lark task Full access pin failed (task continues): %s', String(error))
    }
  }

  private async collectReply(agent: Agent, events: readonly SessionEvent[]): Promise<ConversationReply> {
    const texts: string[] = []
    const images: ConversationReply['images'] = []
    for (const event of events) {
      if (event.type !== 'assistant/message') continue
      for (const block of event.data.message.content) {
        if (block.type === 'text' && block.text.trim()) texts.push(block.text.trim())
        if (block.type === 'image') {
          const stored = await this.ctx.attachments.readImage(block.attachment)
          images.push({
            data: stored.data,
            mediaType: stored.ref.mediaType,
            ...(stored.ref.name === undefined ? {} : { name: stored.ref.name }),
          })
        }
      }
    }

    const finalTurn = [...events].reverse().find(event => event.type === 'turn/end')
    if (texts.length === 0 && finalTurn?.type === 'turn/end' && finalTurn.data.reason.kind === 'error') {
      return { text: `处理失败（${finalTurn.data.reason.error.code}），请稍后重试。`, images }
    }
    if (texts.length === 0 && images.length === 0) {
      return { text: '处理完成，但没有生成可发送的内容。', images }
    }
    return { text: texts.join('\n\n'), images }
  }

  /** The fixed task-report prefix line: ✅[identity] [date-任务-seq], H2 + bold. */
  private reportPrefixLine(taskId: string): string | null {
    const entry = this.taskSeq.get(taskId)
    if (entry === undefined) return null
    const identity = this.config.reportIdentity || 'wdsh'
    return `## **✅[${identity}] [${entry.date}-任务-${entry.seq}]**`
  }

  /** Prepend the fixed prefix line to a task report (keeps the card untouched). */
  private withReportPrefix(taskId: string, reply: ConversationReply): ConversationReply {
    const prefix = this.reportPrefixLine(taskId)
    if (prefix === null) return reply
    const text = reply.text.trim()
    if (text === '') return reply
    return { text: `${prefix}\n\n${text}`, images: reply.images }
  }

  /** Assign the per-day sequential task number for a task session (resets at 00:00 local time). */
  private assignTaskSeq(taskId: string): void {
    if (this.taskSeq.has(taskId)) return
    const now = new Date()
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    const counter = this.loadTaskCounter()
    const tasks = counter.tasks ?? {}
    const existing = tasks[taskId]
    if (existing !== undefined) {
      this.taskSeq.set(taskId, { date: existing.date, seq: existing.seq })
      return
    }
    if (counter.date !== date) {
      counter.date = date
      counter.seq = 0
    }
    counter.seq += 1
    tasks[taskId] = { date, seq: counter.seq }
    counter.tasks = tasks
    this.saveTaskCounter(counter)
    this.taskSeq.set(taskId, { date, seq: counter.seq })
  }

  private loadTaskCounter(): { date: string; seq: number; tasks: Record<string, { date: string; seq: number }> } {
    try {
      const file = this.config.taskCounterFile || join(this.config.cwd, '.lark-task-counter.json')
      const raw = readFileSync(file, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && typeof parsed.date === 'string' && typeof parsed.seq === 'number') {
        return { date: parsed.date, seq: parsed.seq, tasks: parsed.tasks && typeof parsed.tasks === 'object' ? parsed.tasks : {} }
      }
    } catch (error) {
      this.log.warn('Lark task counter read failed: %s', String(error))
    }
    return { date: '', seq: 0, tasks: {} }
  }

  private saveTaskCounter(counter: { date: string; seq: number; tasks: Record<string, { date: string; seq: number }> }): void {
    try {
      const file = this.config.taskCounterFile || join(this.config.cwd, '.lark-task-counter.json')
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify(counter, null, 2), 'utf8')
    } catch (error) {
      this.log.warn('Lark task counter write failed: %s', String(error))
    }
  }
}
