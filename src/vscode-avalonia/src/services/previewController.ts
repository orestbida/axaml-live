import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs-extra";
import { spawn } from "child_process";

import * as sm from "../models/solutionModel";
import * as sln from "./solutionParser";
import { PreviewSession, PreviewFrame, canStartPreviewer, isSameProject, XamlResult } from "./previewSession";
import { PanelOptions, WebPreviewerPanel } from "../panels/WebPreviwerPanel";
import { AppConstants, isAvaloniaFile, logger, samePath } from "../util/Utilities";
import { Messages, mapKey } from "./messageParser";
import { averageLuminance } from "./frameStats";
import { applyDesignSize, applyThemeVariant } from "../xaml/designTransforms";
import { formFactors, resolveFormFactor } from "../xaml/formFactors";

interface ViewInfo {
	zoom: number;
	zoomMode: number | string;
	renderScale: number;
	stageWidth: number;
	stageHeight: number;
}

interface FrameInfo {
	width: number;
	height: number;
	scale: number;
	logicalWidth: number;
	logicalHeight: number;
	avgLum: number;
}

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

	// previewer view options (toolbar) and rendering statistics
	private _theme: string;
	private _formFactor: string;
	private _rotated: boolean;
	private _inputEnabled: boolean;
	private _view: ViewInfo | undefined;
	private _frames = 0;
	private _frameTimes: number[] = [];
	private _frameInfo: FrameInfo | undefined;
	private _lastFrameData: Buffer | undefined;
	private _inputsForwarded = 0;

	constructor(private readonly _context: vscode.ExtensionContext) {
		const config = this.config;
		this._theme = config.get<string>("defaultThemeVariant", "Default");
		this._formFactor = config.get<string>("defaultFormFactor", "default");
		this._rotated = config.get<boolean>("defaultFormFactorRotated", false);
		this._inputEnabled = config.get<boolean>("enableInput", true);
		this._disposables.push(
			this._diagnostics,
			vscode.window.onDidChangeActiveTextEditor((e) => {
				if (e && isAvaloniaFile(e.document)) {
					if (this._panel) {
						this.setFile(e.document.uri);
					} else if (this.config.get<boolean>("autoOpen", false)) {
						this.show(e.document.uri);
					}
				}
			}),
			vscode.workspace.onDidChangeTextDocument((e) => {
				if (this._file && samePath(e.document.uri.fsPath, this._file.fsPath) && e.contentChanges.length) {
					clearTimeout(this._editTimer);
					this._editTimer = setTimeout(() => this.pushXaml(), this.editDelay);
				}
			}),
			vscode.workspace.onDidChangeConfiguration((e) => {
				const hostChanged =
					e.affectsConfiguration("avalonia.previewer.hostProject") ||
					e.affectsConfiguration("avalonia.previewer.syncWithLaunchConfig") ||
					(this.config.get<boolean>("syncWithLaunchConfig", false) && e.affectsConfiguration("launch"));
				if (this._panel && hostChanged) {
					this.restart();
				}
				if (e.affectsConfiguration("avalonia.previewer.fpsLimit")) {
					this._session?.setFpsLimit(this.fpsLimit);
				}
				if (e.affectsConfiguration("avalonia.previewer.maxRenderScale")) {
					this._panel?.setOptions(this.panelOptions);
				}
			}),
			vscode.workspace.onDidSaveTextDocument((doc) => {
				if (this._file && samePath(doc.uri.fsPath, this._file.fsPath)) {
					this.pushXaml();
				}
			})
		);
	}

	private get config() {
		return vscode.workspace.getConfiguration("avalonia.previewer");
	}

	private get editDelay(): number {
		return this.config.get<number>("updateDelay", 300);
	}

	private get fpsLimit(): number {
		return Math.max(0, this.config.get<number>("fpsLimit", 60));
	}

	private get panelOptions(): PanelOptions {
		return {
			theme: this._theme,
			formFactor: this._formFactor,
			rotated: this._rotated,
			inputEnabled: this._inputEnabled,
			maxRenderScale: Math.max(1, this.config.get<number>("maxRenderScale", 3)),
		};
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
			this._panel = new WebPreviewerPanel(this._context.extensionUri, column, this.panelOptions);
			this._panel.onDidDispose(() => this.onPanelClosed());
			this._panel.onMessage((msg) => this.onPanelMessage(msg));
		} else {
			this._panel.reveal();
		}
		await this.setFile(uri);
	}

	/** Messages from the preview webview (also used by tests through avalonia.debug.previewCommand). */
	public onPanelMessage(msg: any) {
		switch (msg?.type) {
			case "restart":
				this.restart();
				break;
			case "build":
				this.build();
				break;
			case "selectHost":
				vscode.commands.executeCommand(AppConstants.selectHostCommand);
				break;
			case "showLog":
				logger.show(true);
				break;
			case "zoom":
				this._panel?.setZoom(msg.zoom);
				break;
			case "view":
				this._view = msg;
				this._session?.setRenderScale(msg.renderScale);
				break;
			case "setTheme":
				this._theme = ["Light", "Dark"].includes(msg.value) ? msg.value : "Default";
				this.optionsChanged();
				break;
			case "setFormFactor":
				this._formFactor = formFactors.some((f) => f.id === msg.id) ? msg.id : "default";
				this._rotated = !!msg.rotated;
				this.optionsChanged();
				break;
			case "setInput":
				this._inputEnabled = !!msg.enabled;
				this._panel?.setOptions(this.panelOptions);
				break;
			case "input":
				this.forwardInput(msg);
				break;
		}
	}

	private _optionsTimer: NodeJS.Timeout | undefined;
	private _watchdog: NodeJS.Timeout | undefined;

	/** Toolbar changes in quick succession result in one XAML update (each update opens a new design window). */
	private optionsChanged() {
		this._panel?.setOptions(this.panelOptions);
		clearTimeout(this._optionsTimer);
		this._optionsTimer = setTimeout(() => this.pushXaml(), 50);
	}

	/**
	 * If an update produces neither a frame nor a result, send it once more. Back-to-back updates can leave the
	 * designer's new window waiting for a frame acknowledgement that belonged to the previous window.
	 */
	private armWatchdog(framesAtPush: number, retry: boolean) {
		clearTimeout(this._watchdog);
		const resultAtPush = this._lastXaml;
		this._watchdog = setTimeout(() => {
			if (this._frames === framesAtPush && this._lastXaml === resultAtPush && this._session?.state === "ready" && retry) {
				logger.debug("No frame after XAML update, sending it again.");
				this.pushXaml(false);
			}
		}, 4000);
	}

	private forwardInput(msg: any) {
		if (!this._inputEnabled || !this._session) {
			return;
		}
		const mods: number[] = Array.isArray(msg.modifiers) ? msg.modifiers : [];
		let message: Buffer | undefined;
		switch (msg.kind) {
			case "pointerMoved":
				message = Messages.pointerMovedMessage(msg.x, msg.y, mods);
				break;
			case "pointerPressed":
				message = Messages.pointerPressedMessage(msg.x, msg.y, msg.button ?? 1, mods);
				break;
			case "pointerReleased":
				message = Messages.pointerReleasedMessage(msg.x, msg.y, msg.button ?? 1, mods);
				break;
			case "scroll":
				message = Messages.scrollMessage(msg.x, msg.y, msg.deltaX ?? 0, msg.deltaY ?? 0, mods);
				break;
			case "key":
				message = Messages.keyMessage(!!msg.isDown, mapKey(String(msg.key ?? "")), msg.key, mods);
				break;
			case "text":
				message = Messages.textInputMessage(String(msg.text ?? ""), mods);
				break;
		}
		if (message && this._session.sendInput(message)) {
			this._inputsForwarded++;
		}
	}

	private onFrame(frame: PreviewFrame) {
		this._frames++;
		logger.debug(`Frame ${frame.sequenceId} ${frame.width}x${frame.height} scale=${frame.scale}`);
		const now = Date.now();
		this._frameTimes.push(now);
		while (this._frameTimes.length && now - this._frameTimes[0] > 2000) {
			this._frameTimes.shift();
		}
		this._lastFrameData = frame.data; // statistics are computed on demand, not per frame
		this._frameInfo = {
			width: frame.width,
			height: frame.height,
			scale: frame.scale,
			logicalWidth: Math.round(frame.width / frame.scale),
			logicalHeight: Math.round(frame.height / frame.scale),
			avgLum: -1,
		};
		this._panel?.showFrame({
			width: frame.width,
			height: frame.height,
			stride: frame.stride,
			scale: frame.scale,
			data: new Uint8Array(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength),
		});
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
		if (!fs.existsSync(target.file.targetPath) && this.autoBuild && !this._building) {
			// the file's own assembly (e.g. a plugin library the host doesn't reference) was never built
			this.stopSession();
			await this.build(target.project);
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
		const session = new PreviewSession(project, this.fpsLimit, this._view?.renderScale ?? 1);
		this._session = session;
		this.watchOutput(project);

		session.onFrame((f) => this._session === session && this.onFrame(f));
		session.onDidChangeState((state) => {
			if (this._session !== session) {
				return;
			}
			if (state === "ready") {
				// frames travel through the extension host, so this also works remotely (SSH, WSL, Codespaces)
				this._panel?.setState({ status: "ready", message: `${project.name} · ${path.basename(this._file?.fsPath ?? "")}` });
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

	private async pushXaml(retryIfStuck = true) {
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
		let text = doc ? doc.getText() : await fs.readFile(file.fsPath, "utf-8").catch(() => undefined);
		if (text === undefined) {
			return;
		}
		// previewer options are applied to the XAML sent to the designer only, never to the document
		text = applyThemeVariant(text, this._theme);
		const size = resolveFormFactor(this._formFactor, this._rotated);
		if (size) {
			text = applyDesignSize(text, size.width, size.height);
		}
		logger.debug(`UpdateXaml ${path.basename(file.fsPath)} theme=${this._theme} size=${size ? `${size.width}x${size.height}` : "design"}`);
		session.updateXaml(details, text);
		this.armWatchdog(this._frames, retryIfStuck);
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

		// a library that the host does not reference (plugin, #207) is not built by building the host
		const current = sln.getSolutionModel();
		const fileInfo = this._file && current ? sln.getFileDetails(this._file.fsPath, current) : undefined;
		const targets = [project.path];
		if (current && fileInfo && !samePath(fileInfo.projectPath, project.path) && !sln.isProjectReferencedBy(current, project, fileInfo.projectPath)) {
			targets.unshift(fileInfo.projectPath);
		}

		let result: BuildResult = { ok: true, errors: "", tail: "" };
		for (const target of targets) {
			result = await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Window, title: `Avalonia: building ${path.basename(target)}` },
				() => dotnetBuild(target)
			);
			if (!result.ok) {
				break;
			}
		}
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

	/** The host project for the current file and how it was chosen (avalonia.debug.hostInfo). */
	public async getHostInfo() {
		const model = await sln.ensureSolutionModel().catch(() => undefined);
		const file = model && this._file ? sln.getFileDetails(this._file.fsPath, model) : undefined;
		const project = model ? sln.getExecutableProject(model, file) : undefined;
		return project ? { name: project.name, targetPath: project.targetPath, source: sln.lastHostSource } : undefined;
	}

	/** Internal state for diagnostics and end-to-end tests (command avalonia.debug.state). */
	public getDebugState() {
		return {
			panel: !!this._panel,
			file: this._file?.fsPath,
			panelState: this._panel?.state,
			sessionState: this._session?.state,
			project: this._session?.project.name,
			previewerPid: this._session?.pid,
			sessionsStarted: this._restarts,
			lastXaml: this._lastXaml,
			building: !!this._building,
			preview: {
				frames: this._frames,
				frame: this._frameInfo && {
					...this._frameInfo,
					avgLum: this._lastFrameData ? Math.round(averageLuminance(this._lastFrameData) * 10) / 10 : -1,
				},
				zoom: this._view?.zoom,
				stage: this._view ? { width: this._view.stageWidth, height: this._view.stageHeight } : undefined,
				theme: this._theme,
				formFactor: this._formFactor,
				rotated: this._rotated,
				inputEnabled: this._inputEnabled,
				inputsForwarded: this._inputsForwarded,
				fpsLimit: this.fpsLimit,
				recentFps: this._frameTimes.length / 2,
			},
		};
	}

	public dispose() {
		clearTimeout(this._restartTimer);
		clearTimeout(this._editTimer);
		clearTimeout(this._optionsTimer);
		clearTimeout(this._watchdog);
		this.stopSession();
		this._panel?.dispose();
		this._disposables.forEach((d) => d.dispose());
	}
}

export interface BuildResult {
	ok: boolean;
	errors: string;
	tail: string;
}

export function dotnetBuild(projectPath: string): Promise<BuildResult> {
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
