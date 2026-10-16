# Pi Project Memory

[English](README.md) | 简体中文

Pi Project Memory 是 Pi 的项目自动记忆扩展。它把每个项目的长期背景、用户偏好、关键决策和外部资源入口保存为本地 Markdown 文件，并在后续对话中自动挑选相关内容提供给模型，减少每次新会话都要重新解释项目上下文的工作。

本扩展参考 Claude Code 2.1.296 的本地文件模式自动记忆，使用 `MEMORY.md` 索引文件和按主题拆分的 Markdown 文件来管理项目记忆。所有记忆文件都保存在本地，你可以随时用普通文本编辑器查看、修改或删除。

## 日常工作方式

- **自动取回相关记忆**：主模型使用会话内固定的精简 `MEMORY.md` 索引快照，后台 selector 根据每次提问最多挑选 5 个相关主题文件（topic）注入当前对话。索引改动通过追加过期提醒通知模型，避免反复改写提示词前缀；会话压缩、切换分支、重载配置或启动会话后重新加载快照。
- **回合后自动提取**：每完成一轮对话（或空闲满 2 分钟），后台 extractor 会自动检查刚结束的对话，把值得长期保留的信息写入或更新到记忆目录。会话压缩或退出前也会自动处理尚未提取的对话。
- **定期自动整理（Dream）**：当距离上次整理尝试满 24 小时，且期间至少有 5 个其他会话更新过时，后台 dream 会在空闲时自动整理记忆文件，合并重复内容、清理过时信息并精简索引。
- **支持直接读写与口头指令**：你可以直接在对话中让主模型记住某条规则或忘掉某条旧记录，主模型会立即更新记忆文件；你也可以直接用外部编辑器修改记忆目录下的 `.md` 文件，扩展会自动感知外部改动。

关于底层钩子机制、安全协议和与 Claude Code 2.1.296 的详细对比，请参见[设计与安全边界](docs/design-and-security.zh.md)与 [Claude Code 行为对齐说明](docs/claude-code-compatibility.zh.md)。

## 快速开始

### 1. 环境要求与安装

本扩展支持 macOS、Linux 和 Android 上的 Termux，运行环境需要安装 `bash`、`git`、`rg`（ripgrep）和 `fd`。

推荐从 npm 安装：

```bash
pi install npm:pi-project-memory
```

Termux 用户还需完成[原生依赖的手动编译](#在-termux-中安装)。其他安装方式见下文[安装与管理](#安装与管理)。

### 2. 启动并检查状态

进入一个已在 Pi 中受信任的项目目录并启动 Pi，然后运行：

```text
/memory status
```

命令会显示当前项目路径、记忆目录位置、已有主题数量、三个后台任务（selector、extractor、dream）的模型配置以及累计用量。确认状态正常后即可像平时一样对话。

如果想立即将当前对话中的信息提取为记忆，可以随时运行 `/memory extract`。

## 安装与管理

### 从 npm 安装

```bash
pi install npm:pi-project-memory
```

### 在 Termux 中安装

首先，安装所需工具和扩展。

```bash
pkg install nodejs-lts bash git ripgrep fd python make clang
pi install npm:pi-project-memory
```

接着，使用 npm 12 或更高版本时，放行安装脚本。旧版 npm 可跳过此命令。

```bash
npm --prefix ~/.pi/agent/npm install-scripts approve tree-sitter tree-sitter-bash
```

最后，手动编译依赖。

```bash
GYP_DEFINES="android_ndk_path=''" npm --prefix ~/.pi/agent/npm rebuild \
  tree-sitter tree-sitter-bash --ignore-scripts=false --foreground-scripts
```

### 从 GitHub 安装

```bash
pi install git:github.com/XYenon/pi-project-memory
```

### 从本地源码安装

```bash
git clone https://github.com/XYenon/pi-project-memory.git
cd pi-project-memory
pnpm install
pi install .
```

### 单次试用与日常包管理

- 单次加载试用（不写入 Pi 配置）：`pi -e npm:pi-project-memory`
- 查看已安装的包：`pi list`
- 更新已安装的扩展：`pi update --extensions`
- 卸载扩展：`pi remove <source>`（`<source>` 与安装时使用的来源写法一致）

## 命令参考

| 命令                    | 用途                                                                                                                    |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `/memory status`        | 查看当前项目路径、记忆目录、主题数量、三个后台任务的模型与参数状态、自动开关、当前分支取回用量及累计后台 token 与费用。 |
| `/memory list`          | 列出当前项目的所有记忆主题（包含类型、相对路径和单行描述）。                                                            |
| `/memory extract`       | 立即运行一次记忆提取，处理尚未提取的对话内容（即使配置中关闭了自动提取也可手动运行）。                                  |
| `/memory dream`         | 立即运行一次记忆整理与合并。跳过间隔时间和会话数量条件，但仍要求配置中 `dream.enabled` 为 `true`。                      |
| `/memory reload-config` | 重新加载用户级配置文件。模型、提取和整理参数立即生效；`autoMemoryDirectory` 目录路径变更需在下次启动会话时生效。        |

直接运行 `/memory` 等同于 `/memory status`。输入未知子命令时会提示可用命令列表。

## 常见配置入口

用户级配置文件位于：

```text
~/.pi/agent/project-memory/config.json
```

如果该文件不存在，扩展会使用内置默认值。你可以从仓库中的 `config.example.json` 复制生成初始配置：

```bash
mkdir -p ~/.pi/agent/project-memory
cp config.example.json ~/.pi/agent/project-memory/config.json
```

最常用的配置项如下：

- `enabled`：扩展总开关（默认 `true`）。设为 `false` 时完全停用扩展，不创建记忆目录，也不发起任何后台模型调用。
- `autoMemoryDirectory`：自定义记忆文件的保存目录（默认 `null`，支持绝对路径或 `~/` 开头的路径）。只能从用户级配置文件设置，项目仓库内的文件无法覆盖它。
- `models.selector`、`models.extractor`、`models.dream`：分别为挑选、提取和整理三个后台任务指定模型（`model`）、思考档位（`thinkingLevel`）和最大输出长度（`maxTokens`）。
- `extraction`：调整自动提取开关（`enabled`）、每隔多少轮提取一次（`everyNTurns`，默认 `1`）以及空闲触发秒数（`idleFlushSeconds`，默认 `120`）。
- `dream`：调整定期整理开关（`enabled`）、最短间隔小时数（`minimumHours`，默认 `24`）以及需要累积的其他会话数（`minimumOtherSessions`，默认 `5`）。

修改配置后，运行 `/memory reload-config` 或重启 Pi 即可。所有字段的类型、取值范围、逐字段回退规则和配置示例请查阅[配置参考](docs/configuration.zh.md)。

## 数据存储与可直接编辑的文件

默认情况下，扩展将数据保存在 `~/.pi/agent/project-memory/` 下，每个项目拥有独立的记忆目录：

```text
~/.pi/agent/project-memory/
├── config.json
├── projects/
│   └── <project-key>/
│       └── memory/
│           ├── MEMORY.md
│           └── *.md
└── memory-roots/
    └── <memory-root-hash>/
        ├── state.json
        └── locks/
```

- **同一仓库与 Worktree 共享记忆**：Git 仓库按主检出目录区分项目，使用 `git worktree` 创建的关联工作树会自动共享同一份项目记忆。
- **可直接查看和编辑**：`memory/` 目录下的 `MEMORY.md` 是简短索引，其他 `.md` 文件保存具体的主题记忆。你可以随时用编辑器查看、修改、新增或删除这些 `.md` 文件。
- **切勿手动修改内部状态文件**：除 `config.json` 和 `memory/*.md` 外，其余如 `.project-root`、`state.json` 和 `locks/` 均为扩展内部协调文件，请勿手动编辑。

完整的目录树、自定义目录影响、状态文件用途和文件生命周期说明请参见[配置参考中的存储路径与目录结构说明](docs/configuration.zh.md#存储路径与目录结构)。

## 模型费用、隐私与安全摘要

- **模型选择与费用**：三个后台任务的模型默认均为 `"inherit"`（跟随当前 Pi 主会话模型），也可单独指定为 `"provider/model-id"`。当显式指定的模型不存在或未配置凭据时，对应任务会发出 warning 通知并跳过，不会私自切换到其他模型。后台调用会按所选 provider 的标准正常计费，但不会写入主会话的聊天账单记录；你可以通过 `/memory status` 查看当前进程累计的后台 token 与费用（重启 Pi 后清零）。
- **提示词缓存**：后台请求启用 Pi 的短期缓存。Selector 保持完整目录前缀，在选择后过滤已读文件；同模型的 extractor / dream 在有父请求快照时保留其系统消息、工具声明与完整历史，仅追加任务指令。实际命中和费用取决于 provider、缓存有效期与最小长度，不能保证每次命中。
- **项目信任保护**：扩展只在 Pi 已信任的项目中运行。对未受信任的项目，扩展不会创建目录、读取文件或调用模型。
- **发送给模型的数据**：
  - `selector` 只接收你的当前提问和已有记忆文件的摘要列表（文件名、类型、修改时间和一行描述），不会上传全部记忆正文。
  - `extractor` 默认可接收完整父请求历史以复用缓存，但提取目标仍是游标之后的未处理消息；跨模型、缺少可复用快照等情况下仅发送未处理消息。显式设置 `extraction.recentMessages` 为整数时禁用完整父前缀复用，遵守该消息上限。
  - `dream` 在整理时会读取记忆目录、当前项目文件以及该项目的历史会话记录（JSONL），用来核对事实和提炼长期信息。
  - 以上数据会发送给你所配置的模型 provider，请根据项目敏感程度选择合适的 provider 和模型。
- **后台写入限制**：后台任务只能创建、修改或删除当前项目记忆目录下的 `.md` 文件，不能修改你的项目源码、`AGENTS.md` 或历史会话文件。详细安全边界请阅读[设计与安全边界](docs/design-and-security.zh.md)。

## 使用限制与注意事项

- **中英文空格触发门槛**：为了对齐 Claude Code 2.1.296 的触发规则，自动取回和自动提取都按空白字符判断输入长度：
  - **自动取回（Selector）**：提问文本去掉首尾空白后，中间必须包含至少一个空格、换行或制表符。单个英文单词或**整句不含空格的纯中文输入**不会触发自动取回。
  - **自动提取（Extractor）**：未提取的用户消息中，必须至少有一段文本按空白字符拆分后达到 3 个词（即至少包含两处空格或换行）。**完全不含空格的纯中文短句**不会触发自动提取（手动运行 `/memory extract` 同样受此三词条件限制）。如果你习惯输入不带空格的中文，可以直接在对话中让主模型保存记忆，或在句子中加入空格。
- **记忆文件大小与预算限制**：`MEMORY.md` 索引最多加载前 200 行（约 25,000 个字符）；单个主题文件在自动取回时最多读取前 200 行或 4,096 字节，因此建议每个主题文件只记录一项独立事实并保持简短。单个会话分支累计自动取回达到 61,440 个字符后，会在该分支停止自动取回（会话压缩或开启新会话后会重置）。
- **主模型已完整读取的文件不重复取回**：如果主模型已经在当前对话中完整读取过某个记忆文件，扩展不会再重复自动取回它；修改时间满 48 小时的旧记忆在读取或取回时会自动提示模型先核对当前代码。
- **不支持的功能**：本扩展仅实现本地项目文件记忆，不提供 BM25 本地搜索，不支持读取 PDF（`.pdf`）或 Jupyter Notebook（`.ipynb`），也不包含任何 Claude 云端账户记忆、团队共享存储（`CLAUDE_MEMORY_STORES`）、`claude.ai` Project memory 或 `memory_search` 等服务端功能。

## 常见问题排查

### 提示项目未受信任（Project is not trusted）

请先在 Pi 中信任当前项目目录，然后重启会话。未受信任的项目不会启用记忆功能。

### 提示配置的模型不可用或缺少凭据

请检查 `~/.pi/agent/project-memory/config.json` 中的 `model` 是否为 `"inherit"` 或正确的 `"provider/model-id"` 格式，并确认已在 Pi 中为该 provider 配置好 API 凭据。

### 对话后没有自动生成记忆文件

1. 运行 `/memory status`，检查 `Auto-memory` 和 `Extraction` 是否都显示为 `enabled`。
2. 检查你的输入是否包含足够的空格（按空白拆分至少 3 个词），并且主模型没有在本轮对话中直接调用文件工具写过记忆文件（若主模型已直接写过记忆，后台会自动跳过重复提取）。
3. 运行 `/memory extract` 手动触发提取，并查看 Pi 是否有模型错误或文件权限方面的 warning 通知。

### 修改配置文件后没有生效

保存配置后请运行 `/memory reload-config` 或重启 Pi。注意：如果修改了 `autoMemoryDirectory`，必须启动新的 Pi 会话才会切换到新目录，且扩展不会自动搬移旧目录中的文件。

## 文档导航

- [配置参考与存储结构](docs/configuration.zh.md)：配置文件位置、逐字段回退规则、全部字段详解、配置示例以及完整的本地存储目录结构与文件生命周期。
- [设计与安全边界](docs/design-and-security.zh.md)：威胁模型、生命周期与钩子流程、后台工具权限控制、读取基线与跨进程并发锁设计。
- [Claude Code 行为对齐说明](docs/claude-code-compatibility.zh.md)：与 Claude Code 2.1.296 的对齐范围、静态逆向依据、提示词基线规则与宿主适配取舍。
- [开发说明](docs/development.zh.md)：本地开发环境、检查与测试命令、源码模块职责及长期维护约束。

## 许可证

本项目基于 [GNU Affero General Public License v3.0 or later](LICENSE) 许可发布。

Copyright (C) 2026 XYenon
