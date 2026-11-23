import * as vscode from "vscode";
import * as path from "path";
import { AppConstants, logger } from "./util/Utilities";

/**
 * The .NET runtime needed by the language server (net10.0) and the solution parser (net8.0, rolls forward).
 * The apps being previewed run on their own runtime; this one is only for the tools of this extension.
 */
const dotnetRuntimeVersion = "10.0";
const downloadUrl = "https://dotnet.microsoft.com/download/dotnet/10.0";

interface IDotnetAcquireResult {
    dotnetPath: string;
}

let pending: Promise<string> | undefined;

/**
 * Path of a .NET 10 (or newer) runtime: an installed one, otherwise a private copy downloaded by the .NET Install
 * Tool (no admin rights needed). Shows one clear message when neither works.
 */
export function getDotnetRuntimePath(): Promise<string> {
    pending ??= findOrAcquire().catch((e) => {
        pending = undefined; // try again next time (e.g. after installing .NET)
        throw e;
    });
    return pending;
}

async function findOrAcquire(): Promise<string> {
    const found: IDotnetAcquireResult | undefined = await vscode.commands
        .executeCommand<IDotnetAcquireResult>("dotnet.findPath", {
            acquireContext: {
                version: dotnetRuntimeVersion,
                requestingExtensionId: AppConstants.extensionId,
                mode: "runtime",
                installType: "global",
                architecture: process.arch,
            },
            versionSpecRequirement: "greater_than_or_equal",
        })
        .then(
            (r) => r,
            (e) => {
                logger.warn(`dotnet.findPath failed: ${e}`);
                return undefined;
            }
        );
    if (found?.dotnetPath) {
        return found.dotnetPath;
    }

    logger.info(`.NET ${dotnetRuntimeVersion} runtime not found; downloading it with the .NET Install Tool.`);
    const acquired: IDotnetAcquireResult | undefined = await vscode.commands
        .executeCommand<IDotnetAcquireResult>("dotnet.acquire", {
            version: dotnetRuntimeVersion,
            requestingExtensionId: AppConstants.extensionId,
        })
        .then(
            (r) => r,
            (e) => {
                logger.warn(`dotnet.acquire failed: ${e}`);
                return undefined;
            }
        );
    if (acquired?.dotnetPath) {
        return acquired.dotnetPath;
    }

    const message = `AXAML Live needs the .NET ${dotnetRuntimeVersion} runtime (or newer) for completion and diagnostics, and it could not be found or downloaded.`;
    logger.error(message);
    const download = "Download .NET";
    vscode.window.showErrorMessage(message, download).then((r) => r === download && vscode.env.openExternal(vscode.Uri.parse(downloadUrl)));
    throw new Error(message);
}

export function getLanguageServerPath(context: vscode.ExtensionContext) {
    return path.join(context.extensionPath, "avaloniaServer", "AvaloniaLanguageServer.dll");
}
