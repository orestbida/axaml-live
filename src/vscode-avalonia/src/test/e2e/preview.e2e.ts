import * as assert from "assert";
import * as path from "path";
import * as fs from "fs";
import * as http from "http";
import * as vscode from "vscode";
import { execFile } from "child_process";
import { e2eSetting, windowsScreenshot } from "./config";

const workspace = e2eSetting("E2E_WORKSPACE") ?? vscode.workspace.workspaceFolders![0].uri.fsPath;
const shotDir = e2eSetting("E2E_SCREENSHOT_DIR");
const pauseMs = Number(e2eSetting("E2E_PAUSE_MS") ?? 2500);
const buildTarget = e2eSetting("E2E_BUILD_TARGET");

type State = {
	panel: boolean;
	panelState?: { status: string; message?: string; url?: string };
	sessionState?: string;
	project?: string;
	htmlUrl?: string;
	sessionsStarted: number;
	lastXaml?: { error?: string; message?: string; line?: number };
	building: boolean;
};

const state = async () => (await vscode.commands.executeCommand<State>("avalonia.debug.state"))!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(what: string, pred: (s: State) => boolean, timeout = 120000): Promise<State> {
	const end = Date.now() + timeout;
	let s = await state();
	while (!pred(s)) {
		if (Date.now() > end) {
			throw new Error(`Timed out waiting for: ${what}. Last state: ${JSON.stringify(s)}`);
		}
		await sleep(250);
		s = await state();
	}
	return s;
}

let shot = 0;
async function checkpoint(name: string) {
	console.log(`[e2e] checkpoint: ${name} ${JSON.stringify(await state())}`);
	await sleep(pauseMs);
	if (shotDir) {
		windowsScreenshot(shotDir, `${String(++shot).padStart(2, "0")}-${name}.png`);
	}
}

function findAxaml(name: string): string {
	const stack = [workspace];
	while (stack.length) {
		const dir = stack.pop()!;
		for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
			if (e.isDirectory() && !["bin", "obj", ".git"].includes(e.name)) {
				stack.push(path.join(dir, e.name));
			} else if (e.name === name) {
				return path.join(dir, e.name);
			}
		}
	}
	throw new Error(`${name} not found in ${workspace}`);
}

function dotnetBuild(): Promise<{ code: number; out: string }> {
	return new Promise((resolve) => {
		execFile("dotnet", ["build", ...(buildTarget ? [buildTarget] : []), "-nologo", "-v", "q"], { cwd: workspace }, (err, stdout, stderr) =>
			resolve({ code: err ? ((err as any).code ?? 1) : 0, out: stdout + stderr })
		);
	});
}

const noXamlError = (s: State) => !!s.lastXaml && !s.lastXaml.error && !s.lastXaml.message;

suite("Avalonia previewer (e2e)", () => {
	const mainWindow = findAxaml(e2eSetting("E2E_AXAML") ?? "MainWindow.axaml");
	let editor: vscode.TextEditor;

	suiteSetup(async () => {
		await vscode.workspace.getConfiguration("avalonia.previewer").update("defaultZoom", 0.5, vscode.ConfigurationTarget.Global);
		const doc = await vscode.workspace.openTextDocument(mainWindow);
		editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
	});

	test("shows the preview (builds if needed)", async () => {
		await vscode.commands.executeCommand("avalonia.showPreviewToSide", editor.document.uri);
		const s = await waitFor("preview ready", (s) => s.sessionState === "ready" && s.panelState?.status === "ready", 240000);
		assert.ok(s.htmlUrl?.startsWith("http://127.0.0.1:"));
		// the unmodified file must render without errors
		const r = await waitFor("first XAML result", (s) => !!s.lastXaml, 60000);
		assert.ok(!r.lastXaml?.error && !r.lastXaml?.message, `initial preview error: ${r.lastXaml?.message ?? r.lastXaml?.error}`);
		await checkpoint("preview-ready");
	});

	const showMain = async () => (editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(mainWindow), vscode.ViewColumn.One));

	test("live update of unsaved edits", async () => {
		await showMain();
		const text = editor.document.getText();
		const end = text.lastIndexOf("</Window>");
		const start = text.indexOf(">", text.indexOf("<Window")) + 1;
		assert.ok(end > start, "<Window> element not found");
		const newContent = `
    <StackPanel Margin="20" Spacing="10">
        <TextBlock Text="Live edit from the e2e test" FontSize="28" FontWeight="Bold"/>
        <Button Content="A button"/>
        <Border Background="#7C4DFF" Height="60" CornerRadius="8"/>
    </StackPanel>
`;
		const before = (await state()).lastXaml;
		await editor.edit((e) =>
			e.replace(new vscode.Range(editor.document.positionAt(start), editor.document.positionAt(end)), newContent)
		);
		const s = await waitFor("xaml result after edit", (s) => s.lastXaml !== before && noXamlError(s), 30000);
		assert.strictEqual(s.panelState?.status, "ready");
		await checkpoint("live-edit");
	});

	test("reports XAML errors in the panel and Problems view", async () => {
		await showMain();
		const pos = editor.document.positionAt(editor.document.getText().indexOf("<Button"));
		const expectedLine = pos.line + 1;
		await editor.edit((e) => e.insert(pos, `<NotAControl Foo="1"/>`));
		const s = await waitFor("xaml error", (s) => !!(s.lastXaml?.error || s.lastXaml?.message), 30000);
		console.log(`[e2e] xaml error: ${s.lastXaml?.message ?? s.lastXaml?.error} (line ${s.lastXaml?.line})`);
		const diags = () =>
			vscode.languages.getDiagnostics(editor.document.uri).filter((d) => d.source === "Avalonia Previewer");
		assert.strictEqual(diags().length, 1);
		assert.strictEqual(s.lastXaml?.line, expectedLine, "error line not reported");
		assert.strictEqual(diags()[0].range.start.line, expectedLine - 1);
		await checkpoint("xaml-error");

		await showMain();
		await vscode.commands.executeCommand("undo");
		await waitFor("error cleared", noXamlError, 30000);
		assert.strictEqual(diags().length, 0);
		await editor.document.save();
		await checkpoint("error-fixed");
	});

	test("half-typed values report an error and keep the previewer alive (AvaloniaPro #65)", async () => {
		await showMain();
		const started = (await state()).sessionsStarted;
		const text = editor.document.getText();
		const at = text.indexOf("#7C4DFF");
		assert.ok(at > 0, "live edit content missing");
		const range = new vscode.Range(editor.document.positionAt(at), editor.document.positionAt(at + "#7C4DFF".length));
		await editor.edit((e) => e.replace(range, "#7C"));
		const s = await waitFor("error for incomplete value", (s) => !!(s.lastXaml?.error || s.lastXaml?.message), 30000);
		console.log(`[e2e] incomplete value: ${(s.lastXaml?.message ?? s.lastXaml?.error ?? "").split("\n")[0].substring(0, 120)}`);
		assert.strictEqual(s.sessionState, "ready", "previewer died on an incomplete value");
		await editor.edit((e) => e.replace(new vscode.Range(range.start, range.start.translate(0, 3)), "#7C4DFF"));
		const ok = await waitFor("recovered", noXamlError, 30000);
		assert.strictEqual(ok.sessionsStarted, started, "previewer had to restart");
		await editor.document.save();
	});

	test("external dotnet build works while previewing and reloads the preview", async () => {
		const started = (await state()).sessionsStarted;
		const cs = [path.join(workspace, "ViewModels", "MainViewModel.cs"), path.join(workspace, path.basename(workspace), "ViewModels", "MainViewModel.cs")].find((f) => fs.existsSync(f)) ?? "";
		if (fs.existsSync(cs)) {
			fs.writeFileSync(cs, fs.readFileSync(cs, "utf8").replace(/Welcome to Avalonia!?/, "Rebuilt by the e2e test"));
		}
		const result = await dotnetBuild();
		assert.strictEqual(result.code, 0, `dotnet build failed while previewer was running:\n${result.out}`);
		const s = await waitFor("previewer restarted after build", (s) => s.sessionsStarted > started && s.sessionState === "ready", 120000);
		assert.strictEqual(s.panelState?.status, "ready");
		await checkpoint("after-external-build");
	});

	test("Build command rebuilds and reloads", async () => {
		const started = (await state()).sessionsStarted;
		await vscode.commands.executeCommand("avalonia.createPreviewerAssets");
		await waitFor("previewer restarted after Build command", (s) => s.sessionsStarted > started && s.sessionState === "ready", 180000);
		await checkpoint("after-build-command");
	});

	async function completionLabels(prefix: string): Promise<string[]> {
		await showMain();
		const text = editor.document.getText();
		const pos = editor.document.positionAt(text.indexOf("<TextBlock"));
		await editor.edit((e) => e.insert(pos, prefix));
		const at = pos.translate(0, prefix.length);
		let labels: string[] = [];
		for (let i = 0; i < 20 && !labels.some((l) => l !== "Build the project"); i++) {
			const list = await vscode.commands.executeCommand<vscode.CompletionList>("vscode.executeCompletionItemProvider", editor.document.uri, at);
			labels = list.items.map((it) => (typeof it.label === "string" ? it.label : it.label.label));
			if (!labels.some((l) => l !== "Build the project")) {
				await sleep(1000);
			}
		}
		await editor.edit((e) => e.delete(new vscode.Range(pos, at)));
		return labels;
	}

	test("XAML completion (language server)", async () => {
		const labels = await completionLabels("<Butt");
		console.log(`[e2e] completion for <Butt: ${labels.slice(0, 10).join(", ")} … (${labels.length})`);
		assert.ok(labels.includes("Button"), "Button not offered by completion");
	});

	/** Types `prefix`, applies the completion item `label` exactly like VS Code would and returns the line. */
	async function applyCompletion(prefix: string, label: string): Promise<string> {
		await showMain();
		const pos = editor.document.positionAt(editor.document.getText().indexOf("<TextBlock"));
		await editor.edit((e) => e.insert(pos, prefix));
		const at = pos.translate(0, prefix.length);
		const list = await vscode.commands.executeCommand<vscode.CompletionList>("vscode.executeCompletionItemProvider", editor.document.uri, at);
		const labelOf = (it: vscode.CompletionItem) => (typeof it.label === "string" ? it.label : it.label.label);
		const item = list.items.find((it) => labelOf(it) === label) ?? list.items.find((it) => label.endsWith("*") && labelOf(it).startsWith(label.slice(0, -1)));
		assert.ok(item, `completion "${label}" not offered for "${prefix}"`);
		const range = item.range ? ("replacing" in item.range ? item.range.replacing : item.range) : editor.document.getWordRangeAtPosition(at) ?? new vscode.Range(at, at);
		const insert = typeof item.insertText === "string" ? item.insertText : item.insertText?.value ?? label;
		await editor.edit((e) => e.replace(range, insert));
		const line = editor.document.lineAt(pos.line).text.trim();
		await vscode.commands.executeCommand("undo");
		await vscode.commands.executeCommand("undo");
		return line;
	}

	test("closing tag and prefixed completions replace the typed text (#166)", async () => {
		const closing = await applyCompletion("<Grid></", "/Grid>");
		assert.ok(closing.startsWith("<Grid></Grid>"), `closing tag: ${closing}`);
		// Avalonia 12 template: MainViewModel, Avalonia 11: MainWindowViewModel
		const prefixed = await applyCompletion("<vm:Ma", "vm:Main*");
		assert.ok(/^<vm:Main\w*ViewModel/.test(prefixed), `prefixed: ${prefixed}`);
		console.log(`[e2e] completion applied: ${closing.substring(0, 14)} | ${prefixed.substring(0, 18)}`);
	});

	test("completion picks up new types after a build without restarting VS Code", async () => {
		const vmDir = [path.join(workspace, "ViewModels"), path.join(workspace, path.basename(workspace), "ViewModels")].find((d) => fs.existsSync(d));
		if (!vmDir || !fs.existsSync(path.join(vmDir, "ViewModelBase.cs"))) {
			console.log("[e2e] skipped: not a C# MVVM project");
			return;
		}
		const ns = /namespace\s+([\w.]+)/.exec(fs.readFileSync(path.join(vmDir, "ViewModelBase.cs"), "utf8"))![1];
		const file = path.join(vmDir, "E2eAddedControl.cs");
		fs.writeFileSync(file, `namespace ${ns};\npublic class E2eAddedControl : Avalonia.Controls.TextBlock { }\n`);
		try {
			const before = await completionLabels("<vm:");
			assert.ok(!before.some((l) => l.endsWith("E2eAddedControl")));
			await vscode.commands.executeCommand("avalonia.createPreviewerAssets");
			await waitFor("ready after build", (s) => s.sessionState === "ready" && !s.building, 180000);
			const after = await completionLabels("<vm:");
			console.log(`[e2e] completion for <vm: after build: ${after.join(", ")}`);
			assert.ok(after.some((l) => l.endsWith("E2eAddedControl")), "new type not in completion after build");
		} finally {
			fs.rmSync(file, { force: true });
		}
	});

	test("New Avalonia Item creates a UserControl the preview can show", async () => {
		const views = path.dirname(mainWindow);
		const created = await vscode.commands.executeCommand<vscode.Uri>("avalonia.newItem", vscode.Uri.file(views), {
			template: "UserControl",
			name: "E2eUserControl",
		});
		try {
			assert.ok(created && fs.existsSync(created.fsPath), "UserControl not created");
			const codeBehind = [".cs", ".fs"].map((e) => created.fsPath + e).find((p) => fs.existsSync(p))!;
			const cs = fs.readFileSync(codeBehind, "utf8");
			const xaml = fs.readFileSync(created.fsPath, "utf8");
			const ns = /namespace\s+([\w.]+)/.exec(cs)?.[1];
			console.log(`[e2e] new item namespace: ${ns}, x:Class: ${/x:Class="([^"]+)"/.exec(xaml)?.[1]}`);
			assert.ok(ns?.endsWith(".Views") || /x:Class="[w.]*.Views.E2eUserControl"/.test(xaml), `unexpected namespace ${ns}`);
			// the preview follows the new file; build so its code-behind exists, then it must render without errors
			await waitFor("preview follows new file", (s) => !!s.panelState?.message?.includes("E2eUserControl.axaml") || s.panelState?.status === "starting", 30000);
			const started = (await state()).sessionsStarted;
			await vscode.commands.executeCommand("avalonia.createPreviewerAssets");
			const s = await waitFor("ready after build", (s) => s.sessionsStarted > started && s.sessionState === "ready" && !!s.lastXaml, 180000);
			assert.ok(!s.lastXaml?.error && !s.lastXaml?.message, `new UserControl preview error: ${s.lastXaml?.message ?? s.lastXaml?.error}`);
			await checkpoint("new-usercontrol");
		} finally {
			await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
			if (created) {
				fs.rmSync(created.fsPath, { force: true });
				fs.rmSync(created.fsPath + ".cs", { force: true });
				fs.rmSync(created.fsPath + ".fs", { force: true });
				for (const proj of fs.readdirSync(workspace).filter((f) => f.endsWith(".fsproj"))) {
					const p = path.join(workspace, proj);
					fs.writeFileSync(p, fs.readFileSync(p, "utf8").split(/\r?\n/).filter((l) => !l.includes("E2eUserControl")).join("\r\n"));
				}
			}
			await showMain();
		}
	});

	test("previewer host project setting is honored (#207, #200)", async () => {
		const before = await state();
		const config = vscode.workspace.getConfiguration("avalonia.previewer");
		try {
			await config.update("hostProject", "DoesNotExist", vscode.ConfigurationTarget.Workspace);
			let s = await waitFor("restart with unknown host", (s) => s.sessionsStarted > before.sessionsStarted && s.sessionState === "ready", 120000);
			assert.strictEqual(s.project, before.project, "unknown host must fall back to automatic selection");
			const started = s.sessionsStarted;
			await config.update("hostProject", before.project, vscode.ConfigurationTarget.Workspace);
			s = await waitFor("restart with explicit host", (s) => s.sessionsStarted > started && s.sessionState === "ready", 120000);
			assert.strictEqual(s.project, before.project);
		} finally {
			const started = (await state()).sessionsStarted;
			await config.update("hostProject", undefined, vscode.ConfigurationTarget.Workspace);
			await waitFor("restart after clearing host", (s) => s.sessionsStarted > started && s.sessionState === "ready", 120000);
		}
	});

	test("Restart command", async () => {
		const started = (await state()).sessionsStarted;
		await vscode.commands.executeCommand("avalonia.restartPreviewer");
		await waitFor("previewer restarted", (s) => s.sessionsStarted > started && s.sessionState === "ready", 120000);
	});

	test("switching files keeps one previewer and follows the editor", async () => {
		const started = (await state()).sessionsStarted;
		await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(findAxaml("App.axaml")), vscode.ViewColumn.One);
		await sleep(1500);
		editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(mainWindow), vscode.ViewColumn.One);
		const s = await waitFor("ready after switching", (s) => s.sessionState === "ready", 30000);
		assert.strictEqual(s.sessionsStarted, started, "switching files in the same project must not restart the previewer");
		await checkpoint("switched-back");
	});

	test("closing the preview stops the previewer", async () => {
		const url = (await state()).htmlUrl!;
		for (const group of vscode.window.tabGroups.all) {
			for (const tab of group.tabs) {
				if ((tab.input as any)?.viewType?.endsWith("avaloniaPreviewer")) {
					await vscode.window.tabGroups.close(tab);
				}
			}
		}
		await waitFor("panel closed", (s) => !s.panel && !s.sessionState, 10000);
		await sleep(2000);
		const alive = await new Promise<boolean>((resolve) =>
			http.get(url, (r) => { r.resume(); resolve(true); }).on("error", () => resolve(false))
		);
		assert.strictEqual(alive, false, "previewer HTTP server still alive after closing the panel");
		await checkpoint("closed");
	});
});
