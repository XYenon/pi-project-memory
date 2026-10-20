import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, lstat, mkdir, open, readFile, realpath, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ProjectPaths } from "./types.ts";

const execFileAsync = promisify(execFile);

export const VCS_METADATA_DIRECTORIES = [".git", ".hg", ".svn", ".bzr", ".jj", ".sl"] as const;
const VCS_METADATA_SET = new Set<string>(VCS_METADATA_DIRECTORIES);

/** Match Pi native tool path normalization on the supported Unix platforms. */
export function resolveToolPath(cwd: string, input: string): string {
	let path = input.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ").replace(/^@/, "");
	if (path === "~") path = homedir();
	else if (path.startsWith("~/")) path = join(homedir(), path.slice(2));
	else if (path.startsWith("file://")) path = fileURLToPath(path);
	return resolve(cwd, path);
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
	if (!value) return null;
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
	}
	if (!isAbsolute(expanded) || expanded.includes("\0")) return null;
	const normalized = normalize(expanded).replace(/[\\/]+$/, "");
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
			return join(await realpath(current), ...missing.reverse()).normalize("NFC");
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
	const memoryDir = configured ?? join(projectBaseDir, "memory");
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
	if (!existed) await chmod(path, 0o700);
}

export async function initializeProjectPaths(paths: ProjectPaths): Promise<void> {
	await ensurePrivateDirectory(paths.baseDir, "Project memory state root");
	await ensurePrivateDirectory(paths.memoryDir, "Memory root", true);
	await ensurePrivateDirectory(paths.locksDir, "Lock root");
	const namespaceDir = paths.namespaceDir ?? paths.baseDir;
	if (!(await reserveNamespace(namespaceDir, paths.projectRoot)))
		throw new Error("Project memory namespace belongs to a different project root");
}

export function displayPath(path: string): string {
	return path.startsWith(`${homedir()}${sep}`) ? `~${path.slice(homedir().length)}` : path;
}

export function isContainedPath(root: string, candidate: string): boolean {
	const normalizedRoot = resolve(root);
	const normalized = resolve(candidate);
	return normalized === normalizedRoot || normalized.startsWith(`${normalizedRoot}${sep}`);
}

export function assertContainedMarkdown(root: string, candidate: string): string {
	const absolute = resolve(candidate);
	if (!isContainedPath(root, absolute)) throw new Error(`Path escapes the memory directory: ${candidate}`);
	if (!absolute.endsWith(".md"))
		throw new Error(`Memory writes and deletes require a lowercase .md path: ${candidate}`);
	return absolute;
}
