import * as path from "path";
import { samePath } from "../util/paths";

export interface HostCandidate {
    name: string;
    path: string;
    targetPath: string;
}

/**
 * Finds the executable project a launch configuration starts:
 * `coreclr` configurations by `program` (path, or assembly name when built for another configuration/TFM),
 * C# Dev Kit `dotnet` configurations by `projectPath`. The first matching configuration wins.
 */
export function projectFromLaunchConfigurations<T extends HostCandidate>(
    configs: any[],
    projects: T[],
    workspaceFolder: string
): T | undefined {
    const expand = (s: string) =>
        path.resolve(
            workspaceFolder,
            s.replace(/\$\{workspaceFolder(?::[^}]*)?\}/g, workspaceFolder).replace(/\$\{workspaceRoot\}/g, workspaceFolder)
        );

    for (const c of configs ?? []) {
        if (!c || (c.type !== "coreclr" && c.type !== "dotnet")) {
            continue;
        }
        if (typeof c.projectPath === "string") {
            const p = expand(c.projectPath);
            const match = projects.find((x) => samePath(x.path, p));
            if (match) {
                return match;
            }
        }
        if (typeof c.program === "string") {
            const program = expand(c.program);
            const exact = projects.find((x) => samePath(x.targetPath, program));
            if (exact) {
                return exact;
            }
            const assembly = path
                .basename(program)
                .replace(/\.(dll|exe)$/i, "")
                .toLowerCase();
            const byName = projects.find(
                (x) =>
                    path
                        .basename(x.targetPath)
                        .replace(/\.dll$/i, "")
                        .toLowerCase() === assembly
            );
            if (byName) {
                return byName;
            }
        }
    }
    return undefined;
}
