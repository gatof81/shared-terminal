/**
 * pushEndpoint.ts — which URLs the backend may POST a push message to (#566).
 *
 * A subscription's `endpoint` comes from the client. Before #566 any
 * `https://` URL was stored, and the bell sweeper made the backend POST to it:
 * a blind SSRF from the backend's network (sessions-net, the host), with the
 * row's survival after a 404/410 telling the caller what answered. So the
 * endpoint must name a real push service:
 *   - https, default port, no userinfo;
 *   - a host name, never an IP literal, matching the allowlist exactly or
 *     under a `*.` suffix;
 *   - no trailing dot (`fcm.googleapis.com.` resolves the same but would
 *     dodge an exact-match reading of the list).
 * The browsers' push services are fixed per vendor, so the default list is
 * short; `PUSH_ENDPOINT_HOSTS` replaces it (comma-separated) for a vendor
 * not listed. A malformed entry refuses the whole value: a typo must not
 * silently widen or empty the list.
 *
 * Redirects are not a way around it: web-push's `https.request` never follows
 * one. DNS is: an allowlisted name is assumed to resolve to the vendor.
 *
 * The check must hold for the URL web-push CONNECTS to, and web-push (3.6.x)
 * parses the endpoint with the legacy `url.parse`, not WHATWG `new URL`. The
 * two disagree: WHATWG keeps `'`, `;`, `{`… inside a host, legacy cuts the host
 * there — `https://127.0.0.1'.push.services.mozilla.com/` matched the
 * `*.push.services.mozilla.com` suffix here and connected to 127.0.0.1 there
 * (#574 review). So the host must be a plain DNS name, AND the legacy parse
 * must name the same host with no port, no userinfo, over https.
 */

import net from "node:net";
import { parse as legacyParse } from "node:url";

/** Chrome/Android (FCM), Firefox (autopush), Safari (APNs web), Edge (WNS). */
export const DEFAULT_PUSH_HOSTS: readonly string[] = [
	"fcm.googleapis.com",
	"*.push.services.mozilla.com",
	"web.push.apple.com",
	"*.notify.windows.com",
];

// A DNS name: labels of letters, digits and inner hyphens; lower-case only
// (the URL parser lower-cases what it compares against).
const HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

/** Parse `PUSH_ENDPOINT_HOSTS`; unset/blank ⇒ the default list. Throws on a malformed entry. */
export function pushEndpointHosts(env: NodeJS.ProcessEnv = process.env): readonly string[] {
	const raw = env.PUSH_ENDPOINT_HOSTS?.trim();
	if (!raw) return DEFAULT_PUSH_HOSTS;
	const hosts = raw.split(",").map((h) => h.trim().toLowerCase());
	for (const h of hosts) {
		const name = h.startsWith("*.") ? h.slice(2) : h;
		if (!HOST_RE.test(name)) {
			throw new Error(`PUSH_ENDPOINT_HOSTS: ${JSON.stringify(h)} is not a host name or a *.suffix`);
		}
	}
	return hosts;
}

export type EndpointCheck = { ok: true } | { ok: false; reason: string };

/** Whether `endpoint` may receive a push from this backend. */
export function checkPushEndpoint(endpoint: string, hosts: readonly string[]): EndpointCheck {
	let u: URL;
	try {
		u = new URL(endpoint);
	} catch {
		return { ok: false, reason: "not a URL" };
	}
	if (u.protocol !== "https:") return { ok: false, reason: "not https" };
	if (u.username || u.password) return { ok: false, reason: "userinfo" };
	// The parser drops `:443` for https, so any port left is another one.
	if (u.port !== "") return { ok: false, reason: "port" };
	const host = u.hostname;
	if (net.isIP(host.replace(/^\[|\]$/g, "")) !== 0) return { ok: false, reason: "IP literal" };
	if (host.endsWith(".")) return { ok: false, reason: "trailing dot" };
	if (!HOST_RE.test(host)) return { ok: false, reason: "host not a DNS name" };
	// What web-push will actually use (see the header): any disagreement is refused.
	const legacy = legacyParse(endpoint);
	if (
		legacy.protocol !== "https:" ||
		legacy.hostname !== host ||
		(legacy.port !== null && legacy.port !== "443") ||
		legacy.auth !== null
	) {
		return { ok: false, reason: "ambiguous URL" };
	}
	const allowed = hosts.some((h) =>
		h.startsWith("*.") ? host.endsWith(h.slice(1)) && host.length > h.length - 1 : host === h,
	);
	return allowed ? { ok: true } : { ok: false, reason: "host not allowed" };
}
