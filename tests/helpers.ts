import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { TestContext } from "node:test";

export const shellPath = process.platform === "android" ? "/system/bin/sh" : "/bin/sh";

export const WINDOWS_XARGS_REASON = "xargs is classified as not read-only on win32 (src/bash-readonly.ts)";

/** Skips the whole test on Windows and returns true so callers can return early. */
export function skipOnWindows(t: TestContext, reason: string): boolean {
	if (process.platform !== "win32") return false;
	t.skip(`Windows: ${reason}`);
	return true;
}

/** Gates a POSIX-only block inside an otherwise cross-platform test. */
export function skipBlockOnWindows(t: TestContext, reason: string): boolean {
	if (process.platform !== "win32") return false;
	t.diagnostic(`Windows skip: ${reason}`);
	return true;
}

/** Leave Windows working directories before using Node's bounded removal retries. */
export async function removeTempDirectory(directory: string): Promise<void> {
	leaveWorkingDirectory(directory);
	await rm(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
}

export async function createTempDirectory(t: TestContext, prefix: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), prefix));
	t.after(() => removeTempDirectory(root));
	return root;
}

export async function createToolWorkspace(t: TestContext, prefix: string) {
	const root = await createTempDirectory(t, prefix);
	const memoryDir = join(root, "memory");
	const projectRoot = join(root, "project");
	const locksDir = join(root, "locks");
	await Promise.all([mkdir(memoryDir), mkdir(projectRoot), mkdir(locksDir)]);
	return { root, memoryDir, projectRoot, locksDir };
}

function leaveWorkingDirectory(directory: string): void {
	const target = resolve(directory);
	const current = resolve(process.cwd());
	const inside = relative(target, current);
	if (inside === "" || (!inside.startsWith("..") && !isAbsolute(inside))) process.chdir(tmpdir());
}
