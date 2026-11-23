import { BSON } from "bson";

/**
 * Avalonia remote protocol (tcp-bson) helpers.
 *
 * Wire format of a single message:
 *   [int32 LE body length][16 byte .NET GUID of the message type][BSON body]
 */
export class Messages {
	public static readonly htmlTransportStarted = "5377800478FA43818EC3176A6F2328B6";
	public static readonly startDesignerSession = "854887CF26944EB6B4997461B6FB96C7";
	public static readonly updateXamlResult = "B7A700930C5D47FD926122086D43A2E2";
	public static readonly clientRenderInfo = "7A3C25D33652438D8EF186E942CC96C0";
	public static readonly clientSupportedPixelFormats = "63481025701643FEBADCF2FD0F88609E";
	public static readonly updateXaml = "9AEC9A2E63154066B4BAE9A9EFD0F8CC";

	public static readonly frame = "F58313EEFE694536819DF52EDF201A0E";
	public static readonly frameReceived = "68014F8A289D48518D345367EDA7F827";
	public static readonly pointerMoved = "6228F0B999F24F62A621414DA2881648";
	public static readonly pointerPressed = "7E9E2818F93F411A800E6B1AEB11DA46";
	public static readonly pointerReleased = "4ADC84EEE7C84BCF986CDE3A2F78EDE4";
	public static readonly scroll = "79301A05F02D4B90BB39472563B504AE";
	public static readonly key = "1C3B691E3D544237BFB09FEA83BC1DB8";
	public static readonly textInput = "C174102E37054594916FB10B8248A17D";

	public static clientSupportedPixelFormatsMessage(): Buffer {
		return createMessage(Messages.clientSupportedPixelFormats, { Formats: [PixelFormat.Rgba8888] });
	}

	/** Render scaling as DPI. Must be BSON doubles: the designer's BSON reader fails on int32 here. */
	public static clientRenderInfoMessage(scale: number): Buffer {
		const dpi = new BSON.Double(96 * scale);
		return createMessage(Messages.clientRenderInfo, { DpiX: dpi, DpiY: dpi });
	}

	public static frameReceivedMessage(sequenceId: number | bigint | BSON.Long): Buffer {
		const id = typeof sequenceId === "number" ? BSON.Long.fromNumber(sequenceId) : typeof sequenceId === "bigint" ? BSON.Long.fromBigInt(sequenceId) : sequenceId;
		return createMessage(Messages.frameReceived, { SequenceId: id });
	}

	public static pointerMovedMessage(x: number, y: number, modifiers: InputModifier[]): Buffer {
		return createMessage(Messages.pointerMoved, { X: new BSON.Double(x), Y: new BSON.Double(y), Modifiers: modifiers });
	}

	public static pointerPressedMessage(x: number, y: number, button: MouseButton, modifiers: InputModifier[]): Buffer {
		return createMessage(Messages.pointerPressed, { X: new BSON.Double(x), Y: new BSON.Double(y), Button: button, Modifiers: modifiers });
	}

	public static pointerReleasedMessage(x: number, y: number, button: MouseButton, modifiers: InputModifier[]): Buffer {
		return createMessage(Messages.pointerReleased, { X: new BSON.Double(x), Y: new BSON.Double(y), Button: button, Modifiers: modifiers });
	}

	public static scrollMessage(x: number, y: number, deltaX: number, deltaY: number, modifiers: InputModifier[]): Buffer {
		return createMessage(Messages.scroll, {
			X: new BSON.Double(x),
			Y: new BSON.Double(y),
			DeltaX: new BSON.Double(deltaX),
			DeltaY: new BSON.Double(deltaY),
			Modifiers: modifiers,
		});
	}

	public static keyMessage(isDown: boolean, key: number, symbol: string | undefined, modifiers: InputModifier[]): Buffer {
		return createMessage(Messages.key, { IsDown: isDown, Key: key, PhysicalKey: 0, KeySymbol: symbol ?? null, Modifiers: modifiers });
	}

	public static textInputMessage(text: string, modifiers: InputModifier[]): Buffer {
		return createMessage(Messages.textInput, { Text: text, Modifiers: modifiers });
	}

	public static updateXamlMessage(assemblyPath: string, xaml: string, xamlFileProjectPath?: string): Buffer {
		return createMessage(Messages.updateXaml, { assemblyPath, xaml, xamlFileProjectPath });
	}
}

/** Avalonia.Remote.Protocol enums (values verified by reflection on Avalonia.Remote.Protocol 12.2). */
export enum PixelFormat {
	Rgb565 = 0,
	Rgba8888 = 1,
	Bgra8888 = 2,
}

/** Modifiers are sent as an array of these values (not flags). */
export enum InputModifier {
	Alt = 0,
	Control = 1,
	Shift = 2,
	Windows = 3,
	LeftMouseButton = 4,
	RightMouseButton = 5,
	MiddleMouseButton = 6,
}

export enum MouseButton {
	None = 0,
	Left = 1,
	Right = 2,
	Middle = 3,
}

const namedKeys: Record<string, number> = {
	Backspace: 2,
	Tab: 3,
	Enter: 6,
	Escape: 13,
	PageUp: 19,
	PageDown: 20,
	End: 21,
	Home: 22,
	ArrowLeft: 23,
	ArrowUp: 24,
	ArrowRight: 25,
	ArrowDown: 26,
	Insert: 31,
	Delete: 32,
};

/** Maps a DOM `KeyboardEvent.key` to Avalonia's Key enum (0 = None). */
export function mapKey(domKey: string): number {
	if (domKey === " ") {
		return 18; // Space
	}
	if (domKey in namedKeys) {
		return namedKeys[domKey];
	}
	if (/^[a-zA-Z]$/.test(domKey)) {
		return 44 + (domKey.toUpperCase().charCodeAt(0) - 65); // A = 44
	}
	if (/^[0-9]$/.test(domKey)) {
		return 34 + Number(domKey); // D0 = 34
	}
	const f = /^F([1-9]|1[0-2])$/.exec(domKey);
	if (f) {
		return 89 + Number(f[1]); // F1 = 90
	}
	return 0;
}

export interface IncomingMessage {
	type: string;
	body: BSON.Document;
}

/**
 * Accumulates TCP chunks and yields complete messages.
 * TCP is a stream: one `data` event may contain a partial message or several messages.
 */
/**
 * Splits the designer's TCP stream into messages. Frames are megabytes and arrive in small chunks: chunks are kept
 * in a list and joined once per message (joining on every chunk is quadratic and halves the frame rate).
 */
export class MessageReader {
	private _chunks: Buffer[] = [];
	private _size = 0;

	public push(chunk: Buffer): IncomingMessage[] {
		this._chunks.push(chunk);
		this._size += chunk.length;
		const result: IncomingMessage[] = [];

		while (this._size >= 20) {
			const head = this._chunks[0].length >= 20 ? this._chunks[0] : this.join();
			const length = head.readUInt32LE(0);
			if (this._size < 20 + length) {
				break;
			}
			const all = this.join();
			const type = guidFromBytes(all.subarray(4, 20));
			const bodyBytes = all.subarray(20, 20 + length);
			const rest = all.subarray(20 + length);
			this._chunks = rest.length ? [rest] : [];
			this._size = rest.length;

			try {
				result.push({ type, body: BSON.deserialize(bodyBytes, { promoteBuffers: true }) });
			} catch {
				result.push({ type, body: {} });
			}
		}
		return result;
	}

	private join(): Buffer {
		if (this._chunks.length > 1) {
			this._chunks = [Buffer.concat(this._chunks, this._size)];
		}
		return this._chunks[0];
	}
}

function createMessage(type: string, body: object): Buffer {
	const bson = BSON.serialize(body, { ignoreUndefined: true });
	const length = Buffer.alloc(4);
	length.writeUInt32LE(bson.length, 0);
	return Buffer.concat([length, guidToBytes(type), Buffer.from(bson)]);
}

/** .NET Guid.ToByteArray() stores the first three groups little-endian. */
function swapGuidEndianness(bytes: Buffer): Buffer {
	bytes.subarray(0, 4).reverse();
	bytes.subarray(4, 6).reverse();
	bytes.subarray(6, 8).reverse();
	return bytes;
}

export function guidToBytes(guid: string): Buffer {
	return swapGuidEndianness(Buffer.from(guid.replace(/-/g, ""), "hex"));
}

export function guidFromBytes(bytes: Buffer): string {
	// copy so the source buffer is never mutated
	return swapGuidEndianness(Buffer.from(bytes)).toString("hex").toUpperCase();
}
