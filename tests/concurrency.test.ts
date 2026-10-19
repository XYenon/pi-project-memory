import assert from "node:assert/strict";
import { type ChildProcessByStdio, spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Readable } from "node:stream";
import test from "node:test";
import { createTempDirectory } from "./helpers.ts";

const packageRoot = resolve(import.meta.dirname, "..");
type Worker = ChildProcessByStdio<null, Readable, Readable>;

function worker(fixture: string, args: string[]): Worker {
	return spawn(process.execPath, ["--import=tsx", join(packageRoot, "tests", "fixtures", fixture), ...args], {
		cwd: packageRoot,
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function inlineWorker(source: string, env: NodeJS.ProcessEnv): Worker {
	return spawn(process.execPath, ["--import=tsx", "--input-type=module", "--eval", source], {
		cwd: packageRoot,
		env: { ...process.env, ...env },
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function output(child: Worker): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolvePromise, reject) => {
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => (stdout += String(chunk)));
		child.stderr.on("data", (chunk) => (stderr += String(chunk)));
		child.on("error", reject);
		child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
	});
}

function waitForText(child: Worker, expected: string): Promise<void> {
	return new Promise((resolvePromise, reject) => {
		let stdout = "";
		let stderr = "";
		const onData = (chunk: Buffer | string) => {
			stdout += String(chunk);
			if (stdout.includes(expected)) {
				cleanup();
				resolvePromise();
			}
		};
		const onError = (chunk: Buffer | string) => (stderr += String(chunk));
		const onClose = (code: number | null) => {
			cleanup();
			reject(new Error(`worker exited before ${JSON.stringify(expected)} (${code}): ${stderr}`));
		};
		const cleanup = () => {
			child.stdout.off("data", onData);
			child.stderr.off("data", onError);
			child.off("close", onClose);
		};
		child.stdout.on("data", onData);
		child.stderr.on("data", onError);
		child.on("close", onClose);
	});
}

test("cross-process locks preserve live owners and reclaim dead owners", async (t) => {
	const root = await createTempDirectory(t, "pi-memory-process-lock-");
	const locksDir = join(root, "locks");
	await mkdir(locksDir);

	const releaseFile = join(root, "release-shared");
	t.after(() => writeFile(releaseFile, "release").catch(() => {}));
	const first = worker("lock-worker.ts", [locksDir, "shared", "hold-file", releaseFile, "100"]);
	await waitForText(first, "acquired\n");
	const firstResultPromise = output(first);
	const secondResult = await output(worker("lock-worker.ts", [locksDir, "shared", "hold", "0", "100"]));
	assert.notEqual(secondResult.code, 0);
	assert.match(secondResult.stderr, /lock is busy/);
	await writeFile(releaseFile, "release");
	const firstResult = await firstResultPromise;
	assert.equal(firstResult.code, 0, firstResult.stderr);
	const afterRelease = await output(worker("lock-worker.ts", [locksDir, "shared", "hold", "0", "100"]));
	assert.equal(afterRelease.code, 0, afterRelease.stderr);

	const crashed = worker("lock-worker.ts", [locksDir, "orphan", "crash", "0", "50"]);
	const crashedResult = await output(crashed);
	assert.equal(crashedResult.code, 0, crashedResult.stderr);
	await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
	const recovered = await Promise.all([
		output(worker("lock-worker.ts", [locksDir, "orphan", "hold", "1500", "50"])),
		output(worker("lock-worker.ts", [locksDir, "orphan", "hold", "1500", "50"])),
	]);
	assert.equal(recovered.filter((result) => result.code === 0).length, 1);
	assert.equal(recovered.filter((result) => result.code !== 0).length, 1);
	const afterRecovery = await output(worker("lock-worker.ts", [locksDir, "orphan", "hold", "0", "50"]));
	assert.equal(afterRecovery.code, 0, afterRecovery.stderr);
});

test("cross-process dream timestamp CAS publishes exactly one replacement", async (t) => {
	const root = await createTempDirectory(t, "pi-memory-process-dream-cas-");
	const locksDir = join(root, "locks");
	const marker = join(root, "start");
	await mkdir(locksDir);
	const source = `
		import { access } from "node:fs/promises";
		import { compareAndSwapLastDreamAt } from "./src/store.ts";
		const paths = {
			projectRoot: process.env.ROOT,
			projectKey: "test",
			baseDir: process.env.ROOT,
			memoryDir: process.env.ROOT,
			stateFile: process.env.STATE,
			locksDir: process.env.LOCKS,
		};
		console.log("ready");
		while (true) {
			try { await access(process.env.MARKER); break; } catch { await new Promise((resolve) => setTimeout(resolve, 5)); }
		}
		console.log(JSON.stringify({ swapped: await compareAndSwapLastDreamAt(paths, 0, Number(process.env.VALUE)) }));
	`;
	const common = {
		ROOT: root,
		STATE: join(root, "state.json"),
		LOCKS: locksDir,
		MARKER: marker,
	};
	const first = inlineWorker(source, { ...common, VALUE: "101" });
	const second = inlineWorker(source, { ...common, VALUE: "202" });
	await Promise.all([waitForText(first, "ready\n"), waitForText(second, "ready\n")]);
	const firstResultPromise = output(first);
	const secondResultPromise = output(second);
	await writeFile(marker, "go");
	const results = await Promise.all([firstResultPromise, secondResultPromise]);
	for (const result of results) assert.equal(result.code, 0, result.stderr);
	const swaps = results.map((result) => JSON.parse(result.stdout.trim().split("\n").at(-1)!).swapped);
	assert.equal(swaps.filter(Boolean).length, 1);
	const state = JSON.parse(await readFile(join(root, "state.json"), "utf8"));
	assert.ok(state.lastDreamAt === 101 || state.lastDreamAt === 202);
});

test("cross-process memory edits publish complete files without a lock-busy rejection", async (t) => {
	const root = await createTempDirectory(t, "pi-memory-process-cas-");
	const memoryDir = join(root, "memory");
	const projectRoot = join(root, "project");
	const locksDir = join(root, "locks");
	await Promise.all([mkdir(memoryDir), mkdir(projectRoot), mkdir(locksDir)]);
	const filePath = join(memoryDir, "fact.md");
	const marker = join(root, "start");
	await writeFile(filePath, "initial\n");

	const first = worker("cas-worker.ts", [memoryDir, projectRoot, locksDir, filePath, marker, "first"]);
	const second = worker("cas-worker.ts", [memoryDir, projectRoot, locksDir, filePath, marker, "second"]);
	await Promise.all([waitForText(first, "ready\n"), waitForText(second, "ready\n")]);
	const firstResultPromise = output(first);
	const secondResultPromise = output(second);
	await writeFile(marker, "go");
	const [firstResult, secondResult] = await Promise.all([firstResultPromise, secondResultPromise]);
	assert.equal(firstResult.code, 0, firstResult.stderr);
	assert.equal(secondResult.code, 0, secondResult.stderr);
	const results = [firstResult.stdout, secondResult.stdout].map((text) => JSON.parse(text.trim().split("\n").at(-1)!));
	assert.ok(results.some((result) => result.isError === false));
	for (const result of results) assert.doesNotMatch(JSON.stringify(result), /Another memory writer/);
	assert.match(await readFile(filePath, "utf8"), /^(?:first|second)\n$/);
});
