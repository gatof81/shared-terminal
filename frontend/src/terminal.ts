/**
 * terminal.ts — xterm.js wrapper with WebSocket bridge to Docker exec.
 */

import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { type IDisposable, type ILink, type ILinkProvider, Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

export type SessionStatus = "running" | "stopped" | "terminated" | "disconnected";

export interface TerminalSession {
	dispose(): void;
	setFontSize(px: number): void;
	paste(text: string): void;
}

export type StatusCallback = (status: SessionStatus) => void;
export type ErrorCallback = (message: string) => void;
/** Notice fired the first time WebGL is unavailable on this tab — once
 *  per terminal lifetime. Used by main.ts to surface a one-time toast
 *  so the user knows why their session feels slower (#55). */
export type RendererNoticeCallback = (message: string) => void;

export function openTerminalSession(opts: {
	container: HTMLElement;
	sessionId: string;
	tabId?: string;
	fontSize?: number;
	onStatus: StatusCallback;
	onError: ErrorCallback;
	onRendererFallback?: RendererNoticeCallback;
}): TerminalSession {
	const { container, sessionId, tabId, fontSize, onStatus, onError, onRendererFallback } = opts;
	// Fires the fallback notice at most once per tab, regardless of how
	// many times the WebGL context flaps (#55). A flapping driver
	// shouldn't toast on every cycle.
	let rendererFallbackNoticed = false;
	const noticeFallback = (reason: string) => {
		if (rendererFallbackNoticed) return;
		rendererFallbackNoticed = true;
		onRendererFallback?.(
			`GPU rendering unavailable (${reason}) — falling back to slower DOM renderer.`,
		);
	};

	// ── xterm.js setup ──────────────────────────────────────────────────────
	const term = new Terminal({
		theme: {
			background: "#0d1117",
			foreground: "#e6edf3",
			cursor: "#58a6ff",
			selectionBackground: "#264f78",
		},
		fontFamily:
			'"Cascadia Code", "Fira Code", "JetBrains Mono", "Monaco", "Courier New", monospace',
		fontSize: fontSize ?? 14,
		lineHeight: 1.2,
		cursorBlink: true,
		cursorInactiveStyle: "outline",
		// `convertEol` (default false in xterm) was previously `true`, which
		// rewrote every standalone \n into \r\n on write. tmux, bash, and
		// most TUIs already emit \r\n where they want both line-feed and
		// carriage-return; the option was harmless for them. But Ink
		// (Claude CLI's renderer) emits standalone \n in places where it
		// wants pure line-feed — keep cursor in the same column on the next
		// row — and tracks cursor state assuming that behaviour. With
		// convertEol:true xterm moved the cursor to col 1 instead of
		// preserving the column, so Ink's next absolute write landed in a
		// cell it didn't expect: visible as "after typing for a while in
		// claude, text jumps to the next row and stays one row off". Default
		// false matches what Ink (and standard TUI conventions) expect.
		allowProposedApi: true,
		// Apps like Claude Code emit OSC 8 hyperlink escapes. xterm renders
		// them (underline + pointer cursor) but needs an explicit handler
		// to actually open them on click.
		linkHandler: {
			activate(event, uri) {
				event.preventDefault();
				window.open(uri, "_blank", "noopener,noreferrer");
			},
			allowNonHttpProtocols: false,
		},
		scrollback: 5000,
	});

	const fitAddon = new FitAddon();
	term.loadAddon(fitAddon);
	term.open(container);

	// Touch-action none so the OS doesn't eat vertical drags as page-scroll
	// — our touch handler below routes them into terminal scroll instead.
	container.style.touchAction = "none";

	// ── WebGL renderer ──────────────────────────────────────────────────────
	// WebGL avoids the DOM renderer's visibility-loss glitches (rows written
	// while a tab is hidden drop out of the paint). Activate after open so
	// the canvas exists. If the GPU driver revokes the context we dispose
	// the addon and xterm silently falls back to the DOM renderer.
	let webgl: WebglAddon | null = null;
	try {
		webgl = new WebglAddon();
		webgl.onContextLoss(() => {
			webgl?.dispose();
			webgl = null;
			noticeFallback("context lost");
		});
		term.loadAddon(webgl);
	} catch (err) {
		console.warn("[terminal] WebGL renderer unavailable, falling back to DOM:", err);
		webgl = null;
		noticeFallback("addon init failed");
	}

	// webglcontextlost bubbles; webglcontextrestored does not — listen on the
	// canvas obtained from the loss event's target.
	let pendingRestoreCanvas: HTMLCanvasElement | null = null;
	const onContextRestored = () => {
		// Don't load a second addon while one is already live (prior loss handler nulls webgl).
		if (webgl) return;
		pendingRestoreCanvas = null;
		// The let/const split is deliberate. `restoredAddon` (let, outer) is
		// the catch-block's only handle for disposing a partially-initialised
		// addon if `term.loadAddon(addon)` throws after construction —
		// otherwise the just-allocated WebGL context would leak. `addon`
		// (const, inner) is what the onContextLoss closure binds to: a
		// const here keeps the closure immune to a future refactor that
		// reassigns `restoredAddon` between construction and the closure
		// firing, which would otherwise have the closure dispose the wrong
		// addon. Both bindings point at the same object on the success path;
		// they only diverge on the partial-failure path. Don't collapse them.
		let restoredAddon: WebglAddon | undefined;
		try {
			const addon = new WebglAddon();
			restoredAddon = addon;
			addon.onContextLoss(() => {
				addon.dispose();
				webgl = null;
				noticeFallback("context lost");
			});
			term.loadAddon(addon);
			webgl = addon;
			console.debug("[terminal] WebGL context restored, re-enabled GPU renderer");
		} catch (err) {
			restoredAddon?.dispose();
			console.warn("[terminal] WebGL restore failed:", err);
			// In the common loss → restore → restore-fail sequence the
			// "context lost" notice already fired and `noticeFallback`
			// here is a no-op (the once-per-tab gate is already set).
			// Kept so a future change that resets the flag between
			// loss and restore — e.g. to allow re-notice after an
			// interim successful restore — wouldn't silently skip
			// surfacing this terminal-state failure.
			noticeFallback("restore failed");
		}
	};
	const onContextLost = (ev: Event) => {
		if (!(ev.target instanceof HTMLCanvasElement)) return;
		pendingRestoreCanvas?.removeEventListener("webglcontextrestored", onContextRestored);
		pendingRestoreCanvas = ev.target;
		pendingRestoreCanvas.addEventListener("webglcontextrestored", onContextRestored, {
			once: true,
		});
	};
	// Listener is registered unconditionally. The cost is one no-op
	// attach when WebGL never initialised (no canvas under `container`
	// ever fires webglcontextlost), but in exchange a future code path
	// that hot-swaps the renderer — disposing the addon and replacing it
	// without a full navigate-away — gets the loss/restore plumbing
	// already wired for free, instead of having to re-register the
	// listener from inside that swap. The dispose path was already
	// unconditional, so the symmetry is now properly established.
	container.addEventListener("webglcontextlost", onContextLost);

	fitAddon.fit();

	// Cmd/Ctrl + C copies the current xterm selection to the clipboard.
	// Without this, Cmd-C falls through to the terminal (Claude Code
	// intercepts it as SIGINT) and nothing gets copied.
	term.attachCustomKeyEventHandler((ev) => {
		if (
			ev.type === "keydown" &&
			(ev.metaKey || ev.ctrlKey) &&
			!ev.altKey &&
			!ev.shiftKey &&
			ev.key.toLowerCase() === "c"
		) {
			const sel = term.getSelection();
			if (sel) {
				navigator.clipboard.writeText(sel).catch(() => {});
				return false;
			}
		}
		return true;
	});
	// Fallback for plain-text URLs (without OSC 8). Custom provider so URLs
	// that soft-wrap across rows are still recognised as ONE link — hover
	// underlines the full URL and clicking anywhere on it opens the
	// complete URL. No-op when the app already emits OSC 8 (xterm's native
	// hyperlink handling takes precedence per-cell).
	const linkProviderDisposable = term.registerLinkProvider(new MultilineUrlLinkProvider(term));

	// Mouse clicks should focus xterm immediately. Touch taps are handled
	// in onTouchEnd below — we wait until touchend to distinguish a tap
	// from a scroll gesture so a swipe doesn't pop the keyboard mid-drag.
	const focusOnPointer = (ev: PointerEvent) => {
		if (ev.pointerType !== "touch") term.focus();
	};
	container.addEventListener("pointerdown", focusOnPointer);

	// ── Scrollback / selection preservation ────────────────────────────────
	// xterm auto-tracks output to the bottom of the buffer (cursor follows
	// what tmux/the shell writes). When the user is either parked in
	// scrollback OR holding a live selection, that auto-track yanks the
	// viewport away from whatever they were reading mid-stream — every
	// fresh byte of `tail -f`, a streaming build log, or a claude TUI
	// pulse snaps the screen back to the prompt and erases their place
	// (#157).
	//
	// Track scrollback parking via `term.onScroll` (the buffer geometry
	// is `viewportY < baseY` whenever the user has scrolled up — at
	// bottom both equal `baseY`), check `term.hasSelection()` at write
	// time for selection state, and if either is true capture the
	// pre-write viewport line and restore it from `term.write`'s
	// parser-drained callback.
	//
	// Restoring from the callback (not synchronously after the call)
	// is load-bearing: xterm parses input asynchronously, so a sync
	// read of `viewportY` right after `term.write()` returns can land
	// before the parser has applied the cursor moves the new bytes
	// caused. The callback fires once the bytes have actually been
	// written and the auto-snap (if any) has happened.
	let userScrolled = false;
	const scrollDisposable = term.onScroll(() => {
		const buf = term.buffer.active;
		userScrolled = buf.viewportY < buf.baseY;
		// DEBUG (#178 follow-up). Remove once diagnosed.
		console.log("[scroll-debug] onScroll", {
			viewportY: buf.viewportY,
			baseY: buf.baseY,
			userScrolled,
			bufType: buf.type,
		});
	});

	// ── WebSocket connection ────────────────────────────────────────────────
	// Auth lives in an httpOnly cookie (#18). Browsers send cookies on the
	// WS upgrade to the cookie's domain automatically — no token needs to
	// be threaded through here. Origin policy (CSWSH protection) is
	// enforced server-side by isAllowedWsOrigin against CORS_ORIGINS.
	// Pass the post-fit geometry through the URL so capture-pane on the
	// backend runs at the actual viewport size, not D1's stored default.
	// Without this, the replay arrives at the wrong cols/rows and renders
	// mis-aligned in xterm until the next resize event (sidebar toggle,
	// viewport change). Validated server-side; backend falls back to D1
	// if the params are missing or out of range. Sending geometry as a
	// WS message after open would be too late: the backend ships the
	// replay before its `ws.on("message", …)` listener registers, so the
	// frame would be silently dropped by EventEmitter.
	//
	// Liveness (post-open) is handled at the protocol layer (ws.ping/pong)
	// from the server — see backend/src/index.ts heartbeat. Browsers
	// auto-reply to server pings with no JS hook required, so there is
	// no `ws.onopen` handler.
	const wsUrl = buildWsUrl(sessionId, tabId, term.cols, term.rows);
	const ws = new WebSocket(wsUrl);
	let disposed = false;

	ws.onmessage = (ev) => {
		// disposed: post-close frames buffered by the browser or in flight
		// from the server still fire here, and term.write() throws on a
		// disposed xterm. Sibling of the onerror/onclose guards below (#93).
		if (disposed) return;
		type Msg =
			| { type: "output"; data: string }
			| { type: "status"; status: SessionStatus }
			| { type: "error"; message: string };

		let msg: Msg;
		try {
			msg = JSON.parse(ev.data as string) as Msg;
		} catch {
			return;
		}

		switch (msg.type) {
			case "output": {
				// Fast path when the user is at the bottom with no selection:
				// no callback, no closure allocation, identical to the prior
				// behaviour for the common case (user typing at the prompt).
				const wasOffBottom = userScrolled || term.hasSelection();
				if (!wasOffBottom) {
					term.write(msg.data);
					break;
				}
				const yBefore = term.buffer.active.viewportY;
				// Use the pre-write `wasOffBottom` for the restore decision —
				// NOT a re-check at callback time. xterm's auto-track-to-bottom
				// during the write fires `onScroll`, which our listener
				// reads as `viewportY === baseY` and sets `userScrolled =
				// false`. From inside `onScroll` there's no signal to
				// distinguish that auto-snap from a user-initiated scroll-
				// down, so re-checking inside the callback always sees the
				// auto-snapped state and skips the restore — yanking the
				// user back to the bottom on every output frame. The
				// captured `wasOffBottom` is the only source of truth that
				// survives the parse window; the trade-off is a user who
				// genuinely scrolls back to the bottom mid-parse will be
				// briefly restored to `yBefore` for ~one write before the
				// next call's `wasOffBottom` correctly reads `false`. That
				// edge case is far less disruptive than the previous bug
				// (every output write snapped scroll-back to bottom).
				term.write(msg.data, () => {
					if (term.buffer.active.viewportY !== yBefore) {
						term.scrollToLine(yBefore);
					}
				});
				break;
			}
			case "status":
				onStatus(msg.status);
				break;
			case "error":
				onError(msg.message);
				break;
		}
	};

	ws.onerror = () => {
		if (disposed) return;
		onError("WebSocket connection error");
	};

	ws.onclose = (ev) => {
		// disposed: stale async close from a prior navigate-away — ignore
		if (disposed) return;
		if (ev.code !== 1000) {
			onError(`Connection closed (${ev.code}): ${ev.reason || "unknown reason"}`);
		}
		onStatus("disconnected");
	};

	// ── Input: xterm → WS ──────────────────────────────────────────────────
	const inputDisposable = term.onData((data) => {
		send({ type: "input", data });
	});

	// ── Touch scroll ────────────────────────────────────────────────────────
	// On mobile there are no wheel events, and `mouse on` in tmux means
	// finger drags aren't forwarded as anything useful. We translate the
	// drag into terminal scroll:
	//
	//  - Main buffer (shell prompt, command output): scroll xterm's own
	//    scrollback with `scrollLines`. Users expect to pull older lines
	//    back into view; we don't involve tmux at all, so there's no weird
	//    copy-mode dance.
	//  - Alt buffer (vim, less, Claude Code, htop, …): synthesise
	//    up/down arrow keys. Every TUI app responds to arrows, so the
	//    user can navigate without needing mouse-wheel support in the app
	//    or tmux copy-mode.
	//
	// Direction follows iOS/Android convention — content tracks the
	// finger: drag up → view moves up → scroll toward newer (bottom).
	let lastTouchY: number | null = null;
	let touchIsScroll = false; // true once the gesture has moved ≥1 cell
	const getCellHeight = () => (term.rows > 0 ? container.clientHeight / term.rows : 20);

	const onTouchStart = (ev: TouchEvent) => {
		if (ev.touches.length !== 1) {
			lastTouchY = null;
			touchIsScroll = false;
			return;
		}
		lastTouchY = ev.touches[0]!.clientY;
		touchIsScroll = false;
	};
	const onTouchMove = (ev: TouchEvent) => {
		if (lastTouchY === null || ev.touches.length !== 1) {
			// Defence-in-depth: clear lastTouchY whenever we see a non-
			// single-touch frame. onTouchStart already clears it when a
			// second finger lands (touchstart fires for each new touch
			// point), so under normal browser behaviour this is a no-op.
			// But touch events are notoriously flaky on the long tail of
			// mobile browsers — Safari has shipped bugs where a touch's
			// touchstart was suppressed while it still appeared in
			// ev.touches on a later move. If anything ever skips that
			// path, lastTouchY would carry over from before the multi-
			// touch and produce a phantom scroll jump on the first
			// single-touch frame after the second finger lifts. Clearing
			// here makes that impossible regardless.
			if (ev.touches.length !== 1) lastTouchY = null;
			return;
		}
		const y = ev.touches[0]!.clientY;
		const cellH = getCellHeight();
		const deltaPx = lastTouchY - y;
		const lines = Math.trunc(deltaPx / cellH);

		// Suppress xterm's drag-selection handler on every frame the
		// gesture qualifies as a scroll — either because it's already
		// been classified as one (touchIsScroll) or because *this* frame
		// crossed at least one cell (lines !== 0) and is about to flip
		// the flag. A single call covers both paths:
		//   - First qualifying frame: lines !== 0 trips the OR;
		//     touchIsScroll flips below.
		//   - Subsequent frames once classified: touchIsScroll trips
		//     the OR, including sub-cell frames where lines === 0.
		// Previously this was two separate ev.preventDefault() calls
		// straddling the `if (lines === 0)` early return — correct
		// (preventDefault is idempotent) but the duplication looked
		// suspicious. touch-action:none is set in CSS, so calling
		// preventDefault here doesn't trigger a passive-listener
		// warning even on the first qualifying frame.
		if (touchIsScroll || lines !== 0) ev.preventDefault();
		if (lines === 0) return;

		touchIsScroll = true;

		if (term.buffer.active.type === "alternate") {
			// Cap the burst so a fast flick doesn't fire 100+ arrows
			// at the app in one frame.
			const n = Math.min(Math.abs(lines), 20);
			const key = lines > 0 ? "\x1b[B" : "\x1b[A";
			send({ type: "input", data: key.repeat(n) });
		} else {
			term.scrollLines(lines);
		}
		lastTouchY -= lines * cellH;
	};
	const onTouchEnd = () => {
		// If the finger never moved a full cell it was a tap: focus xterm
		// so the OS keyboard appears for typing. Scroll gestures skip this
		// so the keyboard doesn't flash open mid-swipe.
		// Guard on lastTouchY !== null: a multi-touch start (pinch) clears
		// lastTouchY and resets touchIsScroll, so when one finger lifts we
		// must not treat it as a tap and pop the keyboard.
		if (!touchIsScroll && lastTouchY !== null) term.focus();
		lastTouchY = null;
		touchIsScroll = false;
	};
	const onTouchCancel = () => {
		lastTouchY = null;
		touchIsScroll = false;
	};

	container.addEventListener("touchstart", onTouchStart, { passive: true });
	// passive:false required so ev.preventDefault() can stop xterm's drag-selection
	container.addEventListener("touchmove", onTouchMove, { passive: false });
	container.addEventListener("touchend", onTouchEnd, { passive: true });
	container.addEventListener("touchcancel", onTouchCancel, { passive: true });

	// ── Wheel scroll ────────────────────────────────────────────────────────
	// Desktop wheel/trackpad routing pairs with the WheelUpPane/WheelDownPane
	// bindings in `session-image/tmux.conf`. xterm's default with
	// `set -g mouse on` is to forward wheel events as SGR mouse-tracking; we
	// intercept ahead of that:
	//
	//   - Main buffer (shell): scroll xterm's own scrollback via
	//     `scrollLines`. `return false` cancels xterm's forward so the SGR
	//     sequence never leaves the browser, and tmux can't discard it
	//     (#171).
	//   - Alt buffer (claude TUI, less, vim, htop, …): `return true`. Let
	//     xterm forward as SGR mouse-tracking and let tmux's WheelUpPane
	//     binding decide. tmux now routes that into copy-mode for apps
	//     that don't request mouse (claude / Ink) so the user reaches the
	//     pane history; vim/htop still get `send-keys -M` because they
	//     set `mouse_any_flag`. See the binding rationale in tmux.conf.
	//     Earlier attempts to synthesise arrow keys here (#176) ended up
	//     navigating the *input* line history (readline-style) for claude
	//     instead of scrolling the rendered output, so this path was
	//     reverted to forward-and-let-tmux-handle.
	//
	// Sensitivity: notched mice can deliver either `DOM_DELTA_LINE`
	// (`deltaY === 1` per notch) or `DOM_DELTA_PIXEL` (`deltaY` close to
	// `cellH` per notch). Both produced one-line-per-notch with a 1×
	// multiplier, far slower than the OS-typical ~3 lines/notch. Apply a
	// shared multiplier to both modes. Trackpad smooth-scroll (many
	// small `DOM_DELTA_PIXEL` events) is amplified too, but the residue
	// accumulator and small per-event `deltaY` keep the felt speed
	// reasonable in practice; tunable up/down here without touching the
	// rest of the handler.
	const WHEEL_SENSITIVITY = 3;
	let wheelResidue = 0;
	// Known limitation: tmux copy-mode (Ctrl-b [) is *not* the alternate
	// screen — `pane_in_mode` is tmux-internal state that doesn't propagate
	// to `xterm.buffer.active.type`. When the user has manually entered
	// copy-mode from the main buffer, this handler still scrolls xterm's
	// own scrollback instead of driving copy-mode's cursor. Querying
	// `#{pane_in_mode}` from the frontend would need a side-channel we
	// don't have. Workaround for users in main-buffer copy-mode: arrow
	// keys / Page Up/Down inside copy-mode instead of the wheel.
	term.attachCustomWheelEventHandler((ev) => {
		// DEBUG (#178 follow-up): user reports wheel does nothing in bash
		// despite scrollback content. Log every wheel event + the buffer/
		// scroll state so we can see whether the handler fires, what
		// values the browser delivers, and whether `term.scrollLines`
		// has any visible effect on `viewportY`. Remove once diagnosed.
		const _bufBefore = term.buffer.active;
		const _yBefore = _bufBefore.viewportY;
		const _baseBefore = _bufBefore.baseY;
		const _bufType = _bufBefore.type;
		// Alt buffer → forward to xterm's default; tmux's binding takes it
		// from there. Keep the early return *before* residue accounting so
		// switching buffers mid-gesture doesn't carry residue across modes.
		if (term.buffer.active.type === "alternate") {
			console.log("[wheel-debug] ALT-BUFFER forward", {
				deltaMode: ev.deltaMode,
				deltaY: ev.deltaY,
				bufType: _bufType,
			});
			return true;
		}
		const cellH = getCellHeight();
		let deltaPx: number;
		switch (ev.deltaMode) {
			case 1: // DOM_DELTA_LINE
				deltaPx = ev.deltaY * cellH * WHEEL_SENSITIVITY;
				break;
			case 2: // DOM_DELTA_PAGE
				deltaPx = ev.deltaY * cellH * term.rows;
				break;
			default: // DOM_DELTA_PIXEL — what trackpads and most modern mice emit
				deltaPx = ev.deltaY * WHEEL_SENSITIVITY;
		}
		// Reset the residue if the user reverses direction — otherwise a
		// long downward swipe followed by a short upward flick would have
		// to "spend" the accumulated downward residue before any upward
		// scroll registered, which feels broken at the input boundary.
		// Gate on `deltaPx !== 0` so a horizontal-only wheel event
		// (`ev.deltaY === 0`, common on trackpads doing diagonal/sideways
		// gestures) doesn't trip the reset: `0 < 0` is false, which would
		// always look like "opposite sign" against any upward (negative)
		// residue and silently discard it mid-gesture.
		if (deltaPx !== 0 && deltaPx < 0 !== wheelResidue < 0) wheelResidue = 0;
		wheelResidue += deltaPx;
		const lines = Math.trunc(wheelResidue / cellH);
		if (lines === 0) {
			console.log("[wheel-debug] no-op", {
				deltaMode: ev.deltaMode,
				deltaY: ev.deltaY,
				cellH,
				deltaPx,
				wheelResidue,
				lines,
				bufType: _bufType,
				yBefore: _yBefore,
				baseBefore: _baseBefore,
			});
			return false;
		}
		wheelResidue -= lines * cellH;
		term.scrollLines(lines);
		const _bufAfter = term.buffer.active;
		console.log("[wheel-debug] scrollLines", {
			deltaMode: ev.deltaMode,
			deltaY: ev.deltaY,
			cellH,
			deltaPx,
			lines,
			bufType: _bufType,
			yBefore: _yBefore,
			yAfter: _bufAfter.viewportY,
			baseBefore: _baseBefore,
			baseAfter: _bufAfter.baseY,
			scrolled: _bufAfter.viewportY !== _yBefore,
		});
		return false;
	});

	// ── Resize ──────────────────────────────────────────────────────────────
	// ResizeObserver fires continuously during mobile viewport churn (URL
	// bar show/hide, soft-keyboard open/close, rotation) and desktop
	// window drags. Coalescing to one fit per frame avoids overlapping
	// tmux redraws that leave half-painted cells on screen.
	//
	// LOCAL fit runs every animation frame so the visible terminal
	// tracks the container smoothly (xterm handles the cell math client
	// side). The REMOTE resize notification is trailing-debounced on a
	// short idle window, because every `{type:"resize"}` WS message
	// triggers a synchronous chain on the backend:
	//
	//   wsHandler → DockerManager.resize → recomputeSize →
	//   exec.resize → tmux resize-window → pane repaint fan-out.
	//
	// A sustained window-edge drag on a 1080p display can cross cell
	// boundaries ~50× per second; forwarding every crossing lets the
	// Docker exec API queue up dozens of resizes that tmux processes
	// after the fact, producing a cascade of repaints that each get
	// invalidated by the next one. Debouncing collapses a drag into a
	// single backend resize at the settled size.
	//
	// 100 ms is enough to absorb the noisy tail of a mouse-drag or
	// soft-keyboard slide but short enough to feel "instant" when the
	// user stops adjusting.
	const RESIZE_DEBOUNCE_MS = 100;
	let lastSentCols = term.cols;
	let lastSentRows = term.rows;
	let fitScheduled = false;
	let resizeSendTimer: ReturnType<typeof setTimeout> | null = null;
	const sendResizeDebounced = () => {
		if (resizeSendTimer !== null) clearTimeout(resizeSendTimer);
		resizeSendTimer = setTimeout(() => {
			resizeSendTimer = null;
			// Skip if disposed between schedule and fire — the socket is
			// already being torn down by the parent component.
			if (disposed) return;
			// Re-check dimensions at fire time; they may have bounced back
			// to the last-sent size during the debounce window (e.g. user
			// overshoots a drag and returns). No point spending a round
			// trip for a no-op.
			if (term.cols === lastSentCols && term.rows === lastSentRows) return;
			lastSentCols = term.cols;
			lastSentRows = term.rows;
			send({ type: "resize", cols: term.cols, rows: term.rows });
		}, RESIZE_DEBOUNCE_MS);
	};
	const scheduleFit = () => {
		if (fitScheduled) return;
		fitScheduled = true;
		requestAnimationFrame(() => {
			fitScheduled = false;
			try {
				fitAddon.fit();
			} catch {
				/* container detached mid-resize */
			}
			if (term.cols !== lastSentCols || term.rows !== lastSentRows) {
				// Soft-keyboard slide-in, URL bar reveal, font-size cycle, and
				// rotation can all narrow xterm to fewer rows/cols mid-stream.
				// Two failure modes (#155):
				//
				//   1. WebGL atlas stale — at a different cell pixel height
				//      (font-size cycle, DPR change while we were fitting),
				//      cached glyph textures don't align with the new grid;
				//      tmux's repaint lands on top of misaligned cells and
				//      leaves duplicated rows / ghost glyphs visible until
				//      the next visibility change.
				//   2. Backend lag on shrink — tmux is still painting at the
				//      OLD size for the duration of the debounce window.
				//      Anything it writes past the new bottom row lands on
				//      cells xterm has already reflowed away. Bypassing the
				//      debounce in the shrink direction tells tmux to resize
				//      now so it stops over-painting; growth still coalesces
				//      because nothing on the wire goes wrong if tmux paints
				//      at a SMALLER size than xterm has already reflowed to.
				//
				// History note: this block was originally landed in #159 and
				// reverted in #163 during a debugging session attributing
				// "text outside input lines" / "Mac wheel dead" to it. Those
				// symptoms have since been traced to other root causes —
				// #169 (first-tab fit-before-tab-bar layout race) and #173
				// (tmux mouse-on consuming wheel events) — and fixed
				// independently. Re-applying with that diagnostic context.
				const shrinking = term.rows < lastSentRows || term.cols < lastSentCols;
				try {
					webgl?.clearTextureAtlas();
				} catch {
					webgl?.dispose();
					webgl = null;
				}
				term.refresh(0, term.rows - 1);
				if (shrinking) {
					if (resizeSendTimer !== null) clearTimeout(resizeSendTimer);
					resizeSendTimer = null;
					lastSentCols = term.cols;
					lastSentRows = term.rows;
					send({ type: "resize", cols: term.cols, rows: term.rows });
				} else {
					sendResizeDebounced();
				}
			}
		});
	};
	const ro = new ResizeObserver(scheduleFit);
	ro.observe(container);

	// ── Visibility / focus refresh ──────────────────────────────────────────
	// Backgrounded tabs get rAF throttled, so xterm's renderer stops
	// flushing dirty cells while the user is away. Output still streams
	// in and lands in the internal buffer, but the painted DOM/canvas
	// can end up several screens stale by the time the tab returns.
	//
	// On return, re-fit (viewport may have resized while hidden), wipe
	// the WebGL texture atlas (fonts render sharp again after DPR change
	// or OS font-smoothing toggles), and force a full refresh so every
	// row repaints.
	const onVisibilityChange = () => {
		if (document.hidden) return;
		// scheduleFit's rAF will atlas-clear + refresh too, but only if the
		// fit detects a dimension change. The synchronous pair below covers
		// the no-change case — tab hidden then restored at the same size,
		// where the GPU may still need a fresh atlas (DPR change, OS font-
		// smoothing toggle) and the canvas needs a repaint to flush rows
		// that streamed in while rAF was throttled. The double-fire on the
		// dimension-change path is harmless: refresh is idempotent and
		// atlas clear is cheap.
		scheduleFit();
		try {
			webgl?.clearTextureAtlas();
		} catch {
			webgl?.dispose();
			webgl = null;
		}
		term.refresh(0, term.rows - 1);
	};
	const onWindowFocus = () => {
		scheduleFit();
		term.refresh(0, term.rows - 1);
	};
	document.addEventListener("visibilitychange", onVisibilityChange);
	window.addEventListener("focus", onWindowFocus);

	// ── Helpers ─────────────────────────────────────────────────────────────
	function send(msg: object) {
		if (ws.readyState === WebSocket.OPEN) {
			ws.send(JSON.stringify(msg));
		}
	}

	function setFontSize(px: number) {
		term.options.fontSize = px;
		scheduleFit();
	}

	// term.paste() routes through the same onData handler that pipes browser
	// → WS, and wraps the bytes in DECSET 2004 bracketed-paste sequences
	// (\e[200~ … \e[201~) when the receiving app has bracketed paste on —
	// bash, zsh, and Claude CLI all do — so multi-line content arrives as
	// one paste event instead of being executed line-by-line.
	function paste(text: string) {
		term.paste(text);
	}

	// ── Dispose ─────────────────────────────────────────────────────────────
	function dispose() {
		disposed = true;
		// The resize send is debounced on a trailing 100 ms window; if the
		// user navigates away inside that window the timer would fire after
		// the socket closes. The `if (disposed) return` guard at the top of
		// the callback already makes this harmless today — but it leaves
		// the pending timer holding a closure reference to the (disposed)
		// xterm + ws for up to 100 ms, and any future logic added to the
		// callback ahead of that guard would run post-dispose. Cancel
		// here to remove the subtle refactor trap.
		if (resizeSendTimer !== null) clearTimeout(resizeSendTimer);
		ro.disconnect();
		document.removeEventListener("visibilitychange", onVisibilityChange);
		window.removeEventListener("focus", onWindowFocus);
		container.removeEventListener("pointerdown", focusOnPointer);
		container.removeEventListener("touchstart", onTouchStart);
		container.removeEventListener("touchmove", onTouchMove);
		container.removeEventListener("touchend", onTouchEnd);
		container.removeEventListener("touchcancel", onTouchCancel);
		inputDisposable.dispose();
		linkProviderDisposable.dispose();
		scrollDisposable.dispose();
		pendingRestoreCanvas?.removeEventListener("webglcontextrestored", onContextRestored);
		container.removeEventListener("webglcontextlost", onContextLost);
		webgl?.dispose();
		ws.close(1000, "User navigated away");
		term.dispose();
	}

	return { dispose, setFontSize, paste };
}

// ── Multiline URL link provider ─────────────────────────────────────────────
// xterm's built-in WebLinksAddon only matches URLs within a single row. OAuth
// URLs (like Claude's login link) commonly soft-wrap across 3–4 rows, so the
// addon only recognises the first row. This provider walks the buffer,
// reassembles soft-wrapped rows back into logical lines, finds URLs, and
// returns ILink entries whose `range` spans every row the URL actually
// occupies — hover underlines the full URL and clicking anywhere on any row
// opens the complete URL.
//
// xterm re-invokes `provideLinks` for each row the user hovers. We rebuild a
// cache of detected URLs whenever the buffer changes (onWriteParsed) rather
// than on every hover.

interface CachedLink {
	url: string;
	// 1-based buffer coordinates (xterm's ILink range convention)
	startX: number;
	startY: number;
	endX: number;
	endY: number;
}

class MultilineUrlLinkProvider implements ILinkProvider {
	private cache: CachedLink[] = [];
	private dirty = true;
	private onWrite: IDisposable;

	constructor(private term: Terminal) {
		this.onWrite = term.onWriteParsed(() => {
			this.dirty = true;
		});
	}

	provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void): void {
		if (this.dirty) this.rebuild();
		const y = bufferLineNumber;
		const links: ILink[] = [];
		for (const c of this.cache) {
			if (c.startY <= y && c.endY >= y) {
				// Return the FULL multi-row range, not a per-row slice. xterm
				// iterates start.y → end.y internally when drawing the hover
				// underline, so one link with the full span lights up every
				// row the URL occupies. Returning per-row slices here is what
				// caused "hover only underlines the first line" — each slice
				// was a distinct link confined to its own row.
				links.push({
					range: {
						start: { x: c.startX, y: c.startY },
						end: { x: c.endX, y: c.endY },
					},
					text: c.url,
					decorations: { underline: true, pointerCursor: true },
					activate: (event, text) => {
						event.preventDefault();
						window.open(text, "_blank", "noopener,noreferrer");
					},
				});
			}
		}
		callback(links.length ? links : undefined);
	}

	dispose(): void {
		this.onWrite.dispose();
	}

	private rebuild(): void {
		this.cache = [];
		const buf = this.term.buffer.active;

		// "Terminators" that can't appear inside a URL. Includes
		// whitespace, common quote/bracket chars, and the Unicode Box
		// Drawing block — the `─-╿` range covers U+2500–U+257F (│ ─
		// ╭ ╮ etc. that ink/React TUIs draw around their panels). The
		// dash inside the brackets is a regex range operator, NOT a
		// literal hyphen-or-three-chars; flagging this so a future
		// reviewer doesn't "fix" what looks like a typo. This lets
		// us treat a row's URL "zone" as the contiguous run of
		// URL-safe chars between the left and right borders/padding
		// of the row.
		const NON_URL = /[\s<>"'`{}()[\]─-╿|]/; //   ─-╿ = box-drawing range
		const URL_RE = /https?:\/\/[^\s<>"'`{}()[\]─-╿|]+/g; // ─-╿ = box-drawing range

		// Phase 1 — for every row in the buffer, strip leading/trailing
		// non-URL chars (borders, padding) and record where the interior
		// URL zone starts and ends. Inner whitespace in the zone is kept
		// (the URL regex will terminate at it).
		interface Row {
			content: string; // interior zone, inclusive of both ends
			startCol: number; // 0-based col in the row where `content` begins
			endCol: number; // 0-based col where `content` ends (inclusive)
		}
		const rows: Row[] = [];
		for (let r = 0; r < buf.length; r++) {
			const line = buf.getLine(r);
			const raw = line?.translateToString(false) ?? "";
			let first = 0;
			let last = raw.length - 1;
			while (first <= last && NON_URL.test(raw[first])) first++;
			while (last >= first && NON_URL.test(raw[last])) last--;
			if (first > last) {
				rows.push({ content: "", startCol: -1, endCol: -1 });
			} else {
				rows.push({ content: raw.slice(first, last + 1), startCol: first, endCol: last });
			}
		}

		// Phase 2 — find URL starts and follow them across row boundaries
		// when the URL clearly continues. A "continuation" row is one
		// whose entire interior zone is a single whitespace-free run
		// (i.e. all URL-safe chars). Any whitespace anywhere in the next
		// row's zone means the URL has ended.
		for (let r = 0; r < rows.length; r++) {
			const row = rows[r];
			if (row.startCol < 0) continue;
			for (const m of row.content.matchAll(URL_RE)) {
				if (m.index === undefined) continue;
				let url = m[0];
				const matchStartInZone = m.index;
				const matchEndInZone = matchStartInZone + url.length; // exclusive
				let endRow = r;
				let endColInRow = row.startCol + matchEndInZone - 1;

				// Only try to extend if the URL reaches the very end of the
				// row's interior — otherwise the URL already terminated with
				// whitespace or punctuation on this same row.
				if (matchEndInZone === row.content.length) {
					for (let next = r + 1; next < rows.length; next++) {
						const nr = rows[next];
						if (nr.startCol < 0) break; // empty row ends the URL
						if (/\s/.test(nr.content)) break; // sentence text, not URL
						url += nr.content;
						endRow = next;
						endColInRow = nr.endCol;
					}
				}

				// Strip trailing sentence punctuation that's usually not URL.
				const trailingPunct = url.match(/[.,;:!?)]+$/)?.[0] ?? "";
				if (trailingPunct) {
					url = url.slice(0, -trailingPunct.length);
					endColInRow -= trailingPunct.length;
				}
				if (!url) continue;

				this.cache.push({
					url,
					// +1 because xterm's IBufferRange is 1-based in both x and y.
					startX: row.startCol + matchStartInZone + 1,
					startY: r + 1,
					endX: endColInRow + 1,
					endY: endRow + 1,
				});
			}
		}

		this.dirty = false;
	}
}

// ── URL builder ─────────────────────────────────────────────────────────────

function buildWsUrl(
	sessionId: string,
	tabId: string | undefined,
	cols: number,
	rows: number,
): string {
	// Use VITE_API_URL to derive the WebSocket URL
	const apiUrl = import.meta.env.VITE_API_URL ?? "http://localhost:3001";
	const url = new URL(apiUrl);
	const wsProto = url.protocol === "https:" ? "wss:" : "ws:";
	const base = `${wsProto}//${url.host}/ws/sessions/${sessionId}`;
	const params = new URLSearchParams();
	// tabId is server-issued and re-validated on the backend before any
	// `tmux attach -t` — see backend/src/wsHandler.ts (rawTab regex
	// /^[a-zA-Z0-9._-]{1,64}$/). Excluding `:` is the load-bearing part:
	// tmux target syntax needs a colon to parse `session:window.pane`, so
	// `.` alone can't escalate a tabId into a different tmux target.
	if (tabId) params.set("tab", tabId);
	// Geometry is bounds-checked server-side (1..1024 integer); a missing
	// or out-of-range value falls back to D1's stored session.cols/rows.
	if (Number.isInteger(cols) && cols > 0) params.set("cols", String(cols));
	if (Number.isInteger(rows) && rows > 0) params.set("rows", String(rows));
	const qs = params.toString();
	return qs ? `${base}?${qs}` : base;
}
