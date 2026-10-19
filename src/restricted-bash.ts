import { realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import type { BashToolOptions } from "@earendil-works/pi-coding-agent";
import { classifyReadOnlyBash, parseStaticBashCommand } from "./bash-readonly.ts";
import { assertContainedMarkdown, VCS_METADATA_DIRECTORIES } from "./paths.ts";

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

function parseDelete(command: string, memoryDir: string): { paths: string[]; force: boolean } | undefined {
	const argv = parseStaticBashCommand(command);
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
		if (!raw.startsWith("/") || /[*?[]/.test(raw)) throw new Error("rm requires absolute, non-glob Markdown paths");
		const path = assertContainedMarkdown(memoryDir, raw);
		if (
			relative(resolve(memoryDir), path)
				.split(sep)
				.some((segment) => PROTECTED_MEMORY_DIRECTORIES.has(segment.toLowerCase()))
		)
			throw new Error("rm cannot delete from a protected memory subdirectory");
		paths.push(path);
	}
	if (paths.length === 0) throw new Error("rm requires at least one Markdown path");
	return { paths, force };
}

export async function prepareRestrictedBash(command: string, policy: RestrictedBashPolicy): Promise<PreparedBash> {
	if (command.includes("\0")) throw new Error("command contains a NUL byte");
	const deletePaths = parseDelete(command, policy.memoryDir);
	if (deletePaths) return { kind: "delete", ...deletePaths };

	const decision = classifyReadOnlyBash(command, { platform: process.platform });
	if (!decision.readOnly) throw new Error(decision.reason);
	return {
		kind: "execute",
		cwd: await realpath(policy.cwd),
		command,
		options: { exposeSessionEnvironment: false },
	};
}
