import assert from "node:assert/strict";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { removeTempDirectory } from "./helpers.ts";

test("removeTempDirectory removes a directory tree", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-memory-helper-remove-"));
	await writeFile(join(root, "fact.md"), "fact\n");
	await removeTempDirectory(root);
	await assert.rejects(stat(root), { code: "ENOENT" });
});

test("removeTempDirectory leaves a working directory inside the temp tree first", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-memory-helper-chdir-"));
	const previous = process.cwd();
	try {
		process.chdir(root);
		await removeTempDirectory(root);
		assert.notEqual(process.cwd(), root);
		await assert.rejects(stat(root), { code: "ENOENT" });
	} finally {
		process.chdir(previous);
	}
});
