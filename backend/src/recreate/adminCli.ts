/**
 * recreate/adminCli.ts — host-shell access to the recreation's §2.7.7 verbs
 * (docs/CONVERSATION.md §2.7.7, DEPLOYMENT.md "Activating an existing session"):
 *
 *   npm run recreate:admin -- <sid> preflight [--preserve] --user <admin>
 *   npm run recreate:admin -- <sid> recreate --image <sha256:…> [--preserve] --user <admin>
 *   npm run recreate:admin -- <sid> approve   --user <admin>
 *   npm run recreate:admin -- <sid> rollback  --user <admin>
 *   npm run recreate:admin -- <sid> recover   --user <admin>
 *
 * `recreate` exists because a carry-over of a real layer (4–12 GB) runs
 * for minutes and the public API hostname sits behind Cloudflare, whose
 * origin timeout cuts a response at 100 s (524): the operator would lose
 * the answer every time. On loopback nothing cuts it; the CLI waits up to
 * `--timeout-min` (default 65: T_rec's 60 min cap plus T_rb) and NEVER
 * repeats a recreation on its own. A lost connection or a client timeout is
 * reported as UNCERTAIN together with the preflight's evidence (`retained`,
 * blockers such as `recreate-unresolved`): the backend's attempt goes on and
 * resolves by evidence; the way forward is `preflight`, the `[recreate]` log
 * lines and, after a backend death, `recover`.
 *
 * Like composerCli.ts, it does NOT act on records or containers itself: the
 * per-session exclusion (the lifecycle lock and the `recreate-unresolved`
 * gate) lives in the running backend, so the CLI mints a short-lived token
 * for the named admin (verified in D1) and calls the backend's own admin
 * endpoints on loopback. Authorization, the `operate` audit row and every
 * 409 are exactly the API's. With the backend down the CLI refuses — the
 * D8 recovery in particular must run inside the process that will own the
 * session's lock afterwards, never beside it.
 *
 * `runRecreateAdminCli(argv, deps)` is exported so tests drive the real
 * argument handling against a real HTTP server with an injected admin lookup.
 */

import http from "node:http";

export interface RecreateAdminCliDeps {
	port: number;
	/** `http.request`, injectable so a test can drop the connection. */
	request?: typeof http.request;
	/** The admin to act as: null when unknown or not an admin. */
	lookupAdmin: (username: string) => Promise<{ id: string; username: string } | null>;
	signToken: (userId: string, username: string) => string;
	fetch: typeof fetch;
	stdout: (line: string) => void;
	stderr: (line: string) => void;
}

const VERBS = new Set(["preflight", "recreate", "approve", "rollback", "recover"]);
const USAGE =
	"usage: recreate:admin -- <sid> preflight [--preserve] --user <admin>\n" +
	"       recreate:admin -- <sid> recreate --image <sha256:…> [--preserve] [--timeout-min <n>] --user <admin>\n" +
	"       recreate:admin -- <sid> <approve|rollback|recover> --user <admin>";
const IMAGE_ID_RE = /^sha256:[0-9a-f]{64}$/;

/** Exit codes: 0 done, 1 refused/failed (nothing to recover), 2 UNCERTAIN (see the printed evidence). */
export const EXIT_UNCERTAIN = 2;

/**
 * A long POST on loopback without the fetch stack's own deadlines (undici
 * gives up on headers after 300 s by default — exactly the shape of a
 * carry-over, whose only bytes are its final answer). Rejects with
 * `code: "client-timeout"` or the socket error; never retries.
 */
function longPost(
	url: string,
	headers: Record<string, string>,
	body: string,
	timeoutMs: number,
	request: typeof http.request,
): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const req = request(url, { method: "POST", headers }, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (c: Buffer) => chunks.push(c));
			res.on("end", () =>
				resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
			);
			res.on("error", reject);
		});
		req.setTimeout(timeoutMs, () => {
			req.destroy(
				Object.assign(new Error(`no answer after ${timeoutMs} ms`), { code: "client-timeout" }),
			);
		});
		req.on("error", reject);
		req.end(body);
	});
}

export async function runRecreateAdminCli(
	argv: string[],
	deps: RecreateAdminCliDeps,
): Promise<number> {
	try {
		const flagValue = (flag: string) => {
			const i = argv.indexOf(flag);
			return i >= 0 ? argv[i + 1] : undefined;
		};
		const username = flagValue("--user");
		const image = flagValue("--image");
		const timeoutMin = flagValue("--timeout-min");
		const preserve = argv.includes("--preserve");
		const valued = new Set(["--user", "--image", "--timeout-min"]);
		const positional = argv.filter(
			(a, i) => !valued.has(a) && !valued.has(argv[i - 1] ?? "") && a !== "--preserve",
		);
		const [sid, verb] = positional;
		if (!username || positional.length !== 2 || !verb || !VERBS.has(verb)) throw new Error(USAGE);
		if (!/^[0-9a-f-]{36}$/i.test(sid as string)) throw new Error("invalid session id");
		if (preserve && verb !== "preflight" && verb !== "recreate") throw new Error(USAGE);
		if ((image !== undefined || timeoutMin !== undefined) && verb !== "recreate")
			throw new Error(USAGE);
		if (verb === "recreate" && (!image || !IMAGE_ID_RE.test(image)))
			throw new Error("recreate needs --image <sha256:64 hex> (the preflight's currentImageId)");
		const timeoutMs = Math.round(Number(timeoutMin ?? "65") * 60_000);
		if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
			throw new Error("--timeout-min must be a positive number");
		const admin = await deps.lookupAdmin(username);
		if (!admin) throw new Error(`user ${username} is not an admin (or does not exist)`);
		const token = deps.signToken(admin.id, admin.username);
		const base = `http://127.0.0.1:${deps.port}/api/admin/sessions/${encodeURIComponent(sid as string)}/recreate`;
		const headers = { Cookie: `st_token=${token}`, "Content-Type": "application/json" };
		if (verb === "recreate") {
			const payload = JSON.stringify({ expectImageId: image, preserveLayer: preserve });
			deps.stdout(
				`recreating ${sid}${preserve ? " with carry-over" : ""}; waiting up to ${timeoutMin ?? "65"} min on loopback (do not run it twice)`,
			);
			let answer: { status: number; body: string };
			try {
				answer = await longPost(base, headers, payload, timeoutMs, deps.request ?? http.request);
			} catch (err) {
				// The backend's attempt is NOT over: it continues and resolves by
				// evidence (the record, D1, dockerd). Report what can be seen,
				// never start another one.
				const why = (err as NodeJS.ErrnoException).code ?? (err as Error).message;
				deps.stderr(
					`UNCERTAIN: the connection to the backend ended without an answer (${why}). ` +
						"The recreation continues in the backend; its outcome is in the record and the [recreate] log lines. " +
						"Do NOT run recreate again: check `preflight` (a `retained` container means it committed; " +
						"`recreate-unresolved` means it is still finishing, or died with the backend — then `recover`).",
				);
				const pf = await deps.fetch(base, { headers }).catch(() => null);
				if (pf) deps.stdout(`preflight now: ${pf.status} ${await pf.text()}`);
				return EXIT_UNCERTAIN;
			}
			deps.stdout(`${answer.status} ${answer.body}`);
			if (answer.status === 409) deps.stderr("refused by the backend; nothing changed");
			if (answer.status === 500 && answer.body.includes('"unresolved":true')) {
				deps.stderr(
					"UNCERTAIN: the attempt is not resolved yet (a request to Docker is still out). The session stays gated until the evidence lands; " +
						"watch `preflight` and the [recreate] log lines. Do NOT run recreate again.",
				);
				return EXIT_UNCERTAIN;
			}
			return answer.status >= 200 && answer.status < 300 ? 0 : 1;
		}
		const res =
			verb === "preflight"
				? await deps.fetch(preserve ? `${base}?preserveLayer=1` : base, { headers })
				: await deps.fetch(`${base}/${verb}`, { method: "POST", headers });
		const body = await res.text();
		deps.stdout(`${res.status} ${body}`);
		if (res.status === 409) deps.stderr("refused by the backend; nothing changed");
		return res.ok ? 0 : 1;
	} catch (err) {
		const msg = (err as Error).message;
		deps.stderr(
			msg.includes("ECONNREFUSED")
				? `backend not reachable on loopback: ${msg} (the session lock lives there; start the backend)`
				: msg,
		);
		return 1;
	}
}

/* c8 ignore start */
if (typeof require !== "undefined" && require.main === module) {
	void (async () => {
		const { d1Query } = await import("../db.js");
		const { signCliToken } = await import("../auth.js");
		const code = await runRecreateAdminCli(process.argv.slice(2), {
			port: Number.parseInt(process.env.PORT ?? "3001", 10),
			lookupAdmin: async (username) => {
				const r = await d1Query<{ id: string; username: string; is_admin: number }>(
					"SELECT id, username, is_admin FROM users WHERE username = ?",
					[username],
				);
				const row = r.results[0];
				return row && row.is_admin === 1 ? { id: row.id, username: row.username } : null;
			},
			signToken: signCliToken,
			fetch,
			stdout: (l) => console.log(l),
			stderr: (l) => console.error(l),
		});
		process.exit(code);
	})();
}
/* c8 ignore stop */
