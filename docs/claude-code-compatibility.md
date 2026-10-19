# Claude Code Behavior Alignment

Pi Project Memory uses the local private file mode auto-memory of Claude Code 2.1.296 as its reference. This document records the scope of alignment for client-observable behavior, the static reverse engineering evidence, the adaptation plan for the Pi host, and the differences that were kept on purpose. Regular users do not need to read this document.

## Evidence scope and research materials

The analysis covers the darwin arm64 release of `@anthropic-ai/claude-code@2.1.296`, which is a single-file Bun executable. The analysis first extracted the Bun module graph statically from the binary. Then it used a reverse engineering analysis tool (REA) and a source-level audit to locate the code related to auto-memory. The target binary was never executed.

The conclusions in this document cover only the deterministic logic and prompt templates that can be observed in the client executable. They do not infer Anthropic server-side private feature flags, internal model routing, vector embedding, ranking, or the server implementation of `memory_search`.

The reverse engineering report, the raw prompt excerpts, and the chunk-level verification evidence are stored in the repository's `docs/research/` directory. The `docs/research/` directory only records the target behavior and evidence for Claude Code. All implementation, adaptation, and difference notes for Pi Project Memory are recorded in this document, [design and security boundaries](design-and-security.md), and [development guide](development.md). The research materials are available only in Chinese:

- [Claude Code 2.1.296 Memory implementation analysis (Chinese)](research/implementation-analysis.md)
- [Prompt, tool definition, and key function appendix (Chinese)](research/prompt-tools-and-functions.md)
- [Research evidence notes (Chinese)](research/research-evidence.md)

## Core behaviors that are aligned

### 1. File layout and data model

- The directory structure uses a `MEMORY.md` index file and separate topic Markdown files.
- `MEMORY.md` stores only one link pointer per line (keep each line under 150 characters). It has no frontmatter and does not store memory content directly.
- Each topic file uses YAML frontmatter to store `name`, `description`, and `metadata.type`. The four supported types are `user`, `feedback`, `project`, and `reference`. Like Claude, the extension also accepts top-level non-standard `type` and `modified` fields, and moves them into `metadata`. An explicit `metadata.type` takes priority.

### 2. Project key and worktree ownership

- The project root is the canonical Git root when one is available. If the directory is a linked `git worktree` and its common Git directory is named `.git`, the project belongs to the main checkout that owns that common `.git` directory. This lets several linked worktrees share one project memory. For a directory that is not in Git, the canonical current working directory is used.
- The project key replaces every character in the root path that is not `[A-Za-z0-9]` with `-`. If the result is longer than 200 characters, the extension keeps the first 200 characters and appends a base36 suffix from the 32-bit signed Java `String.hashCode`.

### 3. Index trimming, automatic backfill, and recall window

- **Index window**: The `MEMORY.md` injection limit is 200 lines and 25,000 JavaScript UTF-16 code units. The limit is measured with the string `.length` of JavaScript, and the first limit reached applies. When the limit is exceeded, the index is cut at a line break, and the warning `WARNING: MEMORY.md was truncated` is added at the end. The prompt text describes this limit as about 25 KB, but the code counts UTF-16 code units. When `MEMORY.md` is missing and the directory has topic files that can be safely linked, the extension backfills an initial index automatically. The backfill uses no more than 80% of the window (160 lines and 20,000 code units). It creates the file with exclusive creation (`wx`, no-clobber).
- **Single-file recall window**: Each selected topic file is read for at most its first 200 lines and 4,096 UTF-8 bytes, whichever limit is reached first. The reader adds complete UTF-8 lines. When the next line would exceed 4,096 bytes, it stops right away. It never injects a partial line or a cut multi-byte character.
- **Asynchronous prefetch and delayed injection**: The selector starts asynchronously after Pi accepts the final user text. A normal request starts it in `before_agent_start`. A queued or streamed user message starts it when the message enters the main session (`message_end`). The raw `input` event does not start a model request. Before a normal request starts, the extension waits up to 2 seconds for the prefetch. A result that finishes after 2 seconds is added to the next model call as a Pi `steer` message. A normal request also marks the next user message as already prefetched. When Pi then appends a user message with a normalized image size, the selector is not called again. Later independent queued messages still trigger their own selector calls.
- **Branch budget and read suppression**: Each session branch can accumulate at most 61,440 UTF-16 code units of automatic recall. The budget counts only the sanitized topic text and the truncation note added when a file is cut. It does not count the `<system-reminder>` wrapper, file path headings, staleness reminders, or the first guidance message. When the limit is reached, the selector stops being called. When the main agent fully reads a topic file with the normal `read` tool, the file is no longer recalled automatically on the current branch. A partial read (`offset > 1` or an automatic truncation) does not trigger suppression. If the file is modified on disk, it can become a candidate again.
- **Text sanitization**: Index injection and recall injection all remove dangerous control characters, format characters, and invisible characters. They escape reserved prompt tags such as `<system-reminder>` and `<tool_use>`, including their Unicode lookalike variants, to `&lt;`. The process never introduces the replacement character `U+FFFD`. Ordinary writes and edits do not apply this cleanup on disk or block on these characters.

### 4. Selector directory format and output schema

The candidate directory uses the format `- [type] filename (mtime ISO): description`. When the `type` is unknown, the `[type]` prefix is omitted. The output JSON Schema matches Claude Code 2.1.296 exactly:

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

The selector returns at most 512 tokens by default, and it returns at most 5 file names in one call. If the model returns a file name with a type prefix such as `[project]`, the parser removes the prefix automatically and checks that the file exists in the candidate list. The extension keeps the selector's query and answer pairs in the current session branch. This prevents the same file from being selected again in the same conversation.

### 5. Fault tolerance for index, scan, and selector

- **`readIndex()` fault tolerance**: As an optional entry point for loading system context, `readIndex()` tries to backfill when `MEMORY.md` is missing. If reading or backfilling fails (for example, when `MEMORY.md` is a dangling symbolic link or a directory), `readIndex()` silently returns an empty string `""` so the main session can keep running. The lower-level `readRegularFileNoFollow()` and `backfillIndex()` still throw exceptions to direct callers. This behavior matches the fault tolerance logic of `XNe()` (starting at line 35595) and `BJn()` (starting at line 34548) in `chunk-sfn1dbxq.js`.
- **`scanTopics()` fault tolerance**: The extension handles failures of single files and of the whole directory separately. If opening, reading, or UTF-8 decoding of one file fails, that file is skipped and the other valid topics are kept. If the whole directory cannot be traversed, the public entry point `scanTopics()` returns an empty array `[]`. Valid files are sorted from newest to oldest by `mtime`, and the first 200 are kept. The extension still reads at most 16 files at the same time, so it does not run out of handles when the file descriptor limit is low. This behavior matches `Hdr()` (starting at line 10285 of `chunk-n3ykh62m.js`, which uses `Promise.allSettled()`) and `dVe()` (starting at line 10348).
- **Selector failure boundary**: When a request fails, the output is cut off by length (`length`), the text is missing, JSON parsing fails, or schema validation fails, the selector boundary sends a warning notification and returns an empty array `[]`. When a request is cancelled (`aborted`), it returns `[]` silently. If a native structured output request returns successfully but the content format is invalid, the selector returns `[]` directly and does not make a second tool request. This behavior matches the error handling logic that starts at line 171105 of `chunk-sfn1dbxq.js`.

### 6. Post-turn extraction

- **Message context and signature handling**: The cursor determines the extraction range and recent message count in the task prompt. A reusable same-model request sends the full parent history as a cache prefix and appends instructions targeting recent unprocessed messages. Independent requests send only messages after the cursor, optionally limited by `recentMessages`. When the extractor and historical assistant messages use the same concrete `provider`, `api`, and `model`, the extension keeps `thinking` blocks and signatures. Across models, it deletes `thinking` blocks and strips provider-specific signatures from text and tool calls.
- **Prompt completion**: When the extractor or dream starts, the extension checks whether the parent system prompt already contains the auto-memory rules. For example, the rules may be missing after a session is restored and `/memory extract` is run by hand. If they are missing, the extension adds the main memory prompt. That prompt includes the current memory directory, the memory types, the exclusions, and the frontmatter rules. If the parent prompt already contains them, the extension reuses it and does not concatenate them again.
- **New input and merged runs**: To match the local file mode of Claude Code, new user input does not stop a running extractor, and it does not take away that extractor's write permission. The extraction controller merges the new conversation into one later extraction (trailing extraction) that runs after the current extraction ends. Before session compaction, the extension also waits for any extraction that is being prepared or running, and then extracts the remaining unprocessed messages.
- **Cursor advance rules**: When the main agent's direct write deduplicates the extraction, or when the user prose does not reach the three-word threshold and the extraction is skipped, the cursor moves to the end of the current message snapshot. When the background extraction sub-task returns normally, including when the model returns an API error or reaches the `maxTurns` limit, the cursor also moves to the end of this run's input snapshot. The cursor stays in place only when the sub-task throws an exception, is aborted, or becomes invalid because of a trust or configuration change, so the run can be retried. Messages that arrive during the extraction are not consumed by this cursor advance. The MCP mode rule for advancing the cursor after three consecutive incomplete runs does not apply to the local file mode.

### 7. Periodic consolidation (Dream) and shutdown wait

- **Trigger and independent dispatch**: The check runs after a normal turn ends (`agent_settled`). By default, it requires at least 24 hours since the last consolidation attempt and at least 5 other sessions with updates. The in-process scan throttle is 10 minutes, and the sub-agent tool loop is limited to 50 turns. The extractor and dream are dispatched independently from the same turn. They use `extract.lock` and `dream.lock`.
- **Attempt time and rollback**: When the extension acquires `dream.lock` and starts the task, it records the attempt time `lastDreamAt` at once. The later 24-hour threshold and the other-session count both use this attempt time as the baseline. The timestamp is kept when the sub-task returns normally (including when it returns an API error or changes no files) or when it is aborted (`aborted`). The timestamp is rolled back to the old value through compare-and-swap only when the sub-task throws an exception during the fork step without being aborted. An error reported in the completion step does not trigger a rollback.
- **Direct read-only access to the original session directory**: The scheduler reads the header information of `.jsonl` session files. It checks `type: "session"` and the valid Pi session ID syntax. In a custom shared session directory, it also filters by canonical project root. The list of recent session IDs goes into the dream prompt. Dream reads the original session directory directly and read-only. It does not copy transcripts to a temporary directory first, and it does not treat the ID list as a file access allowlist. If reading one session file fails, the tool returns the error directly and the consolidation timestamp is not rolled back. This behavior matches the implementation that passes the session directory and the recent ID list directly, starting at line 340 of `chunk-kxgzv2t8.js`.
- **Shutdown wait**: When the session exits (`session_shutdown`), the extension waits up to 60 seconds for background maintenance tasks. If the wait times out, it sends the abort signal.

### 8. Prompt caching and memory context snapshots

Additional static inspection of the Linux x64 releases of Claude Code 2.1.296 and 2.1.300 confirmed session caches for initial instruction files and assembled user context, appended staleness notices after memory writes, explicit system/catalog/latest-query caching in the traditional selector, and parent system/tool/full-message prefix reuse in local extractor and dream forks. Pi implements these mechanisms as follows:

- Cache the first `MEMORY.md` load until compaction, branch navigation, configuration reload, or session start. Background and external edits do not replace the old system sections.
- Enable short selector cache retention, use a stable session cache ID, and retain the full catalog and query/answer history. Filter unchanged already-read files after selection; update the catalog text when its data changes. Cache markers follow Pi's API adapter defaults; the extension does not add a catalog breakpoint or rewrite OAuth system markers.
- Preserve the parent prefix for extractor and dream when the model and tool schemas are compatible and a captured snapshot exists. Append tool restrictions and task instructions in a user message. Only restricted executors are connected. An integer `recentMessages`, image blocking, or other incompatible conditions select independent requests. See [Parent request prefix and execution permissions](design-and-security.md#parent-request-prefix-and-execution-permissions).
- Both background paths use Pi's `cacheRetention: "short"`. Claude's local `skipCacheWrite` depends on a server flag with a client fallback of `false`; it adjusts the trailing cache marker and does not disable all caching. Pi does not introduce that private flag or guarantee cache hit rates or cost reductions.

## Prompt and background tool alignment

### 1. Static prompt baseline rules

The main agent auto-memory prompt, selector prompt, extractor prompt, and dream prompt all use the runtime text of Claude Code 2.1.296 local private file mode as their fixed baseline. `tests/prompts.test.ts` and `tests/fixtures/prompts/*.txt` check that baseline word for word. The static text allows only four kinds of replacement:

1. Replace the instruction file name `CLAUDE.md` with `AGENTS.md`.
2. Replace tool names, parameter names, and field names with Pi native interfaces (such as `read`, `write`, `edit`, `find`, `grep`, and `bash`).
3. Remove sections that only serve features that are explicitly unsupported, such as team shared storage and MCP memory tools.
4. Replace the product name `Claude Code` in the prompt with the neutral term `the agent`.

When the selector uses a constrained tool mode, the fixed instruction `Call the select_memories tool exactly once with the JSON object you would otherwise return.` may be appended to the end of the selector baseline. The runtime values, such as the directory path, the number of messages, and the list of recent session IDs, are dynamic and are filled in with the values from the actual run.

### 2. Background tool interface and Codemode adaptation

Background sub-agents do not imitate Claude Code's file tool names or parameter structures. They wrap and reuse the six Pi native tool factories directly: `read`, `find`, `grep`, `write`, `edit`, and `bash`. So the paging window of `read`, the parameter format of `find` and `grep`, and the `edits[]` array structure of `edit` all follow Pi. Claude's `Glob` tool, `output_mode` for `Grep`, and the PDF `pages` and `allow_large` parameters for `Read` are not provided. PDF and Jupyter Notebook parsing is not added; file reads follow Pi native behavior.

Bash follows the execution order observed in Claude's memory permission path: static permission and read-only checks first, then the host's general shell tool. Pi Project Memory passes the original command to Pi's native Bash tool and leaves grep and xargs execution to the host programs. It does not reproduce Claude's optional sandbox wrapper. Dynamic stdin-expanded paths are not checked at runtime.

The separate `## Background memory task tools` section lists executable background tools and their access limits while preserving inherited user, project, and auto-memory instructions. A fork appends this section with the task instructions in the final user message and preserves parent tool declarations. Independent requests append it to the system prompt and declare the restricted tools.

When the main session enables `codemode`, the extractor and dream also enable Pi's native `codemode` inside the task. They inherit the main session's `on` or `only` mode and its `inlineBudget`. Scripts can call only the six restricted tools of the current task. These calls are subject to the same checks for path, read baseline, project trust, and generation. The in-memory store of the task is fully isolated from the parent session. This is an adaptation of tool calls for the Pi runtime. It does not change the four fixed prompt baselines described above.

### 3. Working-directory basis for background tools

In Claude Code 2.1.296, local extraction (`chunk-9mazb6vn.js:912`) and dream (`chunk-kxgzv2t8.js:356`) both call the general `MC()` function (`chunk-sfn1dbxq.js:116467`), which calls `Rir()` (same file, line 116301) to create the background fork context. By default, that context inherits the parent session's session and working directory directly. It does not switch the working directory for different background roles or for read and write operations. The memory directory is passed only to the permission check function `p5n()` (`chunk-9mazb6vn.js:429`), which limits the write scope.

To match this mechanism, Pi Project Memory uses the parent session's `ctx.cwd` at task start as the working directory base for background `read`, `find`, `grep`, `write`, `edit`, and `bash`. The extractor and dream behave the same way:

- When Pi starts from a repository subdirectory or a linked worktree, the canonical project root (`projectRoot`) decides the memory identity. `ctx.cwd` decides where relative tool paths start. `find` and `grep` also search from `ctx.cwd` when `path` is omitted.
- Claude's `Read`, `Write`, and `Edit` interfaces require absolute paths. Pi's native tools support relative paths and resolve them against `ctx.cwd`. So when a background model changes a memory file, it should pass an absolute path, or a path relative to `ctx.cwd` that points to the memory directory. A bare `"topic.md"` resolves to `ctx.cwd/topic.md`. It is not redirected to the memory directory automatically.

## Adaptations and trade-offs for the Pi host

The table below summarizes the trade-offs and implementation methods used when the Claude Code 2.1.296 local memory mechanism moves to the Pi host.

### Input filtering and automatic extraction

| Claude Code 2.1.296 mechanism                                             | Strategy              | How Pi Project Memory implements it and why                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Only real user queries from the main agent are processed                  | Adapt host events     | The selector starts only for user text that the main session actually submits to the model. It excludes tool results, memory update and recall messages, background task requests, and local `/memory` commands.                                                                                                                                                                                                |
| Filtering by internal query source identifiers                            | Adapt host events     | It uses Pi's public `before_agent_start` (the final prompt of a normal request) and `message_end` (queued or streamed user messages) to identify valid text. It does not call a model from the raw `input` event, so other extensions cannot rewrite or block the text after an invalid request has already started.                                                                                            |
| Selector whitespace threshold and conditional CJK branch                  | Keep traditional path | It requires `/\s/.test(query.trim())` to be true. A single English word or Chinese text without spaces does not start the selector. Claude's no-space CJK exception shares the `tengu_mill_orange` switch with BM25. This project does not include BM25, so it keeps the traditional whitespace threshold.                                                                                                      |
| Skip extraction when the main agent already wrote memory after the cursor | Keep and adapt        | Checks whether the main agent made a successful `write` or `edit` call on the memory directory after the cursor. If it did, automatic extraction is skipped and the cursor advances. Failed calls and writes outside the directory do not cause a skip.                                                                                                                                                         |
| Three-word threshold for user prose in extraction                         | Keep                  | Requires at least one real user message after the cursor, with string content or a single standalone `text` block, that has at least 3 non-empty words after splitting on `/\s+/`. Blocks and messages are not merged, and there is no separate Chinese word segmentation. If the threshold is not met, automatic extraction is skipped and the cursor advances. Manual extraction is subject to the same rule. |
| Cursor advance and merging of new input in local file mode                | Keep                  | The cursor advances when a run is skipped or when a background sub-task returns (including an API error or reaching `maxTurns`). It stays in place when the sub-task throws an exception. New input during a run is marked `trailingExtraction`. It does not cancel the current task, and the current cursor does not consume it.                                                                               |
| Three consecutive incomplete MCP runs before the cursor advances          | Exclude               | The rule for advancing the cursor only after three consecutive incomplete runs belongs to the MCP transport branch (`y()` in `chunk-9mazb6vn.js`). It does not apply to the local private file mode.                                                                                                                                                                                                            |

### Context injection, tool state, and background execution

| Claude Code 2.1.296 mechanism                                            | Strategy                | How Pi Project Memory implements it and why                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------ | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Topic candidate directory and frontmatter header window                  | Keep                    | The scan keeps at most 200 candidates, sorted by `mtime` in descending order. For each file, it reads the first 30 lines and 65,536 bytes to parse the frontmatter `description`, `type`, and `modified`. If `modified` is missing or invalid, it falls back to `mtime`.                                                            |
| Recall history, full-read suppression, and reset after compaction        | Keep and adapt          | Changing a file removes its old read suppression. After the main session completes compaction (`session_compact`) or switches branches (`session_tree`), the recall budget, the read set, and the selector history are rebuilt or reset from the active branch.                                                                     |
| 48-hour staleness reminder and post-write format lint (lint)             | Adapt message mechanism | Staleness days are calculated as `Math.floor((Date.now() - mtimeMs) / 86_400_000) > 1`. This means a reminder appears only after at least 48 hours. The reminder and the post-write lint are added to the context through Pi's `tool_result` and hidden custom messages.                                                            |
| Plain-text read baseline (Read baseline)                                 | Keep                    | A background `read` with explicit `offset` and `limit` establishes a modification baseline. Multi-page ranges are not added together. A read that is automatically truncated by the default 2,000 line or 50 KiB window, or an image read, revokes the baseline. The main agent's full-read suppression is still judged separately. |
| Background sub-tasks do not pollute the main session transcript          | Adapt                   | The background tool loop is not appended to the main session transcript. Only a summary of file changes is sent to the main session as a hidden message. The extension process accumulates background tokens and cost, which `/memory status` displays.                                                                             |
| Private automatic compaction of the general fork                         | Exclude internal engine | The extension keeps extraction before main session compaction, cross-model signature cleanup, and the background `maxTurns` and `maxTokens` limits. It does not copy Claude's internal private fork compaction engine.                                                                                                              |
| Internal API retry policy and Sonnet candidate model routing             | Adapt public interfaces | It calls the models that the user configured or inherited through the Pi model registry. It keeps the native JSON Schema to `select_memories` tool downgrade retry on the same model. It does not switch models across providers or use built-in private retry routes.                                                              |
| Permission denial watchdog                                               | Exclude                 | Pi has no host-level deny and ask permission evaluator and no approval dialog. The extension limits background behavior through its own project trust, path containment, read baseline, file locks, and turn limits.                                                                                                                |
| `<cc-memory>` reference tag protocol                                     | Exclude                 | This XML tag depends on Claude-specific interface rendering and feature flags. Pi has no matching protocol.                                                                                                                                                                                                                         |
| Compact mode, team mounts, dedicated tool storage, and skill maintenance | Exclude                 | The extension implements only the local private file mode. It does not manage team or organization shared storage, custom agent memory, project skills, or `AGENTS.md`.                                                                                                                                                             |

## Compatibility summary

| Feature area                                                                     | Level of compatibility                                                                                                   |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Local directory structure, project key, index trimming, and automatic recall     | High. Matches the window constants, the UTF-16 and UTF-8 counting methods, and the backfill logic.                       |
| Static prompt baseline, selector schema, and lifecycle                           | High. Only four kinds of declared replacement and a one-line tool mode addition on the selector are allowed.             |
| User text filtering and extraction and consolidation cursor state machine        | High. Matches the traditional whitespace threshold, the three-word prose threshold, and the attempt time rollback rules. |
| Path containment, read baseline, cross-process locks, and session record reading | High. Uses deterministic checks and atomic publishing designed for the local file system.                                |
| Background tool names and parameter schemas                                      | Pi native interfaces. Reuses Pi's six native tools and the optional task-level codemode.                                 |
| Model routing and structured output fallback                                     | Adapts to the Pi model registry. Same-model tool fallback, with no cross-model fallback.                                 |
| General permission system for the main session (deny and ask)                    | Not applicable. Pi has no matching host design, and it is not this extension's responsibility.                           |
| BM25, account and team shared memory, and server-side Memory API                 | Not implemented.                                                                                                         |

## Target version boundary

The alignment baseline for this project is fixed at `@anthropic-ai/claude-code@2.1.296`. If a later Claude Code version changes its prompts, trigger thresholds, window sizes, output schema, or server protocol, first update the static reverse engineering evidence in `docs/research/`. Then update the code, the test fixtures, and this document.
