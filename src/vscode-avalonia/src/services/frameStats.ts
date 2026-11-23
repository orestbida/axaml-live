/** Average luminance (0-255) of RGBA pixels; samples large frames. Used by tests and diagnostics. */
export function averageLuminance(rgba: Uint8Array): number {
	const pixels = Math.floor(rgba.length / 4);
	if (!pixels) {
		return 0;
	}
	const step = Math.max(1, Math.floor(pixels / 50000));
	let sum = 0;
	let n = 0;
	for (let p = 0; p < pixels; p += step) {
		const i = p * 4;
		sum += (rgba[i] + rgba[i + 1] + rgba[i + 2]) / 3;
		n++;
	}
	return sum / n;
}

/**
 * Caps the previewer frame rate: the designer sends the next frame only after the previous one is acknowledged,
 * so delaying the acknowledgement limits FPS (and CPU usage).
 */
export class FrameRateLimiter {
	private last: number | undefined;
	constructor(private fps: number) {}

	setFps(fps: number) {
		this.fps = fps;
	}

	/** Milliseconds to wait before acknowledging a frame received at `now`. */
	delay(now: number): number {
		if (this.fps <= 0) {
			return 0;
		}
		const interval = 1000 / this.fps;
		if (this.last === undefined || now >= this.last + interval) {
			this.last = now;
			return 0;
		}
		this.last += interval;
		return Math.round(this.last - now);
	}
}

/** Cheap brightness estimate from 64 pixels (RGBA). */
export function sampleLuminance(data: Uint8Array): number {
	const pixels = Math.floor(data.length / 4);
	if (!pixels) {
		return 0;
	}
	let sum = 0;
	for (let i = 0; i < 64; i++) {
		const p = Math.floor((i * pixels) / 64) * 4;
		sum += (data[p] + data[p + 1] + data[p + 2]) / 3;
	}
	return Math.round(sum / 64);
}

/** Average alpha of 64 sampled pixels (RGBA): 0 for a frame the designer never painted. */
export function sampleAlpha(data: Uint8Array): number {
	const pixels = Math.floor(data.length / 4);
	if (!pixels) {
		return 0;
	}
	let sum = 0;
	for (let i = 0; i < 64; i++) {
		sum += data[Math.floor((i * pixels) / 64) * 4 + 3];
	}
	return Math.round(sum / 64);
}

export interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/**
 * Bounding box of the pixels that differ between two RGBA frames of the same size (tightly packed), or undefined when
 * nothing changed. Compares 32-bit pixels; rows are scanned from both ends so small changes stay cheap.
 */
export function changedRect(prev: Uint8Array, next: Uint8Array, width: number, height: number): Rect | undefined {
	const aligned = prev.byteOffset % 4 === 0 && next.byteOffset % 4 === 0;
	const a = aligned ? new Uint32Array(prev.buffer, prev.byteOffset, width * height) : new Uint32Array(prev.slice().buffer);
	const b = aligned ? new Uint32Array(next.buffer, next.byteOffset, width * height) : new Uint32Array(next.slice().buffer);
	const rowDiffers = (y: number) => {
		for (let i = y * width, end = i + width; i < end; i++) {
			if (a[i] !== b[i]) {
				return true;
			}
		}
		return false;
	};
	let top = 0;
	while (top < height && !rowDiffers(top)) {
		top++;
	}
	if (top === height) {
		return undefined;
	}
	let bottom = height - 1;
	while (bottom > top && !rowDiffers(bottom)) {
		bottom--;
	}
	let left = width;
	let right = -1;
	for (let y = top; y <= bottom; y++) {
		const row = y * width;
		for (let x = 0; x < left; x++) {
			if (a[row + x] !== b[row + x]) {
				left = x;
				break;
			}
		}
		for (let x = width - 1; x > right; x--) {
			if (a[row + x] !== b[row + x]) {
				right = x;
				break;
			}
		}
	}
	return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

/** Copies a rectangle out of a tightly packed RGBA frame. */
export function cropRows(data: Uint8Array, width: number, r: Rect): Uint8Array {
	const out = new Uint8Array(r.width * r.height * 4);
	for (let y = 0; y < r.height; y++) {
		const start = ((r.y + y) * width + r.x) * 4;
		out.set(data.subarray(start, start + r.width * 4), y * r.width * 4);
	}
	return out;
}
