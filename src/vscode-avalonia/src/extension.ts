import * as vscode from "vscode";
import * as lsp from "vscode-languageclient/node";
import { createLanguageService } from "./client";
import { registerAvaloniaCommands } from "./commands";
import { CommandManager } from "./commandManager";
import { logger } from "./util/Utilities";
import { AppConstants } from "./util/Utilities";
import { initSolutionService, buildSolutionModel } from "./services/solutionParser";
import { PreviewController } from "./services/previewController";

let languageClient: lsp.LanguageClient | null = null;
let controller: PreviewController | undefined;

export async function activate(context: vscode.ExtensionContext) {
	initSolutionService(context);

	controller = new PreviewController(context);
	context.subscriptions.push(controller);
	context.subscriptions.push(registerAvaloniaCommands(new CommandManager(), controller));
	context.subscriptions.push(vscode.commands.registerCommand("avalonia.debug.state", () => controller?.getDebugState()));

	if (!vscode.workspace.workspaceFolders) {
		return;
	}

	context.subscriptions.push(
		vscode.commands.registerTextEditorCommand(
			AppConstants.insertPropertyCommandId,
			(textEditor, _edit, prop: { repositionCaret: boolean } | undefined) => {
				if (prop?.repositionCaret) {
					const cursorPos = textEditor.selection.active;
					const newPos = cursorPos.with(cursorPos.line, cursorPos.character - 1);
					textEditor.selection = new vscode.Selection(newPos, newPos);
				}
				vscode.commands.executeCommand("editor.action.triggerSuggest");
			}
		)
	);

	// keep the solution model (also used by the language server) fresh when projects change
	const projectWatcher = vscode.workspace.createFileSystemWatcher("**/*.{csproj,fsproj,sln,slnx,props}");
	let timer: NodeJS.Timeout | undefined;
	const reparse = (uri: vscode.Uri) => {
		if (/[\\/](bin|obj)[\\/]/i.test(uri.fsPath)) {
			return; // restore/build outputs; the previewer re-parses after builds itself
		}
		clearTimeout(timer);
		timer = setTimeout(() => buildSolutionModel().catch((e) => logger.error(`${e}`)), 1000);
	};
	projectWatcher.onDidChange(reparse);
	projectWatcher.onDidCreate(reparse);
	projectWatcher.onDidDelete(reparse);
	context.subscriptions.push(projectWatcher);

	// parse once at startup so completion works without pressing Build when the project is already built (#152)
	buildSolutionModel().catch((e) => logger.error(`Failed to parse solution: ${e}`));

	try {
		languageClient = await createLanguageService(context);
		logger.appendLine("Starting Avalonia Language Server...");
		await languageClient.start();
	} catch (error) {
		logger.appendLine(`Failed to start Avalonia Language Server. ${error}`);
	}
}

export async function deactivate() {
	controller?.dispose();
	await languageClient?.stop();
}
