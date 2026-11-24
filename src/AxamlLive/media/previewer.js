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
    let frameQueue = Promise.resolve();
    let options = { theme: "Default", formFactor: "default", rotated: false, inputEnabled: true, maxRenderScale: 3 };
    let lastView = "";

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
    $("formFactor").onchange = () => {
        const id = $("formFactor").value;
        // Custom starts from the remembered size, or from the size shown now
        const size = logicalSize();
        send({
            type: "setFormFactor",
            id,
            rotated: options.rotated,
            width: options.customWidth ?? (size && Math.round(size.w)),
            height: options.customHeight ?? (size && Math.round(size.h)),
        });
    };
    const customInputs = [$("customWidth"), $("customHeight")];
    for (const input of customInputs) {
        // Enter or leaving the field applies the typed size
        input.onchange = () => send({ type: "setCustomSize", width: $("customWidth").value, height: $("customHeight").value });
        input.onkeydown = (e) => {
            if (e.key === "Enter") {
                input.blur();
            } else if (e.key === "Escape") {
                input.value = String(input === $("customWidth") ? (options.customWidth ?? "") : (options.customHeight ?? ""));
                input.blur();
            }
        };
    }
    $("rulers").onclick = () => send({ type: "setRulers", on: !options.rulers });
    $("input").onclick = () => send({ type: "setInput", enabled: !options.inputEnabled });

    // Toolbar menus drawn by the page instead of native <select> popups: in a webview without focus a native popup
    // opens and closes again on the first click. The hidden <select> keeps the value and its change handler.
    const dropdowns = [];
    let openMenu = null;
    function closeMenu() {
        if (openMenu) {
            openMenu.menu.remove();
            openMenu.button.setAttribute("aria-expanded", "false");
            openMenu = null;
        }
    }
    function dropdown(select) {
        const button = document.createElement("button");
        button.className = "dropdown-button";
        button.title = select.title;
        button.setAttribute("aria-haspopup", "listbox");
        button.setAttribute("aria-expanded", "false");
        select.parentElement.insertBefore(button, select);
        const refresh = () => {
            const o = select.options[select.selectedIndex];
            button.textContent = o ? o.textContent : "";
        };
        const choose = (value) => {
            closeMenu();
            if (select.value !== value) {
                select.value = value;
                refresh();
                select.dispatchEvent(new Event("change"));
            }
            button.focus();
        };
        const open = () => {
            const menu = document.createElement("div");
            menu.className = "dropdown-menu";
            menu.setAttribute("role", "listbox");
            for (const o of select.options) {
                if (!o.textContent) {
                    continue;
                }
                const item = document.createElement("div");
                item.className = "dropdown-item" + (o.selected ? " selected" : "");
                item.setAttribute("role", "option");
                item.textContent = o.textContent;
                item.title = o.title;
                item.dataset.value = o.value;
                item.onpointerdown = (e) => e.preventDefault();
                item.onclick = () => choose(o.value);
                menu.appendChild(item);
            }
            document.body.appendChild(menu);
            const r = button.getBoundingClientRect();
            const left = Math.max(4, Math.min(r.left, window.innerWidth - menu.offsetWidth - 4));
            menu.style.left = left + "px";
            menu.style.top = r.bottom + 2 + "px";
            menu.style.minWidth = r.width + "px";
            menu.style.maxHeight = Math.max(80, window.innerHeight - r.bottom - 10) + "px";
            button.setAttribute("aria-expanded", "true");
            openMenu = { button, menu, select };
            (menu.querySelector(".selected") || menu.firstChild)?.classList.add("active");
            menu.querySelector(".active")?.scrollIntoView({ block: "nearest" });
        };
        button.onclick = () => {
            const wasOpen = openMenu && openMenu.button === button;
            closeMenu();
            if (!wasOpen) {
                open();
            }
        };
        button.onkeydown = (e) => {
            const menu = openMenu && openMenu.button === button ? openMenu.menu : null;
            if (!menu) {
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                    e.preventDefault();
                    open();
                }
                return;
            }
            const items = [...menu.children];
            const i = items.findIndex((x) => x.classList.contains("active"));
            if (e.key === "Escape") {
                e.preventDefault();
                closeMenu();
            } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                const next = items[Math.max(0, Math.min(items.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
                items.forEach((x) => x.classList.toggle("active", x === next));
                next.scrollIntoView({ block: "nearest" });
            } else if ((e.key === "Enter" || e.key === " ") && i >= 0) {
                e.preventDefault();
                choose(items[i].dataset.value);
            }
        };
        dropdowns.push(refresh);
        refresh();
    }
    const refreshDropdowns = () => dropdowns.forEach((r) => r());
    for (const id of ["zoom", "theme", "formFactor"]) {
        dropdown($(id));
    }
    document.addEventListener("pointerdown", (e) => {
        if (openMenu && !openMenu.menu.contains(e.target) && e.target !== openMenu.button) {
            closeMenu();
        }
    });
    window.addEventListener("blur", closeMenu);
    window.addEventListener("resize", closeMenu);

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

    function logicalSize() {
        return frame ? { w: frame.width / frame.scale, h: frame.height / frame.scale } : undefined;
    }

    function layout() {
        const size = logicalSize();
        // stage padding on both sides (+ the device hairline): Fit All / Fit Width keep the margin
        const pad = 2 * 24 + (frameBox.classList.contains("device") ? 2 : 0);
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
        // the design size entry shows the size of the view as designed (known while it is shown)
        const design = [...$("formFactor").options].find((o) => o.value === "default");
        if (design && size && options.formFactor === "default") {
            design.textContent = "Design size (" + Math.round(size.w) + "×" + Math.round(size.h) + ")";
        }
        const known = typeof zoomMode === "string" ? zoomMode : String(zoomMode);
        if ([...zoomSelect.options].some((o) => o.value === known)) {
            zoomSelect.value = known;
        } else {
            $("zoomCustom").textContent = Math.round(zoom * 100) + "%";
            zoomSelect.value = "custom";
        }
        refreshDropdowns();
        reportView(stageW, stageH);
        renderHighlight();
        renderOutline();
        drawRulers();
    }

    // custom size: drag the frame's right edge, bottom edge or corner. The outline follows the pointer at once; the
    // previewer gets the new size a few times per second while dragging, and the final size on release.
    let drag = null; // { edge, x, y, w, h, zoom, width, height, sent }
    function clampSize(v) {
        return Math.round(Math.min(8000, Math.max(16, v)));
    }
    // after release the outline stays until a frame of the new size arrives (or a few seconds pass)
    let pendingSize = null; // { width, height, until }
    function renderOutline() {
        const outline = $("resizeOutline");
        if (pendingSize && Date.now() > pendingSize.until) {
            pendingSize = null;
        }
        const target = drag || pendingSize;
        outline.classList.toggle("show", !!target);
        if (target) {
            outline.style.width = target.width * zoom + "px";
            outline.style.height = target.height * zoom + "px";
            $("resizeLabel").textContent = target.width + " × " + target.height;
        }
    }
    // each new size rebuilds the view in the designer: while dragging, only when the pointer pauses, and on release
    function sendDragSize(final) {
        clearTimeout(drag.timer);
        const d = drag;
        const flush = () => {
            if (d.sent !== d.width + "x" + d.height) {
                d.sent = d.width + "x" + d.height;
                send({ type: "setCustomSize", width: d.width, height: d.height });
            }
        };
        if (final) {
            flush();
        } else {
            d.timer = setTimeout(flush, 200);
        }
    }
    for (const handle of document.querySelectorAll(".resize-handle")) {
        handle.addEventListener("pointerdown", (e) => {
            const size = logicalSize();
            if (!size || e.button !== 0) {
                return;
            }
            e.preventDefault();
            e.stopPropagation();
            try {
                // moves outside the handle keep coming to it while dragging
                handle.setPointerCapture(e.pointerId);
            } catch {
                // a pointer that is not active (test events): moves are dispatched to the handle anyway
            }
            // a fitting zoom would change with every new size under the pointer: keep the current zoom while dragging
            if (typeof zoomMode === "string") {
                setZoom(zoom);
            }
            const w = Math.round(size.w);
            const h = Math.round(size.h);
            drag = { edge: handle.dataset.edge, x: e.clientX, y: e.clientY, w, h, zoom, width: w, height: h, sent: w + "x" + h, timer: 0 };
            renderOutline();
        });
        handle.addEventListener("pointermove", (e) => {
            if (!drag) {
                return;
            }
            if (drag.edge.includes("e")) {
                drag.width = clampSize(drag.w + (e.clientX - drag.x) / drag.zoom);
            }
            if (drag.edge.includes("s")) {
                drag.height = clampSize(drag.h + (e.clientY - drag.y) / drag.zoom);
            }
            $("customWidth").value = String(drag.width);
            $("customHeight").value = String(drag.height);
            renderOutline();
            sendDragSize(false);
        });
        const end = () => {
            if (!drag) {
                return;
            }
            sendDragSize(true);
            const size = logicalSize();
            const reached = size && Math.round(size.w) === drag.width && Math.round(size.h) === drag.height;
            pendingSize = reached ? null : { width: drag.width, height: drag.height, until: Date.now() + 4000 };
            drag = null;
            renderOutline();
            if (pendingSize) {
                setTimeout(renderOutline, 4100);
            }
        };
        handle.addEventListener("pointerup", end);
        handle.addEventListener("pointercancel", end);
    }

    // rulers (toolbar toggle): logical pixels of the previewed view, 0 at the frame's top-left corner, following zoom
    // and scrolling; a marker shows the pointer's position
    const rulerTop = $("rulerTop");
    const rulerLeft = $("rulerLeft");
    let rulerPointer = null; // logical { x, y } of the pointer over the frame
    let rulerFrame = 0;
    function requestRulers() {
        if (!rulerFrame) {
            rulerFrame = requestAnimationFrame(() => {
                rulerFrame = 0;
                drawRulers();
            });
        }
    }
    stage.addEventListener("scroll", requestRulers);
    canvas.addEventListener("pointermove", (e) => {
        rulerPointer = { x: e.offsetX / zoom, y: e.offsetY / zoom };
        requestRulers();
    });
    canvas.addEventListener("pointerleave", () => {
        rulerPointer = null;
        requestRulers();
    });
    function drawRulers() {
        if (!options.rulers) {
            return;
        }
        const css = getComputedStyle(document.body);
        const color = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
        const fg = color("--vscode-editorLineNumber-foreground", "#858585");
        const bg = color("--vscode-editor-background", "#1e1e1e");
        const band = color("--vscode-editor-inactiveSelectionBackground", "rgba(128, 128, 128, 0.18)");
        const accent = color("--vscode-focusBorder", "#007fd4");
        const font = "10px " + (color("--vscode-font-family", "sans-serif") || "sans-serif");
        const frameRect = canvas.getBoundingClientRect();
        const size = logicalSize();
        // tick spacing in logical pixels: minor ticks at least 6 px apart on screen, labels at least 50 px apart
        const steps = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];
        const minor = steps.find((s) => s * zoom >= 6) ?? 10000;
        const major = steps.find((s) => s >= minor * 5 && s * zoom >= 50) ?? minor * 10;
        const dpr = window.devicePixelRatio || 1;
        for (const [ruler, horizontal] of [
            [rulerTop, true],
            [rulerLeft, false],
        ]) {
            const w = ruler.clientWidth;
            const h = ruler.clientHeight;
            if (!w || !h) {
                continue;
            }
            if (ruler.width !== Math.round(w * dpr) || ruler.height !== Math.round(h * dpr)) {
                ruler.width = Math.round(w * dpr);
                ruler.height = Math.round(h * dpr);
            }
            const g = ruler.getContext("2d");
            g.setTransform(dpr, 0, 0, dpr, 0, 0);
            g.fillStyle = bg;
            g.fillRect(0, 0, w, h);
            const rect = ruler.getBoundingClientRect();
            const origin = horizontal ? frameRect.left - rect.left : frameRect.top - rect.top; // where logical 0 is
            const length = horizontal ? w : h;
            const depth = horizontal ? h : w;
            if (size) {
                // the frame's extent
                g.fillStyle = band;
                const extent = (horizontal ? size.w : size.h) * zoom;
                if (horizontal) {
                    g.fillRect(origin, 0, extent, h);
                } else {
                    g.fillRect(0, origin, w, extent);
                }
            }
            g.strokeStyle = fg;
            g.fillStyle = fg;
            g.lineWidth = 1;
            g.font = font;
            g.textBaseline = "top";
            const first = Math.floor(-origin / zoom / minor) * minor;
            const last = (length - origin) / zoom;
            g.beginPath();
            for (let v = first; v <= last; v += minor) {
                const p = Math.round(origin + v * zoom) + 0.5;
                const isMajor = v % major === 0;
                const tick = isMajor ? depth : v % (major / 2) === 0 && major / 2 >= minor ? depth * 0.45 : depth * 0.25;
                if (horizontal) {
                    g.moveTo(p, h - tick);
                    g.lineTo(p, h);
                } else {
                    g.moveTo(w - tick, p);
                    g.lineTo(w, p);
                }
            }
            g.stroke();
            for (let v = Math.ceil(first / major) * major; v <= last; v += major) {
                const p = Math.round(origin + v * zoom);
                if (horizontal) {
                    g.fillText(String(v), p + 3, 1);
                } else {
                    // the narrow vertical ruler stacks the characters, one per line, below the tick (as image editors do)
                    const text = String(v);
                    for (let i = 0; i < text.length; i++) {
                        g.fillText(text[i], 3, p + 2 + i * 9);
                    }
                }
            }
            if (rulerPointer) {
                g.strokeStyle = accent;
                g.beginPath();
                const p = Math.round(origin + (horizontal ? rulerPointer.x : rulerPointer.y) * zoom) + 0.5;
                if (horizontal) {
                    g.moveTo(p, 0);
                    g.lineTo(p, h);
                } else {
                    g.moveTo(0, p);
                    g.lineTo(w, p);
                }
                g.stroke();
            }
        }
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

    async function decodePixels(f) {
        const bytes = f.data instanceof Uint8Array ? f.data : new Uint8Array(f.data);
        if (!f.deflated) {
            return bytes;
        }
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
        return new Uint8Array(await new Response(stream).arrayBuffer());
    }

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
        ctx.putImageData(
            new ImageData(new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, f.width * f.height * 4), f.width, f.height),
            0,
            0
        );
        if (sizeChanged) {
            if (
                pendingSize &&
                Math.abs(f.width / f.scale - pendingSize.width) <= 1 &&
                Math.abs(f.height / f.scale - pendingSize.height) <= 1
            ) {
                pendingSize = null; // the view is shown at the dragged size
            }
            layout();
        }
    }

    // select mode: pointer input goes to the designer hook (marked with Alt+Control+Shift+Windows), not to the app
    let selectMode = false;
    let highlight = null; // { x, y, width, height, label, selected } in logical coordinates
    function renderHighlight() {
        const highlightBox = $("highlight");
        const r = selectMode ? highlight : null;
        highlightBox.style.display = r ? "block" : "none";
        if (r) {
            highlightBox.style.left = r.x * zoom + "px";
            highlightBox.style.top = r.y * zoom + "px";
            highlightBox.style.width = r.width * zoom + "px";
            highlightBox.style.height = r.height * zoom + "px";
            highlightBox.classList.toggle("selected", !!r.selected);
            const label = $("highlightLabel");
            label.textContent = r.label;
            // the frame clips what is outside it (device frames): no room above the box puts the label inside its top
            // edge, and a label that would pass the right edge is aligned to the box's right side
            const frameWidth = highlightBox.parentElement ? highlightBox.parentElement.clientWidth : Infinity;
            highlightBox.classList.toggle("label-inside", r.y * zoom < label.offsetHeight);
            highlightBox.classList.toggle("label-right", r.x * zoom + label.offsetWidth > frameWidth);
        }
    }
    function setSelectMode(on) {
        selectMode = on;
        $("selectElement").classList.toggle("checked", on);
        $("selectElement").setAttribute("aria-pressed", String(on));
        canvas.style.cursor = on ? "crosshair" : options.inputEnabled ? "default" : "not-allowed";
        if (!on) {
            highlight = null;
        }
        renderHighlight();
    }
    $("selectElement").onclick = () => setSelectMode(!selectMode);
    const forwarding = () => options.inputEnabled || selectMode;

    function modifiers(e) {
        if (selectMode) {
            return [0, 1, 2, 3, ...(e.buttons & 1 ? [4] : [])];
        }
        const m = [];
        if (e.altKey) {
            m.push(0);
        }
        if (e.ctrlKey) {
            m.push(1);
        }
        if (e.shiftKey) {
            m.push(2);
        }
        if (e.metaKey) {
            m.push(3);
        }
        if (e.buttons & 1) {
            m.push(4);
        }
        if (e.buttons & 2) {
            m.push(5);
        }
        if (e.buttons & 4) {
            m.push(6);
        }
        return m;
    }
    const pos = (e) => ({ x: e.offsetX / zoom, y: e.offsetY / zoom });
    const button = (e) => (e.button === 0 ? 1 : e.button === 2 ? 2 : e.button === 1 ? 3 : 0);
    let pendingMove = null;
    // a move waiting for the next animation frame goes out before a press or release, never after it
    const flushMove = () => {
        if (pendingMove) {
            send(pendingMove);
            pendingMove = null;
        }
    };
    canvas.addEventListener("pointermove", (e) => {
        if (!forwarding()) {
            return;
        }
        const first = !pendingMove;
        pendingMove = { type: "input", kind: "pointerMoved", ...pos(e), modifiers: modifiers(e), select: selectMode };
        if (first) {
            requestAnimationFrame(flushMove);
        }
    });
    canvas.addEventListener("pointerdown", (e) => {
        if (!forwarding()) {
            return;
        }
        canvas.focus();
        canvas.setPointerCapture(e.pointerId);
        flushMove();
        send({ type: "input", kind: "pointerPressed", ...pos(e), button: button(e), modifiers: modifiers(e), select: selectMode });
    });
    canvas.addEventListener("pointerup", (e) => {
        if (!forwarding()) {
            return;
        }
        flushMove();
        send({ type: "input", kind: "pointerReleased", ...pos(e), button: button(e), modifiers: modifiers(e), select: selectMode });
    });
    canvas.addEventListener("pointerleave", () => {
        if (selectMode && highlight && !highlight.selected) {
            highlight = null;
            renderHighlight();
        }
    });
    canvas.addEventListener("contextmenu", (e) => options.inputEnabled && e.preventDefault());
    canvas.addEventListener(
        "wheel",
        (e) => {
            if (!options.inputEnabled || e.ctrlKey) {
                return;
            }
            e.preventDefault();
            send({ type: "input", kind: "scroll", ...pos(e), deltaX: -e.deltaX / 100, deltaY: -e.deltaY / 100, modifiers: modifiers(e) });
        },
        { passive: false }
    );
    canvas.addEventListener("keydown", (e) => {
        if (selectMode) {
            if (e.key === "Escape") {
                setSelectMode(false);
            }
            return;
        }
        if (!options.inputEnabled) {
            return;
        }
        e.preventDefault();
        send({ type: "input", kind: "key", isDown: true, key: e.key, modifiers: modifiers(e) });
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
            send({ type: "input", kind: "text", text: e.key, modifiers: modifiers(e) });
        }
    });
    canvas.addEventListener("keyup", (e) => {
        if (!options.inputEnabled || selectMode) {
            return;
        }
        e.preventDefault();
        send({ type: "input", kind: "key", isDown: false, key: e.key, modifiers: modifiers(e) });
    });

    window.addEventListener("message", (e) => {
        const msg = e.data;
        switch (msg.type) {
            case "frame":
            case "patch":
                // a few frames/patches are in flight (the extension waits for frameDrawn); patches carry only the changed
                // rectangle and remote sessions deflate the pixels. Applied strictly in order: decoding is asynchronous.
                frameQueue = frameQueue
                    .then(() => decodePixels(msg.frame))
                    .then((data) => {
                        if (msg.type === "frame") {
                            drawFrame({ ...msg.frame, data });
                        } else if (frame && canvas.width === msg.frame.canvasWidth && canvas.height === msg.frame.canvasHeight) {
                            const r = msg.frame;
                            ctx.putImageData(
                                new ImageData(
                                    new Uint8ClampedArray(data.buffer, data.byteOffset, r.width * r.height * 4),
                                    r.width,
                                    r.height
                                ),
                                r.x,
                                r.y
                            );
                        } else {
                            send({ type: "needFullFrame" });
                        }
                    })
                    .catch(() => send({ type: "needFullFrame" }))
                    .then(() => send({ type: "frameDrawn" }));
                break;
            case "setZoom":
                setZoom(msg.zoom);
                break;
            case "testDrag": {
                // end-to-end tests: the same pointer events a mouse drag on the handle produces
                const handle = document.querySelector(".handle-" + msg.edge);
                const r = handle.getBoundingClientRect();
                const x = r.left + r.width / 2;
                const y = r.top + r.height / 2;
                const at = (type, cx, cy) =>
                    handle.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: cx, clientY: cy, button: 0, pointerId: 1 }));
                at("pointerdown", x, y);
                at("pointermove", x + msg.dx / 2, y + msg.dy / 2);
                at("pointermove", x + msg.dx, y + msg.dy);
                at("pointerup", x + msg.dx, y + msg.dy);
                break;
            }
            case "highlight":
                highlight = msg.rect || null;
                renderHighlight();
                break;
            case "options":
                options = msg.options;
                $("theme").value = options.theme;
                $("formFactor").value = options.formFactor;
                refreshDropdowns();
                $("input").classList.toggle("checked", options.inputEnabled);
                $("input").setAttribute("aria-pressed", String(options.inputEnabled));
                $("rulers").classList.toggle("checked", !!options.rulers);
                $("rulers").setAttribute("aria-pressed", String(!!options.rulers));
                $("stageArea").classList.toggle("rulers", !!options.rulers);
                const custom = options.formFactor === "custom";
                $("customSize").hidden = !custom;
                for (const input of customInputs) {
                    // not while the field is being typed into
                    if (document.activeElement !== input && !drag) {
                        input.value = String((input === $("customWidth") ? options.customWidth : options.customHeight) ?? "");
                    }
                }
                frameBox.classList.toggle("custom", custom);
                frameBox.classList.toggle("device", options.formFactor !== "default" && !custom);
                canvas.style.cursor = selectMode ? "crosshair" : options.inputEnabled ? "default" : "not-allowed";
                lastView = "";
                layout();
                break;
            case "state": {
                const { state, xaml } = msg;
                $("dot").className = "dot " + state.status;
                $("status").textContent = state.message || state.status;
                // details of a ready state (e.g. why there is no design data) are in the tooltip, not the toolbar
                $("status").title =
                    (state.status === "ready" && state.details ? state.details + "\n" : "") +
                    (state.message || state.status) +
                    " (click to choose the previewer host)";
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
