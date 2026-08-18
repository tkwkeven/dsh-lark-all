/**
 * Feishu cloud document (docx) helpers: create a docx from markdown and
 * read a docx's markdown content. Both go through the SDK's docx client
 * (`docx.v1.document`) and need the app to have docx document permissions
 * on the Feishu open platform.
 */

import type { Client } from '@larksuiteoapi/node-sdk'

/** A docx created from markdown. */
export interface CreatedDocx {
  documentId: string
  /** Feishu shareable URL. */
  url: string
  title: string
}

/**
 * Create a docx titled `title` and fill it with `markdown` content.
 * Uses the documented flow: create the document, convert markdown to
 * blocks, then insert the blocks as descendants of the root block.
 */
export async function createDocxFromMarkdown(
  client: Client,
  title: string,
  markdown: string,
): Promise<CreatedDocx> {
  const created = await client.docx.document.create({ data: { title } })
  const document = created?.data?.document
  const documentId = document?.document_id
  if (documentId === undefined || documentId === '') {
    throw new Error('Feishu docx create returned no document_id')
  }
  const url = docxUrl(client, documentId)
  const content = markdown.trim()
  if (content !== '') {
    const converted = await client.docx.document.convert({
      data: { content_type: 'markdown', content },
    })
    const blocks = converted?.data?.blocks ?? []
    if (blocks.length > 0) {
      // Insert in batches of up to 1000 blocks (Feishu cap per request).
      for (let start = 0; start < blocks.length; start += 1000) {
        const batch = blocks.slice(start, start + 1000)
        await client.docx.documentBlockDescendant.create({
          path: { document_id: documentId, block_id: documentId },
          data: {
            children_id: batch.map(block => block.block_id ?? '').filter(id => id !== ''),
            index: -1,
            descendants: batch as never,
          },
        })
      }
    }
  }
  return { documentId, url, title }
}

/** Read a docx's markdown content via the docs content endpoint. */
export async function readDocxMarkdown(client: Client, documentId: string): Promise<string> {
  const result = await client.docs.v1.content.get({
    params: { doc_token: documentId, doc_type: 'docx', content_type: 'markdown' },
  })
  const content = result?.data?.content
  if (typeof content !== 'string' || content === '') {
    throw new Error('Feishu docx content is empty or unreadable')
  }
  return content
}

/** Fallback share URL for a document id when create() omitted `url`. */
function docxUrl(client: Client, documentId: string): string {
  const host = (client as unknown as { domain?: string }).domain
  const base = typeof host === 'string' && host.includes('larksuite') ? 'https://larksuite.com' : 'https://feishu.cn'
  return `${base}/docx/${documentId}`
}
