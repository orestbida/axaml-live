/**
 * Previews every .axaml file of the workspace (read-only: the project is not modified) and reports per file:
 * previewer result (error or OK), rendered size, whether the frame is blank, language server diagnostics.
 * Run with E2E_SUITE=allFiles; E2E_REPORT=<json file> to save the report.
 */
import * as assert from "assert";
import * as path from "path";
import * as fs from "fs";
import * as vscode from "vscode";
import { e2eSetting, windowsScreenshot } from "./config";

const workspace = e2eSetting("E2E_WORKSPACE") ?? vscode.workspace.workspaceFolders![0].uri.fsPath;
const shotDir = e2eSetting("E2E_SCREENSHOT_DIR");
const reportFile = e2eSetting("E2E_REPORT");
const pauseMs = Number(e2eSetting("E2E_PAUSE_MS") ?? 1500);
const include = e2eSetting("E2E_INCLUDE"); // regex on the workspace-relative path (forward slashes)
const screenshotAll = e2eSetting("E2E_SCREENSHOT_ALL") === "1";
const extensions = (e2eSetting("E2E_EXT") ?? ".axaml").split(",").map((e) => e.trim().toLowerCase()); // e.g. ".axaml,.xaml"

const state = async () => (await vscode.commands.executeCommand<any>("axamlLive.debug.state"))!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(what: string, pred: (s: any) => boolean, timeout: number): Promise<any> {
    const end = Date.now() + timeout;
    let s = await state();
    let exitedSince: number | undefined;
    while (!pred(s)) {
        if (Date.now() > end) {
            throw new Error(`Timed out waiting for: ${what}`);
        }
        // the designer restarts by itself after a crash; give up when it stays down
        exitedSince = s.sessionState === "exited" ? (exitedSince ?? Date.now()) : undefined;
        if (exitedSince && Date.now() - exitedSince > 5000) {
            throw new Error(`Previewer stopped: ${s.lastCrash ?? s.panelState?.message}`);
        }
        await sleep(250);
        s = await state();
    }
    return s;
}

function axamlFiles(dir: string): string[] {
    const out: string[] = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory() && !["bin", "obj", ".git", "node_modules"].includes(e.name)) {
            out.push(...axamlFiles(p));
        } else if (e.isFile() && extensions.includes(path.extname(e.name).toLowerCase())) {
            out.push(p);
        }
    }
    return out.sort();
}

/**
 * E2E_INSPECT=1: select mode over each preview. The pointer moves over a grid of points and the highlighted elements are
 * reported; elements inside other views (labels "Element · View.axaml") are counted, and one of them is clicked, which
 * must select that element in its view's file while the preview stays on the file being inspected. Read-only too.
 */
const inspect = e2eSetting("E2E_INSPECT") === "1";
const previewCommand = (msg: object) => vscode.commands.executeCommand("axamlLive.debug.previewCommand", msg);
const selectModifiers = [0, 1, 2, 3]; // what the toolbar's select mode sends

async function inspectPreview(file: string, frame: { logicalWidth: number; logicalHeight: number }, r: FileReport) {
    await waitFor("designer hook", (s) => !!s.lastInspect, 30000);
    const labels = new Map<string, { x: number; y: number }>();
    const step = Math.max(25, Math.round(Math.min(frame.logicalWidth, frame.logicalHeight) / 10));
    for (let y = 4; y < frame.logicalHeight; y += step) {
        for (let x = 4; x < frame.logicalWidth; x += step) {
            await previewCommand({ type: "input", kind: "pointerMoved", x, y, modifiers: selectModifiers, select: true });
            await sleep(120);
            const label: string | undefined = (await state()).lastHighlight;
            if (label && !labels.has(label)) {
                labels.set(label, { x, y });
            }
        }
    }
    r.inspected = [...labels.keys()];
    const nested = [...labels.entries()].find(([label]) => label.includes(" · "));
    if (!nested) {
        return;
    }
    const [label, at] = nested;
    const before = (await state()).lastInspect;
    await previewCommand({
        type: "input",
        kind: "pointerPressed",
        x: at.x,
        y: at.y,
        button: 1,
        modifiers: [...selectModifiers, 4],
        select: true,
    });
    await previewCommand({ type: "input", kind: "pointerReleased", x: at.x, y: at.y, button: 1, modifiers: selectModifiers, select: true });
    await waitFor("select report", (s) => s.lastInspect?.kind === "select" && s.lastInspect !== before, 10000);
    await sleep(800);
    const viewFile = label.split(" · ").pop()!;
    const element = label.split(" ")[0];
    const editor = vscode.window.visibleTextEditors.find((e) => path.basename(e.document.uri.fsPath) === viewFile);
    const s = await state();
    r.nestedSelect =
        `${label}: ` +
        (editor ? `selected "${editor.document.getText(editor.selection)}" on line ${editor.selection.start.line + 1}` : "file not shown") +
        (s.file?.toLowerCase() === file.toLowerCase() ? ", preview stayed" : `, preview moved to ${s.file}`);
    if (!editor || editor.document.getText(editor.selection) !== element || s.file?.toLowerCase() !== file.toLowerCase()) {
        r.ok = false;
        r.crash = `nested select: ${r.nestedSelect}`;
    }
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file), vscode.ViewColumn.One);
}

interface FileReport {
    inspected?: string[];
    nestedSelect?: string;
    file: string;
    ok: boolean;
    previewError?: string;
    previewLine?: number;
    frame?: { logicalWidth: number; logicalHeight: number; avgLum: number };
    blank?: boolean;
    designDataContext?: boolean;
    crash?: string;
    language?: string;
    diagnostics: string[];
}

suite("All AXAML files (read-only)", () => {
    const files = axamlFiles(workspace).filter(
        (f) => !include || new RegExp(include).test(path.relative(workspace, f).split(path.sep).join("/"))
    );
    const report: FileReport[] = [];
    let first = true;

    suiteTeardown(() => {
        if (reportFile) {
            fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
        }
        for (const r of report) {
            console.log(
                `[report] ${r.ok ? "OK  " : "FAIL"} ${r.file}` +
                    (r.frame
                        ? ` ${r.frame.logicalWidth}x${r.frame.logicalHeight} lum=${r.frame.avgLum}${r.blank ? " (blank)" : ""}`
                        : " (no frame)") +
                    (r.designDataContext ? " [design data]" : "") +
                    (r.language && r.language !== "AXAML" ? ` [language ${r.language}]` : "") +
                    (r.previewError ? ` | preview: ${r.previewError}` : "") +
                    (r.crash ? ` | ${r.crash}` : "") +
                    (r.diagnostics.length ? ` | diagnostics: ${r.diagnostics.join(" ; ")}` : "")
            );
            if (r.inspected) {
                const nested = r.inspected.filter((l) => l.includes(" · "));
                console.log(
                    `[inspect] ${r.file}: ${r.inspected.length} elements, ${nested.length} inside other views` +
                        (nested.length ? ` (${nested.slice(0, 6).join(", ")})` : "") +
                        (r.nestedSelect ? ` | click: ${r.nestedSelect}` : "")
                );
            }
        }
    });

    for (const file of files) {
        const rel = path.relative(workspace, file);
        test(`preview ${rel}`, async () => {
            const wasFirst = first;
            const doc = await vscode.workspace.openTextDocument(file);
            const text = doc.getText();
            await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
            const before = await state();
            if (first) {
                await vscode.commands.executeCommand("axamlLive.showPreviewToSide", doc.uri);
                first = false;
            }
            const s = await waitFor(
                "XAML result for this file",
                (s) =>
                    s.sessionState === "ready" && s.file?.toLowerCase() === file.toLowerCase() && s.xamlResults > (before.xamlResults ?? 0),
                wasFirst ? 240000 : 60000
            );
            await sleep(pauseMs); // frames settle, language server analyzes
            const after = await state();
            const diags = vscode.languages
                .getDiagnostics(doc.uri)
                .filter((d) => d.source === "AXAML Live" || d.source === "AXAML Live Preview");
            const frame = after.preview?.frame;
            const r: FileReport = {
                file: rel,
                ok:
                    !(s.lastXaml?.error || s.lastXaml?.message) &&
                    !diags.some((d) => d.source === "AXAML Live" && d.severity === vscode.DiagnosticSeverity.Error),
                previewError: (s.lastXaml?.message ?? s.lastXaml?.error)?.split("\n")[0],
                previewLine: s.lastXaml?.line,
                frame: frame && { logicalWidth: frame.logicalWidth, logicalHeight: frame.logicalHeight, avgLum: frame.avgLum },
                diagnostics: diags.map((d) => `${d.source} ${d.range.start.line + 1}: ${d.message}`),
            };
            r.designDataContext = !!after.designDataContext;
            r.language = vscode.workspace.textDocuments.find((d) => d.uri.toString() === doc.uri.toString())?.languageId;
            if ((after.crashes ?? 0) > (before.crashes ?? 0)) {
                // the designer crashed (user code at design time, e.g. OnLoaded); the crash can surface while the next
                // file loads, so blame the file named in the crash when there is one
                const named = [r, ...report].find((x) => after.lastCrash?.includes(` in ${path.basename(x.file, ".axaml")}.`)) ?? r;
                named.crash = after.lastCrash;
                named.ok = false;
            }
            r.blank = !!frame && (frame.logicalWidth < 2 || frame.logicalHeight < 2);
            if (inspect && frame && !r.blank) {
                await inspectPreview(file, frame, r);
            }
            if (frame && frame.avgLum < 5) {
                console.log(
                    `[trace] ${rel} rendered black:\n  ${(after.trace ?? []).join("\n  ")}\n  -- session:\n  ${(after.sessionTrace ?? []).join("\n  ")}`
                );
            }
            report.push(r);
            if (shotDir && (screenshotAll || !r.ok || r.blank)) {
                windowsScreenshot(shotDir, `${String(report.length).padStart(2, "0")}-${path.basename(file)}.png`);
            }
            assert.strictEqual(doc.getText(), text, "the file must not be modified");
        });
    }

    test("all files preview without errors", () => {
        const failed = report.filter((r) => !r.ok);
        assert.strictEqual(
            failed.length,
            0,
            failed.map((f) => `${f.file}: ${f.crash ?? f.previewError ?? f.diagnostics.join("; ")}`).join("\n")
        );
    });
});
