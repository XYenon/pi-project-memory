# Claude Code 行为对齐说明

Pi Project Memory 以 Claude Code 2.1.296 的本地私有文件模式（local private file mode）自动记忆为参照。本文记录客户端可观察行为的对齐范围、静态逆向依据、Pi 宿主适配方案以及有意保留的差异。普通用户无需阅读本文。

## 证据范围与研究材料

分析对象是 `@anthropic-ai/claude-code@2.1.296` 的 darwin arm64 发布物（Bun 单文件可执行程序）。分析过程先从二进制中静态提取 Bun 模块图，再结合逆向分析工具（REA）与源码级审计定位自动记忆相关代码，全程未执行目标二进制程序。

本文结论只覆盖客户端可执行文件中可观察到的确定性逻辑与提示词模板，不推断 Anthropic 服务端的私有特性开关（feature flags）、内部模型路由、向量 embedding、重排序（ranking）或 `memory_search` 服务端实现。

逆向分析报告、原始提示词摘录和 chunk 级校验依据保存在仓库的 `docs/research/` 目录中。`docs/research/` 只记录 Claude Code 的目标行为与证据，所有与 Pi Project Memory 相关的实现、适配和差异说明均记录在本文及 `docs/design-and-security.zh.md`、`docs/development.zh.md` 中：

- [Claude Code 2.1.296 Memory 实现逆向分析](research/implementation-analysis.md)
- [提示词、工具定义与关键函数附录](research/prompt-tools-and-functions.md)
- [研究证据说明](research/research-evidence.md)

## 已对齐的核心行为

### 1. 文件布局与数据模型

- 采用 `MEMORY.md` 索引文件加独立 topic Markdown 文件的目录结构。
- `MEMORY.md` 只保存一行一条的链接指针（建议不超过 150 个字符），不含 frontmatter，也不直接存放记忆正文。
- 每个 topic 文件使用 YAML frontmatter 保存 `name`、`description` 和 `metadata.type`（支持 `user`、`feedback`、`project`、`reference` 四种类型；同时兼容像 Claude 一样将顶层非标准 `type` / `modified` 字段拍平归入 `metadata`，且显式 `metadata.type` 优先级更高）。

### 2. 项目 Key 与 Worktree 归属

- 项目根目录优先解析规范化后的 Git 根目录；若当前位于 `git worktree` 关联工作树且公共 Git 目录名为 `.git`，则归属到拥有该公共 `.git` 目录的主检出根目录，使多个关联工作树共享同一份项目记忆。非 Git 目录使用规范化后的当前工作目录。
- 项目 Key 将根路径中的所有非 `[A-Za-z0-9]` 字符替换为 `-`。若替换后长度超过 200 个字符，则保留前 200 个字符并追加 32 位有符号 Java `String.hashCode` 的 base36 后缀。

### 3. 索引裁剪、自动补建与取回窗口

- **索引窗口**：`MEMORY.md` 的注入上限为 200 行和 25,000 个 JavaScript UTF-16 代码单元（即字符串 `.length`，先达到者生效；超限时按换行符边界截断并在末尾附加 `WARNING: MEMORY.md was truncated` 提示）。虽然提示词文案称之为约 25KB，但实际代码按 UTF-16 代码单元计数。当 `MEMORY.md` 缺失且目录内存在可安全链接的 topic 文件时，扩展会按不超过窗口 80%（160 行、20,000 个代码单元）的容量并使用独占创建（`wx` no-clobber）自动补建初始索引。
- **单文件取回窗口**：每个被选中的 topic 文件最多读取前 200 行和 4,096 UTF-8 字节（先达到者生效）。读取按完整 UTF-8 行累加，当下一行超出 4,096 字节时立即停止，绝不注入半行或截断的多字节字符。
- **异步预取与延迟注入**：Selector 在 Pi 接受最终用户文本后异步启动。普通请求在 `before_agent_start` 启动，排队或流式用户消息在实际进入主会话（`message_end`）时启动，原始 `input` 事件不发起模型请求。普通请求开始前最多等待预取 2 秒；超过 2 秒才完成的结果会通过 Pi 的 `steer` 消息加入下一次模型调用。此外，普通请求会标记下一条用户消息已预取，当 Pi 紧接着追加图片尺寸归一化后的用户消息时不会重复调用 selector，而后续独立的排队消息仍会正常触发各自的 selector。
- **会话分支预算与已读抑制**：每个会话分支最多累计自动取回 61,440 个 UTF-16 代码单元。预算只统计净化后的 topic 正文以及文件被截断时实际附加的截断说明，不统计 `<system-reminder>` 包装、文件路径标题、过期提示和首条引导语。达到上限后停止调用 selector。当主 Agent 通过普通 `read` 工具完整读取某个 topic 文件后，该文件在当前分支不再自动取回；局部读取（`offset > 1` 或发生自动截断）不会触发抑制，且文件在磁盘上被修改后可重新进入候选。
- **文本净化**：索引注入与取回注入都会移除危险控制字符、格式字符与不可见字符，并将保留的提示词标签（如 `<system-reminder>`、`<tool_use>` 等及其 Unicode 同形异义变体）转义为 `&lt;`，且不会引入替换字符 `U+FFFD`。普通写入与编辑不执行落盘清理，也不因这些字符而阻断。

### 4. Selector 目录格式与输出 Schema

候选目录格式为 `- [type] filename (mtime ISO): description`（当 `type` 未知时省略 `[type]` 前缀）。输出 JSON Schema 与 Claude Code 2.1.296 完全一致：

```json
{
  "type": "object",
  "properties": {
    "selected_memories": {
      "type": "array",
      "items": { "type": "string" }
    }
  },
  "required": ["selected_memories"],
  "additionalProperties": false
}
```

Selector 默认最大输出为 512 token，单次最多返回 5 个文件名（若模型返回了带 `[project]` 等类型前缀的文件名，解析器会自动剥离前缀并校验其是否存在于候选列表中）。扩展在当前会话分支中保留 selector 的历史查询与回答对，避免在同一对话中重复选择相同文件。

### 5. 索引、扫描与 Selector 的容错边界

- **`readIndex()` 容错**：作为可选的系统上下文加载入口，当 `MEMORY.md` 缺失时会尝试自动补建；若读取或补建失败（例如 `MEMORY.md` 是悬空符号链接或目录），`readIndex()` 会静默返回空字符串 `""` 让主会话继续运行，而底层 `readRegularFileNoFollow()` 和 `backfillIndex()` 仍会向直接调用方抛出异常。这一行为对应 `chunk-sfn1dbxq.js` 中 `XNe()`（`35595` 行起）与 `BJn()`（`34548` 行起）的容错逻辑。
- **`scanTopics()` 容错**：对单个文件和目录整体失败分别处理。单个文件打开、读取或 UTF-8 解码失败时跳过该文件并保留其余有效 topic；目录无法遍历等整体失败时，公开入口 `scanTopics()` 返回空数组 `[]`。有效文件按 `mtime` 从新到旧排序并截取前 200 个。同时保留最多 16 个文件并发读取的上限，防止在低文件描述符限制下耗尽句柄。这一行为对应 `chunk-n3ykh62m.js` 中 `Hdr()`（`10285` 行起，使用 `Promise.allSettled()`）与 `dVe()`（`10348` 行起）的逻辑。
- **Selector 失败边界**：当请求报错、输出被长度截断（`length`）、缺少文本、JSON 解析失败或 schema 校验不通过时，selector 边界会发出 warning 通知并返回空数组 `[]`；当请求被取消（`aborted`）时静默返回 `[]`。若原生结构化输出请求已成功返回但内容格式不合法，直接返回 `[]` 而不再发起第二次工具请求。这一行为对应 `chunk-sfn1dbxq.js:171105` 起的异常处理逻辑。

### 6. 回合后提取（Extraction）

- **消息上下文与签名处理**：提取游标（cursor）决定待提取范围与提示词中的近期消息数量。同模型且可复用父请求时，Extractor 传入完整父历史作为缓存前缀，再追加针对近期未处理消息的任务指令；独立请求路径只传入游标之后的消息（可由 `recentMessages` 裁剪）。当 extractor 与历史助手消息使用完全相同的具体 `provider`、`api` 和 `model` 时保留 `thinking` 块及签名；跨模型时删除 `thinking` 块并剥离文本与工具调用上的 provider 专属签名。
- **提示词补齐**：启动 extractor（或 dream）时，如果父会话系统提示词中尚未包含自动记忆规则（例如恢复会话后立即手动运行 `/memory extract`），扩展会自动补齐包含当前 memory 目录、记忆类型、排除项和 frontmatter 规则的主记忆提示词；若父提示词已包含则直接复用，避免重复拼接。
- **新输入与合并运行**：对齐 Claude Code 本地文件模式，新用户输入到达时不会中止正在运行的 extractor，也不会剥夺其写入资格。提取控制器会在当前提取结束后将新增对话合并为一次后续提取（trailing extraction）。会话压缩前也会先等待正在准备或运行中的提取，再提取剩余未处理消息。
- **游标前移语义**：当触发主 Agent 直接写入去重或未达到三词用户正文门槛而跳过时，游标前移到当前消息快照末尾。当后台提取子任务正常返回时（包括模型返回 API error 或达到 `maxTurns` 上限），游标同样前移到本次输入快照末尾；只有当子任务抛出异常、被中止或因信任/配置变更失效时才保留原游标以便重试。提取期间新到达的消息不会被本次游标前移消费。Claude MCP 模式下的连续三次未完成才前移游标规则不适用于本地文件模式。

### 7. 定期整理（Dream）与退出等待（Shutdown）

- **触发与独立派发**：在正常结束的轮次（`agent_settled`）后检查，默认要求距上次整理尝试满 24 小时且至少有 5 个其他会话更新，进程内扫描节流为 10 分钟，子 Agent 工具循环上限为 50 轮。Extractor 与 dream 从同一轮次独立派发，分别使用 `extract.lock` 和 `dream.lock`。
- **尝试时间与回滚语义**：取得 `dream.lock` 并开始任务时立即记录尝试时间 `lastDreamAt`，后续的 24 小时门槛和其他会话计数均以该尝试时间为基准。子任务正常返回（含返回 API error 或未改动文件）或被中止（`aborted`）时均保留本次时间戳；只有当子任务在 fork 阶段未因中止而抛出异常时，才使用 compare-and-swap 回滚到旧时间戳，完成阶段（completion）的通知报错不回滚。
- **直接只读访问原始会话目录**：调度器读取 `.jsonl` 会话文件头部信息（校验 `type: "session"` 与合法的 Pi 会话 ID 语法，并在自定义共享会话目录下按规范化项目根路径过滤），将近期会话 ID 列表放入 dream 提示词。Dream 直接只读访问原始 session 目录，不将 transcript 预复制到临时目录，也不把 ID 列表当作文件访问白名单；读取某个会话文件失败时由工具直接返回错误，不会回滚整理时间戳。这一行为对应 `chunk-kxgzv2t8.js:340` 起直接传入会话目录与近期 ID 列表的实现。
- **退出等待**：会话退出（`session_shutdown`）时，扩展最多等待后台维护任务 60 秒，超时后触发中止信号。

### 8. 提示词缓存与记忆上下文快照

补充静态核对了 Claude Code 2.1.296 与 2.1.300 的 Linux x64 发布物：初始指令文件与组装后的用户上下文均有会话级缓存，记忆写入通过追加过期通知处理；传统 selector 显式缓存系统提示词、完整目录与最新查询；本地 extractor / dream fork 保留父系统提示词、工具声明与完整消息前缀。Pi 按这些机制实现：

- `MEMORY.md` 首次加载后保持快照，压缩、分支导航、配置重载与会话启动时刷新；后台与外部编辑不替换旧系统段落。
- Selector 启用短期缓存，稳定会话缓存标识，保留完整目录与查询/回答历史，返回后过滤已读且未改动的文件。目录实际变化时更新目录文本。缓存标记遵循 Pi API 适配器的默认行为，扩展不额外添加目录断点或改写 OAuth 系统标记。
- Extractor / dream 在同模型、工具 schema 兼容且有捕获快照时保留父前缀，工具限制与任务指令追加到用户消息中。执行器只连接受限工具；整数 `recentMessages`、图片阻止等不能复用的情况走独立请求。详见[父请求前缀与执行权限](design-and-security.zh.md#父请求前缀与执行权限)。
- 两条后台路径均使用 Pi 的 `cacheRetention: "short"`。Claude 的本地 `skipCacheWrite` 受服务端开关控制且客户端回退值为 `false`；该选项调整尾部缓存标记，不能解释成禁用全部缓存。Pi 不引入该私有开关，也不保证实际命中率或费用下降。

## 提示词与后台工具对齐

### 1. 静态提示词基线规则

主 Agent 自动记忆提示词、selector 提示词、extractor 提示词和 dream 提示词均以 Claude Code 2.1.296 本地私有文件模式的运行时文本为固定基线（由 `tests/prompts.test.ts` 与 `tests/fixtures/prompts/*.txt` 逐字校验）。静态文本只做以下四类替换：

1. 将指令文件名 `CLAUDE.md` 替换为 `AGENTS.md`。
2. 将工具名称、参数名或字段名替换为 Pi 原生接口（如 `read`、`write`、`edit`、`find`、`grep`、`bash`）。
3. 删除仅服务于明确不支持功能（如团队共享存储、MCP 记忆工具等）的专属段落。
4. 将提示词中的产品名 `Claude Code` 替换为中性称呼 `the agent`。

当 selector 使用受约束工具模式时，允许在 selector 基线末尾追加固定指令：`Call the select_memories tool exactly once with the JSON object you would otherwise return.`。运行时的目录路径、消息条数和近期 session ID 列表属于动态插值，按 Pi 实际运行值填入。

### 2. 后台工具接口与 Codemode 适配

后台子 Agent 不仿造 Claude Code 的文件工具名称与参数结构，而是直接包装并复用 Pi 原生的六个工具工厂：`read`、`find`、`grep`、`write`、`edit` 和 `bash`。因此，`read` 的分页窗口、`find` / `grep` 的参数格式以及 `edit` 的 `edits[]` 数组结构均以 Pi 为准；不提供 Claude 的 `Glob` 工具、`Grep` 的 `output_mode`、`Read` 的 PDF `pages` / `allow_large` 参数，不额外实现 PDF 或 Jupyter Notebook 解析，文件读取沿用 Pi 原生行为。

Bash 按 Claude 记忆权限路径中观察到的执行顺序工作：先进行静态权限和只读检查，再交给宿主通用 Shell 工具。Pi Project Memory 将原始命令传给 Pi 原生 Bash 工具，由宿主程序执行 grep 和 xargs；不复刻 Claude 可选的沙箱包装。标准输入展开后的动态路径不做运行时检查。

独立的 `## Background memory task tools` 说明列出后台可执行工具及其访问限制，同时完整保留继承的用户指令、项目指令与自动记忆规则。复用父前缀时，该说明随任务指令追加到末尾用户消息，保留原工具声明；独立请求时仍追加在系统提示词末尾并声明受限工具。

当主会话启用了 `codemode` 时，extractor 和 dream 也会在任务内部启用 Pi 原生 `codemode`，并继承主会话的 `on` / `only` 模式与 `inlineBudget`。脚本内只能调用当前任务的六个受限工具，同样受路径、读取基线、项目信任与代次检查约束，且任务内的内存 store 与父会话完全隔离。这是面向 Pi 执行环境的工具调用适配，不改变上述四份固定提示词基线。

### 3. 后台工具的工作目录依据

在 Claude Code 2.1.296 中，本地 extraction（`chunk-9mazb6vn.js:912`）和 dream（`chunk-kxgzv2t8.js:356`）均通过通用 `MC()` 函数（`chunk-sfn1dbxq.js:116467`）调用 `Rir()`（同文件 `116301` 行）创建后台 fork 上下文，默认直接继承父会话的 session 与工作目录，并未针对不同后台角色或读写操作切换工作目录；memory 目录仅传给权限检查函数 `p5n()`（`chunk-9mazb6vn.js:429`）用于限制写入范围。

对齐这一机制，Pi Project Memory 将任务开始时父会话的 `ctx.cwd` 统一作为后台 `read`、`find`、`grep`、`write`、`edit` 和 `bash` 的工作目录基准，extractor 与 dream 完全一致：

- 当从仓库子目录或关联 worktree 启动 Pi 时，规范化项目根目录（`projectRoot`）决定记忆归属身份，而 `ctx.cwd` 决定工具相对路径的解析起点（`find` 和 `grep` 省略 `path` 时也从 `ctx.cwd` 搜索）。
- Claude 的 `Read`、`Write`、`Edit` 接口要求传入绝对路径；Pi 原生工具支持相对路径，并统一相对于 `ctx.cwd` 解析。因此后台模型修改记忆文件时，应传入绝对路径或从 `ctx.cwd` 指向 memory 目录的相对路径（直接传入 `"topic.md"` 会解析到 `ctx.cwd/topic.md`，不会自动重定向到 memory 目录）。

## 针对 Pi 宿主的适配与细节取舍

下表汇总了将 Claude Code 2.1.296 本地记忆机制迁移到 Pi 宿主时的具体取舍及实现方式：

### 输入过滤与自动提取

| Claude Code 2.1.296 机制               | 策略         | Pi Project Memory 的实现方式与理由                                                                                                                                                         |
| -------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 只处理主 Agent 的真实用户查询          | 适配宿主事件 | 仅对主会话实际提交给模型的用户文本启动 selector，排除工具结果、记忆更新/取回消息、后台任务请求与本地 `/memory` 命令。                                                                      |
| 内部 query source 标识过滤             | 适配宿主事件 | 使用 Pi 公开的 `before_agent_start`（普通请求最终 prompt）和 `message_end`（排队/流式用户消息）识别有效文本；不在原始 `input` 事件中调用模型，防止被其他扩展改写或拦截前发起无效请求。     |
| Selector 内部空白门槛与条件性 CJK 分支 | 保留传统路径 | 要求 `/\s/.test(query.trim())` 为真，单个英文词或无空格中文不启动 selector。Claude 的无空格 CJK 例外与 BM25 共用 `tengu_mill_orange` 开关，本项目不含 BM25，故保持传统空白门槛。           |
| 游标后已有直接记忆写入则跳过提取       | 保留并适配   | 检查游标之后主 Agent 是否有针对 memory 目录的成功 `write` 或 `edit` 调用；若有则跳过自动提取并前移游标，失败调用或目录外写入不跳过。                                                       |
| 三词用户正文（user prose）提取门槛     | 保留         | 要求游标后至少有一条真实用户消息的字符串正文或单个独立 `text` 块按 `/\s+/` 拆分后达到 3 个非空词（跨消息或跨块不合并，无独立中文分词）。未达标时自动提取跳过并前移游标；手动提取同受约束。 |
| 本地文件模式游标前移与新输入合并       | 保留         | 跳过或后台子任务返回（含 API error / 达到 `maxTurns`）时前移游标，子任务抛出异常时保留游标；运行期间的新输入标记为 `trailingExtraction`，不取消当前任务，也不被当前游标消费。              |
| MCP 提取模式的连续三次未完成阈值       | 排除         | 连续三次未完成才前移游标属于 MCP 传输分支（`chunk-9mazb6vn.js` 中的 `y()`），不适用于本地私有文件模式。                                                                                    |

### 上下文注入、工具状态与后台运行

| Claude Code 2.1.296 机制                     | 策略         | Pi Project Memory 的实现方式与理由                                                                                                                                               |
| -------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Topic 候选目录与 frontmatter 头部窗口        | 保留         | 扫描最多保留 200 个候选（按 `mtime` 降序），单文件读取前 30 行和 65,536 字节解析 frontmatter `description`、`type` 和 `modified`（缺失合法 `modified` 时回退到 `mtime`）。       |
| 取回历史、完整读取抑制与压缩后重置           | 保留并适配   | 文件修改后解除旧已读抑制。主会话完成压缩（`session_compact`）或切换分支（`session_tree`）后，按当前活动分支重建或重置取回预算、已读集合与 selector 历史。                        |
| 满 48 小时过期提醒与写后格式检查（lint）     | 适配消息机制 | 过期天数按 `Math.floor((Date.now() - mtimeMs) / 86_400_000) > 1` 计算（即至少满 48 小时才提醒）。提醒与写后 lint 通过 Pi 的 `tool_result` 与隐藏自定义消息注入上下文。           |
| 普通文本读取基线（Read baseline）            | 保留         | 后台 `read` 显式传入 `offset`/`limit` 的分页读取可建立修改基线（不累计多页范围）；被 2,000 行 / 50 KiB 默认窗口自动截断或图片读取会撤销基线。主 Agent 的完整读取抑制仍单独判定。 |
| 后台子任务不污染主会话对话记录               | 适配         | 后台工具循环不会追加到主会话 transcript；仅将文件变更摘要作为隐藏消息通知主会话，并在扩展进程内累计后台 token 与费用（通过 `/memory status` 展示）。                             |
| 通用 fork 的私有自动压缩（compaction）       | 排除内部引擎 | 保留主会话压缩前提取、跨模型签名清理和后台 `maxTurns` / `maxTokens` 限制；不复制 Claude 内部私有 fork 压缩引擎。                                                                 |
| 内部 API 重试策略与 Sonnet 候选模型路由      | 适配公开接口 | 通过 Pi 模型注册表调用用户配置或继承的模型。保留同一模型上原生 JSON Schema 到 `select_memories` 工具的降级重试，不跨模型切换或内置私有重试路由。                                 |
| 权限拒绝看门狗（Permission denial watchdog） | 排除         | Pi 没有宿主级 deny/ask 权限评估器与审批弹窗，扩展通过自身的项目信任、路径包含、读取基线、文件锁和轮次上限约束后台行为。                                                          |
| `<cc-memory>` 引用标签协议                   | 排除         | 该 XML 标签依赖 Claude 专属界面渲染与特性开关，Pi 无对应协议。                                                                                                                   |
| 精简模式、团队挂载、专用工具存储与技能维护   | 排除         | 仅实现本地私有文件模式，不管理团队/组织共享存储、自定义 Agent 记忆、项目 skills 或 `AGENTS.md`。                                                                                 |

## 兼容性总结

| 功能模块                                   | 兼容程度                                                   |
| ------------------------------------------ | ---------------------------------------------------------- |
| 本地目录结构、项目 Key、索引裁剪与自动取回 | 高兼容（对齐窗口常量、UTF-16/UTF-8 计数方式与补建逻辑）    |
| 提示词静态基线、Selector Schema 与生命周期 | 高兼容（仅做四类声明替换与工具模式单行追加）               |
| 用户文本过滤与提取/整理游标状态机          | 高兼容（对齐传统空白门槛、三词正文门槛与尝试时间回滚规则） |
| 路径包含、读取基线、跨进程锁与会话记录读取 | 高兼容（采用面向本地文件系统的确定性检查与原子发布）       |
| 后台工具名称与参数 Schema                  | Pi 原生接口（复用 Pi 原生六工具与可选任务内 codemode）     |
| 模型路由与结构化输出降级                   | 适配 Pi 模型注册表（同模型工具降级，无跨模型回退）         |
| 主会话通用权限系统（deny/ask）             | 不适用（Pi 无对应宿主设计，不属于本扩展职责）              |
| BM25、账户/团队共享记忆与服务端 Memory API | 不实现                                                     |

## 目标版本边界

本项目的对齐基线固定为 `@anthropic-ai/claude-code@2.1.296`。后续 Claude Code 版本如果调整了提示词、触发门槛、窗口大小、输出 schema 或服务端协议，应先更新 `docs/research/` 下的静态逆向证据，再同步更新代码实现、测试 fixture 与本文。
