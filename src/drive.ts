/**
 * Feishu Drive large-file upload. IM messages cap file uploads at 20MB, so
 * oversized outbound files are uploaded to Drive with the multipart flow
 * (upload_prepare → upload_part × N → upload_finish) and the resulting
 * share URL is sent instead. Requires drive permissions on the app.
 */

import type { Client } from '@larksuiteoapi/node-sdk'

/** A file uploaded to Drive with its share link. */
export interface DriveUpload {
  fileToken: string
  url: string
  fileName: string
}

/**
 * Upload `data` to the app's Drive root via multipart upload and return
 * the file token plus share URL. Chunk size is fixed by Feishu (4MB);
 * the number of blocks comes from the prepare response.
 */
export async function uploadFileToDrive(
  client: Client,
  fileName: string,
  data: Buffer,
): Promise<DriveUpload> {
  const prepared = await client.drive.v1.file.uploadPrepare({
    data: {
      file_name: fileName,
      parent_type: 'explorer',
      parent_node: '',
      size: data.byteLength,
    },
  })
  const uploadId = prepared?.data?.upload_id
  const blockSize = prepared?.data?.block_size ?? 4 * 1024 * 1024
  const blockNum = prepared?.data?.block_num
  if (uploadId === undefined || uploadId === '' || blockNum === undefined || blockNum <= 0) {
    throw new Error('Feishu Drive upload prepare returned no upload id')
  }
  for (let seq = 0; seq < blockNum; seq += 1) {
    const start = seq * blockSize
    const part = data.subarray(start, Math.min(start + blockSize, data.byteLength))
    await client.drive.v1.file.uploadPart({
      data: {
        upload_id: uploadId,
        seq,
        size: part.byteLength,
        file: Buffer.from(part),
      },
    })
  }
  const finished = await client.drive.v1.file.uploadFinish({
    data: { upload_id: uploadId, block_num: blockNum },
  })
  const fileToken = finished?.data?.file_token
  if (fileToken === undefined || fileToken === '') {
    throw new Error('Feishu Drive upload finish returned no file token')
  }
  const url = finished?.data?.url ?? driveFileUrl(client, fileToken)
  return { fileToken, url, fileName }
}

/** Fallback Drive file URL when finish() omitted `url`. */
function driveFileUrl(client: Client, fileToken: string): string {
  const host = (client as unknown as { domain?: string }).domain
  const base = typeof host === 'string' && host.includes('larksuite') ? 'https://larksuite.com' : 'https://feishu.cn'
  return `${base}/file/${fileToken}`
}
