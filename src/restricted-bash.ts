import { realpath } from "node:fs/promises";
import { relative, resolve, sep, win32 } from "node:path";
import type { BashToolOptions } from "@earendil-works/pi-coding-agent";
import { classifyReadOnlyBash, parseStaticBashCommand } from "./bash-readonly.ts";
import { assertBashCwdBudget, assertContainedMarkdown, normalizePathLexical, VCS_METADATA_DIRECTORIES } from "./paths.ts";

export interface RestrictedBashPolicy {
	memoryDir: string;
	cwd: string;
}

export type PreparedBash =
	| { kind: "delete"; paths: string[]; force: boolean }
	| {
			kind: "execute";
			cwd: string;
			command: string;
			options: BashToolOptions;
	  };

const PROTECTED_MEMORY_DIRECTORIES = new Set([
	...VCS_METADATA_DIRECTORIES,
	".claude",
	".cargo",
	".devcontainer",
	".githooks",
	".husky",
	".idea",
	".mvn",
	".vscode",
	".yarn",
	"agents",
	"commands",
	"config",
	"head",
	"hooks",
	"node_modules",
	"objects",
	"refs",
	"skills",
]);

const WINDOWS_ABSOLUTE_OPERAND = /^(?:[a-zA-Z]:[\\/]|[\\/]|~(?:[\\/]|$))/;

/** Operand forms are absolute on POSIX; Windows also accepts drive and home forms. */
function isAbsoluteOperand(operand: string, platform: NodeJS.Platform): boolean {
	return platform === "win32" ? WINDOWS_ABSOLUTE_OPERAND.test(operand) : operand.startsWith("/");
}

function parseDelete(
	command: string,
	memoryDir: string,
	platform: NodeJS.Platform,
): { paths: string[]; force: boolean } | undefined {
	// On Windows the typed command often uses backslash paths, but the bash
	// grammar treats `\` as an escape, so `C:\Users\...` parses to `C:Users...`
	// and loses its drive/root. Forward slashes are valid path separators on
	// Windows, so normalize them before parsing without touching semantics of
	// flags (which never contain backslashes).
	const parsedCommand = platform === "win32" ? command.replace(/\\/g, "/") : command;
	const argv = parseStaticBashCommand(parsedCommand);
	if (argv?.[0] !== "rm") return undefined;
	const paths: string[] = [];
	let operands = false;
	let force = false;
	for (const raw of argv.slice(1)) {
		if (!operands && raw === "--") {
			operands = true;
			continue;
		}
		if (!operands && (raw === "-f" || raw === "--force")) {
			force = true;
			continue;
		}
		if (!operands && raw.startsWith("-")) throw new Error("rm permits only -f or --force");
		if (!isAbsoluteOperand(raw, platform)) throw new Error("rm requires absolute, non-glob Markdown paths");
		// Normalize without resolving symlinks so a memory-internal link stays the
		// link itself. The typed command is never rewritten; `path` is only used for
		// validation and the delete call.
		const normalized = normalizePathLexical(memoryDir, raw, platform);
		if (/[*?[]/.test(normalized)) throw new Error("rm requires absolute, non-glob Markdown paths");
		const path = assertContainedMarkdown(memoryDir, normalized, platform);
		const flavor = platform === "win32" ? win32 : undefined;
		const relativePath = flavor ? flavor.relative(flavor.resolve(memoryDir), path) : relative(resolve(memoryDir), path);
		if (
			(flavor ? relativePath.split(/[\\/]+/) : relativePath.split(sep)).some((segment) =>
				PROTECTED_MEMORY_DIRECTORIES.has(segment.toLowerCase()),
			)
		)
			throw new Error("rm cannot delete from a protected memory subdirectory");
		paths.push(path);
	}
	if (paths.length === 0) throw new Error("rm requires at least one Markdown path");
	return { paths, force };
}

export async function prepareRestrictedBash(
	command: string,
	policy: RestrictedBashPolicy,
	platform: NodeJS.Platform = process.platform,
): Promise<PreparedBash> {
	if (command.includes("\0")) throw new Error("command contains a NUL byte");
	const deletePaths = parseDelete(command, policy.memoryDir, platform);
	if (deletePaths) return { kind: "delete", ...deletePaths };

	const decision = classifyReadOnlyBash(command, { platform });
	if (!decision.readOnly) throw new Error(decision.reason);
	const cwd = await realpath(policy.cwd);
	assertBashCwdBudget(cwd, platform);
	return {
		kind: "execute",
		cwd,
		command,
		options: { exposeSessionEnvironment: false },
	};
}
