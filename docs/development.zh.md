# 开发说明

本文面向维护和修改 Pi Project Memory 的开发者。关于扩展的安装、命令和日常使用，请先阅读项目根目录下的 [README](../README.zh.md) 与[配置参考](configuration.zh.md)。

## 开发环境

本项目使用 `pnpm` 管理依赖。Pi 运行时通过 `jiti` 直接加载 TypeScript 源码，因此不需要单独的编译打包步骤。

```bash
corepack enable
pnpm install
```

系统环境需要安装 `bash`、`git`、`rg`（ripgrep）和 `fd`。项目将 `@earendil-works/pi-agent-core`、`@earendil-works/pi-ai`、`@earendil-works/pi-coding-agent` 和 `typebox` 声明在 `peerDependencies`（版本范围保持 `*`），并在 `devDependencies` 中安装用于本地开发与测试的具体版本。请勿将 Pi 宿主核心包放入运行时 `dependencies`。

## 常用校验与测试命令

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm check
```

其中 `pnpm check` 是完整门禁命令，会依次执行：

1. `biome check . --error-on-warnings`（检查 TypeScript 与 JSON 的格式和代码规范）
2. `markdownlint-cli2 "**/*.md"`（检查 Markdown 规范）
3. `prettier --check "**/*.md"`（检查 Markdown 格式）
4. `pnpm typecheck`（运行 `tsc --noEmit` 类型检查）
5. `pnpm test`（使用 Node.js 内置测试运行器执行 `tests/*.test.ts`）

如需自动格式化或修复代码：

```bash
pnpm format
pnpm lint:fix
```

注意：`docs/research/**` 目录下的研究文档受版本证据约束，日常修改非研究文档时，请只对目标 Markdown 文件单独运行 `prettier --write` 与 `markdownlint-cli2`，不要改动 `docs/research/` 下的任何文件。

## 本地手动加载与调试

在仓库根目录下直接加载当前工作区扩展启动 Pi：

```bash
pi --extension ./index.ts
```

在离线模式下快速验证扩展入口能否正常初始化：

```bash
PI_OFFLINE=1 pi --no-extensions --extension ./index.ts --list-models __no_such_model__
```

该命令应当正常加载 `index.ts` 且不抛出扩展初始化错误，最后仅提示未找到匹配的模型。

## 代码结构

| 路径                           | 职责说明                                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------------------- |
| `index.ts`                     | 扩展入口：注册 Pi 生命周期钩子、`/memory` 命令、预取与维护调度器及运行时状态机。                  |
| `src/config.ts`                | 默认配置（`DEFAULT_CONFIG`）、字段范围校验与 `~/.pi/agent/project-memory/config.json` 加载。      |
| `src/models.ts`                | 角色模型解析、selector 原生结构化输出与工具模式降级、消息重放签名清理及后台子 Agent 循环。        |
| `src/prompts.ts`               | 主 Agent、selector、extractor、dream 提示词组装，以及索引、取回消息和过期提醒渲染。               |
| `src/store.ts`                 | `MEMORY.md` 裁剪与自动补建、topic 扫描与取回、写后 lint、读取基线、原子写入、跨进程锁与会话扫描。 |
| `src/child-codemode.ts`        | 后台任务级 codemode 扩展封装、工具说明提示词生成与任务内独立内存 store。                          |
| `src/child-tools.ts`           | 基于 Pi 原生工具工厂封装的后台六工具（`read`、`find`、`grep`、`write`、`edit`、`bash`）。         |
| `src/native-search.ts`         | 启动独立子进程执行原生 `find` / `grep` 搜索，并限制输出大小与超时清理。                           |
| `src/native-search-worker.mjs` | 子进程搜索入口：固定干净环境、禁用 ripgrep 外部配置与符号链接跟随，并注入排除目录规则。           |
| `src/bash-readonly.ts`         | 基于 `tree-sitter-bash` 的只读 Shell 命令 AST 分析器与各命令选项白名单分类。                      |
| `src/restricted-bash.ts`       | 后台 `bash` 策略：解析 `rm` 删除命令、校验读取路径意图、检查 `.git/config` 并构建受控 `PATH`。    |
| `src/paths.ts`                 | 规范化项目根路径（含 Git worktree 归属）、项目 Key、防碰撞命名空间预留与安全路径工具函数。        |
| `src/sanitize.ts`              | 换行符归一化、危险控制/格式/不可见字符清理，以及保留提示词标签（含同形异义字符）转义。            |
| `src/types.ts`                 | 扩展内部共享的 TypeScript 接口与类型定义。                                                        |

## 自动化测试覆盖范围

`tests/` 目录按模块划分单元测试与集成测试，全程使用本地临时目录与 Faux provider，不发送外部付费网络请求：

- `tests/config.test.ts`：测试独立角色模型配置、默认值、非法数值回退、`config.example.json` 与 `DEFAULT_CONFIG` 的一致性，以及 `package.json` 的平台声明（`darwin`、`linux`）。
- `tests/prompts.test.ts`：逐字比对 `mainMemoryPrompt`、`SELECTOR_SYSTEM_PROMPT`、`extractionPrompt`、`dreamPrompt` 与 `tests/fixtures/prompts/*.txt` 基线文件；验证取回消息头、过期提醒、预算计费内容以及 Unicode / 混淆标签净化。
- `tests/models.test.ts`：测试 selector 输出解析、各 API 协议的原生 JSON Schema payload 转换、客户端格式错误的同模型 `select_memories` 工具降级、认证/限流/5xx/长度截断等不可重试错误的拦截、查询历史保持、同模型 `thinking` 保留与跨模型签名剥离、后台子 Agent 的 `ctx.cwd` 传递与 `maxTurns` 边界。
- `tests/paths.test.ts`：测试 VCS 目录段识别、`autoMemoryDirectory` 合法性与回退、共享 `memory-roots` 锁与整理状态、命名空间符号链接拒绝、并发 `.project-root` 预留、项目 Key 冲突消歧以及 Git worktree 共用主检出身份。
- `tests/store.test.ts`：测试路径简写归一化、`MEMORY.md` 200 行 / 25,000 UTF-16 代码单元裁剪与 80% 自动补建、低文件描述符限制下的 16 并发扫描、4,096 字节完整 UTF-8 行取回、兼容旧版扁平 frontmatter、硬链接安全的原子替换、读取基线 CAS 冲突检测、共享整理状态迁移与跨进程锁租约。
- `tests/child-tools.test.ts`：验证后台六工具的 Pi 原生名称与 schema、继承父会话 `ctx.cwd`、显式分页读取建立基线而自动截断或图片读取撤销基线、拒绝 `.pdf` 与 `.ipynb`、`edit` 的多处修改与 `staleRecovered` 恢复、批准读取根与 session 目录排除，以及 `bash rm` 的基线与受保护子目录限制。
- `tests/child-codemode.test.ts`：验证后台任务在 `on` 与 `only` 模式下封装 Pi 原生 `codemode`、仅暴露六个受限工具、隔离任务内 `store()` / `load()`、溢出输出文件重定位与清理，以及脚本执行中途代次失效或中止时的即时拦截。
- `tests/bash-readonly.test.ts` 与 `tests/search-boundaries.test.ts`：验证 `tree-sitter-bash` 只读命令与参数分类、危险 Git 配置拦截、静态校验后的原生 `xargs` 执行、忽略宿主 `RIPGREP_CONFIG_PATH` 的 `--follow` 设置，以及 dream 对原始 session 目录的只读访问。
- `tests/concurrency.test.ts`：通过多子进程 worker（`lock-worker.ts`、`cas-worker.ts`）验证跨进程锁互斥、死进程锁恢复、dream 时间戳 CAS 与文件并发编辑 CAS。
- `tests/lifecycle.test.ts`：端到端验证 Pi 钩子生命周期，包括项目信任门控、`enabled: false` 延迟初始化、2 秒预取等待与延迟 `steer` 送达、普通与排队输入的空白门槛、图片归一化去重、完整读取抑制与分支恢复、满 48 小时过期提醒、写后 lint、主 Agent 直接写入去重、三词用户正文门槛、新输入触发 `trailingExtraction`、会话压缩前提取与状态重置、dream 尝试时间保留与异常回滚，以及进程内后台 usage 累计。

缓存回归覆盖索引快照及刷新边界、完整 selector 目录的已读过滤、短期缓存与稳定会话缓存标识、同模型父前缀及 Faux 缓存命中、声明保留但不能执行的父工具、受限写入，以及跨模型、schema 不兼容、整数消息上限和图片阻止时的独立请求回退。Faux 命中只验证请求复用机制，不代表真实 provider 的命中率或账单。

如果修改了 provider 请求参数构造或 Pi SDK 集成接口，除了运行 `pnpm check` 外，还应在配置了真实模型凭据的环境中做端到端手动验证。

## 长期架构与维护约束

以下规则是本项目的长期设计边界，修改代码或文档时必须遵守：

1. **聚焦本地私有文件模式对齐**：项目优先对齐 Claude Code 2.1.296 的本地项目记忆文件格式、索引与取回窗口、selector、回合后提取、定期 dream 整理及生命周期。明确不实现 BM25，也不实现任何依赖服务端 memory API 的功能（包括账户记忆、团队或组织共享存储、`claude.ai` Project memory、服务端同步、embedding、ranking 和 `memory_search`）。切勿通过隐藏开关或可选依赖引入这些能力，也不要把局部相似夸大为完整产品兼容。
2. **保持主会话工具原样，后台复用 Pi 原生工具工厂**：严禁注册或覆盖主会话的同名内置工具。后台子 Agent 固定使用 Pi 原生名称与 schema 的 `read`、`find`、`grep`、`write`、`edit` 和 `bash`（以及主会话开启 `codemode` 时的任务内原生 `codemode`，通过公开的 `createCodemodeExtension()` 接入，不深层导入 Pi 内部私有模块）。不要增加独立的 `Delete` 工具或不受限制的 Shell。
3. **坚持应用层边界与并发正确性，不夸大为操作系统沙箱**：Pi 原生工具的 `cwd` 不是安全边界。后台工具外层必须保留项目信任、批准读取根目录、memory 目录小写 `.md` 写入包含、符号链接拒绝、普通文本读取基线、代次检查、跨进程锁与原子替换。受限 `bash` 必须保留 AST 分类、命令参数白名单、原生执行前的显式路径检查与独立子进程搜索排除规则（严禁通过临时篡改主进程 `process.env` 来限制搜索）。这些机制用于限定后台工具能力与保证并发安全，不得在文档中描述为抵抗同用户恶意进程的完整 OS 级沙箱。
4. **严格保护静态提示词基线与 `docs/research/` 边界**：
   - `docs/research/` 只记录 Claude Code 2.1.296 二进制的逆向结论、原始提示词、工具定义与证据，必须保留 `Claude Code` 原名与原文，不得混入 Pi 的实现或适配说明。
   - 运行时四份核心提示词（主记忆、selector、extractor、dream）的静态文本必须与 `tests/fixtures/prompts/*.txt` 保持一致，只允许四类替换（`CLAUDE.md` 改为 `AGENTS.md`、Pi 工具与字段名替换、删除不支持功能的专属段落、`Claude Code` 改为 `the agent`）以及 selector 工具模式末尾的固定 `select_memories` 调用指令。后台工具列表与 codemode 说明通过独立的 `backgroundToolPrompt()` 追加：独立请求放在系统提示词末尾，复用父前缀时放在末尾任务消息中；不得通过篡改 Claude 派生提示词基线来容纳宿主适配。
5. **保持配置、依赖与测试同步**：
   - `config.example.json` 解析后的配置值必须与 `src/config.ts` 中的 `DEFAULT_CONFIG` 保持一致。
   - `enabled: false` 必须在解析项目路径和创建目录之前生效。
   - 依赖版本使用 `^`（caret range），`peerDependencies` 保持 `*`。需要执行安装构建脚本的依赖必须在 `pnpm-workspace.yaml` 的 `allowBuilds` 中按包名显式列出，不得全局放开。
   - 任何运行时行为变更都必须在同一提交中同步更新自动化测试与面向用户或维护者的文档。

## 发布前检查

本项目在 GitHub 上的仓库为 `XYenon/pi-project-memory`，在 npm 上的包名为 `pi-project-memory`。在手动执行发布前，请确认工作区干净并运行：

```bash
pnpm check
pnpm pack --dry-run
```

核对 `pnpm pack --dry-run` 输出的文件列表（应包含 `index.ts`、`src/`、`docs/`、`config.example.json`、`LICENSE` 和 `package.json`）、版本号与许可证信息无误后再执行发布。
