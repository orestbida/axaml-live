import * as vscode from "vscode";
import { formatXaml, FormatOptions } from "../xaml/formatter";
import { findStyleMatches } from "../xaml/styleMatcher";

const axamlSelector: vscode.DocumentSelector = [{ language: "AXAML" }, { pattern: "**/*.axaml" }];

function formatOptions(document: vscode.TextDocument, options: vscode.FormattingOptions): FormatOptions {
	const f = vscode.workspace.getConfiguration("avalonia.formatting", document.uri);
	const e = vscode.workspace.getConfiguration("avalonia.editor", document.uri);
	return {
		indentSize: options.tabSize,
		useTabs: !options.insertSpaces,
		attributeWrapping: f.get<FormatOptions["attributeWrapping"]>("attributeWrapping", "alignWithFirst"),
		attributeWrapThreshold: f.get<number>("attributeWrapThreshold", 0),
		markupExtensionArgWrapThreshold: f.get<number>("markupExtensionArgWrapThreshold", 0),
		collapseBlankLines: f.get<boolean>("collapseBlankLines", true),
		quoteStyle: e.get<"double" | "single">("attributeQuoteStyle", "double"),
	};
}

/** Format Document for .axaml files (whole-document edit; nothing happens for malformed XAML). */
export function registerFormatter(): vscode.Disposable {
	return vscode.languages.registerDocumentFormattingEditProvider(axamlSelector, {
		provideDocumentFormattingEdits(document, options) {
			const text = document.getText();
			let formatted = formatXaml(text, formatOptions(document, options));
			if (formatted !== undefined && document.eol === vscode.EndOfLine.CRLF) {
				formatted = formatted.replace(/\r?\n/g, "\r\n");
			}
			if (formatted === undefined || formatted === text) {
				return [];
			}
			return [vscode.TextEdit.replace(new vscode.Range(document.positionAt(0), document.positionAt(text.length)), formatted)];
		},
	});
}

/**
 * 🎨 badges after elements matched by a Style declared in the same file; hover lists the selectors.
 * Setting: avalonia.showStyleAdornments.
 */
export class StyleBadges implements vscode.Disposable {
	private readonly _decoration = vscode.window.createTextEditorDecorationType({
		after: { contentText: " 🎨", margin: "0 0 0 2px" },
	});
	private readonly _disposables: vscode.Disposable[] = [];
	private _timer: NodeJS.Timeout | undefined;
	/** Badges currently shown in the active editor (for tests and diagnostics). */
	public count = 0;

	constructor() {
		this._disposables.push(
			this._decoration,
			vscode.window.onDidChangeActiveTextEditor(() => this.schedule(0)),
			vscode.workspace.onDidChangeTextDocument((e) => {
				if (e.document === vscode.window.activeTextEditor?.document) {
					this.schedule(300);
				}
			}),
			vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration("avalonia.showStyleAdornments") && this.schedule(0))
		);
		this.schedule(0);
	}

	private schedule(delay: number) {
		clearTimeout(this._timer);
		this._timer = setTimeout(() => this.update(), delay);
	}

	private update() {
		const editor = vscode.window.activeTextEditor;
		if (!editor || !(/\.axaml$/i.test(editor.document.fileName) || editor.document.languageId === "AXAML")) {
			this.count = 0;
			return;
		}
		if (!vscode.workspace.getConfiguration("avalonia", editor.document.uri).get<boolean>("showStyleAdornments", true)) {
			editor.setDecorations(this._decoration, []);
			this.count = 0;
			return;
		}
		const doc = editor.document;
		const matches = findStyleMatches(doc.getText());
		const decorations = matches.map((m) => {
			const pos = doc.positionAt(m.startTagEnd);
			const hover = new vscode.MarkdownString(
				"**Styles in this file that apply to this element**\n\n" + m.selectors.map((s) => `- \`${s.replace(/`/g, "")}\``).join("\n")
			);
			return { range: new vscode.Range(pos, pos), hoverMessage: hover };
		});
		editor.setDecorations(this._decoration, decorations);
		this.count = decorations.length;
	}

	public dispose() {
		clearTimeout(this._timer);
		this._disposables.forEach((d) => d.dispose());
	}
}

/** Rewrites `=""` in attribute completions to `=''` when avalonia.editor.attributeQuoteStyle is "single". */
export function applyQuoteStyle<T extends vscode.CompletionItem>(item: T, uri: vscode.Uri | undefined): T {
	if (vscode.workspace.getConfiguration("avalonia.editor", uri).get<string>("attributeQuoteStyle", "double") !== "single") {
		return item;
	}
	const fix = (s: string) => s.replace(/=""/g, "=''");
	if (typeof item.insertText === "string") {
		item.insertText = fix(item.insertText);
	} else if (item.insertText instanceof vscode.SnippetString) {
		item.insertText = new vscode.SnippetString(fix(item.insertText.value));
	}
	return item;
}
