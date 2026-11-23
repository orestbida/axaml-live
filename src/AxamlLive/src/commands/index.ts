import * as vscode from "vscode";
import { CommandManager } from "../commandManager";
import { RestartPreviewerCommand, ShowPreviewToSideCommand } from "./ShowPreviewToSideCommand";
import { CreatePreviewerAssets, SelectPreviewerHostCommand, SelectSolutionCommand } from "./createPreviewerAssets";
import { CreateNewProject } from "./createNewProject";
import { NewItemCommand } from "./newItem";
import { InstallTemplatesCommand, RunProjectCommand, ShowCodeBehindCommand, ShowViewModelCommand } from "./editorCommands";
import { PreviewController } from "../services/previewController";

export function registerAvaloniaCommands(commandManager: CommandManager, controller: PreviewController): vscode.Disposable {
    commandManager.register(new CreateNewProject());
    commandManager.register(new NewItemCommand());
    commandManager.register(new ShowCodeBehindCommand());
    commandManager.register(new ShowViewModelCommand());
    commandManager.register(new RunProjectCommand());
    commandManager.register(new InstallTemplatesCommand());
    commandManager.register(new ShowPreviewToSideCommand(controller));
    commandManager.register(new RestartPreviewerCommand(controller));
    commandManager.register(new CreatePreviewerAssets(controller));
    commandManager.register(new SelectSolutionCommand(controller));
    commandManager.register(new SelectPreviewerHostCommand(controller));
    return commandManager;
}
