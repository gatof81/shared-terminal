// ──────────────────────────────────────────────────────────────────────────────
// The real 3.0b ingest stack (createIngestHandler → ConversationService →
// ConversationStore) as a standalone receiver for the conversation-hooks
// smoke test. It stands where the backend does (`st-backend:3001`) and
// writes the same host-side event logs under $WORKSPACE_ROOT/.conversations,
// so the smoke test asserts on what production would persist, not on what a
// stub thinks it would.
//
// D1 is the only thing faked: `globalThis.fetch` is replaced (before db.ts is
// loaded) by an in-memory emulator that answers the handful of statements
// the ingest path issues, with one `running`, requested session whose token
// hash matches $ST_TEST_TOKEN. Revocation markers are real files, so the real
// `npm run conversation:disable` in another process cuts this receiver off
// exactly as it would the backend.
//
// Every request is also appended raw to $RAW_OUT (headers that matter, the
// parsed body) so the test can check identifiers before normalisation.
//
// Run from backend/: npx tsx ../session-image/test/st-receiver.mts
// Env: WORKSPACE_ROOT, ST_TEST_TOKEN, ST_TEST_SESSION, RAW_OUT, PORT (3001).
// ──────────────────────────────────────────────────────────────────────────────
import fs from "node:fs";
import http from "node:http";
import { Readable } from "node:stream";

const workspaceRoot = process.env.WORKSPACE_ROOT ?? "";
const token = process.env.ST_TEST_TOKEN ?? "";
const stSession = process.env.ST_TEST_SESSION ?? "";
const rawOut = process.env.RAW_OUT ?? "/dev/null";
const port = Number(process.env.PORT ?? 3001);
if (!workspaceRoot || !token || !stSession) {
	console.error("st-receiver: WORKSPACE_ROOT, ST_TEST_TOKEN and ST_TEST_SESSION are required");
	process.exit(2);
}
process.env.CLOUDFLARE_ACCOUNT_ID ??= "smoke";
process.env.CLOUDFLARE_API_TOKEN ??= "smoke";
process.env.D1_DATABASE_ID ??= "smoke";

const { hashIngestToken } = await import("../../backend/src/conversation/registry.ts");
const sessionRow = {
	status: "running",
	conversation_requested: 1,
	ingest_token_hash: hashIngestToken(token),
	ingest_token_hash_suspended: null,
	user_id: "smoke-user",
};
// claude_conversations ownership survives a receiver restart, as the D1 row
// would: the smoke test restarts the receiver mid-conversation.
const ownersFile = `${workspaceRoot}/.st-receiver-owners.json`;
const owners = new Map<string, string>(
	fs.existsSync(ownersFile) ? (JSON.parse(fs.readFileSync(ownersFile, "utf8")) as [string, string][]) : [],
);
const ok = (results: unknown[] = []) =>
	new Response(JSON.stringify({ success: true, errors: [], result: [{ results, success: true, meta: {} }] }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
	const { sql, params = [] } = JSON.parse(String(init?.body ?? "{}")) as { sql: string; params?: unknown[] };
	if (/FROM sessions WHERE session_id = \?/.test(sql)) return ok(params[0] === stSession ? [sessionRow] : []);
	if (/FROM sessions WHERE status = 'running'/.test(sql)) {
		return ok([{ session_id: stSession, conversation_requested: 1, ingest_token_hash: sessionRow.ingest_token_hash }]);
	}
	if (/^INSERT OR IGNORE INTO claude_conversations/.test(sql)) {
		if (!owners.has(String(params[0]))) {
			owners.set(String(params[0]), String(params[1]));
			fs.writeFileSync(ownersFile, JSON.stringify([...owners]));
		}
		return ok();
	}
	if (/^SELECT st_session_id FROM claude_conversations/.test(sql)) {
		const owner = owners.get(String(params[0]));
		return ok(owner ? [{ st_session_id: owner }] : []);
	}
	return ok();
}) as typeof fetch;

const { ConversationService } = await import("../../backend/src/conversation/service.ts");
const { ConversationStore } = await import("../../backend/src/conversation/store.ts");
const { createIngestHandler } = await import("../../backend/src/conversation/ingestRoute.ts");
const store = new ConversationStore({ workspaceRoot });
const service = new ConversationService({ workspaceRoot, enabled: true, port, store });
// Record each outcome (accepted / reason) next to the raw request, so a
// failing smoke run says WHY an event did not persist.
const outcomesOut = rawOut.replace(/\.jsonl$/, ".outcomes.jsonl");
for (const name of ["authorize", "ingest"] as const) {
	const original = service[name].bind(service) as (...args: unknown[]) => Promise<unknown>;
	(service as unknown as Record<string, unknown>)[name] = async (...args: unknown[]) => {
		const outcome = await original(...args);
		const o = outcome as { ok?: boolean; accepted?: boolean };
		if (name === "ingest" || o.ok !== true) {
			fs.appendFileSync(outcomesOut, `${JSON.stringify({ t: Date.now(), step: name, outcome })}\n`);
		}
		return outcome;
	};
}
const handler = createIngestHandler({ service });

const server = http.createServer((req, res) => {
	const chunks: Buffer[] = [];
	req.on("data", (c: Buffer) => chunks.push(c));
	req.on("end", () => {
		const buf = Buffer.concat(chunks);
		let body: Record<string, unknown> | null = null;
		try {
			body = JSON.parse(buf.toString("utf8"));
		} catch {}
		fs.appendFileSync(
			rawOut,
			`${JSON.stringify({
				t: Date.now(),
				method: req.method,
				url: req.url,
				authorization: req.headers.authorization ?? null,
				session: req.headers["x-st-session"] ?? null,
				pane: req.headers["x-st-tmux-pane"] ?? null,
				relay: Object.fromEntries(
					Object.entries(req.headers).filter(([k]) => k.startsWith("x-st-relay-")),
				),
				event: body?.hook_event_name ?? null,
				body,
			})}\n`,
		);
		// Hand the real handler a fresh stream carrying the same request.
		const replay = Readable.from([buf]) as unknown as http.IncomingMessage;
		Object.assign(replay, { headers: req.headers, method: req.method, url: req.url });
		const t0 = performance.now();
		res.on("finish", () => {
			fs.appendFileSync(rawOut.replace(/\.jsonl$/, ".responses.jsonl"), `${JSON.stringify({
				status: res.statusCode,
				ms: Math.round((performance.now() - t0) * 100) / 100,
			})}\n`);
		});
		void handler(replay, res, () => {
			res.statusCode = 404;
			res.end();
		});
	});
});

async function stop() {
	server.close();
	await service.shutdown();
	process.exit(0);
}
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
server.listen(port, "0.0.0.0", () => console.error(`st-receiver listening on ${port}`));
