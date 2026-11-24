import type * as sm from "../models/solutionModel";

/**
 * Runs requests one at a time. A request made while a run is busy is merged into the next run (with any other
 * request made meanwhile), so runs never overlap and the next run always sees the state as it is then.
 */
export class RequestLoop<R> {
    private _pending: R | undefined;
    private _running: Promise<void> | undefined;
    private _stopped = false;

    constructor(
        private readonly _merge: (pending: R | undefined, next: R) => R,
        private readonly _run: (request: R) => Promise<void>
    ) {}

    /** Resolves when the loop is idle again (this request and all requests merged after it ran). */
    public request(r: R): Promise<void> {
        this._pending = this._merge(this._pending, r);
        this._running ??= this.loop();
        return this._running;
    }

    public get busy(): boolean {
        return !!this._running;
    }

    public stop() {
        this._stopped = true;
        this._pending = undefined;
    }

    private async loop() {
        try {
            while (this._pending !== undefined && !this._stopped) {
                const r = this._pending;
                this._pending = undefined;
                await this._run(r).catch(() => undefined); // the run reports its own errors
            }
        } finally {
            // synchronously after the last check: a request made from now on starts a new loop
            this._running = undefined;
        }
    }
}

/** What a run of the preview update loop has to do besides showing the current file. */
export interface PreviewRequest {
    /** Parse the solution again first (project files or build output changed). */
    reparse?: boolean;
    /** Start a new previewer even when the running one hosts the file. */
    restart?: boolean;
    /** Never build in this run (restarts after a crash or a stall). */
    noBuild?: boolean;
    /** Send the XAML even when the previewer already shows this exact text. */
    force?: boolean;
    /** The watchdog's own resend: it must not arm another resend. */
    noRetry?: boolean;
    /** Build first; each caller is told whether the build succeeded. */
    build?: { project?: sm.Project; done: ((ok: boolean) => void)[] };
}

/** Merges a request into the pending one: every wish is kept, and a run may build if any request allows it. */
export function mergePreviewRequests(pending: PreviewRequest | undefined, next: PreviewRequest): PreviewRequest {
    const p: PreviewRequest = { ...pending };
    p.reparse ||= next.reparse;
    p.restart ||= next.restart;
    p.force ||= next.force;
    // a resend by the watchdog stays a single resend only when nothing else asked for an update
    p.noRetry = (pending ? !!pending.noRetry : true) && !!next.noRetry;
    p.noBuild = (pending ? !!pending.noBuild : true) && !!next.noBuild;
    if (next.build || pending?.build) {
        p.build = {
            project: pending?.build?.project ?? next.build?.project,
            done: [...(pending?.build?.done ?? []), ...(next.build?.done ?? [])],
        };
    }
    return p;
}
