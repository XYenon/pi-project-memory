import assert from "node:assert/strict";
import test from "node:test";
import { Theme } from "@earendil-works/pi-coding-agent";
import {
	CURSOR_MARKER,
	KeybindingsManager,
	stripTerminalSequences,
	TUI_KEYBINDINGS,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { MemoryTopic } from "../src/types.ts";
import { filterMemoryTopics, MemoryPanel, type MemoryPanelAction, type MemoryPanelData } from "../src/ui.ts";

function topic(filename: string, type: MemoryTopic["type"], description: string): MemoryTopic {
	return { filename, type, description, filePath: `/memory/${filename}`, mtimeMs: 1, modifiedMs: 1, sizeBytes: 100 };
}

function panelHarness(
	options: { topics?: MemoryTopic[]; enabled?: boolean; read?: (topic: MemoryTopic) => Promise<string> } = {},
) {
	const colors = Object.fromEntries(
		["accent", "border", "success", "warning", "muted", "dim", "text", "thinkingXhigh", "selectedBg"].map((color) => [
			color,
			"#aaaaaa",
		]),
	) as ConstructorParameters<typeof Theme>[0];
	const data: MemoryPanelData = {
		project: "/projects/记忆扩展",
		configFile: "/config.json",
		enabled: options.enabled ?? true,
		dreamEnabled: true,
		extracting: false,
		dreaming: false,
		recallCharacters: 100,
		recallBudget: 1000,
		topics: options.topics ?? [
			topic("workflow.md", "feedback", "Chinese 中文排版 preferences"),
			topic("api.md", "reference", "API reference"),
		],
		overview: ["Selector: automatic", "Extractor: automatic", "Dream: automatic", "Memory: /memory"],
		models: (["selector", "extractor", "dream"] as const).map((role) => ({
			role,
			model: `provider/${role}-model`,
			inherited: role !== "dream",
			thinking: "off (from session)",
			maxTokens: role === "selector" ? 1024 : "inherit",
			outputMode: role === "selector" ? "Auto (native JSON Schema / schema tool)" : undefined,
			activity: "Idle / automatic",
			totalTokens: 1200,
			cost: 0.012,
		})),
	};
	let rows = 32;
	const actions: Array<MemoryPanelAction | undefined> = [];
	let renders = 0;
	const panel = new MemoryPanel(
		data,
		new Theme(colors, {} as ConstructorParameters<typeof Theme>[1], "truecolor"),
		new KeybindingsManager(TUI_KEYBINDINGS),
		() => renders++,
		() => rows,
		(action) => actions.push(action),
		options.read ?? (async () => Array.from({ length: 100 }, (_, i) => `Memory line ${i}`).join("\n")),
	);
	panel.focused = true;
	const render = (width = 100) => panel.render(width).map(stripTerminalSequences).join("\n");
	return {
		panel,
		data,
		actions,
		render,
		setRows: (value: number) => {
			rows = value;
		},
		renders: () => renders,
	};
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("topic search matches all query words across type, path and description, including Chinese", () => {
	const topics = [topic("nested/style.md", "feedback", "中文排版规则"), topic("api.md", "reference", "API guide")];
	assert.deepEqual(filterMemoryTopics(topics, " FEEDBACK 排版 nested "), [topics[0]]);
	assert.deepEqual(filterMemoryTopics(topics, "api reference"), [topics[1]]);
	assert.deepEqual(filterMemoryTopics(topics, "absent"), []);
	assert.deepEqual(filterMemoryTopics(topics, "  "), topics);
});

test("keyboard browsing preserves the search and selection after preview and scrolls content", async () => {
	const h = panelHarness();
	assert.match(h.render(), /\[Overview\]/);
	assert.match(h.render(), /Extract\s+Save durable facts/);
	assert.match(h.render(), /Dream\s+Merge duplicates/);
	assert.doesNotMatch(h.render(), /Consolidat/);
	h.panel.handleInput("\t");
	assert.match(h.render(), /\[Topics\]/);
	h.panel.handleInput("中文");
	assert.match(h.render(), /1 of 2 topics/);
	assert.match(h.render(), /workflow.md/);
	assert.ok(
		h.panel.render(100).some((line) => line.includes(CURSOR_MARKER)),
		"search owns the IME cursor",
	);
	h.panel.handleInput("\r");
	await tick();
	assert.match(h.render(), /Memory line 0/);
	assert.doesNotMatch(h.render(), /Memory line 99/);
	h.panel.handleInput("\u001b[F");
	assert.match(h.render(), /Memory line 99/);
	assert.doesNotMatch(h.render(), /Memory line 0\n/);
	h.panel.handleInput("\u001b[H");
	assert.match(h.render(), /Memory line 0/);
	h.panel.handleInput("\u001b");
	assert.match(h.render(), /Search: 中文/);
	assert.match(h.render(), /1 of 2 topics/);
	h.panel.handleInput("\u001b");
	assert.deepEqual(h.actions, [undefined]);
});

test("no matches cannot open an old selection and empty projects explain how to add memory", () => {
	let reads = 0;
	const h = panelHarness({
		read: async () => {
			reads++;
			return "memory";
		},
	});
	h.render();
	h.panel.handleInput("\t");
	h.render();
	h.panel.handleInput("missing");
	h.panel.handleInput("\r");
	assert.equal(reads, 0);
	assert.match(h.render(), /No matches/);
	const empty = panelHarness({ topics: [] });
	empty.panel.handleInput("\t");
	assert.match(empty.render(), /No memories yet/);
});

test("late previews cannot replace another tab or redraw a disposed panel", async () => {
	let resolve!: (text: string) => void;
	const h = panelHarness({
		read: () =>
			new Promise<string>((done) => {
				resolve = done;
			}),
	});
	h.panel.handleInput("\t");
	h.render();
	h.panel.handleInput("\r");
	assert.match(h.render(), /Loading memory/);
	h.panel.handleInput("\t");
	resolve("late memory result");
	await tick();
	assert.match(h.render(), /\[Models\]/);
	assert.doesNotMatch(h.render(), /late memory result/);
	h.panel.handleInput("\u001b[Z");
	h.render();
	h.panel.handleInput("\r");
	h.panel.dispose();
	const renders = h.renders();
	resolve("disposed result");
	await tick();
	assert.equal(h.renders(), renders);
});

test("preview read errors are visible and escape returns to browsing", async () => {
	const h = panelHarness({
		read: async () => {
			throw new Error("file changed");
		},
	});
	h.panel.handleInput("\t");
	h.render();
	h.panel.handleInput("\r");
	await tick();
	assert.match(h.render(), /Unable to preview/);
	assert.match(h.render(), /file changed/);
	h.panel.handleInput("\u001b");
	assert.match(h.render(), /2 of 2 topics/);
});

test("disabled or running tasks have no runnable action, while reload remains available", () => {
	const disabled = panelHarness({ enabled: false });
	assert.match(disabled.render(), /Disabled/);
	assert.doesNotMatch(disabled.render(), /Extract\s+Save durable facts|Dream\s+Merge duplicates/);
	disabled.panel.handleInput("\u001b[B");
	disabled.panel.handleInput("\r");
	assert.deepEqual(disabled.actions, ["reload-config"]);
	const active = panelHarness();
	active.data.extracting = true;
	active.data.dreaming = true;
	assert.doesNotMatch(active.render(), /Extract\s+Save durable facts|Dream\s+Merge duplicates/);
});

test("all tabs and long previews fit terminal widths and heights after resizing", async () => {
	const h = panelHarness({ read: async () => "很长的中文内容 👩‍💻 ".repeat(300) });
	for (const rows of [14, 24, 50]) {
		h.setRows(rows);
		for (let tab = 0; tab < 3; tab++) {
			for (const width of [1, 20, 44, 80, 160]) {
				const lines = h.panel.render(width);
				assert.ok(lines.length <= rows, `height ${lines.length} exceeds ${rows}`);
				for (const line of lines) assert.ok(visibleWidth(line) <= width, `line exceeds ${width} columns`);
			}
			h.panel.handleInput("\t");
		}
	}
	h.panel.handleInput("\t");
	h.render();
	h.panel.handleInput("\r");
	await tick();
	for (const width of [20, 44, 80]) {
		for (const line of h.panel.render(width)) assert.ok(visibleWidth(line) <= width);
	}
});

test("model diagnostics scroll and terminal control codes in file metadata are removed", () => {
	const h = panelHarness({
		topics: [topic("unsafe\u001b[31m.md", "feedback", "bad\r\nmetadata\u001b]52;c;injected\u0007")],
	});
	h.panel.handleInput("\t");
	const topics = h.render();
	assert.equal(topics.includes("\u001b"), false);
	assert.equal(topics.includes("\u0007"), false);
	assert.match(topics, /bad metadata/);
	h.panel.handleInput("\t");
	assert.match(h.render(), /Selector\s+Available/);
	h.panel.handleInput("\u001b[6~");
	assert.doesNotMatch(h.render(), /Selector\s+Available/);
	h.panel.handleInput("\u001b[F");
	assert.match(h.render(), /Usage resets on restart/);
});

test("Models groups role settings and usage without repeating the project status report", () => {
	const h = panelHarness();
	h.panel.handleInput("\t");
	h.panel.handleInput("\t");
	let content = h.render();
	assert.match(content, /Model\s+provider\/selector-model/);
	assert.match(content, /Source\s+Current session/);
	assert.match(content, /Thinking\s+off \(from session\)/);
	assert.match(content, /Max output\s+1,024 tokens/);
	assert.match(content, /Max output\s+Provider default/);
	for (let page = 0; page < 4; page++) {
		h.panel.handleInput("\u001b[6~");
		content += h.render();
	}
	assert.match(content, /Source\s+Configured for this role/);
	assert.match(content, /Usage this process/);
	assert.match(content, /Total\s+3,600 tokens \/ \$0.036000/);
	assert.doesNotMatch(content, /Extraction pass:|Auto-memory:|Topics:|Recall:/);
});

test("Models wraps long values under their field and labels availability errors separately", () => {
	const h = panelHarness();
	const model = h.data.models[0]!;
	model.model = `provider/${"long-model-".repeat(16)}`;
	model.availabilityError = "No credentials configured for this provider";
	model.lastError = "Request failed: rate limit exceeded";
	h.panel.handleInput("\t");
	h.panel.handleInput("\t");
	const wide = h.render(80);
	assert.match(wide, /Selector\s+Unavailable/);
	assert.match(wide, /\n {15}long/);
	assert.match(wide, /Unavailable\s+No credentials/);
	assert.match(wide, /Last error\s+Request failed/);
	const narrow = h.render(40);
	assert.match(narrow, /\n Model\n {3}provider\//);
	for (const line of h.panel.render(40)) assert.ok(visibleWidth(line) <= 40);
});
