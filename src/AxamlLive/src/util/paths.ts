import * as path from "path";

const isWindows = process.platform === "win32";

export function normalizePath(p: string): string {
    const n = path.normalize(p).replace(/[\\/]+$/, "");
    return isWindows ? n.toLowerCase() : n;
}

/** Path equality that ignores drive letter / case differences on Windows. */
export function samePath(a: string | undefined, b: string | undefined): boolean {
    if (!a || !b) {
        return false;
    }
    return normalizePath(a) === normalizePath(b);
}

/** True when `child` is located inside `parent` folder. */
export function isUnder(child: string, parent: string): boolean {
    const c = normalizePath(child);
    const p = normalizePath(parent);
    return c.startsWith(p + path.sep);
}
