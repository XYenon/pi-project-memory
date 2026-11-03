import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { access, chmod, lstat, mkdir, open, readFile, realpath, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, posix, resolve, sep, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ProjectPaths } from "./types.ts";

const execFileAsync = promisify(execFile);

export const VCS_METADATA_DIRECTORIES = [".git", ".hg", ".svn", ".bzr", ".jj", ".sl"] as const;
const VCS_METADATA_SET = new Set<string>(VCS_METADATA_DIRECTORIES);

const WINDOWS_DRIVE = /^[a-zA-Z]:/;
const WINDOWS_ABSOLUTE_DRIVE = /^[a-zA-Z]:[\\/]/;

function stripExtendedPrefix(path: string): string {
	if (/^\\\\\?\\UNC\\/i.test(path)) return `\\\\${path.slice(8)}`;
	if (/^\\\\[?.]\\/.test(path)) return path.slice(4);
	return path;
}

/** Resolve aliases and on-disk casing, including paths whose final components do not exist yet. */
function canonicalWindowsPath(path: string): string {
	const resolved = win32.resolve(path);
	let current = resolved;
	const suffix: string[] = [];
	for (;;) {
		try {
			const canonical = stripExtendedPrefix(realpathSync.native(current));
			return win32.join(canonical, ...suffix);
		} catch {}
		const parent = win32.dirname(current);
		if (parent === current) return resolved;
		suffix.unshift(win32.basename(current));
		current = parent;
	}
}

/**
 * The single path-input normalizer. On Windows it accepts native, forward-slash,
 * MSYS/Cygwin/WSL, home-relative, and extended-length forms and returns the
 * canonical drive form with on-disk casing. On POSIX it is a no-op for already
 * canonical paths.
 */
export function normalizePathInput(base: string, input: string, platform: NodeJS.Platform = process.platform): string {
	const lexical = normalizePathLexical(base, input, platform);
	return platform === "win32" ? canonicalWindowsPath(lexical) : lexical;
}

/**
 * Normalize for bash operations: handle home, spaces, extended prefixes,
 * but do NOT resolve symlinks. This keeps symlinks themselves intact so
 * background Bash can delete them as they are, not by following to the target.
 */
export function normalizePathLexical(
	base: string,
	input: string,
	platform: NodeJS.Platform = process.platform,
): string {
	const windows = platform === "win32";
	const flavor = windows ? win32 : posix;
	let path = input.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ").replace(/^@/, "");
	if (path === "~") path = homedir();
	else if (windows ? /^~[\\/]/.test(path) : path.startsWith("~/")) path = flavor.join(homedir(), path.slice(2));
	else if (path.startsWith("file://")) path = fileURLToPath(path);
	if (!windows) return flavor.resolve(base, path);
	path = stripExtendedPrefix(path).replace(
		/^\/(?:(?:mnt|cygdrive)\/)?([a-zA-Z])(?=\/|$)/,
		(_match, drive: string) => `${drive.toUpperCase()}:\\`,
	);
	if (WINDOWS_DRIVE.test(path) && !WINDOWS_ABSOLUTE_DRIVE.test(path))
		throw new Error(`Drive-relative paths are not supported: ${input}`);
	const resolved = stripExtendedPrefix(flavor.resolve(base, path));
	if (resolved.slice(2).includes(":")) throw new Error(`Alternate data streams are not supported: ${input}`);
	return resolved;
}

/** Match Pi native tool path normalization on the supported platforms. */
export function resolveToolPath(cwd: string, input: string): string {
	return normalizePathInput(cwd, input);
}

/** Markdown extensions compare case-insensitively on every platform. */
export function isMarkdownPath(path: string): boolean {
	return /\.md$/i.test(path);
}

/**
 * Walk every ancestor of a file path and reject when one is a reparse point.
 * This closes the `realpath` gap where a junction chains to an escaped root.
 */
export async function rejectReparsePathAncestor(filePath: string): Promise<void> {
	if (process.platform !== "win32") return;
	for (let current = resolve(filePath); ; current = dirname(current)) {
		const info = await lstat(current).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return undefined;
			throw error;
		});
		if (info?.isSymbolicLink()) throw new Error(`Memory path traverses a symlink or junction: ${current}`);
		if (dirname(current) === current) return;
	}
}

/** Reject memory roots that are themselves junctions or symlinks. */
export async function rejectReparseRoot(path: string): Promise<void> {
	if (process.platform !== "win32") return;
	const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return undefined;
		throw error;
	});
	if (info?.isSymbolicLink()) throw new Error(`Memory root must not be a symlink or junction: ${path}`);
}

export function containsVcsMetadataSegment(path: string): boolean {
	return path.split(/[\\/]+/).some((segment) => VCS_METADATA_SET.has(segment.toLowerCase()));
}

async function gitRevParse(cwd: string, argument: string): Promise<string> {
	const { stdout } = await execFileAsync(
		"git",
		["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=", "-C", cwd, "rev-parse", argument],
		{
			timeout: 3000,
			encoding: "utf8",
			env: {
				HOME: cwd,
				PATH: process.env.PATH ?? "/usr/bin:/bin",
				GIT_CONFIG_GLOBAL: "/dev/null",
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_OPTIONAL_LOCKS: "0",
			},
		},
	);
	return stdout.trim();
}

/** Resolve linked worktrees to the checkout which owns the common .git directory. */
export async function canonicalProjectRoot(cwd: string): Promise<string> {
	const canonicalCwd = await realpath(resolve(cwd));
	try {
		const [topLevelValue, commonDirValue] = await Promise.all([
			gitRevParse(canonicalCwd, "--show-toplevel"),
			gitRevParse(canonicalCwd, "--git-common-dir"),
		]);
		const topLevel = await realpath(resolve(canonicalCwd, topLevelValue));
		const commonDir = await realpath(resolve(canonicalCwd, commonDirValue));
		// This matches Claude's linked-worktree key: a normal common directory
		// named .git belongs to its parent checkout. Bare/unusual layouts keep
		// the current worktree root rather than guessing another directory.
		return basename(commonDir) === ".git" ? await realpath(dirname(commonDir)) : topLevel;
	} catch {
		return canonicalCwd;
	}
}

export function base36Hash(value: string): string {
	// Claude Code 2.1.296 uses the signed 32-bit Java String.hashCode algorithm.
	let hash = 0;
	for (let index = 0; index < value.length; index++) hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
	return Math.abs(hash).toString(36);
}

export function sanitizeProjectKey(projectRoot: string): string {
	const replaced = projectRoot.replace(/[^a-zA-Z0-9]/g, "-");
	return replaced.length <= 200 ? replaced : `${replaced.slice(0, 200)}-${base36Hash(projectRoot)}`;
}

function configuredMemoryDirectory(value: string | null): string | null {
	if (!value || value.includes("\0") || value === "~") return null;
	let expanded = value;
	if (/^~[\\/]/.test(value)) {
		const tail = value.slice(2);
		const normalizedTail = normalize(tail || ".");
		if (
			normalizedTail === "." ||
			normalizedTail === ".." ||
			normalizedTail.startsWith(`..${sep}`) ||
			normalizedTail.startsWith("../") ||
			normalizedTail.startsWith("..\\")
		)
			return null;
		expanded = join(homedir(), tail);
	} else if (!isAbsolute(value)) {
		return null;
	}
	let normalized: string;
	try {
		normalized = (process.platform === "win32" ? normalizePathInput(homedir(), expanded) : normalize(expanded)).replace(
			/[\\/]+$/,
			"",
		);
	} catch {
		// Invalid forms fall back to the project namespace rather than failing startup.
		return null;
	}
	if (
		normalized.length < 3 ||
		normalized === sep ||
		/^[A-Za-z]:$/.test(normalized) ||
		containsVcsMetadataSegment(normalized)
	)
		return null;
	return normalized.normalize("NFC");
}

function namespaceHash(value: string): string {
	return createHash("sha256").update(value.normalize("NFC")).digest("hex").slice(0, 24);
}

const PROJECT_ROOT_MARKER = ".project-root";

async function ensureRealPrivateDirectory(path: string): Promise<void> {
	await mkdir(path, { recursive: true, mode: 0o700 });
	const info = await lstat(path);
	if (!info.isDirectory() || info.isSymbolicLink())
		throw new Error(`Project memory namespace must be a real directory: ${path}`);
	await chmod(path, 0o700);
}

async function readProjectMarker(namespaceDir: string): Promise<string | undefined> {
	const markerPath = join(namespaceDir, PROJECT_ROOT_MARKER);
	for (let attempt = 0; attempt < 20; attempt++) {
		try {
			const marker = (await readFile(markerPath, "utf8")).trim();
			if (marker) return marker;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			return undefined;
		}
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
	}
	return undefined;
}

async function reserveNamespace(namespaceDir: string, projectRoot: string): Promise<boolean> {
	await ensureRealPrivateDirectory(namespaceDir);
	const markerPath = join(namespaceDir, PROJECT_ROOT_MARKER);
	try {
		const handle = await open(markerPath, "wx", 0o600);
		try {
			await handle.writeFile(`${projectRoot}\n`);
		} finally {
			await handle.close();
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	return (await readProjectMarker(namespaceDir)) === projectRoot;
}

async function projectNamespace(agentMemoryRoot: string, projectKey: string, projectRoot: string): Promise<string> {
	const projectsRoot = join(agentMemoryRoot, "projects");
	const compatible = join(projectsRoot, projectKey);
	if (await reserveNamespace(compatible, projectRoot)) return projectKey;
	const collisionNamespace = `${projectKey}-${namespaceHash(projectRoot)}`;
	const collision = join(projectsRoot, collisionNamespace);
	if (await reserveNamespace(collision, projectRoot)) return collisionNamespace;
	throw new Error("Project memory collision namespace belongs to a different project root");
}

async function canonicalNamespacePath(path: string): Promise<string> {
	let current = path;
	const missing: string[] = [];
	for (;;) {
		try {
			return join(stripExtendedPrefix(await realpath(current)), ...missing.reverse()).normalize("NFC");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") return resolve(path).normalize("NFC");
		}
		const parent = dirname(current);
		if (parent === current) return resolve(path).normalize("NFC");
		missing.push(basename(current));
		current = parent;
	}
}

export async function resolveProjectPaths(
	cwd: string,
	autoMemoryDirectory: string | null = null,
): Promise<ProjectPaths> {
	const projectRoot = await canonicalProjectRoot(cwd);
	const projectKey = sanitizeProjectKey(projectRoot);
	const agentMemoryRoot = join(getAgentDir(), "project-memory");
	const projectsRoot = join(agentMemoryRoot, "projects");
	const compatibleBaseDir = join(projectsRoot, projectKey);
	const preHashBaseDir = join(projectsRoot, `${projectKey}-${namespaceHash(projectRoot)}`);
	// Migrate the short-lived always-hashed layout before reserving the ordinary
	// Claude-compatible name. Rename is atomic, and a racing resolver can safely
	// observe either side before it performs the same reservation check.
	if (preHashBaseDir !== compatibleBaseDir) {
		try {
			const oldMarker = await readProjectMarker(preHashBaseDir);
			if (oldMarker === projectRoot)
				await access(compatibleBaseDir).then(
					() => {},
					async () => rename(preHashBaseDir, compatibleBaseDir),
				);
		} catch {}
	}
	// Keep Claude's exact default namespace for the first ordinary project. An
	// atomic marker reservation disambiguates roots whose sanitized keys collide.
	const namespace = await projectNamespace(agentMemoryRoot, projectKey, projectRoot);
	const projectBaseDir = join(projectsRoot, namespace);
	const configured = configuredMemoryDirectory(autoMemoryDirectory);
	let memoryDir = configured ?? join(projectBaseDir, "memory");
	if (process.platform === "win32") memoryDir = await canonicalNamespacePath(memoryDir);
	const memoryNamespace = namespaceHash(await canonicalNamespacePath(memoryDir));
	// Project state remains isolated. Dream cadence and locks use the canonical
	// memory root so projects mounting one store coordinate maintenance.
	const baseDir = configured ? join(projectBaseDir, "stores", memoryNamespace) : projectBaseDir;
	const sharedDir = join(agentMemoryRoot, "memory-roots", memoryNamespace);
	return {
		projectRoot,
		projectKey,
		namespaceDir: projectBaseDir,
		baseDir,
		memoryDir,
		stateFile: join(baseDir, "state.json"),
		dreamStateFile: join(sharedDir, "state.json"),
		locksDir: join(sharedDir, "locks"),
	};
}

async function ensurePrivateDirectory(path: string, label: string, followLinks = false): Promise<void> {
	const existed = await lstat(path).then(
		() => true,
		() => false,
	);
	await mkdir(path, { recursive: true, mode: 0o700 });
	const info = followLinks ? await stat(path) : await lstat(path);
	if (!info.isDirectory()) throw new Error(`${label} must be a directory`);
	// Windows cannot set owner/group/other mode bits; POSIX privacy stays 0o700.
	if (!existed && process.platform !== "win32") await chmod(path, 0o700);
}

export async function initializeProjectPaths(paths: ProjectPaths): Promise<void> {
	await ensurePrivateDirectory(paths.baseDir, "Project memory state root");
	await ensurePrivateDirectory(paths.memoryDir, "Memory root", true);
	await rejectReparseRoot(paths.memoryDir);
	await ensurePrivateDirectory(paths.locksDir, "Lock root");
	const namespaceDir = paths.namespaceDir ?? paths.baseDir;
	if (!(await reserveNamespace(namespaceDir, paths.projectRoot)))
		throw new Error("Project memory namespace belongs to a different project root");
}

export function displayPath(path: string): string {
	const home = homedir();
	if (process.platform === "win32") {
		const foldedHome = win32.resolve(home).toLowerCase().replace(/\\+$/, "");
		const foldedPath = win32.resolve(path).toLowerCase();
		return foldedPath.startsWith(`${foldedHome}\\`) ? `~${path.slice(home.length)}` : path;
	}
	return path.startsWith(`${home}${sep}`) ? `~${path.slice(home.length)}` : path;
}

/**
 * The single containment primitive. Windows compares case-folded `path.win32`
 * forms so drive casing, separators, and junctions name the same root. The
 * comparison stays lexical on every platform; callers that guard writes,
 * deletes, and index exclusion resolve both sides with `realpath` first, which
 * keeps reads able to follow links the way Claude does.
 */
export function isContainedPath(
	root: string,
	candidate: string,
	platform: NodeJS.Platform = process.platform,
): boolean {
	if (platform === "win32") {
		const foldedRoot = win32.resolve(root).toLowerCase().replace(/\\+$/, "");
		const foldedCandidate = win32.resolve(candidate).toLowerCase().replace(/\\+$/, "");
		return foldedCandidate === foldedRoot || foldedCandidate.startsWith(`${foldedRoot}\\`);
	}
	const normalizedRoot = posix.resolve(root);
	const normalized = posix.resolve(candidate);
	return normalized === normalizedRoot || normalized.startsWith(`${normalizedRoot}${posix.sep}`);
}

export function assertContainedMarkdown(
	root: string,
	candidate: string,
	platform: NodeJS.Platform = process.platform,
): string {
	const absolute = normalizePathLexical(process.cwd(), candidate, platform);
	if (!isContainedPath(root, absolute, platform)) throw new Error(`Path escapes the memory directory: ${candidate}`);
	if (!isMarkdownPath(absolute)) throw new Error(`Memory writes and deletes require a .md path: ${candidate}`);
	return absolute;
}
