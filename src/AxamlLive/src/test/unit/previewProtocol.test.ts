import * as assert from "assert";
import { BSON } from "bson";
import { Messages, MessageReader, InputModifier, mapKey } from "../../services/messageParser";
import { averageLuminance, changedRect, cropRows, FrameRateLimiter, sampleAlpha } from "../../services/frameStats";
import { designTimeConfigProperties } from "../../services/runtimeConfig";

suite("preview protocol message ids", () => {
    // from Avalonia.Remote.Protocol (the same in 11.3 and 12.2): a wrong id makes the designer drop the connection
    const avalonia: [keyof typeof Messages, string][] = [
        ["htmlTransportStarted", "53778004-78fa-4381-8ec3-176a6f2328b6"],
        ["startDesignerSession", "854887CF-2694-4EB6-B499-7461B6FB96C7"],
        ["updateXamlResult", "B7A70093-0C5D-47FD-9261-22086D43A2E2"],
        ["clientRenderInfo", "7A3c25d3-3652-438D-8EF1-86E942CC96C0"],
        ["clientSupportedPixelFormats", "63481025-7016-43FE-BADC-F2FD0F88609E"],
        ["updateXaml", "9AEC9A2E-6315-4066-B4BA-E9A9EFD0F8CC"],
        ["frame", "F58313EE-FE69-4536-819D-F52EDF201A0E"],
        ["frameReceived", "68014F8A-289D-4851-8D34-5367EDA7F827"],
        ["pointerMoved", "6228F0B9-99F2-4F62-A621-414DA2881648"],
        ["pointerPressed", "7E9E2818-F93F-411A-800E-6B1AEB11DA46"],
        ["pointerReleased", "4ADC84EE-E7C8-4BCF-986C-DE3A2F78EDE4"],
        ["scroll", "79301A05-F02D-4B90-BB39-472563B504AE"],
        ["key", "1C3B691E-3D54-4237-BFB0-9FEA83BC1DB8"],
        ["textInput", "C174102E-7405-4594-916F-B10B8248A17D"],
    ];
    for (const [name, id] of avalonia) {
        test(`${name} matches Avalonia's id`, () => {
            assert.strictEqual(String(Messages[name]).toUpperCase(), id.replace(/-/g, "").toUpperCase());
        });
    }
});

suite("preview protocol messages", () => {
    test("render info DPI is serialized as BSON double (the designer rejects int32)", () => {
        const msg = Messages.clientRenderInfoMessage(2);
        const doc = BSON.deserialize(msg.subarray(20), { promoteValues: false });
        assert.strictEqual((doc.DpiX as any)._bsontype, "Double");
        assert.strictEqual((doc.DpiX as any).valueOf(), 192);
    });

    test("pointer, scroll and key messages round-trip through the reader", () => {
        const reader = new MessageReader();
        const buf = Buffer.concat([
            Messages.pointerMovedMessage(10.5, 20, [InputModifier.Shift]),
            Messages.pointerPressedMessage(1, 2, 1, []),
            Messages.scrollMessage(1, 2, 0, -1, []),
            Messages.keyMessage(true, 44, "a", [InputModifier.Control]),
            Messages.textInputMessage("a", []),
        ]);
        const msgs = reader.push(buf);
        assert.deepStrictEqual(
            msgs.map((m) => m.type),
            [Messages.pointerMoved, Messages.pointerPressed, Messages.scroll, Messages.key, Messages.textInput]
        );
        assert.strictEqual(msgs[0].body.X, 10.5);
        assert.deepStrictEqual(msgs[0].body.Modifiers, [2]);
        assert.strictEqual(msgs[3].body.Key, 44);
    });

    test("frames split across TCP chunks are reassembled", () => {
        const frame = Buffer.concat([lengthPrefix(5), Buffer.alloc(16), Buffer.from([5, 0, 0, 0, 0])]);
        const reader = new MessageReader();
        assert.strictEqual(reader.push(frame.subarray(0, 7)).length, 0);
        assert.strictEqual(reader.push(frame.subarray(7)).length, 1);
    });

    test("large messages in small chunks, split anywhere (also inside the header)", () => {
        const data = Buffer.alloc(3 * 1024 * 1024, 7);
        const one = Messages.frameReceivedMessage(1);
        const stream = Buffer.concat([one, Messages.pointerMovedMessage(1, 2, []), one]);
        const big = Buffer.concat([stream.subarray(0, one.length), stream.subarray(one.length)]);
        // a 3 MB BSON body (like a frame) between small messages
        const { BSON } = require("bson");
        // eslint-disable-next-line @typescript-eslint/naming-convention -- designer protocol fields
        const body = Buffer.from(BSON.serialize({ Data: data, Width: 1, Height: 1 }));
        const len = Buffer.alloc(4);
        len.writeUInt32LE(body.length, 0);
        const frameMsg = Buffer.concat([len, Buffer.alloc(16), body]);
        const all = Buffer.concat([big, frameMsg, one]);
        for (const chunkSize of [1, 13, 20, 65536]) {
            const reader = new MessageReader();
            const msgs = [];
            const limit = chunkSize === 1 ? 4096 : all.length; // byte-by-byte only through the small messages
            for (let i = 0; i < limit; i += chunkSize) {
                msgs.push(...reader.push(all.subarray(i, Math.min(i + chunkSize, limit))));
            }
            if (limit < all.length) {
                msgs.push(...reader.push(all.subarray(limit)));
            }
            assert.strictEqual(msgs.length, 5, `chunk ${chunkSize}`);
            assert.strictEqual(msgs[3].body.Data.length, data.length, `chunk ${chunkSize}`);
            assert.strictEqual(msgs[4].type, Messages.frameReceived);
        }
    });

    test("reassembling a large message is linear (no copy of everything received per chunk)", () => {
        const body = Buffer.alloc(16 * 1024 * 1024);
        const len = Buffer.alloc(4);
        len.writeUInt32LE(body.length, 0);
        const msg = Buffer.concat([len, Buffer.alloc(16), body]);
        const reader = new MessageReader();
        const t0 = Date.now();
        for (let i = 0; i < msg.length; i += 16384) {
            reader.push(msg.subarray(i, i + 16384));
        }
        // quadratic: ~8 GB copied; linear: 16 MB
        assert.ok(Date.now() - t0 < 300, `took ${Date.now() - t0} ms`);
    });

    test("DOM keys map to Avalonia keys", () => {
        assert.strictEqual(mapKey("Backspace"), 2);
        assert.strictEqual(mapKey("Enter"), 6);
        assert.strictEqual(mapKey(" "), 18);
        assert.strictEqual(mapKey("ArrowLeft"), 23);
        assert.strictEqual(mapKey("a"), 44);
        assert.strictEqual(mapKey("Z"), 69);
        assert.strictEqual(mapKey("5"), 39);
        assert.strictEqual(mapKey("F1"), 90);
        assert.strictEqual(mapKey("Unidentified"), 0);
    });
});

suite("frame stats", () => {
    test("average luminance of RGBA pixels", () => {
        const white = Buffer.alloc(4 * 4, 255);
        const black = Buffer.from([0, 0, 0, 255, 0, 0, 0, 255]);
        assert.strictEqual(Math.round(averageLuminance(white)), 255);
        assert.strictEqual(Math.round(averageLuminance(black)), 0);
    });

    test("frame rate limiter delays acknowledgements", () => {
        const limiter = new FrameRateLimiter(10); // 100 ms per frame
        assert.strictEqual(limiter.delay(1000), 0);
        assert.strictEqual(limiter.delay(1030), 70);
        assert.strictEqual(limiter.delay(1250), 0);
        assert.strictEqual(new FrameRateLimiter(0).delay(5), 0, "0 = unlimited");
    });
});

function lengthPrefix(n: number) {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return b;
}

suite("frame transparency", () => {
    test("an empty (never rendered) frame is fully transparent", () => {
        const empty = new Uint8Array(98 * 91 * 4);
        assert.strictEqual(sampleAlpha(empty), 0);
        const rendered = new Uint8Array(98 * 91 * 4).fill(255);
        assert.strictEqual(sampleAlpha(rendered), 255);
        assert.strictEqual(sampleAlpha(new Uint8Array(0)), 0);
    });
});

suite("frame deltas", () => {
    const frame = (w: number, h: number, fill = 0) => new Uint8Array(w * h * 4).fill(fill);

    test("identical frames: nothing changed", () => {
        assert.strictEqual(changedRect(frame(10, 8, 1), frame(10, 8, 1), 10, 8), undefined);
    });

    test("bounding box of the changed pixels", () => {
        const a = frame(10, 8);
        const b = frame(10, 8);
        b[(2 * 10 + 3) * 4] = 9; // pixel (3,2)
        b[(5 * 10 + 7) * 4 + 2] = 9; // pixel (7,5)
        assert.deepStrictEqual(changedRect(a, b, 10, 8), { x: 3, y: 2, width: 5, height: 4 });
    });

    test("crop copies the rectangle row by row", () => {
        const b = frame(4, 3);
        for (let i = 0; i < b.length; i++) {
            b[i] = i % 251;
        }
        const r = cropRows(b, 4, { x: 1, y: 1, width: 2, height: 2 });
        assert.strictEqual(r.length, 2 * 2 * 4);
        assert.deepStrictEqual([...r.subarray(0, 8)], [...b.subarray((1 * 4 + 1) * 4, (1 * 4 + 3) * 4)]);
        assert.deepStrictEqual([...r.subarray(8, 16)], [...b.subarray((2 * 4 + 1) * 4, (2 * 4 + 3) * 4)]);
    });

    test("a 1000x700 diff is fast", () => {
        const a = frame(1000, 700);
        const b = frame(1000, 700);
        b[b.length - 1] = 1;
        const t0 = Date.now();
        for (let i = 0; i < 10; i++) {
            changedRect(a, b, 1000, 700);
        }
        assert.ok(Date.now() - t0 < 200, `${Date.now() - t0} ms for 10 diffs`);
    });
});

/* eslint-disable @typescript-eslint/naming-convention -- .NET runtimeconfig keys */
suite("design-time runtimeconfig", () => {
    test("drops trimming/AOT switches the designer needs, keeps the rest", () => {
        const props: Record<string, unknown> = {
            "System.Runtime.CompilerServices.RuntimeFeature.IsDynamicCodeSupported": false,
            "System.Text.Json.JsonSerializer.IsReflectionEnabledByDefault": false,
            "System.Resources.UseSystemResourceKeys": true,
            "System.Globalization.Invariant": true,
        };
        assert.strictEqual(designTimeConfigProperties(props), true);
        assert.deepStrictEqual(props, { "System.Globalization.Invariant": true });
        assert.strictEqual(designTimeConfigProperties(props), false);
    });
});
