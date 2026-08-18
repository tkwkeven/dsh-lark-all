/**
 * Inbound resource download/storage and outbound media handling for the
 * Feishu/Lark channel. Everything here is transport-agnostic: downloads go
 * through the channel port (which owns the SDK client), storage goes to the
 * configured inbox directory, and outbound sources are validated before the
 * SDK's own uploader reads them (the SDK additionally enforces its built-in
 * SSRF guard and POSIX blocklist on URL / path sources).
 */

import { realpathSync } from 'node:fs'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, resolve, sep } from 'node:path'
import type { Config } from './config.js'
import { withTimeout } from './util.js'

/** Resource types a Feishu message can carry (as normalized by the SDK). */
export type InboundResourceType = 'file' | 'audio' | 'video' | 'sticker'

/** One downloaded inbound resource, ready to describe to the model. */
export interface StoredInboundResource {
  type: InboundResourceType
  /** Original file name when Feishu provided one. */
  fileName: string
  /** Absolute path of the stored file under the inbox directory. */
  path: string
  /** Stored byte length. */
  bytes: number
  /** Optional audio/video duration in milliseconds. */
  durationMs?: number
  /** Text preview (text-like files only, truncated to the configured limit). */
  preview?: string
}

/** Outbound media attached to a model reply or a `/bot-send-*` command. */
export type OutboundMediaKind = 'file' | 'image' | 'audio' | 'video'

/** A validated outbound media item ready for `channel.send`. */
export interface OutboundMedia {
  kind: OutboundMediaKind
  /** Buffer or local path / http(s) URL understood by the SDK uploader. */
  source: string | Buffer
  fileName: string
}

/** Markers the model can emit to attach media to a reply. */
export type OutboundMarkerKind = OutboundMediaKind | 'doc'

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonl', '.csv', '.tsv', '.log', '.yml', '.yaml', '.xml',
  '.html', '.htm', '.css', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.java', '.c',
  '.h', '.cpp', '.hpp', '.cs', '.go', '.rs', '.rb', '.php', '.sh', '.bat', '.cmd', '.ps1',
  '.sql', '.ini', '.cfg', '.conf', '.env', '.toml', '.properties', '.srt', '.vtt', '.gitignore',
  '.diff', '.patch', '.lrc',
])

const MEDIA_MARKER = /^\s*\[lark-(file|image|voice|video|doc):\s*([^\]]+?)\s*\]\s*$/

/**
 * Download one inbound resource and store it under the inbox directory.
 * `downloader` resolves a file key to bytes (the message-resource endpoint
 * for audio/video, the plain file endpoint for files). Audio/video first try
 * the generic 'file' type — which works for most deployments, mirroring the
 * larksuite/openclaw-lark implementation — and fall back to the concrete
 * type on failure.
 */
export async function storeInboundResource(
  downloader: (fileKey: string, type: 'file' | 'audio' | 'video') => Promise<Buffer>,
  config: Config,
  resource: { type: InboundResourceType; fileKey: string; fileName?: string; durationMs?: number },
  chatKey: string,
  log: { warn(message: string, ...args: unknown[]): void },
): Promise<StoredInboundResource | undefined> {
  const label = resource.fileName ?? resource.type
  try {
    const types = resource.type === 'file' ? ['file'] : ['file', resource.type]
    let data: Buffer | undefined
    let lastError: unknown
    for (const type of types) {
      try {
        data = await withTimeout(
          downloader(resource.fileKey, type as 'file' | 'audio' | 'video'),
          config.mediaDownloadTimeoutMs,
          `Lark ${resource.type} download`,
        )
        break
      } catch (error) {
        lastError = error
      }
    }
    if (data === undefined) throw lastError ?? new Error('download failed')
    if (data.byteLength > config.inboundResourceLimitBytes) {
      log.warn('Lark %s resource exceeds the %d-byte inbound limit; skipped', resource.type, config.inboundResourceLimitBytes)
      return undefined
    }
    const fileName = sanitizeFileName(resource.fileName ?? fallbackName(resource.type, data))
    const dir = resolveInboxDir(config, chatKey)
    await mkdir(dir, { recursive: true })
    const path = join(dir, fileName)
    // Overwrite the previous copy of the same message resource — file keys
    // are unique per upload, so a collision means a redelivery of the same
    // message, not a different file.
    await writeFile(path, data)
    const stored: StoredInboundResource = {
      type: resource.type,
      fileName,
      path,
      bytes: data.byteLength,
      ...(resource.durationMs === undefined ? {} : { durationMs: resource.durationMs }),
    }
    const preview = textPreview(data, fileName, config.inboundTextPreviewChars)
    if (preview !== undefined) stored.preview = preview
    return stored
  } catch (error) {
    log.warn('Lark %s resource download failed (%s): %s', resource.type, label, String(error))
    return undefined
  }
}

/**
 * Extract `[lark-file: ...]`-style markers from a model reply. Returns the
 * cleaned text and the parsed markers (deduplicated, in order). Markers are
 * removed from the text so the visible reply stays clean; the caller sends
 * each media item after the text pages.
 */
export function extractMediaMarkers(
  text: string,
  config: Config,
  log: { warn(message: string, ...args: unknown[]): void },
): { text: string; markers: Array<{ kind: OutboundMediaKind | 'doc'; source: string }> } {
  const lines = text.split('\n')
  const kept: string[] = []
  const markers: Array<{ kind: OutboundMediaKind | 'doc'; source: string }> = []
  const seen = new Set<string>()
  for (const line of lines) {
    const match = MEDIA_MARKER.exec(line)
    if (match === null) {
      kept.push(line)
      continue
    }
    if (!config.sendFileMarkers) {
      kept.push(line)
      continue
    }
    const rawKind = match[1] ?? 'file'
    const kind = rawKind === 'voice' ? 'audio' : (rawKind as OutboundMediaKind | 'doc')
    const source = (match[2] ?? '').trim()
    if (source === '') {
      kept.push(line)
      continue
    }
    const key = `${kind}\0${source}`
    if (seen.has(key)) continue
    seen.add(key)
    markers.push({ kind, source })
  }
  return { text: kept.join('\n').trim(), markers }
}

/**
 * Build the list of outbound media for one reply: model markers first, then
 * image blocks (kept for backward compatibility). `resolveSource` turns each
 * marker into validated media; failures are logged and skipped so one bad
 * attachment never blocks the whole reply.
 */
export async function buildOutboundMedia(
  markers: Array<{ kind: OutboundMediaKind | 'doc'; source: string }>,
  config: Config,
  log: { warn(message: string, ...args: unknown[]): void },
): Promise<{ media: OutboundMedia[]; failures: string[] }> {
  const media: OutboundMedia[] = []
  const failures: string[] = []
  for (const marker of markers) {
    if (marker.kind === 'doc') {
      // Docx creation happens in the bridge (it needs the API client).
      continue
    }
    try {
      const item = await resolveOutboundMedia(marker.kind, marker.source, config)
      media.push(item)
    } catch (error) {
      log.warn('Lark outbound %s skipped (%s): %s', marker.kind, marker.source, String(error))
      failures.push(`[${marker.kind}: ${marker.source}] ${String(error)}`)
    }
  }
  return { media, failures }
}

/**
 * Validate one outbound media source: resolve local paths against the
 * configured allowlist (realpath-checked, so symlinks cannot escape) and
 * enforce the per-kind size cap. Buffers are size-checked directly; URLs
 * cannot be pre-flighted and are capped by the SDK's own 50MB URL fetch.
 */
export async function resolveOutboundMedia(
  kind: OutboundMediaKind,
  source: string | Buffer,
  config: Config,
): Promise<OutboundMedia> {
  const cap = kind === 'image' ? config.maxOutboundImageBytes
    : kind === 'audio' ? config.maxOutboundAudioBytes
      : kind === 'video' ? config.maxOutboundVideoBytes
        : config.maxOutboundFileBytes
  let fileName: string | undefined
  if (typeof source === 'string') {
    const cleaned = cleanSource(source)
    if (cleaned === '') throw new Error('empty media source')
    if (!/^https?:\/\//i.test(cleaned)) {
      const resolved = resolve(cleaned)
      assertInsideAllowedDirs(resolved, config.outboundAllowedDirs.length > 0
        ? config.outboundAllowedDirs
        : [config.cwd])
      const info = await stat(resolved)
      if (info.size > cap) {
        throw new Error(`file is ${info.size} bytes, over the ${kind} limit of ${cap} bytes`)
      }
      fileName = basename(resolved)
      source = resolved
    } else {
      fileName = urlFileName(cleaned)
    }
  } else if (source.byteLength > cap) {
    throw new Error(`media is ${source.byteLength} bytes, over the ${kind} limit of ${cap} bytes`)
  }
  return { kind, source, fileName: fileName ?? fallbackName(kind, undefined) }
}

/** True when a file name extension looks like a text file worth previewing. */
export function isTextLike(fileName: string, data: Uint8Array): boolean {
  const ext = extname(fileName).toLowerCase()
  if (TEXT_EXTENSIONS.has(ext)) return true
  // Unknown extension: only treat small, mostly-printable payloads as text.
  if (data.byteLength > 64 * 1024) return false
  let printable = 0
  for (let i = 0; i < data.byteLength; i += 1) {
    const byte = data[i] ?? 0
    if (byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte < 127) || byte >= 0x80) printable += 1
  }
  return data.byteLength > 0 && printable / data.byteLength > 0.95
}

/** Decode a text preview capped at `limit` chars; undefined for binary files. */
export function textPreview(data: Uint8Array, fileName: string, limit: number): string | undefined {
  if (limit <= 0) return undefined
  if (!isTextLike(fileName, data)) return undefined
  const sample = data.subarray(0, Math.min(data.byteLength, limit * 4))
  const text = Buffer.from(sample).toString('utf8')
  const points = [...text]
  if (points.length <= limit) return text
  return `${points.slice(0, limit).join('')}\n…[预览已截断，完整内容在消息附带的文件中]`
}

/** Strip markdown/code wrappers and surrounding quotes from a media source. */
export function cleanSource(value: string): string {
  let raw = value.trim()
  if (raw.startsWith('<') && raw.endsWith('>') && raw.length >= 2) raw = raw.slice(1, -1).trim()
  const first = raw[0]
  const last = raw[raw.length - 1]
  if (raw.length >= 2 && ((first === '"' && last === '"') || (first === "'" && last === "'") || (first === '`' && last === '`'))) {
    raw = raw.slice(1, -1).trim()
  }
  return raw
}

/** Reject a local path outside the allowed directories (realpath-aware). */
export function assertInsideAllowedDirs(filePath: string, allowedDirs: readonly string[]): void {
  if (allowedDirs.length === 0) throw new Error('no outbound media directories are configured')
  const resolved = resolve(filePath)
  const real = realPathOrResolve(resolved)
  for (const dir of allowedDirs) {
    const root = realPathOrResolve(dir)
    if (real === root || real.startsWith(root + sep)) {
      return
    }
  }
  throw new Error(`path is not inside any allowed outbound media directory (${allowedDirs.join(', ')})`)
}

function realPathOrResolve(value: string): string {
  try {
    return realpathSync(value)
  } catch {
    return value
  }
}

function urlFileName(url: string): string {
  try {
    const parsed = new URL(url)
    const name = basename(parsed.pathname)
    if (name !== '' && name !== '/') return decodeURIComponent(name)
  } catch {
    // fall through
  }
  return 'download'
}

/** A filesystem-safe display name (no separators, no traversal). */
export function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[/\\:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim()
  const limited = [...cleaned].slice(0, 160).join('')
  return limited === '' ? 'unnamed' : limited
}

function fallbackName(kind: string, data: Uint8Array | undefined): string {
  switch (kind) {
    case 'file': return 'file.bin'
    case 'image': return 'image.png'
    case 'audio': return 'voice.opus'
    case 'video': return 'video.mp4'
    case 'sticker': return 'sticker'
    default: {
      const bytes = data?.byteLength ?? 0
      return `${kind}-${bytes}.bin`
    }
  }
}

function resolveInboxDir(config: Config, chatKey: string): string {
  const root = config.inboundDir.trim() === '' ? join(config.cwd, '.lark-inbox') : config.inboundDir
  return join(root, sanitizeFileName(chatKey))
}

export function isAbsoluteOrUrl(value: string): boolean {
  return /^https?:\/\//i.test(value) || isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)
}
