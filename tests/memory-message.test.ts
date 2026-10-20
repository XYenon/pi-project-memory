import assert from "node:assert/strict";
import test from "node:test";
import { convertToLlm, type Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui";
import { type MemoryMessageDetails, renderMemoryMessage } from "../src/memory-message.ts";

const theme = { fg: (_color: string, text: string) => text } as Theme;

function message(customType: string, content: string, details?: MemoryMessageDetails) {
	return { role: "custom" as const, customType, content, details, display: true, timestamp: 1 };
}

function render(entry: ReturnType<typeof message>, expanded = false, width = 100): string {
	const component = renderMemoryMessage(entry, { expanded, outputPad: 1 }, theme);
	assert.ok(component);
	const lines = component.render(width);
	for (const line of lines) assert.ok(visibleWidth(line) <= width);
	return lines.map(stripTerminalSequences).join("\n");
}

test("recall messages show a compact summary and expand the exact recalled content", () => {
	const entry = message(
		"pi-project-memory-recall",
		"<system-reminder>\nMemory: /memory/style.md:\n\n---\nmetadata:\n  type: feedback\n---\n中文排版规则\n</system-reminder>",
		{ files: ["style.md"] },
	);
	const original = structuredClone(entry);
	assert.match(render(entry), /Memory · Recalled 1 topic/);
	assert.doesNotMatch(render(entry), /中文排版规则|style.md|system-reminder/);
	const expanded = render(entry, true);
	assert.match(expanded, /style.md/);
	assert.match(expanded, /中文排版规则/);
	assert.doesNotMatch(expanded, /system-reminder/);
	assert.deepEqual(entry, original, "rendering must not change the model-facing message");
	assert.deepEqual(convertToLlm([entry]), convertToLlm([{ ...entry, display: false }]));
	for (const width of [12, 30, 80]) render(entry, true, width);
});

test("update messages summarize extraction, dream, external changes and index-only edits", () => {
	const cases = [
		{ source: "extract" as const, paths: ["a.md", "MEMORY.md"], label: "Saved 1 topic" },
		{ source: "dream" as const, paths: ["a.md", "b.md"], label: "Organized 2 topics" },
		{ source: "external" as const, paths: ["a.md"], label: "Updated 1 topic" },
		{ source: "extract" as const, paths: ["MEMORY.md"], label: "Updated index" },
	];
	for (const { source, paths, label } of cases) {
		const entry = message("pi-project-memory-update", "Files changed: a.md", {
			updates: [{ source, paths, summary: "model-facing summary" }],
		});
		assert.ok(render(entry).includes(label));
		assert.doesNotMatch(render(entry), /model-facing summary|Files changed/);
		assert.match(render(entry, true), /a.md|MEMORY.md/);
	}
});

test("combined recall and update messages show both operations and hide bookkeeping wrappers", () => {
	const entry = message(
		"pi-project-memory-recall",
		'<system-reminder source="project-memory-update">\nFiles changed: a.md\nThis is machine-generated bookkeeping. Do not quote it to the user.\n</system-reminder>\n<system-reminder>\nMemory: a.md\nremember this\n</system-reminder>',
		{ files: ["a.md", "b.md"], updates: [{ source: "extract", paths: ["a.md"], summary: "saved" }] },
	);
	assert.match(render(entry), /Recalled 2 topics · Saved 1 topic/);
	assert.match(render(entry, true), /remember this/);
	assert.doesNotMatch(render(entry, true), /system-reminder|machine-generated|Do not quote/);
});

test("stale-only and older messages render without new metadata", () => {
	const stale = message("pi-project-memory-update", "Your loaded copy of a.md is now stale relative to disk.", {
		stalePaths: ["a.md"],
	});
	assert.match(render(stale), /Loaded memories are outdated/);
	assert.match(render(stale, true), /a.md/);
	const old = message("pi-project-memory-update", "Files changed: old.md", { updatedPaths: ["old.md"] });
	assert.match(render(old), /Updated 1 topic/);
	assert.match(render(old, true), /old.md/);
});

function click(overrides: Partial<TuiMouseEvent> = {}): TuiMouseEvent {
	return {
		type: "click",
		button: "left",
		x: 2,
		y: 0,
		screenX: 2,
		screenY: 0,
		width: 100,
		height: 1,
		shift: false,
		alt: false,
		ctrl: false,
		...overrides,
	};
}

test("clicking the summary toggles details, survives rebuilds, and respects keyboard expansion", () => {
	const entry = message("pi-project-memory-recall", "remember this", { files: ["a.md"] });
	const component = () => renderMemoryMessage(entry, { expanded: false, outputPad: 1 }, theme)!;
	const first = component();
	assert.doesNotMatch(first.render(100).join("\n"), /remember this/);
	assert.equal(first.handleMouse?.(click({ type: "wheel", wheelDelta: 1 })), undefined);
	assert.equal(first.handleMouse?.(click({ button: "right" })), undefined);
	assert.deepEqual(first.handleMouse?.(click()), { handled: true, render: true });
	assert.match(first.render(100).join("\n"), /remember this/);
	const rebuilt = component();
	assert.match(rebuilt.render(100).join("\n"), /remember this/);
	assert.equal(rebuilt.handleMouse?.(click({ y: 2 })), undefined, "body stays available for selection");
	rebuilt.handleMouse?.(click());
	assert.doesNotMatch(rebuilt.render(100).join("\n"), /remember this/);
	assert.match(render(entry, true), /remember this/);
	assert.doesNotMatch(render(entry, false), /remember this/);
});

test("structured details show files and sources without model bookkeeping", () => {
	const entry = message(
		"pi-project-memory-update",
		'<system-reminder source="project-memory-update">Background memory extraction updated your memory directory\nThis is machine-generated bookkeeping. Do not quote it to the user.\n</system-reminder>',
		{ updates: [{ source: "external", summary: "internal", paths: ["a.md", "MEMORY.md"] }], stalePaths: ["a.md"] },
	);
	assert.match(render(entry), /Updated 1 topic/);
	assert.match(render(entry, true), /Changed externally:\s+a\.md\s+MEMORY\.md/);
	assert.match(render(entry, true), /Read them again/);
	assert.doesNotMatch(render(entry, true), /system-reminder|machine-generated|Background memory|internal/);
});

test("already displayed updates do not repeat their summary alongside recalls", () => {
	const entry = message("pi-project-memory-recall", "recalled fact", {
		files: ["a.md"],
		updates: [{ source: "extract", summary: "saved", paths: ["a.md"], displayed: true }],
	});
	assert.match(render(entry), /Recalled 1 topic/);
	assert.doesNotMatch(render(entry), /Saved/);
});
