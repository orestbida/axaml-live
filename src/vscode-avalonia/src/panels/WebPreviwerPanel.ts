import * as vscode from "vscode";
import path = require("path");
import { AppConstants } from "../util/Utilities";
import { getNonce } from "../util/getNouce";

export type PanelStatus = "idle" | "starting" | "building" | "ready" | "error";

export interface PanelState {
	status: PanelStatus;
	message?: string;
	details?: string;
	url?: string;
	canBuild?: boolean;
}

export interface XamlState {
	error?: string;
	line?: number;
}

/**
 * The previewer webview. It only displays state pushed by the PreviewController.
 * The webview can be reloaded by VS Code at any time (moving it between groups, etc.);
 * it then sends `ready` and the last state is re-sent, so no restart is needed (#87).
 */
export class WebPreviewerPanel implements vscode.Disposable {
	private readonly _panel: vscode.WebviewPanel;
	private readonly _disposables: vscode.Disposable[] = [];
	private _state: PanelState = { status: "idle" };
	private _xaml: XamlState = {};

	private readonly _onDidDispose = new vscode.EventEmitter<void>();
	public readonly onDidDispose = this._onDidDispose.event;
	private readonly _onCommand = new vscode.EventEmitter<string>();
	public readonly onCommand = this._onCommand.event;

	constructor(extensionUri: vscode.Uri, column: vscode.ViewColumn) {
		this._panel = vscode.window.createWebviewPanel(
			AppConstants.previewerPanelViewType,
			"Preview",
			{ viewColumn: column, preserveFocus: true },
			{ enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] }
		);
		this._panel.iconPath = {
			dark: vscode.Uri.joinPath(extensionUri, "media", "preview-dark.svg"),
			light: vscode.Uri.joinPath(extensionUri, "media", "preview-light.svg"),
		};
		this._panel.webview.html = this.getHtml();
		this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
		this._panel.webview.onDidReceiveMessage(
			(msg) => {
				if (msg?.type === "ready") {
					this.post();
				} else if (typeof msg?.type === "string") {
					this._onCommand.fire(msg.type);
				}
			},
			null,
			this._disposables
		);
	}

	public reveal(column?: vscode.ViewColumn) {
		this._panel.reveal(column, true);
	}

	public get state(): PanelState {
		return this._state;
	}

	public get visible() {
		return this._panel.visible;
	}

	public setTitle(file: vscode.Uri) {
		this._panel.title = `Preview ${path.basename(file.fsPath)}`;
	}

	public setState(state: PanelState) {
		// keep the last URL so the old frame stays visible under the overlay while restarting
		this._state = { ...state, url: state.url ?? this._state.url };
		this.post();
	}

	public setXaml(xaml: XamlState) {
		this._xaml = xaml;
		this.post();
	}

	private post() {
		this._panel.webview.postMessage({ type: "state", state: this._state, xaml: this._xaml });
	}

	public dispose() {
		this._onDidDispose.fire();
		this._panel.dispose();
		while (this._disposables.length) {
			this._disposables.pop()?.dispose();
		}
		this._onDidDispose.dispose();
		this._onCommand.dispose();
	}

	private getHtml() {
		const nonce = getNonce();
		const defaultZoom = Number(vscode.workspace.getConfiguration("avalonia.previewer").get<number>("defaultZoom", 1)) || 1;
		return /* html */ `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src http: https:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
	html, body { height: 100%; margin: 0; padding: 0; overflow: hidden; }
	body { display: flex; flex-direction: column; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); }
	.toolbar { display: flex; align-items: center; gap: 6px; padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-editor-background); flex: none; }
	.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--vscode-disabledForeground); flex: none; }
	.dot.ready { background: var(--vscode-testing-iconPassed, #3fb950); }
	.dot.starting, .dot.building { background: var(--vscode-editorWarning-foreground, #d29922); animation: pulse 1s infinite alternate; }
	.dot.error { background: var(--vscode-editorError-foreground, #f85149); }
	@keyframes pulse { from { opacity: 1; } to { opacity: .3; } }
	.status { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; opacity: .85; }
	button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; padding: 3px 10px; cursor: pointer; border-radius: 2px; font: inherit; }
	button:hover { background: var(--vscode-button-secondaryHoverBackground); }
	button:disabled { opacity: .5; cursor: default; }
	.stage { position: relative; flex: 1; min-height: 0;
		background-size: 15px 15px;
		background-image: linear-gradient(to right, var(--vscode-editorIndentGuide-background, rgba(128,128,128,.15)) 1px, transparent 1px), linear-gradient(to bottom, var(--vscode-editorIndentGuide-background, rgba(128,128,128,.15)) 1px, transparent 1px); }
	.stage { overflow: hidden; }
	iframe { width: 100%; height: 100%; border: 0; display: block; transform-origin: 0 0; }
	.zoom { min-width: 3.5em; text-align: center; opacity: .85; cursor: pointer; }
	.sep { width: 1px; align-self: stretch; background: var(--vscode-panel-border); margin: 0 2px; }
	.overlay { position: absolute; inset: 0; display: none; align-items: center; justify-content: center; flex-direction: column; gap: 10px; background: color-mix(in srgb, var(--vscode-editor-background) 80%, transparent); text-align: center; padding: 16px; }
	.overlay.show { display: flex; }
	.overlay pre { max-width: 90%; max-height: 50%; overflow: auto; text-align: left; font-family: var(--vscode-editor-font-family); font-size: 12px; background: var(--vscode-textCodeBlock-background); padding: 8px; white-space: pre-wrap; }
	.xaml-error { display: none; flex: none; padding: 6px 8px; font-family: var(--vscode-editor-font-family); font-size: 12px; white-space: pre-wrap; background: var(--vscode-inputValidation-errorBackground); border-top: 1px solid var(--vscode-inputValidation-errorBorder); max-height: 30%; overflow: auto; }
	.xaml-error.show { display: block; }
</style>
</head>
<body>
	<div class="toolbar">
		<span id="dot" class="dot"></span>
		<span id="status" class="status">Waiting…</span>
		<button id="zoomOut" title="Zoom out (Ctrl+Wheel)">−</button>
		<span id="zoom" class="zoom" title="Reset zoom">100%</span>
		<button id="zoomIn" title="Zoom in (Ctrl+Wheel)">+</button>
		<span class="sep"></span>
		<button id="restart" title="Restart the previewer process">Restart</button>
		<button id="build" title="Build the project and reload the preview">Build</button>
		<button id="log" title="Show the Avalonia output log">Log</button>
	</div>
	<div class="stage">
		<iframe id="frame"></iframe>
		<div id="overlay" class="overlay"><div id="overlayText"></div><pre id="overlayDetails" style="display:none"></pre><button id="overlayBuild" style="display:none">Build project</button></div>
	</div>
	<div id="xamlError" class="xaml-error"></div>
<script nonce="${nonce}">
	const vscode = acquireVsCodeApi();
	const $ = (id) => document.getElementById(id);
	const send = (type) => vscode.postMessage({ type });
	$("restart").onclick = () => send("restart");
	$("build").onclick = () => send("build");
	$("overlayBuild").onclick = () => send("build");
	$("log").onclick = () => send("showLog");

	// zoom: scales the previewer frame; mouse input still maps correctly through the transform
	const levels = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.25, 1.5, 2, 3, 4];
	let zoom = (vscode.getState() || {}).zoom || ${defaultZoom};
	function applyZoom(z) {
		zoom = Math.min(4, Math.max(0.25, z));
		const f = $("frame");
		f.style.transform = "scale(" + zoom + ")";
		f.style.width = (100 / zoom) + "%";
		f.style.height = (100 / zoom) + "%";
		$("zoom").textContent = Math.round(zoom * 100) + "%";
		vscode.setState({ zoom });
	}
	const step = (dir) => {
		const i = levels.findIndex((l) => l >= zoom - 0.001);
		applyZoom(levels[Math.min(levels.length - 1, Math.max(0, (i < 0 ? levels.length - 1 : i) + dir))]);
	};
	$("zoomIn").onclick = () => step(1);
	$("zoomOut").onclick = () => step(-1);
	$("zoom").onclick = () => applyZoom(1);
	document.querySelector(".stage").addEventListener("wheel", (e) => {
		if (e.ctrlKey) { e.preventDefault(); step(e.deltaY < 0 ? 1 : -1); }
	}, { passive: false });
	applyZoom(zoom);

	window.addEventListener("message", (e) => {
		const { state, xaml } = e.data;
		if (e.data.type !== "state") return;
		$("dot").className = "dot " + state.status;
		$("status").textContent = state.message || state.status;
		$("build").disabled = state.status === "building";

		if (state.url && $("frame").dataset.url !== state.url && state.status === "ready") {
			$("frame").dataset.url = state.url;
			$("frame").src = state.url;
		}
		const showOverlay = state.status !== "ready";
		$("overlay").className = "overlay" + (showOverlay ? " show" : "");
		$("overlayText").textContent = state.message || "";
		$("overlayDetails").style.display = state.details ? "block" : "none";
		$("overlayDetails").textContent = state.details || "";
		$("overlayBuild").style.display = state.canBuild ? "inline-block" : "none";

		const err = xaml && xaml.error;
		$("xamlError").className = "xaml-error" + (err && state.status === "ready" ? " show" : "");
		$("xamlError").textContent = err ? (xaml.line ? "Line " + xaml.line + ": " : "") + err : "";
	});
	send("ready");
</script>
</body>
</html>`;
	}
}
