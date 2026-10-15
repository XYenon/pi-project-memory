# Development Guide

This guide is for developers who maintain or change Pi Project Memory. For installation, commands, and everyday use, read the [README](../README.md) and the [configuration reference](configuration.md) first.

## Development environment

This project uses `pnpm` to manage dependencies. The Pi runtime loads the TypeScript source directly through `jiti`, so no separate compile or bundle step is needed.

```bash
corepack enable
pnpm install
```

Your system needs `bash`, `git`, `rg` (ripgrep), and `fd` installed. The project declares `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `typebox` in `peerDependencies`, and the version range stays `*`. It installs specific versions in `devDependencies` for local development and tests. Do not put the Pi host core packages in the runtime `dependencies`.

## Common validation and test commands

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm check
```

`pnpm check` is the full gate. It runs these steps in order:

1. `biome check . --error-on-warnings` (checks the format and code rules for TypeScript and JSON)
2. `markdownlint-cli2 "**/*.md"` (checks Markdown rules)
3. `prettier --check "**/*.md"` (checks Markdown format)
4. `pnpm typecheck` (runs the `tsc --noEmit` type check)
5. `pnpm test` (runs `tests/*.test.ts` with the Node.js built-in test runner)

To format or fix code automatically, run:

```bash
pnpm format
pnpm lint:fix
```

Note: The research documents under `docs/research/**` are bound by version evidence. When you change non-research documents, run `prettier --write` and `markdownlint-cli2` only on the target Markdown files. Do not change any file under `docs/research/`.

## Local manual loading and debugging

Start Pi from the repository root and load the current workspace extension:

```bash
pi --extension ./index.ts
```

To check quickly in offline mode that the extension entry point initializes, run:

```bash
PI_OFFLINE=1 pi --no-extensions --extension ./index.ts --list-models __no_such_model__
```

This command should load `index.ts` without an extension initialization error. At the end, it only reports that no matching model was found.

## Code structure

| Path                           | Responsibility                                                                                                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`                     | Extension entry point. Registers Pi lifecycle hooks, the `/memory` command, the prefetch and maintenance scheduler, and the runtime state machine.                        |
| `src/config.ts`                | Default config (`DEFAULT_CONFIG`), field range validation, and loading of `~/.pi/agent/project-memory/config.json`.                                                       |
| `src/models.ts`                | Role model resolution, selector native structured output with tool-mode fallback, message replay signature cleanup, and the background sub-agent loop.                    |
| `src/prompts.ts`               | Assembly of the main agent, selector, extractor, and dream prompts. Also renders the index, recall messages, and staleness reminders.                                     |
| `src/store.ts`                 | `MEMORY.md` trimming and automatic backfill, topic scanning and recall, post-write lint, read baselines, atomic writes, cross-process locks, and session scanning.        |
| `src/child-codemode.ts`        | Wrapper for the task-level background codemode extension, generation of the tool description prompt, and an isolated in-memory store for each task.                       |
| `src/child-tools.ts`           | The six background tools (`read`, `find`, `grep`, `write`, `edit`, `bash`) wrapped from Pi native tool factories.                                                         |
| `src/native-search.ts`         | Runs native `find` and `grep` searches in a separate process. Limits output size and cleans up on timeout.                                                                |
| `src/native-search-worker.mjs` | Entry point for the search process. Fixes a clean environment, disables external ripgrep config and symbolic link following, and injects exclusion rules for directories. |
| `src/bash-readonly.ts`         | Read-only shell command AST analyzer based on `tree-sitter-bash`, with an option allowlist for each command.                                                              |
| `src/restricted-bash.ts`       | Background `bash` policy. Parses `rm` delete commands, checks the intent of read paths, inspects `.git/config`, and builds the controlled `PATH`.                         |
| `src/paths.ts`                 | Canonical project root resolution (including Git worktree ownership), project key, collision-safe namespace reservation, and safe path helper functions.                  |
| `src/sanitize.ts`              | Newline normalization, cleanup of dangerous control, format, and invisible characters, and escaping of reserved prompt tags (including homoglyph characters).             |
| `src/types.ts`                 | TypeScript interfaces and type definitions shared inside the extension.                                                                                                   |

## Automated test coverage

The `tests/` directory organizes unit and integration tests by module. All tests use local temporary directories and a Faux provider. They do not send paid external network requests.

- `tests/config.test.ts`: Tests separate role model settings, defaults, fallback for invalid numbers, consistency between `config.example.json` and `DEFAULT_CONFIG`, and the platform declaration in `package.json` (`darwin` and `linux`).
- `tests/prompts.test.ts`: Compares `mainMemoryPrompt`, `SELECTOR_SYSTEM_PROMPT`, `extractionPrompt`, and `dreamPrompt` word for word with the `tests/fixtures/prompts/*.txt` baseline files. Checks the header of recall messages, staleness reminders, budget billing content, and sanitization of Unicode and disguised tags.
- `tests/models.test.ts`: Tests selector output parsing, native JSON Schema payload conversion for each API protocol, same-model fallback to the `select_memories` tool after client format errors, blocking of non-retryable errors such as authentication, rate limit, 5xx, and length truncation, query history retention, same-model `thinking` retention and cross-model signature stripping, passing of `ctx.cwd` to background sub-agents, and `maxTurns` boundaries.
- `tests/paths.test.ts`: Tests VCS directory segment detection, `autoMemoryDirectory` validity and fallback, shared `memory-roots` locks and consolidation state, rejection of namespace symbolic links, concurrent `.project-root` reservation, project key collision disambiguation, and sharing of one project identity across Git worktrees of the same checkout.
- `tests/store.test.ts`: Tests path shorthand normalization, `MEMORY.md` trimming at 200 lines and 25,000 UTF-16 code units, automatic backfill at 80%, 16-way concurrent scanning under low file descriptor limits, recall of 4,096-byte complete UTF-8 lines, compatibility with legacy flat frontmatter, hard-link-safe atomic replacement, read baseline CAS conflict detection, migration of shared consolidation state, and cross-process lock leases.
- `tests/child-tools.test.ts`: Verifies the Pi native names and schemas of the six background tools, inheritance of the parent session's `ctx.cwd`, explicit paged reads that establish a baseline while automatic truncation or image reads revoke it, rejection of `.pdf` and `.ipynb` files, `edit` with multiple changes and `staleRecovered` recovery, approved read roots and session directory exclusion, and the baseline and protected subdirectory limits for `bash rm`.
- `tests/child-codemode.test.ts`: Verifies that background tasks wrap Pi native `codemode` in `on` and `only` modes, expose only the six restricted tools, isolate `store()` and `load()` within each task, relocate and clean up overflow output files, and immediately block calls when the generation becomes stale or the run is aborted during script execution.
- `tests/bash-readonly.test.ts` and `tests/search-boundaries.test.ts`: Verify read-only command and argument classification for `tree-sitter-bash`, blocking of dangerous Git configuration, native `xargs` execution after static validation, ignoring of the host `RIPGREP_CONFIG_PATH` with the `--follow` setting, and dream's read-only access to the original session directory.
- `tests/concurrency.test.ts`: Uses multi-process workers (`lock-worker.ts` and `cas-worker.ts`) to verify cross-process lock mutual exclusion, recovery from locks held by dead processes, dream timestamp CAS, and file edit CAS under concurrency.
- `tests/lifecycle.test.ts`: Verifies the Pi hook lifecycle from end to end. It covers the project trust gate, lazy initialization with `enabled: false`, the 2-second prefetch wait and delayed `steer` delivery, the whitespace threshold for normal and queued input, deduplication of image normalization, full-read suppression and branch recovery, staleness reminders at 48 hours, post-write lint, deduplication when the main agent writes directly, the three-word user prose threshold, `trailingExtraction` triggered by new input, extraction before session compaction and state reset, retention and exception rollback of the dream attempt time, and in-process accumulation of background usage.

If you change the construction of provider request parameters or the Pi SDK integration interface, run `pnpm check`. Then run an end-to-end manual check in an environment with real model credentials.

## Long-term architecture and maintenance constraints

The following rules are the long-term design boundaries of this project. Follow them when you change code or docs.

1. **Focus on alignment with the local private file mode**: The project aligns first with the local project memory file format, index and recall windows, selector, post-turn extraction, periodic dream consolidation, and lifecycle of Claude Code 2.1.296. BM25 is not implemented. Neither are features that depend on a server-side memory API. These include account memory, team or organization shared storage, `claude.ai` Project memory, server-side sync, embedding, ranking, and `memory_search`. Do not add these features through hidden switches or optional dependencies. Also, do not overstate partial similarity as full product compatibility.

2. **Keep the main session tools unchanged, and reuse Pi native tool factories in the background**: Do not register or override built-in tools with the same name in the main session. Background sub-agents always use `read`, `find`, `grep`, `write`, `edit`, and `bash` with Pi native names and schemas. When the main session enables `codemode`, they also use the task-level native `codemode`. That tool connects through the public `createCodemodeExtension()` and does not deep-import private Pi internal modules. Do not add a separate `Delete` tool or an unrestricted shell.

3. **Keep application-level boundaries and concurrency correctness, and do not overstate them as an operating system sandbox**: The `cwd` of Pi native tools is not a security boundary. The outer layer of the background tools must keep project trust, approved read roots, containment checks that limit writes to lowercase `.md` files in the memory directory, symbolic link rejection, the plain-text read baseline, generation checks, cross-process locks, and atomic replacement. The restricted `bash` must keep AST classification, the command argument allowlist, explicit path checks before native execution, and exclusion rules for the separate search subprocess. Do not limit search by temporarily changing `process.env` in the main process. These mechanisms limit what background tools can do and keep concurrent access safe. Do not describe them in the docs as a full OS-level sandbox that resists malicious processes running as the same user.

4. **Strictly protect the static prompt baseline and the `docs/research/` boundary**:
   - `docs/research/` records only the reverse engineering conclusions, original prompts, tool definitions, and evidence for the Claude Code 2.1.296 binary. It must keep the original name `Claude Code` and the original text. It must not mix in Pi implementation or adaptation notes.
   - The static text of the four core runtime prompts (main memory, selector, extractor, and dream) must match `tests/fixtures/prompts/*.txt`. Only four kinds of replacement are allowed. `CLAUDE.md` becomes `AGENTS.md`, Pi tool and field names replace the originals, sections that only serve unsupported features are removed, and `Claude Code` becomes `the agent`. The selector tool mode also adds the fixed `select_memories` call instruction at the end. The background tool list and codemode notes are appended to the end of the system prompt through a separate `backgroundToolPrompt()`. Do not change the prompt baseline derived from Claude to fit host adaptations.

5. **Keep config, dependencies, and tests in sync**:
   - The parsed values of `config.example.json` must match `DEFAULT_CONFIG` in `src/config.ts`.
   - `enabled: false` must take effect before project paths are resolved and directories are created.
   - Dependency versions use `^` (caret range), and `peerDependencies` stays `*`. Dependencies that run install build scripts must be listed by package name in `allowBuilds` in `pnpm-workspace.yaml`. Do not allow them globally.
   - Any runtime behavior change must update the automated tests and the user-facing or maintainer-facing docs in the same commit.

## Pre-release checks

The GitHub repository for this project is `XYenon/pi-project-memory`. The npm package name is `pi-project-memory`. Before you publish manually, confirm that the working tree is clean and run:

```bash
pnpm check
pnpm pack --dry-run
```

Check the file list from `pnpm pack --dry-run`. It should include `index.ts`, `src/`, `docs/`, `config.example.json`, `LICENSE`, and `package.json`. Confirm that the version number and license information are correct before you publish.
