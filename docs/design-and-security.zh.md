# 设计与安全边界

本文说明 Pi Project Memory 如何处理项目数据、协调并发读写，以及限制后台子 Agent 的工具能力。本扩展为项目自动记忆提供清晰、可测试的应用层边界，但不把本地路径与命令检查当作抵抗同一操作系统用户下恶意进程的完整安全沙箱。

## 威胁模型

扩展假定 Pi 宿主进程、当前操作系统用户账户以及由宿主 `PATH` 选择的命令行程序处于同一个信任域内。在此前提下，扩展的安全设计主要解决两类问题：

1. **防止后台模型越界访问或误改文件**：通过批准读取根目录、记忆目录写入包含检查（containment）、符号链接拒绝、受限只读 `bash` 分类以及普通文本读取基线（Read baseline），阻止后台子 Agent 直接读取未授权目录或修改记忆目录之外的文件。
2. **防止并发任务互相覆盖**：通过跨进程文件锁、状态版本比对（compare-and-swap）和临时文件原子重命名，协调同一项目或多个会话对同一记忆目录的并发维护。

扩展**不尝试**防御同一用户权限下持续替换目录、符号链接、二进制程序或环境变量的本地恶意进程。受限 `bash` 在原生命令执行前进行语法树（AST）分析、命令参数白名单和显式路径检查，但不会对全路径做持续的 inode / ctime 身份跟踪，也不提供操作系统内核级的命名空间或容器隔离。如果部署场景需要对抗不可信本地进程，应当在操作系统或容器层面配置独立的强隔离沙箱。

## 生命周期与工作流程

### 1. 请求前：索引注入与记忆取回（Recall）

- **用户文本捕获**：Selector 只处理主会话实际提交给模型的用户文本。普通交互请求在 `before_agent_start` 钩子中使用最终 prompt 启动预取；排队或流式跟进的用户消息在实际进入会话（`message_end`）时启动预取。原始 `input` 事件不会发起模型请求，避免被其他扩展拦截或改写前的文本产生多余调用。
- **空白字符门槛**：用户输入经 `trim()` 后内部必须包含空白字符（匹配 `/\s/`），且当前分支累计取回字符数未达到 61,440 上限，才会调用 selector。
- **注入与等待**：首次请求读取并缓存裁剪后的 `MEMORY.md`，后续请求复用同一系统提示词快照（`auto_memory` 与 `auto_memory_index` 段落）。索引改动通过追加过期提醒通知主模型；压缩、分支导航、配置重载和会话启动会清除快照。每次普通请求最多等待 selector 预取 2 秒：按时完成则直接注入 topic，超时结果通过 Pi 的 `steer` 消息送入后续模型调用。
- **Selector 缓存**：目录始终包含本次扫描的全部 topic，已读抑制在解析返回文件名时执行；只有目录数据实际变化才改变目录前缀。查询/回答历史与稳定的会话缓存标识用于后续请求。请求使用 Pi 的 `cacheRetention: "short"`，缓存标记由 Pi 的 API 适配器管理。

### 2. 对话轮次中：主 Agent 工具拦截与增强

- **写入前检查（`tool_call`）**：当主 Agent 调用 `read`、`write` 或 `edit` 访问 memory 目录时，扩展会先检查项目信任状态。若主 Agent 调用 `write` 或 `edit` 修改 memory 文件，而此时后台正在准备或运行 extractor / dream，扩展会暂时拦截该调用并提示稍后重试；同时还会验证目标路径不是符号链接、父目录真实路径仍在 memory 根目录内，且写入内容不包含保留的提示词标签（如 `<system-reminder>`）或危险不可见字符。
- **读取后过期提醒与写后检查（`tool_result`）**：
  - 当主 Agent 通过 `read` 完整读取某个 memory 文件后，扩展会将其加入当前分支的已读抑制集合，避免后续 selector 重复取回该文件；如果该文件修改时间距今满 48 小时（按天向下取整大于 1 天），工具返回结果开头会自动附加过期提醒，要求先对照当前代码核实。
  - 当主 Agent 通过 `write` 或 `edit` 成功写入 memory 文件后，扩展会立即对落盘内容执行格式与长度检查（lint）：如果文件接近或超过窗口限制、使用了类似 `topic-2.md` 的编号续写文件名、缺少 frontmatter `description` 或 `description` 超过 300 字符，会在工具结果末尾附加修正提醒。

### 3. 轮次结束后与退出前：后台维护（Extraction 与 Dream）

- **独立派发**：当一个对话轮次正常结束（`agent_settled`）且未发生中止时，扩展会先捕获外部对 memory 文件的改动，随后独立启动 extractor 和 dream 检查。两者分别使用 `extract.lock` 和 `dream.lock`，互不等待。
- **新输入不中断当前任务**：对齐 Claude Code 本地文件模式，新用户消息到达时不会中止正在运行的 extractor 或 dream，也不会撤销它们当前的写入资格。提取控制器会将期间新增的对话合并标记为一次后续提取（trailing extraction），在当前提取完成且会话空闲时继续处理。但若发生配置重载、全局关闭、项目信任撤销、代次（generation）失效或文件锁丢失，后台任务仍会立即中止并拒绝后续工具调用。
- **Dream 尝试时间与回滚**：Dream 在取得 `dream.lock` 并开始任务时立即通过 compare-and-swap 记录尝试时间戳 `lastDreamAt`。只要子任务正常返回（包括返回 API error 或未改动文件）或被取消中止，都保留该时间戳；只有当子任务在 fork 执行阶段未因中止而抛出异常时，才通过 compare-and-swap 回滚到旧时间戳（完成后的通知报错不回滚）。
- **变更通知持久化**：后台任务每成功修改或删除一个记忆文件，都会立即登记一条对模型可见、对界面隐藏的 `<system-reminder source="project-memory-update">` 更新记录，并实时累加已完成模型调用的 usage。即使后续轮次的模型请求抛出异常或任务被中止，已经落盘的变更通知和已消耗的 token 统计也不会丢失。
- **压缩与退出等待**：会话压缩前（`session_before_compact`），扩展会先等待正在准备或运行中的提取任务，再对未处理消息执行一次提取；压缩完成后重置当前分支的取回状态。会话退出时（`session_shutdown`），扩展最多等待后台维护任务 60 秒，超时后触发中止信号。

## 存储与状态布局

扩展在用户的 Pi agent 目录下维护以下结构：

```text
~/.pi/agent/project-memory/
├── config.json
├── projects/
│   └── <project-key>/
│       ├── .project-root
│       ├── state.json
│       ├── memory/
│       │   ├── MEMORY.md
│       │   └── *.md
│       └── stores/
│           └── <memory-root-hash>/
│               └── state.json
└── memory-roots/
    └── <memory-root-hash>/
        ├── state.json
        └── locks/
            ├── extract.lock
            ├── dream.lock
            ├── last-dream-at.lock
            └── files/
                └── <file-path-sha256>.lock
```

- **项目身份（Project Root）**：优先通过无副作用的 `git rev-parse --show-toplevel` 与 `--git-common-dir` 解析规范化 Git 根目录。如果是通过 `git worktree` 创建的关联工作树，且其公共 Git 目录名为 `.git`，则会解析到拥有该 `.git` 目录的主检出根目录，使同一仓库的不同 worktree 共享记忆。非 Git 目录则使用 `realpath(cwd)`。
- **命名空间预留与防碰撞**：路径中的非 `[A-Za-z0-9]` 字符会被替换为 `-`（超过 200 字符时截断并附加 32 位有符号 Java `String.hashCode` 的 base36 后缀）。为防止不同路径替换后产生相同的 `<project-key>`，扩展在初始化目录时会以独占方式（`wx`）写入 `.project-root` 标记文件记录真实项目根路径；若发现该命名空间已被另一个项目根路径占用，则自动改用 `<project-key>-<24位SHA256>` 子目录。
- **共享整理状态与锁**：无论使用默认目录还是通过用户级 `autoMemoryDirectory` 指定自定义目录，扩展都会对规范化后的实际 memory 根目录计算 24 位 SHA-256 哈希（`<memory-root-hash>`），并在 `memory-roots/<memory-root-hash>/` 下存放 `state.json`（记录 `lastDreamAt`）和 `locks/`。这样，默认路径与显式指向同一路径的配置（包括通过符号链接别名指向同一目录的情况）会共享同一份整理间隔状态和并发锁。若共享状态文件尚不存在，扩展会自动读取旧版项目级 `state.json` 作为迁移来源。完整的目录树、三类 `state.json` 职责、临时文件与生命周期说明见[配置参考与存储结构](configuration.zh.md#存储路径与目录结构)。

## 上下文窗口与扫描边界

| 阶段 / 对象            | 限制值                                 | 超限与失败处理行为                                                                                                                          |
| ---------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `MEMORY.md` 索引加载   | 200 行、25,000 个 UTF-16 代码单元      | 先达到者生效（按换行符边界裁剪），并在末尾附加截断警告。若索引缺失但存在合规 topic，按窗口 80%（160 行 / 20,000 字符）自动条件补建。        |
| Topic 目录扫描         | 最多 200 个文件，并发度 16             | 排除 `MEMORY.md` 和 `.git`、`.hg`、`.svn`、`.bzr`、`.jj`、`.sl` 目录。每个文件读取前 30 行 / 65,536 字节解析 frontmatter，按 `mtime` 降序。 |
| 单个 Topic 自动取回    | 200 行、4,096 UTF-8 字节               | 先达到者生效，仅保留完整 UTF-8 行（不返回半行或截断的多字节字符），并在截断时附加说明。                                                     |
| 会话分支累计取回预算   | 61,440 个 UTF-16 代码单元              | 仅统计清理后的 topic 正文与实际发送的截断说明。达到上限后当前分支不再调用 selector。                                                        |
| 后台 `read` 单文件上限 | 1 GiB 原始大小，单页 2,000 行或 50 KiB | 超出 2,000 行或 50 KiB 时由 Pi 原生 `read` 自动截断；支持显式传入 `offset` 和 `limit` 分页读取。                                            |
| 搜索传输               | 搜索子进程输出 4 MiB                   | 防止意外大输出耗尽内存，属于资源保护上限而非安全隔离。                                                                                      |

在扫描与取回边界上，单个 topic 文件打开、读取或 UTF-8 解码失败时会跳过该文件并保留其余有效结果；如果整个 memory 目录无法遍历，`scanTopics()` 与 `readIndex()` 会返回空结果以保证主会话正常继续，而不会中断用户的正常提问。

## 后台工具与执行环境

后台子 Agent（extractor 和 dream）只执行以下六个基于 Pi 原生工厂包装的工具：

- `read`：复用 Pi 原生 `createReadTool`，只允许读取批准根目录内的 UTF-8 文本文件和常见图片格式。明确拒绝 `.pdf`、`.ipynb`、包含 NUL 字节的二进制文件以及非 UTF-8 编码文件。
- `find` 与 `grep`：在独立子进程中运行 `native-search-worker.mjs`，复用 Pi 原生的 `createFindTool` 与 `createGrepTool`。子进程通过宿主 `PATH` 查找 `fd` 与 `rg` 可执行文件，清空 `RIPGREP_CONFIG_PATH`，强制对 `grep` 传入 `--no-config` 和 `--no-follow`（禁止跟随符号链接），并把排除目录规则放在命令行 `--` 分隔符之前的最后位置，确保模型传入的正向 glob 无法绕过排除规则。`grep` 单次调用带有 20 秒超时保护。
- `write` 与 `edit`：复用 Pi 原生的参数 schema、文本替换（`edits[]`）和 unified diff 生成逻辑，但将底层文件写入替换为扩展自己的安全发布管线（包含路径验证、内容清理、普通文本读取基线校验、跨进程文件锁、compare-and-swap、原子重命名与写后 lint 提示）。
- `bash`：复用 Pi 原生 `createBashTool` 的进程管理与输出截断逻辑（默认超时 120 秒，最大可设 600 秒；超出内联窗口的完整输出日志会被转移到任务专属的临时目录，并在任务结束时自动清理）。执行前必须通过下述受限 `bash` 检查。

### 父请求前缀与执行权限

扩展通过公开的 `context_with_system` 捕获父请求的系统消息、工具声明与消息投影，并通过 `message_end` 补充随后完成的消息。任务开始时固定该快照；同模型（provider、API 与模型 ID 均相同）且同名工具 schema 兼容时，后台请求原样保留父前缀，仅在末尾用户消息中追加工具限制与任务指令。声明保留的父会话扩展或 MCP 工具不会连接到执行器，调用会返回错误；同名文件工具仍由受限实现执行。

Schema 兼容性会递归比较完整 `parameters` 的 JSON 表示，忽略各层对象键的排列顺序，但仍要求值和数组顺序一致。比较不会改写请求中发送的父工具声明。

跨模型、没有捕获到父请求、Pi 开启图片阻止或同名工具 schema 不兼容时，使用独立系统提示词和受限工具声明。Extractor 显式设置整数 `recentMessages` 时也使用独立请求，以遵守消息上限。两种路径均启用 `cacheRetention: "short"`；复用路径使用父会话 ID，独立路径的每个任务使用自己的稳定 ID。完整父历史可能增加缓存未命中时的输入成本；实际缓存效果仍由 provider 决定。其他扩展在捕获钩子之后改写请求、宿主后续投影或 provider 参数差异也可能影响命中。

### 后台 Codemode 适配

如果后台任务启动时主会话启用了 `codemode`，extractor 和 dream 会通过 Pi 公开的 `createCodemodeExtension({ mode, inlineBudget, models: false })` 注册任务级 codemode 工具：

- 继承主会话的 `codemode.mode`（`on` 模式同时暴露六个基础工具和 `codemode`，`only` 模式只向模型暴露 `codemode`）和 `codemode.inlineBudget`。
- 脚本内只能调用当前任务的六个受限工具（`read`、`find`、`grep`、`write`、`edit`、`bash`），每次嵌套调用都会经过相同的项目信任、代次、路径、基线和文件锁检查。
- 使用独立的内存级 `SessionManager.inMemory()`，脚本内的 `store()` / `load()` 键值仅在本次后台任务生命周期内有效，绝不读写主会话 store，也不连接主会话的 MCP、其他扩展工具或 `models` 接口。

### 工作目录与批准读取根

- **统一的工作目录基准**：所有后台工具统一继承任务启动时父会话的 `ctx.cwd` 作为相对路径基准（当 `find` 或 `grep` 省略 `path` 时也从 `ctx.cwd` 开始搜索；`bash` 内的 `cd` 只在当次命令内生效）。规范化项目根目录（`projectRoot`）用于确定项目记忆身份，而 `ctx.cwd` 用于解析工具相对路径，使从仓库子目录或关联 worktree 启动会话时行为保持一致。写入 memory 文件时，模型应传入绝对路径或从 `ctx.cwd` 指向 memory 目录的相对路径（直接写 `"topic.md"` 会按 `ctx.cwd` 解析，若 `ctx.cwd` 不在 memory 目录内则会因越界被拒绝）。
- **角色读取范围差异**：
  - `extractor` 的批准读取根包含：`memoryDir`、`projectRoot`、`cwd` 和任务专属 `scratchDir`。同时，原始 session 目录被列入 `excludedReadRoots`，该排除规则优先于所有批准读取根（即使自定义 session 目录位于项目目录内部，extractor 的文件工具和 Bash 显式路径检查也会拒绝访问它）。
  - `dream` 的批准读取根包含：`memoryDir`、`projectRoot`、`cwd`、`sessionDir` 和任务专属 `scratchDir`。Dream 可以直接只读访问原始 session 目录，但任何写入操作依然只能落在 `memoryDir` 内。

### 受限 Bash 执行

后台 `bash` 命令按两条分支处理：

1. **删除分支（Simple Delete）**：仅当整条命令是简单的 `rm <paths...>` 或 `rm -f <paths...>`（允许 `--` 分隔符，拒绝 `--force` 等其他标志、通配符和相对路径）时，进入受控删除流程。目标路径必须是位于 `memoryDir` 内部、且不在受保护子目录（`.git`、`.hg`、`.svn`、`.bzr`、`.jj`、`.sl`、`.claude`、`.cargo`、`.devcontainer`、`.githooks`、`.husky`、`.idea`、`.mvn`、`.vscode`、`.yarn`、`agents`、`commands`、`config`、`head`、`hooks`、`node_modules`、`objects`、`refs`、`skills`）中的小写 `.md` 普通文件，并且当前任务已经对该文件建立了普通文本读取基线。
2. **只读执行分支（Read-Only Execute）**：
   - **AST 语法限制**：使用 `tree-sitter-bash` 解析命令。拒绝包含语法错误、后台运行符（`&`）、子 shell（`(...)`）、代码块（`{ ...; }`）、函数定义、命令替换（`$(...)` 或反引号）、进程替换、变量或算术展开、花括号展开以及 `if` / `for` / `while` / `case` 控制流的命令。如果命令中包含 `cd` 并与后续命令串联，只允许通过单纯的 `&&` 列表连接（拒绝管道中的 `cd` 或 `||` / `;` 混合连接），以保证静态路径推导的确定性。
   - **重定向与环境变量限制**：拒绝一切文件写入重定向和 `/dev/tcp`、`/dev/udp` 网络重定向（仅允许输入重定向、重定向到 `/dev/null` 或标准文件描述符复制如 `2>&1`）。命令内联环境变量只允许 `LANG`、`LC_*`、`TZ`、`NO_COLOR`、`RUST_BACKTRACE`、`NODE_ENV` 等安全展示/区域变量，严禁修改 `PATH`、`LD_*`、`DYLD_*`、`NODE_OPTIONS`、`BASH_ENV`、`SHELLOPTS` 或 `BASH_CMDS` 等特殊变量。
   - **命令与参数白名单**：只允许预定义的只读命令（如 `ls`、`cat`、`head`、`tail`、`wc`、`stat`、`find`、`grep`、`rg`、`fd`、`tree`、`du`、`df`、`sort`、`uniq`、`cut`、`tr`、`sed`、`jq`、`awk`、只读 `git` 子命令、只读 `gh` / `docker` 查询等）及其安全参数子集。例如，`find` 拒绝 `-exec` / `-delete` / `-fprint`；`sed` 拒绝 `w` / `e` / `r` 指令；`git` 拒绝 `-c`、`--exec`、`--ext-diff`、`--output` 等可执行或写文件选项，并在运行前扫描仓库 `.git/config`，若发现 `include`、`filter.*.clean/smudge/process`、`diff.*.command/textconv` 或 `gpg` 签名程序配置则拒绝执行。
   - **静态 `xargs` 检查**：分类器在执行前检查嵌套命令及其固定参数。对于动态输入可能引入执行程序或写入选项的命令，要求显式使用 `--`。标准输入展开、引号处理、占位符替换和命令调用均由原生 `xargs` 处理，扩展不在运行时检查或改写展开后的路径。显式路径在执行前检查；动态生成的路径和命令内部的递归读取没有操作系统沙箱边界。Bash 中的 grep 也不会被自动加入目录排除参数。独立的 `find` 和 `grep` 工具仍保留自身的文件访问检查。

## 写入安全、读取基线与并发控制

### 路径与内容净化

- 所有写入和删除操作都严格限制在规范化 `memoryDir` 内部的小写 `.md` 普通文件。如果目标已存在但为符号链接或非普通文件，或者任何一级父目录解析后逃出 `memoryDir`，操作都会立即报错中止。
- 持久化写入和注入上下文的记忆文本都会经过 `sanitizeMemoryText()` 处理：统一换行符为 `\n`，移除除 `\t`、`\n` 及四个合法连接/变体选择符（`U+200C`、`U+200D`、`U+FE0E`、`U+FE0F`）之外的控制字符、格式字符、私有区字符与默认忽略字符，并将保留的提示词标签（如 `<system-reminder>`、`<tool_use>`、`<function_results>` 等，含全角符号、西里尔字母、数学字母等 Unicode 同形异义混淆写法）的左尖括号转义为 `&lt;`。主 Agent 若直接尝试写入含上述危险字符或保留标签的内容，`tool_call` 钩子会直接拦截。

### 普通文本读取基线（Read Baseline）

后台子 Agent 在覆盖（`write`）、编辑（`edit`）或通过 `bash rm` 删除已存在的 memory 文件前，必须先在当前任务中通过 `read` 读取该文件以建立基线（新建不存在的文件无需基线）：

- **分页与截断规则**：对齐 Claude Code 的普通文本读取状态，显式传入合法 `offset` / `limit` 的分页读取只要未触发自动窗口截断，即可建立该文件的最新基线；如果读取结果被 2,000 行或 50 KiB 默认上限自动截断（`details.truncation` 为真），或者读取的是图片，则会清除该文件的基线，禁止基于不完整视图覆写文件。
- **基线比对与编辑恢复**：基线记录文件完整 UTF-8 内容的 SHA-256 哈希和字节大小（仅 `mtime` 改变但内容哈希与大小未变时仍视为同一基线）。执行 `write` 或 `rm` 时，若磁盘当前内容与基线不一致，操作会直接报错并要求重新读取。执行 `edit` 时，若文件在读取后被外部修改，只有在当前全部 `edits[]` 的 `oldText` 仍能在最新文件内容中精确唯一匹配并成功应用时，才允许完成编辑并在结果中标记 `staleRecovered: true` 及附加重读提醒；否则同样拒绝写入。

### 跨进程锁与原子发布

- **租约锁（Lock Lease）**：提取锁（`extract.lock`，超时 15 分钟）、整理锁（`dream.lock`，超时 60 分钟）、时间戳更新锁（`last-dream-at.lock`，超时 1 分钟）以及单文件写入锁（`locks/files/<sha256>.lock`，超时 15 分钟）均采用 `{ pid, token, acquiredAt }` JSON 格式并以 `wx` 独占模式创建。持有锁期间会定期刷新锁文件 `mtime` 心跳，并在关键步骤前校验 `token` 是否仍归属当前进程。当锁文件超过超时时间且原持有者 PID 已不存在时，其他进程会通过独立的 `.recover` 仲裁锁安全接管过期锁。
- **两阶段校验与原子替换**：单文件写入在取得文件级跨进程锁和进程内队列后，会先核对当前磁盘基线，随后将新内容写入同目录下的 `.tmp` 私有临时文件（权限 `0600`），在最终发布前再次核对代次、项目信任、父目录真实路径与磁盘基线未发生并发变化：新建文件使用 `link()` + `rm()` 实现不覆盖已有文件的独占发布（no-clobber），更新已有文件使用 `rename()` 原子替换目标文件。

## 不在范围内的功能

以下功能明确不在本扩展的设计与实现范围内：

- **BM25 本地检索**及无空格 CJK selector 分支。
- **服务端与跨范围记忆功能**：包括 Anthropic 账户记忆、团队或组织共享记忆（`CLAUDE_MEMORY_STORES`）、claude.ai Project memory、服务端向量 embedding、重排序（ranking）、云端同步以及 `memory_search` / `memory_list` / `memory_read` / `memory_write` 工具。
- **`AGENTS.md` 自动修改与技能目录维护**。
- **PDF（`.pdf`）与 Jupyter Notebook（`.ipynb`）文件读取**。
- **不受限制的后台 Shell、MCP 工具调用或子 Agent 派生**。
- **Pi 主会话的通用权限系统（deny/ask 规则评估与审批弹窗）**。
