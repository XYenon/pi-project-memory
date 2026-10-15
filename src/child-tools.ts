import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, copyFile, lstat, mkdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import {
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createReadTool,
	createWriteTool,
	detectSupportedImageMimeTypeFromFile,
	generateDiffString,
	generateUnifiedPatch,
} from "@earendil-works/pi-coding-agent";
import fg from "fast-glob";
import { runNativeSearch } from "./native-search.ts";
import {
	assertContainedMarkdown,
	canonicalizeReadRoots,
	isContainedPath,
	resolveToolPath,
	VCS_METADATA_DIRECTORIES,
} from "./paths.ts";
import { prepareRestrictedBash } from "./restricted-bash.ts";
import { sanitizePersistedMemoryText } from "./sanitize.ts";
import { atomicWriteIfBaseline, lintMemoryContent, safeDeleteMemoryFile, sameBaseline, sha256 } from "./store.ts";
import type { ReadBaseline } from "./types.ts";

export type ChildMode = "extractor" | "dream";

interface ToolEnvironment {
	mode: ChildMode;
	memoryDir: string;
	locksDir: string;
	projectRoot: string;
	cwd: string;
	sessionDir?: string;
	/** Extractor passes exclude original sessions even when the project contains them. */
	excludedReadRoots?: string[];
	scratchDir?: string;
	isCurrentGeneration: () => boolean;
	isProjectTrusted?: () => boolean;
	touchedPaths: Set<string>;
	onTouched?: (relativePath: string, hash: string | null) => void | Promise<void>;
}

const MAX_TEXT_FILE_BYTES = 1024 * 1024 * 1024;
const DEFAULT_BASH_TIMEOUT_SECONDS = 120;
const MAX_BASH_TIMEOUT_SECONDS = 600;

export async function relocateToolOutput(
	result: AgentToolResult<unknown>,
	source: string,
	target: string,
): Promise<void> {
	await copyFile(source, target);
	await rm(source, { force: true }).catch(() => {});
	for (const block of result.content) if (block.type === "text") block.text = block.text.replaceAll(source, target);
}

function toolError(name: string, error: unknown) {
	const message = error instanceof Error ? error.message : String(error);
	return {
		content: [{ type: "text" as const, text: `${name} failed: ${message}` }],
		details: undefined,
		isError: true,
	};
}

function allowedReadRoots(env: ToolEnvironment): string[] {
	return [
		env.memoryDir,
		env.projectRoot,
		env.cwd,
		...(env.mode === "dream" && env.sessionDir ? [env.sessionDir] : []),
		...(env.scratchDir ? [env.scratchDir] : []),
	];
}

async function canonicalReadRoots(env: ToolEnvironment): Promise<string[]> {
	return Promise.all(allowedReadRoots(env).map((root) => realpath(root)));
}

function canonicalExcludedRoots(env: ToolEnvironment): Promise<string[]> {
	return canonicalizeReadRoots(env.excludedReadRoots ?? []);
}

async function assertNotExcluded(env: ToolEnvironment, path: string): Promise<void> {
	if ((await canonicalExcludedRoots(env)).some((root) => isContainedPath(root, path)))
		throw new Error("Path is inside an excluded original session directory");
}

async function assertDirectoryRead(env: ToolEnvironment, directory: string): Promise<void> {
	await assertNotExcluded(env, directory);
	if ((await canonicalExcludedRoots(env)).some((root) => isContainedPath(directory, root)))
		throw new Error("Directory-wide Bash reads cannot include an original session directory; use find or grep");
}

async function resolveReadablePath(env: ToolEnvironment, rawPath: string): Promise<string> {
	const absolute = resolveToolPath(env.cwd, rawPath);
	const [canonical, roots] = await Promise.all([realpath(absolute), canonicalReadRoots(env)]);
	await assertNotExcluded(env, canonical);
	const directlyAllowed =
		allowedReadRoots(env).some((root) => isContainedPath(root, absolute)) ||
		roots.some((root) => isContainedPath(root, canonical));
	if (!directlyAllowed) throw new Error(`Read path is outside the allowed roots: ${rawPath}`);
	if (!roots.some((root) => isContainedPath(root, canonical)))
		throw new Error(`Read path resolves outside the allowed roots: ${rawPath}`);
	return canonical;
}

function decodeUtf8(buffer: Buffer): string {
	if (buffer.includes(0)) throw new Error("Binary files containing NUL bytes are not supported");
	try {
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
	} catch {
		throw new Error("File is not valid UTF-8; legacy encodings and binary files are not supported");
	}
}

async function readRegularUtf8(filePath: string): Promise<{ content: string; baseline: ReadBaseline }> {
	const before = await stat(filePath);
	if (!before.isFile()) throw new Error("Only regular files can be read");
	if (before.size > MAX_TEXT_FILE_BYTES)
		throw new Error(`Text file exceeds the ${MAX_TEXT_FILE_BYTES}-byte safety limit`);
	const buffer = await readFile(filePath);
	const content = decodeUtf8(buffer);
	const after = await stat(filePath);
	if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error("File changed while it was read");
	return { content, baseline: { hash: sha256(content), mtimeMs: after.mtimeMs, size: after.size } };
}

async function ensureSafeParentDirectories(memoryRoot: string, parent: string): Promise<void> {
	let existing = parent;
	for (;;) {
		try {
			if (!isContainedPath(memoryRoot, await realpath(existing)))
				throw new Error("Write parent resolves outside the memory directory");
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			const next = dirname(existing);
			if (next === existing) throw error;
			existing = next;
		}
	}
	await mkdir(parent, { recursive: true, mode: 0o700 });
	if (!isContainedPath(memoryRoot, await realpath(parent)))
		throw new Error("Write parent resolves outside the memory directory");
}

function assertChildRunAllowed(env: ToolEnvironment, signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error("Memory child operation was aborted");
	if (!env.isCurrentGeneration()) throw new Error("This memory pass is stale");
	if (env.isProjectTrusted && !env.isProjectTrusted()) throw new Error("Project trust was revoked");
}

async function revalidateWritablePath(env: ToolEnvironment, filePath: string, signal?: AbortSignal): Promise<void> {
	assertChildRunAllowed(env, signal);
	const [root, parent] = await Promise.all([realpath(env.memoryDir), realpath(dirname(filePath))]);
	if (!isContainedPath(root, parent)) throw new Error("Write parent resolves outside the memory directory");
	if (parent !== dirname(filePath)) throw new Error("Write parent changed identity or uses a symlink");
}

async function resolveWritablePath(env: ToolEnvironment, rawPath: string, signal?: AbortSignal): Promise<string> {
	assertChildRunAllowed(env, signal);
	const absolute = assertContainedMarkdown(env.memoryDir, resolveToolPath(env.cwd, rawPath));
	const canonicalMemoryRoot = await realpath(env.memoryDir);
	const expected = resolve(canonicalMemoryRoot, relative(resolve(env.memoryDir), absolute));
	await assertNotExcluded(env, expected);
	await ensureSafeParentDirectories(canonicalMemoryRoot, dirname(expected));
	try {
		const targetInfo = await lstat(expected);
		if (targetInfo.isSymbolicLink() || !targetInfo.isFile())
			throw new Error(`Write target is not a regular file: ${rawPath}`);
		const canonical = await realpath(expected);
		if (canonical !== expected)
			throw new Error(`Write target is a symlink or resolves outside the memory directory: ${rawPath}`);
		return canonical;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	return expected;
}

function mutationLock(env: ToolEnvironment, filePath: string): string {
	return join(env.locksDir, "files", `${sha256(resolve(filePath))}.lock`);
}

async function memoryPathSet(memoryDir: string, baselines: ReadonlyMap<string, ReadBaseline>): Promise<Set<string>> {
	const canonicalRoot = await realpath(memoryDir);
	const paths = await fg("**/*.md", {
		cwd: canonicalRoot,
		onlyFiles: true,
		followSymbolicLinks: false,
		dot: false,
		unique: true,
		ignore: VCS_METADATA_DIRECTORIES.map((directory) => `**/${directory}/**`),
	});
	for (const path of baselines.keys()) paths.push(relative(canonicalRoot, path).split(sep).join("/"));
	return new Set(paths);
}

function withMemoryLint(text: string, filePath: string, content: string, paths: ReadonlySet<string>): string {
	const warnings = lintMemoryContent(filePath, content, paths);
	return warnings.length === 0
		? text
		: `${text}\n\nThe memory write succeeded, but it needs correction:\n${warnings.map((warning) => `- ${warning}`).join("\n")}`;
}

async function markTouched(env: ToolEnvironment, filePath: string, hash: string | null): Promise<void> {
	const canonicalRoot = await realpath(env.memoryDir);
	const relativePath = relative(canonicalRoot, filePath).split(sep).join("/");
	env.touchedPaths.add(relativePath);
	await env.onTouched?.(relativePath, hash);
}

function toolSignal(parent: AbortSignal | undefined): { signal: AbortSignal; clear: () => void } {
	const timeout = new AbortController();
	const timer = setTimeout(() => timeout.abort(), 20_000);
	timer.unref();
	return {
		signal: parent ? AbortSignal.any([parent, timeout.signal]) : timeout.signal,
		clear: () => clearTimeout(timer),
	};
}

export function createChildTools(env: ToolEnvironment): AgentTool[] {
	const baselines = new Map<string, ReadBaseline>();

	async function commitMemory(
		filePath: string,
		expected: ReadBaseline | null,
		content: string,
		signal?: AbortSignal,
	): Promise<void> {
		const written = await atomicWriteIfBaseline(
			filePath,
			expected,
			() => content,
			mutationLock(env, filePath),
			() => revalidateWritablePath(env, filePath, signal),
		);
		baselines.set(filePath, written);
		await markTouched(env, filePath, written.hash);
	}

	async function search(
		name: "find" | "grep",
		params: Record<string, unknown> & { path?: string },
		signal?: AbortSignal,
	) {
		assertChildRunAllowed(env, signal);
		const path = await resolveReadablePath(env, params.path ?? env.cwd);
		if (name === "find" && !(await stat(path)).isDirectory()) throw new Error("find path must be an allowed directory");
		const result = await runNativeSearch(
			name,
			{ ...params, path },
			{
				cwd: env.cwd,
				roots: await canonicalReadRoots(env),
				excludedRoots: await canonicalExcludedRoots(env),
			},
			signal,
		);
		assertChildRunAllowed(env, signal);
		return result;
	}

	const nativeRead = createReadTool(env.cwd, {
		operations: {
			access: async (path) => {
				const canonical = await resolveReadablePath(env, path);
				const extension = extname(canonical).toLowerCase();
				if ([".pdf", ".ipynb"].includes(extension))
					throw new Error(`${extension} files are not supported by the background read tool`);
				await access(canonical, constants.R_OK);
			},
			readFile: async (path) => readFile(await resolveReadablePath(env, path)),
			detectImageMimeType: async (path) => detectSupportedImageMimeTypeFromFile(await resolveReadablePath(env, path)),
		},
	});
	const read: typeof nativeRead = {
		...nativeRead,
		description: `${nativeRead.description} Access is limited to the approved memory, project, and session roots.`,
		async execute(id, params, signal, onUpdate) {
			try {
				assertChildRunAllowed(env, signal);
				const filePath = await resolveReadablePath(env, params.path);
				const canonicalMemoryRoot = await realpath(env.memoryDir);
				const isMemoryFile = isContainedPath(canonicalMemoryRoot, filePath);
				const before = isMemoryFile ? await readRegularUtf8(filePath).catch(() => undefined) : undefined;
				const result = await nativeRead.execute(id, { ...params, path: filePath }, signal, onUpdate);
				assertChildRunAllowed(env, signal);
				if (isMemoryFile) {
					const textResult = !result.content.some((block) => block.type === "image");
					const after = textResult ? await readRegularUtf8(filePath).catch(() => undefined) : undefined;
					const stable = before && after && sameBaseline(before.baseline, after.baseline);
					const truncated = Boolean((result.details as { truncation?: unknown } | undefined)?.truncation);
					// Claude accepts ordinary explicit pages as read baselines. Automatic
					// truncation is a partial view and cannot authorize a mutation.
					const validPage =
						(params.offset === undefined || (Number.isSafeInteger(params.offset) && params.offset >= 0)) &&
						(params.limit === undefined || (Number.isSafeInteger(params.limit) && params.limit > 0));
					if (stable && validPage && !truncated) baselines.set(filePath, after.baseline);
					else baselines.delete(filePath);
				}
				return result;
			} catch (error) {
				return toolError("read", error);
			}
		},
	};

	const nativeFind = createFindTool(env.cwd);
	const find: typeof nativeFind = {
		...nativeFind,
		description: `${nativeFind.description} The search root must be inside an approved read root.`,
		async execute(_id, params, signal, _onUpdate) {
			try {
				return await search("find", params, signal);
			} catch (error) {
				return toolError("find", error);
			}
		},
	};

	const nativeGrep = createGrepTool(env.cwd);
	const grep: typeof nativeGrep = {
		...nativeGrep,
		description: `${nativeGrep.description} The search target must be inside an approved read root.`,
		async execute(_id, params, signal, _onUpdate) {
			const bounded = toolSignal(signal);
			try {
				return await search("grep", params, bounded.signal);
			} catch (error) {
				return toolError("grep", error);
			} finally {
				bounded.clear();
			}
		},
	};

	const nativeWriteShape = createWriteTool(env.cwd);
	const write: typeof nativeWriteShape = {
		...nativeWriteShape,
		description:
			"Write a Markdown file inside the memory directory. Existing files require a prior ordinary text read. Uses Pi's native write schema and transformation path.",
		async execute(id, params, signal, onUpdate) {
			try {
				const filePath = await resolveWritablePath(env, params.path, signal);
				let expected: ReadBaseline | null = null;
				let original: string | null = null;
				try {
					await access(filePath, constants.F_OK);
					expected = baselines.get(filePath) ?? null;
					if (!expected) throw new Error("Existing memory files require a prior ordinary text read before write");
					original = (await readRegularUtf8(filePath)).content;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
				let finalContent = "";
				const nativeWrite = createWriteTool(env.cwd, {
					operations: {
						mkdir: async () => {},
						writeFile: async (_path, content) => {
							finalContent = content;
						},
					},
				});
				const content = sanitizePersistedMemoryText(params.content);
				const nativeResult = await nativeWrite.execute(id, { path: filePath, content }, signal, onUpdate);
				await commitMemory(filePath, expected, finalContent, signal);
				const diff = generateDiffString(original ?? "", finalContent);
				const text =
					nativeResult.content[0]?.type === "text" ? nativeResult.content[0].text : `Successfully wrote to ${filePath}`;
				return {
					content: [
						{
							type: "text" as const,
							text: withMemoryLint(text, filePath, finalContent, await memoryPathSet(env.memoryDir, baselines)),
						},
					],
					details: {
						diff: diff.diff,
						patch: generateUnifiedPatch(filePath, original ?? "", finalContent),
						firstChangedLine: diff.firstChangedLine,
					},
				};
			} catch (error) {
				return toolError("write", error);
			}
		},
	};

	const nativeEditShape = createEditTool(env.cwd);
	const edit: typeof nativeEditShape = {
		...nativeEditShape,
		description:
			"Edit one memory Markdown file with Pi's native edits[] schema and text transformation. The file requires a prior ordinary text read.",
		async execute(id, params, signal, onUpdate) {
			try {
				const filePath = await resolveWritablePath(env, params.path, signal);
				await access(filePath, constants.F_OK);
				const authorized = baselines.get(filePath);
				if (!authorized) throw new Error("edit requires a prior ordinary text read of the same file");
				const snapshot = await readRegularUtf8(filePath);
				const staleRecovered = !sameBaseline(snapshot.baseline, authorized);
				let capturedEdit = "";
				const nativeEdit = createEditTool(env.cwd, {
					operations: {
						access: async () => {},
						readFile: async () => Buffer.from(snapshot.content, "utf8"),
						writeFile: async (_path, content) => {
							capturedEdit = content;
						},
					},
				});
				const sanitizedEdits = params.edits.map((item) => ({
					oldText: item.oldText,
					newText: sanitizePersistedMemoryText(item.newText),
				}));
				const nativeResult = await nativeEdit.execute(id, { path: filePath, edits: sanitizedEdits }, signal, onUpdate);
				const finalContent = sanitizePersistedMemoryText(capturedEdit);
				await commitMemory(filePath, snapshot.baseline, finalContent, signal);
				const diff = generateDiffString(snapshot.content, finalContent);
				const nativeText = nativeResult.content[0]?.type === "text" ? nativeResult.content[0].text : "File edited";
				const staleNotice = staleRecovered
					? " The file changed after your earlier read; the edits still applied to the current content. Read it again before edits that depend on surrounding text."
					: "";
				return {
					content: [
						{
							type: "text" as const,
							text: withMemoryLint(
								`${nativeText}${staleNotice}`,
								filePath,
								finalContent,
								await memoryPathSet(env.memoryDir, baselines),
							),
						},
					],
					details: {
						diff: diff.diff,
						patch: generateUnifiedPatch(filePath, snapshot.content, finalContent),
						firstChangedLine: diff.firstChangedLine,
						staleRecovered,
					},
				};
			} catch (error) {
				return toolError("edit", error);
			}
		},
	};

	const nativeBashShape = createBashTool(env.cwd, { exposeSessionEnvironment: false });
	const bash: typeof nativeBashShape = {
		...nativeBashShape,
		description:
			"Run validated read-only Bash commands. The only mutation allowed is rm or rm -f of previously-read Markdown files inside the memory directory.",
		async execute(id, params, signal, onUpdate) {
			try {
				assertChildRunAllowed(env, signal);
				if (
					params.timeout !== undefined &&
					(!Number.isFinite(params.timeout) || params.timeout <= 0 || params.timeout > MAX_BASH_TIMEOUT_SECONDS)
				)
					throw new Error(`Bash timeout must be between 1 and ${MAX_BASH_TIMEOUT_SECONDS} seconds`);
				const prepared = await prepareRestrictedBash(params.command, {
					memoryDir: env.memoryDir,
					cwd: env.cwd,
					resolveReadablePath: (path) => resolveReadablePath(env, path),
					assertDirectoryRead: (path) => assertDirectoryRead(env, path),
				});
				if (prepared.kind === "delete") {
					for (const path of prepared.paths) {
						const filePath = await resolveWritablePath(env, path, signal);
						const expected = baselines.get(filePath);
						if (!expected) throw new Error("Memory files require a prior ordinary text read before deletion");
						await safeDeleteMemoryFile(env.memoryDir, filePath, expected, mutationLock(env, filePath), () =>
							revalidateWritablePath(env, filePath, signal),
						);
						baselines.delete(filePath);
						await markTouched(env, filePath, null);
					}
					return {
						content: [{ type: "text" as const, text: `Deleted ${prepared.paths.join(", ")}` }],
						details: undefined,
					};
				}
				if (!env.scratchDir) throw new Error("Restricted Bash requires a private scratch directory");
				await prepared.revalidate();
				const nativeBash = createBashTool(prepared.cwd, prepared.options);
				const result = await nativeBash.execute(
					id,
					{ command: prepared.command, timeout: params.timeout ?? DEFAULT_BASH_TIMEOUT_SECONDS },
					signal,
					onUpdate,
				);
				assertChildRunAllowed(env, signal);
				const details = result.details as { fullOutputPath?: string } | undefined;
				const structured = result.structuredContent as { full_output_path?: string } | undefined;
				const source = details?.fullOutputPath ?? structured?.full_output_path;
				if (source) {
					const target = join(env.scratchDir, `bash-${randomUUID()}.log`);
					await relocateToolOutput(result, source, target);
					if (details) details.fullOutputPath = target;
					if (structured?.full_output_path) structured.full_output_path = target;
				}
				return result;
			} catch (error) {
				return toolError("bash", error);
			}
		},
	};

	return [read, write, edit, find, grep, bash];
}
