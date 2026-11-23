/**
 * End-to-end test of the previewer in a real (visible) VS Code window.
 *
 *   node out/test/e2e/runE2E.js <path-to-avalonia-project-folder> [path-to-Code.exe]
 *
 * Env: E2E_SCREENSHOT_DIR - when set, a desktop screenshot is saved at each checkpoint (Windows).
 *      E2E_PAUSE_MS       - pause at each checkpoint so a human can watch (default 2500).
 */
import * as path from "path";
import * as os from "os";
import { runTests } from "@vscode/test-electron";

async function main() {
	const workspace = path.resolve(process.argv[2] ?? "");
	const vscodeExecutablePath = process.argv[3];
	const extensionDevelopmentPath = path.resolve(__dirname, "../../../");
	const extensionTestsPath = path.resolve(__dirname, "./index");

	try {
		await runTests({
			vscodeExecutablePath,
			extensionDevelopmentPath,
			extensionTestsPath,
			extensionTestsEnv: {
				E2E_WORKSPACE: workspace,
				E2E_AXAML: process.env.E2E_AXAML,
				E2E_BUILD_TARGET: process.env.E2E_BUILD_TARGET,
				E2E_SCREENSHOT_DIR: process.env.E2E_SCREENSHOT_DIR,
				E2E_PAUSE_MS: process.env.E2E_PAUSE_MS,
				E2E_GREP: process.env.E2E_GREP,
			},
			launchArgs: [
				workspace,
				"--user-data-dir",
				process.env.E2E_USER_DATA_DIR ?? path.join(os.tmpdir(), "avalonia-vscode-e2e-run"),
				// the official (closed source) extension contributes the same commands
				"--disable-extension",
				"AvaloniaTeam.vscode-avalonia",
				"--disable-workspace-trust",
				// use the real extensions folder: the .NET runtime extension is a dependency
				"--extensions-dir",
				process.env.E2E_EXTENSIONS_DIR ?? path.join(os.homedir(), ".vscode", "extensions"),
			],
		});
	} catch (err) {
		console.error("E2E failed", err);
		process.exit(1);
	}
}

main();
