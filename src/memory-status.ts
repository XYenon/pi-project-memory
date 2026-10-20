import { CustomEditor, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Loader, sliceByColumn, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type UI = ExtensionContext["ui"];
type EditorFactory = NonNullable<ReturnType<UI["getEditorComponent"]>>;

const RIGHT_BORDER = "──";
// Columns reserved around the status: a space before it, a space after it, and the right border.
const STATUS_CHROME_WIDTH = 2 + RIGHT_BORDER.length;

/** Adds a background-task indicator without changing the editor's height or input handling. */
export class MemoryStatus {
	private loader?: Loader;
	private message?: string;
	private readonly previous: EditorFactory | undefined;
	private readonly factory: EditorFactory;
	private disposed = false;

	constructor(private readonly ui: UI) {
		this.previous = ui.getEditorComponent();
		this.factory = (tui, theme, keys) => {
			this.stopLoader();
			const editor =
				this.previous?.(tui, theme, keys) ?? new CustomEditor(tui, theme, keys, { embedWorkingStatus: true });
			// CustomEditor and Editor subclasses share this border hook. Preserve an
			// unrelated editor implementation rather than replacing its renderer.
			const bordered = editor as typeof editor & { renderBottomBorder?: (width: number, hidden: number) => string };
			const renderBorder = bordered.renderBottomBorder?.bind(editor);
			if (!renderBorder) return editor;
			const updateLoader = () => {
				if (!this.message || this.disposed) this.stopLoader();
				else if (this.loader) this.loader.setMessage(this.message);
				else {
					this.loader = new Loader(
						tui,
						(text) => editor.borderColor?.(text) ?? text,
						(text) => editor.borderColor?.(text) ?? text,
						this.message,
					);
				}
				tui.requestRender();
			};
			this.updateLoader = updateLoader;
			bordered.renderBottomBorder = (width, hidden) => {
				const original = renderBorder(width, hidden);
				if (!this.loader || width < 6) return original;
				// Leave a centered scroll indicator intact; use only its right-hand tail.
				const scrollLabel = hidden > 0 ? ` ↓ ${hidden} more ` : "";
				const labelWidth = visibleWidth(scrollLabel);
				const start = hidden > 0 ? Math.floor((width - labelWidth) / 2) + labelWidth + 1 : 1;
				const available = width - start - STATUS_CHROME_WIDTH;
				if (available < 1 || (hidden > 0 && labelWidth + 2 > width)) return original;
				const line = this.loader.render(available + 2)[1] ?? "";
				const status = truncateToWidth(line.startsWith(" ") ? line.slice(1).trimEnd() : line.trimEnd(), available, "");
				const statusWidth = visibleWidth(status);
				const prefix = sliceByColumn(original, 0, width - statusWidth - STATUS_CHROME_WIDTH, true);
				const border = editor.borderColor?.(RIGHT_BORDER) ?? RIGHT_BORDER;
				return `${prefix} ${status} ${border}`;
			};
			updateLoader();
			return editor;
		};
		ui.setEditorComponent(this.factory);
	}

	private updateLoader: () => void = () => {};

	private stopLoader(): void {
		this.loader?.stop();
		this.loader = undefined;
	}

	setMessage(message: string | undefined): void {
		if (this.disposed || this.message === message) return;
		this.message = message;
		this.updateLoader();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.stopLoader();
		if (this.ui.getEditorComponent() === this.factory) this.ui.setEditorComponent(this.previous);
	}
}
