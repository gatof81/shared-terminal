/**
 * recreate/adminCli.ts — host-shell access to the recreation's §2.7.7 verbs
 * (docs/CONVERSATION.md §2.7.7, DEPLOYMENT.md "Activating an existing session"):
 *
 *   npm run recreate:admin -- <sid> preflight [--preserve] --user <admin>
 *   npm run recreate:admin -- <sid> approve   --user <admin>
 *   npm run recreate:admin -- <sid> rollback  --user <admin>
 *   npm run recreate:admin -- <sid> recover   --user <admin>
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

export interface RecreateAdminCliDeps {
	port: number;
	/** The admin to act as: null when unknown or not an admin. */
	lookupAdmin: (username: string) => Promise<{ id: string; username: string } | null>;
	signToken: (userId: string, username: string) => string;
	fetch: typeof fetch;
	stdout: (line: string) => void;
	stderr: (line: string) => void;
}

const VERBS = new Set(["preflight", "approve", "rollback", "recover"]);
const USAGE =
	"usage: recreate:admin -- <sid> preflight [--preserve] --user <admin>\n" +
	"       recreate:admin -- <sid> <approve|rollback|recover> --user <admin>";

export async function runRecreateAdminCli(
	argv: string[],
	deps: RecreateAdminCliDeps,
): Promise<number> {
	try {
		const userIdx = argv.indexOf("--user");
		const username = userIdx >= 0 ? argv[userIdx + 1] : undefined;
		const preserve = argv.includes("--preserve");
		const positional = argv.filter(
			(a, i) => a !== "--user" && i !== userIdx + 1 && a !== "--preserve",
		);
		const [sid, verb] = positional;
		if (!username || positional.length !== 2 || !verb || !VERBS.has(verb)) throw new Error(USAGE);
		if (!/^[0-9a-f-]{36}$/i.test(sid as string)) throw new Error("invalid session id");
		if (preserve && verb !== "preflight") throw new Error(USAGE);
		const admin = await deps.lookupAdmin(username);
		if (!admin) throw new Error(`user ${username} is not an admin (or does not exist)`);
		const token = deps.signToken(admin.id, admin.username);
		const base = `http://127.0.0.1:${deps.port}/api/admin/sessions/${encodeURIComponent(sid as string)}/recreate`;
		const headers = { Cookie: `st_token=${token}`, "Content-Type": "application/json" };
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
