// Type-only port over the official Lark channel, so the bridge stays
// testable and decoupled from the SDK's concrete channel class. All shapes
// come straight from the official Node SDK.
import type {
  BotIdentity,
  EventMap,
  EventName,
  LarkChannelOptions,
  ResourceType,
  SendInput,
  SendOptions,
  SendResult,
  StreamInput,
} from '@larksuiteoapi/node-sdk'

/** Identity of the connected bot, as reported by the channel. */
export type LarkChannelIdentity = BotIdentity

/** Options accepted by `send` / `stream` on the channel port. */
export type LarkChannelSendOptions = SendOptions

/** Result of an outbound `send` / `stream` call. */
export type LarkChannelSendResult = SendResult

/**
 * Thin port over the official SDK channel: connect / disconnect lifecycle,
 * message and connection events, text & media sending, card streaming and
 * inbound resource downloads. The default factory in the bridge wraps the
 * SDK's `createLarkChannel`, which satisfies this interface structurally.
 */
export interface LarkChannelPort {
  connect(): Promise<void>
  disconnect(): Promise<void>
  readonly botIdentity?: LarkChannelIdentity
  on<K extends EventName>(name: K, handler: EventMap[K]): () => void
  send(to: string, input: SendInput, opts?: SendOptions): Promise<SendResult>
  stream(to: string, input: StreamInput, opts?: SendOptions): Promise<SendResult>
  downloadResource(fileKey: string, type: ResourceType): Promise<Buffer>
}

/** Creates a channel port from SDK channel options. */
export type LarkChannelFactory = (options: LarkChannelOptions) => LarkChannelPort
