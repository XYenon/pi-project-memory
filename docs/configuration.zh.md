# 配置参考与存储结构

本文档详细说明 Pi Project Memory 的用户级配置文件结构、字段校验与回退规则、角色运行参数，以及本地磁盘上的完整存储路径结构与文件生命周期。

## 配置文件位置与加载规则

### 1. 配置文件路径与 `PI_CODING_AGENT_DIR`

扩展通过 `@earendil-works/pi-coding-agent` 导出的 `getAgentDir()` 解析 Pi 用户目录，配置文件路径固定为：

```text
<agentDir>/project-memory/config.json
```

在默认环境中，`<agentDir>` 为 `~/.pi/agent`，因此默认配置文件路径为：

```text
~/.pi/agent/project-memory/config.json
```

如果设置了环境变量 `PI_CODING_AGENT_DIR`，`getAgentDir()` 会返回该自定义目录。注意：Pi 1.1.0+ 的扩展上下文不会公开 SDK 嵌入调用传入的 `agentDir`，因此通过 SDK 嵌入 Pi 并使用自定义 agent 目录时，必须同时设置环境变量 `PI_CODING_AGENT_DIR`，否则 `getAgentDir()` 仍会返回默认的 `~/.pi/agent`，扩展也会读写 `~/.pi/agent/project-memory/`。

### 2. 配置来源与逐字段回退规则

- **仅读取用户级配置文件**：扩展只从 `<agentDir>/project-memory/config.json` 读取配置，不存在项目仓库内配置文件（如 `.pi/` 下的项目配置）、CLI 参数或独立环境变量覆盖配置字段的机制。这一设计确保未受信任或外部克隆的仓库无法篡改记忆目录或后台模型配置。
- **文件不存在时的默认行为**：当 `config.json` 不存在（`ENOENT`）时，扩展直接使用内置的 `DEFAULT_CONFIG`。仓库根目录下的 `config.example.json` 解析后的配置值与 `DEFAULT_CONFIG` 保持一致。
- **JSON 语法错误或读取失败**：当 `config.json` 存在但无法读取，或者文件内容不是合法的 JSON 语法时，`loadConfig()` 会直接抛出错误：
  - 在会话启动（`session_start`）时，会导致扩展初始化报错。
  - 在运行 `/memory reload-config` 时，会弹出 error 通知提示失败原因，并保留重新加载前的有效配置继续运行。
- **非对象顶层值与逐字段独立回退**：当 JSON 解析成功时，`parseConfig()` 会进行无异常的逐字段校验：
  - 如果 JSON 顶层不是普通对象（例如为 `null`、数组或原始值），整份配置回退为 `DEFAULT_CONFIG`。
  - 如果 `models`、`extraction`、`dream` 或某个角色配置对象不是普通对象，对应子块回退为该子块的默认值。
  - 每个具体字段独立校验：只有当该字段缺失、类型不匹配、格式不合法或超出允许的整数范围时，**该字段自身**才会回退到内置默认值，同一对象内其他合法的兄弟字段不受影响。未知的多余字段会被忽略。

### 3. 配置重载（`/memory reload-config`）的生效边界

运行 `/memory reload-config` 时：

- `enabled`、`models.*`、`extraction.*` 和 `dream.*` 的修改会**立即生效**。
- 如果重开或维持了 `enabled: true`，扩展会立即中止当前正在运行的后台提取或整理子任务（通过递增 `generation` 并触发 `AbortController`），并取消正在等待的预取和空闲计时器。
- 如果将 `enabled` 从 `true` 改为 `false`，扩展会中止后台任务、清空内存中的路径引用与待发送更新；如果将 `enabled` 从 `false` 改为 `true`，则会按当前会话固定的目录配置初始化记忆目录。
- `autoMemoryDirectory` 在每次会话启动（`session_start`）时会被固定到 `sessionMemoryDirectory`。在会话运行期间修改 `autoMemoryDirectory` 并执行 `/memory reload-config` **不会**切换当前会话的记忆目录，也不会迁移已有文件；命令会提示该改动将在下次会话启动后生效。

## 配置字段总表

下表列出 `config.json` 支持的全部字段、类型、默认值、允许取值范围与单位：

| 字段路径                           | 类型                  | 默认值      | 允许取值与约束                                                                                | 单位                    | 简要作用                                                        |
| ---------------------------------- | --------------------- | ----------- | --------------------------------------------------------------------------------------------- | ----------------------- | --------------------------------------------------------------- |
| `enabled`                          | `boolean`             | `true`      | `true` 或 `false`（非布尔值回退为 `true`）                                                    | 无                      | 扩展全局总开关；关闭时不解析或创建目录，不运行任何自动任务。    |
| `autoMemoryDirectory`              | `string \| null`      | `null`      | `null`，或合法的绝对路径 / `~/` 开头路径（空白字符串或非法路径回退默认）                      | 无                      | 覆盖项目默认的 `memory/` 存储目录（仅下次会话启动生效）。       |
| `models.selector.model`            | `string`              | `"inherit"` | `"inherit"`，或以第一个 `/` 分隔 `provider` 与非空 `model-id` 的字符串（`model-id` 可含 `/`） | 无                      | Selector（相关记忆挑选）使用的模型。                            |
| `models.selector.thinkingLevel`    | `string`              | `"off"`     | `"off"` \| `"minimal"` \| `"low"` \| `"medium"` \| `"high"` \| `"xhigh"` \| `"max"`           | 无                      | Selector 的思考预算档位（会自动夹紧到模型支持的最接近档位）。   |
| `models.selector.maxTokens`        | `"inherit" \| number` | `512`       | `"inherit"` 或 `64` 到 `65536` 的安全整数                                                     | 输出 token              | Selector 单次调用的最大输出 token 数。                          |
| `models.selector.structuredOutput` | `boolean`             | `true`      | `true` 或 `false`                                                                             | 无                      | 是否对支持的协议优先使用原生 JSON Schema 输出格式。             |
| `models.extractor.model`           | `string`              | `"inherit"` | `"inherit"`，或以第一个 `/` 分隔 `provider` 与非空 `model-id` 的字符串（`model-id` 可含 `/`） | 无                      | Extractor（回合后提取）使用的模型。                             |
| `models.extractor.thinkingLevel`   | `string`              | `"low"`     | `"off"` \| `"minimal"` \| `"low"` \| `"medium"` \| `"high"` \| `"xhigh"` \| `"max"`           | 无                      | Extractor 的思考预算档位。                                      |
| `models.extractor.maxTokens`       | `"inherit" \| number` | `"inherit"` | `"inherit"` 或 `64` 到 `65536` 的安全整数                                                     | 输出 token              | Extractor 单次模型请求的最大输出 token 数。                     |
| `models.dream.model`               | `string`              | `"inherit"` | `"inherit"`，或以第一个 `/` 分隔 `provider` 与非空 `model-id` 的字符串（`model-id` 可含 `/`） | 无                      | Dream（定期整理）使用的模型。                                   |
| `models.dream.thinkingLevel`       | `string`              | `"medium"`  | `"off"` \| `"minimal"` \| `"low"` \| `"medium"` \| `"high"` \| `"xhigh"` \| `"max"`           | 无                      | Dream 的思考预算档位。                                          |
| `models.dream.maxTokens`           | `"inherit" \| number` | `"inherit"` | `"inherit"` 或 `64` 到 `65536` 的安全整数                                                     | 输出 token              | Dream 单次模型请求的最大输出 token 数。                         |
| `extraction.enabled`               | `boolean`             | `true`      | `true` 或 `false`                                                                             | 无                      | 是否开启自动提取（关闭后仍可手动运行 `/memory extract`）。      |
| `extraction.everyNTurns`           | `number`              | `1`         | `1` 到 `100` 的安全整数                                                                       | 正常结束的对话轮次      | 每累积多少个已结束轮次（settled turns）运行一次自动提取。       |
| `extraction.idleFlushSeconds`      | `number`              | `120`       | `0` 到 `86400` 的安全整数（`0` 表示禁用空闲提取）                                             | 秒                      | 轮次未达到 `everyNTurns` 时，空闲多久后自动提取未处理消息。     |
| `extraction.maxTurns`              | `number`              | `5`         | `1` 到 `8` 的安全整数                                                                         | 子 Agent 工具轮次       | Extractor 单次任务允许的最大模型请求与工具调用循环次数。        |
| `extraction.recentMessages`        | `"inherit" \| number` | `"inherit"` | `"inherit"` 或 `3` 到 `1000` 的安全整数                                                       | `user`/`assistant` 条数 | 每次提供给 extractor 的最近对话消息上限。                       |
| `dream.enabled`                    | `boolean`             | `true`      | `true` 或 `false`                                                                             | 无                      | Dream 总开关（关闭后自动整理与手动 `/memory dream` 均不可用）。 |
| `dream.minimumHours`               | `number`              | `24`        | `1` 到 `8760` 的安全整数                                                                      | 小时                    | 两次自动整理尝试之间的最短间隔时间。                            |
| `dream.minimumOtherSessions`       | `number`              | `5`         | `1` 到 `1000` 的安全整数                                                                      | 会话数（不含当前会话）  | 上次整理尝试后，至少需要有多少个其他项目会话更新过才触发整理。  |
| `dream.scanThrottleSeconds`        | `number`              | `600`       | `0` 到 `86400` 的安全整数（`0` 表示不节流）                                                   | 秒                      | 同一进程内满足 `minimumHours` 后扫描会话目录的最短间隔时间。    |
| `dream.maxTurns`                   | `number`              | `50`        | `1` 到 `50` 的安全整数                                                                        | 子 Agent 工具轮次       | Dream 单次任务允许的最大模型请求与工具调用循环次数。            |

## 各字段详细说明与相互关系

### 1. 全局配置项

#### `enabled`

- **类型**：`boolean`，默认 `true`。
- **作用与相互影响**：控制整个扩展的最高优先级开关。当 `enabled` 为 `false` 时：
  - 扩展在 `session_start` 时**不会**调用 `resolveProjectPaths()` 或 `initializeProjectPaths()`，不会在磁盘上创建任何项目目录、状态文件或锁目录。
  - 即使 `extraction.enabled` 或 `dream.enabled` 为 `true`，自动取回、自动提取、手动 `/memory extract`、自动整理、手动 `/memory dream` 以及 `/memory list` 都会被禁用。
  - 只有 `/memory status`（显示 `Auto-memory: disabled` 与 `Memory directory: not initialized`）和 `/memory reload-config` 可用。

#### `autoMemoryDirectory`

- **类型**：`string | null`，默认 `null`。
- **作用**：覆盖默认的记忆文件目录（默认位于 `<agentDir>/project-memory/projects/<project-key>/memory`），将 `MEMORY.md` 和所有主题 `.md` 文件保存到你指定的目录中。
- **两级校验规则**：
  1. `parseConfig()` 阶段：如果传入非字符串，或 `trim()` 后为空字符串，归为 `null`。
  2. `resolveProjectPaths()` 阶段（`configuredMemoryDirectory()`）：检查字符串是否合法。如果**不满足**以下任一条件，不会抛出异常，而是静默回退到项目默认的 `projects/<project-key>/memory` 目录：
     - 必须是绝对路径，或者以 `~/`、`~\` 开头。
     - 若以 `~/` 开头，`~/` 之后的部分规范化后不能是 `.`、`..`，也不能以 `../` 或 `..\` 开头。
     - 不能包含空字节 `\0`。
     - 展开并去掉末尾斜杠后，字符长度必须至少为 3，且不能是根目录 `/` 或 Windows 盘符根（如 `C:`）。
     - 路径中任何一段目录名（按 `/` 或 `\` 拆分，不区分大小写）不能是版本控制元数据目录：`.git`、`.hg`、`.svn`、`.bzr`、`.jj`、`.sl`。
  3. `initializeProjectPaths()` 阶段：如果目标路径在磁盘上已经存在，但本身是一个符号链接（symlink）或非目录文件，初始化会直接抛出错误拒绝运行。

### 2. 模型配置（`models`）

`models.selector`、`models.extractor` 和 `models.dream` 彼此完全独立，你可以为高频轻量的 `selector` 配置快速低价模型，为 `dream` 配置推理能力更强的模型。

#### 公共字段：`model`、`thinkingLevel`、`maxTokens`

- **`model`**：
  - 设为 `"inherit"` 时，使用当前 Pi 主会话正在使用的模型（`ctx.model`）。若当前主会话没有活动模型，后台任务会报错提示无可用模型。
  - 设为 `"provider/model-id"` 格式字符串时（解析器通过 `indexOf("/")` 检查第一个 `/` 两侧均非空，`model-id` 内部可以继续包含 `/`），扩展会在运行时按第一个 `/` 拆出 `provider` 与 `modelId`，调用 `ctx.modelRegistry.find(provider, modelId)` 并检查 `ctx.modelRegistry.hasConfiguredAuth(model)`。如果字符串不含 `/` 或 `/` 位于首尾，配置解析阶段会回退为 `"inherit"`；如果格式合法但找不到该模型或未配置凭据，运行时会发出 warning 通知并跳过本次任务，**绝不会**回退到 `"inherit"` 或其他模型。
- **`thinkingLevel`**：
  - 允许值为 `"off"`、`"minimal"`、`"low"`、`"medium"`、`"high"`、`"xhigh"`、`"max"`。
  - 运行时会通过 Pi 的 `clampThinkingLevel(model, configured)` 映射到该模型实际支持的最近档位（例如对不支持推理的模型会自动降为 `"off"`）。当最终生效档位为 `"off"` 时，请求不传 `reasoning` 参数。
- **`maxTokens`**：
  - 允许值为 `"inherit"` 或 `64` 到 `65536` 之间的整数（超出范围如 `32` 或 `100000` 会回退为该角色的默认值：selector 回退为 `512`，extractor 和 dream 回退为 `"inherit"`）。
  - 设为 `"inherit"` 时，调用 `streamSimple()` 不传 `maxTokens`，沿用模型或 provider 的默认上限。

#### `models.selector` 专属字段与行为

- **`structuredOutput`（`boolean`，默认 `true`）**：
  - 当设为 `true` 且目标模型的 `model.api` 属于以下 9 种内置协议之一时，selector 首先发送带有原生 JSON Schema 输出约束的请求：`anthropic-messages`、`openai-completions`、`openai-responses`、`openai-codex-responses`、`azure-openai-responses`、`google-generative-ai`、`google-vertex`、`mistral-conversations`、`bedrock-converse-stream`。
  - 如果原生请求失败，且错误属于客户端格式不支持（如 HTTP 400、404、405、406、415、422，或错误信息匹配 `structured_output`、`json_schema`、`response_format`、`output_config`），selector 会在**同一模型**上自动切换到 `select_memories` 受约束工具模式重试一次。
  - 如果错误属于认证/权限失败（401、403）、超时（408）、冲突/锁定（409、423、425）、限流（429）、服务端错误（5xx）、网络错误、取消（`AbortError`）、安全拒绝（refusal / content_filter / safety）或输出达到 `maxTokens` 被截断（`stopReason === "length"`），则**不会**重试工具模式，直接发出 warning 并返回空选择 `[]`。
  - 如果原生请求成功返回，但返回文本不是合法的 `{"selected_memories": string[]}` JSON，直接发出 warning 并返回 `[]`，不再发起第二次工具请求。
  - 当 `structuredOutput` 设为 `false`，或者模型的 API 协议为 `pi-messages` 或其他自定义 API 时，selector 直接使用 `select_memories` 工具模式，不发送原生格式探测请求。
- **与 `maxTokens` 的配合**：如果将 `models.selector.thinkingLevel` 设为非 `"off"`，而目标协议将思考 token 计入 `maxTokens`，过小的 `maxTokens` 可能导致返回 `stopReason: "length"`（此时即使已输出部分有效 JSON，selector 也会将其视为截断失败并丢弃）。因此在开启 selector 思考时，建议相应调大 `models.selector.maxTokens`。

#### `models.extractor` 与 `models.dream` 的模型切换影响

当 `extractor` 或 `dream` 实际解析出的模型与主会话历史消息中的助手模型满足相同的 `provider`、`api` 和 `model.id` 时，重放历史消息会保留隐藏的 `thinking` 块及其加密签名；只要三者有一项不同（例如为 `extractor` 单独指定了另一个模型），扩展在重放消息时会自动剥离所有历史 `thinking` 块以及文本块和工具调用块上的 `textSignature`、`thoughtSignature`，防止跨模型签名校验报错。

### 3. 自动提取配置（`extraction`）

- **`enabled`（`boolean`，默认 `true`）**：控制是否在轮次结束（`agent_settled`）、空闲超时（idle）、会话压缩前（`session_before_compact`）和会话退出时（`session_shutdown`）自动运行提取。设为 `false` 时上述自动触发全部停用，但用户在命令行手动执行 `/memory extract` **仍然可以运行**（前提是顶层 `enabled` 为 `true` 且未提取消息满足至少 3 个词的用户正文门槛）。
- **`everyNTurns`（`1` 到 `100`，默认 `1`）**：每完成多少个正常结束的对话轮次运行一次自动提取。例如设为 `3` 时，第 1、2 轮结束时不会立即提取，而是启动空闲计时器；到第 3 轮结束时立即提取并将轮次计数归零。
- **`idleFlushSeconds`（`0` 到 `86400`，默认 `120`，单位：秒）**：与 `everyNTurns` 配合使用。当 `everyNTurns > 1` 且当前累积轮次尚未达到阈值，或者上一轮提取因锁占用/后续合并（trailing extraction）需要稍后重试时，如果会话持续空闲达到 `idleFlushSeconds` 秒，扩展会自动触发一次提取。设为 `0` 时关闭空闲计时器触发。
- **`maxTurns`（`1` 到 `8`，默认 `5`）**：限制 extractor 子 Agent 最多执行多少轮模型调用与工具执行循环。推荐策略是第 1 轮并发读取所有可能更新的记忆文件，第 2 轮并发写入或编辑。如果在最后一轮模型仍返回了工具调用，扩展会执行完该轮工具调用后结束任务，不再发起下一次模型请求。
- **`recentMessages`（`"inherit"` 或 `3` 到 `1000`，默认 `"inherit"`）**：控制从提取游标（cursor）之后的未处理消息切片中，向后截取多少条 `user` 和 `assistant` 消息发送给 extractor：
  - 设为 `"inherit"` 时，发送游标之后的全部未处理消息。
  - 设为整数 `N`（`3` 到 `1000`）时，从切片末尾向前数满 `N` 条 `user` 或 `assistant` 消息，并保留这 `N` 条消息之间的所有 `toolResult` 消息。

### 4. 定期整理配置（`dream`）

- **`enabled`（`boolean`，默认 `true`）**：Dream 功能的总门控。与 `extraction.enabled` 不同，当 `dream.enabled` 设为 `false` 时，不仅自动整理会停用，**手动运行 `/memory dream` 也会被拒绝**（提示 `Memory dream is disabled by the global dream gate`）。
- **`minimumHours`（`1` 到 `8760`，默认 `24`，单位：小时）**：自动整理的时间门槛。要求当前时间距离共享状态文件 `state.json` 中的 `lastDreamAt` 至少经过 `minimumHours * 3600` 秒。
- **`minimumOtherSessions`（`1` 到 `1000`，默认 `5`，单位：会话数）**：自动整理的会话数量门槛。在满足 `minimumHours` 后，扩展会扫描当前项目的 session 目录，统计修改时间（`mtimeMs`）晚于 `lastDreamAt` 且不等于当前会话的文件数量（按合法的 session header `id` 去重）。只有当其他会话数达到 `minimumOtherSessions` 时才会启动自动整理。手动运行 `/memory dream` 会跳过 `minimumHours`、`minimumOtherSessions` 和 `scanThrottleSeconds` 三个门槛，但仍会把扫描到的近期会话 ID 列表传给 dream 模型。
- **`scanThrottleSeconds`（`0` 到 `86400`，默认 `600`，单位：秒）**：进程内目录扫描节流时间。当距离上次整理尝试已满 `minimumHours`，但活跃的其他会话数还不到 `minimumOtherSessions` 时，为了避免每个对话轮次结束都重复遍历 session 目录，同一个 Pi 进程内至少间隔 `scanThrottleSeconds` 秒才会再次扫描 session 目录。设为 `0` 时每轮都会扫描。
- **`maxTurns`（`1` 到 `50`，默认 `50`）**：Dream 子 Agent 的最大工具循环轮次。

## 有效 JSON 配置示例

### 示例 1：默认配置（与 `config.example.json` 一致）

```json
{
  "enabled": true,
  "autoMemoryDirectory": null,
  "models": {
    "selector": {
      "model": "inherit",
      "thinkingLevel": "off",
      "maxTokens": 512,
      "structuredOutput": true
    },
    "extractor": {
      "model": "inherit",
      "thinkingLevel": "low",
      "maxTokens": "inherit"
    },
    "dream": {
      "model": "inherit",
      "thinkingLevel": "medium",
      "maxTokens": "inherit"
    }
  },
  "extraction": {
    "enabled": true,
    "everyNTurns": 1,
    "idleFlushSeconds": 120,
    "maxTurns": 5,
    "recentMessages": "inherit"
  },
  "dream": {
    "enabled": true,
    "minimumHours": 24,
    "minimumOtherSessions": 5,
    "scanThrottleSeconds": 600,
    "maxTurns": 50
  }
}
```

### 示例 2：分角色指定模型、降低提取频率并自定义记忆目录

以下配置将高频的 `selector` 绑定到轻量模型，每 3 轮对话（或空闲 300 秒）提取一次且最多只看最近 20 条对话，同时将记忆文件存放在 `~/notes/pi-memory`：

```json
{
  "enabled": true,
  "autoMemoryDirectory": "~/notes/pi-memory",
  "models": {
    "selector": {
      "model": "anthropic/claude-3-5-haiku-latest",
      "thinkingLevel": "off",
      "maxTokens": 512,
      "structuredOutput": true
    },
    "extractor": {
      "model": "anthropic/claude-sonnet-4-20250514",
      "thinkingLevel": "low",
      "maxTokens": 4096
    },
    "dream": {
      "model": "inherit",
      "thinkingLevel": "high",
      "maxTokens": 8192
    }
  },
  "extraction": {
    "enabled": true,
    "everyNTurns": 3,
    "idleFlushSeconds": 300,
    "maxTurns": 5,
    "recentMessages": 20
  },
  "dream": {
    "enabled": true,
    "minimumHours": 48,
    "minimumOtherSessions": 8,
    "scanThrottleSeconds": 900,
    "maxTurns": 30
  }
}
```

## 存储路径与目录结构

### 1. 完整目录树

当扩展在已信任项目中启用后，会在 `<agentDir>/project-memory/`（默认 `~/.pi/agent/project-memory/`）以及操作系统临时目录下使用如下文件结构：

```text
~/.pi/agent/project-memory/                  # 扩展数据根目录（受 PI_CODING_AGENT_DIR 控制）
├── config.json                              # 用户级配置文件（可选，用户手动创建与编辑）
├── projects/                                # 按项目隔离的命名空间目录
│   ├── <project-key>/                       # 普通项目命名空间（首次预留成功的项目）
│   │   ├── .project-root                    # 命名空间归属标记文件（保存规范化 projectRoot 单行文本）
│   │   ├── state.json                       # 默认模式下的项目级状态路径（亦用作旧版状态迁移回退源）
│   │   ├── memory/                          # 默认模式下的项目记忆目录（autoMemoryDirectory 为 null 时）
│   │   │   ├── MEMORY.md                    # 记忆索引文件（每次请求前自动裁剪并注入系统上下文）
│   │   │   ├── <topic>.md                   # 主题记忆文件（支持嵌套子目录，如 nested/fact.md）
│   │   │   └── .<name>.<pid>.<uuid>.tmp     # 原子写入期间短暂存在的临时文件（发布后立即删除）
│   │   └── stores/                          # 当配置了有效 autoMemoryDirectory 时使用的状态隔离目录
│   │       └── <memory-root-hash>/          # 按自定义 memory 目录真实路径计算的 24 位 SHA-256
│   │           └── state.json               # 自定义目录模式下的项目状态文件路径（paths.stateFile）
│   └── <project-key>-<project-root-hash>/   # 当不同项目的 sanitized key 发生碰撞时自动启用的消歧命名空间
│       └── ...                              # 结构与 <project-key>/ 完全一致
└── memory-roots/                            # 按实际 memory 根目录共享的协调目录
    └── <memory-root-hash>/                  # 规范化 memoryDir 的 24 位 SHA-256 哈希
        ├── state.json                       # 实际读写的共享 Dream 整理状态（paths.dreamStateFile）
        └── locks/                           # 跨进程互斥锁目录（paths.locksDir）
            ├── extract.lock                 # 后台提取任务互斥锁（超时 15 分钟）
            ├── extract.lock.recover         # 接管过期 extract.lock 时短暂存在的仲裁锁
            ├── dream.lock                   # 后台整理任务互斥锁（超时 60 分钟）
            ├── dream.lock.recover           # 接管过期 dream.lock 时短暂存在的仲裁锁
            ├── last-dream-at.lock           # 更新 state.json 中 lastDreamAt 时的 CAS 锁（超时 1 分钟）
            └── files/                       # 单文件写入/编辑/删除互斥锁目录
                └── <file-path-sha256>.lock  # 按目标 Markdown 绝对路径 SHA-256 命名的文件锁（超时 15 分钟）

<autoMemoryDirectory>/                       # 当配置了有效 autoMemoryDirectory 时的自定义记忆目录
├── MEMORY.md                                # 记忆索引文件
└── *.md                                     # 主题记忆文件

<os.tmpdir()>/                               # 操作系统临时目录（运行期间按需创建，结束后自动删除）
├── pi-project-memory-<random>/              # 单次 extractor 或 dream 运行的私有 scratchDir
│   ├── controlled-bin/                      # 受限 Bash 注入 PATH 的受信任命令软链与 grep/xargs 包装脚本
│   ├── bash-<uuid>.log                      # 受限 Bash 超出内联长度时的完整输出转存文件
│   └── codemode-<uuid>.txt                  # 后台 codemode 超出内联长度时的完整输出转存文件
└── pi-project-memory-search-<random>/       # 单次后台 find / grep 子进程运行的临时隔离目录
    └── bin/                                 # 注入边界排除规则的 rg / fd 包装脚本
```

### 2. 项目归属、`<project-key>` 计算与碰撞处理

1. **解析规范化项目根路径（`projectRoot`）**：
   - 扩展首先对当前工作目录执行 `realpath(resolve(cwd))`。
   - 随后在禁用全局/系统 Git 配置、禁用 hooks 和 fsmonitor 的干净环境中执行 `git -C <canonicalCwd> rev-parse --show-toplevel` 与 `--git-common-dir`。
   - 如果当前目录是一个通过 `git worktree` 创建的关联工作树，其 `--git-common-dir` 会指向主检出仓库下的 `.git` 目录（即 `basename(commonDir) === ".git"`）。此时扩展会取 `realpath(dirname(commonDir))` 作为 `projectRoot`，从而让主检出和所有关联 worktree 共享同一个项目身份与同一份记忆。
   - 如果是裸仓库（bare repository）或特殊 `.git` 布局，则使用 `--show-toplevel` 的真实路径；如果当前目录不在 Git 仓库内或 `git` 命令失败，则使用 `canonicalCwd`。
2. **生成 `<project-key>`**：
   - 将 `projectRoot` 中的所有非字母数字字符（`[^a-zA-Z0-9]`）替换为 `-`。
   - 如果替换后的长度不超过 200 个字符，直接使用该字符串作为 `projectKey`。
   - 如果超过 200 个字符，取前 200 个字符并拼接 `-<base36Hash(projectRoot)>`（其中 `base36Hash` 采用与 Claude Code 2.1.296 一致的 32 位有符号 Java `String.hashCode` 算法转无符号 36 进制字符串）。
3. **命名空间预留与防碰撞（`.project-root`）**：
   - 由于 `/path/a-b` 和 `/path/a_b` 替换非字母数字字符后都会变成 `-path-a-b`，扩展通过 `projects/<namespace>/.project-root` 文件防止不同项目互相覆盖。
   - 首次访问 `projects/<project-key>/` 时，扩展以独占创建模式（`wx`，权限 `0600`）写入 `.project-root`，内容为 `<projectRoot>\n`。
   - 如果 `.project-root` 已存在且记录的路径与当前 `projectRoot` 相同，则继续使用 `projects/<project-key>/`。
   - 如果 `.project-root` 记录的是另一个项目的根路径，说明发生了命名空间碰撞，扩展会自动改用 `projects/<project-key>-<project-root-hash>/`（其中 `<project-root-hash>` 是 `projectRoot` 经 NFC 归一化后的 SHA-256 前 24 位十六进制字符），并在该目录下写入归属自己的 `.project-root`。
   - 兼容性迁移：如果检测到旧版本遗留的 `projects/<project-key>-<project-root-hash>/.project-root` 归属当前项目，且普通的 `projects/<project-key>/` 尚未被占用，扩展会在解析路径时自动将其原子重命名回 `projects/<project-key>/`。

### 3. 默认与自定义记忆目录的影响，以及三类 `state.json` 的用途

扩展将**项目命名空间**与**实际记忆存储根（memory root）**分开管理：

- **默认目录模式（`autoMemoryDirectory: null`）**：
  - `paths.baseDir` 为 `projects/<namespace>`。
  - `paths.memoryDir` 为 `projects/<namespace>/memory`。
  - `paths.stateFile` 为 `projects/<namespace>/state.json`。
- **自定义目录模式（`autoMemoryDirectory` 为合法路径）**：
  - `paths.memoryDir` 为展开并规范化后的自定义路径。
  - 扩展会对 `paths.memoryDir` 解析最深已存在祖先的 `realpath` 并做 NFC 归一化，计算 24 位 SHA-256 得到 `<memory-root-hash>`。
  - `paths.baseDir` 为 `projects/<namespace>/stores/<memory-root-hash>`（初始化时会创建该私有目录）。
  - `paths.stateFile` 为 `projects/<namespace>/stores/<memory-root-hash>/state.json`。
- **共享协调目录（`memory-roots/<memory-root-hash>/`）**：
  - 无论使用默认目录还是自定义目录，都会按 `paths.memoryDir` 的规范化真实路径计算 `<memory-root-hash>`，并将：
    - `paths.dreamStateFile` 指向 `memory-roots/<memory-root-hash>/state.json`。
    - `paths.locksDir` 指向 `memory-roots/<memory-root-hash>/locks`。
  - 这意味着：如果你把默认路径显式写进 `autoMemoryDirectory`（或通过符号链接别名指向同一个目录），或者让两个不同项目通过 `autoMemoryDirectory` 挂载同一个共享记忆目录，它们会计算出相同的 `<memory-root-hash>`，从而**自动共享同一套跨进程锁（`locks/`）和同一份 Dream 整理时间戳（`dreamStateFile`）**，不会对同一个记忆目录重复并发运行整理。
- **三处 `state.json` 路径在当前实现中的具体职责**：
  1. `memory-roots/<memory-root-hash>/state.json`（`paths.dreamStateFile`）：这是当前版本**唯一实际写入**的状态文件，格式为 `{"schemaVersion": 1, "lastDreamAt": <毫秒时间戳>}`。每次 Dream 取得锁并记录尝试时间、或因 fork 异常回滚时间时，都会写入该文件。
  2. `projects/<namespace>/state.json`（默认模式下的 `paths.stateFile`）与 `projects/<namespace>/stores/<memory-root-hash>/state.json`（自定义模式下的 `paths.stateFile`）：在 `readState()` 读取整理状态时，扩展优先读取 `paths.dreamStateFile`；当 `paths.dreamStateFile` 不存在（`ENOENT`）时，会自动回退读取 `paths.stateFile`（并且兼容读取旧字段名 `lastSuccessfulDreamAt`），从而无损继承旧版本的整理时间记录。

### 4. 锁文件、恢复锁与临时文件

所有锁文件均位于 `memory-roots/<memory-root-hash>/locks/` 下，内容格式为 `{"pid": <进程号>, "token": "<UUID>", "acquiredAt": <时间戳>}`：

- `extract.lock`：保证同一记忆根目录在同一时刻最多只有一个进程运行 extractor（stale 超时为 15 分钟）。
- `dream.lock`：保证同一记忆根目录在同一时刻最多只有一个进程运行 dream（stale 超时为 60 分钟）。
- `last-dream-at.lock`：在 compare-and-swap 更新 `state.json` 中的 `lastDreamAt` 时提供短周期互斥保护（stale 超时为 1 分钟）。
- `files/<sha256(resolve(filePath))>.lock`：后台子 Agent 写入、编辑或删除某个具体 `.md` 文件时的单文件跨进程锁（stale 超时为 15 分钟）。
- `*.lock.recover`：当某个锁文件已超过 stale 时间且原持有者 `pid` 进程已不存在时，竞争接管的进程会先以 `wx` 创建对应的 `.recover` 文件完成二次确认，移除死锁后立即删除 `.recover` 文件。
- `.<filename>.<pid>.<uuid>.tmp`：在更新 `state.json` 或记忆目录下的 `.md` 文件时，扩展会先在目标文件所在目录创建权限为 `0600` 的 `.tmp` 临时文件，写入完整内容并通过校验后，再通过 `link` + `rm`（新建文件防覆盖）或 `rename`（原子替换已有文件）发布，并在 `finally` 块中强制清理残留的 `.tmp` 文件。

### 5. 实际 Session 目录来源与只读用途

扩展本身**不存储**会话聊天记录（transcript），而是通过 Pi 会话管理器提供的 `ctx.sessionManager.getSessionDir()` 获取当前项目的原始 session 目录（包含 Pi 生成的 `*.jsonl` 会话文件）：

- **在 Dream 中的用途**：
  1. 调度阶段：Dream 调度器只读遍历 `sessionDir` 下的 `.jsonl` 文件，读取每个文件前 16 KiB 的首行 JSON header（要求 `type === "session"` 且 `id` 符合安全字符语法 `/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/`），排除当前会话自身，统计 `mtimeMs > lastDreamAt` 的其他会话数量。如果宿主使用的是共享自定义 session 目录（`usesDefaultSessionDir()` 返回 `false`），调度器还会额外解析 header 中的 `cwd` 字段，只统计归属于当前项目 `projectRoot` 的会话。
  2. 执行阶段：`sessionDir` 被加入 dream 子 Agent 的批准只读根目录，选出的近期 session ID 列表被写入 dream 提示词。Dream 子 Agent 可以使用 `read`、`find`、`grep` 或受限只读 `bash` 在原始 `sessionDir` 中按关键词检索历史上下文；任何针对 `sessionDir` 的写入或删除操作都会被工具层拒绝。
- **在 Extractor 中的排除规则**：Extractor 的输入直接来自当前内存中的会话消息投影（`buildSessionProjection()`），不需要也不允许读取磁盘上的历史会话文件。因此 `sessionDir` 被显式加入 extractor 的 `excludedReadRoots`（即使 `sessionDir` 位于项目目录内部，extractor 的所有工具和受控 `xargs` 也会阻止读取它）。

### 6. 文件生命周期、清理机制与用户可编辑范围

- **自动清理的临时资源**：
  - 每次后台 extractor 或 dream 运行时创建的 `<tmpdir>/pi-project-memory-<random>/`（含受控命令目录和溢出的工具输出日志），会在该次子任务结束的 `finally` 块中通过 `rm(..., { recursive: true, force: true })` 彻底删除。
  - 每次后台 `find` 或 `grep` 搜索创建的 `<tmpdir>/pi-project-memory-search-<random>/`，会在该次搜索子进程退出后立即递归删除。
  - 正常释放的 `.lock`、`.lock.recover` 和 `.tmp` 文件会在对应操作结束时立即删除。
- **持久保留的文件（无后台静默删除）**：
  - `config.json`、`projects/<namespace>/`、`memory-roots/<memory-root-hash>/` 以及 `memory/` 下的 `.md` 文件会长期保留在磁盘上。
  - 卸载扩展、执行 `/memory reload-config` 或将 `enabled` 设为 `false` **不会**自动删除已有的项目记忆目录或历史文件。
  - 只有主模型或后台 extractor / dream 根据对话指令与事实核对结果，才会通过受控工具删除过时或错误的主题 `.md` 文件。
- **用户可安全查看与手动编辑的范围**：
  - **可安全编辑**：
    1. `~/.pi/agent/project-memory/config.json`：可随时手动编辑，保存后执行 `/memory reload-config` 或重启 Pi。
    2. 记忆目录（默认 `~/.pi/agent/project-memory/projects/<project-key>/memory/` 或自定义的 `autoMemoryDirectory`）下的 `MEMORY.md` 和所有主题 `.md` 文件：可随时用任何文本编辑器查看、新增、修改或删除。扩展在每次请求前、轮次结算前都会通过文件快照（`snapshotMarkdown`）自动检测外部修改，刷新已读抑制状态，并在主模型已加载过被改文件时自动通知主模型重新读取。注意：请保持文件名以小写 `.md` 结尾，不要在记忆目录内将 `.md` 文件替换为指向外部的符号链接，也不要把主题文件放进 `.git`、`agents`、`skills`、`node_modules` 等保留子目录名下。
  - **请勿手动修改**：
    - `.project-root`：修改会导致项目命名空间校验失败或被视为碰撞。
    - `state.json`：手动写入非法的 JSON 或不支持的 `schemaVersion` 会导致 Dream 调度器报错停止（这是为了防止损坏状态被静默覆盖而设计的保护行为）。
    - `locks/` 下的 `.lock` 与 `.recover` 文件：由扩展自动管理，除非确认所有 Pi 进程均已退出，否则请勿手动干预。
