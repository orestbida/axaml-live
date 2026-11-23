import * as vscode from "vscode";
import path = require("path");
import { AppConstants } from "../util/Utilities";
import { getNonce } from "../util/getNouce";
import { formFactors } from "../xaml/formFactors";

export type PanelStatus = "idle" | "starting" | "building" | "ready" | "error";

export interface PanelState {
	status: PanelStatus;
	message?: string;
	details?: string;
	canBuild?: boolean;
}

export interface XamlState {
	error?: string;
	line?: number;
}

export interface PanelOptions {
	theme: string;
	formFactor: string;
	rotated: boolean;
	inputEnabled: boolean;
	maxRenderScale: number;
}

export interface FrameMessage {
	width: number;
	height: number;
	stride: number;
	scale: number;
	data: Uint8Array;
}

/**
 * The previewer webview: draws frames sent by the designer on a canvas, shows state and errors,
 * owns zoom (incl. Fit All / Fit Width) and forwards toolbar actions and input to the controller.
 * VS Code may reload the webview at any time; it then sends `ready` and everything is re-sent.
 */
export class WebPreviewerPanel implements vscode.Disposable {
	private readonly _panel: vscode.WebviewPanel;
	private readonly _disposables: vscode.Disposable[] = [];
	private _state: PanelState = { status: "idle" };
	private _xaml: XamlState = {};
	private _options: PanelOptions;
	private _lastFrame: FrameMessage | undefined;
	private _frameInFlight = 0; // time the frame being drawn was posted, 0 = none
	private _frameWaiting = false;

	private readonly _onDidDispose = new vscode.EventEmitter<void>();
	public readonly onDidDispose = this._onDidDispose.event;
	private readonly _onMessage = new vscode.EventEmitter<any>();
	/** Messages from the webview (toolbar commands, view changes, input). */
	public readonly onMessage = this._onMessage.event;

	constructor(private readonly _extensionUri: vscode.Uri, column: vscode.ViewColumn, options: PanelOptions) {
		this._options = options;
		this._panel = vscode.window.createWebviewPanel(
			AppConstants.previewerPanelViewType,
			"Preview",
			{ viewColumn: column, preserveFocus: true },
			{ enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(_extensionUri, "media"), vscode.Uri.joinPath(_extensionUri, "node_modules", "@vscode", "codicons", "dist")] }
		);
		this._panel.iconPath = {
			dark: vscode.Uri.joinPath(_extensionUri, "media", "preview-dark.svg"),
			light: vscode.Uri.joinPath(_extensionUri, "media", "preview-light.svg"),
		};
		this._panel.webview.html = this.getHtml();
		this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
		this._panel.webview.onDidReceiveMessage(
			(msg) => {
				if (msg?.type === "ready") {
					this.postAll();
				} else if (msg?.type === "frameDrawn") {
					this.onFrameDrawn();
				} else if (typeof msg?.type === "string") {
					this._onMessage.fire(msg);
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
		this._state = state;
		this.postState();
	}

	public setXaml(xaml: XamlState) {
		this._xaml = xaml;
		this.postState();
	}

	public setOptions(options: PanelOptions) {
		this._options = options;
		this._panel.webview.postMessage({ type: "options", options });
	}

	/**
	 * Frames are megabytes: one is in flight to the webview at a time and only the newest waits, so a slow or hidden
	 * webview never queues up stale frames (the designer keeps rendering, see PreviewSession.acceptFrame).
	 */
	public showFrame(frame: FrameMessage) {
		this._lastFrame = frame;
		if (this._frameInFlight && Date.now() - this._frameInFlight < 1000) {
			this._frameWaiting = true;
			return;
		}
		this.postFrame(frame);
	}

	private postFrame(frame: FrameMessage) {
		this._frameInFlight = Date.now();
		this._frameWaiting = false;
		this._panel.webview.postMessage({ type: "frame", frame });
	}

	private onFrameDrawn() {
		this._frameInFlight = 0;
		if (this._frameWaiting && this._lastFrame) {
			this.postFrame(this._lastFrame);
		}
	}

	/** zoom: a factor, "fitAll" or "fitWidth"; applied by the webview, which reports back with a "view" message. */
	public setZoom(zoom: number | string) {
		this._panel.webview.postMessage({ type: "setZoom", zoom });
	}

	private postState() {
		this._panel.webview.postMessage({ type: "state", state: this._state, xaml: this._xaml });
	}

	private postAll() {
		this.setOptions(this._options);
		this.postState();
		if (this._lastFrame) {
			this.postFrame(this._lastFrame);
		}
	}

	public dispose() {
		this._onDidDispose.fire();
		this._panel.dispose();
		while (this._disposables.length) {
			this._disposables.pop()?.dispose();
		}
		this._onDidDispose.dispose();
		this._onMessage.dispose();
	}

	private getHtml() {
		const webview = this._panel.webview;
		const nonce = getNonce();
		const codicons = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, "node_modules", "@vscode", "codicons", "dist", "codicon.css"));
		const media = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, "media", f));
		const config = vscode.workspace.getConfiguration("avalonia.previewer");
		const init = {
			defaultZoom: config.get<number | string>("defaultZoom", 1),
			formFactors: formFactors.map((f) => ({ id: f.id, label: f.label, size: f.width ? `${f.width}×${f.height}` : "d:DesignWidth/Height" })),
		};
		return /* html */ `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${codicons}">
<link rel="stylesheet" href="${media("previewer.css")}">
</head>
<body>
	<div class="toolbar" role="toolbar">
		<span id="dot" class="dot"></span>
		<span id="status" class="status" title="Click to choose the project that hosts the previewer">Waiting…</span>
		<div class="group">
			<button id="zoomOut" class="action codicon codicon-zoom-out" title="Zoom out (Ctrl+Wheel)"></button>
			<span class="select"><select id="zoom" title="Zoom"></select></span>
			<button id="zoomIn" class="action codicon codicon-zoom-in" title="Zoom in (Ctrl+Wheel)"></button>
		</div>
		<span class="sep"></span>
		<div class="group">
			<span class="select"><select id="theme" title="Theme variant"><option value="Default">App theme</option><option value="Light">Light</option><option value="Dark">Dark</option></select></span>
			<span class="select"><select id="formFactor" title="Form factor"></select></span>
			<button id="rotate" class="action codicon codicon-arrow-swap" title="Rotate"></button>
			<button id="input" class="action codicon codicon-inspect" title="Mouse and keyboard input to the preview" aria-pressed="true"></button>
		</div>
		<span class="sep"></span>
		<div class="group">
			<button id="restart" class="action codicon codicon-debug-restart" title="Restart the previewer"></button>
			<button id="build" class="action codicon codicon-tools" title="Build the project and reload the preview"></button>
			<button id="log" class="action codicon codicon-output" title="Show the Avalonia output log"></button>
		</div>
	</div>
	<div id="stage" class="stage">
		<div id="frameBox" class="frame-box"><canvas id="canvas" tabindex="0"></canvas></div>
		<div id="overlay" class="overlay"><div id="overlayText"></div><pre id="overlayDetails" style="display:none"></pre><button id="overlayBuild" style="display:none">Build project</button></div>
	</div>
	<div id="xamlError" class="xaml-error"></div>
	<script nonce="${nonce}">window.previewerInit = ${JSON.stringify(init)};</script>
	<script nonce="${nonce}" src="${media("previewer.js")}"></script>
</body>
</html>`;
	}
}
