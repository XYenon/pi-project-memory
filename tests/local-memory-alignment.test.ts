import assert from "node:assert/strict";
import { access, lstat, mkdir, readFile, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { classifyReadOnlyBash } from "../src/bash-readonly.ts";
import { createChildTools } from "../src/child-tools.ts";
import { sanitizeMemoryText } from "../src/sanitize.ts";
import { acquireLock, readIndex, recallTopic, scanTopics, sha256 } from "../src/store.ts";
import { createToolWorkspace } from "./helpers.ts";

test("local memory reads follow links and decode NUL and invalid UTF-8 like Claude", async (t) => {
	const env = await createToolWorkspace(t, "pi-memory-local-read-");
	const source = join(env.root, "source.md");
	await writeFile(source, Buffer.concat([Buffer.from("fact\0"), Buffer.from([0xff]), Buffer.from("\n")]));
	await symlink(source, join(env.memoryDir, "linked.md"));
	await symlink(source, join(env.memoryDir, "MEMORY.md"));
	const expected = "fact\0�\n";
	assert.equal(await readIndex(env.memoryDir), expected.trim());
	const topics = await scanTopics(env.memoryDir);
	assert.equal(topics.length, 1);
	assert.ok(topics[0]);
	assert.equal(topics[0].filename, "linked.md");
	const recall = await recallTopic(topics[0]);
	assert.equal(recall.content, expected);
	assert.equal(sanitizeMemoryText(recall.content), "fact�\n");
	await writeFile(source, "updated fact\n");
	await utimes(source, new Date(0), new Date(0));
	assert.equal((await recallTopic(topics[0])).content, "updated fact\n");
});

test("background reads establish editable baselines for NUL and invalid UTF-8 text", async (t) => {
	const env = await createToolWorkspace(t, "pi-memory-lossy-baseline-");
	const path = join(env.memoryDir, "fact.md");
	await writeFile(path, Buffer.from([0x61, 0, 0xff, 0x0a]));
	const tools = new Map(
		createChildTools({
			...env,
			mode: "extractor",
			cwd: env.projectRoot,
			isCurrentGeneration: () => true,
			touchedPaths: new Set(),
		}).map((tool) => [tool.name, tool]),
	);
	const read = await tools.get("read")!.execute("read", { path });
	assert.notEqual(read.isError, true, JSON.stringify(read));
	const edit = await tools.get("edit")!.execute("edit", { path, edits: [{ oldText: "a", newText: "b" }] });
	assert.notEqual(edit.isError, true, JSON.stringify(edit));
	assert.equal(await readFile(path, "utf8"), "b\0�\n");
});

test("forced deletion succeeds for absent files without creating directories", async (t) => {
	const env = await createToolWorkspace(t, "pi-memory-force-missing-");
	const tools = createChildTools({
		...env,
		mode: "extractor",
		cwd: env.projectRoot,
		isCurrentGeneration: () => true,
		touchedPaths: new Set(),
	});
	const bash = tools.find((tool) => tool.name === "bash")!;
	const absent = join(env.memoryDir, "absent", "missing.md");
	for (const flag of ["-f", "--force"]) {
		const result = await bash.execute("delete", { command: `rm ${flag} -- '${absent}'` });
		assert.notEqual(result.isError, true, JSON.stringify(result));
	}
	assert.equal((await bash.execute("plain", { command: `rm '${absent}'` })).isError, true);
	await assert.rejects(access(join(env.memoryDir, "absent")), { code: "ENOENT" });
});

test("read-only cd commands can use semicolons, alternatives, and pipelines", async (t) => {
	const env = await createToolWorkspace(t, "pi-memory-compound-cd-");
	const sub = join(env.projectRoot, "sub");
	const scratchDir = join(env.root, "scratch");
	await Promise.all([mkdir(sub), mkdir(scratchDir)]);
	await writeFile(join(sub, "fact.md"), "CD_MARKER\n");
	const bash = createChildTools({
		...env,
		mode: "extractor",
		cwd: env.projectRoot,
		scratchDir,
		isCurrentGeneration: () => true,
		touchedPaths: new Set(),
	}).find((tool) => tool.name === "bash")!;
	assert.equal(classifyReadOnlyBash("cd sub | cat").readOnly, true);
	for (const command of ["cd sub; cat fact.md", "cd absent || cat sub/fact.md"]) {
		const result = await bash.execute("read", { command });
		assert.notEqual(result.isError, true, JSON.stringify(result));
		assert.match(JSON.stringify(result.content), /CD_MARKER/);
	}
});

test("background writes and edits follow internal file and directory symlinks", async (t) => {
	const env = await createToolWorkspace(t, "pi-memory-linked-writes-");
	const directory = join(env.memoryDir, "real");
	await mkdir(directory);
	const target = join(directory, "fact.md");
	await writeFile(target, "old\n");
	const fileLink = join(env.memoryDir, "alias.md");
	const directoryLink = join(env.memoryDir, "alias-directory");
	await symlink(target, fileLink);
	await symlink(directory, directoryLink);
	const tools = new Map(
		createChildTools({
			...env,
			mode: "extractor",
			cwd: env.projectRoot,
			isCurrentGeneration: () => true,
			touchedPaths: new Set(),
		}).map((tool) => [tool.name, tool]),
	);
	await tools.get("read")!.execute("read", { path: fileLink });
	const edited = await tools
		.get("edit")!
		.execute("edit", { path: fileLink, edits: [{ oldText: "old", newText: "new" }] });
	assert.notEqual(edited.isError, true, JSON.stringify(edited));
	const written = await tools
		.get("write")!
		.execute("write", { path: join(directoryLink, "fact.md"), content: "replacement\n" });
	assert.notEqual(written.isError, true, JSON.stringify(written));
	assert.equal(await readFile(target, "utf8"), "replacement\n");
	assert.ok((await lstat(fileLink)).isSymbolicLink());
	const created = await tools
		.get("write")!
		.execute("create", { path: join(directoryLink, "created.md"), content: "created" });
	assert.notEqual(created.isError, true, JSON.stringify(created));
	assert.equal(await readFile(join(directory, "created.md"), "utf8"), "created");
	const deleted = await tools.get("bash")!.execute("delete-link", { command: `rm '${fileLink}'` });
	assert.notEqual(deleted.isError, true, JSON.stringify(deleted));
	await assert.rejects(lstat(fileLink), { code: "ENOENT" });
	assert.equal(await readFile(target, "utf8"), "replacement\n");
	const outside = join(env.root, "outside.md");
	await writeFile(outside, "outside\n");
	for (const destination of [outside, join(env.root, "missing.md")]) {
		await symlink(destination, fileLink);
		const result = await tools.get("bash")!.execute("delete-alias", { command: `rm '${fileLink}'` });
		assert.notEqual(result.isError, true, JSON.stringify(result));
		await assert.rejects(lstat(fileLink), { code: "ENOENT" });
	}
	assert.equal(await readFile(outside, "utf8"), "outside\n");
});

test("background writes use Claude mtime gating without lock-busy failures", async (t) => {
	const env = await createToolWorkspace(t, "pi-memory-write-checks-");
	const path = join(env.memoryDir, "fact.md");
	await writeFile(path, "original\n");
	const tools = new Map(
		createChildTools({
			...env,
			mode: "extractor",
			cwd: env.projectRoot,
			isCurrentGeneration: () => true,
			touchedPaths: new Set(),
		}).map((tool) => [tool.name, tool]),
	);
	const before = await stat(path);
	await utimes(path, before.atime, new Date(1000));
	await tools.get("read")!.execute("read", { path });
	await writeFile(path, "external\n");
	await utimes(path, before.atime, new Date(2000));
	const lease = await acquireLock(join(env.locksDir, "files", `${sha256(path)}.lock`), 60_000);
	assert.ok(lease);
	try {
		const result = await tools.get("write")!.execute("write", { path, content: "updated\n" });
		assert.notEqual(result.isError, true, JSON.stringify(result));
		assert.equal(await readFile(path, "utf8"), "updated\n");
	} finally {
		await lease();
	}
});

test("read-only variable checks and uniq permit safe operands", () => {
	for (const command of ["[[ -v PATH ]]", "[[ -R name ]]", "uniq input.txt", "uniq -f 1 input.txt"])
		assert.equal(classifyReadOnlyBash(command).readOnly, true, command);
	for (const command of ["[[ -v 'x[1]' ]]", "uniq input.txt output.txt"])
		assert.equal(classifyReadOnlyBash(command).readOnly, false, command);
});

test("background Bash runs implicit-path rg and Claude-style sed scripts", async (t) => {
	const env = await createToolWorkspace(t, "pi-memory-native-search-sed-");
	const scratchDir = join(env.root, "scratch");
	await mkdir(scratchDir);
	await writeFile(join(env.projectRoot, "fact.txt"), "SEARCH_MARKER\nsecond\nthird\n");
	const bash = createChildTools({
		...env,
		mode: "extractor",
		cwd: env.projectRoot,
		scratchDir,
		isCurrentGeneration: () => true,
		touchedPaths: new Set(),
	}).find((tool) => tool.name === "bash")!;
	for (const [command, expected] of [
		["rg SEARCH_MARKER", /SEARCH_MARKER/],
		["printf old | sed 's/old/new/'", /new/],
		["sed -n '1p;3p' fact.txt", /SEARCH_MARKER.*third/s],
	] as const) {
		const result = await bash.execute("read", { command });
		assert.notEqual(result.isError, true, JSON.stringify(result));
		assert.match(JSON.stringify(result.content), expected);
	}
});
