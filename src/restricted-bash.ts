import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type { BashToolOptions } from "@earendil-works/pi-coding-agent";
import fg from "fast-glob";
import { classifyReadOnlyBash } from "./bash-readonly.ts";
import { assertContainedMarkdown, VCS_METADATA_DIRECTORIES } from "./paths.ts";

export interface RestrictedBashPolicy {
	memoryDir: string;
	cwd: string;
	resolveReadablePath(path: string): Promise<string>;
	assertDirectoryRead?(path: string): Promise<void>;
}

export type PreparedBash =
	| { kind: "delete"; paths: string[] }
	| {
			kind: "execute";
			cwd: string;
			command: string;
			options: BashToolOptions;
			revalidate(): Promise<void>;
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

function shellWords(value: string): string[] {
	return value.match(/(?:'[^']*'|"(?:[^"\\]|\\.)*"|\S+)/g) ?? [];
}

function parseDelete(command: string, memoryDir: string): string[] | undefined {
	const match = /^\s*rm(?:\s+(.*))?\s*$/.exec(command);
	if (!match) return undefined;
	const paths: string[] = [];
	let operands = false;
	for (let raw of shellWords(match[1] ?? "")) {
		if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"')))
			raw = raw.slice(1, -1);
		if (!operands && raw === "--") {
			operands = true;
			continue;
		}
		if (!operands && raw === "-f") continue;
		if (!operands && raw.startsWith("-")) throw new Error("rm permits only -f");
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
	return paths;
}

async function assertNoEscapingSymlinks(policy: RestrictedBashPolicy, directory: string): Promise<void> {
	const matches = await fg("**/*", {
		cwd: directory,
		onlyFiles: false,
		followSymbolicLinks: false,
		dot: true,
		unique: true,
	});
	if (matches.length > 50_000) throw new Error("Symlink-following traversal exceeds the 50000-entry limit");
	for (const match of matches) {
		const candidate = resolve(directory, match);
		if ((await lstat(candidate)).isSymbolicLink()) await policy.resolveReadablePath(candidate);
	}
}

async function validateReadIntent(
	policy: RestrictedBashPolicy,
	cwd: string,
	value: string,
	glob: boolean,
	allowDirectory = true,
	followsSymlinks = false,
): Promise<void> {
	if (value === "-" || value === "/dev/null") return;
	let values = [value];
	if (glob) {
		if (value.startsWith("/") || value.split(/[\\/]/).includes(".."))
			throw new Error(`glob path is outside the allowed roots: ${value}`);
		values = await fg(value, { cwd, dot: true, followSymbolicLinks: false, unique: true });
		if (values.length === 0) throw new Error(`glob did not resolve to a readable path: ${value}`);
	}
	for (const candidate of values) {
		const canonical = await policy.resolveReadablePath(resolve(cwd, candidate));
		const info = await stat(canonical);
		if (!info.isDirectory()) continue;
		await policy.assertDirectoryRead?.(canonical);
		if (!allowDirectory) throw new Error(`Recursive directory reads are not allowed: ${value}`);
		if (!glob && followsSymlinks) await assertNoEscapingSymlinks(policy, canonical);
	}
}

async function assertSafeLocalGitConfig(cwd: string, policy: RestrictedBashPolicy): Promise<void> {
	const marker = join(cwd, ".git");
	let gitDir = marker;
	try {
		const metadata = await lstat(marker);
		if (metadata.isSymbolicLink()) throw new Error("Git metadata symlinks are not allowed");
		if (metadata.isFile()) {
			const pointer = await readFile(marker, "utf8");
			const match = /^gitdir:\s*(.+)\s*$/im.exec(pointer);
			if (!match?.[1]) throw new Error("invalid Git worktree metadata");
			gitDir = resolve(cwd, match[1]);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return;
	}
	const canonicalGitDir = await policy.resolveReadablePath(gitDir);
	const configPaths = [join(canonicalGitDir, "config")];
	try {
		const common = (await readFile(join(canonicalGitDir, "commondir"), "utf8")).trim();
		if (common) {
			const commonDir = await policy.resolveReadablePath(resolve(canonicalGitDir, common));
			configPaths.push(join(commonDir, "config"));
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	for (const configPath of new Set(configPaths)) {
		let content: string;
		try {
			content = await readFile(configPath, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		let section = "";
		for (const line of content.split(/\r?\n/)) {
			const header = /^\s*\[([^\]]+)]/.exec(line);
			if (header?.[1]) {
				section = header[1].trim().toLowerCase();
				if (section === "include" || section.startsWith("includeif "))
					throw new Error("Git config includes are not allowed for read-only Bash");
				continue;
			}
			const key = /^\s*([a-zA-Z][\w-]*)\s*=/.exec(line)?.[1]?.toLowerCase();
			if (
				key &&
				(((section.startsWith('filter "') || section.startsWith("filter.")) &&
					["clean", "smudge", "process"].includes(key)) ||
					((section.startsWith('diff "') || section.startsWith("diff.")) && ["command", "textconv"].includes(key)) ||
					section === "gpg" ||
					section.startsWith('gpg "') ||
					section.startsWith("gpg.") ||
					key === "showsignature" ||
					key === "gpgsign" ||
					key === "gpgformat")
			)
				throw new Error("Git config contains an executable helper or signature setting");
		}
	}
}

function followsSymlinks(name: string, argv: string[]): boolean {
	const args = argv.slice(1);
	if (name === "tree") return args.includes("-l");
	if (["fd", "fdfind", "rg"].includes(name)) return args.some((arg) => arg === "-L" || arg === "--follow");
	if (name === "find") return args[0] === "-L" || args.includes("-follow");
	if (["grep", "egrep", "fgrep"].includes(name))
		return args.some((arg) => arg === "-R" || arg === "--dereference-recursive");
	if (name === "du") return args.some((arg) => arg === "-L" || arg === "--dereference");
	return name === "ls" && args.some((arg) => /^-[A-Za-z]*R[A-Za-z]*$/.test(arg) && /L/.test(arg));
}

export async function prepareRestrictedBash(command: string, policy: RestrictedBashPolicy): Promise<PreparedBash> {
	if (command.includes("\0")) throw new Error("command contains a NUL byte");
	const deletePaths = parseDelete(command, policy.memoryDir);
	if (deletePaths) return { kind: "delete", paths: deletePaths };

	const decision = classifyReadOnlyBash(command, { platform: process.platform });
	if (!decision.readOnly) throw new Error(decision.reason);
	const cwd = await realpath(policy.cwd);
	const revalidate = async () => {
		let effectiveCwd = cwd;
		for (const parsed of decision.commands) {
			const commandCwd = effectiveCwd;
			const followsLinks = followsSymlinks(parsed.name, parsed.argv);
			for (const intent of parsed.workingDirectoryIntents ?? []) {
				await validateReadIntent(policy, effectiveCwd, intent.value, intent.glob);
				effectiveCwd = await policy.resolveReadablePath(resolve(effectiveCwd, intent.value));
			}
			if (parsed.name === "git") {
				await policy.assertDirectoryRead?.(effectiveCwd);
				await assertSafeLocalGitConfig(effectiveCwd, policy);
			}
			if (
				parsed.pathIntents.length === 0 &&
				["ls", "find", "tree", "du", "fd", "fdfind", "rg", "grep", "egrep", "fgrep"].includes(parsed.name)
			)
				await policy.assertDirectoryRead?.(effectiveCwd);
			if (followsLinks && parsed.pathIntents.length === 0) await assertNoEscapingSymlinks(policy, effectiveCwd);
			for (const intent of parsed.pathIntents) {
				await validateReadIntent(policy, effectiveCwd, intent.value, intent.glob, parsed.name !== "rg", followsLinks);
				if (parsed.name === "cd" && intent.access === "cwd")
					effectiveCwd = await policy.resolveReadablePath(resolve(effectiveCwd, intent.value));
			}
			if ((parsed.workingDirectoryIntents?.length ?? 0) > 0 && parsed.name !== "cd") effectiveCwd = commandCwd;
		}
	};
	await revalidate();
	return {
		kind: "execute",
		cwd,
		command,
		revalidate,
		options: { exposeSessionEnvironment: false },
	};
}
