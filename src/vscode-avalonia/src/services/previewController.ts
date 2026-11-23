import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs-extra";
import { spawn } from "child_process";

import * as sm from "../models/solutionModel";
import * as sln from "./solutionParser";
import { PreviewSession, canStartPreviewer, isSameProject, XamlResult } from "./previewSession";
import { WebPreviewerPanel } from "../panels/WebPreviwerPanel";
import { isAvaloniaFile, logger, samePath } from "../util/Utilities";

/**
 * Owns the preview panel and the previewer session and keeps them in sync with the editor:
 *  - follows the active AXAML editor
 *  - pushes unsaved edits to the previewer (debounced)
 *  - restarts the previewer when the project output changes (any build: ours, terminal, C# Dev Kit)
 *  - reports XAML errors in the panel and the Problems view (#112, #79)
 */
export class PreviewController implements vscode.Disposable {
	private _panel: WebPreviewerPanel | undefined;
	private _session: PreviewSession | undefined;
	private _file: vscode.Uri | undefined;
	private _building: Promise<boolean> | undefined;
	private _outputWatchers: vscode.Disposable[] = [];
	private _watchedDirs: string[] = [];
	private _restartTimer: NodeJS.Timeout | undefined;
	private _editTimer: NodeJS.Timeout | undefined;
	private _generation = 0;
	private _lastXaml: XamlResult | undefined;
	private _restarts = 0;
	private readonly _disposables: vscode.Disposable[] = [];
	private readonly _diagnostics = vscode.languages.createDiagnosticCollection("Avalonia Previewer");

	constructor(private readonly _context: vscode.ExtensionContext) {
		this._disposables.push(
			this._diagnostics,
			vscode.window.onDidChangeActiveTextEditor((e) => {
				if (this._panel && e && isAvaloniaFile(e.document)) {
					this.setFile(e.document.uri);
				}
			}),
			vscode.workspace.onDidChangeTextDocument((e) => {
				if (this._file && samePath(e.document.uri.fsPath, this._file.fsPath) && e.contentChanges.length) {
					clearTimeout(this._editTimer);
					this._editTimer = setTimeout(() => this.pushXaml(), this.editDelay);
				}
			}),
			vscode.workspace.onDidSaveTextDocument((doc) => {
				if (this._file && samePath(doc.uri.fsPath, this._file.fsPath)) {
					this.pushXaml();
				}
			})
		);
	}

	private get editDelay(): number {
		return vscode.workspace.getConfiguration("avalonia.previewer").get<number>("updateDelay", 300);
	}

	/** Shows the preview panel for the given file. */
	public async show(uri: vscode.Uri | undefined) {
		uri ??= vscode.window.activeTextEditor?.document.uri;
		if (!uri) {
			vscode.window.showInformationMessage("Open an .axaml file to preview it.");
			return;
		}
		if (!this._panel) {
			const column = vscode.window.activeTextEditor ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active;
			this._panel = new WebPreviewerPanel(this._context.extensionUri, column);
			this._panel.onDidDispose(() => this.onPanelClosed());
			this._panel.onCommand((cmd) => this.onPanelCommand(cmd));
		} else {
			this._panel.reveal();
		}
		await this.setFile(uri);
	}

	private onPanelCommand(cmd: string) {
		switch (cmd) {
			case "restart":
				this.restart();
				break;
			case "build":
				this.build();
				break;
			case "showLog":
				logger.show(true);
				break;
		}
	}

	private onPanelClosed() {
		// closing the preview stops the previewer process (AvaloniaPro #188)
		this._panel = undefined;
		this._file = undefined;
		this.stopSession();
		this._diagnostics.clear();
	}

	/** Switches the previewed file; starts a new previewer only when the host project changes. */
	private async setFile(uri: vscode.Uri) {
		this._file = uri;
		this._panel?.setTitle(uri);

		const target = await this.resolveTarget(uri);
		if (!target) {
			return;
		}
		const session = this._session;
		if (session && session.state !== "exited" && isSameProject(session.project, target.project)) {
			this._panel?.setState({ ...this._panel.state, message: `${target.project.name} · ${path.basename(uri.fsPath)}` });
			this.pushXaml();
			return;
		}
		await this.startSession(target.project);
	}

	private async resolveTarget(uri: vscode.Uri): Promise<{ file: sm.File; project: sm.Project } | undefined> {
		let model: sm.Solution | undefined;
		try {
			model = await sln.ensureSolutionModel();
		} catch (e) {
			this.showError("Failed to analyze the solution.", `${e}`);
			return;
		}
		let file = model && sln.getFileDetails(uri.fsPath, model);
		if (!file) {
			// file may be new or the model stale
			model = await sln.buildSolutionModel().catch(() => undefined);
			file = model && sln.getFileDetails(uri.fsPath, model);
		}
		if (!model || !file) {
			this.showError(`${path.basename(uri.fsPath)} is not part of any project in the workspace.`);
			return;
		}
		const project = sln.getExecutableProject(model, file);
		if (!project) {
			this.showError("No executable project (OutputType WinExe/Exe) found that hosts this file.");
			return;
		}
		return { file, project };
	}

	/** (Re)starts the previewer for the project, building it first when needed. */
	private async startSession(project: sm.Project, allowBuild = true): Promise<void> {
		const generation = ++this._generation;
		this.stopSession();
		clearTimeout(this._restartTimer);

		const problem = canStartPreviewer(project);
		if (problem && allowBuild && this.autoBuild) {
			await this.build(project); // restarts the session on success, shows the error otherwise
			return;
		}
		if (problem) {
			this._panel?.setState({ status: "error", message: problem, canBuild: true });
			return;
		}

		this._restarts++;
		this._lastXaml = undefined;
		this._panel?.setXaml({});
		this._diagnostics.clear();
		this._panel?.setState({ status: "starting", message: `Starting previewer for ${project.name}…` });
		const session = new PreviewSession(project);
		this._session = session;
		this.watchOutput(project);

		session.onDidChangeState((state) => {
			if (this._session !== session) {
				return;
			}
			if (state === "ready") {
				// remote / Codespaces / WSL: forward the previewer port to the machine running the UI (#131, #122, #53)
				vscode.env.asExternalUri(vscode.Uri.parse(session.htmlUrl!)).then((external) => {
					if (this._session === session && session.state === "ready") {
						this._panel?.setState({ status: "ready", message: `${project.name} · ${path.basename(this._file?.fsPath ?? "")}`, url: external.toString(true) });
					}
				});
			} else if (state === "exited") {
				this.showError(session.exitReason ?? "Previewer stopped.", session.recentOutput);
			}
		});
		session.onXamlResult((r) => this.onXamlResult(r));

		try {
			await session.start();
		} catch (e) {
			if (generation === this._generation) {
				this.showError("Failed to start the previewer.", `${e}`);
			}
			return;
		}
		if (generation !== this._generation) {
			return;
		}
		this.pushXaml();

		// the previewer must report the designer session in a reasonable time
		setTimeout(() => {
			if (this._session === session && session.state === "starting") {
				this.showError("Previewer did not respond.", session.recentOutput);
			}
		}, 60000);
	}

	private get autoBuild(): boolean {
		return vscode.workspace.getConfiguration("avalonia.previewer").get<boolean>("buildIfNeeded", true);
	}

	private stopSession() {
		this._session?.dispose();
		this._session = undefined;
		this.disposeWatchers();
	}

	/** Restart button / command. Re-parses the solution so project changes are picked up. */
	public async restart() {
		if (!this._file) {
			return this.show(undefined);
		}
		this._panel?.setState({ status: "starting", message: "Restarting previewer…" });
		await sln.buildSolutionModel().catch((e) => logger.error(`${e}`));
		this.stopSession();
		await this.setFile(this._file);
	}

	private async pushXaml() {
		const file = this._file;
		const session = this._session;
		if (!file || !session) {
			return;
		}
		const details = sln.getFileDetails(file.fsPath);
		if (!details) {
			return;
		}
		const doc = vscode.workspace.textDocuments.find((d) => samePath(d.uri.fsPath, file.fsPath));
		const text = doc ? doc.getText() : await fs.readFile(file.fsPath, "utf-8").catch(() => undefined);
		if (text !== undefined) {
			session.updateXaml(details, text);
		}
	}

	private onXamlResult(r: XamlResult) {
		this._lastXaml = r;
		const file = this._file;
		if (!file) {
			return;
		}
		const error = r.message ?? r.error;
		this._panel?.setXaml(error ? { error: (r.exceptionType ? `${r.exceptionType}: ` : "") + error, line: r.line } : {});
		if (!error) {
			this._diagnostics.delete(file);
			return;
		}
		const line = Math.max((r.line ?? 1) - 1, 0);
		const col = Math.max((r.column ?? 1) - 1, 0);
		const diag = new vscode.Diagnostic(new vscode.Range(line, col, line, col + 1), error, vscode.DiagnosticSeverity.Error);
		diag.source = "Avalonia Previewer";
		this._diagnostics.set(file, [diag]);
	}

	/**
	 * Builds the executable project and restarts the previewer.
	 * Thanks to the shadow copy the running previewer doesn't block the build.
	 */
	public async build(project?: sm.Project): Promise<boolean> {
		if (this._building) {
			return this._building;
		}
		if (!project) {
			const model = await sln.ensureSolutionModel().catch(() => undefined);
			const file = this._file && model ? sln.getFileDetails(this._file.fsPath, model) : undefined;
			project = model ? sln.getExecutableProject(model, file) : undefined;
		}
		if (!project) {
			vscode.window.showErrorMessage("No executable Avalonia project found to build.");
			return false;
		}
		const projectToBuild = project;
		this._building = this.runBuild(projectToBuild).finally(() => (this._building = undefined));
		return this._building;
	}

	private async runBuild(project: sm.Project): Promise<boolean> {
		this._panel?.setState({ status: "building", message: `Building ${project.name}…` });
		clearTimeout(this._restartTimer);

		const result = await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Window, title: `Avalonia: building ${project.name}` },
			() => dotnetBuild(project.path)
		);
		clearTimeout(this._restartTimer); // ignore watcher events caused by our own build

		if (!result.ok) {
			const msg = `Build failed for ${project.name}.`;
			this.showError(msg, result.errors || result.tail, true);
			vscode.window.showErrorMessage(msg, "Show Log").then((r) => r && logger.show(true));
			return false;
		}

		// re-parse: designer host path / output paths are only known after restore + build
		const model = await sln.buildSolutionModel().catch((e) => {
			this.showError("Failed to analyze the solution.", `${e}`);
			return undefined;
		});
		if (this._panel && this._file && model) {
			const file = sln.getFileDetails(this._file.fsPath, model);
			const exe = sln.getExecutableProject(model, file) ?? project;
			await this.startSession(exe, false);
		}
		return true;
	}

	/** Watches the build output so an external `dotnet build` refreshes the preview (#152, #179). */
	private watchOutput(project: sm.Project) {
		this.disposeWatchers();
		const dirs = new Set<string>([path.dirname(project.targetPath)]);
		const file = this._file && sln.getFileDetails(this._file.fsPath);
		if (file) {
			dirs.add(path.dirname(file.targetPath));
		}
		this._watchedDirs = [...dirs];
		for (const dir of dirs) {
			const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(dir), "*.dll"));
			const onChange = () => this.scheduleRestart();
			watcher.onDidChange(onChange);
			watcher.onDidCreate(onChange);
			this._outputWatchers.push(watcher);
		}
	}

	private scheduleRestart() {
		if (this._building || !this._panel) {
			return;
		}
		clearTimeout(this._restartTimer);
		this._restartTimer = setTimeout(async () => {
			if (this._building || !this._panel || !this._file) {
				return;
			}
			logger.info("Build output changed, restarting previewer.");
			const model = await sln.buildSolutionModel().catch(() => undefined);
			const file = model && sln.getFileDetails(this._file.fsPath, model);
			const exe = model && sln.getExecutableProject(model, file);
			if (exe) {
				await this.startSession(exe, false);
			}
		}, 1500);
	}

	private disposeWatchers() {
		this._outputWatchers.forEach((w) => w.dispose());
		this._outputWatchers = [];
		this._watchedDirs = [];
	}

	private showError(message: string, details?: string, canBuild = false) {
		logger.error(message + (details ? `\n${details}` : ""));
		this._panel?.setState({ status: "error", message, details, canBuild });
	}

	/** Internal state for diagnostics and end-to-end tests (command avalonia.debug.state). */
	public getDebugState() {
		return {
			panel: !!this._panel,
			file: this._file?.fsPath,
			panelState: this._panel?.state,
			sessionState: this._session?.state,
			project: this._session?.project.name,
			htmlUrl: this._session?.htmlUrl,
			sessionsStarted: this._restarts,
			lastXaml: this._lastXaml,
			building: !!this._building,
		};
	}

	public dispose() {
		clearTimeout(this._restartTimer);
		clearTimeout(this._editTimer);
		this.stopSession();
		this._panel?.dispose();
		this._disposables.forEach((d) => d.dispose());
	}
}

interface BuildResult {
	ok: boolean;
	errors: string;
	tail: string;
}

function dotnetBuild(projectPath: string): Promise<BuildResult> {
	return new Promise((resolve) => {
		logger.info(`dotnet build "${projectPath}"`);
		const lines: string[] = [];
		const errors = new Set<string>();
		const proc = spawn("dotnet", ["build", projectPath, "-nologo", "-v", "q", "-clp:NoSummary"], {
			cwd: path.dirname(projectPath),
			env: { ...process.env, DOTNET_CLI_UI_LANGUAGE: "en" },
		});
		const onData = (d: Buffer) => {
			for (const line of d.toString().split(/\r?\n/)) {
				if (!line.trim()) {
					continue;
				}
				logger.appendLine(line);
				lines.push(line);
				if (/\berror\b/i.test(line)) {
					errors.add(line.trim());
				}
			}
		};
		proc.stdout.on("data", onData);
		proc.stderr.on("data", onData);
		proc.on("error", (e) => resolve({ ok: false, errors: `Failed to run dotnet: ${e.message}`, tail: "" }));
		proc.on("close", (code) =>
			resolve({ ok: code === 0, errors: [...errors].slice(0, 10).join("\n"), tail: lines.slice(-10).join("\n") })
		);
	});
}
