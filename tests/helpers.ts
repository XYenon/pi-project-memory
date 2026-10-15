import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

export async function createTempDirectory(t: TestContext, prefix: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), prefix));
	t.after(() => rm(root, { recursive: true, force: true }));
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
