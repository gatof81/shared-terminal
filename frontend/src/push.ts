/**
 * push.ts — Web Push subscription lifecycle (#355, PR 3/3).
 *
 * Owns the browser-side plumbing: service-worker registration, the
 * permission → subscribe → POST flow, and the toggle-state decision the
 * "Notifications" button renders from. Wire calls live in api.ts; the
 * source of truth for "is this device subscribed" is the browser's own
 * PushManager + the server status, never localStorage.
 */

import { fetchVapidKey, getPushStatus, subscribePush, unsubscribePush } from "./api.js";

// ── VAPID key decoding ──────────────────────────────────────────────────────

/**
 * Decode a base64url VAPID public key into the `Uint8Array` that
 * `pushManager.subscribe({ applicationServerKey })` requires. The key is
 * transmitted base64url (URL-safe alphabet, no padding); this restores the
 * padding and standard alphabet before `atob`. Pure — unit-tested.
 */
// Return type pins the backing buffer to ArrayBuffer (not ArrayBufferLike):
// `pushManager.subscribe`'s `applicationServerKey: BufferSource` rejects a
// possibly-SharedArrayBuffer-backed Uint8Array under the current DOM lib.
export function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
	const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
	const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
	const raw = atob(base64);
	const output = new Uint8Array(new ArrayBuffer(raw.length));
	for (let i = 0; i < raw.length; i++) {
		output[i] = raw.charCodeAt(i);
	}
	return output;
}

// ── Toggle-state decision (pure) ────────────────────────────────────────────

export type PushToggleState = "unsupported" | "ios-needs-install" | "blocked" | "on" | "off";

export interface PushToggleInputs {
	/** `isPushSupported()` — the browser exposes SW + PushManager + Notification. */
	supported: boolean;
	/** GET /push/status `.enabled` — server has VAPID configured. */
	serverEnabled: boolean;
	/** GET /push/status `.subscribed` — this endpoint is in the server's set. */
	serverSubscribed: boolean;
	/** `Notification.permission` at decision time. */
	permission: NotificationPermission;
	/** Running on an iOS/iPadOS device (Web Push there needs a home-screen PWA). */
	isIos: boolean;
	/** Launched in standalone display-mode (installed to the home screen). */
	isStandalone: boolean;
}

/**
 * Decide how the Notifications toggle should render. Split out as a pure
 * function so the branching is unit-testable without a DOM/SW rig.
 *
 * Ordering is load-bearing:
 *  - `serverEnabled` gates everything: if the server can't push, there is
 *    nothing to offer, so hide even on iOS.
 *  - The iOS-not-installed check comes BEFORE `supported`, because iOS Safari
 *    only exposes `Notification`/`PushManager` inside an installed PWA — a
 *    non-standalone iOS visit reports `supported: false`, and we want to nudge
 *    "install to home screen" there rather than silently hiding the feature.
 */
export function decidePushToggleState(i: PushToggleInputs): PushToggleState {
	if (!i.serverEnabled) return "unsupported";
	if (i.isIos && !i.isStandalone) return "ios-needs-install";
	if (!i.supported) return "unsupported";
	if (i.permission === "denied") return "blocked";
	if (i.permission === "granted" && i.serverSubscribed) return "on";
	return "off";
}

// ── Feature detection ───────────────────────────────────────────────────────

export function isPushSupported(): boolean {
	return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

function isIosDevice(): boolean {
	const ua = navigator.userAgent;
	// iPadOS 13+ masquerades as desktop Safari ("Macintosh") but still needs
	// the installed-PWA path; a touch-capable "Macintosh" is an iPad.
	return /iP(hone|ad|od)/.test(ua) || (ua.includes("Macintosh") && navigator.maxTouchPoints > 1);
}

function isStandaloneDisplay(): boolean {
	// `navigator.standalone` is the non-standard iOS-Safari signal; the
	// media query is the cross-browser one. Either being true means installed.
	const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
	return window.matchMedia?.("(display-mode: standalone)").matches === true || iosStandalone;
}

// ── Service-worker registration ─────────────────────────────────────────────

let swRegistration: Promise<ServiceWorkerRegistration> | null = null;

/**
 * Register /sw.js at root scope. Idempotent: memoises the registration
 * promise so boot + a later `enablePush()` don't each hit the registration
 * machinery. Returns null when the browser has no service-worker support.
 */
export function registerServiceWorker(): Promise<ServiceWorkerRegistration> | null {
	if (!("serviceWorker" in navigator)) return null;
	if (!swRegistration) {
		swRegistration = navigator.serviceWorker.register("/sw.js", { scope: "/" });
	}
	return swRegistration;
}

// ── Enable / disable ────────────────────────────────────────────────────────

export async function enablePush(): Promise<void> {
	if (!isPushSupported()) {
		throw new Error("Push notifications aren't supported in this browser.");
	}
	const permission = await Notification.requestPermission();
	if (permission !== "granted") {
		throw new Error(
			permission === "denied"
				? "Notifications are blocked in your browser settings."
				: "Notification permission was not granted.",
		);
	}

	const key = await fetchVapidKey();
	// Ensure the SW is registered, then wait for it to become active — a
	// freshly-registered worker isn't `ready` until it activates, and
	// pushManager.subscribe needs an active registration.
	registerServiceWorker();
	const registration = await navigator.serviceWorker.ready;
	const sub = await registration.pushManager.subscribe({
		userVisibleOnly: true,
		applicationServerKey: urlBase64ToUint8Array(key),
	});

	// PushSubscription's endpoint/keys are getters that a plain spread drops;
	// the JSON round-trip materialises the { endpoint, keys:{ p256dh, auth } }
	// shape the backend validates.
	await subscribePush(JSON.parse(JSON.stringify(sub)) as PushSubscriptionJSON);
}

export async function disablePush(): Promise<void> {
	if (!("serviceWorker" in navigator)) return;
	const registration = await navigator.serviceWorker.ready;
	const sub = await registration.pushManager.getSubscription();
	if (!sub) return;
	// Drop the server row first so a subsequent local `unsubscribe()` failure
	// doesn't leave the server pushing to an endpoint the user just disabled.
	await unsubscribePush(sub.endpoint);
	await sub.unsubscribe();
}

// ── Combined state read (impure) ────────────────────────────────────────────

/**
 * Resolve the toggle's current state by combining browser feature-detection,
 * the local Notification.permission, and the server's push status. Fetches
 * GET /push/status; on failure treats the server as not-configured so the
 * toggle hides rather than rendering an inoperable control.
 */
export async function getPushToggleState(): Promise<PushToggleState> {
	const supported = isPushSupported();
	let serverEnabled = false;
	let serverSubscribed = false;
	try {
		const status = await getPushStatus();
		serverEnabled = status.enabled;
		serverSubscribed = status.subscribed;
	} catch {
		// Status fetch failed (network / auth) — leave both false so we hide.
	}
	const permission = "Notification" in window ? Notification.permission : "default";
	return decidePushToggleState({
		supported,
		serverEnabled,
		serverSubscribed,
		permission,
		isIos: isIosDevice(),
		isStandalone: isStandaloneDisplay(),
	});
}
