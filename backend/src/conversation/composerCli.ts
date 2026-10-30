/**
 * conversation/composerCli.ts — host-shell access to the composer's admin
 * operations (docs/CONVERSATION.md §8.1.11):
 *
 *   npm run composer:resolve -- <sid> <paneId> <clientMessageId> <outcome> --user <admin>
 *   npm run composer:resolve -- <sid> --list --user <admin>
 *
 * `outcome` is `discarded`, `sent-manually` or `reconcile`.
 *
 * It does NOT touch the pane records itself. The exclusion that protects a
 * pane (the executor's lock, §8.1.4) lives in the running backend, and two
 * independent locks could never be one exclusion — so the CLI mints a
 * short-lived token for the named admin (verified in D1) and calls the
 * backend's own admin endpoint on loopback. Authorization, the `operate`
 * audit row and the 409 `operation-active` answer are exactly the API's.
 * With the backend down the CLI refuses: nothing is running that could
 * hold the lock, and nothing may resolve a pane outside it.
 *
 * `runComposerCli(argv, deps)` is exported so tests drive the real argument
 * handling against a real HTTP server with an injected admin lookup.
 */

export interface ComposerCliDeps {
	port: number;
	/** The admin to act as: null when unknown or not an admin. */
	lookupAdmin: (username: string) => Promise<{ id: string; username: string } | null>;
	signToken: (userId: string, username: string) => string;
	fetch: typeof fetch;
	stdout: (line: string) => void;
	stderr: (line: string) => void;
}

const USAGE =
	"usage: composer:resolve -- <sid> <paneId> <clientMessageId> <discarded|sent-manually|reconcile> --user <admin>\n" +
	"       composer:resolve -- <sid> --list --user <admin>";

export async function runComposerCli(argv: string[], deps: ComposerCliDeps): Promise<number> {
	try {
		const userIdx = argv.indexOf("--user");
		const username = userIdx >= 0 ? argv[userIdx + 1] : undefined;
		const positional = argv.filter((a, i) => a !== "--user" && i !== userIdx + 1);
		if (!username || positional.length < 2) throw new Error(USAGE);
		const [sid, second] = positional;
		if (!/^[0-9a-f-]{36}$/i.test(sid as string)) throw new Error("invalid session id");
		const admin = await deps.lookupAdmin(username);
		if (!admin) throw new Error(`user ${username} is not an admin (or does not exist)`);
		const token = deps.signToken(admin.id, admin.username);
		const base = `http://127.0.0.1:${deps.port}/api/admin/sessions/${encodeURIComponent(sid as string)}/composer`;
		const headers = { Cookie: `st_token=${token}`, "Content-Type": "application/json" };

		if (second === "--list") {
			const res = await deps.fetch(`${base}/panes`, { headers });
			const body = await res.text();
			deps.stdout(body);
			return res.ok ? 0 : 1;
		}
		const [, paneId, clientMessageId, outcome] = positional;
		if (!paneId || !clientMessageId || !outcome) throw new Error(USAGE);
		if (outcome !== "discarded" && outcome !== "sent-manually" && outcome !== "reconcile")
			throw new Error(USAGE);
		const res = await deps.fetch(`${base}/resolve`, {
			method: "POST",
			headers,
			body: JSON.stringify({ paneId, clientMessageId, outcome }),
		});
		const body = await res.text();
		deps.stdout(`${res.status} ${body}`);
		if (res.status === 409) deps.stderr("refused by the backend's pane exclusion; nothing changed");
		return res.ok ? 0 : 1;
	} catch (err) {
		const msg = (err as Error).message;
		deps.stderr(
			msg.includes("ECONNREFUSED")
				? `backend not reachable on loopback: ${msg} (the composer's exclusion lives there; start the backend)`
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
		const code = await runComposerCli(process.argv.slice(2), {
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
