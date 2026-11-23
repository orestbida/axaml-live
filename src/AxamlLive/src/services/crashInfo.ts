/**
 * Designer crashes: user code that throws on the UI thread at design time (e.g. an OnLoaded handler that casts a
 * null DataContext) terminates the whole designer process, not just one preview. No dependency on vscode.
 */

/** One-line description of why the designer process ended, from its output. */
export function summarizeCrash(log: string[], code: number | null, signal: string | null): string {
    const start = log.findIndex((l) => /Unhandled exception\./.test(l));
    if (start >= 0) {
        const rest = log.slice(start);
        const thrown = rest.map((l) => /([\w.]+(?:Exception|Error))\b:\s*(.*)/.exec(l)).find((m) => m);
        const frame = rest
            .map((l) => /^\s*at ([\w.`<>+]+)\.([\w<>`]+)\([^)]*\)(?: in (.+):line (\d+))?/.exec(l))
            .find((m) => m && !/^(System|Avalonia|Microsoft)\./.test(m[1]));
        if (thrown) {
            const exception = thrown[1].split(".").pop();
            const message = thrown[2].trim();
            // the designer starts the app through Program.BuildAvaloniaApp(), which apps started differently lack
            const noBuilder = /Unable to create AppBuilder from type "([^"]+)"/.exec(message);
            if (noBuilder) {
                return (
                    `Previewer cannot start the app: ${noBuilder[1]} has no BuildAvaloniaApp() method. The designer needs ` +
                    "`public static AppBuilder BuildAvaloniaApp()` returning the configured AppBuilder (Main can call it)."
                );
            }
            if (frame) {
                const type = frame[1].split(".").pop();
                let where = ` in ${type}.${frame[2]}`;
                if (frame[3]) {
                    where += ` (${frame[3].split(/[\\/]/).pop()}:${frame[4]})`;
                }
                return `Previewer crashed: ${exception}${where}`;
            }
            return `Previewer crashed: ${exception}${message ? `: ${message.slice(0, 200)}` : ""}`;
        }
    }
    if (code === null && signal) {
        return `Previewer process was terminated (${signal})`;
    }
    return `Previewer process exited with code ${code}`;
}

/**
 * Decides whether to restart the designer after a crash: yes, unless the same file crashed it twice in a row
 * without a file switch or an edit in between (which would restart forever; a crash in OnLoaded follows a successful load).
 */
export class CrashGuard {
    private _lastCrashFile: string | undefined;

    /** Returns true when the designer should be restarted. */
    public onCrash(file: string | undefined): boolean {
        if (file !== undefined && file === this._lastCrashFile) {
            return false;
        }
        this._lastCrashFile = file;
        return true;
    }

    /** The user switched files or edited: allow restarting again. */
    public reset() {
        this._lastCrashFile = undefined;
    }
}
