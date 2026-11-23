/**
 * End-to-end test of the previewer in a real (visible) VS Code window.
 *
 *   node out/test/e2e/runE2E.js <path-to-avalonia-project-folder> [path-to-Code.exe]
 *
 * Env: E2E_SCREENSHOT_DIR - when set, a desktop screenshot is saved at each checkpoint (Windows).
 *      E2E_PAUSE_MS       - pause at each checkpoint so a human can watch (default 2500).
 *      E2E_AXAML, E2E_BUILD_TARGET, E2E_GREP - see CONTRIBUTING.md
 *
 * Remote (e.g. WSL): set E2E_REMOTE=wsl+Ubuntu-22.04 and E2E_REMOTE_EXTENSION=<extension folder on the remote>;
 * the project folder argument is then a remote path. Settings for the remote test host are read from
 * out/test/e2e/e2e.config.json in the remote extension folder (environment variables don't reach it).
 */
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { runTests } from "@vscode/test-electron";

/** Test windows open maximized so the run is easy to watch (E2E_MAXIMIZED=0 to disable). */
function prepareUserSettings(userDataDir: string) {
	const file = path.join(userDataDir, "User", "settings.json");
	let settings: Record<string, unknown> = {};
	try {
		settings = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		/* new profile */
	}
	settings["window.newWindowDimensions"] = process.env.E2E_MAXIMIZED === "0" ? "default" : "maximized";
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(settings, null, 2));
}

async function main() {
	const userDataDir = process.env.E2E_USER_DATA_DIR ?? path.join(os.tmpdir(), "avalonia-vscode-e2e-run");
	prepareUserSettings(userDataDir);
	const remote = process.env.E2E_REMOTE;
	const vscodeExecutablePath = process.argv[3];

	let workspaceArgs: string[];
	let extensionDevelopmentPath: string;
	let extensionTestsPath: string;
	let workspace: string | undefined;

	if (remote) {
		const remoteExt = process.env.E2E_REMOTE_EXTENSION;
		if (!remoteExt || !process.argv[2]) {
			throw new Error("E2E_REMOTE requires E2E_REMOTE_EXTENSION and a remote project folder argument");
		}
		const uri = (p: string) => `vscode-remote://${remote}${p.startsWith("/") ? "" : "/"}${p}`;
		extensionDevelopmentPath = uri(remoteExt);
		extensionTestsPath = uri(`${remoteExt}/out/test/e2e/index`);
		// a vscode-remote folder URI selects the remote. Use the "=" form: "--remote x" or "--folder-uri <uri>"
		// as separate arguments make Code.exe exit with -1 when extension tests run
		workspaceArgs = [`--folder-uri=${uri(process.argv[2])}`];
	} else {
		workspace = path.resolve(process.argv[2] ?? "");
		extensionDevelopmentPath = path.resolve(__dirname, "../../../");
		extensionTestsPath = path.resolve(__dirname, "./index");
		workspaceArgs = [workspace];
	}

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
				E2E_SUITE: process.env.E2E_SUITE,
				E2E_REPORT: process.env.E2E_REPORT,
				E2E_INCLUDE: process.env.E2E_INCLUDE,
				E2E_SCREENSHOT_ALL: process.env.E2E_SCREENSHOT_ALL,
			},
			launchArgs: [
				...workspaceArgs,
				"--user-data-dir",
				userDataDir,
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
