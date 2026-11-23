import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { runChildAgent } from "../src/models.ts";
import { resolveProjectPaths } from "../src/paths.ts";
import { mainMemoryPrompt } from "../src/prompts.ts";

async function harness(t: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "pi-storage-integration-"));
	const agent = join(root, "agent");
	const cwd = join(root, "project");
	const sessions = join(root, "sessions");
	await Promise.all([mkdir(join(agent, "project-memory"), { recursive: true }), mkdir(cwd), mkdir(sessions)]);
	const old = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agent;
	t.after(async () => {
		if (old === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = old;
		await rm(root, { recursive: true, force: true });
	});
	const config = structuredClone(DEFAULT_CONFIG);
	config.useProjectMemory = true;
	config.extraction.idleFlushSeconds = 0;
	config.dream.enabled = true;
	config.extraction.maxTurns = 4;
	config.dream.maxTurns = 4;
	const configFile = join(agent, "project-memory", "config.json");
	await writeFile(configFile, JSON.stringify(config));
	const faux = createFauxCore({ models: [{ id: "runtime-model", reasoning: false }] });
	const notices: string[] = [];
	const entries: any[] = [];
	const handlers = new Map<string, any[]>();
	const commands = new Map<string, any>();
	const messages = [{ role: "user", content: "Remember my durable testing preference", timestamp: 1 }];
	const ctx = {
		cwd,
		mode: "rpc",
		hasUI: true,
		model: faux.getModel(),
		modelRegistry: { streamSimple: faux.streamSimple },
		isIdle: () => true,
		isProjectTrusted: () => true,
		getSystemPrompt: () => mainMemoryPrompt(join(cwd, ".pi", "memory")),
		ui: { notify: (text: string) => notices.push(text) },
		sessionManager: {
			getBranch: () => [],
			getSessionId: () => "actual-session-id",
			getSessionDir: () => sessions,
			getSessionFile: () => undefined,
			usesDefaultSessionDir: () => true,
			buildSessionProjection: () => ({ messages, entries: [{ sourceEntry: { id: "turn-1" }, messages }] }),
		},
	} as unknown as ExtensionContext;
	const api = {
		on: (name: string, handler: any) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		registerCommand: (name: string, value: any) => commands.set(name, value),
		registerMessageRenderer() {},
		registerEntryRenderer() {},
		getActiveTools: () => [],
		getSettings: () => ({}),
		appendEntry: (type: string, data: any) => entries.push({ type, data }),
		sendMessage() {},
	} as unknown as ExtensionAPI;
	const emit = async (name: string, event: any = {}) => {
		let result: any;
		for (const handler of handlers.get(name) ?? []) result = await handler(event, ctx);
		return result;
	};
	extension(api);
	await emit("session_start");
	const paths = await resolveProjectPaths(cwd, null, true);
	const command = (args: string) => commands.get("memory").handler(args, ctx);
	const run = (role: "extractor" | "dream", extra: Partial<Parameters<typeof runChildAgent>[0]> = {}) =>
		runChildAgent({
			role,
			prompt: `Use ${paths.memoryDir}`,
			systemPrompt: mainMemoryPrompt(paths.memoryDir),
			sourceMessages: [],
			parentContext: {
				model: ctx.model!,
				sessionId: "old-parent",
				messages: [{ role: "system", content: mainMemoryPrompt(paths.memoryDir), timestamp: 1 }] as any,
			},
			paths,
			config,
			ctx,
			isCurrentGeneration: () => true,
			...extra,
		});
	return { root, cwd, paths, config, configFile, ctx, faux, notices, emit, command, run };
}

test("directory configuration remains pinned through disable/re-enable and runtime reload", async (t) => {
	const h = await harness(t);
	const next = {
		...h.config,
		useProjectMemory: false,
		autoMemoryDirectory: join(h.root, "other"),
		projectMemoryDirectory: ".em",
		enabled: false,
	};
	await writeFile(h.configFile, JSON.stringify(next));
	await h.command("reload-config");
	await writeFile(h.configFile, JSON.stringify({ ...next, enabled: true }));
	await h.command("reload-config");
	assert.ok(
		h.notices.some((text) =>
			text.includes(
				"autoMemoryDirectory/useProjectMemory/projectMemoryDirectory changes apply after the next session start",
			),
		),
	);
	await h.emit("session_start", { reason: "reload" });
	const event = { messageType: "custom", systemPromptOptions: { sections: {} as Record<string, string> } };
	await h.emit("before_agent_start", event);
	// The prompt should show the pinned project-memory directory (.pi) not the new .em
	assert.match(event.systemPromptOptions.sections.auto_memory!, /\.pi\/memory/);
	assert.doesNotMatch(event.systemPromptOptions.sections.auto_memory!, /\.em\/memory/);
});

test("default mode retains native writes, touchedPaths, parent file access and plain prompt", async (t) => {
	const h = await harness(t);
	h.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("write", { path: join(h.paths.memoryDir, "direct.md"), content: "direct\n" })),
		fauxAssistantMessage("done"),
	]);
	const result = await h.run("extractor");
	assert.deepEqual(result.touchedPaths, ["direct.md"]);
	for (const toolName of ["read", "write", "edit"]) {
		assert.equal(
			await h.emit("tool_call", { toolName, input: { path: join(h.paths.memoryDir, "direct.md") } }),
			undefined,
		);
	}
	const event = { messageType: "custom", systemPromptOptions: { sections: {} as Record<string, string> } };
	await h.emit("before_agent_start", event);
	assert.match(event.systemPromptOptions.sections.auto_memory!, /write to it directly/);
	assert.doesNotMatch(event.systemPromptOptions.sections.auto_memory!, /read-only to this agent/);
});
