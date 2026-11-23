/**
 * Takes the README screenshot: one .axaml file next to its preview, without side bars.
 * Run with E2E_SUITE=screenshot, E2E_AXAML=<file name>, E2E_SCREENSHOT_DIR=<folder> (Windows desktop capture).
 */
import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { e2eSetting, windowsScreenshot } from "./config";

const workspace = vscode.workspace.workspaceFolders![0].uri.fsPath;
const state = async () => (await vscode.commands.executeCommand<any>("axamlLive.debug.state"))!;
const previewCommand = (msg: object) => vscode.commands.executeCommand("axamlLive.debug.previewCommand", msg);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function findFile(dir: string, name: string): string | undefined {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory() && !["bin", "obj", ".git", "node_modules"].includes(e.name)) {
            const found = findFile(p, name);
            if (found) {
                return found;
            }
        } else if (e.name === name) {
            return p;
        }
    }
    return undefined;
}

suite("README screenshot", () => {
    test("file and preview side by side", async () => {
        const file = findFile(workspace, e2eSetting("E2E_AXAML") ?? "MainWindow.axaml");
        assert.ok(file, "file not found");
        await vscode.workspace.getConfiguration("axamlLive.previewer").update("defaultZoom", 1, vscode.ConfigurationTarget.Global);
        try {
            await vscode.commands.executeCommand("workbench.action.closeAllEditors");
            const doc = await vscode.workspace.openTextDocument(file);
            await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
            for (const command of ["workbench.action.closeSidebar", "workbench.action.closeAuxiliaryBar", "workbench.action.closePanel"]) {
                await vscode.commands.executeCommand(command);
            }
            await vscode.commands.executeCommand("axamlLive.showPreviewToSide", doc.uri);
            const end = Date.now() + 240000;
            while (!((await state()).preview?.frame?.avgLum > 0) && Date.now() < end) {
                await sleep(500);
            }
            await previewCommand({ type: "setTheme", value: e2eSetting("E2E_THEME") ?? "Dark" });
            await previewCommand({ type: "zoom", zoom: 1 }); // 100%: one preview pixel per screen pixel, sharp
            await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
            await sleep(Number(e2eSetting("E2E_PAUSE_MS") ?? 4000));
            await vscode.commands.executeCommand("notifications.clearAll");
            await sleep(500);
            const dir = e2eSetting("E2E_SCREENSHOT_DIR");
            if (dir) {
                windowsScreenshot(dir, "screenshot-full.png");
            }
        } finally {
            await vscode.workspace
                .getConfiguration("axamlLive.previewer")
                .update("defaultZoom", undefined, vscode.ConfigurationTarget.Global);
        }
    });
});
