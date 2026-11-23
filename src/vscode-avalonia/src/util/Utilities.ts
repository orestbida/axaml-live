import path = require("path");
import * as vscode from "vscode";

export const avaloniaFileExtension = "axaml";
export const avaloniaLanguageId = "axaml";
export const logger = vscode.window.createOutputChannel("Avalonia Client", { log: true });

/**
 * Checks if the given document is an Avalonia file.
 */
export function isAvaloniaFile(document: vscode.TextDocument): boolean {
	// .axaml, or a .xaml file of an Avalonia project (switched to the AXAML language)
	return document.uri.scheme === "file" && (path.extname(document.fileName).toLowerCase() === `.${avaloniaFileExtension}` || document.languageId === "AXAML");
}

export function getFileName(filePath: string): string {
	return path.basename(filePath);
}

export { samePath, isUnder } from "./paths";

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
