import assert from "node:assert/strict";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG } from "../src/config.ts";
import {
	applySelectorOutputSchema,
	effectiveThinkingLevel,
	parseSelectorResponse,
	runChildAgent,
	SELECTOR_OUTPUT_SCHEMA,
	sanitizeRecentMessages,
	selectorShouldFallbackToTool,
	selectRelevantMemories,
	supportsSelectorOutputSchema,
} from "../src/models.ts";
import { SELECTOR_SYSTEM_PROMPT } from "../src/prompts.ts";
import { createTempDirectory } from "./helpers.ts";

const topics = Array.from({ length: 7 }, (_, index) => ({
	filename: `topic-${index}.md`,
	filePath: `/memory/topic-${index}.md`,
	name: `topic-${index}`,
	description: "test",
	type: "project" as const,
	mtimeMs: 0,
	modifiedMs: 0,
	sizeBytes: 4,
}));

function selectorContext(
	model: Model<any>,
	streamSimple: (model: Model<any>, context: any, options: any) => any,
	availableModels = [model],
) {
	const notices: Array<{ message: string; level: string }> = [];
	return {
		notices,
		ui: { notify: (message: string, level: string) => notices.push({ message, level }) },
		model,
		signal: undefined,
		sessionManager: { getSessionId: () => "selector-session" },
		scopedModels: [],
		modelRegistry: {
			getAvailable: () => availableModels,
			hasConfiguredAuth: () => true,
			streamSimple,
		},
	} as any;
}

test("selector output is strict, catalog-bound, and capped at five topics", () => {
	const selected = parseSelectorResponse(
		JSON.stringify({ selected_memories: [...topics.map((topic) => topic.filename), "../escape.md"] }),
		topics,
	);
	assert.deepEqual(
		selected,
		topics.slice(0, 5).map((topic) => topic.filename),
	);
	assert.deepEqual(parseSelectorResponse('{"selected_memories":["[project] topic-0.md"]}', topics), ["topic-0.md"]);
	assert.throws(() => parseSelectorResponse('```json\n{"selected_memories":[]}\n```', topics), SyntaxError);
	assert.throws(() => parseSelectorResponse('{"selected_memories":[],"extra":true}', topics), TypeError);
	assert.throws(() => parseSelectorResponse('{"selected_memories":["topic-0.md",123]}', topics), TypeError);
	assert.deepEqual(parseSelectorResponse('{"selected_memories":[]}', topics), []);
});

test("selector structured output uses Claude Code's exact JSON schema", () => {
	assert.deepEqual(SELECTOR_OUTPUT_SCHEMA, {
		type: "object",
		properties: { selected_memories: { type: "array", items: { type: "string" } } },
		required: ["selected_memories"],
		additionalProperties: false,
	});
	const anthropic = { api: "anthropic-messages" } as Model<any>;
	assert.deepEqual(applySelectorOutputSchema({ stream: true, betas: ["existing-beta"] }, anthropic), {
		stream: true,
		betas: ["existing-beta", "structured-outputs-2025-12-15"],
		output_config: { format: { type: "json_schema", schema: SELECTOR_OUTPUT_SCHEMA } },
	});
	const openai = { api: "openai-responses" } as Model<any>;
	assert.deepEqual(applySelectorOutputSchema({ stream: true }, openai), {
		stream: true,
		text: { format: { type: "json_schema", name: "memory_selector", strict: true, schema: SELECTOR_OUTPUT_SCHEMA } },
	});
	const bedrock = { api: "bedrock-converse-stream" } as Model<any>;
	assert.deepEqual(applySelectorOutputSchema({ modelId: "x" }, bedrock), {
		modelId: "x",
		outputConfig: {
			textFormat: {
				type: "json_schema",
				structure: { jsonSchema: { name: "memory_selector", schema: JSON.stringify(SELECTOR_OUTPUT_SCHEMA) } },
			},
		},
	});
	const piMessages = { api: "pi-messages" } as Model<any>;
	const custom = { api: "custom-api" } as Model<any>;
	assert.deepEqual(applySelectorOutputSchema({ stream: true }, piMessages), { stream: true });
	assert.deepEqual(applySelectorOutputSchema({ stream: true }, custom), { stream: true });
	assert.equal(supportsSelectorOutputSchema(anthropic), true);
	assert.equal(supportsSelectorOutputSchema(openai), true);
	assert.equal(supportsSelectorOutputSchema(bedrock), true);
	assert.equal(supportsSelectorOutputSchema(piMessages), false);
	assert.equal(supportsSelectorOutputSchema(custom), false);
});

test("selector retries a failed output-format request through the schema tool", async () => {
	const primary = {
		provider: "test",
		id: "sonnet",
		name: "Sonnet",
		api: "openai-completions",
		reasoning: false,
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
	} as Model<any>;
	const calls: Array<{ context: any; options: any }> = [];
	const errorResponse = {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "test",
		model: "sonnet",
		usage: {},
		stopReason: "error",
		errorMessage: "response_format json_schema is unsupported",
		timestamp: 1,
	} as any;
	const toolResponse = {
		role: "assistant",
		content: [{ type: "toolCall", id: "1", name: "select_memories", arguments: { selected_memories: ["topic-0.md"] } }],
		api: "openai-completions",
		provider: "test",
		model: "sonnet",
		usage: {},
		stopReason: "toolUse",
		timestamp: 2,
	} as any;
	const responses = [errorResponse, toolResponse];
	const ctx = selectorContext(primary, (_model, context, options) => {
		calls.push({ context, options });
		const response = responses.shift();
		return { result: async () => response };
	});
	const selected = await selectRelevantMemories("query", topics, new Map(), DEFAULT_CONFIG, ctx);
	assert.deepEqual(selected, ["topic-0.md"]);
	assert.equal(typeof calls[0]!.options.onPayload, "function");
	assert.equal(calls[0]!.context.tools, undefined);
	assert.equal(calls[1]!.options.onPayload, undefined);
	assert.equal(calls[1]!.context.tools.length, 1);
});

test("selector discards malformed native output without a schema-tool retry", async () => {
	const primary = {
		provider: "test",
		id: "selector",
		name: "Selector",
		api: "openai-responses",
		reasoning: false,
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
	} as Model<any>;
	const calls: any[] = [];
	const responses = [
		{
			role: "assistant",
			content: [{ type: "text", text: '{"selected_memories":["topic-0.md",123]}' }],
			api: primary.api,
			provider: primary.provider,
			model: primary.id,
			usage: {},
			stopReason: "stop",
			timestamp: 1,
		},
		{
			role: "assistant",
			content: [
				{ type: "toolCall", id: "1", name: "select_memories", arguments: { selected_memories: ["topic-1.md"] } },
			],
			api: primary.api,
			provider: primary.provider,
			model: primary.id,
			usage: {},
			stopReason: "toolUse",
			timestamp: 2,
		},
	];
	const ctx = selectorContext(primary, (_model, context) => {
		calls.push(context);
		return { result: async () => responses.shift() };
	});
	assert.deepEqual(await selectRelevantMemories("query", topics, new Map(), DEFAULT_CONFIG, ctx), []);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].tools, undefined);
	assert.equal(ctx.notices.length, 1);
});

test("known non-format failures do not trigger a schema-tool retry", async () => {
	const primary = {
		provider: "test",
		id: "claude-sonnet-primary",
		name: "Claude Sonnet Primary",
		api: "openai-completions",
		reasoning: false,
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
	} as Model<any>;
	let calls = 0;
	const failure = Object.assign(new Error("rate limit exceeded"), { status: 429 });
	const ctx = selectorContext(primary, () => {
		calls++;
		return { result: async () => Promise.reject(failure) };
	});
	assert.deepEqual(await selectRelevantMemories("query", topics, new Map(), DEFAULT_CONFIG, ctx), []);
	assert.match(ctx.notices[0].message, /rate limit exceeded/);
	assert.equal(calls, 1);
	assert.equal(
		selectorShouldFallbackToTool(Object.assign(new Error("response_format unsupported"), { status: 400 })),
		true,
	);
	assert.equal(
		selectorShouldFallbackToTool(Object.assign(new Error("json_schema unsupported"), { status: 422 })),
		true,
	);
	assert.equal(selectorShouldFallbackToTool(Object.assign(new Error("generic bad request"), { status: 400 })), true);
	assert.equal(
		selectorShouldFallbackToTool(
			Object.assign(new Error("provider request failed"), {
				cause: Object.assign(new Error("response_format unsupported"), { status: 400 }),
			}),
		),
		true,
	);
	for (const status of [401, 403, 408, 429, 500, 503]) {
		assert.equal(selectorShouldFallbackToTool(Object.assign(new Error("any message"), { status })), false);
		assert.equal(
			selectorShouldFallbackToTool(
				Object.assign(new Error("structured output json_schema request failed"), { status }),
			),
			false,
		);
	}
	for (const message of [
		"HTTP 401 structured output failed",
		"HTTP 500 response_format failed",
		"network error in json_schema",
		"timeout requesting output_config",
	])
		assert.equal(selectorShouldFallbackToTool(new Error(message)), false);
	assert.equal(selectorShouldFallbackToTool(new Error("arbitrary provider failure")), true);
	assert.equal(selectorShouldFallbackToTool(new Error("response_format json_schema is unsupported")), true);
	assert.equal(selectorShouldFallbackToTool(Object.assign(new Error("aborted"), { name: "AbortError" })), false);
	assert.equal(
		selectorShouldFallbackToTool(Object.assign(new Error("network"), { cause: { code: "ECONNRESET" } })),
		false,
	);
});

test("selector warns and returns no selection after its final request fails", async () => {
	const model = { provider: "test", api: "openai-responses", id: "selector", reasoning: false } as Model<any>;
	for (const structuredOutput of [true, false]) {
		for (const outcome of ["thrown", "returned"] as const) {
			const failure = Object.assign(new Error("authentication rejected"), { status: 401 });
			let calls = 0;
			const history: any[] = [];
			const ctx = selectorContext(model, () => {
				calls++;
				return {
					result: async () => {
						if (structuredOutput && calls === 1) throw Object.assign(new Error("unsupported"), { status: 400 });
						if (outcome === "thrown") throw failure;
						return {
							role: "assistant",
							content: [],
							usage: {},
							stopReason: "error",
							errorMessage: failure.message,
						};
					},
				};
			});
			const config = {
				...DEFAULT_CONFIG,
				models: { ...DEFAULT_CONFIG.models, selector: { ...DEFAULT_CONFIG.models.selector, structuredOutput } },
			};
			assert.deepEqual(await selectRelevantMemories("query", topics, new Map(), config, ctx, history), []);
			assert.equal(ctx.notices.length, 1);
			assert.match(ctx.notices[0].message, /authentication rejected/);
			assert.equal(calls, structuredOutput ? 2 : 1);
			assert.deepEqual(history, []);
		}
	}
});

test("selector warns for malformed output and silently accepts a successful empty selection", async () => {
	const model = { provider: "test", api: "openai-responses", id: "selector", reasoning: false } as Model<any>;
	for (const structuredOutput of [true, false]) {
		for (const text of ["", "{", '{"selected_memories":[123]}', '{"selected_memories":[]}']) {
			let calls = 0;
			const history: any[] = [];
			const ctx = selectorContext(model, () => {
				calls++;
				return {
					result: async () => ({
						role: "assistant",
						content: text ? [{ type: "text", text }] : [],
						usage: {},
						stopReason: "stop",
					}),
				};
			});
			const config = {
				...DEFAULT_CONFIG,
				models: { ...DEFAULT_CONFIG.models, selector: { ...DEFAULT_CONFIG.models.selector, structuredOutput } },
			};
			assert.deepEqual(await selectRelevantMemories("query", topics, new Map(), config, ctx, history), []);
			assert.equal(calls, 1);
			if (text === '{"selected_memories":[]}') {
				assert.equal(history.length, 1);
				assert.deepEqual(ctx.notices, []);
			} else {
				assert.equal(ctx.notices.length, 1);
				assert.deepEqual(history, []);
			}
		}
	}
});

test("cancelled selector requests return no selection without warning", async () => {
	const model = { provider: "test", api: "openai-responses", id: "selector", reasoning: false } as Model<any>;
	for (const outcome of ["thrown", "returned"] as const) {
		const controller = new AbortController();
		let calls = 0;
		const ctx = selectorContext(model, () => {
			calls++;
			return {
				result: async () => {
					controller.abort();
					if (outcome === "thrown") throw Object.assign(new Error("cancelled"), { name: "AbortError" });
					return { role: "assistant", content: [], usage: {}, stopReason: "aborted" };
				},
			};
		});
		assert.deepEqual(
			await selectRelevantMemories("query", topics, new Map(), DEFAULT_CONFIG, ctx, [], controller.signal),
			[],
		);
		assert.equal(calls, 1);
		assert.deepEqual(ctx.notices, []);
	}
});

test("returned selector failures never retry forbidden statuses even with format keywords", async () => {
	const model = { provider: "test", api: "openai-responses", id: "selector", reasoning: false } as Model<any>;
	for (const errorMessage of [
		"HTTP 401 structured output failed",
		"HTTP 403 response_format failed",
		"HTTP 429 json_schema failed",
		"HTTP 500 output_config failed",
		"authentication_error: response_format",
	]) {
		let calls = 0;
		const ctx = selectorContext(model, () => {
			calls++;
			return {
				result: async () => ({
					role: "assistant",
					content: [],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {},
					stopReason: "error",
					errorMessage,
					timestamp: 1,
				}),
			};
		});
		assert.deepEqual(await selectRelevantMemories("query", topics, new Map(), DEFAULT_CONFIG, ctx), []);
		assert.equal(ctx.notices[0].message, `memory selector: ${errorMessage}`);
		assert.equal(calls, 1);
	}
});

test("length responses warn and return no selection even when they contain valid JSON", async () => {
	const primary = {
		provider: "test",
		id: "claude-sonnet-primary",
		name: "Claude Sonnet Primary",
		api: "custom-api",
		reasoning: false,
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
	} as Model<any>;
	const ctx = selectorContext(primary, () => ({
		result: async () => ({
			role: "assistant",
			content: [{ type: "text", text: '{"selected_memories":["topic-0.md"]}' }],
			api: "custom-api",
			provider: "test",
			model: primary.id,
			usage: {},
			stopReason: "length",
			timestamp: 1,
		}),
	}));
	assert.deepEqual(await selectRelevantMemories("query", topics, new Map(), DEFAULT_CONFIG, ctx), []);
	assert.match(ctx.notices[0].message, /length/);
});

test("provider refusal does not switch away from the configured selector model", async () => {
	const primary = {
		provider: "first",
		id: "configured-selector",
		name: "Configured Selector",
		api: "openai-completions",
		reasoning: false,
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
	} as Model<any>;
	const other = { ...primary, provider: "second", id: "other-model" } as Model<any>;
	const calls: string[] = [];
	const ctx = selectorContext(
		primary,
		(selected) => {
			calls.push(selected.id);
			return {
				result: async () => ({
					role: "assistant",
					content: [],
					api: "custom-api",
					provider: selected.provider,
					model: selected.id,
					usage: {},
					stopReason: "error",
					rawStopReason: "content_filtered",
					timestamp: 1,
				}),
			};
		},
		[primary, other],
	);
	assert.deepEqual(await selectRelevantMemories("query", topics, new Map(), DEFAULT_CONFIG, ctx), []);
	assert.match(ctx.notices[0].message, /content_filtered/);
	assert.deepEqual(calls, [primary.id]);
});

test("selector keeps the schema-tool path when native structured output is disabled", async () => {
	const primary = {
		provider: "test",
		id: "sonnet",
		name: "Sonnet",
		api: "anthropic-messages",
		reasoning: false,
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
	} as Model<any>;
	let captured: { context: any; options: any } | undefined;
	const response = {
		role: "assistant",
		content: [{ type: "toolCall", id: "1", name: "select_memories", arguments: { selected_memories: ["topic-0.md"] } }],
		api: primary.api,
		provider: "test",
		model: "sonnet",
		usage: {},
		stopReason: "toolUse",
		timestamp: 2,
	} as any;
	const ctx = selectorContext(primary, (_model, context, options) => {
		captured = { context, options };
		return { result: async () => response };
	});
	const config = structuredClone(DEFAULT_CONFIG);
	config.models.selector.structuredOutput = false;
	assert.deepEqual(await selectRelevantMemories("query", topics, new Map(), config, ctx), ["topic-0.md"]);
	assert.equal(captured!.options.onPayload, undefined);
	assert.equal(captured!.context.tools.length, 1);
	assert.equal(
		captured!.context.systemPrompt,
		`${SELECTOR_SYSTEM_PROMPT}\nCall the select_memories tool exactly once with the JSON object you would otherwise return.`,
	);
});

test("pi-messages and unknown APIs go directly to the same-model schema tool", async () => {
	for (const api of ["pi-messages", "custom-api"]) {
		const primary = {
			provider: "test",
			id: `selector-${api}`,
			name: `Selector ${api}`,
			api,
			reasoning: false,
			cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		} as Model<any>;
		let captured: { selected: Model<any>; context: any; options: any } | undefined;
		const ctx = selectorContext(primary, (selected, context, options) => {
			captured = { selected, context, options };
			return {
				result: async () => ({
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "1",
							name: "select_memories",
							arguments: { selected_memories: ["topic-0.md"] },
						},
					],
					api,
					provider: primary.provider,
					model: primary.id,
					usage: {},
					stopReason: "toolUse",
					timestamp: 1,
				}),
			};
		});
		assert.deepEqual(await selectRelevantMemories("query", topics, new Map(), DEFAULT_CONFIG, ctx), ["topic-0.md"]);
		assert.equal(captured!.selected, primary);
		assert.equal(captured!.options.onPayload, undefined);
		assert.equal(captured!.context.tools[0].name, "select_memories");
	}
});

test("selector keeps its catalog and cached query history while filtering recalled files after selection", async () => {
	const primary = {
		provider: "test",
		id: "claude-sonnet-primary",
		name: "Claude Sonnet Primary",
		api: "custom-api",
		reasoning: false,
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
	} as Model<any>;
	const contexts: any[] = [];
	const requests: any[] = [];
	let timestamp = 1;
	const ctx = selectorContext(primary, (_model, context, options) => {
		contexts.push(context);
		requests.push(options);
		return {
			result: async () => ({
				role: "assistant",
				content: [{ type: "text", text: '{"selected_memories":["topic-0.md","topic-1.md"]}' }],
				api: "custom-api",
				provider: "test",
				model: primary.id,
				usage: {},
				stopReason: "stop",
				timestamp: timestamp++,
			}),
		};
	});
	const history: any[] = [];
	await selectRelevantMemories("first query", topics, new Map(), DEFAULT_CONFIG, ctx, history);
	assert.deepEqual(
		await selectRelevantMemories("second query", topics, new Map([["topic-0.md", 0]]), DEFAULT_CONFIG, ctx, history),
		["topic-1.md"],
	);
	assert.deepEqual(contexts[1].messages[0].content, contexts[0].messages[0].content);
	assert.equal(requests[0].cacheRetention, "short");
	assert.equal(requests[1].sessionId, requests[0].sessionId);
	assert.equal(history.length, 2);
	assert.deepEqual(
		contexts[1].messages.map((message: any) => message.role),
		["user", "user", "assistant", "user"],
	);
	assert.match(contexts[1].messages[1].content[0].text, /first query/);
});

test("background replay preserves Pi compaction and branch summaries", () => {
	const messages = [
		{ role: "compactionSummary" as const, summary: "historical project constraint", tokensBefore: 100, timestamp: 1 },
		{ role: "branchSummary" as const, summary: "returned branch decision", fromId: "branch", timestamp: 2 },
	];
	const replay = sanitizeRecentMessages(messages, Number.POSITIVE_INFINITY);
	assert.deepEqual(replay, convertToLlm(messages));
	assert.equal(replay.length, 2);
	assert.match(JSON.stringify(replay), /historical project constraint/);
	assert.match(JSON.stringify(replay), /returned branch decision/);
});

test("extraction replay preserves thinking only for the same concrete model", () => {
	const assistant = {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "hidden", thinkingSignature: "opaque-thinking" },
			{ type: "text", text: "visible", textSignature: "opaque-text" },
			{
				type: "toolCall",
				id: "call-1",
				name: "read",
				arguments: { path: "x" },
				thoughtSignature: "opaque-tool",
			},
		],
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 1,
	} as any;
	const toolResult = {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "read",
		content: [{ type: "text", text: "result" }],
		isError: false,
		timestamp: 2,
	} as any;
	const messages = [{ role: "user", content: "request", timestamp: 0 } as any, assistant, toolResult];
	const sameModel = {
		provider: assistant.provider,
		api: assistant.api,
		id: assistant.model,
	} as Model<any>;
	const inherited = sanitizeRecentMessages(messages, Number.MAX_SAFE_INTEGER);
	const same = sanitizeRecentMessages(messages, Number.MAX_SAFE_INTEGER, sameModel);
	assert.equal(inherited[1], assistant);
	assert.equal(same[1], assistant);
	assert.equal(same[2], toolResult);

	for (const otherModel of [
		{ ...sameModel, id: "other-model" },
		{ ...sameModel, provider: "other-provider" },
		{ ...sameModel, api: "other-api" },
	]) {
		const replay = sanitizeRecentMessages(messages, Number.MAX_SAFE_INTEGER, otherModel);
		assert.deepEqual((replay[1] as any).content, [
			{ type: "text", text: "visible" },
			{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "x" } },
		]);
		assert.equal(replay[2], toolResult);
	}
});

test("dream child inherits parent messages and applies cross-model replay sanitization", async () => {
	const faux = createFauxCore({
		provider: "dream-provider",
		api: "dream-api",
		models: [{ id: "dream-model", reasoning: false }],
	});
	let captured: any;
	faux.setResponses([
		(context) => {
			captured = context;
			return fauxAssistantMessage("done");
		},
	]);
	const sourceMessages = [
		{ role: "user", content: "parent request", timestamp: 1 },
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "private", thinkingSignature: "opaque" },
				{ type: "text", text: "parent answer", textSignature: "provider-signature" },
			],
			api: "other-api",
			provider: "other-provider",
			model: "other-model",
			usage: {},
			stopReason: "stop",
			timestamp: 2,
		},
	] as any;
	await runChildAgent({
		role: "dream",
		prompt: "dream prompt",
		sourceMessages,
		systemPrompt: "system",
		config: structuredClone(DEFAULT_CONFIG),
		paths: {
			projectRoot: "/",
			projectKey: "test",
			baseDir: "/",
			memoryDir: "/",
			stateFile: "/state.json",
			locksDir: "/",
		},
		sessionDir: "/",
		isCurrentGeneration: () => true,
		ctx: {
			cwd: "/",
			model: faux.getModel(),
			isProjectTrusted: () => true,
			modelRegistry: { streamSimple: faux.streamSimple },
		} as any,
	});
	assert.ok(captured.systemPrompt.startsWith("system\n\n"));
	assert.match(
		captured.systemPrompt,
		/Earlier tool inventories and tool-routing instructions describe the parent session/,
	);
	for (const tool of captured.tools) assert.ok(captured.systemPrompt.includes(`- ${tool.name}: ${tool.description}`));
	assert.deepEqual(
		captured.messages.map((message: any) => message.role),
		["user", "assistant", "user"],
	);
	assert.equal(captured.messages[0].content, "parent request");
	assert.deepEqual(captured.messages[1].content, [{ type: "text", text: "parent answer" }]);
	assert.equal(captured.messages[2].content[0].text, "dream prompt");
});

test("child runs pass the parent cwd to tools instead of the canonical project root", async (t) => {
	const root = await createTempDirectory(t, "pi-memory-parent-cwd-");
	const projectRoot = join(root, "checkout");
	const cwd = join(root, "worktree", "nested");
	const memoryDir = join(root, "memory");
	const locksDir = join(root, "locks");
	await Promise.all([mkdir(projectRoot), mkdir(cwd, { recursive: true }), mkdir(memoryDir), mkdir(locksDir)]);
	await writeFile(join(projectRoot, "fact.txt"), "checkout fact\n");
	await writeFile(join(cwd, "fact.txt"), "parent fact\n");
	for (const role of ["extractor", "dream"] as const) {
		const target = join(memoryDir, `${role}.md`);
		const faux = createFauxCore({ models: [{ id: "cwd-model", reasoning: false }] });
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path: "fact.txt" })),
			(context) => {
				const read = context.messages.at(-1);
				assert.equal(read?.role, "toolResult");
				assert.match(JSON.stringify(read?.content), /parent fact/);
				assert.doesNotMatch(JSON.stringify(read?.content), /checkout fact/);
				return fauxAssistantMessage(fauxToolCall("write", { path: relative(cwd, target), content: "saved fact\n" }));
			},
			fauxAssistantMessage("done"),
		]);
		const result = await runChildAgent({
			role,
			prompt: "remember the fact",
			sourceMessages: [],
			systemPrompt: "system",
			config: structuredClone(DEFAULT_CONFIG),
			paths: {
				projectRoot,
				projectKey: "test",
				baseDir: root,
				memoryDir,
				stateFile: join(root, "state.json"),
				locksDir,
			},
			isCurrentGeneration: () => true,
			ctx: {
				cwd,
				model: faux.getModel(),
				isProjectTrusted: () => true,
				modelRegistry: { streamSimple: faux.streamSimple },
			} as any,
		});
		assert.equal(result.error, undefined);
		assert.deepEqual(result.touchedPaths, [`${role}.md`]);
		assert.equal(await readFile(target, "utf8"), "saved fact\n");
	}
});

test("child maxTurns executes final-turn tools without another model request", async (t) => {
	const root = await createTempDirectory(t, "pi-memory-max-turn-");
	const memoryDir = join(root, "memory");
	const projectRoot = join(root, "project");
	const locksDir = join(root, "locks");
	await Promise.all([mkdir(memoryDir), mkdir(projectRoot), mkdir(locksDir)]);
	const target = join(memoryDir, "saved.md");
	const faux = createFauxCore({ models: [{ id: "faux-1", reasoning: false }] });
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("write", { path: target, content: "saved fact" }, { id: "write-1" }), {
			stopReason: "toolUse",
		}),
	]);
	const model = faux.getModel() as Model<any>;
	const config = structuredClone(DEFAULT_CONFIG);
	config.extraction.maxTurns = 1;
	const result = await runChildAgent({
		role: "extractor",
		prompt: "extract",
		sourceMessages: [],
		systemPrompt: "system",
		config,
		paths: {
			projectRoot,
			projectKey: "test",
			baseDir: root,
			memoryDir,
			stateFile: join(root, "state.json"),
			locksDir,
		},
		isCurrentGeneration: () => true,
		ctx: {
			cwd: projectRoot,
			model,
			isProjectTrusted: () => true,
			modelRegistry: { streamSimple: faux.streamSimple },
		} as any,
	});
	assert.equal(faux.state.callCount, 1);
	assert.equal(result.turns, 1);
	assert.deepEqual(result.touchedPaths, ["saved.md"]);
	assert.equal(result.stopReason, "toolUse");
	assert.equal(result.error, undefined);
	assert.ok(result.usage.totalTokens > 0);
	assert.equal(await readFile(target, "utf8"), "saved fact");
});

test("child loop executes complete tool calls with a non-error stop reason", async (t) => {
	const root = await createTempDirectory(t, "pi-memory-stop-tool-");
	const memoryDir = join(root, "memory");
	const projectRoot = join(root, "project");
	const locksDir = join(root, "locks");
	await Promise.all([mkdir(memoryDir), mkdir(projectRoot), mkdir(locksDir)]);
	const target = join(memoryDir, "written.md");
	const faux = createFauxCore({ models: [{ id: "faux-1", reasoning: false }] });
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("write", { path: target, content: "written" }), {
			stopReason: "stop",
		}),
		fauxAssistantMessage("done"),
	]);
	const config = structuredClone(DEFAULT_CONFIG);
	config.extraction.maxTurns = 2;
	const sessionIds: string[] = [];
	const result = await runChildAgent({
		role: "extractor",
		prompt: "extract",
		sourceMessages: [],
		systemPrompt: "system",
		config,
		paths: { projectRoot, projectKey: "test", baseDir: root, memoryDir, stateFile: join(root, "state.json"), locksDir },
		isCurrentGeneration: () => true,
		ctx: {
			cwd: projectRoot,
			model: faux.getModel(),
			isProjectTrusted: () => true,
			modelRegistry: {
				streamSimple: (model: any, context: any, options: any) => {
					sessionIds.push(options.sessionId);
					return faux.streamSimple(model, context, options);
				},
			},
		} as any,
	});
	assert.equal(faux.state.callCount, 2);
	assert.equal(new Set(sessionIds).size, 1);
	assert.deepEqual(result.touchedPaths, ["written.md"]);
	await access(target);
});

test("child API failures remain explicit for cursor-owning callers", async () => {
	const faux = createFauxCore({ models: [{ id: "faux-1", reasoning: false }] });
	faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider unavailable" })]);
	const model = faux.getModel() as Model<any>;
	const result = await runChildAgent({
		role: "extractor",
		prompt: "extract",
		sourceMessages: [],
		systemPrompt: "system",
		config: structuredClone(DEFAULT_CONFIG),
		paths: {
			projectRoot: "/",
			projectKey: "test",
			baseDir: "/",
			memoryDir: "/",
			stateFile: "/state.json",
			locksDir: "/",
		},
		isCurrentGeneration: () => true,
		ctx: {
			cwd: "/",
			model,
			isProjectTrusted: () => true,
			modelRegistry: { streamSimple: faux.streamSimple },
		} as any,
	});
	assert.equal(result.turns, 1);
	assert.equal(result.stopReason, "error");
	assert.equal(result.error, "provider unavailable");
});

test("configured thinking level clamps to the closest level supported by the selected model", () => {
	const noReasoning = { reasoning: false } as Model<any>;
	assert.equal(effectiveThinkingLevel(noReasoning, "high"), "off");
	assert.equal(effectiveThinkingLevel(noReasoning, "inherit", "high"), "off");
	const reasoning = { reasoning: true } as Model<any>;
	assert.equal(effectiveThinkingLevel(reasoning, "inherit", "high"), "high");
	assert.equal(effectiveThinkingLevel(reasoning, "inherit", "off"), "off");
	assert.equal(effectiveThinkingLevel(reasoning, "inherit"), "off");
	assert.equal(effectiveThinkingLevel(reasoning, "low", "high"), "low");

	const sparse = {
		reasoning: true,
		thinkingLevelMap: { medium: null, high: null, xhigh: "xhigh", max: null },
	} as Model<any>;
	assert.equal(effectiveThinkingLevel(sparse, "medium"), "xhigh");
	assert.equal(effectiveThinkingLevel(sparse, "inherit", "medium"), "xhigh");
});
