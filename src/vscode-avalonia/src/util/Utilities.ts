import path = require("path");
import * as vscode from "vscode";

export const avaloniaFileExtension = "axaml";
export const avaloniaLanguageId = "axaml";
export const logger = vscode.window.createOutputChannel("Avalonia Client", { log: true });

const isWindows = process.platform === "win32";

/**
 * Checks if the given document is an Avalonia file.
 */
export function isAvaloniaFile(document: vscode.TextDocument): boolean {
	return document.uri.scheme === "file" && path.extname(document.fileName).toLowerCase() === `.${avaloniaFileExtension}`;
}

export function getFileName(filePath: string): string {
	return path.basename(filePath);
}

function normalize(p: string): string {
	const n = path.normalize(p).replace(/[\\/]+$/, "");
	return isWindows ? n.toLowerCase() : n;
}

/** Path equality that ignores drive letter / case differences on Windows. */
export function samePath(a: string | undefined, b: string | undefined): boolean {
	if (!a || !b) {
		return false;
	}
	return normalize(a) === normalize(b);
}

/** True when `child` is located inside `parent` folder. */
export function isUnder(child: string, parent: string): boolean {
	const c = normalize(child);
	const p = normalize(parent);
	return c.startsWith(p + path.sep);
}

/**
 * Various app constants
 */
export class AppConstants {
	static readonly insertPropertyCommandId = "avalonia.InsertProperty";
	static readonly localhost = "127.0.0.1";

	static readonly showPreviewToSideCommand = "avalonia.showPreviewToSide";
	static readonly previewerAssetsCommand = "avalonia.createPreviewerAssets";
	static readonly restartPreviewerCommand = "avalonia.restartPreviewer";
	static readonly selectSolutionCommand = "avalonia.selectSolution";
	static readonly newProjectCommandId = "avalonia.newProject";
	static readonly newItemCommandId = "avalonia.newItem";

	static readonly previewerPanelViewType = "avaloniaPreviewer";

	static readonly solutionData = "avalonia.solutionData";
	static readonly selectedSolution = "avalonia.selectedSolution";
	static readonly previewerHost = "avalonia.previewerHost";
	static readonly selectHostCommand = "avalonia.selectPreviewerHost";

	static readonly extensionId = "AvaloniaCommunity.vscode-avalonia-community";
}
