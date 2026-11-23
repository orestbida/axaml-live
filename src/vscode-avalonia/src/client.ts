import * as vscode from "vscode";
import * as lsp from "vscode-languageclient/node";
import { getDotnetRuntimePath, getLanguageServerPath } from "./runtimeManager";
import { avaloniaLanguageId, logger } from "./util/Utilities";
import { getSolutionDataFile } from "./services/solutionParser";

export async function createLanguageService(context: vscode.ExtensionContext): Promise<lsp.LanguageClient> {
	logger.appendLine("Creating language service");

	const executable: lsp.Executable = {
		command: await getDotnetRuntimePath(),
		args: [getLanguageServerPath(context)],
		options: {
			// tells the server which solution model to use (same file the extension writes)
			env: { ...process.env, AVALONIA_SOLUTION_DATA: getSolutionDataFile(context) },
		},
	};

	const clientOptions: lsp.LanguageClientOptions = {
		documentSelector: [{ language: avaloniaLanguageId }],
		progressOnInitialization: true,
		outputChannel: logger,
		synchronize: {
			configurationSection: "avalonia",
			fileEvents: vscode.workspace.createFileSystemWatcher("**/*.axaml"),
		},
		middleware: {
			provideDocumentFormattingEdits: (document, options, token, next) =>
				next(document, { ...options, insertFinalNewline: true }, token),
		},
	};

	return new lsp.LanguageClient(avaloniaLanguageId, "Avalonia LSP", { run: executable, debug: executable }, clientOptions);
}
