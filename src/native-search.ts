import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";

/** Run Pi's native search factory without changing the host's environment. */
export async function runNativeSearch(
	name: "find" | "grep",
	params: Record<string, unknown>,
	policy: { cwd: string; roots: string[]; excludedRoots: string[] },
	signal?: AbortSignal,
): Promise<AgentToolResult<unknown>> {
	if (signal?.aborted) throw new Error("Search was aborted");
	const directory = await mkdtemp(join(tmpdir(), "pi-project-memory-search-"));
	const worker = fileURLToPath(new URL("./native-search-worker.mjs", import.meta.url));
	try {
		return await new Promise<AgentToolResult<unknown>>((resolve, reject) => {
			const child = spawn(process.execPath, [worker], {
				stdio: ["pipe", "pipe", "pipe"],
				detached: true,
				env: {
					PATH: process.env.PATH ?? "/usr/bin:/bin",
					HOME: directory,
					TMPDIR: directory,
					PI_CODING_AGENT_DIR: directory,
					PI_OFFLINE: "1",
					RIPGREP_CONFIG_PATH: "",
				},
			});
			let output = "";
			let errors = "";
			let failure: Error | undefined;
			const stop = () => {
				failure ??= new Error("Search was aborted");
				if (child.pid) {
					try {
						process.kill(-child.pid, "SIGTERM");
					} catch {}
				}
			};
			signal?.addEventListener("abort", stop, { once: true });
			child.stdout.on("data", (chunk) => {
				output += chunk.toString();
				if (Buffer.byteLength(output) > 4 * 1024 * 1024) {
					failure = new Error("Native search result exceeds the transport limit");
					stop();
				}
			});
			child.stderr.on("data", (chunk) => {
				errors = `${errors}${chunk}`.slice(-4096);
			});
			child.on("error", (error) => {
				signal?.removeEventListener("abort", stop);
				reject(error);
			});
			child.on("close", (code) => {
				signal?.removeEventListener("abort", stop);
				if (failure) return reject(failure);
				if (code !== 0) return reject(new Error(errors || `Native search exited with code ${code}`));
				try {
					resolve(JSON.parse(output) as AgentToolResult<unknown>);
				} catch {
					reject(new Error("Native search returned invalid JSON"));
				}
			});
			child.stdin.on("error", () => {});
			child.stdin.end(JSON.stringify({ name, params, policy, directory }));
			if (signal?.aborted) stop();
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}
