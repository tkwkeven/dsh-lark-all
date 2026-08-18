import { dirname, isAbsolute, join, resolve, basename } from 'node:path'
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync } from 'node:fs'
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { Client, createLarkChannel, Domain, type LarkChannelOptions, type NormalizedMessage } from '@larksuiteoapi/node-sdk'
import axios from 'axios'
import type { LarkChannelFactory, LarkChannelPort } from './channel-port.js'
import type { Config } from './config.js'
import { ConversationManager, type ConversationReply } from './conversations.js'
import { createDocxFromMarkdown, readDocxMarkdown } from './docx.js'
import { uploadFileToDrive } from './drive.js'
import { assertInsideAllowedDirs, buildOutboundMedia, extractMediaMarkers, isAbsoluteOrUrl, resolveOutboundMedia, type OutboundMedia } from './media.js'
import { parseTaskPrefix, splitReportPages, taskModeLabel, truncateText, withTimeout } from './util.js'

const OUTBOUND_TEST_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAMgAAABkCAYAAADDhn8LAAAACXBIWXMAAAPoAAAD6AG1e1JrAAACn0lEQVR4nO3XsZFCQRDEUDIhxA28g1gS4JwrCmQ8QwmoR/vh8Ty74MAN7K2DBzHicAP704FABCKQIxBH4CG4/3HgC+JwPB5HII7AQ3B9QRyBh+B81oGfWKIS1RGII/AQXF8QR+AhOH5iOQIPwf2WA/9BHJsH5wjEEXgIri+II/AQHD+xHIGH4PoP4gg8BOf3DvxJD4yAZR0IJDAClnUgkMAIWNaBQAIjYFkHAgmMgGUdCCQwApZ1IJDACFjWgUACI2BZBwIJjIBlHQgkMAKWdSCQwAhY1oFAAiNgWQcCCYyAZR0IJDAClnUgkMAIWNaBQAIjYFkHAgmMgGUdCCQwApZ1IJDACFjWgUACI2BZBwIJjIBlHQgkMAKWdSCQwAhY1oFAAiNgWQcCCYyAZR0IJDAClnUgkMAIWNaBQAIjYFkHAgmMgGUdCCQwApZ1IJDACFjWgUACI2BZBwIJjIBlHQgkMAKWdSCQwAhY1oFAAiNgWQcCCYyAZR0IJDAClnUgkMAIWNaBQAIjYFkHAgmMgGUdCCQwApZ1IJDACFjWgUACI2BZBwIJjIBlHQgkMAKWdSCQwAhY1oFAAiNgWQcCCYyAZR0IJDAClnUgkMAIWNaBQAIjYFkHAgmMgGUdCCQwApZ1IJDACFjWgUACI2BZBwIJjIBlHQgkMAKWdSCQwAhY1oFAAiNgWQcCCYyAZR0IJDAClnUgkMAIWNaBQAIjYFkHAgmMgGUdCCQwApZ1IJDACFjWgUACI2BZBwIJjIBlHQgkMAKWdSCQwAhY1oFAAiNgWQcCCYyAZR0IJDAClnUgkMAIWNaBQAIjYFkHAgmMgGUdCCQwAroOBBIYAcs6EEhgBCzrQCCBEbCsA4EERsCyDgQSGAHLOhBIYAQs60AggRGwrAOBBEbAsg4EEhgByzoQSGAELOtAIIERsKwDgQRGwLIOBBIYAcs6EEhgBCzrQCCBEbCsA4EERsCyDgQSGAHLOhBIYAQs60AggRGwrAOBBEbAsg4EEhgBCzr4AVwXepBk5abggAAAAABJRU5ErkJggg==',
  'base64',
)

/** Live Feishu/Lark WebSocket bridge backed by the official Node SDK. */
export class LarkHarnessBridge {
  private readonly log
  private readonly inFlight = new Set<Promise<void>>()
  private readonly unsubscribers: Array<() => void> = []
  private channel: LarkChannelPort | undefined
  private conversations: ConversationManager | undefined
  /** Dedicated API client for message reactions, media downloads, docx and Drive. */
  private reactionsClient: Client | undefined
  private stopping = false

  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
    private readonly channelFactory: LarkChannelFactory = options => createLarkChannel(options),
  ) {
    if (!isAbsolute(config.cwd)) throw new Error(`lark-channel: cwd must be absolute, got ${JSON.stringify(config.cwd)}`)
    this.log = ctx.logger('deepseek-harness-lark')
  }

  /** Resolve the secret, connect the official WebSocket client, and accept events. */
  async start(): Promise<void> {
    const secret = await this.resolveSecret()
    const options: LarkChannelOptions = {
      appId: this.config.appId,
      appSecret: secret,
      transport: 'websocket',
      domain: this.config.domain === 'feishu' ? Domain.Feishu : Domain.Lark,
      source: 'deepseek-harness-lark/0.2.2',
      handshakeTimeoutMs: this.config.handshakeTimeoutMs,
      // Keep the raw Feishu event on every normalized message: cloud-document
      // shares (docx/sheet/bitable) are not parsed by the SDK's converters,
      // and their tokens only exist in the raw `message.content`.
      includeRawEvent: true,
      safety: {
        dedup: { maxEntries: this.config.maxSeenMessageIds },
        // Per-chat SDK serialization would block independent task sessions
        // inside one chat; disabled by default so tasks run in parallel.
        chatQueue: { enabled: this.config.chatQueue },
        staleMessageWindowMs: this.config.staleMessageWindowMs,
      },
      policy: {
        dmMode: this.config.singlePolicy,
        dmAllowlist: this.config.singleAllowFrom,
        ...(this.config.groupPolicy === 'allowlist' ? { groupAllowlist: this.config.groupAllowChats } : {}),
        requireMention: this.config.groupRequireMention,
        respondToMentionAll: this.config.respondToMentionAll,
      },
      outbound: {
        textChunkLimit: Math.min(3_500, this.config.maxReplyChars),
        retry: { maxAttempts: this.config.sendRetries + 1, baseDelayMs: 500 },
        streamInitialText: '🧠 任务已接收，正在启动…',
      },
    }
    // Dedicated API client for message reactions (progress / done emoji),
    // inbound media downloads, cloud documents and Drive uploads. The
    // WebSocket channel does not expose its internal client, so these go
    // through their own `Client` sharing the same app credentials.
    this.reactionsClient = new Client({
      appId: this.config.appId,
      appSecret: secret,
      domain: this.config.domain === 'feishu' ? Domain.Feishu : Domain.Lark,
      source: 'deepseek-harness-lark/0.2.2',
    })
    const channel = this.channelFactory(options)
    this.channel = channel
    const conversations = new ConversationManager(this.ctx, this.config, this.mediaHandlers())
    this.conversations = conversations
    await conversations.initialize()
    this.unsubscribers.push(
      channel.on('message', message => this.trackMessage(message)),
      channel.on('error', error => this.log.error('Lark channel error (%s): %s', error.code, error.message)),
      channel.on('reconnecting', () => this.log.warn('Lark WebSocket reconnecting')),
      channel.on('reconnected', () => this.log.info('Lark WebSocket reconnected')),
    )
    await channel.connect()
    const identity = channel.botIdentity
    this.log.info(
      'Lark WebSocket connected%s',
      identity === undefined ? '' : ` as ${identity.name} (${shortId(identity.openId)})`,
    )
  }

  /** Stop event intake, settle owned turns, and close the WebSocket. */
  async stop(): Promise<void> {
    if (this.stopping) return
    this.stopping = true
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe()
    if (this.channel !== undefined) await this.channel.disconnect()
    await Promise.allSettled(this.inFlight)
    if (this.conversations !== undefined) await this.conversations.dispose()
  }

  private async trackMessage(message: NormalizedMessage): Promise<void> {
    if (this.stopping) return Promise.resolve()
    while (this.inFlight.size >= this.config.maxInFlightMessages && !this.stopping) {
      await Promise.race(this.inFlight)
    }
    if (this.stopping) return
    const task = this.handleMessage(message).catch(error => {
      this.log.error('Lark message %s failed: %s', shortId(message.messageId), String(error))
    })
    const tracked = task.finally(() => this.inFlight.delete(tracked))
    this.inFlight.add(tracked)
    return tracked
  }

  private async handleMessage(message: NormalizedMessage): Promise<void> {
    if (!this.allowed(message)) {
      this.traceRouting(message, 'not-allowed')
      return
    }
    this.traceRouting(message, 'received')
    const progressReactionId = await this.markInProgress(message)
    try {
      await this.handleMessageCore(message)
    } finally {
      await this.markDone(message, progressReactionId)
    }
  }

  private async handleMessageCore(message: NormalizedMessage): Promise<void> {
    const command = message.content.trim().split(/\s+/, 1)[0]?.toLowerCase()
    if (command === '/bot-ping') {
      await this.sendReply(message, { text: 'pong — DeepSeek Harness 飞书机器人已连接。', images: [] })
      return
    }
    if (command === '/bot-help') {
      const help = [
        'DeepSeek Harness 飞书机器人',
        '/bot-ping — 检查连通性',
        '/bot-image-test — 发送蓝色图片，检查图片链路',
        '/bot-status — 查看当前连接状态',
        '/bot-cancel — 取消当前生成',
      ]
      if (this.config.outboundMedia) {
        help.push(
          '/bot-send-file <路径|URL> — 发送文件（≤20MB）',
          '/bot-send-image <路径|URL> — 发送原图',
          '/bot-send-voice <路径|URL> — 发送语音（opus）',
          '/bot-send-video <路径|URL> — 发送视频（mp4）',
          '/bot-send-doc <md路径> — 生成飞书云文档并发送链接',
          '模型回复中可用 [lark-file:路径] / [lark-image:路径] / [lark-voice:路径] / [lark-video:路径] / [lark-doc:路径] 标记附带媒体（需在允许目录内）。',
        )
      }
      help.push(
        '任务会话：消息以「ptc任务：」「标准任务：」「极简任务：」「创造任务：」「任务：」开头时创建独立会话（与 Web 相同模式），在该消息的话题里继续对话即可。',
        '其他消息会交给当前 Harness 默认模型处理。',
      )
      await this.sendReply(message, { text: help.join('\n'), images: [] })
      return
    }
    if (command === '/bot-image-test') {
      await this.sendReply(message, {
        text: '蓝色测试图片发送成功。',
        images: [{ data: OUTBOUND_TEST_PNG, mediaType: 'image/png', name: 'lark-image-test.png' }],
      })
      return
    }
    if (command === '/bot-status') {
      await this.sendReply(message, {
        text: '飞书/Lark WebSocket 长连接正常，DeepSeek Harness 会话按聊天/任务独立持久化。',
        images: [],
      })
      return
    }
    if (command === '/bot-cancel') {
      const cancelled = this.requireConversations().cancel(message)
      await this.sendReply(message, {
        text: cancelled ? '已请求取消当前生成。' : '当前没有正在生成的回复。',
        images: [],
      })
      return
    }

    // Outbound media commands: send a local file / original image / voice /
    // video / cloud document to this chat. Sources are realpath-checked
    // against `outboundAllowedDirs` (defaults to cwd); URLs are fetched by
    // the SDK with its built-in SSRF guard.
    if (this.config.outboundMedia && command?.startsWith('/bot-send-')) {
      await this.handleSendMediaCommand(message, command)
      return
    }

    const conversations = this.requireConversations()

    // Exact restart command in the main chat (never inside a task thread).
    if (this.config.taskSessions && message.threadId === undefined && message.rootId === undefined
      && message.content.trim() === this.config.restartCommand) {
      await this.handleRestart(message)
      return
    }

    // A message inside a task thread continues that task's session. The task
    // session is derived deterministically from the thread root (or from the
    // replied-to message via the message registry when thread context is
    // missing), so routing survives process restarts without a registry.
    const taskId = conversations.taskIdFor(message)
    if (taskId !== undefined) {
      this.traceRouting(message, `task:${taskId.slice(-8)}`)
      try {
        const reply = await conversations.processTask(message, this.requireChannel(), taskId, undefined, undefined, '任务')
        await this.sendReply(message, reply, true)
      } catch (error) {
        this.log.error('Lark task thread message failed: %s', String(error))
        await this.sendReply(message, { text: '处理任务消息时发生错误，请稍后重试。', images: [] }, true)
      }
      return
    }

    // A task-mode prefix in the main chat creates a NEW task session.
    if (this.config.taskSessions) {
      const parsed = parseTaskPrefix(message.content, this.config.taskPresets, this.config.taskDefaultPreset)
      if (parsed !== undefined) {
        const taskId = conversations.taskIdFor(message, true)
        if (taskId === undefined) return
        this.traceRouting(message, `new-task:${taskId.slice(-8)}`)
        const modeLabel = taskModeLabel(parsed.keyword)
        try {
          const reply = await conversations.processTask(
            message, this.requireChannel(), taskId, parsed.preset, parsed.content, modeLabel,
          )
          await this.sendReply(message, reply, true)
        } catch (error) {
          this.log.error('Lark task message failed: %s', String(error))
          await this.sendReply(message, { text: '创建任务会话时发生错误，请稍后重试。', images: [] }, true)
        }
        return
      }
    }

    try {
      this.traceRouting(message, 'plain')
      const reply = await conversations.process(message, this.requireChannel())
      await this.sendReply(message, reply)
    } catch (error) {
      this.log.error('Lark message processing failed: %s', String(error))
      await this.sendReply(message, { text: '处理消息时发生错误，请稍后重试。', images: [] })
    }
  }

  /**
   * Append one JSON line per inbound message with its thread context and the
   * routing decision to `<cwd>/.lark-routing.log`. Best-effort: used to
   * diagnose follow-up delivery in the task topic, never fails the message.
   */
  private traceRouting(message: NormalizedMessage, note: string): void {
    try {
      const file = join(this.config.cwd, '.lark-routing.log')
      appendFileSync(file, JSON.stringify({
        at: new Date().toISOString(),
        messageId: message.messageId,
        chatId: message.chatId,
        chatType: message.chatType,
        rootId: message.rootId ?? null,
        threadId: message.threadId ?? null,
        parentId: message.replyToMessageId ?? null,
        sender: shortId(message.senderId),
        note,
      }) + '\n', 'utf8')
    } catch {
      // tracing is best-effort
    }
  }

  /**
   * Handle the exact 「重启进程」 main-chat command: notify the user, record a
   * restart marker (consumed by dsh-harness-ops on the next boot), then
   * relaunch through the process-external safe-restart watchdog
   * (dsh-safe-restart.ps1: config backup -> stop -> launch -> health check ->
   * rollback last-known-good on boot failure -> relaunch -> Feishu notice).
   * Falls back to a bare detached helper when the script is not installed.
   * Finally exit this process.
   */
  private async handleRestart(message: NormalizedMessage): Promise<void> {
    const markerFile = this.config.restartMarkerFile || join(this.config.cwd, '.dsh-ops-restart-marker.json')
    try {
      await this.sendReply(message, {
        text: '🔄 收到重启指令，正在通过安全重启流程重启 DSH 进程（失败会自动回滚配置并通知，约 10~60 秒）。恢复后我会发送恢复提示。',
        images: [],
      })
      await mkdir(dirname(markerFile), { recursive: true })
      await writeFile(markerFile, JSON.stringify({
        chatId: message.chatId,
        reason: 'restart-command',
        at: Date.now(),
      }), 'utf8')

      // Preferred path: process-external safe restart (auto rollback + notice).
      const safeRestartScript = join(this.config.cwd, 'dsh-safe-restart.ps1')
      if (existsSync(safeRestartScript)) {
        spawn('powershell', [
          '-NoProfile', '-ExecutionPolicy', 'Bypass',
          '-File', safeRestartScript,
          '-Mode', 'restart',
        ], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
          cwd: this.config.cwd,
        }).unref()
        this.log.info('Safe restart scheduled via %s', safeRestartScript)
      } else {
        // Fallback: bare detached helper.
        // Relaunch exactly the current process via a detached Node helper.
        // On this machine `ping -n 5` inside a cmd spawned with `stdio:
        // 'ignore'` blocks forever (PING.EXE never returns), so a cmd batch
        // never reaches `dsh web`. The helper waits with `setTimeout` for the
        // old process to release the port, then spawns the current bin directly
        // with spawn(process.execPath, [bin, 'web']) -- verified reliable under
        // detached stdio-ignore spawns (no cmd / batch involved).
        const binPath = process.argv[1] ?? ''
        const helperFile = join(this.config.cwd, '.dsh-restart-helper.mjs')
        const logFile = this.config.restartLogFile || join(this.config.cwd, 'dsh-web.log')
        const delayMs = Math.max(this.config.restartExitDelayMs, 1_000) + 3_000
        const helper = `import { spawn } from 'node:child_process'\n`
          + `import { appendFileSync } from 'node:fs'\n`
          + `setTimeout(() => {\n`
          + `  const bin = ${JSON.stringify(binPath)}\n`
          + `  const cwd = ${JSON.stringify(this.config.cwd)}\n`
          + `  const logFile = ${JSON.stringify(logFile)}\n`
          + `  appendFileSync(logFile, '[dsh-restart] launching ' + bin + ' web\\n')\n`
          + `  const child = spawn(process.execPath, [bin, 'web'], {\n`
          + `    detached: true,\n`
          + `    stdio: 'ignore',\n`
          + `    windowsHide: true,\n`
          + `    cwd,\n`
          + `  })\n`
          + `  child.unref()\n`
          + `}, ${delayMs})\n`
        await writeFile(helperFile, helper, 'utf8')
        spawn(process.execPath, [helperFile], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        }).unref()
        this.log.info('Fallback restart helper scheduled')
      }

      this.log.info('Restart scheduled; exiting in %d ms', this.config.restartExitDelayMs)
      setTimeout(() => process.exit(0), this.config.restartExitDelayMs)
    } catch (error) {
      this.log.error('Lark restart request failed: %s', String(error))
      await this.sendReply(message, { text: '重启失败：无法调度进程重启，请手动重启。', images: [] })
    }
  }

  /**
   * React to the inbound message with the configured progress emoji so the
   * sender immediately sees that the bot started working. Best-effort: any
   * failure is logged and never fails the message itself.
   * @returns the created reaction id (used later to clear the progress emoji).
   */
  private async markInProgress(message: NormalizedMessage): Promise<string | undefined> {
    if (!this.config.progressReaction) return undefined
    const emoji = this.config.progressEmoji.trim()
    const client = this.reactionsClient
    if (emoji === '' || client === undefined) return undefined
    try {
      const result = await withTimeout(
        client.im.v1.messageReaction.create({
          path: { message_id: message.messageId },
          data: { reaction_type: { emoji_type: emoji } },
        }),
        this.config.sendTimeoutMs,
        'Lark progress reaction',
      )
      return result?.data?.reaction_id
    } catch (error) {
      this.log.warn('Lark progress reaction (%s) failed: %s', emoji, String(error))
      return undefined
    }
  }

  /**
   * Clear the progress reaction once the turn settles and optionally react
   * with a done emoji. Best-effort: failures are logged and swallowed.
   */
  private async markDone(message: NormalizedMessage, progressReactionId: string | undefined): Promise<void> {
    const client = this.reactionsClient
    if (client === undefined) return
    try {
      if (progressReactionId !== undefined) {
        await withTimeout(
          client.im.v1.messageReaction.delete({
            path: { message_id: message.messageId, reaction_id: progressReactionId },
          }),
          this.config.sendTimeoutMs,
          'Lark progress reaction clear',
        )
      }
      const done = this.config.doneEmoji.trim()
      if (done !== '') {
        await withTimeout(
          client.im.v1.messageReaction.create({
            path: { message_id: message.messageId },
            data: { reaction_type: { emoji_type: done } },
          }),
          this.config.sendTimeoutMs,
          'Lark done reaction',
        )
      }
    } catch (error) {
      this.log.warn('Lark done reaction failed: %s', String(error))
    }
  }

  private allowed(message: NormalizedMessage): boolean {
    // Topic-group messages (chat_type "topic") and p2p both follow the DM
    // gate: mention is not required inside the task topic, otherwise the
    // follow-ups users send there would be silently dropped.
    if (message.chatType === 'p2p' || String(message.chatType) === 'topic') {
      return this.config.singlePolicy === 'open'
        || (this.config.singlePolicy === 'allowlist' && this.config.singleAllowFrom.includes(message.senderId))
    }
    if (this.config.groupPolicy === 'disabled') return false
    if (this.config.groupPolicy === 'allowlist' && !this.config.groupAllowChats.includes(message.chatId)) return false
    if (!this.config.groupRequireMention) return true
    return message.mentionedBot || (message.mentionAll && this.config.respondToMentionAll)
  }

  private async sendReply(message: NormalizedMessage, reply: ConversationReply, replyInThread = this.config.replyInThread): Promise<void> {
    const channel = this.requireChannel()
    const options = { replyTo: message.messageId, replyInThread }
    // When this inbound message belongs to a task, remember every outbound
    // report page/image so replies to those messages also route to the task.
    const taskId = this.conversations?.taskMessageIdOf(message.messageId)

    // Model-emitted media markers are split off the text first so the
    // visible reply stays clean; each marker becomes a separate message.
    const markerParsed = extractMediaMarkers(reply.text, this.config, this.log)
    const failures: string[] = []
    const media = await buildOutboundMedia(markerParsed.markers, this.config, this.log)
    failures.push(...media.failures)

    const text = truncateText(markerParsed.text, this.config.maxReplyChars)
    // The bundled SDK chunks markdown/text at `textChunkLimit` and only the
    // first chunk is sent as a reply; later chunks drop `replyTo` and fall
    // through to `message.create`, which has no `reply_in_thread` parameter —
    // so page 2+ of a long report lands in the chat's main flow instead of
    // the task thread. Paginate here instead and send every page as its own
    // reply to the original message, keeping every page inside the thread.
    const pageLimit = Math.min(3_500, this.config.maxReplyChars)
    for (const page of splitReportPages(text, pageLimit)) {
      if (!page) continue
      const result = await withTimeout(channel.send(message.chatId, { markdown: page }, options), this.config.sendTimeoutMs, 'Lark text send')
      if (taskId !== undefined) this.conversations?.registerOutboundMessage(result, taskId)
    }
    // Marker media first, then model image blocks (backward compatible).
    for (const item of media.media) {
      const result = await this.sendMediaItem(channel, message.chatId, item, options)
      if (result === undefined) {
        failures.push(`[${item.kind}: ${item.fileName}] 发送失败`)
        continue
      }
      if (taskId !== undefined) this.conversations?.registerOutboundMessage(result, taskId)
    }
    for (const image of reply.images.slice(0, this.config.maxReplyImages)) {
      if (image.data.byteLength > this.config.maxOutboundImageBytes) {
        this.log.warn('Skipping Lark outbound image over %d bytes', this.config.maxOutboundImageBytes)
        continue
      }
      const result = await withTimeout(
        channel.send(message.chatId, { image: { source: Buffer.from(image.data) } }, options),
        this.config.sendTimeoutMs,
        'Lark image send',
      )
      if (taskId !== undefined) this.conversations?.registerOutboundMessage(result, taskId)
    }
    // Report marker failures as one trailing note so the user knows which
    // attachments could not be sent and why.
    if (failures.length > 0) {
      await withTimeout(
        channel.send(message.chatId, {
          markdown: `⚠️ 以下附件发送失败：\n${failures.map(failure => `- ${failure}`).join('\n')}\n提示：本地文件需位于允许的媒体目录内，且不超过大小限制。`,
        }, options),
        this.config.sendTimeoutMs,
        'Lark media failure note',
      )
    }
  }

  /**
   * Send one outbound media item. Local paths and URLs are handed to the
   * SDK uploader (which enforces its own SSRF guard and POSIX blocklist);
   * audio/video fall back to a generic file message when the uploader
   * rejects the container format.
   */
  private async sendMediaItem(
    channel: LarkChannelPort,
    chatId: string,
    item: OutboundMedia,
    options: { replyTo: string; replyInThread: boolean },
  ): Promise<{ messageId?: string; chunkIds?: string[] } | undefined> {
    const label = `Lark ${item.kind} send`
    const attempt = async (): Promise<{ messageId?: string; chunkIds?: string[] } | undefined> => {
      switch (item.kind) {
        case 'file':
          return withTimeout(
            channel.send(chatId, { file: { source: item.source, fileName: item.fileName } }, options),
            this.config.sendTimeoutMs,
            label,
          )
        case 'image':
          return withTimeout(
            channel.send(chatId, { image: { source: item.source } }, options),
            this.config.sendTimeoutMs,
            label,
          )
        case 'audio':
          return withTimeout(
            channel.send(chatId, { audio: { source: item.source } }, options),
            this.config.sendTimeoutMs,
            label,
          )
        case 'video':
          return withTimeout(
            channel.send(chatId, { video: { source: item.source } }, options),
            this.config.sendTimeoutMs,
            label,
          )
      }
    }
    try {
      return await attempt()
    } catch (error) {
      this.log.warn('%s failed (%s): %s', label, item.fileName, String(error))
      // Voice/video must match the container the uploader expects (opus /
      // mp4); fall back to a file message so the content still arrives.
      if (item.kind === 'audio' || item.kind === 'video') {
        this.log.warn('Falling back to a file message for %s', item.fileName)
        return withTimeout(
          channel.send(chatId, { file: { source: item.source, fileName: item.fileName } }, options),
          this.config.sendTimeoutMs,
          'Lark file fallback send',
        )
      }
      return undefined
    }
  }

  /** Execute one `/bot-send-*` media command. */
  private async handleSendMediaCommand(message: NormalizedMessage, command: string): Promise<void> {
    const rest = message.content.trim().slice(command.length).trim()
    if (rest === '') {
      await this.sendReply(message, {
        text: `用法：${command} <路径或 URL>`,
        images: [],
      })
      return
    }
    const source = rest.split(/\s+/, 1)[0] ?? rest
    const chatId = message.chatId
    try {
      switch (command) {
        case '/bot-send-file': {
          const item = await resolveOutboundMedia('file', source, this.config)
          if (typeof item.source === 'string' && !isAbsoluteOrUrl(item.source)) {
            throw new Error('file source must be an absolute path or URL')
          }
          const sent = await this.sendFileOrDrive(item)
          if (sent.kind === 'drive') {
            await this.sendReply(message, {
              text: `📎 文件超过飞书 IM 上限（20MB），已上传至云空间：\n[${sent.fileName}](${sent.url})`,
              images: [],
            })
            return
          }
          const channel = this.requireChannel()
          const result = await this.sendMediaItem(channel, chatId, item, { replyTo: message.messageId, replyInThread: this.config.replyInThread })
          if (result === undefined) throw new Error('send failed')
          break
        }
        case '/bot-send-image': {
          const item = await resolveOutboundMedia('image', source, this.config)
          const result = await this.sendMediaItem(this.requireChannel(), chatId, item, { replyTo: message.messageId, replyInThread: this.config.replyInThread })
          if (result === undefined) throw new Error('send failed')
          break
        }
        case '/bot-send-voice': {
          const item = await resolveOutboundMedia('audio', source, this.config)
          const result = await this.sendMediaItem(this.requireChannel(), chatId, item, { replyTo: message.messageId, replyInThread: this.config.replyInThread })
          if (result === undefined) throw new Error('send failed')
          break
        }
        case '/bot-send-video': {
          const item = await resolveOutboundMedia('video', source, this.config)
          const result = await this.sendMediaItem(this.requireChannel(), chatId, item, { replyTo: message.messageId, replyInThread: this.config.replyInThread })
          if (result === undefined) throw new Error('send failed')
          break
        }
        case '/bot-send-doc': {
          if (!this.config.docxOutbound) {
            await this.sendReply(message, { text: '云文档发送已禁用（docxOutbound: false）。', images: [] })
            return
          }
          const created = await this.createDocxFromFile(source, message.messageId)
          await this.sendReply(message, {
            text: `📄 已生成飞书云文档：\n**[${created.title}](${created.url})**`,
            images: [],
          })
          break
        }
        default:
          await this.sendReply(message, { text: `未知命令：${command}`, images: [] })
          return
      }
    } catch (error) {
      this.log.warn('Lark %s failed: %s', command, String(error))
      await this.sendReply(message, {
        text: `发送失败：${String(error)}\n提示：本地文件需位于允许的媒体目录内（默认工作目录），且不超过大小限制；文件或语音/视频有格式要求。`,
        images: [],
      })
    }
  }

  /**
   * Send one outbound file; files over the IM cap go to Drive when enabled.
   * @returns `{ kind: 'im' }` when sent as an IM message, `{ kind: 'drive', url, fileName }` when uploaded to Drive.
   */
  private async sendFileOrDrive(item: OutboundMedia): Promise<
    { kind: 'im' } | { kind: 'drive'; url: string; fileName: string }
  > {
    const size = typeof item.source === 'string'
      ? await statSize(item.source)
      : item.source.byteLength
    const cap = this.config.maxOutboundFileBytes
    if (size <= cap) return { kind: 'im' }
    if (!this.config.driveLargeFiles) {
      throw new Error(`文件大小 ${size} 超过飞书 IM 上限 ${cap} 字节（driveLargeFiles 未启用）`)
    }
    if (size > this.config.maxDriveFileBytes) {
      throw new Error(`文件大小 ${size} 超过云空间上传上限 ${this.config.maxDriveFileBytes} 字节`)
    }
    const client = this.requireApiClient()
    const data = typeof item.source === 'string'
      ? await readFileBuffer(item.source)
      : Buffer.from(item.source)
    const uploaded = await withTimeout(
      uploadFileToDrive(client, item.fileName, data),
      Math.max(this.config.sendTimeoutMs, 300_000),
      'Lark Drive upload',
    )
    return { kind: 'drive', url: uploaded.url, fileName: uploaded.fileName }
  }

  /** Create a Feishu docx from a local markdown file and return its meta. */
  private async createDocxFromFile(source: string, _replyToMessageId: string): Promise<{ title: string; url: string }> {
    const isUrl = /^https?:\/\//i.test(source)
    let markdown: string
    let title: string
    if (isUrl) {
      markdown = await fetchText(source)
      title = '云端文档'
    } else {
      const local = resolveLocalPath(source)
      assertInsideAllowedDirsLocal(local, this.config)
      markdown = await readFileText(local)
      title = basename(local)
    }
    const client = this.requireApiClient()
    const created = await withTimeout(
      createDocxFromMarkdown(client, title, markdown),
      Math.max(this.config.sendTimeoutMs, 120_000),
      'Lark docx create',
    )
    return { title: created.title, url: created.url }
  }

  private async resolveSecret(): Promise<string> {
    const resolved = await this.ctx.credentials.resolve(credentialRef(this.config.appSecretRef))
    const secret = resolved?.value.trim()
    if (!secret) throw new Error(`lark-channel: credential ${JSON.stringify(this.config.appSecretRef)} is not configured`)
    return secret
  }

  private requireChannel(): LarkChannelPort {
    if (this.channel === undefined) throw new Error('Lark channel has not started')
    return this.channel
  }

  private requireConversations(): ConversationManager {
    if (this.conversations === undefined) throw new Error('Lark conversations have not started')
    return this.conversations
  }

  private requireApiClient(): Client {
    if (this.reactionsClient === undefined) throw new Error('Lark API client has not started')
    return this.reactionsClient
  }

  /**
   * Media handler factory for inbound content processing. Bound per message
   * so parallel in-flight messages never share (or clobber) a message id.
   * Safe to construct before `start()` resolves the secret: the client is
   * created there and accessed lazily.
   */
  private mediaHandlers(): (message: NormalizedMessage) => import('./inbound.js').InboundMediaHandlers {
    return (message: NormalizedMessage) => ({
      downloadResource: (fileKey, type) => this.downloadMessageResource(message, fileKey, type),
      ...(this.config.docxInbound
        ? { readDocx: (documentId: string) => withTimeout(
            readDocxMarkdown(this.requireApiClient(), documentId),
            this.config.mediaDownloadTimeoutMs,
            'Lark docx read',
          ) }
        : {}),
    })
  }

  /**
   * Download a file/audio/video resource of one message via the
   * message-resource endpoint (the only one that serves audio/video).
   */
  private async downloadMessageResource(
    message: NormalizedMessage,
    fileKey: string,
    type: 'file' | 'audio' | 'video',
  ): Promise<Buffer> {
    const client = this.requireApiClient()
    const result = await client.im.v1.messageResource.get({
      path: { message_id: message.messageId, file_key: fileKey },
      params: { type },
    })
    return bufferFromStream(result)
  }
}

function shortId(value: string): string {
  return value.length <= 8 ? value : value.slice(0, 8)
}

/** Collect a stream-shaped SDK response into a Buffer. */
async function bufferFromStream(
  response: { getReadableStream(): NodeJS.ReadableStream } | { writeFile(path: string): Promise<string> } | Buffer,
): Promise<Buffer> {
  if (Buffer.isBuffer(response)) return response
  if (typeof (response as { getReadableStream(): NodeJS.ReadableStream }).getReadableStream === 'function') {
    const stream = (response as { getReadableStream(): NodeJS.ReadableStream }).getReadableStream()
    const chunks: Buffer[] = []
    for await (const chunk of stream as AsyncIterable<Uint8Array>) {
      chunks.push(Buffer.from(chunk))
    }
    return Buffer.concat(chunks)
  }
  const writer = response as { writeFile(path: string): Promise<string> }
  const tmp = join(process.cwd(), `.lark-tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  try {
    await writer.writeFile(tmp)
    const { readFile } = await import('node:fs/promises')
    return await readFile(tmp)
  } finally {
    const { unlink } = await import('node:fs/promises')
    void unlink(tmp).catch(() => undefined)
  }
}

/** Stat a local path; URLs report 0 (pre-flight impossible). */
async function statSize(source: string): Promise<number> {
  if (/^https?:\/\//i.test(source)) return 0
  const info = await stat(source)
  return info.size
}

async function readFileBuffer(source: string): Promise<Buffer> {
  return readFile(source)
}

async function readFileText(source: string): Promise<string> {
  return readFile(source, 'utf8')
}

async function fetchText(url: string): Promise<string> {
  const response = await axios.get<string>(url, { timeout: 30_000, responseType: 'text' })
  return response.data
}

function resolveLocalPath(source: string): string {
  return resolve(source)
}

function assertInsideAllowedDirsLocal(filePath: string, config: Config): void {
  assertInsideAllowedDirs(filePath, config.outboundAllowedDirs.length > 0 ? config.outboundAllowedDirs : [config.cwd])
}
