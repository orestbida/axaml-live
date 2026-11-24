import { FrameRateLimiter } from "./frameStats";

/** Time and timers, injected so the flow control can be tested with a fake clock. */
export interface FlowClock {
    now(): number;
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
}

export const systemClock: FlowClock = {
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/** What the flow control asks for. */
export interface FlowOutput<F> {
    /** Send FrameReceived for this sequence id: the designer renders its next frame only after it. */
    ack(sequenceId: number): void;
    /** Show the frame. */
    show(frame: F): void;
    /** Diagnostics trace. */
    log(event: string): void;
}

/**
 * Frame flow control between the extension and the designer, for one connection. No sockets and no real timers: the
 * session feeds it events and carries out what it asks for.
 *
 * The designer renders a window only while lastReceivedFrame == lastSentFrame, with
 * lastReceivedFrame = Math.Max(ack, lastReceivedFrame). Each XAML update creates a new window whose counters start at
 * 0, so an acknowledgement for a frame of the previous window (e.g. sequence 250 while an animation runs) that arrives
 * after the update blocks the new window forever. Therefore:
 * - an update cancels acknowledgements that are still waiting for the frame rate limit;
 * - while updates are pending, frames are held (not shown, not acknowledged) until the designer's result;
 * - on success, a held frame #1 is the new window's first frame (shown); any other held frame belongs to the closed
 *   window (dropped);
 * - on failure there is no new window: the previous one stays current and gets its held frame or the cancelled
 *   acknowledgement, or it would never render again.
 */
export class FrameFlow<F extends { sequenceId: number }> {
    private readonly _limiter: FrameRateLimiter;
    private _pendingUpdates = 0;
    private _held: F | undefined;
    private readonly _ackTimers = new Set<unknown>();
    private _lastAccepted: number | undefined;
    private _ackCancelled = false;
    private _disposed = false;

    constructor(
        private readonly _out: FlowOutput<F>,
        fps: number,
        private readonly _clock: FlowClock = systemClock
    ) {
        this._limiter = new FrameRateLimiter(fps);
    }

    public get pendingUpdates(): number {
        return this._pendingUpdates;
    }

    public setFps(fps: number) {
        this._limiter.setFps(fps);
    }

    /** An UpdateXaml message was sent: the designer will open a new window. */
    public updateSent() {
        if (this._ackTimers.size) {
            this._ackCancelled = true;
        }
        this._ackTimers.forEach((t) => this._clock.clearTimeout(t));
        this._ackTimers.clear();
        this._pendingUpdates++;
        this._out.log(`update pending=${this._pendingUpdates}`);
    }

    /** The designer answered an update. */
    public updateResult(failed: boolean) {
        this._pendingUpdates = Math.max(0, this._pendingUpdates - 1);
        this._out.log(
            `result ${failed ? "failed" : "ok"} pending=${this._pendingUpdates} held=${this._held ? "#" + this._held.sequenceId : "-"} ackCancelled=${this._ackCancelled}`
        );
        if (this._pendingUpdates > 0) {
            return;
        }
        const held = this._held;
        this._held = undefined;
        if (failed) {
            if (held) {
                this.accept(held);
            } else if (this._ackCancelled && this._lastAccepted !== undefined) {
                this.ack(this._lastAccepted);
            }
        } else if (held && held.sequenceId === 1) {
            this.accept(held);
        }
        this._ackCancelled = false;
    }

    /** A frame arrived. `drawable`: it has pixels (an empty frame is acknowledged but not shown). */
    public frame(frame: F, drawable: boolean) {
        if (this._pendingUpdates > 0) {
            this._out.log(`hold #${frame.sequenceId}${this._held ? ` (replaces #${this._held.sequenceId})` : ""}`);
            this._held = frame;
            return;
        }
        if (drawable) {
            this.accept(frame);
        } else {
            this.ack(frame.sequenceId);
        }
    }

    /** The connection is gone: nothing more is sent. */
    public dispose() {
        this._disposed = true;
        this._ackTimers.forEach((t) => this._clock.clearTimeout(t));
        this._ackTimers.clear();
        this._held = undefined;
    }

    private accept(frame: F) {
        this._lastAccepted = frame.sequenceId;
        // acknowledged before it is shown, so the designer renders while this frame travels to the webview; delaying
        // the acknowledgement caps the frame rate
        const delay = this._limiter.delay(this._clock.now());
        if (delay > 0) {
            const timer = this._clock.setTimeout(() => {
                this._ackTimers.delete(timer);
                this.ack(frame.sequenceId);
            }, delay);
            this._ackTimers.add(timer);
        } else {
            this.ack(frame.sequenceId);
        }
        this._out.show(frame);
    }

    private ack(sequenceId: number) {
        if (this._disposed) {
            return;
        }
        this._out.log(`ack #${sequenceId}`);
        this._out.ack(sequenceId);
    }
}
