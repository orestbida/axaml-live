import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs-extra";
import { spawn } from "child_process";
import { Command } from "../commandManager";
import { AppConstants, logger } from "../util/Utilities";

const templates = [
	{ label: "Window", key: "avalonia.window", description: "Window (.axaml + code-behind)" },
	{ label: "UserControl", key: "avalonia.usercontrol", description: "UserControl (.axaml + code-behind)" },
	{ label: "TemplatedControl", key: "avalonia.templatedcontrol", description: "Templated control (class + style)" },
	{ label: "Styles", key: "avalonia.styles", description: "Styles (.axaml)", noLanguage: true },
	{ label: "ResourceDictionary", key: "avalonia.resource", description: "Resource dictionary (.axaml)", noLanguage: true },
];

export interface NewItemArgs {
	template?: string;
	name?: string;
}

/**
 * Explorer context menu: create a Window / UserControl / ... in the selected folder (#38, #116, #128, #118).
 * Uses the Avalonia item templates (`dotnet new install Avalonia.Templates`).
 */
export class NewItemCommand implements Command {
	public readonly id = AppConstants.newItemCommandId;

	async execute(target?: vscode.Uri, args?: NewItemArgs): Promise<vscode.Uri | undefined> {
		const folder = await resolveFolder(target);
		if (!folder) {
			return;
		}

		const template =
			templates.find((t) => t.key === args?.template || t.label === args?.template) ??
			(await vscode.window.showQuickPick(templates, { placeHolder: "Avalonia item to create" }));
		if (!template) {
			return;
		}

		const name =
			args?.name ??
			(await vscode.window.showInputBox({
				prompt: `Name of the new ${template.label}`,
				value: template.label === "Window" ? "NewWindow" : `New${template.label}`,
				validateInput: (v) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(v) ? undefined : "Use a valid class name"),
			}));
		if (!name) {
			return;
		}

		const project = findProjectFile(folder);
		const isFSharp = project?.endsWith(".fsproj") ?? false;
		const ns = project ? getNamespace(project, folder) : undefined;

		const dotnetArgs = ["new", template.key, "-n", name, "-o", folder];
		if (ns) {
			dotnetArgs.push("--namespace", ns);
		}
		if (isFSharp && !template.noLanguage) {
			dotnetArgs.push("--language", "F#");
		}

		const created = path.join(folder, `${name}.axaml`);
		if (await fs.pathExists(created)) {
			vscode.window.showErrorMessage(`${name}.axaml already exists.`);
			return;
		}

		const before = new Set(await fs.readdir(folder));
		const result = await runDotnet(dotnetArgs, folder);
		if (!result.ok) {
			vscode.window.showErrorMessage(
				`Failed to create ${template.label}. Make sure the Avalonia templates are installed: dotnet new install Avalonia.Templates`,
				"Show Log"
			).then((r) => r && logger.show(true));
			return;
		}

		if (isFSharp && project) {
			// F# compiles only files listed in the project, in order
			const newFs = (await fs.readdir(folder)).filter((f) => f.endsWith(".fs") && !before.has(f));
			addFSharpCompileItems(project, newFs.map((f) => path.join(folder, f)));
		}

		const file = (await fs.pathExists(created)) ? created : undefined;
		if (file) {
			await vscode.window.showTextDocument(vscode.Uri.file(file));
			return vscode.Uri.file(file);
		}
	}
}

async function resolveFolder(target?: vscode.Uri): Promise<string | undefined> {
	let p = target?.fsPath ?? vscode.window.activeTextEditor?.document.uri.fsPath;
	if (p && (await fs.pathExists(p)) && !(await fs.stat(p)).isDirectory()) {
		p = path.dirname(p);
	}
	if (p) {
		return p;
	}
	const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: "Create here" });
	return picked?.[0].fsPath;
}

function findProjectFile(folder: string): string | undefined {
	let dir = folder;
	for (;;) {
		const proj = fs.readdirSync(dir).find((f) => f.endsWith(".csproj") || f.endsWith(".fsproj"));
		if (proj) {
			return path.join(dir, proj);
		}
		const parent = path.dirname(dir);
		if (parent === dir) {
			return undefined;
		}
		dir = parent;
	}
}

/** RootNamespace (or project name) + sub folders, like Visual Studio does. */
function getNamespace(projectFile: string, folder: string): string {
	const content = fs.readFileSync(projectFile, "utf-8");
	const root = /<RootNamespace>\s*([^<]+?)\s*<\/RootNamespace>/.exec(content)?.[1] ?? path.basename(projectFile).replace(/\.(cs|fs)proj$/, "");
	const rel = path.relative(path.dirname(projectFile), folder);
	const parts = [root, ...rel.split(path.sep).filter((s) => s && s !== ".")].map((s) =>
		s.replace(/[^A-Za-z0-9_.]/g, "_").replace(/^(\d)/, "_$1")
	);
	return parts.join(".");
}

/**
 * Inserts <Compile Include> items: after the last file of the same folder, otherwise before the
 * entry point files (ViewLocator / App / Program) which usually reference views.
 */
export function addFSharpCompileItems(projectFile: string, files: string[]) {
	if (!files.length) {
		return;
	}
	const projectDir = path.dirname(projectFile);
	let content = fs.readFileSync(projectFile, "utf-8");
	const eol = content.includes("\r\n") ? "\r\n" : "\n";
	const dirOf = (p: string) => path.posix.dirname(p.replace(/\\/g, "/"));
	for (const file of files) {
		const rel = path.relative(projectDir, file).split(path.sep).join("\\");
		if (content.includes(`Include="${rel}"`)) {
			continue;
		}
		const lines = content.split(/\r?\n/);
		const compile = lines
			.map((l, i) => ({ i, inc: /<Compile\s+Include="([^"]+)"/.exec(l)?.[1] }))
			.filter((x) => x.inc);
		const sameDir = compile.filter((c) => dirOf(c.inc!) === dirOf(rel));
		const entry = compile.find((c) => /^(ViewLocator|App\.axaml|App|Program|Main)\.fs$/i.test(c.inc!));
		let at: number;
		if (sameDir.length) {
			at = sameDir[sameDir.length - 1].i + 1;
		} else if (entry) {
			at = entry.i;
		} else if (compile.length) {
			at = compile[compile.length - 1].i;
		} else {
			logger.warn(`No <Compile> items found in ${projectFile}; add ${rel} manually.`);
			continue;
		}
		const indent = /^\s*/.exec(lines[compile.length ? compile[0].i : at])?.[0] ?? "    ";
		lines.splice(at, 0, `${indent}<Compile Include="${rel}" />`);
		content = lines.join(eol);
		logger.info(`Added ${rel} to ${path.basename(projectFile)}`);
	}
	fs.writeFileSync(projectFile, content, "utf-8");
}

function runDotnet(args: string[], cwd: string): Promise<{ ok: boolean }> {
	return new Promise((resolve) => {
		logger.info(`dotnet ${args.join(" ")}`);
		const proc = spawn("dotnet", args, { cwd, env: process.env });
		proc.stdout.on("data", (d) => logger.appendLine(d.toString().trim()));
		proc.stderr.on("data", (d) => logger.appendLine(d.toString().trim()));
		proc.on("error", (e) => {
			logger.error(`Failed to run dotnet: ${e.message}`);
			resolve({ ok: false });
		});
		proc.on("close", (code) => resolve({ ok: code === 0 }));
	});
}
