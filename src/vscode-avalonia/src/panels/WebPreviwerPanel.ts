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
			{ enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(_extensionUri, "media")] }
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

	public showFrame(frame: FrameMessage) {
		this._lastFrame = frame;
		this._panel.webview.postMessage({ type: "frame", frame });
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
			this.showFrame(this._lastFrame);
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
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${media("previewer.css")}">
</head>
<body>
	<div class="toolbar">
		<span id="dot" class="dot"></span>
		<span id="status" class="status" title="Click to choose the project that hosts the previewer">Waiting…</span>
		<button id="zoomOut" title="Zoom out (Ctrl+Wheel)">−</button>
		<select id="zoom" title="Zoom"></select>
		<button id="zoomIn" title="Zoom in (Ctrl+Wheel)">+</button>
		<span class="sep"></span>
		<select id="theme" title="Theme variant">
			<option value="Default">App theme</option><option value="Light">Light</option><option value="Dark">Dark</option>
		</select>
		<select id="formFactor" title="Form factor"></select>
		<button id="rotate" title="Rotate">⟲</button>
		<button id="input" title="Mouse and keyboard input to the preview">🖱</button>
		<span class="sep"></span>
		<button id="restart" title="Restart the previewer process">⟳</button>
		<button id="build" title="Build the project and reload the preview">Build</button>
		<button id="log" title="Show the Avalonia output log">≡</button>
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
