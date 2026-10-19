# Development Guide

This guide is for developers who maintain or change Pi Project Memory. For installation, commands, and everyday use, read the [README](../README.md) and the [configuration reference](configuration.md) first.

## Development environment

This project uses `pnpm` to manage dependencies. The Pi runtime loads the TypeScript source directly through `jiti`, so no separate compile or bundle step is needed.

```bash
corepack enable
pnpm install
```

Your system needs `bash`, `git`, `rg` (ripgrep), and `fd` installed. The project declares `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `typebox` in `peerDependencies`, and the version range stays `*`. It installs specific versions in `devDependencies` for local development and tests. Do not put the Pi host core packages in the runtime `dependencies`.

## Development on Termux

Follow the [Termux installation instructions](../README.md#install-on-termux) for the runtime tools and native build dependencies. From a checkout in Termux's private storage, run `pnpm install` and `pnpm test` as usual. The test fixtures use Android's `/system/bin/sh` and find Bash through `PATH`. The hard-link replacement test skips only when Android policy denies the hard-link operation; exclusive creation, updates, and concurrency checks still run.

The pinned Biome and TypeScript 7 packages do not currently ship Android executables, so their npm wrappers cannot select a binary automatically in Termux. On the tested ARM64 device, Biome's Linux ARM64 musl static binary runs directly; set `BIOME_BINARY` to its absolute path to use it through the npm wrapper. TypeScript 7's Linux ARM64 binary is blocked by Android's system-call policy when run directly, but works inside a PRoot Linux environment. TypeScript 6.0.3 can also run directly through `pnpm --package=typescript@6.0.3 dlx tsc --noEmit` for an additional compatibility check; the project's pinned type checker remains TypeScript 7. These development-tool limitations do not affect Pi loading the extension's TypeScript source or running `pnpm test` in Termux.

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

| Path                     | Responsibility                                                                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `index.ts`               | Extension entry point. Registers Pi lifecycle hooks, the `/memory` command, the prefetch and maintenance scheduler, and the runtime state machine.                 |
| `src/config.ts`          | Default config (`DEFAULT_CONFIG`), field range validation, and loading of `~/.pi/agent/project-memory/config.json`.                                                |
| `src/models.ts`          | Role model resolution, selector native structured output with tool-mode fallback, message replay signature cleanup, and the background sub-agent loop.             |
| `src/prompts.ts`         | Assembly of the main agent, selector, extractor, and dream prompts. Also renders the index, recall messages, and staleness reminders.                              |
| `src/store.ts`           | `MEMORY.md` trimming and automatic backfill, topic scanning and recall, post-write lint, read baselines, atomic writes, cross-process locks, and session scanning. |
| `src/child-codemode.ts`  | Wrapper for the task-level background codemode extension, generation of the tool description prompt, and an isolated in-memory store for each task.                |
| `src/child-tools.ts`     | The six background tools (`read`, `find`, `grep`, `write`, `edit`, `bash`) wrapped from Pi native tool factories.                                                  |
| `src/bash-readonly.ts`   | Read-only shell command AST analyzer based on `tree-sitter-bash`, with an option allowlist for each command.                                                       |
| `src/restricted-bash.ts` | Parses restricted `rm` commands and applies read-only command classification.                                                                                      |
| `src/paths.ts`           | Canonical project root resolution (including Git worktree ownership), project key, collision-safe namespace reservation, and safe path helper functions.           |
| `src/sanitize.ts`        | Newline normalization, cleanup of dangerous control, format, and invisible characters, and escaping of reserved prompt tags (including homoglyph characters).      |
| `src/types.ts`           | TypeScript interfaces and type definitions shared inside the extension.                                                                                            |

## Automated test coverage

The `tests/` directory organizes unit and integration tests by module. All tests use local temporary directories and a Faux provider. They do not send paid external network requests.

- `tests/config.test.ts`: Tests separate role model settings, defaults, fallback for invalid numbers, consistency between `config.example.json` and `DEFAULT_CONFIG`, and the platform declaration in `package.json` (`darwin`, `linux`, and `android`).
- `tests/prompts.test.ts`: Compares `mainMemoryPrompt`, `SELECTOR_SYSTEM_PROMPT`, `extractionPrompt`, and `dreamPrompt` word for word with the `tests/fixtures/prompts/*.txt` baseline files. Checks the header of recall messages, staleness reminders, budget billing content, and sanitization of Unicode and disguised tags.
- `tests/models.test.ts`: Tests selector output parsing, native JSON Schema payload conversion for each API protocol, same-model fallback to the `select_memories` tool after client format errors, blocking of non-retryable errors such as authentication, rate limit, 5xx, and length truncation, query history retention, same-model `thinking` retention and cross-model signature stripping, passing of `ctx.cwd` to background sub-agents, and `maxTurns` boundaries.
- `tests/paths.test.ts`: Tests VCS directory segment detection, `autoMemoryDirectory` validity and fallback, shared `memory-roots` locks and consolidation state, rejection of namespace symbolic links, concurrent `.project-root` reservation, project key collision disambiguation, and sharing of one project identity across Git worktrees of the same checkout.
- `tests/store.test.ts`: Tests path shorthand normalization, `MEMORY.md` trimming at 200 lines and 25,000 UTF-16 code units, automatic backfill at 80%, 16-way concurrent scanning under low file descriptor limits, recall of 4,096-byte complete UTF-8 lines, compatibility with legacy flat frontmatter, hard-link-safe atomic replacement, exclusive new-file creation with private permissions, read baseline CAS conflict detection, migration of shared consolidation state, and cross-process lock leases.
- `tests/child-tools.test.ts`: Verifies native tool interfaces, parent working directories, read baselines, edit recovery, outside reads, and restricted deletion without prior reads.
- `tests/child-codemode.test.ts`: Verifies that background tasks wrap Pi native `codemode` in `on` and `only` modes, expose only the six restricted tools, isolate `store()` and `load()` within each task, relocate and clean up overflow output files, and immediately block calls when the generation becomes stale or the run is aborted during script execution.
- `tests/bash-readonly.test.ts` and `tests/search-boundaries.test.ts`: Verify read-only command classification, native `xargs` execution, search behavior, and session read access.
- `tests/claude-permissions.test.ts`: Verifies verbatim writes, original session access for both background roles, and read-only Git queries with local includes and helpers.
- `tests/concurrency.test.ts`: Uses multi-process workers (`lock-worker.ts` and `cas-worker.ts`) to verify cross-process lock mutual exclusion, recovery from locks held by dead processes, dream timestamp CAS, and file edit CAS under concurrency.
- `tests/lifecycle.test.ts`: Verifies the Pi hook lifecycle from end to end. It covers the project trust gate, lazy initialization with `enabled: false`, the 2-second prefetch wait and delayed `steer` delivery, the whitespace threshold for normal and queued input, deduplication of image normalization, full-read suppression and branch recovery, staleness reminders at 48 hours, post-write lint, deduplication when the main agent writes directly, the three-word user prose threshold, `trailingExtraction` triggered by new input, extraction before session compaction and state reset, retention and exception rollback of the dream attempt time, and in-process accumulation of background usage.

Cache regression coverage includes index snapshots and refresh boundaries, full selector catalogs with read filtering, short cache retention and stable session cache IDs, same-model parent prefixes and Faux cache hits, declared parent tools without executors, restricted writes, and independent-request fallback for model/schema differences, integer message limits, and image blocking. Faux hits validate request reuse, not real provider hit rates or billing.

If you change the construction of provider request parameters or the Pi SDK integration interface, run `pnpm check`. Then run an end-to-end manual check in an environment with real model credentials.

## Long-term architecture and maintenance constraints

The following rules are the long-term design boundaries of this project. Follow them when you change code or docs.

1. **Focus on alignment with the local private file mode**: The project aligns first with the local project memory file format, index and recall windows, selector, post-turn extraction, periodic dream consolidation, and lifecycle of Claude Code 2.1.296. BM25 is not implemented. Neither are features that depend on a server-side memory API. These include account memory, team or organization shared storage, `claude.ai` Project memory, server-side sync, embedding, ranking, and `memory_search`. Do not add these features through hidden switches or optional dependencies. Also, do not overstate partial similarity as full product compatibility.

2. **Keep the main session tools unchanged, and reuse Pi native tool factories in the background**: Do not register or override built-in tools with the same name in the main session. Background sub-agents always use `read`, `find`, `grep`, `write`, `edit`, and `bash` with Pi native names and schemas. When the main session enables `codemode`, they also use the task-level native `codemode`. That tool connects through the public `createCodemodeExtension()` and does not deep-import private Pi internal modules. Do not add a separate `Delete` tool or an unrestricted shell.

3. **Keep write boundaries and concurrency correctness**: Background changes are limited to lowercase `.md` files in memory. Keep project trust, edit read baselines, generation checks, file locks, and atomic publishing. Do not add fixed read directory allowlists or session exclusions, or block main-session writes because of maintenance or tags in the text.

4. **Strictly protect the static prompt baseline and the `docs/research/` boundary**:
   - `docs/research/` records only the reverse engineering conclusions, original prompts, tool definitions, and evidence for the Claude Code 2.1.296 binary. It must keep the original name `Claude Code` and the original text. It must not mix in Pi implementation or adaptation notes.
   - The static text of the four core runtime prompts (main memory, selector, extractor, and dream) must match `tests/fixtures/prompts/*.txt`. Only four kinds of replacement are allowed. `CLAUDE.md` becomes `AGENTS.md`, Pi tool and field names replace the originals, sections that only serve unsupported features are removed, and `Claude Code` becomes `the agent`. The selector tool mode also adds the fixed `select_memories` call instruction at the end. The separate `backgroundToolPrompt()` appends tool and codemode notes to the system prompt for independent requests, or to the final task message when preserving the parent prefix. Do not change the prompt baseline derived from Claude to fit host adaptations.

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
