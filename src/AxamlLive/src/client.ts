import * as vscode from "vscode";
import * as lsp from "vscode-languageclient/node";
import { getDotnetRuntimePath, getLanguageServerPath } from "./runtimeManager";
import { avaloniaLanguageId, logger } from "./util/Utilities";
import { getSolutionDataFile } from "./services/solutionParser";
import { applySingleQuotes, singleQuotes } from "./features/editorFeatures";

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

    const watchers = [
        vscode.workspace.createFileSystemWatcher("**/*.axaml"),
        vscode.workspace.createFileSystemWatcher("**/*.{cs,csproj,props}"),
    ];
    context.subscriptions.push(...watchers);

    const clientOptions: lsp.LanguageClientOptions = {
        documentSelector: [{ language: avaloniaLanguageId }],
        progressOnInitialization: true,
        outputChannel: logger,
        synchronize: {
            // C# and project changes keep the server's in-memory compilation current (generated members without a build)
            fileEvents: watchers,
        },
        middleware: {
            // attribute quote style (axamlLive.editor.attributeQuoteStyle) for completions that write `Prop=""`
            provideCompletionItem: async (document, position, context, token, next) => {
                const result = await next(document, position, context, token);
                const items = Array.isArray(result) ? result : result?.items;
                if (items?.length && singleQuotes(document.uri)) {
                    items.forEach(applySingleQuotes);
                }
                return result;
            },
            resolveCompletionItem: async (item, token, next) => {
                const resolved = await next(item, token);
                return resolved && singleQuotes(vscode.window.activeTextEditor?.document.uri) ? applySingleQuotes(resolved) : resolved;
            },
        },
    };

    return new lsp.LanguageClient("axamlLive", "AXAML Live language server", { run: executable, debug: executable }, clientOptions);
}
