import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	Input,
	Key,
	type KeybindingsManager,
	matchesKey,
	ScrollView,
	type SelectItem,
	SelectList,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { sanitizeMemoryText } from "./sanitize.ts";
import type { MemoryRole, MemoryTopic } from "./types.ts";

export type MemoryPanelTab = "overview" | "topics" | "models";
export type MemoryPanelAction = "extract" | "dream" | "reload-config" | "refresh";

export interface MemoryModelView {
	role: MemoryRole;
	model: string;
	inherited: boolean;
	thinking: string;
	maxTokens: number | "inherit";
	outputMode?: string;
	activity: string;
	availabilityError?: string;
	lastError?: string;
	totalTokens: number;
	cost: number;
}

export interface MemoryPanelData {
	project: string;
	configFile: string;
	enabled: boolean;
	dreamEnabled: boolean;
	extracting: boolean;
	dreaming: boolean;
	recallCharacters: number;
	recallBudget: number;
	topics: MemoryTopic[];
	overview: string[];
	models: MemoryModelView[];
}

const TABS: MemoryPanelTab[] = ["overview", "topics", "models"];
const TAB_LABELS = ["Overview", "Topics", "Models"];
const ROLE_LABELS: Record<MemoryRole, string> = {
	selector: "Selector",
	extractor: "Extractor",
	dream: "Dream",
};

// File metadata and model errors are untrusted terminal text.
function safeText(value: string): string {
	return sanitizeMemoryText(value).replaceAll("\t", "    ");
}

function singleLine(value: string): string {
	return safeText(value).replace(/\s+/g, " ").trim();
}

export function filterMemoryTopics(topics: MemoryTopic[], query: string): MemoryTopic[] {
	const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
	return topics.filter((topic) => {
		const text = singleLine(`${topic.type} ${topic.filename} ${topic.description}`).toLowerCase();
		return words.every((word) => text.includes(word));
	});
}

/** A session-local screen. Browsing never injects memory into the model context. */
export class MemoryPanel {
	private tab: MemoryPanelTab;
	private readonly search = new Input({ prompt: "Search: ", placeholder: "type, filename, or description" });
	private list?: SelectList;
	private listItems: SelectItem[] = [];
	private listHeight = 0;
	private preview?: { topic: MemoryTopic; text: string };
	private reading = false;
	private request = 0;
	private disposed = false;
	private hasFocus = false;
	private readonly scroll: ScrollView;
	private scrollLines: string[] = [];
	private bodyHeight = 12;

	constructor(
		private readonly data: MemoryPanelData,
		private readonly theme: Theme,
		private readonly keys: KeybindingsManager,
		private readonly requestRender: () => void,
		private readonly terminalRows: () => number,
		private readonly done: (action: MemoryPanelAction | undefined) => void,
		private readonly readTopic: (topic: MemoryTopic) => Promise<string>,
		initialTab: MemoryPanelTab = "overview",
	) {
		this.tab = initialTab;
		this.scroll = new ScrollView(
			{
				render: (width) => this.scrollLines.flatMap((line) => wrapTextWithAnsi(line, width)),
				invalidate() {},
			},
			{ scrollbar: "hidden" },
		);
	}

	get focused(): boolean {
		return this.hasFocus;
	}

	set focused(value: boolean) {
		this.hasFocus = value;
		this.search.focused = value && this.tab === "topics" && !this.preview;
	}

	invalidate(): void {
		this.search.invalidate();
		this.list?.invalidate();
		this.scroll.invalidate();
	}

	dispose(): void {
		this.disposed = true;
		this.request++;
	}

	private actions(): SelectItem[] {
		return [
			{ value: "topics", label: "Browse memories", description: `${this.data.topics.length} topics, newest first` },
			...(this.data.enabled && !this.data.extracting
				? [{ value: "extract", label: "Extract", description: "Save durable facts from this conversation" }]
				: []),
			...(this.data.enabled && this.data.dreamEnabled && !this.data.dreaming
				? [{ value: "dream", label: "Dream", description: "Merge duplicates and review old memories" }]
				: []),
			{ value: "reload-config", label: "Reload configuration", description: "Apply changes from config.json" },
			{ value: "refresh", label: "Refresh panel", description: "Update status and files" },
		];
	}

	private renderList(items: SelectItem[], height: number, width: number): string[] {
		if (
			!this.list ||
			this.listHeight !== height ||
			items.length !== this.listItems.length ||
			items.some((item, i) => item.value !== this.listItems[i]?.value)
		) {
			const selected = this.list?.getSelectedItem()?.value;
			this.list = new SelectList(items, Math.max(1, height - 1), {
				selectedPrefix: (text) => this.theme.fg("accent", text),
				selectedText: (text) => this.theme.fg("accent", this.theme.bold(text)),
				description: (text) => this.theme.fg("muted", text),
				scrollInfo: (text) => this.theme.fg("dim", text),
				noMatch: (text) => this.theme.fg("muted", text),
			});
			this.list.setSelectedIndex(
				Math.max(
					0,
					items.findIndex((item) => item.value === selected),
				),
			);
			this.list.onSelect = (item) => {
				if (this.tab === "topics") {
					const topic = this.data.topics.find((topic) => topic.filename === item.value);
					if (topic) void this.openTopic(topic);
				} else if (item.value === "topics") this.changeTab("topics");
				else this.done(item.value as MemoryPanelAction);
			};
			this.listItems = items;
			this.listHeight = height;
		}
		return this.list.render(width);
	}

	private changeTab(tab: MemoryPanelTab): void {
		this.tab = tab;
		this.preview = undefined;
		this.request++;
		this.list = undefined;
		this.focused = this.hasFocus;
		this.scroll.scrollToStart();
	}

	private async openTopic(topic: MemoryTopic): Promise<void> {
		const request = ++this.request;
		this.preview = { topic, text: "Loading memory…" };
		this.reading = true;
		this.focused = this.hasFocus;
		this.scroll.scrollToStart();
		this.requestRender();
		try {
			const text = await this.readTopic(topic);
			if (!this.disposed && this.request === request) this.preview = { topic, text };
		} catch (error) {
			if (!this.disposed && this.request === request)
				this.preview = {
					topic,
					text: `Unable to preview this memory.\n\n${error instanceof Error ? error.message : String(error)}\n\nReturn to Topics and refresh the panel if the file changed.`,
				};
		} finally {
			if (!this.disposed && this.request === request) {
				this.reading = false;
				this.requestRender();
			}
		}
	}

	private renderScroll(lines: string[], width: number, height: number): string[] {
		this.scrollLines = lines;
		const content = this.scroll.render(width);
		const viewportHeight = Math.max(1, height - 2);
		this.scroll.updateLayout(content.length, viewportHeight, this.requestRender);
		const start = this.scroll.scrollTop;
		const visible = content.slice(start, start + viewportHeight);
		while (visible.length < viewportHeight) visible.push("");
		return [
			...visible,
			"",
			this.theme.fg(
				"dim",
				`Lines ${Math.min(start + 1, content.length)}–${Math.min(start + viewportHeight, content.length)} of ${content.length}`,
			),
		];
	}

	private modelDetails(width: number): string[] {
		const lines: string[] = [];
		const heading = (text: string) => this.theme.fg("accent", this.theme.bold(text));
		const field = (label: string, value: string, warning = false) => {
			const stacked = width < 44;
			const prefix = stacked ? "  " : `  ${this.theme.fg("muted", label.padEnd(12))}`;
			const indent = stacked ? 2 : 14;
			const content = wrapTextWithAnsi(singleLine(value), Math.max(1, width - indent));
			if (stacked) lines.push(this.theme.fg("muted", label));
			for (const [index, line] of content.entries())
				lines.push(`${index === 0 ? prefix : " ".repeat(indent)}${warning ? this.theme.fg("warning", line) : line}`);
		};
		for (const model of this.data.models) {
			const name = ROLE_LABELS[model.role];
			const availability = model.availabilityError
				? this.theme.fg("warning", "Unavailable")
				: this.theme.fg("success", "Available");
			lines.push(`${heading(name)}  ${availability}`);
			field("Model", model.model);
			field("Source", model.inherited ? "Current session" : "Configured for this role");
			field("Thinking", model.thinking);
			field(
				"Max output",
				model.maxTokens === "inherit" ? "Provider default" : `${model.maxTokens.toLocaleString("en-US")} tokens`,
			);
			if (model.outputMode) field("Output mode", model.outputMode);
			field("Activity", model.activity);
			if (model.availabilityError) field("Unavailable", model.availabilityError, true);
			if (model.lastError) field("Last error", model.lastError, true);
			lines.push("");
		}
		lines.push(heading("Usage this process"));
		let totalTokens = 0;
		let totalCost = 0;
		for (const model of this.data.models) {
			field(ROLE_LABELS[model.role], `${model.totalTokens.toLocaleString("en-US")} tokens / $${model.cost.toFixed(6)}`);
			totalTokens += model.totalTokens;
			totalCost += model.cost;
		}
		field("Total", `${totalTokens.toLocaleString("en-US")} tokens / $${totalCost.toFixed(6)}`);
		lines.push(this.theme.fg("dim", "Usage resets on restart."), "", heading("Configuration"));
		lines.push(...wrapTextWithAnsi(singleLine(this.data.configFile), width));
		lines.push("", this.theme.fg("muted", "Edit config.json, then reload configuration in Overview."));
		return lines;
	}

	render(width: number): string[] {
		const innerWidth = Math.max(1, width - 2);
		this.bodyHeight = Math.max(4, Math.min(24, this.terminalRows() - 9));
		const muted = (text: string) => this.theme.fg("muted", text);
		const enabled = this.data.enabled ? this.theme.fg("success", "Enabled") : this.theme.fg("warning", "Disabled");
		const header = [
			this.theme.fg("border", "─".repeat(innerWidth)),
			`${this.theme.fg("accent", this.theme.bold("Project memory"))}  ${enabled}`,
			muted(singleLine(this.data.project)),
			"",
			TABS.map((tab, i) =>
				tab === this.tab ? this.theme.fg("accent", this.theme.bold(`[${TAB_LABELS[i]}]`)) : muted(` ${TAB_LABELS[i]} `),
			).join("  "),
			"",
		];
		let body: string[];
		let hint: string;
		if (this.preview) {
			body = [
				this.theme.fg("accent", singleLine(this.preview.topic.filename)),
				...this.renderScroll(safeText(this.preview.text).split("\n"), innerWidth, this.bodyHeight - 1),
			];
			hint = `${this.reading ? "Loading… · " : ""}↑↓ scroll · PgUp/PgDn page · Esc back`;
		} else if (this.tab === "topics") {
			const topics = filterMemoryTopics(this.data.topics, this.search.getValue());
			body = [
				...this.search.render(innerWidth),
				muted(`${topics.length} of ${this.data.topics.length} topics · newest first`),
				...(topics.length
					? this.renderList(
							topics.map((topic) => ({
								value: topic.filename,
								label: singleLine(topic.filename),
								description: singleLine(`[${topic.type}] ${topic.description}`),
							})),
							this.bodyHeight - 2,
							innerWidth,
						)
					: [
							muted(
								this.data.topics.length
									? "No matches. Try another search."
									: "No memories yet. Ask the agent to remember a preference or decision.",
							),
						]),
			];
			hint = "Type to search · ↑↓ choose · Enter preview · Tab switch · Esc close";
		} else if (this.tab === "models") {
			body = this.renderScroll(this.modelDetails(innerWidth), innerWidth, this.bodyHeight);
			hint = "↑↓ scroll · PgUp/PgDn page · Tab switch · Esc close";
		} else {
			const summary = [
				`${this.data.topics.length} topics · Recall ${Math.round((this.data.recallCharacters / this.data.recallBudget) * 100)}% used`,
				...this.data.overview.map(singleLine),
			];
			const summaryHeight = Math.max(0, Math.min(summary.length, this.bodyHeight - 6));
			body = [
				...summary.slice(0, summaryHeight).map(muted),
				...(summaryHeight ? [""] : []),
				...this.renderList(this.actions(), this.bodyHeight - summaryHeight - (summaryHeight ? 1 : 0), innerWidth),
			];
			hint = "↑↓ choose · Enter run · Tab switch · Esc close";
		}
		const content = [...header, ...body.slice(0, this.bodyHeight)];
		while (content.length < header.length + this.bodyHeight) content.push("");
		content.push(this.theme.fg("dim", hint), this.theme.fg("border", "─".repeat(innerWidth)));
		return content.map((line) => truncateToWidth(` ${line}`, Math.max(1, width), "…"));
	}

	handleInput(data: string): void {
		if (this.keys.matches(data, "tui.select.cancel") || matchesKey(data, Key.ctrl("c"))) {
			if (this.preview) {
				this.preview = undefined;
				this.request++;
				this.focused = this.hasFocus;
			} else this.done(undefined);
		} else if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
			const offset = matchesKey(data, Key.tab) ? 1 : -1;
			this.changeTab(TABS[(TABS.indexOf(this.tab) + offset + TABS.length) % TABS.length] ?? "overview");
		} else if (this.preview || this.tab === "models") {
			if (this.keys.matches(data, "tui.select.up")) this.scroll.scrollBy(-1);
			else if (this.keys.matches(data, "tui.select.down")) this.scroll.scrollBy(1);
			else if (this.keys.matches(data, "tui.select.pageUp")) this.scroll.scrollBy(-this.bodyHeight + 1);
			else if (this.keys.matches(data, "tui.select.pageDown")) this.scroll.scrollBy(this.bodyHeight - 1);
			else if (matchesKey(data, Key.home)) this.scroll.scrollToStart();
			else if (matchesKey(data, Key.end)) this.scroll.scrollToEnd();
		} else if (
			this.tab === "overview" ||
			(
				["tui.select.up", "tui.select.down", "tui.select.pageUp", "tui.select.pageDown", "tui.select.confirm"] as const
			).some((action) => this.keys.matches(data, action))
		) {
			if (this.tab !== "topics" || filterMemoryTopics(this.data.topics, this.search.getValue()).length)
				this.list?.handleInput(data);
		} else {
			const before = this.search.getValue();
			this.search.handleInput(data);
			if (before !== this.search.getValue()) this.list = undefined;
		}
		this.requestRender();
	}
}

export async function openMemoryPanel(
	ctx: ExtensionContext,
	data: MemoryPanelData,
	readTopic: (topic: MemoryTopic) => Promise<string>,
	tab: MemoryPanelTab = "overview",
): Promise<MemoryPanelAction | undefined> {
	return ctx.ui.custom<MemoryPanelAction | undefined>(
		(tui, theme, keys, done) =>
			new MemoryPanel(
				data,
				theme,
				keys,
				() => tui.requestRender(),
				() => tui.terminal.rows,
				done,
				readTopic,
				tab,
			),
	);
}
