# Design and Security Boundaries

This document explains how Pi Project Memory handles project data, coordinates concurrent reads and writes, and limits the tool capabilities of background sub-agents. The extension provides clear, testable application-level boundaries for project memory. It does not treat local path and command checks as a complete security sandbox against malicious processes that run as the same operating system user.

## Threat model

The extension assumes that the Pi host process, the current operating system user account, and command-line programs selected by the host's `PATH` all belong to the same trust domain. Under this assumption, the security design of the extension mainly addresses two kinds of problems:

1. **Prevent background models from changing files outside memory.** Background writes are limited to memory Markdown files through read-only `bash` classification, write path checks, and read baselines before edits. Reads have no fixed directory allowlist or original session exclusion.
2. **Prevent concurrent tasks from overwriting each other.** The extension uses cross-process file locks, compare-and-swap (CAS) on state versions, and atomic rename of temporary files. These controls coordinate concurrent maintenance of the same memory directory by one project or by multiple sessions.

The extension does **not** try to defend against local malicious processes running under the same user permissions that keep replacing directories, symbolic links, binary programs, or environment variables. Restricted `bash` uses syntax tree (AST) analysis, command argument allowlists before native command execution. It does not continuously track the inode and ctime identity of full paths, and it does not provide operating system kernel-level namespace or container isolation. If a deployment must resist untrusted local processes, configure a separate strong sandbox at the operating system or container level.

## Lifecycle and workflows

### 1. Before a request: index injection and memory recall (Recall)

- **Capture of user text**: The selector handles only the user text that the main session actually submits to the model. For a normal interactive request, the `before_agent_start` hook starts prefetching with the final prompt. For a queued or streamed follow-up message, prefetching starts when the message actually enters the session (`message_end`). The raw `input` event does not start a model request. This avoids extra calls on text that other extensions may intercept or rewrite first.
- **Whitespace threshold**: After `trim()`, the user input must contain a whitespace character inside it (matching `/\s/`). The selector runs only when the cumulative recall count of the current branch has not reached the 61,440 limit.
- **Injection and waiting**: The first request loads and caches the trimmed `MEMORY.md`. Later requests reuse the same system prompt snapshot (`auto_memory` and `auto_memory_index`). Index changes append a staleness notice; compaction, branch navigation, configuration reload, and session start clear the snapshot. Normal requests wait up to 2 seconds for selector prefetch: results that arrive in time are injected directly, and later results use Pi's `steer` delivery.
- **Selector caching**: The catalog contains all topics from the current scan. Read suppression filters returned filenames after selection; only actual catalog changes alter the prefix. Query/answer history and a stable session cache ID support subsequent requests. Requests use Pi's `cacheRetention: "short"`; cache markers are managed by Pi's API adapters.

### 2. During a turn: main agent tool interception and enhancement

- **Tool call check (`tool_call`)**: After project trust is revoked, the extension rejects main-agent `read`, `write`, and `edit` calls on memory files. In trusted projects, main-session writes use host tool behavior without blocking on background maintenance, reserved tags, or invisible characters.
- **Post-read staleness reminder and post-write check (`tool_result`)**:
  - When the main agent fully reads a memory file with `read`, the extension adds that file to the read suppression set of the current branch. This stops later selector calls from recalling the same file again. If the file was last modified 48 hours or more ago (rounded down by days, greater than 1 day), the extension adds a staleness reminder at the top of the tool result. The reminder asks the agent to check the file against the current code first.
  - When the main agent successfully writes a memory file with `write` or `edit`, the extension immediately runs format and length checks (lint) on the saved content. If the file is near or over the window limit, uses a numbered continuation file name such as `topic-2.md`, lacks a frontmatter `description`, or has a `description` longer than 300 characters, the extension adds a correction reminder at the end of the tool result.

### 3. After a turn and before exit: background maintenance (Extraction and Dream)

- **Independent dispatch**: When a conversation turn ends normally (`agent_settled`) and nothing was aborted, the extension first captures any external changes to memory files. Then it starts the extractor and dream checks independently. They use `extract.lock` and `dream.lock`, and neither waits for the other.
- **New input does not interrupt the current task**: To match the local file mode of Claude Code, a new user message does not abort a running extractor or dream, and it does not revoke their current write permission. The extraction controller marks new conversation that arrives during the run for one trailing extraction. That extraction runs after the current extraction finishes and the session is idle. However, if the configuration is reloaded, the extension is turned off globally, project trust is revoked, the generation becomes invalid, or a file lock is lost, the background task still aborts at once and rejects later tool calls.
- **Dream attempt time and rollback**: When Dream acquires `dream.lock` and starts its task, it immediately records the attempt timestamp `lastDreamAt` with compare-and-swap. The timestamp is kept whenever the sub-task returns normally (including when it returns an API error or changes no files) or is cancelled. The timestamp is rolled back to the old value through compare-and-swap only when the sub-task throws an exception during the fork step without being aborted. An error reported after completion does not trigger a rollback.
- **Persistent change notices**: Each time a background task successfully changes or deletes a memory file, the extension immediately records a `<system-reminder source="project-memory-update">` update entry. The model can see the entry, and the interface hides it. The extension also adds the usage of each completed model call as it happens. Even if a later model request throws an exception or the task is aborted, the change notices already saved to disk and the token usage already consumed are kept.
- **Waiting before compaction and exit**: Before the session is compacted (`session_before_compact`), the extension waits for any extraction that is being prepared or running. Then it runs one extraction on the unprocessed messages. After compaction finishes, it resets the recall state of the current branch. When the session exits (`session_shutdown`), the extension waits up to 60 seconds for background maintenance tasks. If the wait times out, it sends the abort signal.

## Storage and state layout

The extension keeps the following structure in the user's Pi agent directory:

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
            └── last-dream-at.lock
```

- **Project identity (Project Root)**: The extension first resolves the canonical Git root with `git rev-parse --show-toplevel` and `--git-common-dir`, which have no side effects. If the directory is a linked working tree created with `git worktree`, and its common Git directory is named `.git`, the extension resolves to the root of the main checkout that owns that `.git` directory. This lets different worktrees of the same repository share memory. For a directory that is not in Git, the extension uses `realpath(cwd)`.
- **Namespace reservation and collision prevention**: Each character in the path that is not `[A-Za-z0-9]` is replaced with `-`. If the result is longer than 200 characters, it is truncated and a base36 suffix from the 32-bit signed Java `String.hashCode` is appended. To stop different paths from producing the same `<project-key>` after replacement, the extension writes the `.project-root` marker file exclusively (`wx`) when it initializes the directory. The marker records the real project root. If the namespace is already used by another project root, the extension switches to a `<project-key>-<24-character SHA-256>` subdirectory.
- **Shared consolidation state and locks**: Whether the extension uses the default directory or a custom directory set in the user-level `autoMemoryDirectory`, it computes a 24-character SHA-256 hash (`<memory-root-hash>`) of the canonical actual memory root. It stores `state.json` (which records `lastDreamAt`) and `locks/` under `memory-roots/<memory-root-hash>/`. This means the default path and a configuration that points to the same path (including a symbolic link alias for the same directory) share one consolidation interval state and one set of concurrency locks. If the shared state file does not exist yet, the extension reads the legacy project-level `state.json` as the migration source. For the full directory tree, the roles of the three `state.json` files, and the lifecycle of temporary files, see the [configuration reference and storage structure](configuration.md#storage-paths-and-directory-structure).

## Context window and scan boundaries

| Stage or object                 | Limit                               | Behavior when exceeded or on failure                                                                                                                                                                                                                                        |
| ------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MEMORY.md` index loading       | 200 lines, 25,000 UTF-16 code units | The first limit reached applies. The index is cut at a line break, and a truncation warning is added at the end. If the index is missing but compliant topics exist, the extension backfills the index automatically at 80% of the window (160 lines or 20,000 characters). |
| Topic directory scan            | Up to 200 files, concurrency 16     | Excludes `MEMORY.md` and the `.git`, `.hg`, `.svn`, `.bzr`, `.jj`, and `.sl` directories. Each file is parsed for frontmatter from its first 30 lines or 65,536 bytes, sorted by `mtime` in descending order.                                                               |
| Single topic automatic recall   | 200 lines, 4,096 UTF-8 bytes        | The first limit reached applies. Only complete UTF-8 lines are kept (no partial lines or cut multi-byte characters), and a note is added when the content is truncated.                                                                                                     |
| Branch cumulative recall budget | 61,440 UTF-16 code units            | Counts only the cleaned topic text and the truncation note that is actually sent. When the limit is reached, the selector is no longer called on the current branch.                                                                                                        |
| Background `read` file limit    | 2,000 lines or 50 KiB per page      | When 2,000 lines or 50 KiB is exceeded, Pi's native `read` truncates the output automatically. Explicit `offset` and `limit` parameters allow paged reading.                                                                                                                |

At the scan and recall boundaries, the extension skips a topic file when opening or reading that file fails, and it keeps the other valid results. If the whole memory directory cannot be traversed, `scanTopics()` and `readIndex()` return empty results so the main session can continue normally and the user's prompt is not interrupted.

## Background tools and execution environment

Background sub-agents (extractor and dream) execute only the following six tools, which are wrapped from Pi native factories:

- `read`: Reuses Pi's native `createReadTool` without extra directory or extension restrictions. It uses the host's text and image support. Modification baselines require stable regular files and decode text with Node's UTF-8 replacement behavior.
- `find` and `grep`: Call Pi native `createFindTool` and `createGrepTool` directly in the extension process. They inherit the host environment and native search behavior. Each `grep` call has a 20-second timeout, and both tools check task validity before and after execution.
- `write` and `edit`: Reuse Pi's native parameter schema, text replacement (`edits[]`), and unified diff generation. The low-level file write, however, is replaced with the extension's own safe publishing pipeline. That pipeline includes path validation, the plain-text read baseline check, cross-process file locks, compare-and-swap, atomic rename, and the post-write lint hint.
- `bash`: Reuses the process management and output truncation logic of Pi's native `createBashTool`. The default timeout is 120 seconds, and the maximum is 600 seconds. Full output logs that do not fit the inline window are moved to a temporary directory for the task and deleted automatically when the task ends. Before execution, each command must pass the restricted `bash` check described below.

### Parent request prefix and execution permissions

The public `context_with_system` hook captures the parent's system messages, tool declarations, and projected messages. `message_end` adds messages completed afterward. Each task freezes this snapshot at its start. With the same provider, API, and model ID, and compatible schemas for tools with matching names, the background request preserves the parent prefix and appends tool restrictions and task instructions in a user message. Parent extension and MCP declarations do not connect to executors: calls to them return errors. File tools with matching names still run through the restricted implementations.

Schema compatibility compares the JSON representation of the complete `parameters` recursively, ignoring object key order at every depth. Values and array order must still match. This comparison does not rewrite the parent declarations sent in the request.

Across models, without a captured request, with Pi image blocking enabled, or with incompatible tool schemas, the task uses an independent system prompt and restricted tool declarations. An integer extractor `recentMessages` also selects this path to respect the message limit. Both paths use `cacheRetention: "short"`; forks use the parent session ID, and independent tasks each keep their own stable ID. Full parent history can increase input costs on a cache miss. The provider determines actual cache behavior. Other extensions that rewrite a request after the capture hook, later host projections, and provider parameter differences can also affect hits.

### Background Codemode adaptation

If the main session enables `codemode` when a background task starts, the extractor and dream register task-level codemode tools through Pi's public `createCodemodeExtension({ mode, inlineBudget, models: false })`:

- It inherits the main session's `codemode.mode` (`on` mode exposes the six base tools and `codemode` together, and `only` mode exposes only `codemode` to the model) and `codemode.inlineBudget`.
- Scripts can call only the six restricted tools of the current task (`read`, `find`, `grep`, `write`, `edit`, and `bash`). Each nested call passes the same checks for project trust, generation, path, baseline, and file lock.
- It uses a separate in-memory `SessionManager.inMemory()`. The `store()` and `load()` key-value pairs in a script last only for the lifetime of the background task. They never read or write the main session's store, and they do not connect to the main session's MCP, other extension tools, or `models` interface.

### Working directory and read access

- **Shared working directory base**: All background tools use the `ctx.cwd` of the parent session at task start as the base for relative paths. When `find` or `grep` omits `path`, the search also starts from `ctx.cwd`. A `cd` inside `bash` takes effect only within the current command. The canonical project root (`projectRoot`) determines the memory identity of the project, and `ctx.cwd` resolves relative tool paths. This keeps behavior consistent when a session starts from a repository subdirectory or a linked worktree. When writing a memory file, the model should pass an absolute path, or a path relative to `ctx.cwd` that points to the memory directory. A bare `"topic.md"` resolves against `ctx.cwd`. If `ctx.cwd` is not inside the memory directory, the write is rejected for leaving the allowed area.
- **Read access**: Both extractor and dream can read files outside the project and original session records through host tools. Writes remain limited to `memoryDir`.

### Restricted Bash execution

Background `bash` commands follow two paths:

1. **Delete path (Simple Delete)**: Allows simple `rm`, `rm -f`, and `rm --force`, with an optional `--` separator. Targets must be regular lowercase `.md` files inside memory and outside protected subdirectories. Paths must be absolute and contain no wildcards. Deletion requires no prior read or matching earlier read baseline. With `-f` or `--force`, missing targets succeed without creating their parent directories. Deletion reuses the Bash AST static argument parser used by read-only classification, supporting escaped spaces, static quote concatenation, and backslash line continuation. Redirects, environment assignments, dynamic expansion, and multiple commands do not enter the delete flow.
2. **Read-only execution path (Read-Only Execute)**:
   - **AST syntax limits**: The command is parsed with `tree-sitter-bash`. The extension rejects commands with syntax errors, background operators (`&`), subshells (`(...)`), code blocks (`{ ...; }`), function definitions, command substitution (`$(...)` or backticks), process substitution, variable or arithmetic expansion, brace expansion, and `if`, `for`, `while`, or `case` control flow. Read-only `cd` commands may use `&&`, `||`, semicolons, and pipelines.
   - **Redirection and environment variable limits**: The extension rejects every file write redirection and every `/dev/tcp` or `/dev/udp` network redirection. It allows only input redirection, redirection to `/dev/null`, and standard file descriptor copies such as `2>&1`. Inline environment variables may only be safe display or locale variables, such as `LANG`, `LC_*`, `TZ`, `NO_COLOR`, `RUST_BACKTRACE`, and `NODE_ENV`. Special variables such as `PATH`, `LD_*`, `DYLD_*`, `NODE_OPTIONS`, `BASH_ENV`, `SHELLOPTS`, and `BASH_CMDS` must never be changed.
   - **Command and argument allowlist**: Only predefined read-only commands are allowed, together with safe subsets of their arguments. Examples include `ls`, `cat`, `head`, `tail`, `wc`, `stat`, `find`, `grep`, `rg`, `fd`, `tree`, `du`, `df`, `sort`, `uniq`, `cut`, `tr`, `sed`, `jq`, `awk`, read-only `git` subcommands, and read-only `gh` or `docker` queries. For example, `find` rejects `-exec`, `-delete`, and `-fprint`. `sed` allows one substitution expression on stdin or a list of printing expressions in quiet mode, while rejecting file writes and execution. `git` rejects options that run programs or write files, such as `-c`, `--exec`, `--ext-diff`, and `--output`. Local Git includes and helper settings do not independently block read-only queries. `rg` may omit the search path, and `--glob` adds no extra absolute or parent-directory restrictions.
   - **Static `xargs` checks**: The classifier checks the nested command and its fixed arguments before execution. Commands whose dynamic input could introduce executable or writable options require an explicit `--`. The native `xargs` program handles stdin expansion, quoting, replacement, and command invocation. The extension does not inspect or rewrite the expanded paths at runtime. Read paths have no fixed directory allowlist or OS sandbox boundary. Bash grep commands also receive no automatic directory-exclusion flags. The separate `find` and `grep` tools use Pi native read behavior.

## Write safety, read baseline, and concurrency control

### Path and content sanitization

Local private memory index, catalog, and recall reads follow symbolic links. Text uses Node's UTF-8 replacement decoding, and NUL does not discard the whole file. Controls are cleaned when injected into context. Recall reads the current file without requiring its mtime to match the catalog snapshot.

- Background writes and deletes remain limited to lowercase `.md` paths in memory. File targets and parents may use symbolic links if the resolved target stays inside memory. Writes and edits follow file links; deletion removes the link itself.
- Memory text passes through `sanitizeMemoryText()` when injected into context, removing dangerous controls and invisible characters and escaping reserved tags and Unicode lookalikes. Ordinary writes and edits preserve the supplied text without this cleanup on disk.

### Plain-text read baseline (Read Baseline)

Before a background sub-agent overwrites (`write`) or edits (`edit`) an existing memory file, it must first read that file with `read` in the current task to build a baseline. A new file that does not exist yet does not need a baseline.

- **Paging and truncation rules**: To match Claude Code's plain-text read state, a paged read with valid `offset` and `limit` establishes the latest baseline for the file, as long as the default window does not truncate it automatically. If the read result is automatically truncated by the default limit of 2,000 lines or 50 KiB (`details.truncation` is true), or if the file is an image, the baseline for that file is cleared. This prevents overwriting a file based on an incomplete view.
- **Baseline comparison and edit recovery**: `write` compares content only when the floored current mtime is later than the read baseline time, and requests another read if the content differs. `edit` can recover when all old texts still match uniquely. Read baselines have no 1 GiB cap, and publishing does not add a second content check.

### Cross-process locks and atomic publishing

- **Lock lease (Lock Lease)**: The extraction lock (`extract.lock`, 15-minute timeout), the consolidation lock (`dream.lock`, 60-minute timeout), the timestamp update lock (`last-dream-at.lock`, 1-minute timeout), all use the JSON format `{ pid, token, acquiredAt }`. They are created in exclusive `wx` mode. While a process holds a lock, it refreshes the lock file's `mtime` as a heartbeat. It also checks that the `token` still belongs to the current process before each critical step. When a lock file is older than its timeout and the PID of the original holder no longer exists, another process can take over the expired lock safely through a separate `.recover` arbitration lock. Background file writes and deletes do not acquire per-file process locks or reject calls because a file lock is occupied.
- **Atomic replacement**: Writes use an in-process queue, validate the baseline by read time, and stage a temporary file in the same directory. Existing files publish with `rename()`, and new files use exclusive creation. Task validity and write containment are checked before publishing without another content conflict check.

## Features outside the scope

The following features are explicitly outside the design and implementation scope of this extension:

- **BM25 local retrieval** and the selector branch for CJK text without spaces.
- **Server-side and cross-scope memory features**, including Anthropic account memory, team or organization shared memory (`CLAUDE_MEMORY_STORES`), claude.ai Project memory, server-side vector embedding, ranking, cloud sync, and the `memory_search`, `memory_list`, `memory_read`, and `memory_write` tools.
- **Automatic changes to `AGENTS.md`** and maintenance of the skills directory.
- **Dedicated PDF and Jupyter Notebook parsing**. File reads follow Pi native behavior without extension-based blocking.
- **Unrestricted background shell, MCP tool calls, or sub-agent spawning**.
- **A general permission system for the Pi main session** (deny and ask rule evaluation and approval dialogs).
