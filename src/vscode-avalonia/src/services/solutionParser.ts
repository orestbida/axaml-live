import * as fs from "fs-extra";
import * as path from "path";
import { spawn } from "child_process";
import * as vscode from "vscode";

import * as sln from "../models/solutionModel";
import { AppConstants, logger, samePath, isUnder } from "../util/Utilities";
import { getDotnetRuntimePath } from "../runtimeManager";
import { projectFromLaunchConfigurations } from "./launchConfig";

let _context: vscode.ExtensionContext;
let _model: sln.Solution | undefined;
let _parsing: Promise<sln.Solution | undefined> | undefined;

export function initSolutionService(context: vscode.ExtensionContext) {
	_context = context;
	_model = context.workspaceState.get<sln.Solution>(AppConstants.solutionData);
}

/**
 * Path of the solution JSON consumed by the language server.
 * It is workspace specific (no collisions between projects with the same name, see #171).
 */
export function getSolutionDataFile(context: vscode.ExtensionContext = _context): string {
	const dir = context.storageUri?.fsPath ?? context.globalStorageUri.fsPath;
	return path.join(dir, "solution.json");
}

export function getSolutionModel(): sln.Solution | undefined {
	return _model;
}

/**
 * Parses the solution (or project folder) with the SolutionParser tool.
 * Concurrent calls share the same run.
 */
export function buildSolutionModel(): Promise<sln.Solution | undefined> {
	_parsing ??= parseSolution().finally(() => (_parsing = undefined));
	return _parsing;
}

/** Returns the model, parsing it first if it doesn't exist yet. */
export async function ensureSolutionModel(): Promise<sln.Solution | undefined> {
	return _model ?? (await buildSolutionModel());
}

/**
 * Finds the solution file to use. Supports `.sln` and `.slnx` (#162).
 * When there are several, asks the user once and remembers the choice (#101).
 * Falls back to the workspace folder, which the parser scans for project files.
 */
async function getSolutionFile(): Promise<string | undefined> {
	const files = await vscode.workspace.findFiles("**/*.{sln,slnx}", "**/{bin,obj,node_modules,.git}/**");
	if (files.length === 0) {
		return vscode.workspace.workspaceFolders?.[0].uri.fsPath;
	}
	if (files.length === 1) {
		return files[0].fsPath;
	}

	const saved = _context.workspaceState.get<string>(AppConstants.selectedSolution);
	if (saved && files.some((f) => samePath(f.fsPath, saved))) {
		return saved;
	}
	return await pickSolution(files);
}

export async function selectSolution(): Promise<string | undefined> {
	const files = await vscode.workspace.findFiles("**/*.{sln,slnx}", "**/{bin,obj,node_modules,.git}/**");
	if (files.length === 0) {
		vscode.window.showInformationMessage("No .sln or .slnx files found in the workspace.");
		return;
	}
	const picked = await pickSolution(files);
	if (picked) {
		await buildSolutionModel();
	}
	return picked;
}

async function pickSolution(files: vscode.Uri[]): Promise<string | undefined> {
	const sorted = files.map((f) => f.fsPath).sort((a, b) => a.length - b.length);
	const picked = await vscode.window.showQuickPick(
		sorted.map((f) => ({ label: path.basename(f), description: vscode.workspace.asRelativePath(f), path: f })),
		{ placeHolder: "Multiple solutions found. Select the one to use for the Avalonia previewer" }
	);
	const result = picked?.path ?? sorted[0];
	await _context.workspaceState.update(AppConstants.selectedSolution, result);
	return result;
}

async function parseSolution(): Promise<sln.Solution | undefined> {
	const solutionPath = await getSolutionFile();
	if (!solutionPath) {
		logger.warn("No workspace folder; nothing to parse.");
		return undefined;
	}

	const parserLocation = path.join(_context.extensionPath, "solutionParserTool", "SolutionParser.dll");
	const dotnet = await getDotnetRuntimePath();

	const json = await new Promise<string>((resolve, reject) => {
		let stdout = "";
		let stderr = "";
		// no shell: arguments with spaces are passed safely (#41, #43)
		const parser = spawn(dotnet, [parserLocation, solutionPath], { env: process.env });
		logger.info(`Parsing solution: ${solutionPath}`);
		parser.stdout.on("data", (d) => (stdout += d.toString()));
		parser.stderr.on("data", (d) => (stderr += d.toString()));
		parser.on("error", (e) => reject(e));
		parser.on("close", (code) => {
			if (stderr.trim()) {
				code === 0 ? logger.info(stderr.trim()) : logger.warn(stderr.trim());
			}
			if (code === 0) {
				resolve(stdout);
			} else {
				reject(new Error(stderr.trim() || `Solution parser exited with code ${code}`));
			}
		});
	});

	const model = JSON.parse(json) as sln.Solution;
	_model = model;
	await _context.workspaceState.update(AppConstants.solutionData, model);

	const dataFile = getSolutionDataFile();
	await fs.ensureDir(path.dirname(dataFile));
	await fs.writeFile(dataFile, json, "utf-8");

	logger.info(`Solution parsed: ${model.projects.length} project(s), ${model.files.length} XAML file(s)`);
	return model;
}

/**
 * Finds the file in the solution model.
 * Paths are compared case-insensitively on Windows (VS Code lowercases the drive letter).
 * Files created after the last parse are matched to the project whose folder contains them.
 */
export function getFileDetails(filePath: string, solution = _model): sln.File | undefined {
	if (!solution) {
		return undefined;
	}
	const file = solution.files.find((f) => samePath(f.path, filePath));
	if (file) {
		return file;
	}

	const owner = solution.projects
		.filter((p) => p.directoryPath && isUnder(filePath, p.directoryPath))
		.sort((a, b) => b.directoryPath.length - a.directoryPath.length)[0];

	return owner ? { path: filePath, targetPath: owner.targetPath, projectPath: owner.path } : undefined;
}

function isExecutable(p: sln.Project) {
	return p.outputType === "WinExe" || p.outputType === "Exe";
}

/**
 * Picks the executable project that hosts the given file:
 * the file's own project if it is executable, otherwise an executable that references it
 * (e.g. the Desktop head of an `avalonia.xplat` solution, #155).
 */
export function getExecutableProject(solution: sln.Solution, file?: sln.File): sln.Project | undefined {
	const exes = solution.projects.filter(isExecutable);

	// explicit choice (#207, #200, #171): e.g. a test/host project for plugin libraries that no executable references
	const preferred = getPreferredHost();
	if (preferred) {
		const host = exes.find((p) => p.name === preferred.name || samePath(p.path, preferred.name));
		if (host) {
			lastHostSource = preferred.source;
			return host;
		}
		logger.warn(`Previewer host project "${preferred.name}" not found among executable projects; using automatic selection.`);
	}

	// the project started by the launch configuration (opt-in)
	if (vscode.workspace.getConfiguration("avalonia.previewer").get<boolean>("syncWithLaunchConfig", false)) {
		for (const folder of vscode.workspace.workspaceFolders ?? []) {
			const configs = vscode.workspace.getConfiguration("launch", folder.uri).get<any[]>("configurations", []);
			const host = projectFromLaunchConfigurations(configs, exes, folder.uri.fsPath);
			if (host) {
				lastHostSource = "launch.json";
				return host;
			}
		}
	}

	lastHostSource = "automatic";
	const withDesigner = exes.filter((p) => p.designerHostPath);
	const candidates = withDesigner.length ? withDesigner : exes;

	if (file) {
		const own = candidates.find((p) => samePath(p.path, file.projectPath));
		if (own) {
			return own;
		}
		const referencing = candidates.filter((p) => referencesProject(solution, p, file.projectPath, new Set()));
		if (referencing.length) {
			return referencing.find((p) => /desktop/i.test(p.name)) ?? referencing[0];
		}
	}
	return candidates.find((p) => /desktop/i.test(p.name)) ?? candidates[0];
}

/** How the last host project was chosen: picked, setting, launch.json or automatic. */
export let lastHostSource = "automatic";

/** Host chosen with "Select previewer host project" (workspace) or the `avalonia.previewer.hostProject` setting. */
function getPreferredHost(): { name: string; source: string } | undefined {
	const picked = _context?.workspaceState.get<string>(AppConstants.previewerHost);
	if (picked) {
		return { name: picked, source: "picked" };
	}
	const setting = vscode.workspace.getConfiguration("avalonia.previewer").get<string>("hostProject", "").trim();
	return setting ? { name: setting, source: "setting" } : undefined;
}

/** Lets the user pick the executable project that hosts the previewer; "Automatic" clears the choice. */
export async function selectPreviewerHost(): Promise<boolean> {
	const model = await ensureSolutionModel();
	const exes = model?.projects.filter(isExecutable) ?? [];
	if (!exes.length) {
		vscode.window.showInformationMessage("No executable projects (OutputType WinExe/Exe) found.");
		return false;
	}
	const current = getPreferredHost()?.name;
	const items = [
		{ label: "Automatic", description: "project that references the file, Desktop head preferred", value: "" },
		...exes.map((p) => ({
			label: p.name,
			description: vscode.workspace.asRelativePath(p.path) + (p.designerHostPath ? "" : " (not built)"),
			value: p.name,
		})),
	].map((i) => ({ ...i, picked: i.value === (current ?? "") }));
	const picked = await vscode.window.showQuickPick(items, { placeHolder: `Previewer host project (current: ${current ?? "Automatic"})` });
	if (!picked) {
		return false;
	}
	await _context.workspaceState.update(AppConstants.previewerHost, picked.value || undefined);
	return true;
}

/** True when `host` references the project at `projectPath`, directly or transitively. */
export function isProjectReferencedBy(solution: sln.Solution, host: sln.Project, projectPath: string): boolean {
	return referencesProject(solution, host, projectPath, new Set());
}

function referencesProject(solution: sln.Solution, from: sln.Project, target: string, seen: Set<string>): boolean {
	if (seen.has(from.path)) {
		return false;
	}
	seen.add(from.path);
	for (const ref of from.projectReferences ?? []) {
		if (samePath(ref, target)) {
			return true;
		}
		const refProject = solution.projects.find((p) => samePath(p.path, ref));
		if (refProject && referencesProject(solution, refProject, target, seen)) {
			return true;
		}
	}
	return false;
}
