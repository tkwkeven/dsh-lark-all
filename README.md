# dsh-lark-all — DeepSeek Harness 飞书 / Lark 一体化插件

基于飞书官方 `@larksuiteoapi/node-sdk` 的 [DeepSeek Harness](https://github.com/deepseek-ai) 长连接通道 + 进程重启恢复通知合并插件。使用官方 WebSocket 长连接接收事件，**无需公网 IP、无需回调服务器**，同时支持飞书中国版与国际版 Lark。

一个包、一次安装，同时提供两个插件入口：

| 入口 | 插件 ID | 作用 |
| --- | --- | --- |
| `dsh-lark-all` | `lark-channel` | 飞书/Lark 消息通道桥：收发消息、并行任务会话、流式卡片、媒体与云文档 |
| `dsh-lark-all/ops` | `dsh-ops` | 重启恢复通知：进程重启完成后向发起重启的聊天发送恢复提示 |

---

## 功能特性

### 通道与消息

- 官方 WebSocket 长连接 + 自动重连，无公网服务器
- 单聊 / 群聊访问策略（`open` / `allowlist` / `disabled`），群聊默认要求 `@机器人`
- 文字、富文本、图片消息输入；图片按模型能力启用多模态输入，超大「原图」自动降级为工作区文件并告知模型路径
- 文件 / 语音 / 视频入站：自动下载到 `.lark-inbox/`，文本类文件附带内容预览，模型读路径即可处理
- 飞书云文档（docx）分享入站：自动读取正文内容供模型回答
- 模型文字回复、生成图片上传发送
- 收到消息立即添加「进行中」表情（默认 `Typing`），完成后移除，可选添加完成表情
- 每个聊天独立、可恢复的 Harness 会话；消息路由决策写入 `<cwd>/.lark-routing.log` 便于排查

### 并行任务会话（核心特性）

- 消息以 `任务：` 开头（或 `ptc任务：` / `标准任务：` / `极简任务：` / `创造任务：` 指定 agent preset）创建**独立、可持久化的 Harness 会话**——相当于 Web 端新建对话
- 每个任务在各自的话题中运行，带**实时流式交互卡片**：蓝色「🧠 任务执行中」→ 完成绿色「✅ 任务完成」/ 失败红色「⚠️ 任务失败」，正文展示任务标题、模式与会话、状态、耗时、轮次步骤、最近工具、思考摘要（240 字）与任务清单（最多 3 项）
- 卡片更新按 1200ms 最小间隔节流，终态立即推送并冻结；同一聊天内**多个任务并行执行**（`chatQueue: false` 默认）
- 话题内继续发消息即继续该任务会话（自动归属，无需依赖 `root_id`/`thread_id`）；每轮生成一张新的「第 N 轮」卡片
- 超长报告按每页 3500 字符分页，避开代码块、尽量在标题处断页，每页以回复形式投递到任务话题内
- 恢复旧的严格串行行为：设置 `chatQueue: true`

### 出站媒体

| 方式 | 说明 |
| --- | --- |
| 斜杠命令 | `/bot-send-file`（文件 ≤30MB）、`/bot-send-image`（原图 ≤10MB）、`/bot-send-voice`（opus 语音）、`/bot-send-video`（mp4 视频）、`/bot-send-doc`（markdown 生成飞书云文档） |
| 模型回复标记 | 模型在回复中单独一行输出 `[lark-file: 路径]`、`[lark-image: 路径]`、`[lark-voice: 路径]`、`[lark-video: 路径]`、`[lark-doc: 路径]` 即可附带媒体（标记行不显示在回复中） |
| 大文件 | 超过 IM 上限且开启 `driveLargeFiles` 时，自动分片上传云空间并回复分享链接（≤200MB） |
| 安全边界 | 本地文件必须位于 `outboundAllowedDirs`（默认 `cwd`）内，realpath 校验防路径穿越；URL 由 SDK 内置 SSRF 防护兜底 |

### 进程重启与恢复通知（ops）

- 在**主聊天**发送配置的重启命令（默认 `重启进程`）即可安全重启 DSH 进程：写入重启标记 → 调度 detached 重启（优先 `dsh-safe-restart.ps1` 安全重启脚本，失败自动回滚配置；否则使用内置 detached helper）→ 延迟退出
- 进程恢复后，`dsh-ops` 检测到重启标记，向发起重启的聊天发送 `✅ DSH 进程已恢复，重启完成` 通知并清除标记；通知失败保留标记下次重试

### 凭据安全

- App Secret 通过 Harness 凭据服务（`credentialRef`）解析，**不写入插件配置**；App ID 建议通过环境变量注入

---

## 安装

### 方式一：直接安装到 DSH profile

```sh
# 从 GitHub Releases 安装（发布后）
pnpm dsh plugin --profile web add https://github.com/tkwkeven/dsh-lark-all/releases/download/v1.0.0/dsh-lark-all-1.0.0.tgz

# 本地源码目录安装（开发）
pnpm dsh plugin --profile web add /absolute/path/to/dsh-lark-all
```

### 方式二：从源码构建安装

```sh
git clone https://github.com/tkwkeven/dsh-lark-all.git
cd dsh-lark-all
pnpm install
pnpm build        # 产出 dist/index.js（含 d.ts 与 source map）
pnpm pack         # 产出 dsh-lark-all-1.0.0.tgz
```

---

## 飞书开放平台配置

1. 在[飞书开放平台](https://open.feishu.cn/app)创建企业自建应用，启用「机器人」能力。
2. 添加权限：
   - 必选：`im:message.p2p_msg:readonly`、`im:message.group_at_msg:readonly`、`im:message:send_as_bot`、`im:resource`
   - 「进行中表情」：`im:message.reactions:write_only`
   - 可选：`docx:document`（云文档收发）、`drive:drive`（大文件上传云空间）
3. 在「事件与回调」选择**「使用长连接接收事件」**，订阅 `im.message.receive_v1`（接收消息）。
4. 创建并发布应用版本，把机器人加入需要使用的聊天。
5. 配置凭据（二选一）：

```sh
# 开发时环境变量注入
export LARK_APP_ID='cli_your-app-id'
export LARK_APP_SECRET='your-app-secret'
pnpm dsh --profile web

# 长期运行推荐：App ID 放 ~/.dsh/.env，App Secret 通过 Harness 凭据设置界面保存（引用名 LARK_APP_SECRET）
```

> ⚠️ 不要把真实凭据提交到 Git。

---

## DSH 配置

插件包自带 `cordis.patch.yml`，安装后自动插入两行：

```yaml
- insert:
    - id: lark-channel
      name: dsh-lark-all
      config:
        appId: !!js process.env.LARK_APP_ID
        appSecretRef: LARK_APP_SECRET
        cwd: !!js process.env.DSH_LARK_CWD ?? process.cwd()
        responseTimeoutMs: 21600000
    - id: dsh-ops
      name: dsh-lark-all/ops
      config:
        appId: !!js process.env.LARK_APP_ID
        appSecretRef: LARK_APP_SECRET
        cwd: !!js process.env.DSH_LARK_CWD ?? process.cwd()
```

在 profile 自己的 `cordis.patch.yml`（最后应用的一层）中覆盖配置：

```yaml
- id: lark-channel
  config:
    appId: cli_your-app-id        # 建议保留环境变量方式
    singlePolicy: allowlist
    singleAllowFrom: [ou_xxx]
    groupPolicy: allowlist
    groupAllowChats: [oc_xxx]
    taskReasoningEffort: max      # 任务会话固定的推理强度
    restartExitDelayMs: 2000      # 重启时退出延迟（配合 relaunch helper）
```

### 完整配置项

**访问策略与输入**

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `domain` | `feishu` | `feishu`（中国版）或 `lark`（国际版） |
| `singlePolicy` / `groupPolicy` | `open` | `open` / `allowlist` / `disabled` |
| `singleAllowFrom` / `groupAllowChats` | `[]` | 白名单（`ou_*` / `oc_*`） |
| `groupRequireMention` | `true` | 群聊要求 @机器人 |
| `respondToMentionAll` | `false` | 响应 @所有人 |
| `imageInputMode` | `auto` | `auto` / `always` / `never` |
| `replyInThread` | `false` | 回复是否进话题 |

**超时与回复**

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `responseTimeoutMs` | `300000` | 单轮回复上限（合并版默认 6 小时） |
| `mediaDownloadTimeoutMs` | `30000` | 媒体下载超时 |
| `sendTimeoutMs` | `30000` | 发送超时 |
| `sendRetries` | `2` | 发送重试次数 |
| `maxReplyChars` | `20000` | 单条回复上限 |
| `maxReplyImages` | `4` | 单条回复图片上限 |

**入站媒体**

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `inboundFiles` | `true` | 接收文件到 inbox |
| `inboundMedia` | `true` | 接收语音/视频到 inbox |
| `inboundDir` | `''` | 自定义 inbox 目录（空用 `<cwd>/.lark-inbox`） |
| `inboundResourceLimitBytes` | `104857600` | 入站资源上限（飞书 100MB） |
| `inboundTextPreviewChars` | `6000` | 文本类文件预览长度 |

**出站媒体**

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `outboundMedia` | `true` | 出站媒体总开关（命令 + 标记） |
| `outboundAllowedDirs` | `[]` | 允许的出站本地目录（空默认 `[cwd]`） |
| `maxOutboundFileBytes` | `31457280` | 文件上限（30MB） |
| `maxOutboundAudioBytes` | `31457280` | 语音上限 |
| `maxOutboundVideoBytes` | `31457280` | 视频上限 |
| `maxOutboundImageBytes` | `10485760` | 图片上限（10MB） |
| `driveLargeFiles` | `false` | 超限文件改传云空间并回复链接 |
| `maxDriveFileBytes` | `209715200` | 云空间上传上限（200MB） |
| `sendFileMarkers` | `true` | 解析模型回复 `[lark-*: 路径]` 标记 |
| `docxInbound` | `true` | 读取 docx 分享内容 |
| `docxOutbound` | `true` | 允许 `/bot-send-doc` 与 `[lark-doc:]` |

**任务会话**

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `taskSessions` | `true` | 任务会话总开关 |
| `taskPresets` | `{}` | 额外前缀 → agent preset 映射 |
| `taskDefaultPreset` | `code` | 裸 `任务：` 前缀使用的 preset |
| `taskReasoningEffort` | `max` | 新建任务会话固定的推理强度（模型不支持时会按路由自动收敛） |
| `reportIdentity` | `wdsh` | 任务报告前缀中的身份标识 |
| `taskCounterFile` | `''` | 每日任务计数器路径 |
| `chatQueue` | `false` | 关闭（默认）→ 任务并行；`true` → 同聊天严格串行 |

**重启**

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `restartCommand` | `重启进程` | 主聊天中触发的重启命令 |
| `restartMarkerFile` | `''` | 重启标记路径（ops 消费） |
| `restartLaunch` | `dsh web` | 重启后启动的命令行 |
| `restartLogFile` | `''` | 重启后进程日志 |
| `restartExitDelayMs` | `4000` | 调度重启后退出延迟 |

**其他**

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `progressReaction` | `true` | 收到消息先添加进行中表情 |
| `progressEmoji` | `Typing` | 进行中表情（`Typing`/`THUMBSUP`/`THINKING`/`GLANCE`/`Fire`…） |
| `doneEmoji` | `''` | 完成表情（如 `CheckMark`；空 = 关闭） |
| `maxInFlightMessages` | `8` | 并行处理上限 |
| `systemPrompt` | 内置 | 通道系统提示词覆盖 |

---

## 使用方法

### 1. 基础命令（发给机器人）

| 命令 | 说明 |
| --- | --- |
| `/bot-ping` | 连通性检查，返回 `pong` |
| `/bot-help` | 查看命令帮助 |
| `/bot-image-test` | 发送蓝色测试图片，检查图片链路 |
| `/bot-status` | 查看连接状态 |
| `/bot-cancel` | 取消当前生成 |

### 2. 普通聊天

直接发文字、图片、文件、语音、视频或云文档分享即可。普通消息进入该聊天的常驻 Harness 会话，与 Web 端同一套模型配置。

### 3. 并行任务会话

```text
任务：帮我调研一下开源社区的 Cordis 插件生态
ptc任务：写一个 PowerShell 脚本批量重命名文件
标准任务：总结这篇文档的要点
极简任务：翻译这段话
创造任务：设计一个产品原型方案
```

- 每条任务消息创建独立会话并在话题中运行，带实时流式卡片
- 任务还在运行时，继续发 `任务：…` 即可并行处理
- 在任务消息的话题（或回复任务消息的回复链）里继续发消息 = 继续该任务会话，每轮一张新的「第 N 轮」卡片
- 任务完成后，报告以回复形式投递到话题内；超长报告自动分页

### 4. 发送媒体

```text
/bot-send-file C:\path\to\demo.txt
/bot-send-image C:\path\to\photo.png
/bot-send-voice C:\path\to\audio.opus
/bot-send-video C:\path\to\clip.mp4
/bot-send-doc C:\path\to\report.md
```

也可以让模型在回复中直接输出标记（独立一行）：

```text
[lark-file: C:\path\to\demo.txt]
[lark-image: C:\path\to\photo.png]
[lark-doc: C:\path\to\report.md]
```

超过 IM 上限的文件在开启 `driveLargeFiles` 后自动上传云空间并回复分享链接。

### 5. 接收媒体

- **文件**：下载到 `<cwd>/.lark-inbox/<chatId>-<messageId>/`，文本类文件附带内容预览，可直接问文件内容相关问题
- **语音/视频**：下载到 inbox 并告知时长与路径
- **原图**：超过附件限制的图片自动降级为 inbox 文件并告知路径
- **云文档**：docx 分享自动读取正文；sheet/bitable 识别名称与链接

### 6. 重启进程

在主聊天发送 `重启进程`（可配置 `restartCommand`）。机器人回复确认后调度安全重启，约 10~60 秒后恢复；`dsh-ops` 会向该聊天发送恢复通知。

### 7. 验证链路

```text
/bot-ping        → pong
/bot-image-test  → 文字 + 蓝色图片
```

再发普通文字和一张图片验证模型与入站附件链路；发 `demo.txt` 后 `/bot-send-file C:\绝对\路径\demo.txt` 验证文件出站；向机器人发送一个文件或语音验证入站下载。

---

## 安全建议

- 生产环境使用白名单策略（`singlePolicy` / `groupPolicy: allowlist`），并为 agent 配置最小文件和工具权限
- App Secret 只存 Harness 凭据服务，App ID 走环境变量，**绝不写进配置或提交 Git**
- 出站媒体目录用 `outboundAllowedDirs` 收窄；不要在允许目录里放敏感文件
- 群聊保持 `groupRequireMention: true` 防止误触发

---

## 开发

```sh
pnpm install
pnpm check      # tsc --noEmit + esbuild 打包校验
pnpm build      # 产出 dist/index.js（esbuild 打包，@deepseek-ai/* 保持 external）
pnpm pack       # 产出 .tgz
```

源码结构：

```
src/
├── index.ts          # 插件入口（name/inject/Config/apply）
├── bridge.ts         # 通道桥：连接、消息路由、命令、重启调度
├── conversations.ts  # 会话管理：普通会话 + 并行任务会话 + 卡片流
├── card.ts           # 流式交互卡片状态机与渲染
├── inbound.ts        # 入站内容解析（文本/图片/文件/语音/视频）
├── media.ts          # 出站媒体构造与发送
├── docx.ts           # 飞书云文档读写
├── drive.ts          # 云空间大文件分片上传
├── config.ts         # 配置 schema（schemastery）
└── util.ts           # 工具函数
ops.js                # 重启恢复通知（直接执行的纯 JS 入口）
```

## 致谢与许可

协议与配置行为参考 [larksuite/openclaw-lark](https://github.com/larksuite/openclaw-lark)；通道桥核心源自 [sliverp/DeepSeek-harness-lark](https://github.com/sliverp/DeepSeek-harness-lark)（MIT）。本项目在二者基础上合并增强，使用 [MIT](LICENSE) 许可证；打包产物中的第三方软件见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
