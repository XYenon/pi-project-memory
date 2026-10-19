import assert from "node:assert/strict";
import test from "node:test";
import {
	CustomEditor,
	type ExtensionContext,
	type KeybindingsManager as ExtensionKeys,
} from "@earendil-works/pi-coding-agent";
import {
	type EditorComponent,
	KeybindingsManager,
	stripTerminalSequences,
	type TUI,
	TUI_KEYBINDINGS,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { MemoryStatus } from "../src/memory-status.ts";

type Factory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;

function harness(previous?: Factory) {
	let factory = previous;
	let editor: EditorComponent;
	let renders = 0;
	const tui = { terminal: { rows: 32 }, requestRender: () => renders++ } as unknown as TUI;
	const theme = {
		borderColor: (text: string) => `\u001b[36m${text}\u001b[0m`,
		selectList: {
			selectedPrefix: (text: string) => text,
			selectedText: (text: string) => text,
			description: (text: string) => text,
			scrollInfo: (text: string) => text,
			noMatch: (text: string) => text,
		},
	};
	const keys = new KeybindingsManager(TUI_KEYBINDINGS) as ExtensionKeys;
	const ui = {
		getEditorComponent: () => factory,
		setEditorComponent: (next: Factory | undefined) => {
			factory = next;
			editor = next?.(tui, theme, keys) ?? new CustomEditor(tui, theme, keys, { embedWorkingStatus: true });
		},
	} as ExtensionContext["ui"];
	const status = new MemoryStatus(ui);
	return {
		status,
		ui,
		editor: () => editor,
		renders: () => renders,
		border: (width = 80, hidden = 0) =>
			(editor as CustomEditor & { renderBottomBorder(width: number, hidden: number): string }).renderBottomBorder(
				width,
				hidden,
			),
	};
}

test("memory activity animates in the bottom border without adding rows or changing the working indicator", (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const h = harness();
	t.after(() => h.status.dispose());
	const editor = h.editor() as CustomEditor;
	editor.setText("keep this input 中文");
	const idle = editor.render(80);
	h.status.setMessage("Memory: Extracting");
	const active = editor.render(80);
	assert.equal(active.length, idle.length);
	assert.equal(active[0], idle[0]);
	assert.match(stripTerminalSequences(h.border()), /⠋ Memory: Extracting ─$/);
	assert.equal(visibleWidth(h.border()), 80);
	assert.equal(editor.getText(), "keep this input 中文");

	const before = h.renders();
	t.mock.timers.tick(80);
	assert.ok(h.renders() > before);
	assert.match(stripTerminalSequences(h.border()), /⠙ Memory: Extracting/);
	h.status.setMessage("Memory: Extracting · Dreaming");
	assert.match(stripTerminalSequences(h.border()), /Extracting · Dreaming/);

	h.status.setMessage(undefined);
	assert.equal(h.border(), idle.at(-1));
	const stopped = h.renders();
	t.mock.timers.tick(800);
	assert.equal(h.renders(), stopped, "idle indicators must not retain an animation timer");
});

test("narrow borders fit terminal columns and preserve the input scroll indicator", (t) => {
	const h = harness();
	t.after(() => h.status.dispose());
	h.status.setMessage("Memory: Extracting · Dreaming");
	for (let width = 0; width <= 100; width++) {
		for (const hidden of [0, 1, 99, 1000]) {
			const border = h.border(width, hidden);
			assert.equal(visibleWidth(border), width, `width ${width}, hidden ${hidden}`);
			if (hidden > 0 && width >= visibleWidth(` ↓ ${hidden} more `) + 2)
				assert.ok(stripTerminalSequences(border).includes(`↓ ${hidden} more`));
		}
	}
});

test("existing editor factories and keyboard handling survive installation and cleanup", (t) => {
	let created: CustomEditor | undefined;
	const previous: Factory = (tui, theme, keys) => {
		created = new CustomEditor(tui, theme, keys, { embedWorkingStatus: true });
		return created;
	};
	const h = harness(previous);
	t.after(() => h.status.dispose());
	assert.equal(h.editor(), created);
	h.editor().handleInput("hello");
	h.status.setMessage("Memory: Dreaming");
	assert.equal(h.editor().getText(), "hello");
	assert.match(stripTerminalSequences(h.border()), /Memory: Dreaming/);
	h.status.dispose();
	assert.equal(h.ui.getEditorComponent(), previous);
	h.status.dispose();
});

test("cleanup stops animation without replacing an editor installed later", (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const h = harness();
	h.status.setMessage("Memory: Dreaming");
	const next: Factory = (tui, theme, keys) => new CustomEditor(tui, theme, keys);
	h.ui.setEditorComponent(next);
	h.status.dispose();
	assert.equal(h.ui.getEditorComponent(), next);
	const stopped = h.renders();
	t.mock.timers.tick(800);
	assert.equal(h.renders(), stopped);
});
