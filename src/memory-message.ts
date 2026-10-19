import type { MessageRenderer } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { sanitizeMemoryText } from "./sanitize.ts";

export interface MemoryUpdateView {
	source: "extract" | "dream" | "external";
	summary: string;
	paths: string[];
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
	if (update.source === "external") return `${count(update.paths.length, "file")} changed externally`;
	const topics = update.paths.filter((path) => path !== "MEMORY.md").length;
	if (topics === 0) return "Updated index";
	return `${update.source === "dream" ? "Organized" : "Saved"} ${count(topics, "topic")}`;
}

/** Only the presentation changes; the original content remains in the model context. */
export const renderMemoryMessage: MessageRenderer<MemoryMessageDetails> = (message, { expanded, outputPad }, theme) => {
	const details = message.details;
	const labels: string[] = [];
	if (message.customType === "pi-project-memory-recall") {
		const files = details?.files ?? [];
		labels.push(files.length ? `Recalled ${count(files.length, "topic")}` : "Recalled memories");
	}
	for (const update of details?.updates ?? []) labels.push(updateLabel(update));
	if (labels.length === 0) {
		if (details?.updatedPaths?.length) labels.push(`Updated ${count(details.updatedPaths.length, "file")}`);
		else labels.push("Loaded copies are outdated");
	}
	const summary = theme.fg("muted", `Memory · ${labels.join(" · ")}`);
	if (!expanded) return new Text(summary, outputPad, 0);

	const content =
		typeof message.content === "string"
			? message.content
			: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
	// Omit model-facing wrappers and bookkeeping instructions from the visible text.
	const body = sanitizeMemoryText(
		content
			.replace(/<\/?system-reminder\b[^>]*>/g, "")
			.replace(/^This is machine-generated bookkeeping\. Do not quote it to the user\.\n?/gm, ""),
	).trim();
	return new Text(`${summary}${body ? `\n\n${body}` : ""}`, outputPad, 0);
};
