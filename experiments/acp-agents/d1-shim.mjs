#!/usr/bin/env node
// D1-compatible HTTP endpoint backed by SQLite (node:sqlite), for LAB backends
// only (D1_API_BASE=http://<this>:8787). Implements the one route db.ts uses:
// POST /client/v4/accounts/:a/d1/database/:d/query {sql, params} with D1's
// envelope. Foreign keys on, like D1. Never point a production backend here.
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(process.env.D1_SHIM_DB ?? "/data/d1.sqlite");
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
const ROWS = /^\s*(select|with|pragma)\b|\breturning\b/i;
const bind = (p) => (p === undefined ? null : typeof p === "boolean" ? Number(p) : p);

createServer(async (req, res) => {
	let raw = "";
	for await (const c of req) raw += c;
	const reply = (status, body) => {
		res.writeHead(status, { "content-type": "application/json" });
		res.end(JSON.stringify(body));
	};
	if (req.method !== "POST" || !/\/d1\/database\/[^/]+\/query$/.test(req.url ?? "")) return reply(404, { success: false, errors: [{ code: 404, message: "not found" }] });
	const t0 = performance.now();
	try {
		const { sql, params = [] } = JSON.parse(raw);
		const stmt = db.prepare(sql);
		const args = params.map(bind);
		let results = [];
		let changes = 0;
		let last = 0;
		if (ROWS.test(sql)) {
			results = stmt.all(...args);
			changes = db.prepare("SELECT changes() AS c").get().c;
		} else {
			const r = stmt.run(...args);
			changes = Number(r.changes);
			last = Number(r.lastInsertRowid);
		}
		reply(200, {
			success: true,
			errors: [],
			result: [{ results, success: true, meta: { changes, duration: performance.now() - t0, last_row_id: last } }],
		});
	} catch (err) {
		reply(400, { success: false, errors: [{ code: 7500, message: String(err.message) }], result: [] });
	}
}).listen(Number(process.env.PORT ?? 8787), () => console.log("d1 shim ready"));
