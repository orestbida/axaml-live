import * as assert from "assert";
import { BSON } from "bson";
import { Messages, MessageReader, InputModifier, mapKey } from "../../services/messageParser";
import { averageLuminance, FrameRateLimiter } from "../../services/frameStats";

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

	test("DOM keys map to Avalonia keys", () => {
		assert.strictEqual(mapKey("Backspace"), 2);
		assert.strictEqual(mapKey("Enter"), 6);
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
