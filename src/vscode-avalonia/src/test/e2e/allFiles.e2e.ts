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

const state = async () => (await vscode.commands.executeCommand<any>("avalonia.debug.state"))!;
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
		exitedSince = s.sessionState === "exited" ? exitedSince ?? Date.now() : undefined;
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
		} else if (e.isFile() && e.name.endsWith(".axaml")) {
			out.push(p);
		}
	}
	return out.sort();
}

interface FileReport {
	file: string;
	ok: boolean;
	previewError?: string;
	previewLine?: number;
	frame?: { logicalWidth: number; logicalHeight: number; avgLum: number };
	blank?: boolean;
	designDataContext?: boolean;
	crash?: string;
	diagnostics: string[];
}

suite("All AXAML files (read-only)", () => {
	const files = axamlFiles(workspace).filter((f) => !include || new RegExp(include).test(path.relative(workspace, f).split(path.sep).join("/")));
	const report: FileReport[] = [];
	let first = true;

	suiteTeardown(() => {
		if (reportFile) {
			fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
		}
		for (const r of report) {
			console.log(`[report] ${r.ok ? "OK  " : "FAIL"} ${r.file}` +
				(r.frame ? ` ${r.frame.logicalWidth}x${r.frame.logicalHeight} lum=${r.frame.avgLum}${r.blank ? " (blank)" : ""}` : " (no frame)") +
				(r.designDataContext ? " [design data]" : "") +
				(r.previewError ? ` | preview: ${r.previewError}` : "") +
				(r.crash ? ` | ${r.crash}` : "") +
				(r.diagnostics.length ? ` | diagnostics: ${r.diagnostics.join(" ; ")}` : ""));
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
				await vscode.commands.executeCommand("avalonia.showPreviewToSide", doc.uri);
				first = false;
			}
			const s = await waitFor(
				"XAML result for this file",
				(s) => s.sessionState === "ready" && s.file?.toLowerCase() === file.toLowerCase() && s.xamlResults > (before.xamlResults ?? 0),
				wasFirst ? 240000 : 60000
			);
			await sleep(pauseMs); // frames settle, language server analyzes
			const after = await state();
			const diags = vscode.languages.getDiagnostics(doc.uri).filter((d) => d.source === "Avalonia" || d.source === "Avalonia Previewer");
			const frame = after.preview?.frame;
			const r: FileReport = {
				file: rel,
				ok: !(s.lastXaml?.error || s.lastXaml?.message) && !diags.some((d) => d.source === "Avalonia" && d.severity === vscode.DiagnosticSeverity.Error),
				previewError: (s.lastXaml?.message ?? s.lastXaml?.error)?.split("\n")[0],
				previewLine: s.lastXaml?.line,
				frame: frame && { logicalWidth: frame.logicalWidth, logicalHeight: frame.logicalHeight, avgLum: frame.avgLum },
				diagnostics: diags.map((d) => `${d.source} ${d.range.start.line + 1}: ${d.message}`),
			};
			r.designDataContext = !!after.designDataContext;
			if ((after.crashes ?? 0) > (before.crashes ?? 0)) {
				// the designer crashed (user code at design time, e.g. OnLoaded); the crash can surface while the next
				// file loads, so blame the file named in the crash when there is one
				const named = [r, ...report].find((x) => after.lastCrash?.includes(` in ${path.basename(x.file, ".axaml")}.`)) ?? r;
				named.crash = after.lastCrash;
				named.ok = false;
			}
			r.blank = !!frame && (frame.logicalWidth < 2 || frame.logicalHeight < 2);
			if (frame && frame.avgLum < 5) {
				console.log(`[trace] ${rel} rendered black:\n  ${(after.trace ?? []).join("\n  ")}\n  -- session:\n  ${(after.sessionTrace ?? []).join("\n  ")}`);
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
		assert.strictEqual(failed.length, 0, failed.map((f) => `${f.file}: ${f.crash ?? f.previewError ?? f.diagnostics.join("; ")}`).join("\n"));
	});
});
