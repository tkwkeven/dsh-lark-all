import type { Context } from '@deepseek-ai/cordis'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { NormalizedMessage } from '@larksuiteoapi/node-sdk'
import type { LarkChannelPort } from './channel-port.js'
import type { Config } from './config.js'
import { storeInboundResource } from './media.js'
import { withTimeout } from './util.js'

/** Message types Feishu uses for cloud-document shares. */
const CLOUD_DOC_TYPES = new Set(['docx', 'sheet', 'bitable', 'mindnote', 'slides'])

/** Options passed by the bridge to enrich inbound content with media. */
export interface InboundMediaHandlers {
  /** Download a file/audio/video resource of one message (message-resource endpoint). */
  downloadResource(fileKey: string, type: 'file' | 'audio' | 'video'): Promise<Buffer>
  /** Read a Feishu docx's markdown content; absent when disabled. */
  readDocx?(documentId: string): Promise<string>
}

/** Build durable DSH content blocks from one normalized Lark message. */
export async function inboundContent(
  ctx: Context,
  config: Config,
  channel: LarkChannelPort,
  message: NormalizedMessage,
  includeImages = true,
  textOverride?: string,
  media?: InboundMediaHandlers,
): Promise<ContentBlock[]> {
  const scope = message.chatType === 'group' ? 'Lark group' : 'Lark private chat'
  const textParts = [`[${scope} message from Lark user ${shortId(message.senderId)}]`]
  const normalized = textOverride === undefined ? normalizedText(message) : textOverride
  if (normalized) textParts.push(normalized)

  const imageResources = message.resources
    .filter(resource => resource.type === 'image')
    .slice(0, ctx.attachments.imageLimits.maxImagesPerMessage)
  const imageBlocks: ContentBlock[] = []
  let totalImageBytes = 0
  for (const image of imageResources) {
    const remaining = ctx.attachments.imageLimits.maxMessageImageBytes - totalImageBytes
    const maxBytes = Math.min(ctx.attachments.imageLimits.maxImageBytes, remaining)
    if (maxBytes <= 0) break
    let data: Buffer
    try {
      data = await withTimeout(
        channel.downloadResource(image.fileKey, 'image'),
        config.mediaDownloadTimeoutMs,
        'Lark image download',
      )
    } catch (error) {
      textParts.push(`[Lark image download failed: ${String(error)}]`)
      continue
    }
    // Oversized images degrade to a stored inbox file instead of failing the
    // whole message, so "原图" uploads still reach the model as a path.
    if (data.byteLength > maxBytes) {
      textParts.push(`[Lark original image ${image.fileName ?? ''} is ${data.byteLength} bytes, over the ${maxBytes}-byte model limit; `)
      if (config.inboundFiles) {
        const stored = await storeInboundResource(
          async (_fileKey, _type) => data,
          config,
          { type: 'file', fileKey: image.fileKey, ...(image.fileName === undefined ? {} : { fileName: image.fileName }) },
          chatKeyFor(message),
          { warn: (message: string) => { ctx.logger('deepseek-harness-lark').warn(message) } },
        )
        if (stored !== undefined) {
          textParts[textParts.length - 1] += `stored at ${stored.path}. The selected model cannot inspect it inline; use file tools to read it.]`
        } else {
          textParts[textParts.length - 1] += `storage failed; bytes were discarded.]`
        }
      } else {
        textParts[textParts.length - 1] += `bytes were discarded (inboundFiles disabled).]`
      }
      continue
    }
    let mediaType: ImageMediaType
    try {
      mediaType = detectImageMediaType(data)
    } catch (error) {
      textParts.push(`[Lark image has an unsupported format: ${String(error)}]`)
      continue
    }
    const ref = await ctx.attachments.saveImage({
      data,
      mediaType,
      ...(image.fileName === undefined ? {} : { name: image.fileName }),
    })
    totalImageBytes += ref.bytes
    if (includeImages) {
      imageBlocks.push({ type: 'image', attachment: ref })
    } else {
      const label = image.fileName?.trim() || ref.mediaType
      textParts.push([
        `[Lark image received: ${label}.`,
        `Stored as Harness attachment ${String(ref.attachmentId)}.`,
        'The selected model is text-only and cannot inspect its pixels.]',
      ].join(' '))
    }
  }

  // Files, voice and video: download to the inbox and describe them.
  const fileResources = message.resources.filter(resource => resource.type === 'file')
  const mediaResources = message.resources.filter(resource => resource.type === 'audio' || resource.type === 'video')
  if (fileResources.length > 0 || mediaResources.length > 0) {
    const chatKey = chatKeyFor(message)
    for (const resource of fileResources) {
      if (!config.inboundFiles) {
        textParts.push(`[Lark file received: ${resource.fileName ?? 'unnamed'} (inboundFiles disabled; not downloaded)]`)
        continue
      }
      const stored = await storeInboundResource(
        (fileKey, type) => {
          if (media === undefined) throw new Error('resource downloader unavailable')
          return media.downloadResource(fileKey, type)
        },
        config,
        { type: 'file', fileKey: resource.fileKey, ...(resource.fileName === undefined ? {} : { fileName: resource.fileName }) },
        chatKey,
        { warn: (message: string) => { ctx.logger('deepseek-harness-lark').warn(message) } },
      )
      if (stored === undefined) {
        textParts.push(`[Lark file ${resource.fileName ?? 'unnamed'} download failed or was skipped]`)
        continue
      }
      const parts = [
        `[Lark file received: ${stored.fileName} (${stored.bytes} bytes), stored at ${stored.path}.`,
      ]
      if (stored.preview !== undefined) {
        parts.push(`Content preview:\n${stored.preview}`)
      } else {
        parts.push('Use file tools to inspect it if needed.]')
      }
      textParts.push(parts.join(' '))
    }
    for (const resource of mediaResources) {
      if (!config.inboundMedia) {
        textParts.push(`[Lark ${resource.type} received: ${resource.fileName ?? 'unnamed'} (inboundMedia disabled; not downloaded)]`)
        continue
      }
      const stored = await storeInboundResource(
        (fileKey, type) => {
          if (media === undefined) throw new Error('resource downloader unavailable')
          return media.downloadResource(fileKey, type)
        },
        config,
        {
          type: resource.type === 'audio' ? 'audio' : 'video',
          fileKey: resource.fileKey,
          ...(resource.fileName === undefined ? {} : { fileName: resource.fileName }),
          ...(resource.durationMs === undefined ? {} : { durationMs: resource.durationMs }),
        },
        chatKey,
        { warn: (message: string) => { ctx.logger('deepseek-harness-lark').warn(message) } },
      )
      if (stored === undefined) {
        textParts.push(`[Lark ${resource.type} ${resource.fileName ?? 'unnamed'} download failed or was skipped]`)
        continue
      }
      const duration = stored.durationMs === undefined ? '' : `, ${Math.round(stored.durationMs / 1000)}s`
      textParts.push(
        `[Lark ${resource.type} received: ${stored.fileName} (${stored.bytes} bytes${duration}), stored at ${stored.path}. ` +
        'Use file tools to inspect or transcribe it if needed.]',
      )
    }
  }

  // Stickers cannot be downloaded by the bot; just acknowledge them.
  const stickers = message.resources.filter(resource => resource.type === 'sticker')
  if (stickers.length > 0) {
    textParts.push(`[Lark sticker received (${stickers.length}); stickers cannot be downloaded by the bot]`)
  }

  // Feishu cloud documents: parse the share token from the raw event and,
  // for docx, read the content so the model can answer questions about it.
  const cloudDoc = await describeCloudDoc(config, message, media)
  if (cloudDoc !== undefined) textParts.push(cloudDoc)

  if (!normalized && imageBlocks.length === 0 && imageResources.length === 0
    && fileResources.length === 0 && mediaResources.length === 0 && stickers.length === 0
    && cloudDoc === undefined) {
    textParts.push(`[Unsupported Lark message type: ${message.rawContentType}]`)
  }
  return [{ type: 'text', text: textParts.join('\n') }, ...imageBlocks]
}

/** Build the model-facing description for a cloud-document share message. */
async function describeCloudDoc(
  config: Config,
  message: NormalizedMessage,
  media: InboundMediaHandlers | undefined,
): Promise<string | undefined> {
  if (!CLOUD_DOC_TYPES.has(message.rawContentType)) return undefined
  const parsed = parseCloudDocContent(message)
  if (parsed === undefined) return undefined
  const { token, name } = parsed
  const kind = message.rawContentType
  const link = kind === 'docx' ? `https://feishu.cn/docx/${token}` : `https://feishu.cn/${kind}/${token}`
  if (kind === 'docx' && config.docxInbound && media?.readDocx !== undefined) {
    try {
      const content = await media.readDocx(token)
      const preview = [...content].slice(0, config.inboundTextPreviewChars).join('')
      const truncated = content.length > config.inboundTextPreviewChars ? '\n…[内容已截断]' : ''
      return `[Lark 云文档 (docx) received: ${name || token}. 链接：${link}\n内容：\n${preview}${truncated}]`
    } catch (error) {
      return `[Lark 云文档 (docx) received: ${name || token}. 链接：${link}。内容读取失败：${String(error)}]`
    }
  }
  return `[Lark 云文档 (${kind}) received: ${name || token}. 链接：${link}。此类型暂不支持自动读取内容。]`
}

/** Extract `{token, name}` from a cloud-doc share message's raw event. */
function parseCloudDocContent(
  message: NormalizedMessage,
): { token: string; name?: string } | undefined {
  const raw = message.raw as
    | { event?: { message?: { content?: string } }; message?: { content?: string } }
    | undefined
  const contentJson = raw?.event?.message?.content ?? raw?.message?.content
  if (typeof contentJson !== 'string' || contentJson === '') return undefined
  try {
    const parsed = JSON.parse(contentJson) as { token?: string; doc_name?: string; name?: string }
    const token = parsed.token
    if (typeof token !== 'string' || token === '') return undefined
    const name = typeof parsed.doc_name === 'string' ? parsed.doc_name
      : typeof parsed.name === 'string' ? parsed.name : undefined
    return name === undefined ? { token } : { token, name }
  } catch {
    return undefined
  }
}

function normalizedText(message: NormalizedMessage): string {
  let text = message.content.trim()
  for (const resource of message.resources) {
    text = text.split(resource.fileKey).join(resource.type === 'image' ? 'image' : resource.type)
  }
  return text
    .replace(/!\[([^\]]*)\]\(image\)/g, (_whole, alt: string) => `[${alt || 'image'}]`)
    .trim()
}

function shortId(value: string): string {
  return value.length <= 8 ? value : value.slice(0, 8)
}

function chatKeyFor(message: NormalizedMessage): string {
  return `${message.chatId}-${message.messageId}`
}

/** Detect image formats accepted by Harness attachments from magic bytes. */
export function detectImageMediaType(data: Uint8Array): ImageMediaType {
  if (startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (startsWith(data, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWith(data, [0x47, 0x49, 0x46, 0x38])) return 'image/gif'
  if (
    startsWith(data, [0x52, 0x49, 0x46, 0x46])
    && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50
  ) return 'image/webp'
  throw new Error('Lark image has an unsupported or unrecognized format')
}

function startsWith(data: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((byte, index) => data[index] === byte)
}
