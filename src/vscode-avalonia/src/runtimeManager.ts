import * as vscode from "vscode";
import * as path from "path";
import { AppConstants, logger } from "./util/Utilities";

/**
 * The minimum version of the .NET runtime needed by the language server and the solution parser.
 */
const dotnetRuntimeVersion = "8.0"; // tools roll forward to the newest installed runtime

interface IDotnetAcquireResult {
	dotnetPath: string;
}

let cachedPath: string | undefined;

/**
 * Gets the path to a .NET runtime >= 9.0, preferring the globally installed one.
 */
export async function getDotnetRuntimePath(): Promise<string> {
	if (cachedPath) {
		return cachedPath;
	}
	const result = await vscode.commands.executeCommand<IDotnetAcquireResult>("dotnet.findPath", {
		acquireContext: {
			version: dotnetRuntimeVersion,
			requestingExtensionId: AppConstants.extensionId,
			mode: "runtime",
			installType: "global",
			architecture: process.arch,
		},
		versionSpecRequirement: "greater_than_or_equal",
	});

	if (!result?.dotnetPath) {
		const message = `.NET ${dotnetRuntimeVersion} or newer was not found. Please make sure it's installed globally.`;
		logger.error(message);
		throw new Error(message);
	}
	cachedPath = result.dotnetPath;
	return cachedPath;
}

export function getLanguageServerPath(context: vscode.ExtensionContext) {
	return path.join(context.extensionPath, "avaloniaServer", "AvaloniaLanguageServer.dll");
}
