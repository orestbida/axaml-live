import * as assert from "assert";
import { FlowClock, FrameFlow } from "../../services/frameFlow";

interface Frame {
    sequenceId: number;
}

/** A clock that only moves when the test says so. */
class FakeClock implements FlowClock {
    private _now = 1000;
    private _timers: { at: number; fn: () => void; id: number }[] = [];
    private _id = 0;
    now() {
        return this._now;
    }
    setTimeout(fn: () => void, ms: number) {
        const id = ++this._id;
        this._timers.push({ at: this._now + ms, fn, id });
        return id;
    }
    clearTimeout(handle: unknown) {
        this._timers = this._timers.filter((t) => t.id !== handle);
    }
    advance(ms: number) {
        this._now += ms;
        const due = this._timers.filter((t) => t.at <= this._now).sort((a, b) => a.at - b.at);
        this._timers = this._timers.filter((t) => t.at > this._now);
        due.forEach((t) => t.fn());
    }
}

function setup(fps = 0) {
    const clock = new FakeClock();
    const acks: number[] = [];
    const shown: number[] = [];
    const flow = new FrameFlow<Frame>(
        { ack: (s) => acks.push(s), show: (f) => shown.push(f.sequenceId), log: () => undefined },
        fps,
        clock
    );
    const frame = (sequenceId: number, drawable = true) => flow.frame({ sequenceId }, drawable);
    return { clock, acks, shown, flow, frame };
}

suite("frame flow control", () => {
    test("a frame is shown and acknowledged", () => {
        const { acks, shown, frame } = setup();
        frame(1);
        frame(2);
        assert.deepStrictEqual(shown, [1, 2]);
        assert.deepStrictEqual(acks, [1, 2]);
    });

    test("an empty frame is acknowledged but not shown", () => {
        const { acks, shown, frame } = setup();
        frame(1, false);
        assert.deepStrictEqual(shown, []);
        assert.deepStrictEqual(acks, [1]);
    });

    test("the frame rate limit delays the acknowledgement, not the frame", () => {
        const { clock, acks, shown, frame } = setup(10); // 100 ms per frame
        frame(1);
        clock.advance(10);
        frame(2);
        assert.deepStrictEqual(shown, [1, 2]);
        assert.deepStrictEqual(acks, [1], "second acknowledgement waits for the limit");
        clock.advance(90);
        assert.deepStrictEqual(acks, [1, 2]);
    });

    test("result before the new window's first frame: the frame is shown normally", () => {
        const { acks, shown, flow, frame } = setup();
        flow.updateSent();
        flow.updateResult(false);
        frame(1);
        assert.deepStrictEqual(shown, [1]);
        assert.deepStrictEqual(acks, [1]);
    });

    test("first frame of the new window before its result: held, then shown", () => {
        const { acks, shown, flow, frame } = setup();
        flow.updateSent();
        frame(1);
        assert.deepStrictEqual(shown, [], "held until the result");
        assert.deepStrictEqual(acks, []);
        flow.updateResult(false);
        assert.deepStrictEqual(shown, [1]);
        assert.deepStrictEqual(acks, [1]);
    });

    test("update during an animation: the old window's late acknowledgement never reaches the new window", () => {
        const { clock, acks, shown, flow, frame } = setup(10);
        frame(250);
        clock.advance(10);
        frame(251); // acknowledgement waiting for the frame rate limit
        flow.updateSent();
        frame(252); // old window, rendered before it closed
        clock.advance(500);
        assert.deepStrictEqual(acks, [250], "the waiting acknowledgement (251) was cancelled");
        flow.updateResult(false);
        assert.deepStrictEqual(shown, [250, 251], "the held frame of the closed window is dropped");
        frame(1);
        assert.deepStrictEqual(shown, [250, 251, 1]);
        assert.ok(acks.includes(1));
        assert.ok(!acks.includes(251) && !acks.includes(252));
    });

    test("failed update with a held frame: the old window keeps rendering", () => {
        const { acks, shown, flow, frame } = setup();
        frame(7);
        flow.updateSent();
        frame(8);
        flow.updateResult(true);
        assert.deepStrictEqual(shown, [7, 8]);
        assert.deepStrictEqual(acks, [7, 8]);
    });

    test("failed update after a cancelled acknowledgement: it is sent again", () => {
        const { clock, acks, flow, frame } = setup(10);
        frame(1);
        clock.advance(10);
        frame(2); // acknowledgement delayed
        flow.updateSent(); // cancelled
        flow.updateResult(true); // no new window: the old one waits for #2
        assert.deepStrictEqual(acks, [1, 2]);
    });

    test("back-to-back updates: frames are held until the last result", () => {
        const { shown, flow, frame } = setup();
        flow.updateSent();
        flow.updateSent();
        frame(1); // first new window
        flow.updateResult(false);
        assert.deepStrictEqual(shown, [], "one update still pending");
        frame(1); // second new window
        flow.updateResult(false);
        assert.deepStrictEqual(shown, [1]);
        assert.strictEqual(flow.pendingUpdates, 0);
    });

    test("nothing is acknowledged after the connection closed", () => {
        const { clock, acks, flow, frame } = setup(10);
        frame(1);
        clock.advance(10);
        frame(2);
        flow.dispose();
        clock.advance(500);
        assert.deepStrictEqual(acks, [1]);
    });

    test("a lower frame rate (hidden preview) takes effect for the next frame", () => {
        const { clock, acks, flow, frame } = setup(60);
        flow.setFps(2);
        frame(1);
        clock.advance(20);
        frame(2);
        clock.advance(100);
        assert.deepStrictEqual(acks, [1], "2 fps: the second acknowledgement waits 500 ms");
        clock.advance(400);
        assert.deepStrictEqual(acks, [1, 2]);
    });
});

suite("frame flow control: one update at a time", () => {
    test("updates made while one is in flight wait; only the newest is sent, after the window's first frame", () => {
        const { flow, frame } = setup();
        const sent: string[] = [];
        flow.update(() => sent.push("A"));
        flow.update(() => sent.push("B"));
        flow.update(() => sent.push("C"));
        assert.deepStrictEqual(sent, ["A"], "B and C wait; C replaces B");
        flow.updateResult(false);
        assert.deepStrictEqual(sent, ["A"], "A's window has not sent its first frame yet");
        frame(1);
        assert.deepStrictEqual(sent, ["A", "C"]);
    });

    test("the order from a real trace: the replaced window's frame #1 is acknowledged before the next update", () => {
        // everything sent to the designer, in order: acknowledgements and updates share the connection
        const wire: string[] = [];
        const shown: string[] = [];
        const flow = new FrameFlow<{ sequenceId: number; view: string }>(
            { ack: (s) => wire.push(`ack ${s}`), show: (f) => shown.push(`${f.view} #${f.sequenceId}`), log: () => undefined },
            0,
            new FakeClock()
        );
        flow.update(() => wire.push("update MainWindow"));
        flow.update(() => wire.push("update Host")); // chosen right after: waits
        flow.updateResult(false); // MainWindow answered
        flow.frame({ sequenceId: 1, view: "MainWindow" }, true); // its first frame, sent unasked
        flow.frame({ sequenceId: 2, view: "MainWindow" }, true); // rendered after the ack, before the host update
        flow.updateResult(false); // the host answered
        flow.frame({ sequenceId: 1, view: "Host" }, true);
        assert.deepStrictEqual(wire, ["update MainWindow", "ack 1", "update Host", "ack 1"]);
        assert.deepStrictEqual(shown, ["MainWindow #1", "Host #1"], "the closed window's #2 is dropped, not acknowledged");
    });

    test("a view that does not paint: the waiting update goes out after a moment", () => {
        const { clock, flow } = setup();
        const sent: string[] = [];
        flow.update(() => sent.push("A"));
        flow.update(() => sent.push("B"));
        flow.updateResult(false);
        clock.advance(500);
        assert.deepStrictEqual(sent, ["A"]);
        clock.advance(600);
        assert.deepStrictEqual(sent, ["A", "B"]);
    });

    test("a failed update opens no window: the waiting update goes out at once", () => {
        const { flow } = setup();
        const sent: string[] = [];
        flow.update(() => sent.push("A"));
        flow.update(() => sent.push("B"));
        flow.updateResult(true);
        assert.deepStrictEqual(sent, ["A", "B"]);
    });

    test("an update the designer never answers does not hold up the next one for good", () => {
        const { clock, flow } = setup();
        const sent: string[] = [];
        flow.update(() => sent.push("A"));
        clock.advance(11000);
        flow.update(() => sent.push("B"));
        assert.deepStrictEqual(sent, ["A", "B"]);
    });

    test("nothing waiting is sent after the connection closed", () => {
        const { clock, flow } = setup();
        const sent: string[] = [];
        flow.update(() => sent.push("A"));
        flow.update(() => sent.push("B"));
        flow.updateResult(false);
        flow.dispose();
        clock.advance(2000);
        assert.deepStrictEqual(sent, ["A"]);
    });
});
