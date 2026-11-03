// XB-1 binder — pure logic of the observational mod, tested without Claude.
//
// What it proves and how (2.1.317, read in the binary; docs/design/project-chat
// 04-poc §1.13):
//   - `prompt.submit` carries `origin`, which the engine sets where the prompt
//     was queued (a channel notification ⇒ {kind:"channel", server}; Enter at
//     the terminal ⇒ {kind:"composer"}). No hook may set or change it, and the
//     text never decides it, so a pasted `<channel>` tag stays "composer".
//   - `prompt.submit` has no prompt_id. The settings hooks (`classic.*`) run as
//     the CORE of the prompt.submit chain, i.e. strictly inside its next(), and
//     `classic.UserPromptSubmit` carries prompt_id and session_id. So a
//     classic.UserPromptSubmit that arrives while exactly ONE submission of this
//     module is awaiting next() belongs to that submission. Any overlap (two
//     submissions in flight at once, e.g. a prompt typed at Enter while a
//     channel prompt is being processed) leaves every one involved unbound:
//     fail-closed, never a guess by time or text.
//   - Text equality between the two is a consistency check, never the key.
//
// Observational: every handler calls next(e) exactly once with the event it
// received and returns what next returned (or rethrows what it threw). Nothing
// before next can throw. A failed write only loses evidence (a sequence gap the
// analyzer reports); it never changes the prompt, the turn or the hooks.
const str = (v) => (typeof v === "string" ? v : null);
const len = (v) => (typeof v === "string" ? v.length : null);

export function createProbe({ inst, now }) {
	let seq = 0;
	const inflight = new Set();
	// `sink` is made per call by register.mjs: the validator requires every mods
	// API call to be spelled `$.noun.method(...)` at its call site, so `$` itself
	// never crosses into this file.
	async function emit(sink, rec) {
		seq += 1;
		const n = seq;
		try {
			await sink(n, { inst, seq: n, t: now(), ...rec });
		} catch {
			// evidence lost, flow untouched
		}
	}

	async function sessionStart(e, next, sink) {
		const r = await next(e);
		await emit(sink, { event: "session.start" });
		return r;
	}

	async function promptSubmit(e, next, sink) {
		let s = null;
		try {
			const o = e?.origin;
			s = {
				origin_kind: str(o?.kind),
				origin_server: o?.kind === "channel" ? str(o.server) : null,
				is_meta: e?.isMeta === true,
				turn_id_present: typeof e?.turnId === "string",
				text: str(e?.text),
				classic: [],
				overlap: inflight.size > 0,
			};
			for (const other of inflight) other.overlap = true;
			inflight.add(s);
		} catch {
			s = null;
		}
		let outcome = "entered";
		try {
			const r = await next(e);
			if (r && typeof r.drop === "string") outcome = "drop";
			return r;
		} catch (err) {
			outcome = "threw";
			throw err;
		} finally {
			if (s) {
				inflight.delete(s);
				const ids = [...new Set(s.classic.map((c) => c.prompt_id))];
				const sids = [...new Set(s.classic.map((c) => c.session_id))];
				const textEqual = s.classic.length > 0 && s.classic.every((c) => c.prompt !== null && c.prompt === s.text);
				const bound = !s.overlap && s.classic.length >= 1 && ids.length === 1 && ids[0] !== null && sids.length === 1 && textEqual;
				await emit(sink, {
					event: "prompt.submit",
					origin_kind: s.origin_kind,
					origin_server: s.origin_server,
					is_meta: s.is_meta,
					turn_id_present: s.turn_id_present,
					text_len: len(s.text),
					outcome,
					overlap: s.overlap,
					classic_count: s.classic.length,
					classic_prompt_ids: ids,
					classic_session_ids: sids,
					classic_text_equal_all: textEqual,
					bound_prompt_id: bound ? ids[0] : null,
					bound_session_id: bound ? sids[0] : null,
				});
			}
		}
	}

	async function classicUserPromptSubmit(e, next, sink) {
		let attached = false;
		let size = -1;
		let c = null;
		try {
			c = { prompt_id: str(e?.prompt_id), session_id: str(e?.session_id), prompt: str(e?.prompt) };
			size = inflight.size;
			if (size === 1) {
				for (const s of inflight) s.classic.push(c);
				attached = true;
			}
		} catch {
			attached = false;
		}
		const r = await next(e);
		await emit(sink, { event: "classic.UserPromptSubmit", prompt_id: c?.prompt_id ?? null, session_id: c?.session_id ?? null, prompt_len: len(c?.prompt), inflight: size, attached });
		return r;
	}

	async function classicStop(e, next, sink) {
		const r = await next(e);
		await emit(sink, { event: "classic.Stop", prompt_id: str(e?.prompt_id), session_id: str(e?.session_id) });
		return r;
	}

	async function sessionAppendPrompt(e, next, sink) {
		const r = await next(e);
		const o = e?.origin;
		await emit(sink, {
			event: "session.append",
			door: str(e?.door),
			uuid: str(e?.uuid),
			origin_kind: str(o?.kind),
			origin_server: o?.kind === "channel" ? str(o.server) : null,
			is_meta: e?.message?.isMeta === true,
		});
		return r;
	}

	return { sessionStart, promptSubmit, classicUserPromptSubmit, classicStop, sessionAppendPrompt, inflightSize: () => inflight.size };
}
