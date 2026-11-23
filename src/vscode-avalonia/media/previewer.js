// Avalonia previewer webview: renders designer frames on a canvas and forwards input/toolbar actions.
(function () {
	const vscode = acquireVsCodeApi();
	const init = window.previewerInit || {};
	const $ = (id) => document.getElementById(id);
	const send = (msg) => vscode.postMessage(msg);

	const canvas = $("canvas");
	const ctx = canvas.getContext("2d");
	const stage = $("stage");
	const frameBox = $("frameBox");

	const zoomLevels = [0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8];
	const saved = vscode.getState() || {};
	let zoomMode = saved.zoomMode ?? init.defaultZoom ?? 1; // number | "fitAll" | "fitWidth"
	let zoom = typeof zoomMode === "number" ? zoomMode : 1;
	let frame = null; // { width, height, scale }
	let options = { theme: "Default", formFactor: "default", rotated: false, inputEnabled: true, maxRenderScale: 3 };
	let lastView = "";
	let pendingFrame = null;

	// ---------- toolbar ----------
	const zoomSelect = $("zoom");
	function fillZoomSelect() {
		const items = [["fitAll", "Fit All"], ["fitWidth", "Fit Width"], ...zoomLevels.map((z) => [String(z), Math.round(z * 100) + "%"])];
		zoomSelect.innerHTML = "";
		for (const [value, label] of items) {
			const o = document.createElement("option");
			o.value = value;
			o.textContent = label;
			zoomSelect.appendChild(o);
		}
		const custom = document.createElement("option");
		custom.value = "custom";
		custom.id = "zoomCustom";
		zoomSelect.appendChild(custom);
	}
	fillZoomSelect();
	for (const ff of init.formFactors || []) {
		const o = document.createElement("option");
		o.value = ff.id;
		o.textContent = ff.label;
		o.title = ff.size;
		$("formFactor").appendChild(o);
	}

	$("restart").onclick = () => send({ type: "restart" });
	$("build").onclick = () => send({ type: "build" });
	$("overlayBuild").onclick = () => send({ type: "build" });
	$("log").onclick = () => send({ type: "showLog" });
	$("status").onclick = () => send({ type: "selectHost" });
	$("zoomIn").onclick = () => step(1);
	$("zoomOut").onclick = () => step(-1);
	zoomSelect.onchange = () => {
		const v = zoomSelect.value;
		if (v !== "custom") {
			setZoom(v === "fitAll" || v === "fitWidth" ? v : Number(v));
		}
	};
	$("theme").onchange = () => send({ type: "setTheme", value: $("theme").value });
	$("formFactor").onchange = () => send({ type: "setFormFactor", id: $("formFactor").value, rotated: options.rotated });
	$("rotate").onclick = () => send({ type: "setFormFactor", id: options.formFactor, rotated: !options.rotated });
	$("input").onclick = () => send({ type: "setInput", enabled: !options.inputEnabled });

	function step(dir) {
		const next = dir > 0 ? zoomLevels.find((l) => l > zoom + 0.001) : [...zoomLevels].reverse().find((l) => l < zoom - 0.001);
		setZoom(next ?? (dir > 0 ? zoomLevels[zoomLevels.length - 1] : zoomLevels[0]));
	}

	function setZoom(mode) {
		zoomMode = mode;
		vscode.setState({ ...(vscode.getState() || {}), zoomMode });
		layout();
	}

	stage.addEventListener(
		"wheel",
		(e) => {
			if (e.ctrlKey) {
				e.preventDefault();
				step(e.deltaY < 0 ? 1 : -1);
			}
		},
		{ passive: false }
	);
	new ResizeObserver(() => layout()).observe(stage);

	// ---------- layout / zoom ----------
	function logicalSize() {
		return frame ? { w: frame.width / frame.scale, h: frame.height / frame.scale } : undefined;
	}

	function layout() {
		const size = logicalSize();
		const pad = frameBox.classList.contains("device") ? 2 * (14 + 12) : 0;
		const stageW = stage.clientWidth - pad;
		const stageH = stage.clientHeight - pad;
		if (size) {
			if (zoomMode === "fitWidth") {
				zoom = Math.max(0.05, stageW / size.w);
			} else if (zoomMode === "fitAll") {
				zoom = Math.max(0.05, Math.min(stageW / size.w, stageH / size.h));
			} else {
				zoom = Number(zoomMode) || 1;
			}
			canvas.style.width = size.w * zoom + "px";
			canvas.style.height = size.h * zoom + "px";
		}
		const known = typeof zoomMode === "string" ? zoomMode : String(zoomMode);
		if ([...zoomSelect.options].some((o) => o.value === known)) {
			zoomSelect.value = known;
		} else {
			$("zoomCustom").textContent = Math.round(zoom * 100) + "%";
			zoomSelect.value = "custom";
		}
		reportView(stageW, stageH);
	}

	/** Tells the extension the effective zoom and the render scale needed for a sharp image. */
	function reportView(stageW, stageH) {
		const raw = zoom * (window.devicePixelRatio || 1);
		const renderScale = Math.min(options.maxRenderScale || 3, Math.max(1, Math.ceil(raw * 4) / 4));
		const view = { type: "view", zoom, zoomMode, renderScale, stageWidth: stageW, stageHeight: stageH };
		const key = JSON.stringify(view);
		if (key !== lastView) {
			lastView = key;
			send(view);
		}
	}

	// ---------- frames ----------
	function drawFrame(f) {
		const sizeChanged = !frame || frame.width !== f.width || frame.height !== f.height || frame.scale !== f.scale;
		frame = { width: f.width, height: f.height, scale: f.scale };
		const bytes = f.data instanceof Uint8Array ? f.data : new Uint8Array(f.data);
		let pixels = bytes;
		if (f.stride && f.stride !== f.width * 4) {
			pixels = new Uint8Array(f.width * f.height * 4);
			for (let y = 0; y < f.height; y++) {
				pixels.set(bytes.subarray(y * f.stride, y * f.stride + f.width * 4), y * f.width * 4);
			}
		}
		if (canvas.width !== f.width || canvas.height !== f.height) {
			canvas.width = f.width;
			canvas.height = f.height;
		}
		ctx.putImageData(new ImageData(new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, f.width * f.height * 4), f.width, f.height), 0, 0);
		if (sizeChanged) {
			layout();
		}
	}

	// ---------- input ----------
	function modifiers(e) {
		const m = [];
		if (e.altKey) m.push(0);
		if (e.ctrlKey) m.push(1);
		if (e.shiftKey) m.push(2);
		if (e.metaKey) m.push(3);
		if (e.buttons & 1) m.push(4);
		if (e.buttons & 2) m.push(5);
		if (e.buttons & 4) m.push(6);
		return m;
	}
	const pos = (e) => ({ x: e.offsetX / zoom, y: e.offsetY / zoom });
	const button = (e) => (e.button === 0 ? 1 : e.button === 2 ? 2 : e.button === 1 ? 3 : 0);
	let pendingMove = null;
	canvas.addEventListener("pointermove", (e) => {
		if (!options.inputEnabled) return;
		const first = !pendingMove;
		pendingMove = { type: "input", kind: "pointerMoved", ...pos(e), modifiers: modifiers(e) };
		if (first) {
			requestAnimationFrame(() => {
				send(pendingMove);
				pendingMove = null;
			});
		}
	});
	canvas.addEventListener("pointerdown", (e) => {
		if (!options.inputEnabled) return;
		canvas.focus();
		canvas.setPointerCapture(e.pointerId);
		send({ type: "input", kind: "pointerPressed", ...pos(e), button: button(e), modifiers: modifiers(e) });
	});
	canvas.addEventListener("pointerup", (e) => {
		if (!options.inputEnabled) return;
		send({ type: "input", kind: "pointerReleased", ...pos(e), button: button(e), modifiers: modifiers(e) });
	});
	canvas.addEventListener("contextmenu", (e) => options.inputEnabled && e.preventDefault());
	canvas.addEventListener(
		"wheel",
		(e) => {
			if (!options.inputEnabled || e.ctrlKey) return;
			e.preventDefault();
			send({ type: "input", kind: "scroll", ...pos(e), deltaX: -e.deltaX / 100, deltaY: -e.deltaY / 100, modifiers: modifiers(e) });
		},
		{ passive: false }
	);
	canvas.addEventListener("keydown", (e) => {
		if (!options.inputEnabled) return;
		e.preventDefault();
		send({ type: "input", kind: "key", isDown: true, key: e.key, modifiers: modifiers(e) });
		if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
			send({ type: "input", kind: "text", text: e.key, modifiers: modifiers(e) });
		}
	});
	canvas.addEventListener("keyup", (e) => {
		if (!options.inputEnabled) return;
		e.preventDefault();
		send({ type: "input", kind: "key", isDown: false, key: e.key, modifiers: modifiers(e) });
	});

	// ---------- messages from the extension ----------
	window.addEventListener("message", (e) => {
		const msg = e.data;
		switch (msg.type) {
			case "frame":
				// draw only the newest frame once per display refresh (smooth animations, no backlog)
				if (!pendingFrame) {
					requestAnimationFrame(() => {
						const f = pendingFrame;
						pendingFrame = null;
						if (f) {
							drawFrame(f);
						}
						send({ type: "frameDrawn" }); // the extension posts the next frame only now
					});
				}
				pendingFrame = msg.frame;
				break;
			case "setZoom":
				setZoom(msg.zoom);
				break;
			case "options":
				options = msg.options;
				$("theme").value = options.theme;
				$("formFactor").value = options.formFactor;
				$("rotate").disabled = options.formFactor === "default";
				$("input").classList.toggle("checked", options.inputEnabled);
				$("input").setAttribute("aria-pressed", String(options.inputEnabled));
				frameBox.classList.toggle("device", options.formFactor !== "default");
				canvas.style.cursor = options.inputEnabled ? "default" : "not-allowed";
				lastView = "";
				layout();
				break;
			case "state": {
				const { state, xaml } = msg;
				$("dot").className = "dot " + state.status;
				$("status").textContent = state.message || state.status;
				$("build").disabled = state.status === "building";
				$("overlay").className = "overlay" + (state.status !== "ready" ? " show" : "");
				$("overlayText").textContent = state.message || "";
				$("overlayDetails").style.display = state.details ? "block" : "none";
				$("overlayDetails").textContent = state.details || "";
				$("overlayBuild").style.display = state.canBuild ? "inline-block" : "none";
				const err = xaml && xaml.error;
				$("xamlError").className = "xaml-error" + (err && state.status === "ready" ? " show" : "");
				$("xamlError").textContent = err ? (xaml.line ? "Line " + xaml.line + ": " : "") + err : "";
				break;
			}
		}
	});

	layout();
	send({ type: "ready" });
})();
