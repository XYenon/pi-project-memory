# Design and Security Boundaries

This document explains how Pi Project Memory handles project data, coordinates concurrent reads and writes, and limits the tool capabilities of background sub-agents. The extension provides clear, testable application-level boundaries for project memory. It does not treat local path and command checks as a complete security sandbox against malicious processes that run as the same operating system user.

## Threat model

The extension assumes that the Pi host process, the current operating system user account, and command-line programs selected by the host's `PATH` all belong to the same trust domain. Under this assumption, the security design of the extension mainly addresses two kinds of problems:

1. **Prevent background models from accessing files outside their scope or changing them by mistake.** The extension uses approved read roots, containment checks for memory directory writes, symbolic link rejection, restricted read-only `bash` classification, and the plain-text read baseline. These controls stop background sub-agents from reading unapproved directories or changing files outside the memory directory.
2. **Prevent concurrent tasks from overwriting each other.** The extension uses cross-process file locks, compare-and-swap (CAS) on state versions, and atomic rename of temporary files. These controls coordinate concurrent maintenance of the same memory directory by one project or by multiple sessions.

The extension does **not** try to defend against local malicious processes running under the same user permissions that keep replacing directories, symbolic links, binary programs, or environment variables. Restricted `bash` uses syntax tree (AST) analysis, command argument allowlists, and explicit path checks before native command execution. It does not continuously track the inode and ctime identity of full paths, and it does not provide operating system kernel-level namespace or container isolation. If a deployment must resist untrusted local processes, configure a separate strong sandbox at the operating system or container level.

## Lifecycle and workflows

### 1. Before a request: index injection and memory recall (Recall)

- **Capture of user text**: The selector handles only the user text that the main session actually submits to the model. For a normal interactive request, the `before_agent_start` hook starts prefetching with the final prompt. For a queued or streamed follow-up message, prefetching starts when the message actually enters the session (`message_end`). The raw `input` event does not start a model request. This avoids extra calls on text that other extensions may intercept or rewrite first.
- **Whitespace threshold**: After `trim()`, the user input must contain a whitespace character inside it (matching `/\s/`). The selector runs only when the cumulative recall count of the current branch has not reached the 61,440 limit.
- **Injection and waiting**: Before each normal request starts, the extension injects the trimmed `MEMORY.md` into the system prompt (in the `auto_memory` and `auto_memory_index` sections). It waits up to 2 seconds for any selector prefetch that is still running. If the prefetch finishes within 2 seconds, the recalled topic content goes directly into this request. If it takes longer than 2 seconds, the result is sent as a Pi `steer` message in the next model call once it is ready.

### 2. During a turn: main agent tool interception and enhancement

- **Pre-write check (`tool_call`)**: When the main agent calls `read`, `write`, or `edit` on the memory directory, the extension first checks the project trust status. If the main agent calls `write` or `edit` on a memory file while a background extractor or dream is being prepared or is running, the extension temporarily blocks the call and asks the agent to retry later. The extension also checks that the target path is not a symbolic link, that the real path of the parent directory is still inside the memory root, and that the content does not contain reserved prompt tags (such as `<system-reminder>`) or dangerous invisible characters.
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
            ├── last-dream-at.lock
            └── files/
                └── <file-path-sha256>.lock
```

- **Project identity (Project Root)**: The extension first resolves the canonical Git root with `git rev-parse --show-toplevel` and `--git-common-dir`, which have no side effects. If the directory is a linked working tree created with `git worktree`, and its common Git directory is named `.git`, the extension resolves to the root of the main checkout that owns that `.git` directory. This lets different worktrees of the same repository share memory. For a directory that is not in Git, the extension uses `realpath(cwd)`.
- **Namespace reservation and collision prevention**: Each character in the path that is not `[A-Za-z0-9]` is replaced with `-`. If the result is longer than 200 characters, it is truncated and a base36 suffix from the 32-bit signed Java `String.hashCode` is appended. To stop different paths from producing the same `<project-key>` after replacement, the extension writes the `.project-root` marker file exclusively (`wx`) when it initializes the directory. The marker records the real project root. If the namespace is already used by another project root, the extension switches to a `<project-key>-<24-character SHA-256>` subdirectory.
- **Shared consolidation state and locks**: Whether the extension uses the default directory or a custom directory set in the user-level `autoMemoryDirectory`, it computes a 24-character SHA-256 hash (`<memory-root-hash>`) of the canonical actual memory root. It stores `state.json` (which records `lastDreamAt`) and `locks/` under `memory-roots/<memory-root-hash>/`. This means the default path and a configuration that points to the same path (including a symbolic link alias for the same directory) share one consolidation interval state and one set of concurrency locks. If the shared state file does not exist yet, the extension reads the legacy project-level `state.json` as the migration source. For the full directory tree, the roles of the three `state.json` files, and the lifecycle of temporary files, see the [configuration reference and storage structure](configuration.md#storage-paths-and-directory-structure).

## Context window and scan boundaries

| Stage or object                 | Limit                                          | Behavior when exceeded or on failure                                                                                                                                                                                                                                        |
| ------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MEMORY.md` index loading       | 200 lines, 25,000 UTF-16 code units            | The first limit reached applies. The index is cut at a line break, and a truncation warning is added at the end. If the index is missing but compliant topics exist, the extension backfills the index automatically at 80% of the window (160 lines or 20,000 characters). |
| Topic directory scan            | Up to 200 files, concurrency 16                | Excludes `MEMORY.md` and the `.git`, `.hg`, `.svn`, `.bzr`, `.jj`, and `.sl` directories. Each file is parsed for frontmatter from its first 30 lines or 65,536 bytes, sorted by `mtime` in descending order.                                                               |
| Single topic automatic recall   | 200 lines, 4,096 UTF-8 bytes                   | The first limit reached applies. Only complete UTF-8 lines are kept (no partial lines or cut multi-byte characters), and a note is added when the content is truncated.                                                                                                     |
| Branch cumulative recall budget | 61,440 UTF-16 code units                       | Counts only the cleaned topic text and the truncation note that is actually sent. When the limit is reached, the selector is no longer called on the current branch.                                                                                                        |
| Background `read` file limit    | 1 GiB raw size, 2,000 lines or 50 KiB per page | When 2,000 lines or 50 KiB is exceeded, Pi's native `read` truncates the output automatically. Explicit `offset` and `limit` parameters allow paged reading.                                                                                                                |
| Search transfer                 | Search subprocess output 4 MiB                 | Prevents accidentally large output from exhausting memory. These are resource protection limits, not security isolation.                                                                                                                                                    |

At the scan and recall boundaries, the extension skips a topic file when opening, reading, or UTF-8 decoding of that file fails, and it keeps the other valid results. If the whole memory directory cannot be traversed, `scanTopics()` and `readIndex()` return empty results so the main session can continue normally and the user's prompt is not interrupted.

## Background tools and execution environment

Background sub-agents (extractor and dream) declare only the following six tools, which are wrapped from Pi native factories:

- `read`: Reuses Pi's native `createReadTool`. It allows reading UTF-8 text files and common image formats inside approved roots. It explicitly rejects `.pdf` files, `.ipynb` files, binary files that contain NUL bytes, and files that are not UTF-8 encoded.
- `find` and `grep`: Run in a separate subprocess, `native-search-worker.mjs`, and reuse Pi's native `createFindTool` and `createGrepTool`. The subprocess resolves `fd` and `rg` through the host's `PATH` and clears `RIPGREP_CONFIG_PATH`. It forces `--no-config` and `--no-follow` on `grep`, which prevents following symbolic links. It places the directory exclusion rules last among the options, before the `--` separator on the command line. This ensures that a positive glob passed by the model cannot bypass the exclusion rules. Each `grep` call has a 20-second timeout.
- `write` and `edit`: Reuse Pi's native parameter schema, text replacement (`edits[]`), and unified diff generation. The low-level file write, however, is replaced with the extension's own safe publishing pipeline. That pipeline includes path validation, content cleanup, the plain-text read baseline check, cross-process file locks, compare-and-swap, atomic rename, and the post-write lint hint.
- `bash`: Reuses the process management and output truncation logic of Pi's native `createBashTool`. The default timeout is 120 seconds, and the maximum is 600 seconds. Full output logs that do not fit the inline window are moved to a temporary directory for the task and deleted automatically when the task ends. Before execution, each command must pass the restricted `bash` check described below.

### Background Codemode adaptation

If the main session enables `codemode` when a background task starts, the extractor and dream register task-level codemode tools through Pi's public `createCodemodeExtension({ mode, inlineBudget, models: false })`:

- It inherits the main session's `codemode.mode` (`on` mode exposes the six base tools and `codemode` together, and `only` mode exposes only `codemode` to the model) and `codemode.inlineBudget`.
- Scripts can call only the six restricted tools of the current task (`read`, `find`, `grep`, `write`, `edit`, and `bash`). Each nested call passes the same checks for project trust, generation, path, baseline, and file lock.
- It uses a separate in-memory `SessionManager.inMemory()`. The `store()` and `load()` key-value pairs in a script last only for the lifetime of the background task. They never read or write the main session's store, and they do not connect to the main session's MCP, other extension tools, or `models` interface.

### Working directory and approved read roots

- **Shared working directory base**: All background tools use the `ctx.cwd` of the parent session at task start as the base for relative paths. When `find` or `grep` omits `path`, the search also starts from `ctx.cwd`. A `cd` inside `bash` takes effect only within the current command. The canonical project root (`projectRoot`) determines the memory identity of the project, and `ctx.cwd` resolves relative tool paths. This keeps behavior consistent when a session starts from a repository subdirectory or a linked worktree. When writing a memory file, the model should pass an absolute path, or a path relative to `ctx.cwd` that points to the memory directory. A bare `"topic.md"` resolves against `ctx.cwd`. If `ctx.cwd` is not inside the memory directory, the write is rejected for leaving the allowed area.
- **Differences in read scope by role**:
  - The approved read roots for `extractor` include `memoryDir`, `projectRoot`, `cwd`, and the task's own `scratchDir`. The original session directory is also listed in `excludedReadRoots`. This exclusion takes priority over all approved read roots. Even when the custom session directory is inside the project directory, the extractor's file tools and explicit Bash path checks still reject access to it.
  - The approved read roots for `dream` include `memoryDir`, `projectRoot`, `cwd`, `sessionDir`, and the task's own `scratchDir`. Dream can read the original session directory directly and read-only. However, any write operation can only target `memoryDir`.

### Restricted Bash execution

Background `bash` commands follow two paths:

1. **Delete path (Simple Delete)**: A command enters the controlled delete flow only when the whole command is a simple `rm <paths...>` or `rm -f <paths...>`. The `--` separator is allowed. Other flags such as `--force`, wildcards, and relative paths are rejected. The target path must be a regular file inside `memoryDir` whose name is lowercase `.md`. It must not be inside a protected subdirectory (`.git`, `.hg`, `.svn`, `.bzr`, `.jj`, `.sl`, `.claude`, `.cargo`, `.devcontainer`, `.githooks`, `.husky`, `.idea`, `.mvn`, `.vscode`, `.yarn`, `agents`, `commands`, `config`, `head`, `hooks`, `node_modules`, `objects`, `refs`, or `skills`). The current task must also have built a plain-text read baseline for that file.
2. **Read-only execution path (Read-Only Execute)**:
   - **AST syntax limits**: The command is parsed with `tree-sitter-bash`. The extension rejects commands with syntax errors, background operators (`&`), subshells (`(...)`), code blocks (`{ ...; }`), function definitions, command substitution (`$(...)` or backticks), process substitution, variable or arithmetic expansion, brace expansion, and `if`, `for`, `while`, or `case` control flow. If a `cd` command is chained with later commands, only plain `&&` lists are allowed. Piping `cd`, or mixing `||` and `;`, is rejected, so static path resolution stays deterministic.
   - **Redirection and environment variable limits**: The extension rejects every file write redirection and every `/dev/tcp` or `/dev/udp` network redirection. It allows only input redirection, redirection to `/dev/null`, and standard file descriptor copies such as `2>&1`. Inline environment variables may only be safe display or locale variables, such as `LANG`, `LC_*`, `TZ`, `NO_COLOR`, `RUST_BACKTRACE`, and `NODE_ENV`. Special variables such as `PATH`, `LD_*`, `DYLD_*`, `NODE_OPTIONS`, `BASH_ENV`, `SHELLOPTS`, and `BASH_CMDS` must never be changed.
   - **Command and argument allowlist**: Only predefined read-only commands are allowed, together with safe subsets of their arguments. Examples include `ls`, `cat`, `head`, `tail`, `wc`, `stat`, `find`, `grep`, `rg`, `fd`, `tree`, `du`, `df`, `sort`, `uniq`, `cut`, `tr`, `sed`, `jq`, `awk`, read-only `git` subcommands, and read-only `gh` or `docker` queries. For example, `find` rejects `-exec`, `-delete`, and `-fprint`. `sed` rejects the `w`, `e`, and `r` commands. `git` rejects options that run programs or write files, such as `-c`, `--exec`, `--ext-diff`, and `--output`. Before it runs, the extension scans the repository's `.git/config`. It refuses to run if it finds `include`, `filter.*.clean/smudge/process`, `diff.*.command/textconv`, or `gpg` signing program settings.
   - **Static `xargs` checks**: The classifier checks the nested command and its fixed arguments before execution. Commands whose dynamic input could introduce executable or writable options require an explicit `--`. The native `xargs` program handles stdin expansion, quoting, replacement, and command invocation. The extension does not inspect or rewrite the expanded paths at runtime. Explicit paths are checked before execution; dynamically produced paths and recursive command reads have no OS sandbox boundary. Bash grep commands also receive no automatic directory-exclusion flags. The separate `find` and `grep` tools retain their own file access checks.

## Write safety, read baseline, and concurrency control

### Path and content sanitization

- All writes and deletes are strictly limited to regular files with lowercase `.md` names inside the canonical `memoryDir`. If the target already exists as a symbolic link or as a non-regular file, or if any parent directory resolves outside `memoryDir`, the operation fails immediately.
- Memory text that is persisted or injected into context passes through `sanitizeMemoryText()`. It normalizes line breaks to `\n`. It removes control characters, format characters, private-use characters, and default-ignorable characters, except for `\t`, `\n`, and four valid joiner and variation selectors (`U+200C`, `U+200D`, `U+FE0E`, and `U+FE0F`). It also escapes the opening angle bracket of reserved prompt tags to `&lt;`. Reserved tags include `<system-reminder>`, `<tool_use>`, and `<function_results>`, including disguised forms that use fullwidth symbols, Cyrillic letters, mathematical alphanumeric symbols, and other Unicode lookalikes. If the main agent tries to write content that contains these dangerous characters or reserved tags, the `tool_call` hook blocks the write directly.

### Plain-text read baseline (Read Baseline)

Before a background sub-agent overwrites (`write`), edits (`edit`), or deletes through `bash rm` an existing memory file, it must first read that file with `read` in the current task to build a baseline. A new file that does not exist yet does not need a baseline.

- **Paging and truncation rules**: To match Claude Code's plain-text read state, a paged read with valid `offset` and `limit` establishes the latest baseline for the file, as long as the default window does not truncate it automatically. If the read result is automatically truncated by the default limit of 2,000 lines or 50 KiB (`details.truncation` is true), or if the file is an image, the baseline for that file is cleared. This prevents overwriting a file based on an incomplete view.
- **Baseline comparison and edit recovery**: The baseline records the SHA-256 hash and byte size of the full UTF-8 content of the file. If only `mtime` changed and the content hash and size stayed the same, the file is still treated as the same baseline. When `write` or `rm` runs and the current disk content differs from the baseline, the operation fails and asks the agent to read the file again. When `edit` runs and the file was changed externally after it was read, the edit proceeds only if every `oldText` in the current `edits[]` still matches exactly once in the latest file content and applies successfully. In that case, the result is marked with `staleRecovered: true` and a reread reminder. Otherwise, the write is also rejected.

### Cross-process locks and atomic publishing

- **Lock lease (Lock Lease)**: The extraction lock (`extract.lock`, 15-minute timeout), the consolidation lock (`dream.lock`, 60-minute timeout), the timestamp update lock (`last-dream-at.lock`, 1-minute timeout), and the single-file write lock (`locks/files/<sha256>.lock`, 15-minute timeout) all use the JSON format `{ pid, token, acquiredAt }`. They are created in exclusive `wx` mode. While a process holds a lock, it refreshes the lock file's `mtime` as a heartbeat. It also checks that the `token` still belongs to the current process before each critical step. When a lock file is older than its timeout and the PID of the original holder no longer exists, another process can take over the expired lock safely through a separate `.recover` arbitration lock.
- **Two-phase checks and atomic replacement**: After a single-file write gets the file-level cross-process lock and the in-process queue, it first checks the current disk baseline. Then it writes the new content to a private `.tmp` file in the same directory (permissions `0600`). Before the final publish, it checks again that the generation, project trust, the real path of the parent directory, and the disk baseline have not changed concurrently. A new file is published with `link()` and then `rm()`, which is an exclusive publish that does not overwrite an existing file (no-clobber). An existing file is replaced atomically with `rename()`.

## Features outside the scope

The following features are explicitly outside the design and implementation scope of this extension:

- **BM25 local retrieval** and the selector branch for CJK text without spaces.
- **Server-side and cross-scope memory features**, including Anthropic account memory, team or organization shared memory (`CLAUDE_MEMORY_STORES`), claude.ai Project memory, server-side vector embedding, ranking, cloud sync, and the `memory_search`, `memory_list`, `memory_read`, and `memory_write` tools.
- **Automatic changes to `AGENTS.md`** and maintenance of the skills directory.
- **Reading PDF (`.pdf`) and Jupyter Notebook (`.ipynb`) files**.
- **Unrestricted background shell, MCP tool calls, or sub-agent spawning**.
- **A general permission system for the Pi main session** (deny and ask rule evaluation and approval dialogs).
