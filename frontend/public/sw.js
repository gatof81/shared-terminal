// sw.js — Web Push service worker (#355, PR 3/3).
//
// Intentionally NOT bundled. Vite copies everything under public/ to the
// build output verbatim, so this file ships at the site root (/sw.js) and
// therefore registers at root scope ("/") — a service worker's scope can
// never be broader than its own URL path, so a bundled worker emitted under
// /assets/ could only ever control /assets/*, never the app. Keeping it here,
// as plain JS with no imports, is the only way it can receive push events for
// the whole origin.
//
// This runs in the ServiceWorkerGlobalScope, not a browser window: `self` is
// the registration, and there is no `window`/`document`. Kept dependency-free.

/* global self, clients */

const FALLBACK_TITLE = "Shared Terminal";
const FALLBACK_BODY = "You have a new notification.";
const ICON_URL = "/icons/icon-192.png";

self.addEventListener("push", (event) => {
	// Some browsers deliver payload-less pushes (keep-alive / test pings from
	// the push service). `event.data.json()` throws on those, so guard the
	// whole parse and fall back to a generic notification rather than letting
	// the handler reject — a rejected push handler shows the browser's own
	// "This site has been updated in the background" notification instead.
	let payload = {};
	if (event.data) {
		try {
			payload = event.data.json();
		} catch {
			payload = {};
		}
	}

	const title = payload.title || FALLBACK_TITLE;
	const body = payload.body || FALLBACK_BODY;
	const sessionId = payload.sessionId;

	event.waitUntil(
		self.registration.showNotification(title, {
			body,
			icon: ICON_URL,
			// tag+renotify collapses repeated pushes for the same session into
			// one notification instead of stacking a wall of them.
			tag: sessionId || "shared-terminal",
			data: { sessionId },
		}),
	);
});

self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const sessionId = event.notification.data && event.notification.data.sessionId;

	event.waitUntil(
		(async () => {
			const windowClients = await clients.matchAll({
				type: "window",
				includeUncontrolled: true,
			});

			// Prefer focusing an already-open app window and letting it switch
			// to the session in place, rather than spawning a duplicate tab.
			for (const client of windowClients) {
				if ("focus" in client) {
					await client.focus();
					if (sessionId) {
						client.postMessage({ type: "open-session", sessionId });
					}
					return;
				}
			}

			// No window open — open the app root. The SW is served from the
			// Pages origin, so this lands on the SPA; a #session hash lets the
			// app auto-open the session on boot without a query-string reload.
			const url = sessionId ? `/#session=${encodeURIComponent(sessionId)}` : "/";
			await clients.openWindow(url);
		})(),
	);
});
