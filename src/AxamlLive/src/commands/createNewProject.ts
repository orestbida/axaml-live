import { Command } from "../commandManager";
import { AppConstants, logger } from "../util/Utilities";
import * as vscode from "vscode";
import * as fs from "fs";
import { spawn } from "child_process";
import { onLines } from "../util/lines";
import { projectNameError } from "../util/projectName";
import path = require("path");

export class CreateNewProject implements Command {
    public readonly id = AppConstants.newProjectCommandId;

    public async execute() {
        const selection = await vscode.window.showQuickPick(this.projectList);
        if (!selection) {
            return;
        }

        const projectName = await vscode.window.showInputBox({
            prompt: "Enter project name",
            placeHolder: "AvaloniaApp",
            validateInput: (v) => projectNameError(v),
        });
        if (!projectName) {
            return;
        }

        const folders = await vscode.window.showOpenDialog({ openLabel: "Select", canSelectFolders: true, canSelectFiles: false });
        const folder = folders?.[0]?.fsPath;
        if (!folder) {
            return;
        }

        const projectPath = path.join(folder, projectName);
        if (fs.existsSync(projectPath) && fs.readdirSync(projectPath).length > 0) {
            vscode.window.showErrorMessage(`The folder ${projectPath} already exists and is not empty.`);
            return;
        }

        const created = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, cancellable: false },
            async (progress) => {
                progress.report({ message: `Creating a new project: ${projectName}` });
                return this.createProject(projectName, selection.key, projectPath);
            }
        );

        if (!created) {
            vscode.window
                .showErrorMessage(
                    "Failed to create project. Make sure you have Avalonia Project Templates installed. [Learn More](https://docs.avaloniaui.net/docs/next/get-started/install)",
                    "Show Log"
                )
                .then((r) => r && logger.show(true));
            return;
        }

        const result = await vscode.window.showInformationMessage(`Project ${projectName} created at ${projectPath}`, "Open", "Cancel");

        if (result === "Open") {
            vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(projectPath), false);
        }
    }

    createProject(projectName: string, template: string, projectPath: string): Promise<boolean> {
        return new Promise((resolve) => {
            const dotnet = spawn("dotnet", ["new", template, "-n", projectName, "-o", projectPath]);
            dotnet.on("error", (e) => {
                logger.error(`Failed to run dotnet: ${e.message}`);
                resolve(false);
            });
            onLines(dotnet.stdout, (line) => line.trim() && logger.appendLine(line));
            onLines(dotnet.stderr, (line) => line.trim() && logger.error(line));
            dotnet.on("close", (code) => {
                if (code === 0) {
                    logger.appendLine(`Project ${projectName} created at ${projectPath}`);
                }
                resolve(code === 0);
            });
        });
    }

    projectList = [
        new ProjectTemplate("Avalonia App", "Avalonia Application (.NET Core)", "avalonia.app"),
        new ProjectTemplate("Avalonia MVVM App", "Avalonia MVVM Application (.NET Core)", "avalonia.mvvm"),
        new ProjectTemplate("Avalonia Cross Platform App", "Avalonia Cross Platform Application (.NET Core)", "avalonia.xplat"),
    ];
}

class ProjectTemplate implements vscode.QuickPickItem {
    constructor(label: string, details: string, key: string) {
        this.label = label;
        this.detail = details;
        this.key = key;
    }
    label: string;
    detail?: string | undefined;
    key: string;
}
