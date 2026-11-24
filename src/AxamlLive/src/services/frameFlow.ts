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
 *   acknowledgement, or it would never render again;
 * - only one update is in flight (see update()): with two, a held frame #1 can be the in-between window's, and
 *   acknowledging it blocks the newest window, which then never renders.
 */
/** An update the designer has not answered for this long no longer holds up the next one (it may never answer). */
const unansweredAfterMs = 10000;
/** How long a waiting update waits for the first frame of the window before it (a view may not paint at all). */
const firstFrameWaitMs = 1000;

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

    /**
     * Sends an update now, or once the window of the update in flight is settled: the designer answered it and, on
     * success, its first frame arrived and was acknowledged (a new window sends frame #1 unasked; if it arrived after
     * the next update, it could not be told apart from the next window's frame #1). Of the updates waiting meanwhile only
     * the newest is sent. An update that got no answer for a while does not hold up the next one.
     */
    public update(send: () => void) {
        const busy = this._pendingUpdates > 0 || this._firstFrameTimer !== undefined;
        if (busy && this._clock.now() - this._sentAt < unansweredAfterMs) {
            this._out.log(this._queued ? "update queued (replaces the waiting one)" : "update queued");
            this._queued = send;
            return;
        }
        this.updateSent();
        send();
    }

    private _queued: (() => void) | undefined;
    private _sentAt = 0;
    /** Set while a new window's first frame is awaited before a waiting update is sent. */
    private _firstFrameTimer: unknown;

    private sendQueued() {
        if (this._firstFrameTimer !== undefined) {
            this._clock.clearTimeout(this._firstFrameTimer);
            this._firstFrameTimer = undefined;
        }
        const queued = this._queued;
        if (!queued || this._disposed) {
            return;
        }
        this._queued = undefined;
        this.updateSent();
        queued();
    }

    /** An UpdateXaml message was sent: the designer will open a new window. */
    public updateSent() {
        this._sentAt = this._clock.now();
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

        if (failed || (held && held.sequenceId === 1)) {
            // no new window, or its first frame is here: settled
            this.sendQueued();
        } else {
            // the new window's first frame is still to come: a waiting update goes out after it (or after a moment)
            this._firstFrameTimer = this._clock.setTimeout(() => {
                this._firstFrameTimer = undefined;
                this.sendQueued();
            }, firstFrameWaitMs);
        }
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
        if (this._firstFrameTimer !== undefined) {
            this.sendQueued(); // the window's first frame is acknowledged: the next window may come
        }
    }

    /** The connection is gone: nothing more is sent. */
    public dispose() {
        this._disposed = true;
        this._ackTimers.forEach((t) => this._clock.clearTimeout(t));
        this._ackTimers.clear();
        this._held = undefined;
        this._queued = undefined;
        if (this._firstFrameTimer !== undefined) {
            this._clock.clearTimeout(this._firstFrameTimer);
            this._firstFrameTimer = undefined;
        }
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
