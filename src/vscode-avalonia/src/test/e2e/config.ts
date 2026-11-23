import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";

/**
 * E2E settings: environment variables, or `e2e.config.json` next to the compiled tests.
 * The file is needed for remote runs (WSL/SSH): environment variables of the local
 * VS Code process do not reach the remote extension host.
 */
export function e2eSetting(name: string): string | undefined {
	if (process.env[name]) {
		return process.env[name];
	}
	try {
		const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "e2e.config.json"), "utf8"));
		return cfg[name] === undefined ? undefined : String(cfg[name]);
	} catch {
		return undefined;
	}
}

/**
 * Saves a screenshot of the Windows desktop. `dir` is a Windows path.
 * Works from Windows and from WSL (through `powershell.exe` interop).
 */
export function windowsScreenshot(dir: string, fileName: string) {
	const exe = process.platform === "win32" ? "powershell" : process.platform === "linux" ? "powershell.exe" : undefined;
	if (!exe) {
		return;
	}
	const file = dir.replace(/[\\/]+$/, "") + "\\" + fileName;
	const ps =
		`New-Item -ItemType Directory -Force '${dir}' | Out-Null;` +
		"Add-Type -AssemblyName System.Windows.Forms,System.Drawing;" +
		"$b=[System.Windows.Forms.SystemInformation]::VirtualScreen;" +
		"$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height;" +
		"$g=[System.Drawing.Graphics]::FromImage($bmp);" +
		"$g.CopyFromScreen($b.Left,$b.Top,0,0,$bmp.Size);" +
		`$bmp.Save('${file}');$g.Dispose();$bmp.Dispose()`;
	spawnSync(exe, ["-NoProfile", "-Command", ps]);
}
