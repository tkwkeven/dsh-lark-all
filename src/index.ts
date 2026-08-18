/** Official Feishu/Lark WebSocket channel bundle for DeepSeek Harness. */

import type { Context } from '@deepseek-ai/cordis'
import { LarkHarnessBridge } from './bridge.js'
import { Config, type Config as LarkConfig } from './config.js'

export const name = 'deepseek-harness-lark'
export const inject = ['agentDefaultModel', 'agents', 'attachments', 'credentials', 'llm', 'sessionPersistence']
export { Config }
export type { LarkConfig as ConfigType }
export { LarkHarnessBridge }
export { detectImageMediaType, inboundContent } from './inbound.js'
export { sessionIdFor, truncateText, withTimeout } from './util.js'

/** Mount the Feishu/Lark WebSocket channel and tie teardown to Cordis. */
export async function apply(ctx: Context, config: LarkConfig): Promise<void> {
  const bridge = new LarkHarnessBridge(ctx, config)
  await ctx.effect(async function* () {
    yield async () => bridge.stop()
    await bridge.start()
  }, 'deepseek-harness-lark.websocket')
}

export default { name, inject, Config, apply }
