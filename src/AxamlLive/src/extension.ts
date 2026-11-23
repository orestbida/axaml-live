import * as vscode from "vscode";
import * as lsp from "vscode-languageclient/node";
import { createLanguageService } from "./client";
import { registerAvaloniaCommands } from "./commands";
import { CommandManager } from "./commandManager";
import { logger } from "./util/Utilities";
import { AppConstants } from "./util/Utilities";
import { initSolutionService, buildSolutionModel, isAvaloniaXamlFile } from "./services/solutionParser";
import { PreviewController } from "./services/previewController";
import { registerFormatter, StyleBadges } from "./features/editorFeatures";

let languageClient: lsp.LanguageClient | null = null;
let controller: PreviewController | undefined;

export async function activate(context: vscode.ExtensionContext) {
    AppConstants.extensionId = context.extension.id;
    initSolutionService(context);

    controller = new PreviewController(context);
    context.subscriptions.push(controller);
    context.subscriptions.push(registerAvaloniaCommands(new CommandManager(), controller));
    const badges = new StyleBadges();
    context.subscriptions.push(badges, registerFormatter());
    context.subscriptions.push(
        vscode.commands.registerCommand("axamlLive.debug.state", () => ({ ...controller?.getDebugState(), styleBadges: badges.count }))
    );
    context.subscriptions.push(vscode.commands.registerCommand("axamlLive.debug.hostInfo", () => controller?.getHostInfo()));

    // auto-open the previewer for an .axaml editor that is already active at startup
    const active = vscode.window.activeTextEditor?.document;
    if (
        active &&
        /\.axaml$/i.test(active.fileName) &&
        vscode.workspace.getConfiguration("axamlLive.previewer").get<boolean>("autoOpen", false)
    ) {
        controller.show(active.uri);
    }
    context.subscriptions.push(vscode.commands.registerCommand("axamlLive.debug.previewCommand", (msg) => controller?.onPanelMessage(msg)));

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

    // .xaml files of Avalonia projects (older projects, the Avalonia repository) get the AXAML language: preview,
    // language server, formatter. Only files the solution lists as AvaloniaXaml, so WPF/MAUI .xaml stay untouched.
    const adoptXaml = (doc: vscode.TextDocument) => {
        if (
            doc.languageId !== "AXAML" &&
            doc.uri.scheme === "file" &&
            /\.xaml$/i.test(doc.fileName) &&
            isAvaloniaXamlFile(doc.uri.fsPath)
        ) {
            vscode.languages.setTextDocumentLanguage(doc, "AXAML").then(undefined, (e) => logger.warn(`${e}`));
        }
    };
    context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(adoptXaml));

    // parse once at startup so completion works without pressing Build when the project is already built (#152)
    buildSolutionModel()
        .then(() => vscode.workspace.textDocuments.forEach(adoptXaml))
        .catch((e) => logger.error(`Failed to parse solution: ${e}`));

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
