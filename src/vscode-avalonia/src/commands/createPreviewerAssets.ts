import * as vscode from "vscode";
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

export class SelectSolutionCommand implements Command {
	public readonly id = AppConstants.selectSolutionCommand;
	constructor(private readonly _controller: PreviewController) {}

	async execute() {
		if (await sln.selectSolution()) {
			await this._controller.restart();
		}
	}
}
