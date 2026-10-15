# Configuration Reference and Storage Structure

This document describes in detail the structure of the user-level configuration file, field validation and fallback rules, the runtime parameters of each role, and the complete storage paths and file lifecycle on local disk.

## Config file location and loading rules

### 1. Config file path and `PI_CODING_AGENT_DIR`

The extension resolves the Pi user directory through `getAgentDir()`, which is exported by `@earendil-works/pi-coding-agent`. The config file path is always:

```text
<agentDir>/project-memory/config.json
```

In the default environment, `<agentDir>` is `~/.pi/agent`, so the default config file path is:

```text
~/.pi/agent/project-memory/config.json
```

If the environment variable `PI_CODING_AGENT_DIR` is set, `getAgentDir()` returns that custom directory. Note that the extension context in Pi 1.1.0 and later does not expose the `agentDir` passed to an SDK embedding call. So when Pi is embedded through the SDK with a custom agent directory, you must also set `PI_CODING_AGENT_DIR`. Otherwise, `getAgentDir()` still returns the default `~/.pi/agent`, and the extension reads and writes `~/.pi/agent/project-memory/`.

### 2. Config sources and per-field fallback rules

- **Only the user-level config file is read**: The extension reads configuration only from `<agentDir>/project-memory/config.json`. No project config file in the repository (such as a project config under `.pi/`), no CLI argument, and no separate environment variable can override config fields. This design makes sure that an untrusted or externally cloned repository cannot change the memory directory or the background model settings.
- **Default behavior when the file is missing**: When `config.json` does not exist (`ENOENT`), the extension uses the built-in `DEFAULT_CONFIG` directly. The values that `config.example.json` in the repository root parses to match `DEFAULT_CONFIG`.
- **JSON syntax errors or read failures**: If `config.json` exists but cannot be read, or its content is not valid JSON syntax, `loadConfig()` throws an error directly:
  - At session start (`session_start`), the error makes extension initialization fail.
  - When `/memory reload-config` runs, an error notification shows the reason for the failure. The extension keeps running with the last valid configuration.
- **Non-object top-level values and independent per-field fallback**: When the JSON parses successfully, `parseConfig()` validates each field without throwing exceptions:
  - If the top-level JSON value is not a plain object (for example, `null`, an array, or a primitive), the whole config falls back to `DEFAULT_CONFIG`.
  - If `models`, `extraction`, `dream`, or a role config object is not a plain object, that sub-block falls back to its own default values.
  - Each field is validated independently. A field falls back to its built-in default only when it is missing, has the wrong type, has an invalid format, or is outside the allowed integer range. Other valid sibling fields in the same object are not affected. Unknown extra fields are ignored.

### 3. Effective scope of config reload (`/memory reload-config`)

When you run `/memory reload-config`:

- Changes to `enabled`, `models.*`, `extraction.*`, and `dream.*` take effect **immediately**.
- If `enabled: true` is kept or set, the extension immediately stops the background extraction or consolidation sub-tasks that are running. It does this by incrementing `generation` and triggering an `AbortController`. It also cancels any prefetch that is waiting and any idle timer.
- If `enabled` changes from `true` to `false`, the extension stops background tasks. It clears the path references in memory and any pending updates. If `enabled` changes from `false` to `true`, the extension initializes the memory directory with the directory settings that the current session fixed.
- `autoMemoryDirectory` is fixed to `sessionMemoryDirectory` at each session start (`session_start`). If you change `autoMemoryDirectory` while a session is running and then run `/memory reload-config`, the current session's memory directory does **not** change. Existing files are not moved either. The command tells you that the change takes effect after the next session start.

## Configuration field reference

The table below lists all fields that `config.json` supports, with their types, default values, allowed values and ranges, and units:

| Field path                         | Type                  | Default     | Allowed values and constraints                                                                                              | Unit                                        | Summary                                                                                                                           |
| ---------------------------------- | --------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`                          | `boolean`             | `true`      | `true` or `false` (non-boolean values fall back to `true`)                                                                  | None                                        | Global switch for the extension. When it is off, directories are not parsed or created, and no automatic task runs.               |
| `autoMemoryDirectory`              | `string \| null`      | `null`      | `null`, or a valid absolute path or a path that starts with `~/` (blank strings and invalid paths fall back to the default) | None                                        | Overrides the default `memory/` storage directory of the project. Takes effect only at the next session start.                    |
| `models.selector.model`            | `string`              | `"inherit"` | `"inherit"`, or a string whose first `/` separates `provider` from a non-empty `model-id` (`model-id` may contain `/`)      | None                                        | Model used by the selector, which picks relevant memories.                                                                        |
| `models.selector.thinkingLevel`    | `string`              | `"off"`     | `"off"` \| `"minimal"` \| `"low"` \| `"medium"` \| `"high"` \| `"xhigh"` \| `"max"`                                         | None                                        | Thinking budget level for the selector. It is clamped automatically to the closest level the model supports.                      |
| `models.selector.maxTokens`        | `"inherit" \| number` | `512`       | `"inherit"`, or a safe integer from `64` to `65536`                                                                         | Output tokens                               | Maximum number of output tokens for one selector call.                                                                            |
| `models.selector.structuredOutput` | `boolean`             | `true`      | `true` or `false`                                                                                                           | None                                        | Whether to prefer the native JSON Schema output format for supported protocols.                                                   |
| `models.extractor.model`           | `string`              | `"inherit"` | `"inherit"`, or a string whose first `/` separates `provider` from a non-empty `model-id` (`model-id` may contain `/`)      | None                                        | Model used by the extractor, which runs after each turn.                                                                          |
| `models.extractor.thinkingLevel`   | `string`              | `"low"`     | `"off"` \| `"minimal"` \| `"low"` \| `"medium"` \| `"high"` \| `"xhigh"` \| `"max"`                                         | None                                        | Thinking budget level for the extractor.                                                                                          |
| `models.extractor.maxTokens`       | `"inherit" \| number` | `"inherit"` | `"inherit"`, or a safe integer from `64` to `65536`                                                                         | Output tokens                               | Maximum number of output tokens for one extractor model request.                                                                  |
| `models.dream.model`               | `string`              | `"inherit"` | `"inherit"`, or a string whose first `/` separates `provider` from a non-empty `model-id` (`model-id` may contain `/`)      | None                                        | Model used by dream, which runs periodic consolidation.                                                                           |
| `models.dream.thinkingLevel`       | `string`              | `"medium"`  | `"off"` \| `"minimal"` \| `"low"` \| `"medium"` \| `"high"` \| `"xhigh"` \| `"max"`                                         | None                                        | Thinking budget level for dream.                                                                                                  |
| `models.dream.maxTokens`           | `"inherit" \| number` | `"inherit"` | `"inherit"`, or a safe integer from `64` to `65536`                                                                         | Output tokens                               | Maximum number of output tokens for one dream model request.                                                                      |
| `extraction.enabled`               | `boolean`             | `true`      | `true` or `false`                                                                                                           | None                                        | Whether automatic extraction is on. When it is off, you can still run `/memory extract` by hand.                                  |
| `extraction.everyNTurns`           | `number`              | `1`         | A safe integer from `1` to `100`                                                                                            | Normally ended turns                        | Run automatic extraction after every this many settled turns.                                                                     |
| `extraction.idleFlushSeconds`      | `number`              | `120`       | A safe integer from `0` to `86400` (`0` disables idle extraction)                                                           | Seconds                                     | When the turn count has not reached `everyNTurns`, the idle time after which automatic extraction processes unprocessed messages. |
| `extraction.maxTurns`              | `number`              | `5`         | A safe integer from `1` to `8`                                                                                              | Sub-agent tool turns                        | Maximum number of model request and tool call loops for one extractor task.                                                       |
| `extraction.recentMessages`        | `"inherit" \| number` | `"inherit"` | `"inherit"`, or a safe integer from `3` to `1000`                                                                           | `user` or `assistant` messages              | Upper limit of recent conversation messages that go to the extractor each time.                                                   |
| `dream.enabled`                    | `boolean`             | `true`      | `true` or `false`                                                                                                           | None                                        | Master switch for dream. When it is off, automatic consolidation and manual `/memory dream` are both unavailable.                 |
| `dream.minimumHours`               | `number`              | `24`        | A safe integer from `1` to `8760`                                                                                           | Hours                                       | Minimum interval between two automatic consolidation attempts.                                                                    |
| `dream.minimumOtherSessions`       | `number`              | `5`         | A safe integer from `1` to `1000`                                                                                           | Sessions (not counting the current session) | Minimum number of other project sessions that must be updated after the last consolidation attempt before consolidation runs.     |
| `dream.scanThrottleSeconds`        | `number`              | `600`       | A safe integer from `0` to `86400` (`0` means no throttling)                                                                | Seconds                                     | Minimum interval between scans of the session directory within one process, after `minimumHours` is met.                          |
| `dream.maxTurns`                   | `number`              | `50`        | A safe integer from `1` to `50`                                                                                             | Sub-agent tool turns                        | Maximum number of model request and tool call loops for one dream task.                                                           |

## Details and relationships of each field

### 1. Global settings

#### `enabled`

- **Type**: `boolean`, default `true`.
- **Role and effects**: This is the highest-priority switch for the whole extension. When `enabled` is `false`:
  - At `session_start`, the extension does **not** call `resolveProjectPaths()` or `initializeProjectPaths()`. It does not create any project directory, state file, or lock directory on disk.
  - Even if `extraction.enabled` or `dream.enabled` is `true`, automatic recall, automatic extraction, manual `/memory extract`, automatic consolidation, manual `/memory dream`, and `/memory list` are all disabled.
  - Only `/memory status` (which shows `Auto-memory: disabled` and `Memory directory: not initialized`) and `/memory reload-config` are available.

#### `autoMemoryDirectory`

- **Type**: `string | null`, default `null`.
- **Role**: Overrides the default memory file directory. The default is `<agentDir>/project-memory/projects/<project-key>/memory`. Set this option to save `MEMORY.md` and all topic `.md` files in the directory you choose.
- **Two-level validation rules**:
  1. At the `parseConfig()` stage: If the value is not a string, or it is an empty string after `trim()`, the value becomes `null`.
  2. At the `resolveProjectPaths()` stage (`configuredMemoryDirectory()`): The extension checks whether the string is valid. If it does **not** meet any one of the following conditions, the extension does not throw an exception. It silently falls back to the project default `projects/<project-key>/memory` directory:
     - It must be an absolute path, or start with `~/` or `~\`.
     - If it starts with `~/`, the part after `~/` must not normalize to `.` or `..`, and it must not start with `../` or `..\`.
     - It must not contain a null byte `\0`.
     - After expansion and removal of the trailing slash, the path must be at least 3 characters long. It cannot be the root `/` or a Windows drive root such as `C:`.
     - No directory name in the path (split by `/` or `\`, case-insensitive) may be a version control metadata directory: `.git`, `.hg`, `.svn`, `.bzr`, `.jj`, or `.sl`.
  3. At the `initializeProjectPaths()` stage: If the target path already exists on disk as a symbolic link or as a non-directory file, initialization throws an error and refuses to run.

### 2. Model settings (`models`)

`models.selector`, `models.extractor`, and `models.dream` are completely independent of each other. For example, you can set a fast, low-cost model for the frequently used `selector`, and a model with stronger reasoning for `dream`.

#### Shared fields: `model`, `thinkingLevel`, `maxTokens`

- **`model`**:
  - When it is set to `"inherit"`, the extension uses the model that the current Pi main session is using (`ctx.model`). If the main session has no active model, the background task reports an error that no model is available.
  - When it is set to a string in `"provider/model-id"` format, the parser uses `indexOf("/")` to check that both sides of the first `/` are non-empty. `model-id` may contain more `/` characters. At run time, the extension splits the string at the first `/` into `provider` and `modelId`. It calls `ctx.modelRegistry.find(provider, modelId)` and then `ctx.modelRegistry.hasConfiguredAuth(model)`. If the string has no `/`, or the `/` is at the start or the end, the parser falls back to `"inherit"` during config parsing. If the format is valid but the model cannot be found or has no configured credentials, the extension sends a warning notification at run time and skips this task. It **never** falls back to `"inherit"` or another model.
- **`thinkingLevel`**:
  - Allowed values are `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, and `"max"`.
  - At run time, Pi's `clampThinkingLevel(model, configured)` maps the value to the closest level that the model actually supports. For example, a model that does not support reasoning is lowered to `"off"` automatically. When the effective level is `"off"`, the request does not send a `reasoning` parameter.
- **`maxTokens`**:
  - Allowed values are `"inherit"` or an integer from `64` to `65536`. A value outside that range, such as `32` or `100000`, falls back to the role's default. The selector falls back to `512`. The extractor and dream fall back to `"inherit"`.
  - When it is `"inherit"`, the call to `streamSimple()` does not pass `maxTokens`. The model or provider default limit applies.

#### `models.selector`-specific fields and behavior

- **`structuredOutput` (`boolean`, default `true`)**:
  - When this is `true` and the target model's `model.api` is one of the following 9 built-in protocols, the selector first sends a request with a native JSON Schema output constraint: `anthropic-messages`, `openai-completions`, `openai-responses`, `openai-codex-responses`, `azure-openai-responses`, `google-generative-ai`, `google-vertex`, `mistral-conversations`, and `bedrock-converse-stream`.
  - If the native request fails with a client format error (such as HTTP 400, 404, 405, 406, 415, or 422, or an error message that matches `structured_output`, `json_schema`, `response_format`, or `output_config`), the selector retries once on the **same model** in the constrained `select_memories` tool mode.
  - If the error is an authentication or permission failure (401 or 403), a timeout (408), a conflict or lock (409, 423, or 425), rate limiting (429), a server error (5xx), a network error, cancellation (`AbortError`), a safety refusal (refusal, content_filter, or safety), or output that was cut off because it reached `maxTokens` (`stopReason === "length"`), the selector does **not** retry in tool mode. It sends a warning and returns an empty selection `[]`.
  - If the native request returns successfully but the text is not valid `{"selected_memories": string[]}` JSON, the selector sends a warning and returns `[]`. It does not make a second tool request.
  - When `structuredOutput` is `false`, or when the model's API protocol is `pi-messages` or another custom API, the selector uses the `select_memories` tool mode directly. It does not send a native format probe request.
- **Interaction with `maxTokens`**: If you set `models.selector.thinkingLevel` to a value other than `"off"`, and the target protocol counts thinking tokens toward `maxTokens`, a small `maxTokens` can cause `stopReason: "length"`. In that case, the selector discards the output as a truncated failure, even when it already contains some valid JSON. So when you turn on selector thinking, increase `models.selector.maxTokens` to match.

#### Model switching effects for `models.extractor` and `models.dream`

When the model that the extractor or dream actually resolves to has the same `provider`, `api`, and `model.id` as the assistant model in the main session history, replaying the history keeps the hidden `thinking` blocks and their encrypted signatures. If any one of the three is different (for example, you set a different model for `extractor`), the extension removes all historical `thinking` blocks when it replays messages. It also removes `textSignature` and `thoughtSignature` from text blocks and tool call blocks. This prevents signature validation errors across models.

### 3. Extraction settings (`extraction`)

- **`enabled` (`boolean`, default `true`)**: Controls whether extraction runs automatically when a turn ends (`agent_settled`), when the session is idle (idle), before the session is compacted (`session_before_compact`), and when the session exits (`session_shutdown`). When it is `false`, all of these automatic triggers are off. However, you can still run `/memory extract` by hand (provided that the top-level `enabled` is `true` and the unprocessed messages pass the three-word user text threshold).
- **`everyNTurns` (`1` to `100`, default `1`)**: Run automatic extraction after every this many normally ended conversation turns. For example, if you set it to `3`, the extension does not extract right after turns 1 and 2. It starts an idle timer instead. It extracts immediately after turn 3 ends and resets the turn count to zero.
- **`idleFlushSeconds` (`0` to `86400`, default `120`, unit: seconds)**: Works together with `everyNTurns`. When `everyNTurns > 1` and the current accumulated turn count has not reached the threshold, or when the last extraction must be retried later because of a lock or a trailing extraction, the extension runs one extraction automatically if the session stays idle for `idleFlushSeconds` seconds. If you set it to `0`, the idle timer is turned off.
- **`maxTurns` (`1` to `8`, default `5`)**: Limits how many model call and tool execution loops the extractor sub-agent can run. The recommended strategy is to read all the memory files that might change in parallel during turn 1, and then write or edit in parallel during turn 2. If the model still returns tool calls on the last turn, the extension runs those tool calls and then ends the task. It does not send another model request.
- **`recentMessages` (`"inherit"` or `3` to `1000`, default `"inherit"`)**: Controls how many `user` and `assistant` messages from the unprocessed slice after the extraction cursor are sent to the extractor:
  - When it is `"inherit"`, all unprocessed messages after the cursor are sent.
  - When it is an integer `N` (from `3` to `1000`), the extension counts back from the end of the slice until it has `N` `user` or `assistant` messages. It keeps all `toolResult` messages between those `N` messages.

### 4. Dream settings (`dream`)

- **`enabled` (`boolean`, default `true`)**: The master gate for the Dream feature. Unlike `extraction.enabled`, when `dream.enabled` is `false`, automatic consolidation is turned off. Manual `/memory dream` is also refused, with the message `Memory dream is disabled by the global dream gate`.
- **`minimumHours` (`1` to `8760`, default `24`, unit: hours)**: The time threshold for automatic consolidation. The current time must be at least `minimumHours * 3600` seconds after the `lastDreamAt` value in the shared state file `state.json`.
- **`minimumOtherSessions` (`1` to `1000`, default `5`, unit: sessions)**: The session count threshold for automatic consolidation. After `minimumHours` is met, the extension scans the session directory for the current project. It counts files whose modification time (`mtimeMs`) is later than `lastDreamAt` and that are not the current session. It deduplicates them by the valid session header `id`. Automatic consolidation starts only when the number of other sessions reaches `minimumOtherSessions`. Manual `/memory dream` skips three thresholds: `minimumHours`, `minimumOtherSessions`, and `scanThrottleSeconds`. It still passes the list of recent session IDs it found to the dream model.
- **`scanThrottleSeconds` (`0` to `86400`, default `600`, unit: seconds)**: The throttle for directory scans within one process. When `minimumHours` has passed since the last consolidation attempt, but the number of other active sessions is still below `minimumOtherSessions`, the session directory is scanned again only after at least `scanThrottleSeconds` seconds within the same Pi process. This avoids walking the session directory at the end of every turn. If you set it to `0`, the scan runs on every turn.
- **`maxTurns` (`1` to `50`, default `50`)**: The maximum number of tool loop turns for the Dream sub-agent.

## Valid JSON configuration examples

### Example 1: Default configuration (matches `config.example.json`)

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

### Example 2: Per-role models, less frequent extraction, and a custom memory directory

The configuration below binds the frequently used `selector` to a lightweight model. It runs extraction every 3 turns (or after 300 seconds of idle time), and each extraction sees only the 20 most recent conversation messages. It also stores memory files in `~/notes/pi-memory`:

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

## Storage paths and directory structure

### 1. Full directory tree

After the extension is enabled in a trusted project, it uses the following file structure under `<agentDir>/project-memory/` (by default, `~/.pi/agent/project-memory/`) and under the operating system temporary directory:

```text
~/.pi/agent/project-memory/                  # Extension data root (controlled by PI_CODING_AGENT_DIR)
├── config.json                              # User-level config file (optional, created and edited by the user)
├── projects/                                # Namespace directory isolated for each project
│   ├── <project-key>/                       # Regular project namespace (the first project that reserved it successfully)
│   │   ├── .project-root                    # Namespace ownership marker (stores the canonical projectRoot as one line of text)
│   │   ├── state.json                       # Project-level state path in default mode (also the fallback source for legacy state migration)
│   │   ├── memory/                          # Project memory directory in default mode (when autoMemoryDirectory is null)
│   │   │   ├── MEMORY.md                    # Memory index file (trimmed before each request and injected into the system context)
│   │   │   ├── <topic>.md                   # Topic memory file (nested subdirectories are supported, such as nested/fact.md)
│   │   │   └── .<name>.<pid>.<uuid>.tmp     # Temporary file that exists briefly during an atomic write (deleted right after publishing)
│   │   └── stores/                          # State isolation directory used when a valid autoMemoryDirectory is configured
│   │       └── <memory-root-hash>/          # 24-character SHA-256 of the real path of the custom memory directory
│   │           └── state.json               # Project state file path in custom directory mode (paths.stateFile)
│   └── <project-key>-<project-root-hash>/   # Disambiguation namespace enabled automatically when the sanitized keys of two projects collide
│       └── ...                              # Structure is exactly the same as <project-key>/
└── memory-roots/                            # Coordination directory shared by each actual memory root
    └── <memory-root-hash>/                  # 24-character SHA-256 hash of the canonical memoryDir
        ├── state.json                       # Shared Dream consolidation state that is actually read and written (paths.dreamStateFile)
        └── locks/                           # Cross-process mutex directory (paths.locksDir)
            ├── extract.lock                 # Mutex for the background extraction task (timeout 15 minutes)
            ├── extract.lock.recover         # Arbitration lock that exists briefly when an expired extract.lock is taken over
            ├── dream.lock                   # Mutex for the background consolidation task (timeout 60 minutes)
            ├── dream.lock.recover           # Arbitration lock that exists briefly when an expired dream.lock is taken over
            ├── last-dream-at.lock           # CAS lock used when lastDreamAt in state.json is updated (timeout 1 minute)
            └── files/                       # Mutex directory for single-file writes, edits, and deletes
                └── <file-path-sha256>.lock  # File lock named by the SHA-256 of the target Markdown absolute path (timeout 15 minutes)

<autoMemoryDirectory>/                       # Custom memory directory when a valid autoMemoryDirectory is configured
├── MEMORY.md                                # Memory index file
└── *.md                                     # Topic memory files

<os.tmpdir()>/                               # Operating system temporary directory (created as needed during runs and deleted automatically afterward)
├── pi-project-memory-<random>/              # Private scratchDir for one extractor or dream run
│   ├── bash-<uuid>.log                      # Full output file that restricted Bash saves when output exceeds the inline length
│   └── codemode-<uuid>.txt                  # Full output file that background codemode saves when output exceeds the inline length
└── pi-project-memory-search-<random>/       # Temporary isolation directory for one background find or grep subprocess run
    └── bin/                                 # rg and fd wrapper scripts that inject boundary exclusion rules
```

### 2. Project ownership, `<project-key>` computation, and collision handling

1. **Resolve the canonical project root (`projectRoot`)**:
   - The extension first runs `realpath(resolve(cwd))` on the current working directory.
   - Then it runs `git -C <canonicalCwd> rev-parse --show-toplevel` and `--git-common-dir` in a clean environment. That environment disables the global and system Git config, hooks, and fsmonitor.
   - If the current directory is a linked working tree created with `git worktree`, its `--git-common-dir` points to the `.git` directory of the main checkout (that is, `basename(commonDir) === ".git"`). In that case, the extension uses `realpath(dirname(commonDir))` as the `projectRoot`. This lets the main checkout and all linked worktrees share one project identity and one memory.
   - For a bare repository or an unusual `.git` layout, the extension uses the real path from `--show-toplevel`. If the current directory is not inside a Git repository, or the `git` command fails, the extension uses `canonicalCwd`.
2. **Generate `<project-key>`**:
   - Replace every non-alphanumeric character (`[^a-zA-Z0-9]`) in `projectRoot` with `-`.
   - If the result is 200 characters or fewer, use it directly as the `projectKey`.
   - If it is longer than 200 characters, keep the first 200 characters and append `-<base36Hash(projectRoot)>`. `base36Hash` matches Claude Code 2.1.296. It uses the 32-bit signed Java `String.hashCode` algorithm and converts the unsigned result to a base-36 string.
3. **Namespace reservation and collision prevention (`.project-root`)**:
   - `/path/a-b` and `/path/a_b` both become `-path-a-b` after non-alphanumeric characters are replaced. So the extension uses the file `projects/<namespace>/.project-root` to stop different projects from overwriting each other.
   - The first time it accesses `projects/<project-key>/`, the extension creates `.project-root` in exclusive mode (`wx`, permissions `0600`). The content is `<projectRoot>\n`.
   - If `.project-root` already exists and records the same path as the current `projectRoot`, the extension keeps using `projects/<project-key>/`.
   - If `.project-root` records the root path of another project, a namespace collision has happened. The extension switches to `projects/<project-key>-<project-root-hash>/` automatically. `<project-root-hash>` is the first 24 hexadecimal characters of the SHA-256 of `projectRoot` after NFC normalization. The extension writes its own `.project-root` in that directory.
   - Compatibility migration: If an older version left `projects/<project-key>-<project-root-hash>/.project-root` that belongs to the current project, and the regular `projects/<project-key>/` directory is not yet in use, the extension renames that directory back to `projects/<project-key>/` atomically while it resolves paths.

### 3. Default vs. custom memory directories and the three `state.json` files

The extension manages the **project namespace** and the actual **memory root** separately:

- **Default directory mode (`autoMemoryDirectory: null`)**:
  - `paths.baseDir` is `projects/<namespace>`.
  - `paths.memoryDir` is `projects/<namespace>/memory`.
  - `paths.stateFile` is `projects/<namespace>/state.json`.
- **Custom directory mode (`autoMemoryDirectory` is a valid path)**:
  - `paths.memoryDir` is the expanded and normalized custom path.
  - The extension resolves the `realpath` of the deepest existing ancestor of `paths.memoryDir`, normalizes it with NFC, and computes a 24-character SHA-256. The result is `<memory-root-hash>`.
  - `paths.baseDir` is `projects/<namespace>/stores/<memory-root-hash>`. Initialization creates this private directory.
  - `paths.stateFile` is `projects/<namespace>/stores/<memory-root-hash>/state.json`.
- **Shared coordination directory (`memory-roots/<memory-root-hash>/`)**:
  - Whether the extension uses the default directory or a custom directory, it computes `<memory-root-hash>` from the canonical real path of `paths.memoryDir`. Then it sets:
    - `paths.dreamStateFile` to `memory-roots/<memory-root-hash>/state.json`.
    - `paths.locksDir` to `memory-roots/<memory-root-hash>/locks`.
  - This means that if you write the default path explicitly into `autoMemoryDirectory` (or point to the same directory through a symbolic link alias), or if two different projects mount the same shared memory directory through `autoMemoryDirectory`, they compute the same `<memory-root-hash>`. They then **automatically share one set of cross-process locks (`locks/`) and one Dream consolidation timestamp (`dreamStateFile`)**. The same memory directory is never consolidated by two runs at the same time.
- **The specific roles of the three `state.json` paths in the current implementation**:
  1. `memory-roots/<memory-root-hash>/state.json` (`paths.dreamStateFile`): This is the **only** state file that the current version actually writes. Its format is `{"schemaVersion": 1, "lastDreamAt": <millisecond timestamp>}`. Each time Dream acquires the lock and records an attempt time, or rolls back a time after a fork exception, it writes this file.
  2. `projects/<namespace>/state.json` (`paths.stateFile` in default mode) and `projects/<namespace>/stores/<memory-root-hash>/state.json` (`paths.stateFile` in custom mode): When `readState()` reads the consolidation state, the extension reads `paths.dreamStateFile` first. If `paths.dreamStateFile` does not exist (`ENOENT`), the extension falls back to reading `paths.stateFile`. It also reads the legacy field name `lastSuccessfulDreamAt`. This keeps the consolidation time records of the older version without loss.

### 4. Lock files, recovery locks, and temporary files

All lock files are in `memory-roots/<memory-root-hash>/locks/`. Each one contains `{"pid": <process ID>, "token": "<UUID>", "acquiredAt": <timestamp>}`:

- `extract.lock`: Makes sure that at most one process runs the extractor for the same memory root at any moment (the stale timeout is 15 minutes).
- `dream.lock`: Makes sure that at most one process runs dream for the same memory root at any moment (the stale timeout is 60 minutes).
- `last-dream-at.lock`: Provides short-lived mutual exclusion when `lastDreamAt` in `state.json` is updated with compare-and-swap (the stale timeout is 1 minute).
- `files/<sha256(resolve(filePath))>.lock`: A cross-process lock for one file. It is used when a background sub-agent writes, edits, or deletes a specific `.md` file (the stale timeout is 15 minutes).
- `*.lock.recover`: When a lock file is older than its stale timeout and the process with the original holder's `pid` no longer exists, the process that takes over the lock first creates the matching `.recover` file with `wx` to confirm the takeover. It removes the dead lock and then deletes the `.recover` file right away.
- `.<filename>.<pid>.<uuid>.tmp`: When `state.json` or a `.md` file in the memory directory is updated, the extension first creates a temporary `.tmp` file with permissions `0600` in the same directory as the target. It writes the complete content and checks it. Then it publishes the file with `link` followed by `rm` (creating a new file without overwriting), or with `rename` (atomically replacing an existing file). In the `finally` block, it always removes any leftover `.tmp` file.

### 5. Session directory source and read-only use

The extension **does not store** conversation transcripts. Instead, it uses `ctx.sessionManager.getSessionDir()` from the Pi session manager to get the original session directory of the current project. That directory contains the `*.jsonl` session files that Pi generates:

- **Use in Dream**:
  1. Scheduling: The Dream scheduler reads the `.jsonl` files under `sessionDir` as read-only. For each file, it reads the first JSON header line within the first 16 KiB. The header must have `type === "session"`, and its `id` must match the safe character syntax `/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/`. The scheduler excludes the current session and counts the other sessions with `mtimeMs > lastDreamAt`. If the host uses a shared custom session directory (`usesDefaultSessionDir()` returns `false`), the scheduler also parses the `cwd` field in the header and counts only the sessions that belong to the current project's `projectRoot`.
  2. Execution: `sessionDir` is added to the approved read-only roots of the dream sub-agent. The list of selected recent session IDs is written into the dream prompt. The dream sub-agent can use `read`, `find`, `grep`, or restricted read-only `bash` to search the historical context by keyword in the original `sessionDir`. The tool layer rejects any write or delete operation aimed at `sessionDir`.
- **Exclusion rule in the extractor**: The extractor's input comes directly from the in-memory session message projection (`buildSessionProjection()`). It does not need to read historical session files from disk, and it is not allowed to. So `sessionDir` is explicitly added to the extractor's `excludedReadRoots`. Even when `sessionDir` is inside the project directory, the extractor's file tools and explicit Bash path checks block reads from it. Bash uses native command execution, so paths produced by `xargs` at runtime are not checked.

### 6. File lifecycle, cleanup, and user-editable scope

- **Temporary resources that are cleaned up automatically**:
  - Each background extractor or dream run creates `<tmpdir>/pi-project-memory-<random>/`. It contains the controlled command directory and any overflow tool output logs. The directory is deleted completely with `rm(..., { recursive: true, force: true })` in the `finally` block when that sub-task ends.
  - Each background `find` or `grep` search creates `<tmpdir>/pi-project-memory-search-<random>/`. It is deleted recursively right after that search subprocess exits.
  - Normally released `.lock`, `.lock.recover`, and `.tmp` files are deleted as soon as the related operation ends.
- **Files that persist (the extension never deletes them silently in the background)**:
  - `config.json`, `projects/<namespace>/`, `memory-roots/<memory-root-hash>/`, and the `.md` files under `memory/` stay on disk for a long time.
  - Uninstalling the extension, running `/memory reload-config`, or setting `enabled` to `false` does **not** delete existing project memory directories or history files automatically.
  - Only the main model, or the background extractor or dream after checking conversation instructions and facts, deletes outdated or wrong topic `.md` files through controlled tools.
- **Scope that is safe to view and edit by hand**:
  - **Safe to edit**:
    1. `~/.pi/agent/project-memory/config.json`: You can edit it at any time by hand. After you save, run `/memory reload-config` or restart Pi.
    2. `MEMORY.md` and all topic `.md` files in the memory directory (by default `~/.pi/agent/project-memory/projects/<project-key>/memory/`, or the custom `autoMemoryDirectory`): You can view, add, change, or delete them at any time with any text editor. Before each request and before each turn settles, the extension uses file snapshots (`snapshotMarkdown`) to detect external changes automatically. It refreshes the read suppression state. If the main model has already loaded a changed file, the extension tells the main model to read it again. Keep file names ending in lowercase `.md`. Do not replace a `.md` file in the memory directory with a symbolic link that points outside it. Do not put topic files under reserved subdirectory names such as `.git`, `agents`, `skills`, or `node_modules`.
  - **Do not edit by hand**:
    - `.project-root`: Changing it causes the project namespace check to fail, or it is treated as a collision.
    - `state.json`: If you write invalid JSON or an unsupported `schemaVersion` by hand, the Dream scheduler stops with an error. This protection stops a damaged state from being overwritten silently.
    - `.lock` and `.recover` files under `locks/`: The extension manages them automatically. Do not touch them unless you are sure that every Pi process has exited.
