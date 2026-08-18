# dsh-lark-all — Feishu / Lark all-in-one plugin for DeepSeek Harness

A merged plugin for [DeepSeek Harness](https://github.com/deepseek-ai) built on the official `@larksuiteoapi/node-sdk`. It uses the official WebSocket long-connection transport, so **no public IP or callback server is required**, and supports both Feishu (China) and international Lark.

One package installs two plugin entries:

| Entry | Plugin ID | Purpose |
| --- | --- | --- |
| `dsh-lark-all` | `lark-channel` | Feishu/Lark channel bridge: messaging, parallel task sessions, streaming cards, media and cloud docs |
| `dsh-lark-all/ops` | `dsh-ops` | Restart recovery notification: after a process restart, notify the originating chat |

## Features

- Official WebSocket transport with automatic reconnection
- Direct-chat and group-chat access policies (`open` / `allowlist` / `disabled`); groups require `@bot` by default
- Text, rich-text and image input; model-aware multimodal input; oversized "original" images degrade to workspace files with the path reported to the model
- Inbound file / voice / video messages downloaded to `.lark-inbox/`; text-like files carry a content preview
- Inbound Feishu cloud documents (docx) are read and summarized for the model
- Model text replies and generated-image upload
- Outbound media: `/bot-send-file`, `/bot-send-image`, `/bot-send-voice`, `/bot-send-video`, `/bot-send-doc` commands, plus `[lark-file: path]` / `[lark-image: path]` / `[lark-voice: path]` / `[lark-video: path]` / `[lark-doc: path]` markers in model replies
- Large files over the IM cap (30MB): multipart upload to Drive and reply with a share link (`driveLargeFiles`)
- In-progress emoji reaction (`Typing` by default), cleared on completion; optional done emoji
- Persistent, isolated Harness sessions per chat; routing decisions logged to `<cwd>/.lark-routing.log`
- **Parallel task sessions**: messages starting with `任务：` (or `ptc任务：` / `标准任务：` / `极简任务：` / `创造任务：` for a specific agent preset) create an independent persistent session — the Feishu equivalent of a new Web conversation — each running in its own thread with a live streaming interactive card (`🧠 任务执行中` → `✅ 任务完成` / `⚠️ 任务失败`). Multiple tasks in one chat run in parallel.
- Long reports are paginated (3500 chars/page) and delivered as replies inside the task thread
- **Process restart via chat**: send the configured command (default `重启进程`) in the main chat; the process writes a restart marker, schedules a detached relaunch, and `dsh-ops` sends a recovery notice on the next boot
- App Secret resolved through the Harness credential service; never stored in plugin config

## Install

```sh
# From GitHub Releases (after publishing)
pnpm dsh plugin --profile web add https://github.com/tkwkeven/dsh-lark-all/releases/download/v1.0.0/dsh-lark-all-1.0.0.tgz

# From a local source checkout
pnpm dsh plugin --profile web add /absolute/path/to/dsh-lark-all
```

Build from source:

```sh
git clone https://github.com/tkwkeven/dsh-lark-all.git
cd dsh-lark-all
pnpm install
pnpm build
pnpm pack
```

## Feishu developer console setup

1. Create a custom app at <https://open.feishu.cn/app> and enable its bot capability.
2. Scopes: `im:message.p2p_msg:readonly`, `im:message.group_at_msg:readonly`, `im:message:send_as_bot`, `im:resource` (required); `im:message.reactions:write_only` (in-progress emoji); `docx:document` and `drive:drive` (optional).
3. Choose **long-connection event delivery** and subscribe to `im.message.receive_v1`.
4. Publish a version and add the bot to the chats.
5. Credentials (either):

```sh
export LARK_APP_ID='cli_your-app-id'
export LARK_APP_SECRET='your-app-secret'
pnpm dsh --profile web
```

For durable use, put the App ID in `~/.dsh/.env` and store the App Secret through the Harness credential settings surface (reference name `LARK_APP_SECRET`). Never commit credentials.

## Configuration

The bundle ships `cordis.patch.yml` which inserts both rows. Override in your profile's `cordis.patch.yml`:

```yaml
- id: lark-channel
  config:
    appId: cli_your-app-id
    singlePolicy: allowlist
    singleAllowFrom: [ou_xxx]
    groupPolicy: allowlist
    groupAllowChats: [oc_xxx]
    taskReasoningEffort: max
```

See [cordis.patch.example.yml](cordis.patch.example.yml) and the Chinese [README.md](README.md) for the full annotated configuration table.

## Usage

Slash commands: `/bot-ping`, `/bot-help`, `/bot-image-test`, `/bot-status`, `/bot-cancel`, `/bot-send-file <path|URL>`, `/bot-send-image`, `/bot-send-voice`, `/bot-send-video`, `/bot-send-doc <md path>`.

Task sessions: prefix a message with `任务：` (or a mode prefix) to start a parallel, per-thread task session with a streaming card; keep replying inside that thread to continue the session.

Restart: send `重启进程` in the main chat (configurable via `restartCommand`).

## Security

- Use allowlists in production and least-privilege Harness permissions for the agent.
- Store the App Secret only in the Harness credential service; keep the App ID in env.
- Narrow `outboundAllowedDirs` to the directories the bot may send from.

## Develop

```sh
pnpm install
pnpm check   # tsc --noEmit + esbuild bundle check
pnpm build   # dist/index.js (esbuild; @deepseek-ai/* stay external)
pnpm pack
```

Layout: `src/` — `index.ts` (entry), `bridge.ts` (channel & routing), `conversations.ts` (session & task management), `card.ts` (streaming card), `inbound.ts` (inbound content), `media.ts` (outbound media), `docx.ts` / `drive.ts` (cloud docs / Drive upload), `config.ts` (schema), `util.ts`; `ops.js` (restart recovery notification, plain JS entry).

## Credits & License

Protocol and configuration behavior were cross-checked against [larksuite/openclaw-lark](https://github.com/larksuite/openclaw-lark). The channel bridge core derives from [sliverp/DeepSeek-harness-lark](https://github.com/sliverp/DeepSeek-harness-lark) (MIT). This project merges and enhances both. MIT licensed — see [LICENSE](LICENSE); third-party components in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
