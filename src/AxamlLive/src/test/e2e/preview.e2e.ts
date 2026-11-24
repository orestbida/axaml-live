import * as assert from "assert";
import * as path from "path";
import * as fs from "fs";
import * as vscode from "vscode";
import { execFile } from "child_process";
import { e2eSetting, windowsScreenshot } from "./config";

/** Logical frame size, within a pixel: at fractional render scales the designer rounds the bitmap size. */
const samePathLike = (a: string, b: string) => a.toLowerCase().replace(/\\/g, "/") === b.toLowerCase().replace(/\\/g, "/");
const sizeIs = (s: any, w: number, h: number) =>
    !!s.preview?.frame && Math.abs(s.preview.frame.logicalWidth - w) <= 1 && Math.abs(s.preview.frame.logicalHeight - h) <= 1;

const workspace = e2eSetting("E2E_WORKSPACE") ?? vscode.workspace.workspaceFolders![0].uri.fsPath;
const shotDir = e2eSetting("E2E_SCREENSHOT_DIR");
const pauseMs = Number(e2eSetting("E2E_PAUSE_MS") ?? 2500);
const buildTarget = e2eSetting("E2E_BUILD_TARGET");

type State = {
    panel: boolean;
    panelState?: { status: string; message?: string; url?: string };
    sessionState?: string;
    designDataContext?: boolean;
    xamlResults?: number;
    file?: string;
    crashes?: number;
    framesDrawn?: number;
    sent?: { full: number; patches: number; bytes: number; encodeMs: number };
    lastCrash?: string;
    project?: string;
    htmlUrl?: string;
    sessionsStarted: number;
    lastXaml?: { error?: string; message?: string; line?: number };
    building: boolean;
    preview?: {
        frames: number;
        frame?: { width: number; height: number; scale: number; logicalWidth: number; logicalHeight: number; avgLum: number };
        zoom?: number;
        stage?: { width: number; height: number };
        theme: string;
        formFactor: string;
        rotated: boolean;
        inputEnabled: boolean;
        inputsForwarded: number;
        fpsLimit: number;
        recentFps: number;
    };
    styleBadges?: number;
    previewerPid?: number;
};

/** Sends a message exactly as the preview webview toolbar would. */
const previewCommand = (msg: object) => vscode.commands.executeCommand("axamlLive.debug.previewCommand", msg);
const frames = (s: State) => s.preview?.frames ?? 0;

const state = async () => (await vscode.commands.executeCommand<State>("axamlLive.debug.state"))!;
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
        execFile(
            "dotnet",
            ["build", ...(buildTarget ? [buildTarget] : []), "-nologo", "-v", "q"],
            { cwd: workspace },
            (err, stdout, stderr) => resolve({ code: err ? ((err as any).code ?? 1) : 0, out: stdout + stderr })
        );
    });
}

const noXamlError = (s: State) => !!s.lastXaml && !s.lastXaml.error && !s.lastXaml.message;

suite("Avalonia previewer (e2e)", () => {
    const mainWindow = findAxaml(e2eSetting("E2E_AXAML") ?? "MainWindow.axaml");
    let editor: vscode.TextEditor;

    suiteSetup(async () => {
        await vscode.workspace.getConfiguration("axamlLive.previewer").update("defaultZoom", 0.5, vscode.ConfigurationTarget.Global);
        const doc = await vscode.workspace.openTextDocument(mainWindow);
        editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
    });

    suiteTeardown(async () => {
        // the zoom tests need a small zoom; later runs (and people watching them) get the normal 100%
        await vscode.workspace.getConfiguration("axamlLive.previewer").update("defaultZoom", undefined, vscode.ConfigurationTarget.Global);
    });

    test("shows the preview (builds if needed)", async () => {
        await vscode.commands.executeCommand("axamlLive.showPreviewToSide", editor.document.uri);
        await waitFor("preview ready", (s) => s.sessionState === "ready" && s.panelState?.status === "ready", 240000);
        // the unmodified file must render without errors
        const r = await waitFor("first XAML result", (s) => !!s.lastXaml, 60000);
        assert.ok(!r.lastXaml?.error && !r.lastXaml?.message, `initial preview error: ${r.lastXaml?.message ?? r.lastXaml?.error}`);
        await checkpoint("preview-ready");
    });

    const showMain = async () =>
        (editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(mainWindow), vscode.ViewColumn.One));
    const designSize = () => {
        const t = fs.readFileSync(mainWindow, "utf8");
        return { w: Number(/d:DesignWidth="(\d+)"/.exec(t)?.[1] ?? 0), h: Number(/d:DesignHeight="(\d+)"/.exec(t)?.[1] ?? 0) };
    };

    test("select mode: clicking a control in the preview selects its element in the editor", async () => {
        await showMain();
        const file = path.join(path.dirname(mainWindow), "E2eSelect.axaml");
        fs.writeFileSync(
            file,
            `<UserControl xmlns="https://github.com/avaloniaui" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml" Width="300" Height="200">
` +
                `  <StackPanel Margin="10" Spacing="10">
` +
                `    <TextBlock Text="Title" />
` +
                `    <Button x:Name="FirstButton" Content="First" />
` +
                `    <Border Height="60" Background="Gray">
` +
                `      <Button Content="Inner" VerticalAlignment="Center" />
` +
                `    </Border>
` +
                `  </StackPanel>
` +
                `</UserControl>`
        );
        const select = [0, 1, 2, 3]; // Alt, Control, Shift, Windows: what the toolbar's select mode sends
        const click = async (x: number, y: number) => {
            const before = (await state()) as any;
            await previewCommand({ type: "input", kind: "pointerPressed", x, y, button: 1, modifiers: [...select, 4], select: true });
            await previewCommand({ type: "input", kind: "pointerReleased", x, y, button: 1, modifiers: select, select: true });
            await waitFor("select report", (s: any) => s.lastInspect?.kind === "select" && s.lastInspect !== before.lastInspect, 10000);
            await sleep(500);
            const ed = vscode.window.visibleTextEditors.find((e) => samePathLike(e.document.uri.fsPath, file))!;
            return {
                line: ed.selection.start.line,
                text: ed.document.getText(ed.selection),
                label: ((await state()) as any).lastHighlight,
            };
        };
        try {
            const before = await state();
            await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file), vscode.ViewColumn.One);
            await waitFor(
                "select view",
                (s) => sizeIs(s, 300, 200) && (s.xamlResults ?? 0) > (before.xamlResults ?? 0) && noXamlError(s),
                30000
            );
            await waitFor("designer hook ready", (s: any) => !!s.lastInspect, 30000);
            await sleep(800);

            const first = await click(30, 50);
            console.log(`[e2e] select first button: ${JSON.stringify(first)}`);
            assert.deepStrictEqual([first.line, first.text, first.label], [3, "Button", "Button FirstButton"]);

            // a dark theme wraps the content in a theme scope and background borders that are not in the file
            const results = (await state()).xamlResults ?? 0;
            await previewCommand({ type: "setTheme", value: "Dark" });
            await waitFor("dark preview", (s) => (s.xamlResults ?? 0) > results && noXamlError(s), 30000);
            await sleep(800);
            const inner = await click(30, 112);
            console.log(`[e2e] select inner button (dark theme): ${JSON.stringify(inner)}`);
            assert.deepStrictEqual([inner.line, inner.text], [5, "Button"]);
        } finally {
            await previewCommand({ type: "setTheme", value: "Default" });
            await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file), vscode.ViewColumn.One);
            await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
            fs.rmSync(file, { force: true });
            await showMain();
            await waitFor("main window again", (s) => !!s.file && samePathLike(s.file, mainWindow) && !sizeIs(s, 300, 200), 30000);
        }
    });

    test("frames are rendered by the extension (own previewer renderer)", async () => {
        const s = await waitFor("a frame", (s) => !!s.preview?.frame, 30000);
        const { w, h } = designSize();
        if (w && h) {
            assert.strictEqual(s.preview!.frame!.logicalWidth, w);
            assert.strictEqual(s.preview!.frame!.logicalHeight, h);
        }
        assert.ok(s.preview!.frame!.avgLum > 0);
        assert.ok(s.preview!.zoom! > 0, "webview reported its zoom");
    });

    test("zooming in renders at a higher scale (sharp, not CSS-scaled)", async () => {
        const before = (await state()).preview!.frame!;
        await previewCommand({ type: "zoom", zoom: 2 });
        const s = await waitFor("frame at higher scale", (s) => (s.preview?.frame?.scale ?? 0) >= 2 * before.scale - 0.01, 30000);
        assert.strictEqual(s.preview!.frame!.width, Math.round(s.preview!.frame!.logicalWidth * s.preview!.frame!.scale));
        assert.strictEqual(s.preview!.zoom, 2);
        await checkpoint("zoom-200");
    });

    test("Fit Width and Fit All", async () => {
        await previewCommand({ type: "zoom", zoom: "fitWidth" });
        const fitsWidth = (s: State) =>
            !!s.preview?.stage &&
            !!s.preview.frame &&
            Math.abs(s.preview.frame.logicalWidth * s.preview.zoom! - s.preview.stage.width) <= 2;
        let s = await waitFor("fit width", fitsWidth, 10000);
        const f = s.preview!.frame!;
        await previewCommand({ type: "zoom", zoom: "fitAll" });
        s = await waitFor("fit all", (s) => s.preview!.zoom! * f.logicalHeight <= s.preview!.stage!.height + 2, 10000);
        const p = s.preview!;
        assert.ok(f.logicalWidth * p.zoom! <= p.stage!.width + 2 && f.logicalHeight * p.zoom! <= p.stage!.height + 2);
        assert.ok(Math.abs(f.logicalWidth * p.zoom! - p.stage!.width) <= 2 || Math.abs(f.logicalHeight * p.zoom! - p.stage!.height) <= 2);
        await checkpoint("fit-all");
    });

    test("theme switch (Dark / Light / Default) without touching the file", async () => {
        const text = editor.document.getText();
        await previewCommand({ type: "setTheme", value: "Dark" });
        let s = await waitFor("dark frame", (s) => s.preview?.theme === "Dark" && (s.preview?.frame?.avgLum ?? 255) < 110, 30000);
        await checkpoint("theme-dark");
        await previewCommand({ type: "setTheme", value: "Light" });
        s = await waitFor("light frame", (s) => s.preview?.theme === "Light" && (s.preview?.frame?.avgLum ?? 0) > 150, 30000);
        await previewCommand({ type: "setTheme", value: "Default" });
        await waitFor("default theme", (s) => s.preview?.theme === "Default", 5000);
        assert.strictEqual(editor.document.getText(), text, "the document must not change");
        void s;
    });

    test("form factors and rotation", async () => {
        await previewCommand({ type: "setFormFactor", id: "phone", rotated: false });
        await waitFor("phone size", (s) => sizeIs(s, 390, 844), 30000);
        await checkpoint("form-factor-phone");
        await previewCommand({ type: "setFormFactor", id: "phone", rotated: true });
        await waitFor("rotated phone", (s) => sizeIs(s, 844, 390), 30000);
        await previewCommand({ type: "setFormFactor", id: "default", rotated: false });
        const { w, h } = designSize();
        if (w && h) {
            await waitFor("design size again", (s) => sizeIs(s, w, h), 30000);
        }
    });

    test("mouse input is forwarded only when enabled", async () => {
        const { w, h } = designSize();
        const x = (w || 400) / 2;
        const y = (h || 300) / 2;
        await previewCommand({ type: "setInput", enabled: true });
        let s = await state();
        const forwarded = s.preview!.inputsForwarded;
        const framesBefore = frames(s);
        await previewCommand({ type: "input", kind: "pointerMoved", x, y, modifiers: [] });
        s = await waitFor("input forwarded", (s) => s.preview!.inputsForwarded === forwarded + 1, 5000);
        if (editor.document.getText().includes("<TextBox")) {
            // hovering the centered TextBox of the template changes its border: a new frame arrives
            await waitFor("hover frame", (s) => frames(s) > framesBefore, 10000);
        }
        await previewCommand({ type: "setInput", enabled: false });
        await previewCommand({ type: "input", kind: "pointerMoved", x: x + 5, y, modifiers: [] });
        await sleep(500);
        assert.strictEqual((await state()).preview!.inputsForwarded, forwarded + 1, "input must not be forwarded when disabled");
        await previewCommand({ type: "setInput", enabled: true });
    });

    test("FPS limit caps animation frames", async () => {
        await showMain();
        const config = vscode.workspace.getConfiguration("axamlLive.previewer");
        const original = editor.document.getText();
        // an indeterminate progress bar animates continuously
        const animated =
            original.substring(0, original.indexOf(">", original.indexOf("<Window")) + 1) +
            `<ProgressBar IsIndeterminate="True" Width="300"/></Window>`;
        try {
            await config.update("fpsLimit", 4, vscode.ConfigurationTarget.Global);
            await editor.edit((e) =>
                e.replace(new vscode.Range(editor.document.positionAt(0), editor.document.positionAt(original.length)), animated)
            );
            await sleep(1500);
            let s = await state();
            const f0 = frames(s);
            await sleep(3000);
            s = await state();
            const limited = frames(s) - f0;
            console.log(`[e2e] frames in 3s at fpsLimit=4: ${limited}`);
            assert.ok(limited >= 3 && limited <= 4 * 3 + 2, `limited frames: ${limited}`);
            await config.update("fpsLimit", 0, vscode.ConfigurationTarget.Global);
            await sleep(1000);
            const f1 = frames(await state());
            await sleep(3000);
            const unlimited = frames(await state()) - f1;
            console.log(`[e2e] frames in 3s unlimited: ${unlimited}`);
            assert.ok(unlimited > limited * 2, `unlimited ${unlimited} vs limited ${limited}`);
        } finally {
            await config.update("fpsLimit", undefined, vscode.ConfigurationTarget.Global);
            await editor.edit((e) =>
                e.replace(
                    new vscode.Range(editor.document.positionAt(0), editor.document.positionAt(editor.document.getText().length)),
                    original
                )
            );
            await editor.document.save();
        }
    });

    test("design data context: a type without a public constructor falls back, later previews stay correct", async () => {
        await showMain();
        const main = await waitFor("main frame", (s) => (s.preview?.frame?.avgLum ?? 0) > 50, 30000);
        const mainLum = main.preview!.frame!.avgLum;
        // KeyGesture has no parameterless constructor: the automatic Design.DataContext fails at load time
        const file = path.join(path.dirname(mainWindow), "E2eNoCtor.axaml");
        fs.writeFileSync(
            file,
            `<UserControl xmlns="https://github.com/avaloniaui" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml" x:DataType="KeyGesture" Width="300" Height="120"><TextBlock Text="no constructor" FontSize="24"/></UserControl>`
        );
        try {
            const before = await state();
            await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file), vscode.ViewColumn.One);
            let s = await waitFor("no-ctor view", (s) => sizeIs(s, 300, 120) && (s.xamlResults ?? 0) > (before.xamlResults ?? 0), 30000);
            await sleep(1000);
            s = await state();
            assert.ok(!s.lastXaml?.error && !s.lastXaml?.message, `preview error shown: ${JSON.stringify(s.lastXaml)}`);
            assert.ok(!s.designDataContext, "fell back to the XAML without the design data context");
            assert.ok(s.preview!.frame!.avgLum > 50, `no-ctor view rendered black: ${JSON.stringify(s.preview?.frame)}`);
            // the next file renders normally
            await showMain();
            s = await waitFor("main frame again", (s) => !!s.file && samePathLike(s.file, mainWindow) && !sizeIs(s, 300, 120), 30000);
            await sleep(1000);
            s = await state();
            assert.ok(
                Math.abs(s.preview!.frame!.avgLum - mainLum) < 30,
                `main window renders differently after the fallback: ${s.preview!.frame!.avgLum} vs ${mainLum}`
            );
        } finally {
            await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file), vscode.ViewColumn.One);
            await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
            fs.rmSync(file, { force: true });
            await showMain();
        }
    });

    test("preview background setting fills views without their own background", async () => {
        const config = vscode.workspace.getConfiguration("axamlLive.previewer");
        const file = path.join(path.dirname(mainWindow), "E2eTransparent.axaml");
        fs.writeFileSync(
            file,
            `<UserControl xmlns="https://github.com/avaloniaui" Width="200" Height="100"><TextBlock Text="x" FontSize="8"/></UserControl>`
        );
        try {
            await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file), vscode.ViewColumn.One);
            await waitFor("transparent view", (s) => sizeIs(s, 200, 100), 30000);
            await config.update("background", "#ff0000", vscode.ConfigurationTarget.Global);
            // pure red has a luminance of 85; the theme background is white or near black
            await waitFor("red background", (s) => sizeIs(s, 200, 100) && Math.abs((s.preview?.frame?.avgLum ?? 0) - 85) < 15, 30000);
            await config.update("background", undefined, vscode.ConfigurationTarget.Global);
            await waitFor(
                "theme background again",
                (s) => sizeIs(s, 200, 100) && Math.abs((s.preview?.frame?.avgLum ?? 85) - 85) > 40,
                30000
            );
        } finally {
            await config.update("background", undefined, vscode.ConfigurationTarget.Global);
            await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
            fs.rmSync(file, { force: true });
            await showMain();
        }
    });

    test("global.json with a missing SDK: clear error, or build with the installed SDK when allowed", async () => {
        const root = path.dirname(path.dirname(mainWindow));
        const globalJson = path.join(root, "global.json");
        const hadGlobalJson = fs.existsSync(globalJson) ? fs.readFileSync(globalJson, "utf8") : undefined;
        const build = vscode.workspace.getConfiguration("axamlLive.build");
        await showMain();
        await waitFor("preview ready", (s) => s.sessionState === "ready", 60000);
        fs.writeFileSync(globalJson, JSON.stringify({ sdk: { version: "99.0.100", rollForward: "disable" } }));
        try {
            await previewCommand({ type: "build" });
            let s = await waitFor(
                "build refused",
                (s) => !s.building && /global\.json requests \.NET SDK 99\.0\.100/.test(s.panelState?.message ?? ""),
                120000
            );
            await build.update("useInstalledSdk", true, vscode.ConfigurationTarget.Workspace);
            await previewCommand({ type: "build" });
            s = await waitFor(
                "built with the installed SDK",
                (s) => !s.building && s.sessionState === "ready" && s.panelState?.status === "ready",
                180000
            );
            assert.ok(!/global\.json/.test(s.panelState?.message ?? ""), s.panelState?.message);
        } finally {
            await build.update("useInstalledSdk", undefined, vscode.ConfigurationTarget.Workspace);
            hadGlobalJson === undefined ? fs.rmSync(globalJson, { force: true }) : fs.writeFileSync(globalJson, hadGlobalJson);
        }
    });

    test("form factor, theme and edits apply while an animation runs (no reload needed)", async () => {
        await showMain();
        const original = editor.document.getText();
        const head = original.substring(0, original.indexOf(">", original.indexOf("<Window")) + 1);
        const animated = (label: string) =>
            `${head}<StackPanel Spacing="8" Margin="20"><ProgressBar IsIndeterminate="True" Width="300"/><TextBlock Text="${label}"/></StackPanel></Window>`;
        const replaceAll = (text: string) =>
            editor.edit((e) =>
                e.replace(
                    new vscode.Range(editor.document.positionAt(0), editor.document.positionAt(editor.document.getText().length)),
                    text
                )
            );
        try {
            await replaceAll(animated("one"));
            await sleep(1500); // frames of the animated window are flowing, acknowledgements in flight
            for (const ff of [
                { id: "phone", w: 390, h: 844 },
                { id: "tablet", w: 768, h: 1024 },
            ]) {
                await previewCommand({ type: "setFormFactor", id: ff.id, rotated: false });
                await waitFor(`${ff.id} size while animating`, (s) => sizeIs(s, ff.w, ff.h), 15000);
                const s0 = await state();
                const f0 = frames(s0);
                const drawn0 = s0.framesDrawn ?? 0;
                await sleep(1000);
                const s1 = await state();
                console.log(
                    `[e2e] ${ff.id} ${s1.preview?.frame?.width}x${s1.preview?.frame?.height} px: ${frames(s1) - f0} frames/s received, ${(s1.framesDrawn ?? 0) - drawn0} drawn; sent ${JSON.stringify(s1.sent)} (before ${JSON.stringify(s0.sent)})`
                );
                assert.ok(
                    frames(s1) > f0 + 5,
                    `animation stopped after switching to ${ff.id}: ${frames(s1) - f0} frames/s ${JSON.stringify({ frame: s1.preview?.frame, fps: s1.preview?.recentFps, dc: s1.designDataContext, xaml: s1.lastXaml })}`
                );
            }
            await previewCommand({ type: "setTheme", value: "Dark" });
            await waitFor("dark while animating", (s) => (s.preview?.frame?.avgLum ?? 255) < 110, 15000);
            const before = frames(await state());
            await replaceAll(animated("two"));
            await sleep(1500);
            assert.ok(frames(await state()) > before + 5, "animation stopped after an edit");
            await checkpoint("animated-form-factor");
        } finally {
            await previewCommand({ type: "setTheme", value: "Default" });
            await previewCommand({ type: "setFormFactor", id: "default", rotated: false });
            await replaceAll(original);
            await editor.document.save();
        }
    });

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

    test("a drop-down opened with a click stays open", async () => {
        await showMain();
        const file = path.join(path.dirname(mainWindow), "E2eComboBox.axaml");
        fs.writeFileSync(
            file,
            `<UserControl xmlns="https://github.com/avaloniaui" Width="300" Height="260" Background="Black">\n` +
                `  <ComboBox Margin="10" Width="200" VerticalAlignment="Top" SelectedIndex="0">\n` +
                `    <ComboBoxItem Content="One" /><ComboBoxItem Content="Two" /><ComboBoxItem Content="Three" /><ComboBoxItem Content="Four" />\n` +
                `  </ComboBox>\n` +
                `</UserControl>`
        );
        const input = (kind: string, x: number, y: number, extra: object = {}) =>
            previewCommand({ type: "input", kind, x, y, modifiers: [], ...extra });
        const lum = async () => (await state()).preview?.frame?.avgLum ?? 0;
        try {
            const before = await state();
            await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file), vscode.ViewColumn.One);
            await waitFor("combo box view", (s) => sizeIs(s, 300, 260) && (s.xamlResults ?? 0) > (before.xamlResults ?? 0), 30000);
            await sleep(1500);
            const closed = await lum();
            const variants: [string, () => Promise<unknown>][] = [
                [
                    "plain click",
                    async () => {
                        await input("pointerPressed", 100, 26, { button: 1, modifiers: [4] });
                        await input("pointerReleased", 100, 26, { button: 1 });
                    },
                ],
                [
                    "move while pressed",
                    async () => {
                        await input("pointerPressed", 100, 26, { button: 1, modifiers: [4] });
                        await input("pointerMoved", 101, 27, { modifiers: [4] });
                        await input("pointerReleased", 101, 27, { button: 1 });
                    },
                ],
                [
                    "late move after release",
                    async () => {
                        await input("pointerPressed", 100, 26, { button: 1, modifiers: [4] });
                        await input("pointerReleased", 100, 26, { button: 1 });
                        await input("pointerMoved", 101, 27, { modifiers: [4] });
                    },
                ],
            ];
            const results: string[] = [];
            for (const [name, click] of variants) {
                await click();
                await sleep(400);
                const opened = await lum();
                await sleep(1500);
                const later = await lum();
                results.push(`${name}: closed=${closed.toFixed(1)} opened=${opened.toFixed(1)} after1.5s=${later.toFixed(1)}`);
                // close it again with a click on the black area
                await input("pointerPressed", 280, 250, { button: 1, modifiers: [4] });
                await input("pointerReleased", 280, 250, { button: 1 });
                await sleep(800);
            }
            console.log(`[e2e] combo box: ${results.join(" | ")}`);
            for (const r of results) {
                const [, c, o, l] = /closed=([\d.]+) opened=([\d.]+) after1.5s=([\d.]+)/.exec(r)!.map(Number);
                assert.ok(o > c + 3, `drop-down did not open (${r})`);
                assert.ok(l > c + 3, `drop-down closed by itself (${r})`);
            }
        } finally {
            await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file), vscode.ViewColumn.One);
            await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
            fs.rmSync(file, { force: true });
            await showMain();
        }
    });

    test("update on save: unsaved edits wait until the file is saved", async () => {
        await showMain();
        const config = vscode.workspace.getConfiguration("axamlLive.previewer");
        await config.update("updateOn", "save", vscode.ConfigurationTarget.Global);
        const original = "Live edit from the e2e test";
        const at = editor.document.getText().indexOf(original);
        assert.ok(at > 0, "live edit content missing");
        const range = new vscode.Range(editor.document.positionAt(at), editor.document.positionAt(at + original.length));
        try {
            // wait until earlier updates (file switch, the setting change) are done
            let before = (await state()).xamlResults ?? 0;
            for (let quiet = 0; quiet < 6;) {
                await sleep(500);
                const now = (await state()).xamlResults ?? 0;
                quiet = now === before ? quiet + 1 : 0;
                before = now;
            }
            await editor.edit((e) => e.replace(range, "Shown after saving"));
            await sleep(2000);
            assert.strictEqual((await state()).xamlResults ?? 0, before, "the preview was updated before saving");
            await editor.document.save();
            await waitFor("update after save", (s) => (s.xamlResults ?? 0) > before && noXamlError(s), 30000);
        } finally {
            await config.update("updateOn", undefined, vscode.ConfigurationTarget.Global);
            const now = editor.document.getText().indexOf("Shown after saving");
            if (now > 0) {
                await editor.edit((e) =>
                    e.replace(
                        new vscode.Range(editor.document.positionAt(now), editor.document.positionAt(now + "Shown after saving".length)),
                        original
                    )
                );
            }
            await editor.document.save();
        }
    });

    test("reports XAML errors in the panel and Problems view", async () => {
        await showMain();
        const pos = editor.document.positionAt(editor.document.getText().indexOf("<Button"));
        const expectedLine = pos.line + 1;
        await editor.edit((e) => e.insert(pos, `<NotAControl Foo="1"/>`));
        const s = await waitFor("xaml error", (s) => !!(s.lastXaml?.error || s.lastXaml?.message), 30000);
        console.log(`[e2e] xaml error: ${s.lastXaml?.message ?? s.lastXaml?.error} (line ${s.lastXaml?.line})`);
        const diags = () => vscode.languages.getDiagnostics(editor.document.uri).filter((d) => d.source === "AXAML Live Preview");
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

    test("a XAML error does not turn off the automatic design data context", async () => {
        await showMain();
        const file = path.join(path.dirname(mainWindow), "E2eDesignData.axaml");
        fs.writeFileSync(
            file,
            `<UserControl xmlns="https://github.com/avaloniaui" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml" x:DataType="TextBlock" Width="320" Height="140">\n` +
                `  <TextBlock Text="{Binding FontSize}" FontSize="20" FontWeight="Bold" Margin="8,0,0,18" />\n` +
                `</UserControl>`
        );
        try {
            const before = await state();
            const doc = await vscode.workspace.openTextDocument(file);
            const ed = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
            let s = await waitFor(
                "view with design data",
                (s) => sizeIs(s, 320, 140) && (s.xamlResults ?? 0) > (before.xamlResults ?? 0),
                30000
            );
            await waitFor("no error", noXamlError, 30000);
            assert.ok((await state()).designDataContext, "automatic design data context not used");

            const at = doc.getText().indexOf('FontWeight="Bold"');
            const range = new vscode.Range(doc.positionAt(at), doc.positionAt(at + 'FontWeight="Bold"'.length));
            await ed.edit((e) => e.replace(range, 'FontWeight="Bolt"'));
            await waitFor("error for the invalid value", (s) => !!(s.lastXaml?.error || s.lastXaml?.message), 30000);
            await ed.edit((e) =>
                e.replace(new vscode.Range(range.start, doc.positionAt(at + 'FontWeight="Bolt"'.length)), 'FontWeight="Bold"')
            );
            s = await waitFor("recovered", noXamlError, 30000);
            assert.ok(s.designDataContext, "design data context still off after the error was fixed (bound content missing)");
        } finally {
            await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
            fs.rmSync(file, { force: true });
            await showMain();
        }
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
        const cs =
            [
                path.join(workspace, "ViewModels", "MainViewModel.cs"),
                path.join(workspace, path.basename(workspace), "ViewModels", "MainViewModel.cs"),
            ].find((f) => fs.existsSync(f)) ?? "";
        if (fs.existsSync(cs)) {
            fs.writeFileSync(cs, fs.readFileSync(cs, "utf8").replace(/Welcome to Avalonia!?/, "Rebuilt by the e2e test"));
        }
        const result = await dotnetBuild();
        assert.strictEqual(result.code, 0, `dotnet build failed while previewer was running:\n${result.out}`);
        const s = await waitFor(
            "previewer restarted after build",
            (s) => s.sessionsStarted > started && s.sessionState === "ready",
            120000
        );
        assert.strictEqual(s.panelState?.status, "ready");
        await checkpoint("after-external-build");
    });

    test("Build command rebuilds and reloads", async () => {
        const started = (await state()).sessionsStarted;
        await vscode.commands.executeCommand("axamlLive.createPreviewerAssets");
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
            const list = await vscode.commands.executeCommand<vscode.CompletionList>(
                "vscode.executeCompletionItemProvider",
                editor.document.uri,
                at
            );
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

    test("a .xaml file switched to AXAML gets completion and hover", async () => {
        const file = path.join(path.dirname(mainWindow), "E2eLegacy.xaml");
        const text = `<UserControl xmlns="https://github.com/avaloniaui">\n  <TextBlock Text="x" />\n  \n</UserControl>`;
        fs.writeFileSync(file, text);
        try {
            let doc = await vscode.workspace.openTextDocument(file);
            // what the extension does for .xaml files the solution lists as AvaloniaXaml
            doc = await vscode.languages.setTextDocumentLanguage(doc, "AXAML");
            const ed = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
            let hoverText = "";
            for (let i = 0; i < 20 && !hoverText.includes("Avalonia.Controls.TextBlock"); i++) {
                const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
                    "vscode.executeHoverProvider",
                    doc.uri,
                    doc.positionAt(text.indexOf("TextBlock") + 2)
                );
                hoverText = hovers.flatMap((h) => h.contents.map((c) => (typeof c === "string" ? c : c.value))).join("\n");
                if (!hoverText.includes("Avalonia.Controls.TextBlock")) {
                    await sleep(1000);
                }
            }
            assert.ok(hoverText.includes("Avalonia.Controls.TextBlock"), `no AXAML hover in a .xaml file: ${hoverText}`);

            const emptyLine = doc.positionAt(text.indexOf("  \n") + 2);
            await ed.edit((e) => e.insert(emptyLine, "<Butt"));
            const at = emptyLine.translate(0, "<Butt".length);
            let labels: string[] = [];
            for (let i = 0; i < 20 && !labels.includes("Button"); i++) {
                const list = await vscode.commands.executeCommand<vscode.CompletionList>(
                    "vscode.executeCompletionItemProvider",
                    doc.uri,
                    at
                );
                labels = list.items.map((it) => (typeof it.label === "string" ? it.label : it.label.label));
                if (!labels.includes("Button")) {
                    await sleep(1000);
                }
            }
            assert.ok(labels.includes("Button"), `no AXAML completion in a .xaml file (${labels.slice(0, 10).join(", ")})`);
        } finally {
            await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
            fs.rmSync(file, { force: true });
        }
    });

    /** Types `prefix`, applies the completion item `label` exactly like VS Code would and returns the line. */
    async function applyCompletion(prefix: string, label: string): Promise<string> {
        await showMain();
        const pos = editor.document.positionAt(editor.document.getText().indexOf("<TextBlock"));
        await editor.edit((e) => e.insert(pos, prefix));
        const at = pos.translate(0, prefix.length);
        const list = await vscode.commands.executeCommand<vscode.CompletionList>(
            "vscode.executeCompletionItemProvider",
            editor.document.uri,
            at
        );
        const labelOf = (it: vscode.CompletionItem) => (typeof it.label === "string" ? it.label : it.label.label);
        const item =
            list.items.find((it) => labelOf(it) === label) ??
            list.items.find((it) => label.endsWith("*") && labelOf(it).startsWith(label.slice(0, -1)));
        assert.ok(item, `completion "${label}" not offered for "${prefix}"`);
        const range = item.range
            ? "replacing" in item.range
                ? item.range.replacing
                : item.range
            : (editor.document.getWordRangeAtPosition(at) ?? new vscode.Range(at, at));
        const insert = typeof item.insertText === "string" ? item.insertText : (item.insertText?.value ?? label);
        await editor.edit((e) => e.replace(range, insert));
        const line = editor.document.lineAt(pos.line).text.trim();
        await vscode.commands.executeCommand("undo");
        await vscode.commands.executeCommand("undo");
        return line;
    }

    test("completion in style selectors and Classes", async () => {
        const file = path.join(path.dirname(mainWindow), "E2eStyles.axaml");
        const template = (selector: string, classes: string) =>
            `<UserControl xmlns="https://github.com/avaloniaui" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">\n` +
            `  <UserControl.Styles>\n` +
            `    <Style Selector="TextBlock.caption"><Setter Property="Opacity" Value="0.6" /></Style>\n` +
            `    <Style Selector="Button.primary:pointerover"><Setter Property="Opacity" Value="0.9" /></Style>\n` +
            `    <Style Selector="${selector}" />\n` +
            `  </UserControl.Styles>\n` +
            `  <StackPanel>\n` +
            `    <Button x:Name="SaveButton" Classes="${classes}" Content="Save" />\n` +
            `    <TextBlock Classes="caption" Text="Hello" />\n` +
            `  </StackPanel>\n` +
            `</UserControl>`;
        fs.writeFileSync(file, template("", ""));
        const doc = await vscode.workspace.openTextDocument(file);
        const ed = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
        const labelsAt = async (selector: string, classes: string) => {
            const text = template(selector, classes);
            const marker = text.indexOf("|");
            await ed.edit((e) =>
                e.replace(new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text.replace("|", ""))
            );
            const at = doc.positionAt(marker);
            let labels: string[] = [];
            for (let i = 0; i < 20 && !labels.some((l) => l !== "Build the project"); i++) {
                const list = await vscode.commands.executeCommand<vscode.CompletionList>(
                    "vscode.executeCompletionItemProvider",
                    doc.uri,
                    at
                );
                labels = list.items.map((it) => (typeof it.label === "string" ? it.label : it.label.label));
                if (!labels.some((l) => l !== "Build the project")) {
                    await sleep(1000);
                }
            }
            return labels;
        };
        try {
            // name, selector, Classes value ("|" is the cursor), labels that must be offered, labels that must not
            const cases: [string, string, string, string[], string[]][] = [
                ["selector start", "|", "", ["Button", ":is()"], []],
                ["pseudo-class", "Button:|", "", [":pointerover", ":pressed"], []],
                ["style class", "Button.|", "", ["caption", "primary", "accent"], ["Opacity", "Button"]],
                ["class without type", ".|", "", ["caption", "primary"], []],
                ["class being typed", "Button.cap|", "", ["caption"], ["cap"]],
                ["name", "Button#|", "", ["SaveButton"], ["caption"]],
                ["control after /template/", "Button /template/ |", "", ["ContentPresenter", "Border"], []],
                ["Classes attribute", "", "|", ["caption", "primary", "accent"], []],
                ["second class", "", "primary |", ["caption"], ["primary"]],
            ];
            for (const [name, selector, classes, expected, unexpected] of cases) {
                const labels = await labelsAt(selector, classes);
                console.log(`[e2e] completion ${name}: ${labels.length} ${labels.slice(0, 12).join(", ")}`);
                for (const e of expected) {
                    assert.ok(labels.includes(e), `${name}: '${e}' missing (${labels.slice(0, 20).join(", ")})`);
                }
                for (const u of unexpected) {
                    assert.ok(!labels.includes(u), `${name}: '${u}' should not be offered`);
                }
            }
        } finally {
            await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
            fs.rmSync(file, { force: true });
        }
    });

    test("nested binding paths and data templates: completion, hints and errors", async () => {
        const vmDir = [path.join(workspace, "ViewModels"), path.join(workspace, path.basename(workspace), "ViewModels")].find((d) =>
            fs.existsSync(path.join(d, "ViewModelBase.cs"))
        );
        if (!vmDir) {
            console.log("[e2e] skipped: not a C# MVVM project");
            return;
        }
        const ns = /namespace\s+([\w.]+)/.exec(fs.readFileSync(path.join(vmDir, "ViewModelBase.cs"), "utf8"))![1];
        const cs = path.join(vmDir, "E2eNested.cs");
        fs.writeFileSync(
            cs,
            `namespace ${ns};\n` +
                `public class E2eAddress { public string City { get; set; } = ""; public int Zip { get; set; } }\n` +
                `public class E2eOrder { public decimal Total { get; set; } public string Product { get; set; } = ""; }\n` +
                `public class E2eCustomer { public string Name { get; set; } = ""; public E2eAddress Address { get; set; } = new(); public System.Collections.Generic.List<E2eOrder> Orders { get; } = new(); }\n` +
                `public class E2eCustomerViewModel { public E2eCustomer Customer { get; } = new(); }\n`
        );
        const file = path.join(path.dirname(mainWindow), "E2eNested.axaml");
        const template = (a: string, b: string, c: string) =>
            `<UserControl xmlns="https://github.com/avaloniaui" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"\n` +
            `             xmlns:vm="using:${ns}" x:DataType="vm:E2eCustomerViewModel">\n` +
            `  <StackPanel>\n` +
            `    <TextBlock Text="{Binding ${a}}" />\n` +
            `    <TextBlock Text="{Binding ${b}}" />\n` +
            `    <ItemsControl ItemsSource="{Binding Customer.Orders}">\n` +
            `      <ItemsControl.ItemTemplate>\n` +
            `        <DataTemplate x:DataType="vm:E2eOrder">\n` +
            `          <TextBlock Text="{Binding ${c}}" />\n` +
            `        </DataTemplate>\n` +
            `      </ItemsControl.ItemTemplate>\n` +
            `    </ItemsControl>\n` +
            `  </StackPanel>\n` +
            `</UserControl>`;
        fs.writeFileSync(file, template("Customer.Name", "Customer.Address.City", "Product"));
        const doc = await vscode.workspace.openTextDocument(file);
        const ed = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
        const setText = (text: string) =>
            ed.edit((e) => e.replace(new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text));
        // the new C# file reaches the language server through its file watcher: retry until the members are known
        const labelsAt = async (a: string, b: string, c: string, expected: string[]) => {
            const text = template(a, b, c);
            const marker = text.indexOf("|");
            await setText(text.replace("|", ""));
            let labels: string[] = [];
            for (let i = 0; i < 15 && !expected.every((e) => labels.includes(e)); i++) {
                const list = await vscode.commands.executeCommand<vscode.CompletionList>(
                    "vscode.executeCompletionItemProvider",
                    doc.uri,
                    doc.positionAt(marker)
                );
                labels = list.items
                    .map((it) => (typeof it.label === "string" ? it.label : it.label.label))
                    .filter((l) => l !== "Build the project");
                if (!expected.every((e) => labels.includes(e))) {
                    await sleep(1000);
                }
            }
            return labels;
        };
        try {
            const cases: [string, [string, string, string], string[]][] = [
                ["first level", ["|", "Customer.Name", "Product"], ["Customer"]],
                ["second level", ["Customer.|", "Customer.Name", "Product"], ["Name", "Address", "Orders"]],
                ["third level", ["Customer.Address.|", "Customer.Name", "Product"], ["City", "Zip"]],
                ["data template", ["Customer.Name", "Customer.Name", "|"], ["Total", "Product"]],
            ];
            for (const [name, [a, b, c], expected] of cases) {
                const labels = await labelsAt(a, b, c, expected);
                console.log(`[e2e] binding completion ${name}: ${labels.slice(0, 15).join(", ")}`);
                for (const e of expected) {
                    assert.ok(labels.includes(e), `${name}: '${e}' missing (${labels.slice(0, 20).join(", ")})`);
                }
            }

            await setText(template("Customer.Name", "Customer.Address.City", "Total"));
            let hints: string[] = [];
            for (let i = 0; i < 15 && hints.length < 3; i++) {
                const list =
                    (await vscode.commands.executeCommand<vscode.InlayHint[]>(
                        "vscode.executeInlayHintProvider",
                        doc.uri,
                        new vscode.Range(0, 0, doc.lineCount, 0)
                    )) ?? [];
                hints = list.map(
                    (h) => `${h.position.line}:${typeof h.label === "string" ? h.label : h.label.map((p) => p.value).join("")}`
                );
                if (hints.length < 3) {
                    await sleep(1000);
                }
            }
            console.log(`[e2e] nested hints: ${hints.join(" | ")}`);
            assert.ok(hints.includes("3:: string"), "hint for Customer.Name");
            assert.ok(hints.includes("4:: string"), "hint for Customer.Address.City");
            assert.ok(hints.includes("8:: decimal"), "hint for Total in the data template");

            await setText(template("Customer.Name", "Customer.Adress.City", "Totl"));
            let messages: string[] = [];
            for (let i = 0; i < 20 && messages.length < 2; i++) {
                await sleep(500);
                messages = vscode.languages.getDiagnostics(doc.uri).map((d) => d.message);
            }
            console.log(`[e2e] nested errors: ${messages.join(" | ")}`);
            assert.ok(
                messages.some((m) => m.includes("Adress")),
                "misspelled nested member not reported"
            );
            assert.ok(
                messages.some((m) => m.includes("Totl")),
                "misspelled member in the data template not reported"
            );
        } finally {
            await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
            fs.rmSync(file, { force: true });
            fs.rmSync(cs, { force: true });
        }
    });

    test("resource keys from other files: completion, go to definition and hover", async () => {
        const dir = path.dirname(mainWindow);
        const dictionary = path.join(dir, "E2eResources.axaml");
        fs.writeFileSync(
            dictionary,
            `<ResourceDictionary xmlns="https://github.com/avaloniaui" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">\n` +
                `  <SolidColorBrush x:Key="E2eAccentBrush" Color="#FF3366" />\n` +
                `  <x:Double x:Key="E2eCardRadius">12</x:Double>\n` +
                `</ResourceDictionary>`
        );
        const file = path.join(dir, "E2eUsesResources.axaml");
        const text = (key: string) =>
            `<UserControl xmlns="https://github.com/avaloniaui" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">\n` +
            `  <UserControl.Resources>\n` +
            `    <SolidColorBrush x:Key="E2eLocalBrush" Color="Red" />\n` +
            `  </UserControl.Resources>\n` +
            `  <Border Background="{StaticResource ${key}}" />\n` +
            `</UserControl>`;
        fs.writeFileSync(file, text("E2eAccentBrush"));
        const doc = await vscode.workspace.openTextDocument(file);
        const ed = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
        try {
            const keyAt = doc.positionAt(text("E2eAccentBrush").indexOf("E2eAccentBrush") + 3);
            let targets: vscode.Location[] = [];
            for (let i = 0; i < 15 && !targets.length; i++) {
                targets =
                    (await vscode.commands.executeCommand<vscode.Location[]>("vscode.executeDefinitionProvider", doc.uri, keyAt)) ?? [];
                if (!targets.length) {
                    await sleep(1000);
                }
            }
            console.log(
                `[e2e] resource definition: ${targets.map((t) => `${path.basename(t.uri.fsPath)}:${t.range.start.line + 1}`).join(", ")}`
            );
            assert.ok(
                targets.some((t) => path.basename(t.uri.fsPath) === "E2eResources.axaml" && t.range.start.line === 1),
                "definition in the other file"
            );

            const hovers = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", doc.uri, keyAt);
            const hoverText = hovers
                .flatMap((h) => h.contents)
                .map((c) => (typeof c === "string" ? c : c.value))
                .join(" ");
            console.log(`[e2e] resource hover: ${hoverText.replace(/\s+/g, " ")}`);
            assert.ok(hoverText.includes("SolidColorBrush") && hoverText.includes("E2eResources.axaml"), "hover shows the definition");

            await ed.edit((e) => e.replace(new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text("")));
            const at = doc.positionAt(text("").indexOf("{StaticResource ") + "{StaticResource ".length);
            const list = await vscode.commands.executeCommand<vscode.CompletionList>("vscode.executeCompletionItemProvider", doc.uri, at);
            const items = list.items.map((it) => ({
                label: typeof it.label === "string" ? it.label : it.label.label,
                detail: it.detail ?? "",
            }));
            console.log(
                `[e2e] resource completion: ${items
                    .slice(0, 6)
                    .map((i) => `${i.label} (${i.detail})`)
                    .join(", ")}`
            );
            const labels = items.map((i) => i.label);
            assert.strictEqual(labels[0], "E2eLocalBrush", "keys of this file first");
            assert.ok(labels.includes("E2eAccentBrush") && labels.includes("E2eCardRadius"), "keys of the other file");
            assert.ok(labels.includes("SystemAccentColor"), "theme keys");
            assert.ok(items.find((i) => i.label === "E2eAccentBrush")!.detail.includes("E2eResources.axaml"));
        } finally {
            await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
            fs.rmSync(file, { force: true });
            fs.rmSync(dictionary, { force: true });
        }
    });

    test("quick fix: design-time view model for a view model without a parameterless constructor", async function (this: Mocha.Context) {
        this.timeout(300000);
        const vmDir = [path.join(workspace, "ViewModels"), path.join(workspace, path.basename(workspace), "ViewModels")].find((d) =>
            fs.existsSync(path.join(d, "ViewModelBase.cs"))
        );
        if (!vmDir) {
            console.log("[e2e] skipped: not a C# MVVM project");
            return;
        }
        const ns = /namespace\s+([\w.]+)/.exec(fs.readFileSync(path.join(vmDir, "ViewModelBase.cs"), "utf8"))![1];
        const vm = path.join(vmDir, "E2eNeedsArgsViewModel.cs");
        const design = path.join(vmDir, "DesignE2eNeedsArgsViewModel.cs");
        fs.writeFileSync(
            vm,
            `namespace ${ns};\npublic class E2eNeedsArgsViewModel {\n    public E2eNeedsArgsViewModel(string title, int count) { Title = title; }\n    public string Title { get; set; }\n}\n`
        );
        const view = path.join(path.dirname(mainWindow), "E2eNeedsArgsView.axaml");
        fs.writeFileSync(
            view,
            `<UserControl xmlns="https://github.com/avaloniaui" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"\n` +
                `             xmlns:vm="using:${ns}" x:DataType="vm:E2eNeedsArgsViewModel" Width="300" Height="100">\n` +
                `    <TextBlock Text="{Binding Title}" />\n` +
                `</UserControl>`
        );
        try {
            const doc = await vscode.workspace.openTextDocument(view);
            await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
            const line = new vscode.Range(1, 0, 1, 10);
            let action: vscode.CodeAction | undefined;
            for (let i = 0; i < 20 && !action; i++) {
                const actions =
                    (await vscode.commands.executeCommand<vscode.CodeAction[]>("vscode.executeCodeActionProvider", doc.uri, line)) ?? [];
                action = actions.find((a) => a.title.startsWith("Create a design-time view model"));
                if (!action) {
                    await sleep(1000);
                }
            }
            assert.ok(action?.command, "quick fix not offered");
            console.log(`[e2e] quick fix: ${action.title}`);
            await vscode.commands.executeCommand(action.command.command, ...(action.command.arguments ?? []));
            const generated = fs.readFileSync(design, "utf8");
            console.log(`[e2e] generated:\n${generated}`);
            assert.ok(generated.includes("public class DesignE2eNeedsArgsViewModel : E2eNeedsArgsViewModel {"));
            assert.ok(generated.includes("base(default!, default!)"));
            assert.ok(doc.getText().includes("<vm:DesignE2eNeedsArgsViewModel />"), "Design.DataContext not added");
            assert.ok(!doc.isDirty, "view not saved");
            const s = await waitFor("design data preview", (s) => sizeIs(s, 300, 100) && !s.building && noXamlError(s), 180000);
            assert.ok(!s.lastXaml?.error, `preview error: ${JSON.stringify(s.lastXaml)}`);
        } finally {
            await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
            for (const f of [view, vm, design]) {
                fs.rmSync(f, { force: true });
            }
            await showMain();
        }
    });

    test("outline: element tree with names, keys and selectors", async () => {
        await showMain();
        let symbols: vscode.DocumentSymbol[] = [];
        for (let i = 0; i < 15 && !symbols.length; i++) {
            symbols =
                (await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
                    "vscode.executeDocumentSymbolProvider",
                    editor.document.uri
                )) ?? [];
            if (!symbols.length) {
                await sleep(1000);
            }
        }
        const describe = (s: vscode.DocumentSymbol, depth = 0): string[] => [
            `${"  ".repeat(depth)}${s.name}${s.detail ? ` [${s.detail}]` : ""}`,
            ...s.children.flatMap((c) => describe(c, depth + 1)),
        ];
        const lines = symbols.flatMap((s) => describe(s));
        console.log(`[e2e] outline:\n${lines.join("\n")}`);
        assert.strictEqual(symbols.length, 1, "one root element");
        assert.ok(symbols[0].name.startsWith("Window"), "the root is the Window");
        assert.ok(symbols[0].children.length > 0, "the root has children");
        const root = symbols[0];
        assert.ok(root.range.start.line === 0 && root.range.end.line >= editor.document.lineCount - 2, "the root spans the file");
    });

    test("inlay hints show the type of binding paths", async () => {
        await showMain();
        const text = editor.document.getText();
        const hints = async () => {
            let list: vscode.InlayHint[] = [];
            for (let i = 0; i < 20 && !list.length; i++) {
                list =
                    (await vscode.commands.executeCommand<vscode.InlayHint[]>(
                        "vscode.executeInlayHintProvider",
                        editor.document.uri,
                        new vscode.Range(0, 0, editor.document.lineCount, 0)
                    )) ?? [];
                if (!list.length) {
                    await sleep(1000);
                }
            }
            return list.map((h) => ({
                line: h.position.line,
                character: h.position.character,
                label: typeof h.label === "string" ? h.label : h.label.map((p) => p.value).join(""),
            }));
        };
        const at = text.indexOf("<TextBlock");
        assert.ok(at > 0, "no TextBlock in the main window");
        const pos = editor.document.positionAt(at);
        const binding = '<TextBlock Text="{Binding Greeting}" />';
        await editor.edit((e) => e.insert(pos, binding));
        try {
            const list = await hints();
            console.log(`[e2e] inlay hints: ${JSON.stringify(list)}`);
            const end = pos.translate(0, binding.indexOf("}") + 1);
            const hint = list.find((h) => h.line === end.line && h.character === end.character);
            assert.ok(hint, "no hint after {Binding Greeting}");
            assert.strictEqual(hint.label, ": string");
        } finally {
            await editor.edit((e) => e.delete(new vscode.Range(pos, pos.translate(0, binding.length))));
        }
    });

    test("closing tag and prefixed completions replace the typed text (#166)", async () => {
        const closing = await applyCompletion("<Grid></", "/Grid>");
        assert.ok(closing.startsWith("<Grid></Grid>"), `closing tag: ${closing}`);
        // Avalonia 12 template: MainViewModel, Avalonia 11: MainWindowViewModel
        const prefixed = await applyCompletion("<vm:Ma", "vm:Main*");
        assert.ok(/^<vm:Main\w*ViewModel/.test(prefixed), `prefixed: ${prefixed}`);
        console.log(`[e2e] completion applied: ${closing.substring(0, 14)} | ${prefixed.substring(0, 18)}`);
    });

    test("completion picks up new types after a build without restarting VS Code", async () => {
        const vmDir = [path.join(workspace, "ViewModels"), path.join(workspace, path.basename(workspace), "ViewModels")].find((d) =>
            fs.existsSync(d)
        );
        if (!vmDir || !fs.existsSync(path.join(vmDir, "ViewModelBase.cs"))) {
            console.log("[e2e] skipped: not a C# MVVM project");
            return;
        }
        const ns = /namespace\s+([\w.]+)/.exec(fs.readFileSync(path.join(vmDir, "ViewModelBase.cs"), "utf8"))![1];
        const file = path.join(vmDir, "E2eAddedControl.cs");
        fs.writeFileSync(file, `namespace ${ns};\npublic class E2eAddedControl : Avalonia.Controls.TextBlock { }\n`);
        try {
            // the type can be known from the source already; after the build it must be known in any case
            await vscode.commands.executeCommand("axamlLive.createPreviewerAssets");
            await waitFor("ready after build", (s) => s.sessionState === "ready" && !s.building, 180000);
            const after = await completionLabels("<vm:");
            console.log(`[e2e] completion for <vm: after build: ${after.join(", ")}`);
            assert.ok(
                after.some((l) => l.endsWith("E2eAddedControl")),
                "new type not in completion after build"
            );
        } finally {
            fs.rmSync(file, { force: true });
        }
    });

    test("New Avalonia Item creates a UserControl the preview can show", async () => {
        const views = path.dirname(mainWindow);
        const created = await vscode.commands.executeCommand<vscode.Uri>("axamlLive.newItem", vscode.Uri.file(views), {
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
            assert.ok(ns?.endsWith(".Views") || /x:Class="[\w.]*\.Views\.E2eUserControl"/.test(xaml), `unexpected namespace ${ns}`);
            // the preview follows the new file; build so its code-behind exists, then it must render without errors
            await waitFor(
                "preview follows new file",
                (s) => !!s.panelState?.message?.includes("E2eUserControl.axaml") || s.panelState?.status === "starting",
                30000
            );
            const started = (await state()).sessionsStarted;
            await vscode.commands.executeCommand("axamlLive.createPreviewerAssets");
            const s = await waitFor(
                "ready after build",
                (s) => s.sessionsStarted > started && s.sessionState === "ready" && !!s.lastXaml,
                180000
            );
            assert.ok(
                !s.lastXaml?.error && !s.lastXaml?.message,
                `new UserControl preview error: ${s.lastXaml?.message ?? s.lastXaml?.error}`
            );
            await checkpoint("new-usercontrol");
        } finally {
            await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
            if (created) {
                fs.rmSync(created.fsPath, { force: true });
                fs.rmSync(created.fsPath + ".cs", { force: true });
                fs.rmSync(created.fsPath + ".fs", { force: true });
                for (const proj of fs.readdirSync(workspace).filter((f) => f.endsWith(".fsproj"))) {
                    const p = path.join(workspace, proj);
                    fs.writeFileSync(
                        p,
                        fs
                            .readFileSync(p, "utf8")
                            .split(/\r?\n/)
                            .filter((l) => !l.includes("E2eUserControl"))
                            .join("\r\n")
                    );
                }
            }
            await showMain();
        }
    });

    test("previewer host project setting is honored (#207, #200)", async () => {
        const before = await state();
        const config = vscode.workspace.getConfiguration("axamlLive.previewer");
        try {
            await config.update("hostProject", "DoesNotExist", vscode.ConfigurationTarget.Workspace);
            let s = await waitFor(
                "restart with unknown host",
                (s) => s.sessionsStarted > before.sessionsStarted && s.sessionState === "ready",
                120000
            );
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

    test("Show Code-behind and Show ViewModel", async () => {
        await showMain();
        await vscode.commands.executeCommand("axamlLive.showCodeBehind");
        let active = vscode.window.activeTextEditor!;
        assert.ok(/MainWindow\.axaml\.(cs|fs)$/.test(active.document.fileName), `code-behind: ${active.document.fileName}`);
        await showMain();
        await vscode.commands.executeCommand("axamlLive.showViewModel");
        active = vscode.window.activeTextEditor!;
        const line = active.document.lineAt(active.selection.active.line).text;
        console.log(`[e2e] view model: ${path.basename(active.document.fileName)}: ${line.trim()}`);
        assert.ok(/\b(class|type|record)\s+Main(Window)?ViewModel\b/.test(line), `view model declaration: ${line}`);
        await showMain();
    });

    test("Format Document uses the AXAML formatter and its settings", async () => {
        await showMain();
        const config = vscode.workspace.getConfiguration("axamlLive.formatting");
        const original = editor.document.getText();
        try {
            await config.update("attributeWrapThreshold", 1, vscode.ConfigurationTarget.Global);
            // mess up indentation
            await editor.edit((e) =>
                e.replace(
                    new vscode.Range(editor.document.positionAt(0), editor.document.positionAt(original.length)),
                    original.replace(/^\s+/gm, "")
                )
            );
            // the real "Format Document" action: uses the default formatter for AXAML (other extensions may also format XAML)
            editor.options = { tabSize: 4, insertSpaces: true };
            await vscode.commands.executeCommand("editor.action.formatDocument");
            const formatted = editor.document.getText();
            assert.match(formatted, /\n    <[A-Za-z]/, "children indented");
            assert.match(formatted, /<Window xmlns="[^"]+"\r?\n\s+xmlns:/, "attributes wrapped over the threshold");
            await vscode.commands.executeCommand("editor.action.formatDocument");
            assert.strictEqual(editor.document.getText(), formatted, "formatting is idempotent");
        } finally {
            await config.update("attributeWrapThreshold", undefined, vscode.ConfigurationTarget.Global);
            await editor.edit((e) =>
                e.replace(
                    new vscode.Range(editor.document.positionAt(0), editor.document.positionAt(editor.document.getText().length)),
                    original
                )
            );
            await editor.document.save();
        }
    });

    test("attribute quote style for completions", async () => {
        const config = vscode.workspace.getConfiguration("axamlLive.editor");
        try {
            await config.update("attributeQuoteStyle", "single", vscode.ConfigurationTarget.Global);
            await showMain();
            const pos = editor.document.positionAt(editor.document.getText().lastIndexOf("</Window>"));
            await editor.edit((e) => e.insert(pos, "<Button "));
            const at = pos.translate(0, "<Button ".length);
            const list = await vscode.commands.executeCommand<vscode.CompletionList>(
                "vscode.executeCompletionItemProvider",
                editor.document.uri,
                at
            );
            // snippets (axaml.json) are fixed text; the setting is for attribute completion
            const texts = list.items
                .filter((i) => i.kind !== vscode.CompletionItemKind.Snippet)
                .map(
                    (i) =>
                        (i.textEdit as vscode.TextEdit | undefined)?.newText ??
                        (typeof i.insertText === "string" ? i.insertText : (i.insertText?.value ?? ""))
                );
            const withQuotes = texts.filter((t) => /=['"]/.test(t));
            console.log(`[e2e] attribute completions: ${withQuotes.slice(0, 3).join(" | ")}`);
            assert.ok(withQuotes.length > 0, "no attribute completions");
            assert.ok(
                withQuotes.every((t) => t.includes("=''")),
                "single quotes expected"
            );
            await vscode.commands.executeCommand("undo");
        } finally {
            await config.update("attributeQuoteStyle", undefined, vscode.ConfigurationTarget.Global);
        }
    });

    test("🎨 style badges on elements matched by a Style in the file", async () => {
        await showMain();
        const text = editor.document.getText();
        const insertAt = editor.document.positionAt(text.indexOf(">", text.indexOf("<Window")) + 1);
        const root = /<(\w+)/.exec(text.substring(text.indexOf("<Window")))![1];
        await editor.edit((e) =>
            e.insert(insertAt, `\n    <${root}.Styles><Style Selector="TextBox, TextBlock, ContentControl"/></${root}.Styles>`)
        );
        try {
            const s = await waitFor("badges", (s) => (s.styleBadges ?? 0) >= 1, 10000);
            console.log(`[e2e] style badges: ${s.styleBadges}`);
            await checkpoint("style-badges");
        } finally {
            await vscode.commands.executeCommand("undo");
            await editor.document.save();
        }
        await waitFor("badges cleared", (s) => (s.styleBadges ?? 0) === 0, 10000);
    });

    test("Install / update Avalonia templates", async () => {
        const ok = await vscode.commands.executeCommand<boolean>("axamlLive.installTemplates");
        assert.strictEqual(ok, true);
    });

    test("Run and Debug the project", async () => {
        for (const debug of [false, true]) {
            const started = new Promise<vscode.DebugSession>((resolve) => {
                const d = vscode.debug.onDidStartDebugSession((s) => {
                    d.dispose();
                    resolve(s);
                });
            });
            const ok = await vscode.commands.executeCommand<boolean>("axamlLive.runProject", { debug });
            assert.strictEqual(ok, true, `runProject debug=${debug}`);
            const session = await Promise.race([started, sleep(120000).then(() => undefined)]);
            assert.ok(session, `no debug session (debug=${debug})`);
            assert.strictEqual(!!session!.configuration.noDebug, !debug);
            await sleep(3000);
            await checkpoint(debug ? "debugging" : "running");
            await vscode.debug.stopDebugging(session);
            await sleep(1500);
        }
    });

    test("previewer host from the launch configuration", async () => {
        const before = await state();
        const launchDir = path.join(workspace, ".vscode");
        const launchFile = path.join(launchDir, "launch.json");
        const hadLaunch = fs.existsSync(launchFile) ? fs.readFileSync(launchFile, "utf8") : undefined;
        const config = vscode.workspace.getConfiguration("axamlLive.previewer");
        try {
            const target = (await vscode.commands.executeCommand<{ targetPath: string }>("axamlLive.debug.hostInfo"))!.targetPath;
            fs.mkdirSync(launchDir, { recursive: true });
            fs.writeFileSync(
                launchFile,
                JSON.stringify(
                    { version: "0.2.0", configurations: [{ name: "e2e", type: "coreclr", request: "launch", program: target }] },
                    null,
                    2
                )
            );
            await config.update("syncWithLaunchConfig", true, vscode.ConfigurationTarget.Workspace);
            const s = await waitFor(
                "restart with launch host",
                (s) => s.sessionsStarted > before.sessionsStarted && s.sessionState === "ready",
                120000
            );
            const info = await vscode.commands.executeCommand<{ source: string }>("axamlLive.debug.hostInfo");
            assert.strictEqual(info!.source, "launch.json");
            assert.strictEqual(s.project, before.project);
        } finally {
            await config.update("syncWithLaunchConfig", undefined, vscode.ConfigurationTarget.Workspace);
            if (hadLaunch === undefined) {
                fs.rmSync(launchFile, { force: true });
            } else {
                fs.writeFileSync(launchFile, hadLaunch);
            }
            await waitFor("ready again", (s) => s.sessionState === "ready", 120000);
        }
    });

    const lspFile = path.join(path.dirname(mainWindow), "E2eLsp.axaml");
    // an internal class of the project (usable from its own XAML, missing from the public metadata)
    const internalFile = path.join(path.dirname(mainWindow), "..", "ViewModels", "E2eInternal.cs");
    const mainText = () => fs.readFileSync(mainWindow, "utf8");
    const vmName = () => /x:DataType="\w+:(\w+)"/.exec(mainText())?.[1] ?? "MainViewModel";
    const vmNamespace = () => /xmlns:vm="using:([\w.]+)"/.exec(mainText())?.[1] ?? "";
    const isCSharp = () => fs.existsSync(mainWindow + ".cs");
    let lspDoc: vscode.TextDocument;
    const avaloniaDiagnostics = () => vscode.languages.getDiagnostics(lspDoc.uri).filter((d) => d.source === "AXAML Live");
    const posOf = (text: string, delta = 1) => lspDoc.positionAt(lspDoc.getText().indexOf(text) + delta);
    const waitForDiagnostics = async (what: string, pred: (d: vscode.Diagnostic[]) => boolean, timeout = 90000) => {
        const end = Date.now() + timeout;
        while (!pred(avaloniaDiagnostics())) {
            if (Date.now() > end) {
                throw new Error(
                    `Timed out waiting for diagnostics: ${what}. Got: ${avaloniaDiagnostics()
                        .map((d) => d.message)
                        .join(" | ")}`
                );
            }
            await sleep(500);
        }
        return avaloniaDiagnostics();
    };

    test("XAML diagnostics without building (unknown types, properties, binding paths)", async () => {
        if (isCSharp()) {
            fs.writeFileSync(
                internalFile,
                `namespace ${vmNamespace()};
internal class E2eInternalThing : Avalonia.Controls.Control { }
`
            );
        }
        fs.writeFileSync(
            lspFile,
            `<UserControl xmlns="https://github.com/avaloniaui"
             xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
             xmlns:vm="using:${vmNamespace()}"
             x:DataType="vm:${vmName()}">
    <StackPanel>
        <Button Content="{Binding Greeting}"/>
        <Buton Content="x"/>
        <Button Contnet="x"/>
        <TextBlock Text="{Binding Greting}"/>
        <TextBlock Text="{Binding E2eGenerated}"/>
        <ItemsControl>
            <ItemsControl.ItemTemplate>
                <DataTemplate DataType="vm:${vmName()}">
                    <TextBlock Text="{Binding Greeting}"/>
                </DataTemplate>
            </ItemsControl.ItemTemplate>
        </ItemsControl>
        <ItemsControl>
            <ItemsControl.ItemTemplate>
                <DataTemplate>
                    <TextBlock Text="{Binding ItemOnlyProperty}"/>
                </DataTemplate>
            </ItemsControl.ItemTemplate>
        </ItemsControl>
        <Grid>
            <vm:${vmName()} Grid.Row="1"/>
        </Grid>
        ${isCSharp() ? "<vm:E2eInternalThing/>" : ""}
        <ListBox DisplayMemberBinding="{Binding ItemMemberOnly}" Classes.Accent="{Binding Greeting}"/>
    </StackPanel>
</UserControl>
`
        );
        lspDoc = await vscode.workspace.openTextDocument(lspFile);
        await vscode.window.showTextDocument(lspDoc, vscode.ViewColumn.One);
        const diags = await waitForDiagnostics("Buton, Contnet, Greting", (d) =>
            ["Buton", "Contnet", "Greting"].every((w) => d.some((x) => x.message.includes(w)))
        );
        console.log(`[e2e] diagnostics: ${diags.map((d) => `${d.range.start.line + 1}: ${d.message}`).join(" | ")}`);
        assert.ok(!diags.some((d) => d.message.includes("'Greeting'")), "valid binding reported");
        assert.ok(!diags.some((d) => /StackPanel|UserControl/.test(d.message)), "valid elements reported");
        // DataTemplate DataType="..." (no x:) sets the binding scope; templates without a type are not validated
        assert.ok(!diags.some((d) => d.message.includes("ItemOnlyProperty")), "binding inside an untyped DataTemplate reported");
        assert.strictEqual(
            diags.filter((d) => d.message.includes("'Greeting'")).length,
            0,
            "binding inside DataTemplate DataType reported"
        );
        // an unprefixed attached property on a prefixed element is resolved in the default namespace
        assert.ok(!diags.some((d) => d.message.includes("Type 'Grid' not found")), "Grid.Row on a prefixed element reported");
        // a binding assigned to a binding-typed property (DisplayMemberBinding) is evaluated per item
        assert.ok(!diags.some((d) => d.message.includes("ItemMemberOnly")), "binding assigned to a BindingBase property reported");
        // Classes.Name="{Binding}" toggles a style class
        assert.ok(!diags.some((d) => d.message.includes("'Accent'")), "Classes.Name reported");
        // internal types of the project resolve (the new .cs file reaches the live compilation shortly)
        await waitForDiagnostics("internal type resolved", (d) => !d.some((x) => x.message.includes("E2eInternalThing")), 30000);
        const buton = diags.find((d) => d.message.includes("Buton"))!;
        assert.strictEqual(lspDoc.getText(buton.range), "Buton");
        await checkpoint("lsp-diagnostics");
    });

    test("code fixes for unknown names", async () => {
        const buton = avaloniaDiagnostics().find((d) => d.message.includes("Buton"))!;
        const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
            "vscode.executeCodeActionProvider",
            lspDoc.uri,
            buton.range
        );
        const fix = actions.find((a) => /Button/.test(a.title));
        assert.ok(fix?.edit, `no fix among: ${actions.map((a) => a.title).join(", ")}`);
        await vscode.workspace.applyEdit(fix!.edit!);
        assert.ok(lspDoc.getText().includes('<Button Content="x"/>'));
        await waitForDiagnostics("Buton fixed", (d) => !d.some((x) => x.message.includes("Buton")), 30000);
        const prop = avaloniaDiagnostics().find((d) => d.message.includes("Contnet"))!;
        const propFix = (
            await vscode.commands.executeCommand<vscode.CodeAction[]>("vscode.executeCodeActionProvider", lspDoc.uri, prop.range)
        ).find((a) => /Content/.test(a.title));
        assert.ok(propFix?.edit, "no property fix");
    });

    test("hover on elements and attributes", async () => {
        const hoverText = async (pos: vscode.Position) => {
            const hovers = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", lspDoc.uri, pos);
            return hovers
                .flatMap((h) => h.contents.map((c) => (typeof c === "string" ? c : (c as vscode.MarkdownString).value)))
                .join("\n");
        };
        const element = await hoverText(posOf("<Button Content", 2));
        console.log(`[e2e] hover element: ${element.replace(/\s+/g, " ").substring(0, 160)}`);
        assert.match(element, /Avalonia\.Controls\.Button/);
        const attribute = await hoverText(posOf('Content="{Binding Greeting', 2));
        console.log(`[e2e] hover attribute: ${attribute.replace(/\s+/g, " ").substring(0, 160)}`);
        assert.match(attribute, /Content/);
        const binding = await hoverText(posOf("Greeting}", 2));
        assert.match(binding, /Greeting/);
    });

    test("go to definition (x:DataType, binding path, x:Class)", async () => {
        const definition = async (doc: vscode.TextDocument, pos: vscode.Position) => {
            const locs = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
                "vscode.executeDefinitionProvider",
                doc.uri,
                pos
            );
            const l = locs?.[0];
            return l ? ("targetUri" in l ? { uri: l.targetUri, range: l.targetRange } : { uri: l.uri, range: l.range }) : undefined;
        };
        const vm = await definition(lspDoc, posOf(`vm:${vmName()}"`, 4));
        assert.ok(vm, "no definition for x:DataType");
        const vmDoc = await vscode.workspace.openTextDocument(vm!.uri);
        assert.match(vmDoc.lineAt(vm!.range.start.line).text, new RegExp(`\\b${vmName()}\\b`));
        const prop = await definition(lspDoc, posOf("Greeting}", 2));
        assert.ok(prop, "no definition for binding path");
        assert.match((await vscode.workspace.openTextDocument(prop!.uri)).lineAt(prop!.range.start.line).text, /Greeting/);
        const mainDoc = await vscode.workspace.openTextDocument(mainWindow);
        const cls = await definition(mainDoc, mainDoc.positionAt(mainDoc.getText().indexOf('x:Class="') + 12));
        assert.ok(cls, "no definition for x:Class");
        assert.ok(/MainWindow\.axaml\.(cs|fs)$/.test(cls!.uri.fsPath), `x:Class -> ${cls!.uri.fsPath}`);
        await vscode.window.showTextDocument(lspDoc, vscode.ViewColumn.One);
    });

    test("source-generated view model members are known without building", async function (this: Mocha.Context) {
        if (!isCSharp()) {
            await vscode.window.showTextDocument(lspDoc, vscode.ViewColumn.One);
            await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
            fs.rmSync(lspFile, { force: true });
            fs.rmSync(internalFile, { force: true });
            await showMain();
            this.skip();
        }
        const vmFile = [
            path.join(workspace, "ViewModels", `${vmName()}.cs`),
            path.join(workspace, path.basename(workspace), "ViewModels", `${vmName()}.cs`),
        ].find((f) => fs.existsSync(f))!;
        const original = fs.readFileSync(vmFile, "utf8");
        const builtDll = fs.statSync(path.join(workspace, "bin")).mtimeMs;
        try {
            assert.ok(
                avaloniaDiagnostics().some((d) => d.message.includes("E2eGenerated")),
                "E2eGenerated should be unknown before the change"
            );
            const changed = original.replace(
                /(class\s+\w+[^{]*\{)/,
                `$1\n    [CommunityToolkit.Mvvm.ComponentModel.ObservableProperty] private string _e2eGenerated = "gen";\n`
            );
            const vmDoc = await vscode.workspace.openTextDocument(vmFile);
            const ed = await vscode.window.showTextDocument(vmDoc, vscode.ViewColumn.One);
            await ed.edit((e) => e.replace(new vscode.Range(vmDoc.positionAt(0), vmDoc.positionAt(vmDoc.getText().length)), changed));
            await vmDoc.save();
            await vscode.window.showTextDocument(lspDoc, vscode.ViewColumn.One);
            await waitForDiagnostics(
                "E2eGenerated known",
                (d) => !d.some((x) => x.message.includes("E2eGenerated")) && d.some((x) => x.message.includes("Greting")),
                120000
            );
            const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
                "vscode.executeHoverProvider",
                lspDoc.uri,
                posOf("E2eGenerated}", 2)
            );
            const text = hovers
                .flatMap((h) => h.contents.map((c) => (typeof c === "string" ? c : (c as vscode.MarkdownString).value)))
                .join(" ");
            console.log(`[e2e] hover generated: ${text.replace(/\s+/g, " ").substring(0, 160)}`);
            assert.match(text, /E2eGenerated/);
            assert.match(text, /string/i);
            assert.strictEqual(fs.statSync(path.join(workspace, "bin")).mtimeMs, builtDll, "must not need a build");
            await checkpoint("lsp-generated");
        } finally {
            const vmDoc = await vscode.workspace.openTextDocument(vmFile);
            const ed = await vscode.window.showTextDocument(vmDoc, vscode.ViewColumn.One);
            await ed.edit((e) => e.replace(new vscode.Range(vmDoc.positionAt(0), vmDoc.positionAt(vmDoc.getText().length)), original));
            await vmDoc.save();
            await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
            await vscode.window.showTextDocument(lspDoc, vscode.ViewColumn.One);
            await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
            fs.rmSync(lspFile, { force: true });
            fs.rmSync(internalFile, { force: true });
            await showMain();
        }
    });

    test("Restart command", async () => {
        const started = (await state()).sessionsStarted;
        await vscode.commands.executeCommand("axamlLive.restartPreviewer");
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

        // to a C# file and back: the unchanged view is not loaded again (scroll position and input stay)
        await waitFor("result of the switch", (s) => (s.xamlResults ?? 0) > 0 && noXamlError(s), 30000);
        await sleep(1000);
        const results = (await state()).xamlResults ?? 0;
        const cs = fs.readdirSync(path.dirname(mainWindow)).find((f) => f.endsWith(".axaml.cs"));
        assert.ok(cs, "code-behind next to MainWindow.axaml");
        await vscode.window.showTextDocument(
            await vscode.workspace.openTextDocument(path.join(path.dirname(mainWindow), cs)),
            vscode.ViewColumn.One
        );
        await sleep(500);
        editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(mainWindow), vscode.ViewColumn.One);
        await sleep(2000);
        assert.strictEqual((await state()).xamlResults ?? 0, results, "returning to an unchanged file must not reload the preview");
    });

    test("closing the preview stops the previewer", async () => {
        const pid = (await state()).previewerPid!;
        assert.ok(pid, "previewer pid");
        for (const group of vscode.window.tabGroups.all) {
            for (const tab of group.tabs) {
                if ((tab.input as any)?.viewType?.endsWith("avaloniaPreviewer")) {
                    await vscode.window.tabGroups.close(tab);
                }
            }
        }
        await waitFor("panel closed", (s) => !s.panel && !s.sessionState, 10000);
        await sleep(2000);
        let alive = true;
        try {
            process.kill(pid, 0);
        } catch {
            alive = false;
        }
        assert.strictEqual(alive, false, "previewer process still running after closing the panel");
        await checkpoint("closed");
    });

    test("auto-open preview when an AXAML file is opened", async () => {
        const config = vscode.workspace.getConfiguration("axamlLive.previewer");
        try {
            await config.update("autoOpen", true, vscode.ConfigurationTarget.Global);
            await vscode.commands.executeCommand("workbench.action.closeAllEditors");
            await sleep(500);
            await showMain();
            await waitFor("auto-opened preview", (s) => s.panel && s.sessionState === "ready", 120000);
            await checkpoint("auto-open");
        } finally {
            await config.update("autoOpen", undefined, vscode.ConfigurationTarget.Global);
        }
    });
});
