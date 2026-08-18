// Bundle src/index.ts into a single ESM file with esbuild.
// - @deepseek-ai/* stay external (peer dependencies provided by the host).
// - The Lark Node SDK and its transitive deps (protobufjs, long, ...) are
//   bundled in, matching the published distribution.
import { build } from 'esbuild'
import { rmSync } from 'node:fs'

rmSync('dist', { recursive: true, force: true })

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: 'dist/index.js',
  sourcemap: true,
  legalComments: 'none',
  // CJS dependencies (node-sdk, axios, ...) call require() at runtime; in
  // ESM output the generated __require shim forwards to the global `require`
  // when one exists. Define it via createRequire so the bundle works as a
  // plain ESM file, plus __filename/__dirname for any CJS code that uses them.
  banner: {
    js: [
      `import { createRequire as __createRequire } from 'node:module'`,
      `import { fileURLToPath as __fileURLToPath } from 'node:url'`,
      `import { dirname as __pathDirname } from 'node:path'`,
      `const require = __createRequire(import.meta.url)`,
      `const __filename = __fileURLToPath(import.meta.url)`,
      `const __dirname = __pathDirname(__filename)`,
    ].join('; '),
  },
  external: [
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-agent',
    '@deepseek-ai/dsh-agent-default-model',
    '@deepseek-ai/dsh-attachment',
    '@deepseek-ai/dsh-credentials',
    '@deepseek-ai/dsh-llm',
    '@deepseek-ai/dsh-session',
    '@deepseek-ai/dsh-session-persistence',
  ],
  logLevel: 'info',
})
