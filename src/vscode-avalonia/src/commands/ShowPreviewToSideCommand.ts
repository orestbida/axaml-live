import * as vscode from "vscode";
import { Command } from "../commandManager";
import { AppConstants } from "../util/Utilities";
import { PreviewController } from "../services/previewController";

export class ShowPreviewToSideCommand implements Command {
	public readonly id = AppConstants.showPreviewToSideCommand;
	constructor(private readonly _controller: PreviewController) {}

	public execute(mainUri?: vscode.Uri) {
		return this._controller.show(mainUri instanceof vscode.Uri ? mainUri : undefined);
	}
}

export class RestartPreviewerCommand implements Command {
	public readonly id = AppConstants.restartPreviewerCommand;
	constructor(private readonly _controller: PreviewController) {}

	public execute() {
		return this._controller.restart();
	}
}
