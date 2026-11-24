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
    $("formFactor").onchange = () => send({ type: "setFormFactor", id: $("formFactor").value, rotated: options.rotated });
    $("rotate").onclick = () => send({ type: "setFormFactor", id: options.formFactor, rotated: !options.rotated });
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
            $("highlightLabel").textContent = r.label;
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
            case "highlight":
                highlight = msg.rect || null;
                renderHighlight();
                break;
            case "options":
                options = msg.options;
                $("theme").value = options.theme;
                $("formFactor").value = options.formFactor;
                refreshDropdowns();
                $("rotate").disabled = options.formFactor === "default";
                $("input").classList.toggle("checked", options.inputEnabled);
                $("input").setAttribute("aria-pressed", String(options.inputEnabled));
                frameBox.classList.toggle("device", options.formFactor !== "default");
                canvas.style.cursor = selectMode ? "crosshair" : options.inputEnabled ? "default" : "not-allowed";
                lastView = "";
                layout();
                break;
            case "state": {
                const { state, xaml } = msg;
                $("dot").className = "dot " + state.status;
                $("status").textContent = state.message || state.status;
                $("status").title = (state.message || state.status) + " (click to choose the previewer host)";
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
