# Windows support spec

Status: reduced scope from the closed wayfinder tickets for [Windows support map](https://github.com/fktpp2022/pi-project-memory/issues/1), for review in [Consolidated Windows support spec review](https://github.com/fktpp2022/pi-project-memory/issues/12). The requirements below do not claim completed implementation or verification.

Scope: basic native Windows support for `pi-project-memory` under Pi, with Git Bash optional for background work. macOS, Linux, and Termux behavior stays unchanged.

## 1. Supported matrix and install

| Axis | Target                                                 |
| ---- | ------------------------------------------------------ |
| OS   | Windows 10 22H2 and Windows 11                         |
| Arch | x64 and arm64                                          |
| Node | 22, 24, 26 (`engines.node >= 22.19.0`)                 |
| Pi   | The versions allowed by the existing peer dependencies |

- `package.json` includes `win32` in `os`, with no `cpu` restriction. `engines.node` and the `*` peer dependencies stay unchanged.
- `pi install git:...` and `pi install .` are supported install paths. `pi install npm:pi-project-memory` requires a release containing `win32` in its metadata.
- `tree-sitter` and `tree-sitter-bash` still load when `src/bash-readonly.ts` initializes. A missing or incompatible native binding fails extension load with the dependency's error, even without Git Bash.
- arm64 requires prebuild availability and a manual install smoke test because there is no arm64 CI runner. Windows Server is out of scope.

User-facing Windows support claims may ship once the required `windows-latest` jobs are green on `master`. Live Pi install and extension-load checks belong in the manual checklist.

## 2. Shell and background tools

### Detection and cache

Probe candidates in order:

1. User `shellPath`, when set.
2. `C:\Program Files\Git\bin\bash.exe`.
3. `%LOCALAPPDATA%\Programs\Git\bin\bash.exe`.
4. `where bash.exe`.

Validate candidates with `bash -c 'uname -s'`, accepting `MINGW*` or `MSYS*`. The legacy WSL launcher reports `Linux` and is rejected. An explicit `shellPath` is authoritative. If validation fails, disable background Bash and report the path and reason without falling through.

Cache availability until config reload or session restart. Installing or removing Git Bash does not trigger a probe on each background run. The tools and prompt stay fixed during a run, and removing the executable can cause Bash calls to fail as tool errors.

Background Bash does not honor `shellCommandPrefix`.

### Tools and prompts

- `createChildTools` returns `[read, write, edit, find, grep, bash]` with validated Git Bash and `[read, write, edit, find, grep]` without it. There is no stub Bash tool, and the codemode allowlist uses the same array.
- Native `read`/`find`/`grep` and extension `read`/`write`/`edit` remain available without Bash. Recall, `/memory`, extraction, and dream maintenance continue to work.
- `src/prompts.ts` and `src/child-codemode.ts` select their no-Bash text from the same availability result. The text removes read-only Bash and `bash rm` instructions and states that shell access is unavailable for the run.
- The with-Bash prompt fixtures remain unchanged. No-Bash fixtures cover both background roles and codemode `on` and `only` modes.

Native `grep` can exit 2 on ACL-denied files, which fails the background call rather than returning partial results.

### Notice and status

Show one TUI notice per Pi session on the first background run that would have offered Bash. Do not repeat it per project or persist it across sessions.

`/memory status` reports the selected Git Bash path, missing Bash with the tool disabled, or a rejected candidate with its path and reason. Status uses cached availability until config reload or session restart.

## 3. Windows paths

### Accepted forms

| Form                | Example                                | Handling                              |
| ------------------- | -------------------------------------- | ------------------------------------- |
| Native drive        | `C:\mem\a.md`                          | Native Windows form                   |
| Forward-slash drive | `C:/mem/a.md`                          | Normalize separators                  |
| Git Bash / MSYS     | `/c/mem/a.md`                          | Expand the drive prefix               |
| Cygwin              | `/cygdrive/c/mem/a.md`                 | Expand the drive prefix               |
| WSL drive path      | `/mnt/c/mem/a.md`                      | Expand the drive prefix               |
| Home                | `~`, `~/x`, `~\x`                      | Expand against the user profile       |
| Extended-length     | `\\?\C:\mem\a.md`, `\\?\UNC\srv\share` | Strip the prefix before normalization |
| UNC                 | `\\server\share\a.md`                  | Parse as an absolute Windows path     |

Windows normalization expands home and drive prefixes, normalizes separators, and resolves against the base. Canonical paths use native separators and on-disk casing. Reject drive-relative forms such as `C:foo` and `C:`, and reject `:` after the drive prefix to prevent alternate data streams. Do not expand `%VAR%`.

Use shared Windows normalization and containment rules in `resolveToolPath`, `configuredMemoryDirectory`, `assertContainedMarkdown`, `parseDelete`, and child-tool revalidation. Leave POSIX `memoryDir` resolution, namespace hashing, and display paths unchanged.

### Containment and casing

Resolve Windows memory roots and existing containing paths with `realpath`. Containment uses case-insensitive Windows path comparisons and filesystem checks. Apply the same rules to read, write, edit, delete, teardown, and index exclusion.

On Windows, `.md` and `MEMORY.md` comparisons are case-insensitive. Scanning uses a case-insensitive pattern and deduplicates by canonical path.

There is no fixed-drive restriction or PowerShell drive probe. Do not add hardcoded memory path, filename, or Bash working-directory length budgets. Filesystem and process errors report platform limits when encountered.

### Restricted Bash

Parse Bash commands as written, with normal Bash quoting and escaping. Do not rewrite backslashes before parsing. Model-authored paths should use forward slashes or MSYS form, or quote and escape native paths correctly.

Normalize parsed `rm` operands on a copy for validation. Accept drive paths, MSYS/Cygwin/WSL drive forms, and home-relative paths. Reject genuinely relative operands. Each operand must resolve to a Markdown file inside the memory root and outside protected subdirectories.

`rm` never executes through Bash. `prepareRestrictedBash` returns `kind: "delete"`, and `safeDeleteMemoryFile` performs deletion.

## 4. Storage and safety

### Filesystem errors and publication

Filesystem errors propagate immediately without automatic storage retries. Preserve the original error, including its code and paths. Callers can retry after closing file handles or resolving permission and sync conflicts.

Windows keeps `link` plus `EEXIST` for exclusive creation. The existing Android copy fallback stays unchanged. Replacement does not clear a read-only attribute. A failed replacement leaves the original content intact. Deletion uses Node's `fs.rm`, including its native Windows handling of read-only files.

Existing lock ownership, stale-lock recovery, payload compatibility, and PID behavior stay unchanged.

### Reparse points and no-follow checks

- Reject a Windows memory root that is itself a junction or symlink. POSIX continues to accept symlink memory roots.
- Snapshots use `followSymbolicLinks: false`. Storage reads reject Windows symlinks and junctions when scanning memory files.
- Storage reads check Windows ancestors with `lstat` before opening each file. Native tool reads keep their existing behavior, and writes remain inside memory. Deleting a symlink removes the link itself.
- Retain POSIX `O_NOFOLLOW`. The Windows check before opening leaves a race window that POSIX `O_NOFOLLOW` closes for the final entry.

### Permissions

Run `chmod` on POSIX only. Windows privacy relies on inherited user-profile ACLs, with no explicit ACL hardening. Documentation must not describe Windows directories as private because of POSIX mode bits.

## 5. Tests and CI

Required CI targets are `ubuntu-latest`, `macos-latest`, and `windows-latest` on Node 22/24/26, with `fail-fast: false`. Install `ripgrep` and `fd` on Windows. Git Bash must pass both shell detection and execution in the child-tool test rather than silently skipping it.

Use `.gitattributes` with `* text=auto eol=lf`. Do not normalize CRLF inside tests. Close watchers and child processes and leave temporary working directories before teardown. Node's bounded cleanup retries are limited to test helpers.

Keep shared storage tests on Windows. Skip POSIX-only permission assertions, `ulimit`, and `xargs` cases explicitly through a shared `skipOnWindows(reason)` helper, and document the reasons. Do not use silent `if (win32) return` exits.

Required coverage:

- Path tests cover accepted forms, drive-relative and ADS rejection, case-insensitive containment, `.MD`, and protected paths. Windows integration tests exercise read, write, edit, and delete, including junction rejection and read-only files.
- Both shell states cover memory operations and extraction/dream maintenance. No-Bash cases cover native search/read/edit/write, tool lists, allowlists, prompt variants, and codemode `on` and `only` for both background roles.
- Shell tests cover explicit invalid paths, WSL rejection, cached availability, refresh on config reload or session restart, and the once-per-session notice. Storage failures propagate immediately without recovery retries.
- The metadata test checks `win32` on every OS. Required Windows jobs must pass, and documented POSIX skips must match the tests.

## 6. Documentation and compatibility

This spec records the scope of the Windows adaptation. Windows support does not add a different storage protocol, migration, or recovery policy.

Privacy wording must explain that POSIX uses `0600`/`0700` mode bits, while Windows relies on inherited ACLs and receives no ACL hardening. Troubleshooting must match actual errors without promising custom retry messages or drive-policy errors.

Existing POSIX memory paths, project namespaces, migrations, locks, and state files remain compatible. Windows requires no migration from an earlier supported layout.

## 7. Manual acceptance

Pi installation and extension loading can be checked manually. They are not additional CI requirements for this PR. Native Windows arm64 execution remains unverified by CI.

On a clean Windows 11 x64 system:

1. Install through Pi and start in a Git repository. Recall should show no error with no existing memory.
2. Run `/memory extract` and `/memory dream`. Verify the topic, index, completed provider turns, and `lastDreamAt`.
3. With Git Bash, verify six tools, Bash execution, validated memory deletion, and the selected path in `/memory status`.
4. Make Git Bash unavailable and reload config or restart the session. Verify five tools, native memory operations, no-Bash prompts, the one-time notice, and disabled Bash status.
5. Restore Git Bash and reload config or restart the session. Verify Bash becomes available again. A change without reload or restart must retain cached availability.
6. Check accepted Windows paths, case differences, ADS rejection, junction rejection, and immediate filesystem errors without retries.
7. Remove the extension through Pi and verify memory files remain in place.

## 8. Out of scope

- PowerShell as a background shell, drive probing, fixed-drive restrictions, and explicit ACL hardening.
- Automatic storage retries, hardcoded path length budgets, Bash command rewriting, and unrelated lock or POSIX path changes.
- Windows Server, arm64 CI, WSL-specific behavior changes, and a broad cross-platform test rewrite.
- An upstream PR without an explicit user request.

Implementation work covers packaging, optional Git Bash, Windows paths and no-follow safety, and CI.
