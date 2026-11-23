import path = require("path");
import * as vscode from "vscode";

export const avaloniaFileExtension = "axaml";
export const avaloniaLanguageId = "AXAML";
export const logger = vscode.window.createOutputChannel("AXAML Live", { log: true });

/**
 * Checks if the given document is an Avalonia file.
 */
export function isAvaloniaFile(document: vscode.TextDocument): boolean {
    // .axaml, or a .xaml file of an Avalonia project (switched to the AXAML language)
    return (
        document.uri.scheme === "file" &&
        (path.extname(document.fileName).toLowerCase() === `.${avaloniaFileExtension}` || document.languageId === "AXAML")
    );
}

export function getFileName(filePath: string): string {
    return path.basename(filePath);
}

export { samePath, isUnder } from "./paths";

/**
 * Various app constants
 */
export class AppConstants {
    static readonly insertPropertyCommandId = "axamlLive.InsertProperty";
    static readonly localhost = "127.0.0.1";

    static readonly showPreviewToSideCommand = "axamlLive.showPreviewToSide";
    static readonly previewerAssetsCommand = "axamlLive.createPreviewerAssets";
    static readonly restartPreviewerCommand = "axamlLive.restartPreviewer";
    static readonly selectSolutionCommand = "axamlLive.selectSolution";
    static readonly newProjectCommandId = "axamlLive.newProject";
    static readonly newItemCommandId = "axamlLive.newItem";

    static readonly previewerPanelViewType = "avaloniaPreviewer";

    static readonly solutionData = "axamlLive.solutionData";
    static readonly selectedSolution = "axamlLive.selectedSolution";
    static readonly previewerHost = "axamlLive.previewerHost";
    static readonly selectHostCommand = "axamlLive.selectPreviewerHost";

    /** publisher.name of this extension; set at activation from the running extension. */
    static extensionId = "axaml-live";
}
