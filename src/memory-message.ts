import type { MessageRenderer } from "@earendil-works/pi-coding-agent";
import { MouseRegion, Text } from "@earendil-works/pi-tui";
import { sanitizeMemoryText } from "./sanitize.ts";

export interface MemoryUpdateView {
	source: "extract" | "dream" | "external";
	summary: string;
	paths: string[];
	displayed?: boolean;
}

export interface MemoryMessageDetails {
	files?: string[];
	updates?: MemoryUpdateView[];
	updatedPaths?: string[];
	stalePaths?: string[];
}

function count(value: number, noun: string): string {
	return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

function updateLabel(update: MemoryUpdateView): string {
	const topics = update.paths.filter((path) => path !== "MEMORY.md").length;
	if (topics === 0) return "Updated index";
	const action = update.source === "dream" ? "Organized" : update.source === "extract" ? "Saved" : "Updated";
	return `${action} ${count(topics, "topic")}`;
}

/** Only the presentation changes; the original content remains in the model context. */
export const renderMemoryMessage: MessageRenderer<MemoryMessageDetails> = (message, { expanded, outputPad }, theme) => {
	const details = message.details;
	const updates = (details?.updates ?? []).filter((update) => !update.displayed);
	const labels: string[] = [];
	if (message.customType === "pi-project-memory-recall") {
		const files = details?.files ?? [];
		labels.push(files.length ? `Recalled ${count(files.length, "topic")}` : "Recalled memories");
	}
	for (const update of updates) labels.push(updateLabel(update));
	if (labels.length === 0) {
		if (details?.updatedPaths?.length)
			labels.push(updateLabel({ source: "external", summary: "", paths: details.updatedPaths }));
		else labels.push("Loaded memories are outdated");
	}

	const lines: string[] = [];
	const sources = { extract: "Saved", dream: "Organized", external: "Changed externally" };
	for (const update of updates) {
		lines.push(`${sources[update.source]}:`, ...update.paths.map((path) => `  ${path}`));
	}
	if (!updates.length && details?.updatedPaths?.length && !details.updates?.length)
		lines.push("Updated:", ...details.updatedPaths.map((path) => `  ${path}`));
	if (details?.stalePaths?.length)
		lines.push(`Loaded memories have changed. Read them again when needed: ${details.stalePaths.join(", ")}`);

	const content =
		typeof message.content === "string"
			? message.content
			: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
	// Structured updates replace model-facing bookkeeping. Keep recalled memory text intact.
	const body = content
		.replace(/<system-reminder\b[^>]*source="project-memory-update"[^>]*>[\s\S]*?<\/system-reminder>/g, "")
		.replace(/<\/?system-reminder\b[^>]*>/g, "")
		.replace(/^This is machine-generated bookkeeping\. Do not quote it to the user\.\n?/gm, "")
		.trim();
	if (body && (message.customType === "pi-project-memory-recall" || !details)) lines.push(body);
	const detail = sanitizeMemoryText(lines.join("\n")).trim();
	// Pi rebuilds renderers for keyboard expansion and theme changes. Keep a local
	// click override across rebuilds without changing persisted message details.
	let open = expansion.get(message)?.expanded === expanded ? (expansion.get(message)?.open ?? expanded) : expanded;
	expansion.set(message, { expanded, open });
	const text = new Text("", outputPad, 0);
	const refresh = () => {
		const summary = theme.fg("muted", `${open ? "▾" : "▸"} Memory · ${labels.join(" · ")}`);
		text.setText(`${summary}${open && detail ? `\n\n${detail}` : ""}`);
	};
	refresh();
	return new MouseRegion(text, (event) => {
		if (event.type !== "click" || event.button !== "left" || event.y !== 0) return undefined;
		open = !open;
		expansion.set(message, { expanded, open });
		refresh();
		return { handled: true, render: true };
	});
};

const expansion = new WeakMap<object, { expanded: boolean; open: boolean }>();
