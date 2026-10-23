/**
 * conversation/noProxy.ts — docs/CONVERSATION.md §2.6 "Proxies de la sesión".
 *
 * The CLI sends an HTTP hook through `HTTP_PROXY`/`HTTPS_PROXY` unless the
 * URL's host is listed in `NO_PROXY`/`no_proxy` (exact host match; loopback
 * gets no implicit exemption in 2.1.308). A proxy cannot reach the
 * container's own loopback, so with a proxy in the session env every hook
 * to the relay would be lost. Adding `127.0.0.1` fixes exactly that and
 * changes nothing else: no proxy can serve that address for Claude anyway.
 *
 * Applied only when capture is effective for the spawn, and only when the
 * session env defines a proxy — otherwise the env is returned untouched.
 * Kept free of imports so dockerManager.ts can use it without pulling in
 * the D1-backed conversation modules.
 */

const PROXY_VARS = [
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"ALL_PROXY",
	"http_proxy",
	"https_proxy",
	"all_proxy",
];
const RELAY_HOST = "127.0.0.1";

function withHost(list: string): string {
	const entries = list.split(/[,\s]+/).filter(Boolean);
	if (entries.includes("*") || entries.includes(RELAY_HOST)) return list;
	return entries.length ? `${list},${RELAY_HOST}` : RELAY_HOST;
}

export function withRelayNoProxy(env: string[]): string[] {
	const value = new Map<string, string>();
	for (const entry of env) {
		const eq = entry.indexOf("=");
		if (eq > 0) value.set(entry.slice(0, eq), entry.slice(eq + 1));
	}
	if (!PROXY_VARS.some((k) => value.get(k))) return env;
	const out = env.map((entry) => {
		for (const k of ["NO_PROXY", "no_proxy"]) {
			if (entry.startsWith(`${k}=`)) return `${k}=${withHost(entry.slice(k.length + 1))}`;
		}
		return entry;
	});
	for (const k of ["NO_PROXY", "no_proxy"]) {
		if (!value.has(k)) out.push(`${k}=${RELAY_HOST}`);
	}
	return out;
}
