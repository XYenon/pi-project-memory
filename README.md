# Pi Project Memory

English | [简体中文](README.zh.md)

Pi Project Memory is an auto-memory extension for Pi. It saves each project's long-term background, user preferences, key decisions, and entry points to external resources as local Markdown files. In later conversations, it picks the relevant content and gives it to the model. This saves you from explaining the project context again in every new session.

This extension follows the local file mode auto-memory of Claude Code 2.1.296. It manages memory with a `MEMORY.md` index file and Markdown files split by topic. All memory files are stored locally. You can view, edit, or delete them at any time with any plain text editor.

## Daily workflow

- **Automatic recall of relevant memory**: The main model uses a stable snapshot of the short `MEMORY.md` index for the session. A background selector picks up to 5 relevant topic files for each question and adds them to the conversation. Index changes append a staleness notice to preserve the prompt prefix. Compaction, branch navigation, configuration reload, and session start refresh the snapshot.
- **Automatic extraction after each turn**: After each conversation turn, or after 2 minutes of idle time, a background extractor checks the conversation that just ended. It writes or updates information that is worth keeping long term in the memory directory. Extraction also runs automatically for any unprocessed conversation before the session is compacted or exits.
- **Periodic automatic consolidation (Dream)**: When at least 24 hours have passed since the last consolidation attempt, and at least 5 other sessions have been updated during that time, a background Dream task consolidates the memory files while the system is idle. It merges duplicate content, removes outdated information, and trims the index.
- **Direct reading and writing, and spoken instructions**: You can ask the main model in the conversation to remember a rule or forget an old record. The main model then updates the memory files right away. You can also edit the `.md` files in the memory directory with an external editor. The extension detects those external changes automatically.

For the underlying hook mechanism, the security protocol, and a detailed comparison with Claude Code 2.1.296, see [Design and security boundaries](docs/design-and-security.md) and [Claude Code behavior alignment](docs/claude-code-compatibility.md).

## Quick start

### 1. Requirements and installation

This extension supports macOS, Linux, and Android through Termux. Your system needs `bash`, `git`, `rg` (ripgrep), and `fd` installed.

The recommended way to install is from npm:

```bash
pi install npm:pi-project-memory
```

On Termux, also complete the [manual native dependency build](#install-on-termux). For other installation methods, see [Installation and management](#installation-and-management) below.

### 2. Start and check status

Enter a project directory that you have already trusted in Pi, start Pi, and run:

```text
/memory status
```

The command shows the current project path, the memory directory location, the number of topics, the model settings for the three background tasks (selector, extractor, and dream), and the cumulative usage. If the status looks correct, chat as usual.

To extract information from the current conversation into memory right away, run `/memory extract` at any time.

## Installation and management

### Install from npm

```bash
pi install npm:pi-project-memory
```

### Install on Termux

First, install the required tools and the extension.

```bash
pkg install nodejs-lts bash git ripgrep fd python make clang
pi install npm:pi-project-memory
```

Next, approve the installation scripts on npm 12 or later. Skip this command on older npm versions.

```bash
npm --prefix ~/.pi/agent/npm install-scripts approve tree-sitter tree-sitter-bash
```

Finally, manually compile the dependencies.

```bash
GYP_DEFINES="android_ndk_path=''" npm --prefix ~/.pi/agent/npm rebuild \
  tree-sitter tree-sitter-bash --ignore-scripts=false --foreground-scripts
```

### Install from GitHub

```bash
pi install git:github.com/XYenon/pi-project-memory
```

### Install from local source

```bash
git clone https://github.com/XYenon/pi-project-memory.git
cd pi-project-memory
pnpm install
pi install .
```

### One-off trial and everyday package management

- Load the extension once without writing to the Pi configuration: `pi -e npm:pi-project-memory`
- List installed packages: `pi list`
- Update installed extensions: `pi update --extensions`
- Uninstall the extension: `pi remove <source>` (`<source>` uses the same source form that you used to install it)

## Command reference

| Command                 | Purpose                                                                                                                                                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/memory status`        | Shows the current project path, memory directory, topic count, model and parameter status for the three background tasks, the auto switch, recall usage for the current branch, and the cumulative background tokens and cost. |
| `/memory list`          | Lists all memory topics in the current project, with type, relative path, and one-line description.                                                                                                                            |
| `/memory extract`       | Runs memory extraction once right away. It processes conversation that has not been extracted yet. You can run it by hand even when automatic extraction is off in the configuration.                                          |
| `/memory dream`         | Runs memory consolidation and merging once right away. It skips the time interval and session count conditions, but it still requires `dream.enabled` to be `true` in the configuration.                                       |
| `/memory reload-config` | Reloads the user-level config file. Changes to the model, extraction, and consolidation settings take effect right away. A change to the `autoMemoryDirectory` path takes effect at the next session start.                    |

Running `/memory` alone is the same as `/memory status`. If you enter an unknown subcommand, Pi shows the list of available commands.

## Common configuration entry points

The user-level config file is at:

```text
~/.pi/agent/project-memory/config.json
```

If this file does not exist, the extension uses its built-in defaults. You can create the initial config by copying `config.example.json` from the repository:

```bash
mkdir -p ~/.pi/agent/project-memory
cp config.example.json ~/.pi/agent/project-memory/config.json
```

The most common settings are listed below:

- `enabled`: The master switch for the extension (default `true`). When it is `false`, the extension is fully disabled. It does not create the memory directory and does not start any background model call.
- `autoMemoryDirectory`: The directory where memory files are saved (default `null`). It accepts an absolute path or a path that starts with `~/`. You can set it only in the user-level config file. A file inside the project repository cannot override it.
- `models.selector`, `models.extractor`, and `models.dream`: Each sets the model (`model`), thinking level (`thinkingLevel`), and maximum output length (`maxTokens`) for one of the three background tasks: selection, extraction, and consolidation.
- `extraction`: Controls the automatic extraction switch (`enabled`), how many turns pass between extractions (`everyNTurns`, default `1`), and the number of idle seconds that trigger extraction (`idleFlushSeconds`, default `120`).
- `dream`: Controls the periodic consolidation switch (`enabled`), the minimum number of hours between runs (`minimumHours`, default `24`), and the number of other sessions that must accumulate (`minimumOtherSessions`, default `5`).

After you change the config, run `/memory reload-config` or restart Pi. For the type, allowed range, field-by-field fallback rules, and examples of every field, see the [configuration reference](docs/configuration.md).

## Data storage and directly editable files

By default, the extension stores data under `~/.pi/agent/project-memory/`. Each project has its own memory directory:

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

- **The same repository and worktrees share memory**: The extension identifies a project by its main Git checkout. Linked working trees created with `git worktree` automatically share the same project memory.
- **You can view and edit the files directly**: `MEMORY.md` in the `memory/` directory is a short index. The other `.md` files store the individual topic memories. You can view, edit, add, or delete these `.md` files with an editor at any time.
- **Do not edit the internal state files by hand**: Apart from `config.json` and `memory/*.md`, the other files, such as `.project-root`, `state.json`, and `locks/`, are internal coordination files for the extension. Do not edit them by hand.

For the full directory tree, the effect of a custom directory, the purpose of each state file, and the file lifecycle, see the [storage paths and directory structure section of the configuration reference](docs/configuration.md#storage-paths-and-directory-structure).

## Model costs, privacy, and security summary

- **Model choice and cost**: All three background tasks use `"inherit"` by default. This means they use the model of the current Pi main session. You can also set each task to a specific `"provider/model-id"`. If the model you set does not exist or has no credentials, that task sends a warning notification and is skipped. The extension does not switch to another model on its own. Background calls are billed normally by the selected provider. They are not written to the main session's chat billing record. Run `/memory status` to see the background tokens and cost accumulated in the current process. They reset to zero when you restart Pi.
- **Prompt caching**: Background requests enable Pi's short cache retention. The selector keeps the full catalog prefix and filters already-read files after selection. With a parent request snapshot and the same model, extraction and dream keep the parent's system messages, tool declarations, and full history, then append task instructions. Actual hits and costs depend on the provider, cache lifetime, and minimum length; a hit is not guaranteed.
- **Project trust protection**: The extension runs only in projects that Pi trusts. In an untrusted project, the extension does not create directories, read files, or call models.
- **Data sent to models**:
  - `selector` receives only your current question and a summary list of the existing memory files (file name, type, modification time, and one-line description). It does not upload the full text of every memory file.
  - By default, `extractor` can receive the full parent request history for cache reuse, while targeting only unprocessed messages after the cursor. Across models or without a reusable snapshot, it receives only the unprocessed messages. Setting `extraction.recentMessages` to an integer disables full parent prefix reuse and respects that message limit.
  - When `dream` consolidates memory, it reads the memory directory, the current project files, and the historical session records of the project (JSONL). It uses them to check facts and extract long-term information.
  - All of this data goes to the model provider that you configured. Choose a provider and model that suit how sensitive your project is.
- **Limits on background writes**: Background tasks can create, change, or delete `.md` files only in the current project's memory directory. They cannot change your project source code, `AGENTS.md`, or historical session files. For the full security boundaries, read [Design and security boundaries](docs/design-and-security.md).

## Limits and caveats

- **Whitespace threshold for Chinese and English input**: To match the trigger rules of Claude Code 2.1.296, both automatic recall and automatic extraction check the input length by whitespace characters:
  - **Automatic recall (Selector)**: After you trim the leading and trailing whitespace from your question, the question must contain at least one space, line break, or tab in the middle. A single English word, or **Chinese input with no spaces at all**, does not trigger automatic recall.
  - **Automatic extraction (Extractor)**: The unprocessed user messages must contain at least one passage that has 3 words after splitting by whitespace. That is, it must contain at least two spaces or line breaks. **A short Chinese sentence with no spaces at all** does not trigger automatic extraction. Running `/memory extract` by hand is also subject to this three-word rule. If you usually type Chinese without spaces, ask the main model to save the memory directly in the conversation, or add spaces to the sentence.
- **Memory file size and budget limits**: The `MEMORY.md` index loads at most its first 200 lines (about 25,000 characters). When topic files are recalled automatically, each one is read for at most its first 200 lines or 4,096 bytes. So keep each topic file short, and record only one independent fact in each file. When the automatic recall for one session branch reaches 61,440 characters, automatic recall stops on that branch. Compacting the session or starting a new session resets the count.
- **Files the main model has fully read are not recalled again**: If the main model has fully read a memory file in the current conversation, the extension does not recall that file again. A memory file last modified 48 hours or more ago triggers a reminder that the model should check the current code before it relies on the file. The reminder appears when the file is read or recalled.
- **Unsupported features**: This extension implements only local project file memory. It does not provide BM25 local search. It does not read PDF (`.pdf`) or Jupyter Notebook (`.ipynb`) files. It also has no Claude cloud account memory, no team shared storage (`CLAUDE_MEMORY_STORES`), no `claude.ai` Project memory, and no server-side features such as `memory_search`.

## Troubleshooting

### Project is not trusted

Trust the current project directory in Pi first, and then restart the session. Memory is not enabled in an untrusted project.

### Configured model is unavailable or missing credentials

Check that the `model` in `~/.pi/agent/project-memory/config.json` is `"inherit"` or a valid `"provider/model-id"`. Also confirm that you have configured the API credentials for that provider in Pi.

### No memory files generated after a conversation

1. Run `/memory status` and check that `Auto-memory` and `Extraction` both show `enabled`.
2. Check that your input has enough spaces (at least 3 words when split by whitespace). Also check that the main model did not write a memory file directly with a file tool during this turn. If the main model already wrote memory directly, the background task skips the duplicate extraction.
3. Run `/memory extract` to start extraction by hand. Then check whether Pi shows any model error or file permission warning notifications.

### Config changes have no effect

After you save the config, run `/memory reload-config` or restart Pi. If you changed `autoMemoryDirectory`, you must start a new Pi session before the extension switches to the new directory. The extension does not move files from the old directory automatically.

## Documentation

- [Configuration reference and storage structure](docs/configuration.md): Config file location, field-by-field fallback rules, a detailed description of every field, configuration examples, and the complete local storage directory structure and file lifecycle.
- [Design and security boundaries](docs/design-and-security.md): Threat model, lifecycle and hook flow, permission control for background tools, the read baseline, and the design of cross-process concurrency locks.
- [Claude Code behavior alignment](docs/claude-code-compatibility.md): The scope of alignment with Claude Code 2.1.296, the basis from static reverse engineering, the prompt baseline rules, and the host adaptation trade-offs. The research materials that this page cites are available only in Chinese.
- [Development guide](docs/development.md): The local development environment, checks and test commands, the responsibilities of each source module, and the long-term maintenance constraints.

## License

This project is released under the [GNU Affero General Public License v3.0 or later](LICENSE).

Copyright (C) 2026 XYenon
