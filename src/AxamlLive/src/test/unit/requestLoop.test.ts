import * as assert from "assert";
import { PreviewRequest, RequestLoop, mergePreviewRequests } from "../../services/requestLoop";

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
}

suite("preview update loop", () => {
    test("runs never overlap; requests made during a run are merged into one next run", async () => {
        const runs: PreviewRequest[] = [];
        let active = 0;
        let gate = deferred();
        const loop = new RequestLoop<PreviewRequest>(mergePreviewRequests, async (r) => {
            active++;
            assert.strictEqual(active, 1, "two runs at once");
            runs.push(r);
            await gate.promise;
            active--;
        });
        const first = loop.request({});
        loop.request({ restart: true });
        loop.request({ force: true });
        assert.strictEqual(runs.length, 1);
        const g = gate;
        gate = deferred();
        g.resolve();
        await new Promise((r) => setImmediate(r));
        assert.strictEqual(runs.length, 2, "the two requests made meanwhile ran together");
        assert.ok(runs[1].restart && runs[1].force);
        gate.resolve();
        await first;
        assert.strictEqual(loop.busy, false);
    });

    test("a request after the loop went idle starts a new run", async () => {
        let count = 0;
        const loop = new RequestLoop<PreviewRequest>(mergePreviewRequests, async () => {
            count++;
        });
        await loop.request({});
        await loop.request({});
        assert.strictEqual(count, 2);
    });

    test("a failing run does not stop the loop", async () => {
        let count = 0;
        const loop = new RequestLoop<PreviewRequest>(mergePreviewRequests, async () => {
            count++;
            if (count === 1) {
                throw new Error("boom");
            }
        });
        await loop.request({});
        await loop.request({});
        assert.strictEqual(count, 2);
    });

    test("nothing runs after stop", async () => {
        let count = 0;
        const loop = new RequestLoop<PreviewRequest>(mergePreviewRequests, async () => {
            count++;
        });
        loop.stop();
        await loop.request({});
        assert.strictEqual(count, 0);
    });
});

suite("merging preview requests", () => {
    test("a crash restart (no build) merged with an edit may build", () => {
        assert.strictEqual(mergePreviewRequests({ restart: true, noBuild: true }, {}).noBuild, false);
        assert.strictEqual(mergePreviewRequests({ restart: true, noBuild: true }, { noBuild: true }).noBuild, true);
        assert.strictEqual(mergePreviewRequests(undefined, { noBuild: true }).noBuild, true);
    });

    test("the watchdog's resend stays single only when nothing else asked", () => {
        assert.strictEqual(mergePreviewRequests(undefined, { force: true, noRetry: true }).noRetry, true);
        assert.strictEqual(mergePreviewRequests({}, { force: true, noRetry: true }).noRetry, false);
    });

    test("every build caller is told the result", () => {
        const a = () => undefined;
        const b = () => undefined;
        const merged = mergePreviewRequests({ build: { done: [a] } }, { build: { done: [b] } });
        assert.deepStrictEqual(merged.build?.done, [a, b]);
        assert.ok(mergePreviewRequests({ build: { done: [a] } }, { force: true }).build);
    });
});
