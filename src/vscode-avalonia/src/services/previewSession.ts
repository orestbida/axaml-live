import * as vscode from "vscode";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import * as fs from "fs-extra";
import * as portfinder from "portfinder";
import { ChildProcess, spawn } from "child_process";

import * as sm from "../models/solutionModel";
import { Messages, MessageReader } from "./messageParser";
import { AppConstants, logger, samePath } from "../util/Utilities";
import { XamlResult, parseXamlError } from "./xamlError";


export type SessionState = "starting" | "ready" | "exited";

export { XamlResult } from "./xamlError";

/**
 * One running Avalonia designer host for an executable project.
 *
 * The build output is shadow-copied before the previewer is started, so the previewer never
 * locks the project's `bin` folder and `dotnet build` keeps working while previewing (#115).
 * The previewer is a disposable thing: on rebuild a new session is created and the old one disposed.
 */
export class PreviewSession implements vscode.Disposable {
	private _process: ChildProcess | undefined;
	private _server: net.Server | undefined;
	private _socket: net.Socket | undefined;
	private _shadowDir: string | undefined;
	private _disposed = false;
	private _sessionStarted = false;
	private _pending: { file: sm.File; text: string } | undefined;
	private readonly _log: string[] = [];

	private readonly _onDidChangeState = new vscode.EventEmitter<SessionState>();
	public readonly onDidChangeState = this._onDidChangeState.event;
	private readonly _onXamlResult = new vscode.EventEmitter<XamlResult>();
	public readonly onXamlResult = this._onXamlResult.event;

	public state: SessionState = "starting";
	public htmlUrl: string | undefined;
	public exitReason: string | undefined;

	constructor(public readonly project: sm.Project) {}

	/** Last lines of previewer output, used for error reporting. */
	public get recentOutput(): string {
		return this._log.slice(-15).join("\n");
	}

	public async start(): Promise<void> {
		const p = this.project;
		const outputDir = path.dirname(p.targetPath);

		this._shadowDir = await this.createShadowCopy(outputDir);
		const inShadow = (f: string) => (this._shadowDir ? path.join(this._shadowDir, path.basename(f)) : f);
		if (this._shadowDir) {
			await enableDesignTimeFeatures(inShadow(p.runtimeConfigFilePath));
		}

		this._server = net.createServer((socket) => this.onConnection(socket));
		await new Promise<void>((resolve, reject) => {
			this._server!.once("error", reject);
			this._server!.listen(0, AppConstants.localhost, () => resolve());
		});
		const bsonPort = (this._server.address() as net.AddressInfo).port;
		const httpPort = await portfinder.getPortPromise({ port: bsonPort + 1 });

		const args = [
			"exec",
			"--runtimeconfig",
			inShadow(p.runtimeConfigFilePath),
			"--depsfile",
			inShadow(p.depsFilePath),
			p.designerHostPath,
			"--method",
			"avalonia-remote",
			"--transport",
			`tcp-bson://${AppConstants.localhost}:${bsonPort}/`,
			"--method",
			"html",
			"--html-url",
			`http://${AppConstants.localhost}:${httpPort}`,
			inShadow(p.targetPath),
		];

		if (this._disposed) {
			return;
		}

		logger.info(`Starting previewer for ${p.name}: dotnet ${args.join(" ")}`);
		const proc = spawn("dotnet", args, { env: process.env, cwd: this._shadowDir ?? outputDir });
		this._process = proc;

		const collect = (data: Buffer) => {
			for (const line of data.toString().split(/\r?\n/)) {
				if (line.trim()) {
					this._log.push(line);
					logger.appendLine(`[previewer] ${line}`);
				}
			}
			if (this._log.length > 200) {
				this._log.splice(0, this._log.length - 200);
			}
		};
		proc.stdout?.on("data", collect);
		proc.stderr?.on("data", collect);
		proc.on("error", (e) => {
			this.exitReason = `Failed to start 'dotnet': ${e.message}`;
			this.setState("exited");
		});
		proc.on("exit", (code) => {
			logger.info(`Previewer process for ${p.name} exited with code ${code}`);
			this._process = undefined;
			if (!this._disposed) {
				this.exitReason ??= `Previewer process exited with code ${code}`;
				this.setState("exited");
			}
		});
	}

	public updateXaml(file: sm.File, text: string) {
		this._pending = { file, text };
		if (!this._sessionStarted || !this._socket || this._socket.destroyed) {
			return; // sent as soon as the designer session starts
		}
		const assemblyPath = this.mapAssembly(file.targetPath);
		const projectDir = path.dirname(file.projectPath);
		const relative = "/" + path.relative(projectDir, file.path).split(path.sep).join("/");
		this._socket.write(Messages.updateXamlMessage(assemblyPath, text, relative));
	}

	/** Maps an assembly from the project output to its shadow copy. */
	private mapAssembly(assemblyPath: string): string {
		if (this._shadowDir) {
			const candidate = path.join(this._shadowDir, path.basename(assemblyPath));
			if (fs.existsSync(candidate)) {
				return candidate;
			}
		}
		return assemblyPath;
	}

	private onConnection(socket: net.Socket) {
		if (this._socket && !this._socket.destroyed) {
			this._socket.destroy();
		}
		this._socket = socket;
		const reader = new MessageReader();

		socket.on("data", (chunk) => {
			for (const msg of reader.push(chunk)) {
				this.onMessage(socket, msg.type, msg.body);
			}
		});
		socket.on("error", (e) => logger.warn(`Previewer socket error: ${e.message}`));
		socket.on("close", () => {
			if (this._socket === socket) {
				this._socket = undefined;
				this._sessionStarted = false;
			}
		});
	}

	private onMessage(socket: net.Socket, type: string, body: any) {
		switch (type) {
			case Messages.htmlTransportStarted:
				this.htmlUrl = body.Uri ?? body.uri;
				this.checkReady();
				break;
			case Messages.startDesignerSession:
				socket.write(Messages.clientSupportedPixelFormatsMessage());
				this._sessionStarted = true;
				if (this._pending) {
					this.updateXaml(this._pending.file, this._pending.text);
				}
				this.checkReady();
				break;
			case Messages.updateXamlResult: {
				const ex = body.Exception ?? body.exception;
				const error: string | undefined = body.Error ?? body.error ?? undefined;
				const result: XamlResult = {
					error,
					exceptionType: ex?.ExceptionType ?? undefined,
					message: ex?.Message ?? undefined,
					line: ex?.LineNumber ?? undefined,
					column: ex?.LinePosition ?? undefined,
				};
				// line info is often only embedded in the (aggregate) message text
				const text = result.message ?? error;
				if (text && result.line === undefined) {
					const parsed = parseXamlError(result.exceptionType ? `${result.exceptionType}: ${text}` : text);
					result.message = parsed.message;
					result.line = parsed.line;
					result.column = parsed.column;
					if (result.exceptionType && /AggregateException$/.test(result.exceptionType)) {
						result.exceptionType = undefined;
					}
				}
				this._onXamlResult.fire(result);
				break;
			}
		}
	}

	private checkReady() {
		if (this.state === "starting" && this.htmlUrl && this._sessionStarted) {
			this.setState("ready");
		}
	}

	private setState(state: SessionState) {
		if (this.state === state) {
			return;
		}
		this.state = state;
		this._onDidChangeState.fire(state);
	}

	/**
	 * Copies the build output to a temp folder. The large `runtimes` folder (native libs for
	 * every platform) is linked instead of copied: native files are only rewritten when they change.
	 */
	private async createShadowCopy(outputDir: string): Promise<string | undefined> {
		const hash = crypto.createHash("sha1").update(outputDir.toLowerCase()).digest("hex").substring(0, 10);
		const root = path.join(os.tmpdir(), "avalonia-previewer", hash);
		await cleanupShadowCopies(root);

		const dir = path.join(root, `${Date.now()}`);
		try {
			await fs.ensureDir(dir);
			for (const entry of await fs.readdir(outputDir, { withFileTypes: true })) {
				const src = path.join(outputDir, entry.name);
				const dst = path.join(dir, entry.name);
				if (entry.isDirectory() && entry.name === "runtimes") {
					await fs.symlink(src, dst, process.platform === "win32" ? "junction" : "dir");
				} else {
					await fs.copy(src, dst, { dereference: true });
				}
			}
			return dir;
		} catch (e) {
			logger.warn(`Shadow copy failed, previewing from the build output directly: ${e}`);
			await fs.remove(dir).catch(() => undefined);
			return undefined;
		}
	}

	public dispose() {
		if (this._disposed) {
			return;
		}
		this._disposed = true;
		this._socket?.destroy();
		this._server?.close();

		const shadow = this._shadowDir;
		const removeShadow = () => {
			if (shadow) {
				removeShadowDir(shadow).catch(() => undefined);
			}
		};

		// synchronous kill: must also work while VS Code is shutting down
		const proc = this._process;
		if (proc && proc.exitCode === null) {
			proc.once("exit", () => setTimeout(removeShadow, 300));
			proc.kill("SIGKILL");
		} else {
			removeShadow();
		}
		this._onDidChangeState.dispose();
		this._onXamlResult.dispose();
	}
}

/**
 * Projects with PublishAot / PublishTrimmed / IsAotCompatible get runtime feature switches
 * (e.g. IsDynamicCodeSupported=false) that break the designer's runtime XAML loader:
 * "Dynamic code generation is not supported on this platform" (#151).
 * The previewer runs from the shadow copy, so the switches are removed there; the project output is untouched.
 */
async function enableDesignTimeFeatures(runtimeConfigPath: string) {
	try {
		const config = await fs.readJson(runtimeConfigPath);
		const props = config?.runtimeOptions?.configProperties;
		if (!props) {
			return;
		}
		let changed = false;
		for (const [key, value] of Object.entries(props)) {
			if (value === false && /\.(IsSupported|IsDynamicCodeSupported|CanEmitObjectArrayDelegate|IsReflectionEnabledByDefault)$/.test(key)) {
				delete props[key];
				changed = true;
			}
		}
		if (changed) {
			await fs.writeJson(runtimeConfigPath, config, { spaces: 2 });
			logger.info("Trimming/AOT feature switches disabled for the previewer (shadow copy only).");
		}
	} catch (e) {
		logger.warn(`Could not adjust ${runtimeConfigPath}: ${e}`);
	}
}

/** Removes a shadow dir. The `runtimes` link is unlinked first so its target is never touched. */
async function removeShadowDir(dir: string) {
	const link = path.join(dir, "runtimes");
	try {
		const st = await fs.lstat(link);
		if (st.isSymbolicLink()) {
			await fs.unlink(link);
		}
	} catch {
		/* not present */
	}
	await fs.remove(dir);
}

/** Deletes stale shadow copies (from crashed or previous VS Code sessions). Locked ones are skipped. */
async function cleanupShadowCopies(root: string) {
	if (!(await fs.pathExists(root))) {
		return;
	}
	for (const name of await fs.readdir(root)) {
		await removeShadowDir(path.join(root, name)).catch(() => undefined);
	}
}

export function canStartPreviewer(p: sm.Project | undefined): string | undefined {
	if (!p) {
		return "No executable Avalonia project found in the workspace.";
	}
	const missing = [
		["designer host (Avalonia package not restored?)", p.designerHostPath],
		["assembly", p.targetPath],
		["runtimeconfig.json", p.runtimeConfigFilePath],
		["deps.json", p.depsFilePath],
	].filter(([, f]) => !f || !fs.existsSync(f));
	return missing.length ? `Missing ${missing.map(([n]) => n).join(", ")}. Build the project.` : undefined;
}

export function isSameProject(a: sm.Project | undefined, b: sm.Project | undefined) {
	return !!a && !!b && samePath(a.path, b.path);
}
