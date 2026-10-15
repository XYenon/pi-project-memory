import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { chmod, lstat, mkdir, readFile, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { type BashToolOptions, getAgentDir } from "@earendil-works/pi-coding-agent";
import fg from "fast-glob";
import { classifyReadOnlyBash } from "./bash-readonly.ts";
import { assertContainedMarkdown, canonicalizeReadRoots, isContainedPath, VCS_METADATA_DIRECTORIES } from "./paths.ts";

export interface RestrictedBashPolicy {
	memoryDir: string;
	cwd: string;
	scratchDir?: string;
	resolveReadablePath(path: string): Promise<string>;
	canonicalReadRoots(): Promise<string[]>;
	assertDirectoryRead?(path: string): Promise<void>;
	excludedReadRoots?: string[];
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

const SHELL_BUILTINS = new Set([
	"alias",
	"builtin",
	"cd",
	"command",
	"echo",
	"false",
	"help",
	"history",
	"printf",
	"pwd",
	"true",
	"type",
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

export function resolveTrustedCommand(name: string, cwd: string): string | undefined {
	const home = homedir();
	const userRoots = [
		join(getAgentDir(), "bin"),
		join(home, ".local", "bin"),
		join(home, ".local", "share", "cargo", "bin"),
		join(home, ".local", "share", "go", "bin"),
		join(home, ".local", "lib", "kache", "shims"),
		join(home, ".nix-profile", "bin"),
		...(process.env.USER ? [`/etc/profiles/per-user/${process.env.USER}/bin`] : []),
	];
	const trustedTarget = (path: string, source: string) =>
		["/usr/bin/", "/bin/", "/usr/sbin/", "/sbin/"].some((prefix) => path.startsWith(prefix)) ||
		path.startsWith("/nix/store/") ||
		path.startsWith("/opt/homebrew/Cellar/") ||
		path.startsWith("/usr/local/Cellar/") ||
		path.startsWith("/Applications/Docker.app/") ||
		path.startsWith("/Applications/OrbStack.app/") ||
		userRoots.includes(source);
	for (const directory of [
		...(process.env.PATH ?? "").split(delimiter),
		...userRoots,
		"/usr/bin",
		"/bin",
		"/usr/sbin",
		"/sbin",
	]) {
		if (!directory?.startsWith("/")) continue;
		try {
			const canonical = realpathSync(join(directory, name));
			const info = statSync(canonical);
			accessSync(canonical, constants.X_OK);
			if (
				info.isFile() &&
				(info.mode & 0o022) === 0 &&
				trustedTarget(canonical, directory) &&
				!isContainedPath(cwd, canonical)
			)
				return canonical;
		} catch {}
	}
	return undefined;
}

function quote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function installControlledCommands(
	policy: RestrictedBashPolicy,
	cwd: string,
	commandNames: readonly string[],
	controlledXargs: boolean,
): Promise<string> {
	if (!policy.scratchDir) throw new Error("Restricted Bash requires a private scratch directory");
	const directory = join(policy.scratchDir, "controlled-bin");
	await mkdir(directory, { recursive: true, mode: 0o700 });
	for (const name of commandNames) {
		if (name === "xargs") continue;
		const executable = resolveTrustedCommand(name, cwd);
		if (!executable) {
			if (SHELL_BUILTINS.has(name)) continue;
			throw new Error(`No trusted ${name} executable is available`);
		}
		const target = join(directory, name);
		if (["grep", "egrep", "fgrep"].includes(name)) {
			const exclusions = VCS_METADATA_DIRECTORIES.map((entry) => `--exclude-dir=${quote(entry)}`).join(" ");
			await writeFile(target, `#!/bin/sh\nexec ${quote(executable)} ${exclusions} "$@"\n`, { mode: 0o700 });
			await chmod(target, 0o700);
		} else {
			await symlink(executable, target).catch((error) => {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			});
		}
	}
	if (controlledXargs) {
		const wrapper = join(directory, "xargs");
		const runner = fileURLToPath(new URL("./xargs-runner.mjs", import.meta.url));
		await writeFile(wrapper, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(runner)} "$@"\n`, { mode: 0o700 });
		await chmod(wrapper, 0o700);
	}
	return directory;
}

function safeEnvironment(cwd: string, controlledBin: string, roots: string[]): NodeJS.ProcessEnv {
	const blocked = new Set([
		"BASH_ENV",
		"BASHOPTS",
		"CDPATH",
		"DOCKER_CONFIG",
		"DOCKER_CONTEXT",
		"DOCKER_HOST",
		"ENV",
		"GLOBIGNORE",
		"LESSCLOSE",
		"LESSOPEN",
		"NODE_OPTIONS",
		"PROMPT_COMMAND",
		"SHELLOPTS",
	]);
	const unsafe =
		/^(?:LD_|DYLD_|PYTHON|PERL5|RUBY|GEM_|BUNDLE_|NODE_|JAVA_TOOL_OPTIONS$|_JAVA_OPTIONS$|CLASSPATH$|GCONV_PATH$|NLSPATH$|LOCPATH$|XDG_)/;
	const env = Object.fromEntries(
		Object.entries(process.env).filter(
			([key]) =>
				!blocked.has(key) &&
				!key.startsWith("BASH_FUNC_") &&
				!key.startsWith("DOCKER_") &&
				!key.startsWith("GIT_") &&
				!unsafe.test(key),
		),
	);
	const falseCommand = resolveTrustedCommand("false", cwd);
	return {
		...env,
		DIFF_OPTIONS: "",
		DOCKER_CONFIG: "/dev/null",
		GIT_ATTR_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_EXTERNAL_DIFF: "",
		GIT_OPTIONAL_LOCKS: "0",
		GIT_PAGER: "cat",
		GREP_OPTIONS: "",
		HOME: cwd,
		MANPAGER: "cat",
		PAGER: "cat",
		PATH: controlledBin,
		PI_MEMORY_XARGS_ROOTS: JSON.stringify(roots),
		RIPGREP_CONFIG_PATH: "",
		...(falseCommand
			? {
					GIT_CONFIG_COUNT: "3",
					GIT_CONFIG_KEY_0: "core.hooksPath",
					GIT_CONFIG_VALUE_0: "/dev/null",
					GIT_CONFIG_KEY_1: "diff.external",
					GIT_CONFIG_VALUE_1: "",
					GIT_CONFIG_KEY_2: "gpg.program",
					GIT_CONFIG_VALUE_2: falseCommand,
				}
			: {}),
	};
}

export async function prepareRestrictedBash(command: string, policy: RestrictedBashPolicy): Promise<PreparedBash> {
	if (command.includes("\0")) throw new Error("command contains a NUL byte");
	const deletePaths = parseDelete(command, policy.memoryDir);
	if (deletePaths) return { kind: "delete", paths: deletePaths };

	const decision = classifyReadOnlyBash(command, { platform: process.platform });
	if (!decision.readOnly) throw new Error(decision.reason);
	const usesXargs = decision.commands.some((item) => item.name === "xargs");
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
	const commandNames = [...new Set(decision.commands.flatMap((item) => item.executableNames ?? [item.name]))];
	const controlledBin = await installControlledCommands(policy, cwd, commandNames, usesXargs);
	const roots = usesXargs ? await policy.canonicalReadRoots() : [];
	const excludedRoots = await canonicalizeReadRoots(policy.excludedReadRoots ?? []);
	const shellPath = resolveTrustedCommand("bash", cwd);
	if (!shellPath) throw new Error("No trusted bash executable is available");
	return {
		kind: "execute",
		cwd,
		command,
		revalidate,
		options: {
			shellPath,
			exposeSessionEnvironment: false,
			spawnHook: (context) => ({
				command: context.command,
				cwd,
				env: {
					...safeEnvironment(cwd, controlledBin, roots),
					PI_MEMORY_XARGS_EXCLUDED_ROOTS: JSON.stringify(excludedRoots),
				},
			}),
		},
	};
}
