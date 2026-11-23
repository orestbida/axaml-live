import * as vscode from "vscode";
import * as lsp from "vscode-languageclient/node";
import { getDotnetRuntimePath, getLanguageServerPath } from "./runtimeManager";
import { avaloniaLanguageId, logger } from "./util/Utilities";
import { getSolutionDataFile } from "./services/solutionParser";
import { applyQuoteStyle } from "./features/editorFeatures";

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
			// attribute quote style (avalonia.editor.attributeQuoteStyle) for completions that write `Prop=""`
			provideCompletionItem: async (document, position, context, token, next) => {
				const result = await next(document, position, context, token);
				const items = Array.isArray(result) ? result : result?.items;
				items?.forEach((i) => applyQuoteStyle(i, document.uri));
				return result;
			},
			resolveCompletionItem: async (item, token, next) => {
				const resolved = await next(item, token);
				return resolved ? applyQuoteStyle(resolved, vscode.window.activeTextEditor?.document.uri) : resolved;
			},
		},
	};

	return new lsp.LanguageClient(avaloniaLanguageId, "Avalonia LSP", { run: executable, debug: executable }, clientOptions);
}
