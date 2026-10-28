// ──────────────────────────────────────────────────────────────────────────────
// The real port dispatcher (createPortDispatcher → lookupDispatchTarget →
// http-proxy) as a standalone server for the recreation audit smoke
// (backend/src/recreate/recreateAudit.smoke.ts). It runs in a container on
// the smoke's Docker network, so it reaches a session container by its
// `--name` over Docker's DNS exactly as the backend does on `sessions-net`.
//
// D1 is the only thing emulated: `globalThis.fetch` is replaced (before
// db.ts is loaded) by a reader of the smoke's simulated D1 state,
// $D1_STATE_DIR/<sessionId>.json ({ row, mappings }), answering the one
// JOIN `lookupDispatchTarget` issues. The SQL, its cache, the host parser,
// the auth gate (real `verifyJwt`) and the proxy are production code.
//
// Two cookies (the owner's and another user's) are minted with the same
// throwaway JWT_SECRET and written to $TOKENS_OUT for the smoke to use; they
// are never printed.
//
// Run from backend/: npx tsx ../session-image/test/st-dispatcher.mts
// Env: D1_STATE_DIR, TOKENS_OUT, JWT_SECRET, BASE_DOMAIN, OWNER_USER_ID, PORT (3000).
// ──────────────────────────────────────────────────────────────────────────────
import fs from "node:fs";
import http from "node:http";

const stateDir = process.env.D1_STATE_DIR ?? "";
const tokensOut = process.env.TOKENS_OUT ?? "";
const baseDomain = process.env.BASE_DOMAIN ?? "";
const owner = process.env.OWNER_USER_ID ?? "";
const port = Number(process.env.PORT ?? 3000);
if (!stateDir || !tokensOut || !baseDomain || !owner || !process.env.JWT_SECRET) {
	console.error("st-dispatcher: D1_STATE_DIR, TOKENS_OUT, BASE_DOMAIN, OWNER_USER_ID and JWT_SECRET are required");
	process.exit(2);
}
process.env.CLOUDFLARE_ACCOUNT_ID ??= "smoke";
process.env.CLOUDFLARE_API_TOKEN ??= "smoke";
process.env.D1_DATABASE_ID ??= "smoke";

const ok = (results: unknown[] = []) =>
	new Response(JSON.stringify({ success: true, errors: [], result: [{ results, success: true, meta: {} }] }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
	const { sql, params = [] } = JSON.parse(String(init?.body ?? "{}")) as { sql: string; params?: unknown[] };
	if (/FROM sessions_port_mappings spm\s+JOIN sessions s/.test(sql)) {
		const sid = String(params[0]);
		// Only a session id shape reaches the file system.
		if (!/^[0-9a-f-]{36}$/.test(sid)) return ok();
		let state: {
			row: { status: string; container_name: string; user_id: string };
			mappings: Array<{ containerPort: number; isPublic: boolean }>;
		};
		try {
			state = JSON.parse(fs.readFileSync(`${stateDir}/${sid}.json`, "utf8"));
		} catch {
			return ok();
		}
		if (state.row.status !== "running") return ok();
		return ok(
			state.mappings.map((m) => ({
				container_port: m.containerPort,
				container_name: state.row.container_name,
				is_public: m.isPublic ? 1 : 0,
				user_id: state.row.user_id,
			})),
		);
	}
	console.error(`st-dispatcher: unexpected D1 statement: ${sql}`);
	return ok();
}) as typeof fetch;

const { validateJwtSecret } = await import("../../backend/src/auth.ts");
const { createPortDispatcher } = await import("../../backend/src/portDispatcher.ts");
// Resolved from backend/, whose node_modules this script runs against
// (session-image/test has none).
const { createRequire } = await import("node:module");
const jwt = createRequire(new URL("../../backend/package.json", import.meta.url))(
	"jsonwebtoken",
) as typeof import("jsonwebtoken");
validateJwtSecret();
const sign = (sub: string) =>
	jwt.sign({ sub, username: sub }, process.env.JWT_SECRET as string, { expiresIn: "1h" });
fs.writeFileSync(tokensOut, JSON.stringify({ owner: sign(owner), other: sign(`${owner}-other`) }), {
	mode: 0o600,
});

const dispatcher = createPortDispatcher({ baseDomain, corsOrigins: [], nodeEnv: "test" });
const server = http.createServer((req, res) => {
	dispatcher.middleware(req, res, () => {
		res.statusCode = 421; // not a dispatcher host
		res.end();
	});
});
server.listen(port, "0.0.0.0", () => console.log(`st-dispatcher listening on ${port}`));
