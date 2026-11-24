import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { Command } from "../commandManager";
import { AppConstants } from "../util/Utilities";
import { PreviewController } from "../services/previewController";
import * as sln from "../services/solutionParser";

/** Builds the executable project, refreshes the solution model and reloads the previewer. */
export class CreatePreviewerAssets implements Command {
    public readonly id = AppConstants.previewerAssetsCommand;
    constructor(private readonly _controller: PreviewController) {}

    async execute(args: { triggerCodeComplete: boolean } | undefined): Promise<void> {
        if (!vscode.workspace.workspaceFolders) {
            return;
        }
        const ok = await this._controller.build();
        if (ok && args?.triggerCodeComplete) {
            vscode.commands.executeCommand(AppConstants.insertPropertyCommandId, { repositionCaret: true });
        }
    }
}

export class SelectPreviewerHostCommand implements Command {
    public readonly id = AppConstants.selectHostCommand;
    constructor(private readonly _controller: PreviewController) {}

    async execute() {
        if (await sln.selectPreviewerHost()) {
            await this._controller.restart();
        }
    }
}

export class SelectSolutionCommand implements Command {
    public readonly id = AppConstants.selectSolutionCommand;
    constructor(private readonly _controller: PreviewController) {}

    async execute() {
        if (await sln.selectSolution()) {
            await this._controller.restart();
        }
    }
}

/**
 * Quick fix of the language server for a view model without a parameterless constructor: writes the design-time
 * subclass, adds Design.DataContext to the view and builds, so the preview shows the view with that data.
 */
export class CreateDesignViewModelCommand implements Command {
    public readonly id = "axamlLive.createDesignViewModel";
    constructor(private readonly _controller: PreviewController) {}

    async execute(args: { file: string; content: string; uri: string; line: number; character: number; text: string }) {
        if (!args?.file) {
            return false;
        }
        if (!fs.existsSync(args.file)) {
            await fs.promises.writeFile(args.file, args.content);
        }
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(args.uri));
        const edit = new vscode.WorkspaceEdit();
        edit.insert(doc.uri, new vscode.Position(args.line, args.character), args.text);
        await vscode.workspace.applyEdit(edit);
        await doc.save();
        const name = path.basename(args.file);
        vscode.window
            .showInformationMessage(`Created ${name}. Set sample values in its constructor; the preview uses it.`, "Open")
            .then((choice) => {
                if (choice) {
                    vscode.window.showTextDocument(vscode.Uri.file(args.file), { preview: false });
                }
            });
        return this._controller.build();
    }
}
