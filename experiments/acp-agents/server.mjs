#!/usr/bin/env node
// Durable agent-message inbox (ACP PoC). Zero dependencies: node:http + node:sqlite.
//
// The schema is plain SQLite on purpose: the same table can live in D1 when this
// moves into the backend, so it replaces the project-conversation queue instead of
// adding a second one.
//
// Invariants:
// - A message is INSERTed (and committed) before the 201 that acknowledges it.
// - At most one `running` message per agent: delivery is one job at a time.
// - A `running` message is never put back to `pending` by the system. After a
//   crash the runner settles it from acpx's evidence (done) or marks it
//   `uncertain`; only the owner can requeue an uncertain message.
// - The reply to an agent's request is produced from the ACP turn result in the
//   same transaction that records it — the agent does not have to send it.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const PORT = Number(process.env.PORT ?? 8080);
const DB_PATH = process.env.ST_DB ?? "/data/messages.db";
// { "tokens": { "<token>": "owner" | "<agent>" } }
const CONFIG = JSON.parse(readFileSync(process.env.ST_CONFIG ?? "/data/config.json", "utf8"));
const identities = new Map(Object.entries(CONFIG.tokens));
const agents = new Set([...identities.values()].filter((n) => n !== "owner"));

const db = new DatabaseSync(DB_PATH);
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
CREATE TABLE IF NOT EXISTS agent_messages (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	from_id TEXT NOT NULL,
	to_id TEXT NOT NULL,
	kind TEXT NOT NULL CHECK (kind IN ('request', 'reply')),
	reply_to INTEGER REFERENCES agent_messages(id),
	body TEXT NOT NULL,
	state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'done', 'failed', 'uncertain')),
	attempts INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	started_at TEXT,
	finished_at TEXT,
	result_text TEXT,
	stop_reason TEXT,
	acp_request_id TEXT,
	note TEXT
);
CREATE INDEX IF NOT EXISTS agent_messages_inbox ON agent_messages (to_id, state, id);
`);

const now = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
const q = {
	insert: db.prepare(
		"INSERT INTO agent_messages (from_id, to_id, kind, reply_to, body, state) VALUES (?, ?, ?, ?, ?, 'pending') RETURNING *",
	),
	get: db.prepare("SELECT * FROM agent_messages WHERE id = ?"),
	running: db.prepare("SELECT * FROM agent_messages WHERE to_id = ? AND state = 'running'"),
	// One statement: claims the oldest pending only if nothing is running for that agent.
	claim: db.prepare(`UPDATE agent_messages SET state = 'running', attempts = attempts + 1, started_at = ${now}
		WHERE id = (SELECT id FROM agent_messages WHERE to_id = ?1 AND state = 'pending' ORDER BY id LIMIT 1)
		AND NOT EXISTS (SELECT 1 FROM agent_messages WHERE to_id = ?1 AND state = 'running')
		RETURNING *`),
	settle: db.prepare(`UPDATE agent_messages SET state = ?, result_text = ?, stop_reason = ?, acp_request_id = ?, note = ?, finished_at = ${now}
		WHERE id = ? AND state = 'running' RETURNING *`),
	release: db.prepare("UPDATE agent_messages SET state = 'pending', note = ? WHERE id = ? AND state = 'running' RETURNING *"),
	requeue: db.prepare("UPDATE agent_messages SET state = 'pending', note = ? WHERE id = ? AND state = 'uncertain' RETURNING *"),
	list: db.prepare(
		"SELECT * FROM agent_messages WHERE (?1 IS NULL OR to_id = ?1 OR from_id = ?1) AND id > ?2 ORDER BY id LIMIT 500",
	),
};

function settleTx(id, s) {
	db.exec("BEGIN IMMEDIATE");
	try {
		const msg = q.settle.get(s.state, s.text ?? null, s.stopReason ?? null, s.requestId ?? null, s.note ?? null, id);
		if (!msg) {
			db.exec("ROLLBACK");
			return null;
		}
		let reply = null;
		// Only a completed request from another agent produces a reply. Replies and
		// owner messages only record their result — that is what ends a chain.
		if (msg.state === "done" && msg.kind === "request" && agents.has(msg.from_id)) {
			const body = `Respuesta de @${msg.to_id} a tu mensaje #${msg.id}:\n\n${msg.result_text ?? "(sin texto)"}`;
			reply = q.insert.get(msg.to_id, msg.from_id, "reply", msg.id, body);
		}
		db.exec("COMMIT");
		return { message: msg, reply };
	} catch (err) {
		db.exec("ROLLBACK");
		throw err;
	}
}

function send(res, status, body) {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(body === undefined ? "" : JSON.stringify(body));
}

async function readJson(req) {
	let raw = "";
	for await (const chunk of req) {
		raw += chunk;
		if (raw.length > 1_000_000) throw Object.assign(new Error("too large"), { status: 413 });
	}
	return raw ? JSON.parse(raw) : {};
}

const server = createServer(async (req, res) => {
	try {
		const who = identities.get((req.headers.authorization ?? "").replace(/^Bearer /, ""));
		if (!who) return send(res, 401, { error: "unauthorized" });
		const url = new URL(req.url, "http://x");
		const p = url.pathname.split("/").filter(Boolean); // v1/...
		if (p[0] !== "v1") return send(res, 404, { error: "not-found" });

		// POST /v1/messages {to, body} — the sender is the token, never the body.
		if (req.method === "POST" && p[1] === "messages" && p.length === 2) {
			const { to, body } = await readJson(req);
			const target = String(to ?? "").replace(/^@/, "");
			if (!agents.has(target)) return send(res, 400, { error: "unknown-recipient", agents: [...agents] });
			if (typeof body !== "string" || !body.trim()) return send(res, 400, { error: "empty-body" });
			const msg = q.insert.get(who, target, "request", null, body);
			return send(res, 201, { id: msg.id, state: msg.state, to: msg.to_id });
		}
		// GET /v1/messages[?agent=x&after=n] — owner sees everything, an agent its own traffic.
		if (req.method === "GET" && p[1] === "messages" && p.length === 2) {
			const agent = who === "owner" ? url.searchParams.get("agent") : who;
			return send(res, 200, q.list.all(agent, Number(url.searchParams.get("after") ?? 0)));
		}
		if (req.method === "GET" && p[1] === "messages" && p.length === 3) {
			const msg = q.get.get(Number(p[2]));
			if (!msg || (who !== "owner" && msg.to_id !== who && msg.from_id !== who))
				return send(res, 404, { error: "not-found" });
			return send(res, 200, msg);
		}
		// Runner endpoints: only the agent's own token.
		if (p[1] === "agents" && p.length === 4) {
			if (who !== p[2]) return send(res, 403, { error: "forbidden" });
			if (req.method === "GET" && p[3] === "running") {
				const msg = q.running.get(who);
				return msg ? send(res, 200, msg) : send(res, 204);
			}
			if (req.method === "POST" && p[3] === "claim") {
				const msg = q.claim.get(who);
				if (msg) return send(res, 200, msg);
				const running = q.running.get(who);
				return running ? send(res, 409, { error: "running", id: running.id }) : send(res, 204);
			}
		}
		// POST /v1/messages/:id/result {state, text, stopReason, requestId, note}
		if (req.method === "POST" && p[1] === "messages" && p[3] === "result") {
			const msg = q.get.get(Number(p[2]));
			if (!msg || msg.to_id !== who) return send(res, 404, { error: "not-found" });
			const s = await readJson(req);
			if (!["done", "failed", "uncertain"].includes(s.state)) return send(res, 400, { error: "bad-state" });
			const out = settleTx(msg.id, s);
			return out ? send(res, 200, out) : send(res, 409, { error: "not-running", state: msg.state });
		}
		// POST /v1/messages/:id/release {note} — the runner proved the prompt never left
		// (acpx failed before sending it): back to pending, nothing to be uncertain about.
		if (req.method === "POST" && p[1] === "messages" && p[3] === "release") {
			const msg = q.get.get(Number(p[2]));
			if (!msg || msg.to_id !== who) return send(res, 404, { error: "not-found" });
			const { note } = await readJson(req);
			const out = q.release.get(String(note ?? "released by runner"), msg.id);
			return out ? send(res, 200, out) : send(res, 409, { error: "not-running", state: msg.state });
		}
		// POST /v1/messages/:id/requeue — a person's decision, never automatic.
		if (req.method === "POST" && p[1] === "messages" && p[3] === "requeue") {
			if (who !== "owner") return send(res, 403, { error: "forbidden" });
			const msg = q.requeue.get("requeued by owner", Number(p[2]));
			return msg ? send(res, 200, msg) : send(res, 409, { error: "not-uncertain" });
		}
		return send(res, 404, { error: "not-found" });
	} catch (err) {
		return send(res, err.status ?? 500, { error: String(err.message ?? err) });
	}
});

server.listen(PORT, () => console.log(`st inbox on :${PORT}, agents: ${[...agents].join(", ")}`));
