import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs-extra";
import { spawn } from "child_process";
import { Command } from "../commandManager";
import { logger } from "../util/Utilities";
import {
    codeBehindCandidates,
    findTypeDeclarationLine,
    getDataType,
    getXClass,
    shortName,
    viewModelNameCandidates,
} from "../xaml/navigation";
import * as sln from "../services/solutionParser";
import { dotnetBuild } from "../services/previewController";

const exclude = "**/{bin,obj,node_modules,.git}/**";

function activeAxaml(uri?: vscode.Uri): vscode.TextDocument | undefined {
    const doc = vscode.window.activeTextEditor?.document;
    if (uri && doc?.uri.toString() !== uri.toString()) {
        return vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    }
    return doc && (/\.axaml$/i.test(doc.fileName) || doc.languageId === "AXAML") ? doc : undefined;
}

/** Opens `file` and moves the cursor to the declaration of `typeName` (when found). */
async function openAtType(file: string, typeName?: string): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(file);
    const line = typeName ? findTypeDeclarationLine(doc.getText(), typeName) : -1;
    const editor = await vscode.window.showTextDocument(doc);
    if (line >= 0) {
        const pos = new vscode.Position(line, 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    }
}

/** Finds the source file declaring `typeName`: files named like the type first, then a scan of C#/F# files. */
async function findTypeFile(typeName: string, fullName?: string): Promise<string | undefined> {
    const byName = await vscode.workspace.findFiles(`**/${typeName}.{cs,fs}`, exclude, 20);
    const candidates = byName.map((u) => u.fsPath);
    const all = (await vscode.workspace.findFiles("**/*.{cs,fs}", exclude, 3000))
        .map((u) => u.fsPath)
        .filter((f) => !candidates.includes(f));
    for (const file of [...candidates, ...all]) {
        const text = await fs.readFile(file, "utf-8").catch(() => "");
        if (findTypeDeclarationLine(text, typeName) < 0) {
            continue;
        }
        const ns = fullName?.includes(".") ? fullName.substring(0, fullName.lastIndexOf(".")) : undefined;
        if (!ns || text.includes(ns) || candidates.length + all.length === 1) {
            return file;
        }
    }
    return undefined;
}

/** F7: from an .axaml file to its code-behind (`X.axaml.cs` / `.fs`, or the x:Class declaration). */
export class ShowCodeBehindCommand implements Command {
    public readonly id = "axamlLive.showCodeBehind";

    async execute(uri?: vscode.Uri) {
        const doc = activeAxaml(uri);
        if (!doc) {
            vscode.window.showInformationMessage("Open an .axaml file first.");
            return;
        }
        const xClass = getXClass(doc.getText());
        const direct = codeBehindCandidates(doc.fileName).find((f) => fs.existsSync(f));
        if (direct) {
            return openAtType(direct, xClass ? shortName(xClass) : undefined);
        }
        if (xClass) {
            const file = await findTypeFile(shortName(xClass), xClass);
            if (file) {
                return openAtType(file, shortName(xClass));
            }
        }
        vscode.window.showInformationMessage(`No code-behind found for ${path.basename(doc.fileName)}.`);
    }
}

/** From an .axaml file to its view model: x:DataType, Design.DataContext, then naming conventions. */
export class ShowViewModelCommand implements Command {
    public readonly id = "axamlLive.showViewModel";

    async execute(uri?: vscode.Uri) {
        const doc = activeAxaml(uri);
        if (!doc) {
            vscode.window.showInformationMessage("Open an .axaml file first.");
            return;
        }
        const text = doc.getText();
        const dataType = getDataType(text);
        const viewName = shortName(getXClass(text) ?? path.basename(doc.fileName, ".axaml"));
        const names = dataType ? [shortName(dataType)] : viewModelNameCandidates(viewName);
        for (const name of names) {
            const file = await findTypeFile(name, dataType);
            if (file) {
                return openAtType(file, name);
            }
        }
        vscode.window.showInformationMessage(`No view model found for ${path.basename(doc.fileName)} (looked for ${names.join(", ")}).`);
    }
}

/** Runs or debugs the executable project that hosts the current file. */
export class RunProjectCommand implements Command {
    public readonly id = "axamlLive.runProject";

    async execute(args?: { debug?: boolean }): Promise<boolean> {
        let debug = args?.debug;
        if (debug === undefined) {
            const pick = await vscode.window.showQuickPick(
                [
                    { label: "$(debug-alt) Debug", debug: true },
                    { label: "$(run) Run without debugging", debug: false },
                ],
                { placeHolder: "Avalonia: start the application" }
            );
            if (!pick) {
                return false;
            }
            debug = pick.debug;
        }

        const model = await sln.ensureSolutionModel();
        const editorFile = vscode.window.activeTextEditor?.document.fileName;
        const file = model && editorFile ? sln.getFileDetails(editorFile, model) : undefined;
        const project = model ? sln.getExecutableProject(model, file) : undefined;
        if (!project) {
            vscode.window.showErrorMessage("No executable Avalonia project found.");
            return false;
        }

        const built = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Window, title: `Avalonia: building ${project.name}` },
            () => dotnetBuild(project.path)
        );
        if (!built.ok) {
            vscode.window.showErrorMessage(`Build failed for ${project.name}.`, "Show Log").then((r) => r && logger.show(true));
            return false;
        }

        const folder =
            vscode.workspace.workspaceFolders?.find((f) => project.path.startsWith(f.uri.fsPath)) ?? vscode.workspace.workspaceFolders?.[0];
        if (!vscode.extensions.getExtension("ms-dotnettools.csharp")) {
            // no .NET debugger available: run in a terminal
            const terminal = vscode.window.createTerminal({ name: `Avalonia: ${project.name}`, cwd: path.dirname(project.path) });
            terminal.show();
            terminal.sendText(`dotnet run --no-build --project "${project.path}"`);
            return true;
        }
        return vscode.debug.startDebugging(folder, {
            name: `Avalonia: ${project.name}`,
            type: "coreclr",
            request: "launch",
            program: project.targetPath,
            cwd: path.dirname(project.path),
            console: "internalConsole",
            stopAtEntry: false,
            noDebug: !debug,
        });
    }
}

/** dotnet new install Avalonia.Templates (installs or updates to the latest version). */
export class InstallTemplatesCommand implements Command {
    public readonly id = "axamlLive.installTemplates";

    async execute(): Promise<boolean> {
        const ok = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: "Installing / updating Avalonia templates…" },
            () =>
                new Promise<boolean>((resolve) => {
                    const proc = spawn("dotnet", ["new", "install", "Avalonia.Templates"], {
                        env: { ...process.env, DOTNET_CLI_UI_LANGUAGE: "en" },
                    });
                    const log = (d: Buffer) => logger.appendLine(d.toString().trimEnd());
                    proc.stdout.on("data", log);
                    proc.stderr.on("data", log);
                    proc.on("error", (e) => {
                        logger.error(`Failed to run dotnet: ${e.message}`);
                        resolve(false);
                    });
                    proc.on("close", (code) => resolve(code === 0));
                })
        );
        if (ok) {
            vscode.window.showInformationMessage("Avalonia templates are installed and up to date.");
        } else {
            vscode.window.showErrorMessage("Installing the Avalonia templates failed.", "Show Log").then((r) => r && logger.show(true));
        }
        return ok;
    }
}
