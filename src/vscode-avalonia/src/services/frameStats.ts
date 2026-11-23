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
