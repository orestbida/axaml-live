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

	public static clientSupportedPixelFormatsMessage(): Buffer {
		return createMessage(Messages.clientSupportedPixelFormats, { formats: [1] });
	}

	public static updateXamlMessage(assemblyPath: string, xaml: string, xamlFileProjectPath?: string): Buffer {
		return createMessage(Messages.updateXaml, { assemblyPath, xaml, xamlFileProjectPath });
	}
}

export interface IncomingMessage {
	type: string;
	body: BSON.Document;
}

/**
 * Accumulates TCP chunks and yields complete messages.
 * TCP is a stream: one `data` event may contain a partial message or several messages.
 */
export class MessageReader {
	private _buffer = Buffer.alloc(0);

	public push(chunk: Buffer): IncomingMessage[] {
		this._buffer = this._buffer.length ? Buffer.concat([this._buffer, chunk]) : chunk;
		const result: IncomingMessage[] = [];

		while (this._buffer.length >= 20) {
			const length = this._buffer.readUInt32LE(0);
			if (this._buffer.length < 20 + length) {
				break;
			}
			const type = guidFromBytes(this._buffer.subarray(4, 20));
			const bodyBytes = this._buffer.subarray(20, 20 + length);
			this._buffer = this._buffer.subarray(20 + length);

			try {
				result.push({ type, body: BSON.deserialize(bodyBytes) });
			} catch {
				result.push({ type, body: {} });
			}
		}
		return result;
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
