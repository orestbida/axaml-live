import * as vscode from "vscode";
import path = require("path");
import { AppConstants } from "../util/Utilities";
import { getNonce } from "../util/nonce";
import { formFactorLabel, formFactors } from "../xaml/formFactors";
import * as zlib from "zlib";
import { promisify } from "util";
import * as fs from "fs";
import { changedRect, cropRows } from "../services/frameStats";

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
    /** The custom size (form factor "custom"), also shown in the toolbar's size fields. */
    customWidth?: number;
    customHeight?: number;
    rulers: boolean;
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
    private _inFlight: number[] = []; // post times of frames the webview has not acknowledged yet
    private _frameWaiting = false;

    private readonly _onDidDispose = new vscode.EventEmitter<void>();
    public readonly onDidDispose = this._onDidDispose.event;
    private readonly _onMessage = new vscode.EventEmitter<any>();
    /** Messages from the webview (toolbar commands, view changes, input). */
    public readonly onMessage = this._onMessage.event;
    private readonly _onDidChangeVisibility = new vscode.EventEmitter<boolean>();
    /** The tab was shown or hidden (another tab of its group became active). */
    public readonly onDidChangeVisibility = this._onDidChangeVisibility.event;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        column: vscode.ViewColumn,
        options: PanelOptions
    ) {
        this._options = options;
        this._panel = vscode.window.createWebviewPanel(
            AppConstants.previewerPanelViewType,
            "Preview",
            { viewColumn: column, preserveFocus: true },
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(_extensionUri, "media"),
                    vscode.Uri.joinPath(_extensionUri, "node_modules", "@vscode", "codicons", "dist"),
                ],
            }
        );
        this._panel.iconPath = {
            dark: vscode.Uri.joinPath(_extensionUri, "media", "preview-dark.svg"),
            light: vscode.Uri.joinPath(_extensionUri, "media", "preview-light.svg"),
        };
        this._panel.webview.html = this.getHtml();
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        let visible = this._panel.visible;
        this._panel.onDidChangeViewState(
            (e) => {
                if (e.webviewPanel.visible !== visible) {
                    visible = e.webviewPanel.visible;
                    this._onDidChangeVisibility.fire(visible);
                }
            },
            null,
            this._disposables
        );
        this._panel.webview.onDidReceiveMessage(
            (msg) => {
                if (msg?.type === "ready") {
                    this.postAll();
                } else if (msg?.type === "needFullFrame") {
                    this._shown = undefined;
                    this.sent.refused++;
                    this._frameWaiting = true; // sent as a full frame right after the pending frameDrawn
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
     * At most a few frames are in flight to the webview (enough to hide the round trip of remote sessions) and only the
     * newest waits, so a slow or hidden webview never queues up stale frames (the designer keeps rendering, see
     * PreviewSession.acceptFrame). Acknowledgements older than a second are given up on.
     */
    public showFrame(frame: FrameMessage) {
        this._lastFrame = frame;
        const now = Date.now();
        while (this._inFlight.length && now - this._inFlight[0] > 1000) {
            this._inFlight.shift();
        }
        if (this._inFlight.length >= maxFramesInFlight) {
            this._frameWaiting = true;
            return;
        }
        this.postFrame(frame);
    }

    /** What the webview's canvas shows (tightly packed RGBA): patches are computed against it. */
    private _shown: { width: number; height: number; scale: number; data: Uint8Array } | undefined;

    /**
     * Sends only the rectangle that changed since the frame the webview shows (animations usually change a small
     * part). In remote sessions (WSL, SSH, containers) every byte crosses the connection to the UI, so pixels are
     * also deflated: rendered UI compresses very well and this keeps large previews smooth.
     */
    private postFrame(frame: FrameMessage) {
        this._frameWaiting = false;
        const { width, height, scale } = frame;
        const data = tightPixels(frame);
        const shown = this._shown;
        this._shown = { width, height, scale, data };
        if (shown && shown.width === width && shown.height === height && shown.scale === scale) {
            const r = changedRect(shown.data, data, width, height);
            if (!r) {
                return; // identical: nothing to draw
            }
            if (r.width * r.height < width * height * 0.5) {
                this._inFlight.push(Date.now());
                const patch = cropRows(data, width, r);
                this.sent.patches++;
                this.send("patch", { ...r, canvasWidth: width, canvasHeight: height }, patch);
                return;
            }
        }
        this._inFlight.push(Date.now());
        this.sent.full++;
        this.send("frame", { width, height, scale, stride: width * 4 }, data);
    }

    private _sending: Promise<void> = Promise.resolve();
    private _queued = 0;

    /**
     * Posts a frame or patch. Compression (remote sessions) runs off the extension host's main thread; messages
     * still reach the webview in order, since patches apply to the frame before them.
     */
    private send(type: "frame" | "patch", fields: object, pixels: Uint8Array) {
        const compress = !!vscode.env.remoteName && pixels.length >= 64 * 1024;
        if (!compress && this._queued === 0) {
            this.sent.bytes += pixels.length;
            this._panel.webview.postMessage({ type, frame: { ...fields, data: plainBytes(pixels) } });
            return;
        }
        this._queued++;
        this._sending = this._sending
            .then(async () => {
                const t0 = Date.now();
                const encoded = compress
                    ? { data: plainBytes(await deflateRaw(pixels, { level: 1 })), deflated: true }
                    : { data: plainBytes(pixels) };
                this.sent.encodeMs += Date.now() - t0;
                this.sent.bytes += encoded.data.length;
                await this._panel.webview.postMessage({ type, frame: { ...fields, ...encoded } });
            })
            .catch(() => undefined) // the panel was closed meanwhile
            .finally(() => this._queued--);
    }

    /** Frames the webview has drawn (what the user sees). */
    public framesDrawn = 0;
    /** Transfer statistics (debug state). */
    public readonly sent = { full: 0, patches: 0, bytes: 0, encodeMs: 0, refused: 0 };

    private onFrameDrawn() {
        this.framesDrawn++;
        this._inFlight.shift();
        if (this._frameWaiting && this._lastFrame) {
            this.postFrame(this._lastFrame);
        }
    }

    /** zoom: a factor, "fitAll" or "fitWidth"; applied by the webview, which reports back with a "view" message. */
    public setZoom(zoom: number | string) {
        this._panel.webview.postMessage({ type: "setZoom", zoom });
    }

    /** End-to-end tests: drags a resize handle of the frame with pointer events in the webview. */
    public testDrag(edge: string, dx: number, dy: number) {
        this._panel.webview.postMessage({ type: "testDrag", edge, dx, dy });
    }

    /** Select mode: box around the control under the pointer (logical coordinates of the previewed view). */
    public setHighlight(rect: { x: number; y: number; width: number; height: number; label: string; selected: boolean } | undefined) {
        this._panel.webview.postMessage({ type: "highlight", rect });
    }

    private postState() {
        this._panel.webview.postMessage({ type: "state", state: this._state, xaml: this._xaml });
    }

    private postAll() {
        this.setOptions(this._options);
        this.postState();
        this._shown = undefined;
        this._inFlight = [];
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
        this._onDidChangeVisibility.dispose();
    }

    private getHtml() {
        const webview = this._panel.webview;
        const nonce = getNonce();
        const codicons = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, "node_modules", "@vscode", "codicons", "dist", "codicon.css")
        );
        // the file's modification time in the URL: a webview may otherwise keep an older copy of a changed file
        const media = (f: string) => {
            const uri = vscode.Uri.joinPath(this._extensionUri, "media", f);
            let stamp = "";
            try {
                stamp = String(Math.round(fs.statSync(uri.fsPath).mtimeMs));
            } catch {
                // not on disk (remote file system): no stamp
            }
            return webview.asWebviewUri(uri).with({ query: stamp ? `v=${stamp}` : "" });
        };
        const config = vscode.workspace.getConfiguration("axamlLive.previewer");
        const init = {
            defaultZoom: config.get<number | string>("defaultZoom", 1),
            formFactors: formFactors.map((f) => ({
                id: f.id,
                label: formFactorLabel(f),
                size: f.width ? `${f.width}×${f.height}` : "d:DesignWidth/Height",
            })),
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
            <span class="select"><select id="formFactor" title="Size: the view's design size, a device, or a custom size"></select></span>
            <span id="customSize" class="custom-size" hidden>
                <input id="customWidth" type="number" min="16" max="8000" step="1" title="Width (logical pixels)" aria-label="Width" />
                <span class="times">×</span>
                <input id="customHeight" type="number" min="16" max="8000" step="1" title="Height (logical pixels)" aria-label="Height" />
            </span>
            <button id="input" class="action codicon codicon-keyboard" title="Mouse and keyboard input to the preview" aria-pressed="true"></button>
            <button id="rulers" class="action codicon codicon-symbol-ruler" title="Rulers" aria-pressed="false"></button>
            <button id="selectElement" class="action codicon codicon-inspect" title="Select an element: click it to go to its XAML (Esc to stop)" aria-pressed="false"></button>
        </div>
        <span class="sep"></span>
        <div class="group">
            <button id="restart" class="action codicon codicon-debug-restart" title="Restart the previewer"></button>
            <button id="build" class="action codicon codicon-tools" title="Build the project and reload the preview"></button>
            <button id="log" class="action codicon codicon-output" title="Show the Avalonia output log"></button>
        </div>
    </div>
    <div id="stageArea" class="stage-area">
        <canvas id="rulerTop" class="ruler ruler-top"></canvas>
        <canvas id="rulerLeft" class="ruler ruler-left"></canvas>
        <div class="ruler-corner"></div>
        <div id="stage" class="stage">
            <div id="frameBox" class="frame-box">
                <canvas id="canvas" tabindex="0"></canvas>
                <div id="highlight" class="highlight"><span id="highlightLabel"></span></div>
                <div id="resizeOutline" class="resize-outline"><span id="resizeLabel"></span></div>
                <div class="resize-handle handle-e" data-edge="e" title="Drag to change the width"></div>
                <div class="resize-handle handle-s" data-edge="s" title="Drag to change the height"></div>
                <div class="resize-handle handle-se" data-edge="se" title="Drag to change the size"></div>
            </div>
            <div id="overlay" class="overlay"><div id="overlayText"></div><pre id="overlayDetails" style="display:none"></pre><button id="overlayBuild" style="display:none">Build project</button></div>
        </div>
    </div>
    <div id="xamlError" class="xaml-error"></div>
    <script nonce="${nonce}">window.previewerInit = ${JSON.stringify(init)};</script>
    <script nonce="${nonce}" src="${media("previewer.js")}"></script>
</body>
</html>`;
    }
}

/** Frame pixels without row padding. */
function tightPixels(frame: FrameMessage): Uint8Array {
    const row = frame.width * 4;
    if (!frame.stride || frame.stride === row) {
        return frame.data.subarray(0, row * frame.height);
    }
    const out = new Uint8Array(row * frame.height);
    for (let y = 0; y < frame.height; y++) {
        out.set(frame.data.subarray(y * frame.stride, y * frame.stride + row), y * row);
    }
    return out;
}

/**
 * A plain Uint8Array over the same memory. Node Buffers have toJSON(): in remote sessions webview messages are
 * JSON-serialized and a Buffer would travel as an array of numbers (huge and slow) instead of binary.
 */
function plainBytes(data: Uint8Array): Uint8Array {
    return Object.getPrototypeOf(data) === Uint8Array.prototype ? data : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

/** Frames posted to the webview before waiting for its acknowledgements (hides the round trip of remote sessions). */
const maxFramesInFlight = 3;
const deflateRaw = promisify(zlib.deflateRaw);
