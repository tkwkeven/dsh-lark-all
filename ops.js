// dsh-lark-all/ops — restart recovery notification (merged from
// dsh-harness-ops into the dsh-lark-all bundle). On boot, if a restart
// marker exists (written by the lark channel before it restarts the
// process), send a recovery notice to the originating Feishu chat via the
// direct REST API and remove the marker.
//
// Plain JavaScript, no bundling: the loader executes this file directly.

import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'

export const name = 'dsh-harness-ops'
export const inject = ['credentials']

export const Config = z.object({
  appId: z.string().required(),
  appSecretRef: z.string().default('LARK_APP_SECRET'),
  cwd: z.string().required(),
  markerFile: z.string().default(''),
})

async function resolveSecret(ctx, ref) {
  const resolved = await ctx.credentials.resolve(credentialRef(ref))
  return resolved?.value?.trim()
}

/** Send a plain text message to one chat through the direct REST API. */
async function sendFeishuText(appId, appSecret, chatId, text) {
  const tokenRes = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  })
  const tokenJson = await tokenRes.json()
  if (tokenJson.code !== 0) throw new Error(`token: ${tokenJson.msg}`)
  const msgRes = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${tokenJson.tenant_access_token}`,
    },
    body: JSON.stringify({
      receive_id: chatId,
      msg_type: 'text',
      content: JSON.stringify({ text }),
    }),
  })
  const msgJson = await msgRes.json()
  if (msgJson.code !== 0) throw new Error(`message: ${JSON.stringify(msgJson)}`)
  return msgJson.data?.message_id
}

export async function apply(ctx, config) {
  const markerFile = config.markerFile || join(config.cwd, '.dsh-ops-restart-marker.json')
  const log = ctx.logger('dsh-harness-ops')

  let marker
  try {
    marker = JSON.parse(await readFile(markerFile, 'utf8'))
  } catch {
    // No marker: a normal boot, nothing to report.
    return
  }

  try {
    const secret = await resolveSecret(ctx, config.appSecretRef)
    if (!secret) throw new Error(`credential ${config.appSecretRef} not configured`)
    if (marker.chatId) {
      const reason = marker.reason ? `（原因：${marker.reason}）` : ''
      await sendFeishuText(
        config.appId,
        secret,
        marker.chatId,
        `✅ DSH 进程已恢复，重启完成${reason}。`,
      )
      log.info('recovery notice sent to chat %s', marker.chatId)
    }
    await rm(markerFile, { force: true })
  } catch (error) {
    // Keep the marker so the next boot retries the notification.
    log.error('restart recovery notify failed: %s', String(error))
  }
}

export default { name, inject, Config, apply }
