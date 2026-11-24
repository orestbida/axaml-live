import { StringDecoder } from "string_decoder";

interface DataStream {
    on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
    on(event: "end", listener: () => void): unknown;
}

/**
 * Calls onLine for each line of a process output stream. Chunks can end in the middle of a line or of a UTF-8
 * character: the rest is kept until the next chunk.
 */
export function onLines(stream: DataStream | null | undefined, onLine: (line: string) => void): void {
    if (!stream) {
        return;
    }

    const lines = new LineSplitter(onLine);
    stream.on("data", (chunk) => lines.write(chunk));
    stream.on("end", () => lines.end());
}

export class LineSplitter {
    private readonly _decoder = new StringDecoder("utf8");
    private _rest = "";

    constructor(private readonly _onLine: (line: string) => void) {}

    public write(chunk: Buffer | string) {
        const parts = (this._rest + (typeof chunk === "string" ? chunk : this._decoder.write(chunk))).split("\n");
        this._rest = parts.pop() ?? "";
        parts.forEach((p) => this._onLine(p.endsWith("\r") ? p.slice(0, -1) : p));
    }

    public end() {
        const last = this._rest + this._decoder.end();
        this._rest = "";
        if (last) {
            this._onLine(last.endsWith("\r") ? last.slice(0, -1) : last);
        }
    }
}

/** All output of a stream as text, decoded once (no UTF-8 character is cut at a chunk boundary). */
export function collectText(stream: DataStream | null | undefined): () => string {
    const chunks: Buffer[] = [];
    stream?.on("data", (chunk) => chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk));
    return () => Buffer.concat(chunks).toString("utf8");
}
