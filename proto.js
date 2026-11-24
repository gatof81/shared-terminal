// Prototipo 3A — lógica simulada. Vanilla, sin dependencias.
(() => {
	const D = window.DATA;
	const $ = (s, r = document) => r.querySelector(s);
	const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
	const md = (s) => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/@([a-z]+)/g, '<span class="link" data-agent="$1">@$1</span>');
	const FREEZE = new URLSearchParams(location.search).has("freeze");
	const mobile = () => matchMedia("(max-width: 760px)").matches;

	const S = {
		project: "st", conv: "ui", view: "chat", m: "home",
		lastConv: { st: "ui", hz: "hz1", notas: null },
		pos: {}, recips: {}, drafts: {},
		tools: { agent: "developer", ws: "main", tool: "files", file: null, change: null },
		showClosed: false, resizes: 0, clock: 0,
	};
	const runs = [
		{ agent: "designer", msg: "q-ui-run", conv: "ui", endsAt: 45, activity: "Editando design/3a/proto.css",
			reply: { to: ["owner"], kind: "result", body: "Prototipo listo en design/3a: navegación, bandeja de pendientes y herramientas con workspace." } },
		{ agent: "developer", msg: "ci-run", conv: "ci", endsAt: 30, activity: "npm run test:e2e · 212/318",
			reply: { to: ["owner"], body: "Build compartido listo en work/ci-cache: el job baja de 14 a 8 min (3 corridas)." } },
	];
	const conv = (id) => D.convs.find((c) => c.id === id);
	const proj = (id) => D.projects.find((p) => p.id === id);
	const msgsOf = (cid) => D.messages.filter((m) => m.conv === cid);
	const stOf = (m, a) => (m.rs ? m.rs[a] : m.status);
	const runOf = (a) => runs.find((r) => r.agent === a);
	const teamOf = (pid) => proj(pid).team;

	// ── Estado de un agente, en el vocabulario del usuario ──
	function status(a, here) {
		const q = D.messages.find((m) => m.from === a && m.kind === "question" && m.status === "open");
		const unc = D.messages.find((m) => m.to.includes(a) && stOf(m, a) === "uncertain");
		const run = runOf(a);
		const queued = D.messages.filter((m) => m.to.includes(a) && stOf(m, a) === "pending");
		const consult = D.messages.find((m) => m.from === a && m.kind === "consult" && m.status === "pending");
		const qn = queued.length ? ` · ${queued.length} en cola` : "";
		if (q) return { k: "waitOwner", t: "espera tu decisión", conv: q.conv, msg: q.id };
		if (unc) return { k: "uncertain", t: "ejecución interrumpida", conv: unc.conv, msg: unc.id };
		if (run) return run.conv === here
			? { k: "here", t: `trabajando aquí${qn}`, conv: run.conv }
			: { k: "elsewhere", t: `ocupado en «${conv(run.conv).title}»${qn}`, short: "ocupado", conv: run.conv };
		if (consult) return { k: "waitAgent", t: `esperando a @${consult.to[0]}${qn}`, conv: consult.conv };
		if (queued.length) return { k: "queued", t: `${queued.length} en cola`, conv: queued[0].conv };
		return { k: "idle", t: "disponible" };
	}
	const av = (a, cls = "") => {
		if (a === "owner") return `<span class="av owner ${cls}">D</span>`;
		const st = status(a, S.conv);
		return `<span class="av st-${st.k} ${cls}" style="--h:${D.agents[a].hue}" title="@${a} · ${esc(st.t)}">${a[0].toUpperCase()}<i></i></span>`;
	};
	const name = (a) => (a === "owner" ? "Vos" : `@${a}`);

	// ── Atención ──
	function attention() {
		const action = [], news = [];
		for (const m of D.messages) {
			const c = conv(m.conv);
			if (c.archive) continue;
			if (m.kind === "question" && m.status === "open") action.push({ m, c, type: "q" });
			for (const a of m.to) if (stOf(m, a) === "uncertain") action.push({ m, c, type: "u", a });
			if (m.unseen && m.to.includes("owner")) news.push({ m, c });
		}
		return { action, news };
	}
	const unreadIn = (cid) => msgsOf(cid).filter((m) => m.unseen).length;

	// ── Rail ──
	function renderRail() {
		const p = proj(S.project);
		$("#project-name").textContent = p.name;
		$(".proj-mark").textContent = p.mark;
		const { action, news } = attention();
		document.querySelectorAll("[data-badge]").forEach((b) => (b.textContent = action.length || ""));
		const row = $(".attn-row");
		row.classList.toggle("on", action.length > 0);
		const parts = [];
		if (action.length) parts.push(`${action.length} te ${action.length === 1 ? "espera" : "esperan"}`);
		if (news.length) parts.push(`${news.length} ${news.length === 1 ? "resultado nuevo" : "resultados nuevos"}`);
		$("[data-attn-text]").textContent = parts.join(" · ") || "Nada pendiente";

		const convs = D.convs.filter((c) => c.project === S.project && !c.archive);
		$("#conv-list").innerHTML = convs.map((c) => {
			const ms = msgsOf(c.id);
			const last = ms.filter((m) => m.kind !== "reply").at(-1);
			const unread = unreadIn(c.id);
			const q = ms.some((m) => m.kind === "question" && m.status === "open");
			const unc = ms.some((m) => m.to.some((a) => stOf(m, a) === "uncertain"));
			const working = runs.filter((r) => r.conv === c.id).map((r) => `@${r.agent}`);
			const [cls, sub] = q ? ["attn-w", `● Espera tu decisión`] : unc ? ["attn-e", "● Ejecución interrumpida"] : working.length ? ["attn-a", `${working.join(", ")} trabajando…`]
				: ["", last ? `${esc(name(last.from))}: ${esc(last.body)}` : "Sin mensajes"];
			const mark = unread ? `<span class="count">${unread}</span>` : "";
			return `<li><button class="row ${c.id === S.conv && S.view === "chat" ? "active" : ""} ${unread ? "unread" : ""}" data-conv="${c.id}"><span class="main"><span class="t">${esc(c.title)}</span><span class="s ${cls}">${sub}</span></span>${mark}</button></li>`;
		}).join("") || `<li class="ib-none">Sin conversaciones todavía.</li>`;

		const team = teamOf(S.project);
		$("#team-list").innerHTML = team.map((a) => {
			const st = status(a, null);
			return `<li><button class="row" data-agent-menu="${a}">${av(a)}<span class="main"><span class="t">@${a}</span><span class="s status-t ${st.k}">${esc(st.t)}</span></span></button></li>`;
		}).join("") || `<li class="ib-none">Este proyecto no tiene agentes.</li>`;

		const works = D.works.filter((w) => w.project === S.project && (S.showClosed || w.state !== "cerrado"));
		$("#work-list").innerHTML = works.map((w) => {
			const running = runs.some((r) => r.agent === w.agent && D.messages.find((m) => m.id === r.msg)?.work === w.id);
			const st = w.state === "cerrado" ? `cerrado · ${w.pr || ""}` : running ? "en curso" : "activo · sin mensajes";
			return `<li><button class="row" data-work="${w.id}"><span class="main"><span class="t fl">${esc(w.id)}</span><span class="s">@${w.agent} · <span style="${running ? "color:var(--accent)" : ""}">${st}</span></span></span></button></li>`;
		}).join("") + (D.works.some((w) => w.project === S.project && w.state === "cerrado") ? `<li><button class="row s" id="works-more" style="color:var(--muted);font-size:12px">${S.showClosed ? "Ocultar cerrados" : "Ver cerrados"}</button></li>` : "");

		$("#archive-list").innerHTML = D.convs.filter((c) => c.project === S.project && c.archive).map((c) =>
			`<li><button class="row ${c.id === S.conv && S.view === "chat" ? "active" : ""}" data-conv="${c.id}"><span class="main"><span class="t" style="color:var(--muted)">${esc(c.title)}</span><span class="s">${esc(c.note)}</span></span></button></li>`).join("");
	}

	// ── Conversación ──
	function convPeople(cid) {
		const set = new Set();
		for (const m of msgsOf(cid)) { if (m.from !== "owner" && m.from !== "system") set.add(m.from); m.to.forEach((a) => a !== "owner" && set.add(a)); }
		return [...set].filter((a) => D.agents[a]);
	}
	function ownerFoot(m) {
		const parts = [];
		for (const a of m.to) {
			const s = stOf(m, a);
			const run = runOf(a);
			if (run && run.msg === m.id) parts.push(`<span class="state running"><span class="dot"></span>@${a} trabajando · ${esc(run.activity)}</span>`);
			else if (s === "pending") {
				const st = status(a, m.conv);
				const why = st.k === "elsewhere" ? `@${a} está ocupado en <button class="link" data-goto-conv="${st.conv}">«${esc(conv(st.conv).title)}»</button>; lo toma al terminar`
					: st.k === "waitOwner" ? `@${a} espera tu decisión en <button class="link" data-goto-msg="${st.msg}">«${esc(conv(st.conv).title)}»</button>`
					: `@${a} lo toma en cuanto se libere`;
				parts.push(`<span class="state pending"><span class="dot"></span>En cola — ${why}</span>`);
			} else if (s === "uncertain") parts.push(`<span class="state uncertain"><span class="dot"></span>${esc(m.note || "Interrumpida")}</span> <button class="btn small" data-requeue="${m.id}" data-a="${a}">Reenviar a @${a}</button>`);
		}
		return parts.join("<br>");
	}
	function msgHTML(m, unseenStart) {
		let out = unseenStart ? `<div class="divider" id="new-divider">Nuevos desde tu última visita</div>` : "";
		if (m.from === "system") return `${out}<div class="sys" id="${m.id}">${md(m.body)}${m.link ? ` · <button class="link" data-goto-msg="${m.link}">ver</button>` : ""}</div>`;
		const to = m.to.filter((a) => !(m.from !== "owner" && a === "owner" && m.to.length === 1));
		const toTxt = m.kind === "consult" ? `consulta a ${to.map(name).join(", ")}` : to.length ? `→ ${to.map(name).join(", ")}` : "";
		const work = m.work ? `<button class="work-chip" data-work="${m.work}" title="Abrir el workspace del trabajo">⎇ ${esc(m.work)}</button>` : "";
		let body = `<div class="body">${md(m.body)}</div>`;
		if (m.kind === "consult") {
			const reply = D.messages.find((r) => r.replyTo === m.id);
			const pend = m.status === "pending" ? `<div class="foot">${ownerFoot({ ...m, to: m.to })}</div>` : "";
			body = `<div class="consult" style="--h:${D.agents[m.to[0]].hue}"><div class="body" style="grid-column:auto">${md(m.body)}</div>${pend}${reply ? `<div class="reply" id="${reply.id}"><div class="head">↳ <span class="who">@${reply.from}</span> <span class="to">respondió</span><span class="time">${reply.t}</span></div><div>${md(reply.body)}</div></div>` : ""}</div>`;
		}
		if (m.kind === "question") {
			body += m.status === "open"
				? `<div class="q" data-q="${m.id}"><b>Necesita tu decisión</b> <span class="muted small">— @${m.from} está detenido hasta que respondas</span><div class="opts">${m.options.map((o) => `<button class="btn" data-answer="${m.id}">${esc(o)}</button>`).join("")}</div></div>`
				: `<div class="q answered">Respondiste: <b>${esc(m.answer)}</b></div>`;
		}
		if (m.kind === "result") body = `<div class="result">${md(m.body)}</div>`;
		const foot = m.from === "owner" ? ownerFoot(m) : "";
		const feet = [foot, work].filter(Boolean).join(" ");
		return `${out}<div class="msg ${m.from === "owner" ? "owner" : ""}" id="${m.id}">${m.from === "owner" ? av("owner") : `<button data-agent-menu="${m.from}" aria-label="@${m.from}">${av(m.from)}</button>`}<div class="head"><span class="who" ${m.from !== "owner" ? `style="color:hsl(${D.agents[m.from].hue} 70% 72%)"` : ""}>${name(m.from)}</span><span class="to">${toTxt}</span>${m.kind === "result" ? '<span class="tag">resultado</span>' : ""}<span class="time">${m.t}</span></div>${body}${feet ? `<div class="foot">${feet}</div>` : ""}</div>`;
	}
	function renderThread(opts = {}) {
		const th = $("#thread");
		const c = conv(S.conv);
		if (!c) { th.innerHTML = `<div class="empty">Este proyecto todavía no tiene conversaciones.<br><br><button class="btn primary" data-new-conv>Nueva conversación</button></div>`; return; }
		const ms = msgsOf(S.conv).filter((m) => m.kind !== "reply");
		const firstUnseen = opts.divider ? D.messages.find((m) => m.conv === S.conv && m.unseen) : null;
		const firstUnseenTop = firstUnseen?.kind === "reply" ? D.messages.find((x) => x.id === firstUnseen.replyTo) : firstUnseen;
		th.innerHTML = `<div class="col">${c.archive ? `<div class="sys">Archivo importado · ${esc(c.note)} · solo lectura</div>` : ""}${ms.map((m) => msgHTML(m, firstUnseenTop && m.id === firstUnseenTop.id)).join("")}</div>`;
	}
	function renderChatChrome() {
		const c = conv(S.conv);
		$("#conv-title").textContent = c ? c.title : proj(S.project).name;
		const people = c ? convPeople(c.id) : [];
		const working = runs.filter((r) => r.conv === S.conv).map((r) => `@${r.agent} trabajando`);
		$("#conv-sub").textContent = c?.archive ? "Solo lectura" : [proj(S.project).name, ...working].join(" · ");
		$("#conv-people").innerHTML = people.map((a) => `<button data-agent-menu="${a}" aria-label="@${a}">${av(a, "sm")}</button>`).join("");
		$("#composer").hidden = !c || !!c.archive;
		$("#readonly").hidden = !c?.archive;
		renderChips();
	}
	const atBottom = (th) => th.scrollHeight - th.scrollTop - th.clientHeight < 24;
	function savePos() {
		const th = $("#thread");
		if (S.conv) S.pos[S.conv] = { top: th.scrollTop, bottom: atBottom(th) };
	}
	function openConv(cid, { msg } = {}) {
		if (S.view === "chat" && S.conv) { savePos(); S.drafts[S.conv] = $("#input").value; }
		const c = conv(cid);
		if (c) { S.project = c.project; S.lastConv[c.project] = cid; }
		S.conv = cid; S.view = "chat"; S.m = "chat";
		applyBody();
		renderChatChrome();
		renderThread({ divider: true });
		$("#input").value = S.drafts[cid] || "";
		const th = $("#thread");
		const saved = S.pos[cid];
		const div = $("#new-divider");
		if (msg) { const el = document.getElementById(msg); if (el) { el.scrollIntoView({ block: "center" }); el.classList.add("flash"); } }
		else if (div && !(saved && !saved.bottom)) th.scrollTop = div.offsetTop - 60;
		else if (saved && !saved.bottom) th.scrollTop = saved.top;
		else th.scrollTop = th.scrollHeight;
		// lo que se mostró queda visto (el divisor se conserva hasta la próxima apertura)
		for (const m of msgsOf(cid)) m.unseen = false;
		$("#new-pill").hidden = true;
		renderRail();
		route();
	}
	function refreshOpenThread() {
		if (S.view !== "chat" || !S.conv) { renderRail(); return; }
		const th = $("#thread");
		const bottom = atBottom(th), top = th.scrollTop;
		const before = msgsOf(S.conv).filter((m) => m.unseen).length;
		renderChatChrome();
		renderThread();
		if (bottom) { th.scrollTop = th.scrollHeight; for (const m of msgsOf(S.conv)) m.unseen = false; $("#new-pill").hidden = true; }
		else {
			th.scrollTop = top;
			const n = msgsOf(S.conv).filter((m) => m.unseen).length || before;
			const pill = $("#new-pill");
			pill.hidden = !n; pill.textContent = `↓ ${n} ${n === 1 ? "nuevo" : "nuevos"}`;
		}
		renderRail();
	}

	// ── Destinatarios ──
	function defaultRecips(cid) {
		const last = msgsOf(cid).filter((m) => m.from === "owner").at(-1);
		return last ? [...last.to] : [];
	}
	const recips = () => (S.recips[S.conv] ??= defaultRecips(S.conv));
	function renderChips() {
		if (!S.conv) return;
		const team = teamOf(S.project);
		const r = recips();
		const all = team.length && team.every((a) => r.includes(a));
		$("#to-chips").innerHTML = all
			? `<span class="chip">Todo el equipo <button class="x" data-unchip="*" aria-label="Quitar">×</button></span>`
			: r.map((a) => { const st = status(a, S.conv); const busy = ["elsewhere", "waitOwner", "uncertain"].includes(st.k);
				return `<span class="chip">${av(a, "sm")}@${a}${busy ? `<span class="busy">· ${st.short || st.t}</span>` : ""}<button class="x" data-unchip="${a}" aria-label="Quitar @${a}">×</button></span>`; }).join("")
				|| `<span class="muted small">nadie — elegí con + o escribí @</span>`;
		const busy = r.map((a) => [a, status(a, S.conv)]).filter(([, st]) => ["elsewhere", "waitOwner"].includes(st.k));
		const note = $("#queue-note");
		note.hidden = !busy.length;
		note.innerHTML = busy.map(([a, st]) => st.k === "elsewhere"
			? `@${a} está ocupado en «${esc(conv(st.conv).title)}»: tu mensaje queda en cola y lo toma al terminar.`
			: `@${a} espera tu decisión en «${esc(conv(st.conv).title)}»; hasta entonces no toma mensajes.`).join("<br>");
		$("#send").disabled = false;
	}
	function addRecip(a) {
		const r = recips();
		if (a === "*") { S.recips[S.conv] = [...teamOf(S.project)]; }
		else if (!r.includes(a)) r.push(a);
		renderChips();
	}
	function mentionMenu(filter) {
		const pop = $("#mention-pop");
		const team = teamOf(S.project);
		const items = [["*", "Todo el equipo", `${team.length} agentes`], ...team.map((a) => [a, `@${a}`, status(a, S.conv).t])]
			.filter(([k, l]) => !filter || l.toLowerCase().includes(filter.toLowerCase()) || (k === "*" && "equipo todos".includes(filter.toLowerCase())));
		if (!items.length) { pop.hidden = true; return; }
		pop.innerHTML = items.map(([k, l, s], i) => `<button class="row" role="option" aria-selected="${i === 0}" data-pick="${k}">${k === "*" ? '<span class="av sm owner">∗</span>' : av(k, "sm")}<span class="main"><span class="t">${esc(l)}</span><span class="s">${esc(s)}</span></span></button>`).join("");
		pop.hidden = false;
	}
	function send() {
		const ta = $("#input");
		const text = ta.value.trim();
		if (!text) return;
		const mentioned = [...text.matchAll(/@([a-z]+)/g)].map((x) => x[1]).filter((a) => teamOf(S.project).includes(a));
		mentioned.forEach((a) => addRecip(a));
		const to = [...recips()];
		if (!to.length) { $("#to-add").focus(); $(".to-row").animate([{ transform: "translateX(-4px)" }, { transform: "translateX(4px)" }, { transform: "none" }], 200); return; }
		const rs = {};
		for (const a of to) rs[a] = "pending";
		const m = { id: `n${Date.now()}`, conv: S.conv, from: "owner", to, body: text, t: now(), rs, sim: true };
		D.messages.push(m);
		ta.value = ""; S.drafts[S.conv] = ""; autoGrow();
		const th = $("#thread");
		renderChatChrome(); renderThread(); th.scrollTop = th.scrollHeight;
		renderRail();
	}
	const now = () => new Date().toTimeString().slice(0, 5);

	// ── Simulación de agentes: un mensaje a la vez por agente, respuestas asíncronas ──
	const REPLIES = {
		architect: "Lo veo: cabe en el esquema de sesiones por conversación sin tocar los trabajos.",
		developer: "Medido: reanudar una sesión inactiva tarda ~3 s y no reabre la terminal.",
		designer: "Anotado en el prototipo; lo muestro en la próxima revisión.",
		qa: "Corrí 3 veces: verde. Te dejo los tiempos en el hilo.",
		arq: "Hecho, actualicé el plan.", dev: "Listo.",
	};
	function finishRun(r) {
		runs.splice(runs.indexOf(r), 1);
		const src = D.messages.find((m) => m.id === r.msg);
		if (src && src.rs) src.rs[r.agent] = "done"; else if (src && src.status === "running") src.status = "done";
		if (src?.kind === "consult") src.status = "done";
		const cur = S.view === "chat" && S.conv === r.conv && atBottom($("#thread")) && !document.hidden;
		const rep = r.reply;
		const reply = { id: `r${Date.now()}${r.agent}`, conv: r.conv, from: r.agent, to: rep.to, kind: rep.kind, replyTo: rep.replyTo, body: rep.body, t: now(), unseen: !cur };
		D.messages.push(reply);
		// Una respuesta tardía a una consulta queda en su lugar (anidada) y además se anuncia al final.
		if (rep.replyTo) {
			const ms = msgsOf(r.conv).filter((m) => m.kind !== "reply");
			if (ms.at(-1)?.id !== rep.replyTo) D.messages.push({ id: `s${Date.now()}`, conv: r.conv, from: "system", to: [], body: `↳ @${r.agent} respondió la consulta de @${src.from}`, link: reply.id, t: now() });
		}
	}
	function tick() {
		S.clock++;
		for (const r of [...runs]) if (S.clock >= r.endsAt) finishRun(r);
		for (const a of Object.keys(D.agents)) {
			if (runOf(a)) continue;
			if (D.messages.some((m) => m.from === a && m.kind === "question" && m.status === "open")) continue;
			const next = D.messages.find((m) => m.to.includes(a) && stOf(m, a) === "pending");
			if (!next) continue;
			if (next.rs) next.rs[a] = "running"; else next.status = "running";
			const consult = next.kind === "consult";
			runs.push({ agent: a, msg: next.id, conv: next.conv, endsAt: S.clock + 7, activity: "Leyendo el contexto del tema",
				reply: consult ? { to: [next.from], kind: "reply", replyTo: next.id, body: `SHA para medir: 9c41e2d (work/ci-cache).` } : { to: ["owner"], body: REPLIES[a] } });
		}
		refreshOpenThread();
		if (S.view === "tools") renderTools();
	}

	// ── Pendientes ──
	function renderInbox() {
		const { action, news } = attention();
		const item = (x) => {
			const p = proj(x.c.project);
			const where = `${p.id !== S.project ? `${esc(p.name)} › ` : ""}${esc(x.c.title)}`;
			if (x.type === "q") return `<div class="ib-item action" ><span>${av(x.m.from, "sm")}</span><button class="what" style="text-align:left" data-goto-msg="${x.m.id}"><span class="where2">${where}</span><br>@${x.m.from} pregunta: ${esc(x.m.body)}</button><div class="acts">${x.m.options.map((o) => `<button class="btn small" data-answer="${x.m.id}">${esc(o)}</button>`).join("")}</div></div>`;
			if (x.type === "u") return `<div class="ib-item action err"><span>${av(x.a, "sm")}</span><button class="what" style="text-align:left" data-goto-msg="${x.m.id}"><span class="where2">${where}</span><br>Se interrumpió tu mensaje a @${x.a}: «${esc(x.m.body)}»</button><div class="acts"><button class="btn small" data-requeue="${x.m.id}" data-a="${x.a}">Reenviar</button><button class="btn small ghost" data-goto-msg="${x.m.id}">Ver</button></div></div>`;
			return `<button class="ib-item" data-goto-msg="${x.m.id}"><span>${av(x.m.from, "sm")}</span><span class="what"><span class="where2">${where}</span><br>@${x.m.from}: ${esc(x.m.body)}</span></button>`;
		};
		$("#inbox-body").innerHTML =
			`<div class="ib-sec">Requieren tu acción</div>${action.map(item).join("") || '<div class="ib-none">Nada te espera.</div>'}` +
			`<div class="ib-sec">Resultados sin ver</div>${news.map(item).join("") || '<div class="ib-none">Viste todo.</div>'}` +
			`<p class="ib-none small">La actividad informativa (quién trabaja, colas) no entra acá: se ve en cada tema y en Equipo.</p>`;
	}
	function openInbox() { renderInbox(); $("#inbox").hidden = false; $("#scrim").hidden = mobile(); if (!mobile()) $("#scrim").hidden = false; $("[data-close-inbox]").focus(); }
	function closeInbox() { $("#inbox").hidden = true; $("#scrim").hidden = true; }

	// ── Menús ──
	function showMenu(anchor, html) {
		const menu = $("#menu");
		menu.innerHTML = html; menu.hidden = false; $("#scrim").hidden = false; $("#scrim").style.background = "transparent";
		const r = anchor.getBoundingClientRect();
		const w = menu.offsetWidth, h = menu.offsetHeight;
		menu.style.left = `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`;
		menu.style.top = `${r.bottom + h + 8 > innerHeight ? Math.max(8, r.top - h - 4) : r.bottom + 4}px`;
		menu.querySelector("button")?.focus();
	}
	function hideMenu() { $("#menu").hidden = true; if ($("#inbox").hidden) $("#scrim").hidden = true; $("#scrim").style.background = ""; }
	function agentMenu(anchor, a) {
		const st = status(a, S.conv);
		const works = D.works.filter((w) => w.agent === a && w.state !== "cerrado");
		showMenu(anchor, `<div class="mh">@${a} · ${esc(D.agents[a].role)}<br><span class="status-t ${st.k}">${esc(st.t)}</span></div>
			${conv(S.conv) && !conv(S.conv).archive ? `<button class="row" data-mention="${a}">Escribirle en este tema</button>` : ""}
			${st.conv && st.conv !== S.conv ? `<button class="row" data-goto-conv="${st.conv}">Ir a «${esc(conv(st.conv).title)}»</button>` : ""}
			<hr><div class="mh">Herramientas</div>
			<button class="row" data-tools="${a}|main|files">Files · principal</button>
			<button class="row" data-tools="${a}|main|git">Git · principal</button>
			<button class="row" data-tools="${a}|main|terminal">Terminal de la sesión</button>
			${works.map((w) => `<button class="row" data-tools="${a}|${w.id}|git"><span class="fl">⎇ ${w.id}</span>&nbsp;<span class="muted small">trabajo</span></button>`).join("")}`);
	}
	function projectMenu(anchor) {
		showMenu(anchor, `<div class="mh">Proyectos</div>` + D.projects.map((p) => {
			const n = attention().action.filter((x) => x.c.project === p.id).length;
			return `<button class="row" data-project="${p.id}"><span class="proj-mark" style="${p.id === S.project ? "" : "background:#2d333b"}">${p.mark}</span><span class="main"><span class="t">${esc(p.name)}</span><span class="s">${p.team.length} agentes</span></span>${n ? `<span class="mark-warn">● ${n}</span>` : ""}</button>`;
		}).join("") + `<hr><button class="row muted">+ Nuevo proyecto</button><button class="row muted">Sesiones sin proyecto</button>`);
	}

	// ── Herramientas ──
	function openTools(agent, ws, tool) {
		if (S.view === "chat" && S.conv) savePos();
		S.toolsFrom = S.conv;
		Object.assign(S.tools, { agent, ws, tool, file: null, change: null });
		S.view = "tools"; S.m = "tools";
		applyBody(); renderTools(); renderRail(); route();
	}
	function closeTools() {
		S.view = "chat"; S.m = S.conv ? "chat" : "home";
		applyBody(); renderChatChrome(); renderRail(); route();
		// La conversación nunca se desmontó: su scroll sigue donde estaba.
	}
	function renderTools() {
		const t = S.tools;
		const team = teamOf(S.project);
		$("#tools-back-label").textContent = conv(S.toolsFrom)?.title || "Volver";
		$("#sel-agent").innerHTML = team.map((a) => `<option value="${a}" ${a === t.agent ? "selected" : ""}>@${a}</option>`).join("");
		const works = D.works.filter((w) => w.agent === t.agent);
		if (t.ws !== "main" && !works.some((w) => w.id === t.ws)) t.ws = "main";
		const term = t.tool === "terminal";
		$("#sel-ws").innerHTML = term ? `<option>Sesión completa</option>` : `<option value="main" ${t.ws === "main" ? "selected" : ""}>Principal · main</option>` +
			works.map((w) => `<option value="${w.id}" ${t.ws === w.id ? "selected" : ""}>⎇ ${w.id} · ${w.state}</option>`).join("");
		$("#sel-ws").disabled = term;
		$("#sel-ws-wrap").classList.toggle("off", term);
		document.querySelectorAll("#tool-seg button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tool === t.tool)));
		const w = D.works.find((x) => x.id === t.ws);
		const runningHere = runs.find((r) => r.agent === t.agent && D.messages.find((m) => m.id === r.msg)?.work === (w?.id));
		$("#where").innerHTML = term
			? `<span class="ws-kind">Terminal de la sesión st-${t.agent}</span><span>tmux · un contenedor, compartido por todos sus workspaces</span><span>se abre en <b>~/workspace</b></span>${w ? `<span>el trabajo está en <b>.st/ctx/${w.id}</b></span>` : ""}`
			: w ? `<span class="ws-kind">Trabajo ${esc(w.id)}</span><span>rama <b>${w.branch}</b></span><span>dir <b>~/workspace/.st/ctx/${w.id}</b></span><span>base <b>${w.base}</b></span><span>puertos <b>${w.ports}</b></span>${w.state === "cerrado" ? '<span class="warnl">cerrado · solo lectura</span>' : runningHere ? `<span style="color:var(--accent)">● @${t.agent} trabajando aquí</span>` : ""}${w.conv ? `<button class="link" data-goto-conv="${w.conv}">tema «${esc(conv(w.conv).title)}»</button>` : ""}`
			: `<span class="ws-kind">Workspace principal</span><span>rama <b>main</b></span><span>dir <b>~/workspace</b></span><span>sesión st-${t.agent} · en marcha</span>`;
		const body = $("#tool-body");
		body.classList.toggle("detail", !!(t.file || t.change));
		if (term) {
			body.innerHTML = `<div class="term-wrap"><div class="term-info"><div class="tabs"><span class="on">main</span><span>dev-server</span><span>+</span></div><span class="rz ${S.resizes ? "" : "ok"}" id="rz">120×32 · ${S.resizes} redimensiones</span></div><div class="term" id="term"><pre>${esc(termText(t.agent, w))}</pre></div><div class="keybar"><span>Esc</span><span>Tab</span><span>Ctrl</span><span>↑</span><span>↓</span><span>←</span><span>→</span><span>|</span><span>~</span><span>/</span></div></div>`;
			watchTerm();
			return;
		}
		const key = w ? w.id : "main";
		if (t.tool === "files") {
			const tree = D.tree[key] || D.tree.main;
			body.innerHTML = `<div class="pane-list">${tree.map(([k, n, s]) => `<button class="row" data-file="${n}"><span class="main fl">${k === "d" ? "▸ " : "  "}${esc(n)}</span>${s ? `<span class="mod">${s}</span>` : ""}</button>`).join("")}</div>
				<div class="pane-main">${t.file ? `<div class="bar m-only-flex"><button class="back" data-file-back>‹ Archivos</button><span class="fl">${esc(t.file)}</span></div><pre>${esc(fileText(t.file, key))}</pre>` : `<div class="empty">Elegí un archivo</div>`}</div>`;
		} else {
			const ch = D.changes[key] || [];
			body.innerHTML = ch.length
				? `<div class="pane-list"><div class="ib-sec">Cambios sin commit · ${ch.length}</div>${ch.map((c) => `<button class="row" data-change="${c.path}"><span class="mod">${c.st}</span><span class="main fl"><span class="t">${esc(c.path)}</span></span><span class="plus small">+${c.add}</span><span class="minus small">−${c.del}</span></button>`).join("")}<div class="ib-sec">Commits</div><div class="row s"><span class="main"><span class="t">9c41e2d build compartido</span><span class="s">hace 12 min · @developer</span></span></div></div>
				<div class="pane-main">${t.change ? `<div class="bar m-only-flex"><button class="back" data-file-back>‹ Cambios</button><span class="fl">${esc(t.change)}</span></div>${diffHTML(t.change)}` : `<div class="empty">Elegí un archivo para ver el diff</div>`}</div>`
				: `<div class="empty">Sin cambios en <b class="fl">${w ? w.branch : "main"}</b> · último commit 3bda155</div>`;
		}
	}
	let ro;
	function watchTerm() {
		ro?.disconnect();
		const el = $("#term");
		let first = true;
		ro = new ResizeObserver(() => { if (first) { first = false; return; } S.resizes++; const rz = $("#rz"); if (rz) { rz.textContent = `120×32 · ${S.resizes} redimensiones`; rz.classList.remove("ok"); } });
		ro.observe(el);
	}
	const termText = (a, w) => `developer@st-${a}:~/workspace$ git status -sb
## main...origin/main
developer@st-${a}:~/workspace$ ${w ? `cd .st/ctx/${w.id} && git log --oneline -2
9c41e2d build compartido para los shards de e2e
3bda155 fix(acp): context affinity in the claim (#756)
developer@st-${a}:~/workspace/.st/ctx/${w.id}$ ` : "npm run dev\n\n  VITE v6  ready in 412 ms\n  ➜  Local:   http://localhost:20000/\n"}█`;
	const fileText = (f, key) => f === ".github/" && key !== "main"
		? "# .github/workflows/ci.yml (work/ci-cache)\njobs:\n  e2e:\n    steps:\n      - uses: actions/cache@v4\n        with:\n          path: ~/.cache/ms-playwright\n      - run: npx vite build   # una vez, compartido\n"
		: f.endsWith("/") ? `${f}\n  (directorio — en el producto se expande en el árbol)` : `# ${f}\n\nContenido simulado de ${f} en ${key === "main" ? "el workspace principal" : `el trabajo ${key}`}.`;
	const diffHTML = (p) => [["h", "@@ -18,7 +18,16 @@ jobs:"], ["", "   e2e:"], ["", "     runs-on: ubuntu-latest"], ["d", "-      - run: npx playwright install"], ["a", "+      - uses: actions/cache@v4"], ["a", "+        with:"], ["a", "+          path: ~/.cache/ms-playwright"], ["a", "+          key: pw-${{ hashFiles('package-lock.json') }}"], ["a", "+      - run: npx vite build"], ["", "       - run: npm run test:e2e"]]
		.map(([k, l]) => `<span class="dl ${k}">${esc(l)}</span>`).join("") + `<p class="muted small" style="padding:0 16px">${esc(p)}</p>`;

	// ── Cuerpo / rutas ──
	function applyBody() { document.body.dataset.view = S.view; document.body.dataset.m = S.m; }
	function route() {
		const h = S.view === "tools" ? `#/p/${S.project}/c/${S.toolsFrom || "-"}/tools/${S.tools.agent}/${S.tools.ws}/${S.tools.tool}`
			: S.m === "home" && mobile() ? `#/p/${S.project}` : `#/p/${S.project}/c/${S.conv}`;
		if (location.hash !== h) history.pushState(null, "", h);
	}
	function fromHash() {
		const p = location.hash.slice(2).split("/");
		if (p[0] !== "p") return false;
		S.project = p[1] || "st";
		if (p[4] === "tools") { S.conv = p[3] !== "-" ? p[3] : S.conv; openTools(p[5], p[6], p[7]); return true; }
		if (p[3]) { if (S.view === "tools") { S.view = "chat"; } openConv(p[3]); return true; }
		S.view = "chat"; S.m = "home"; applyBody(); renderRail(); return true;
	}
	addEventListener("popstate", () => { closeInbox(); hideMenu(); fromHash(); });

	// ── Eventos ──
	document.addEventListener("click", (e) => {
		const t = e.target.closest("button, [data-agent]");
		if (!t) return;
		const d = t.dataset;
		if (t.id !== "menu" && !t.closest("#menu") && !$("#menu").hidden && !d.agentMenu && t.id !== "project-btn") hideMenu();
		if (d.conv) { closeInbox(); openConv(d.conv); }
		else if (d.gotoConv) { hideMenu(); closeInbox(); openConv(d.gotoConv); }
		else if (d.gotoMsg) {
			hideMenu(); closeInbox();
			const m = D.messages.find((x) => x.id === d.gotoMsg);
			const target = m.kind === "reply" ? m.replyTo : m.id;
			openConv(m.conv, { msg: target });
		}
		else if ("openInbox" in d) $("#inbox").hidden ? openInbox() : closeInbox();
		else if ("closeInbox" in d) closeInbox();
		else if (d.agentMenu) agentMenu(t, d.agentMenu);
		else if (d.agent && !t.closest("#menu")) agentMenu(t, d.agent);
		else if (d.mention) { hideMenu(); addRecip(d.mention); $("#input").focus(); }
		else if (d.tools) { hideMenu(); closeInbox(); const [a, ws, tool] = d.tools.split("|"); openTools(a, ws, tool); }
		else if (d.work) { const w = D.works.find((x) => x.id === d.work); openTools(w.agent, w.id, w.state === "cerrado" ? "git" : "files"); }
		else if (d.project) { hideMenu(); S.project = d.project; const c = S.lastConv[d.project]; if (c && !mobile()) openConv(c); else { S.conv = c; S.view = "chat"; S.m = "home"; applyBody(); renderRail(); if (c) { renderChatChrome(); renderThread(); } route(); } }
		else if (t.id === "project-btn") projectMenu(t);
		else if (d.answer) {
			const q = D.messages.find((m) => m.id === d.answer);
			q.status = "answered"; q.answer = t.textContent;
			runs.push({ agent: q.from, msg: q.id, conv: q.conv, endsAt: S.clock + 6, activity: `Siguiendo con «${q.answer}»`,
				reply: { to: ["owner"], body: `Entendido: «${q.answer}». Actualicé el esquema y sigo con la implementación del plan.` } });
			if (!$("#inbox").hidden) renderInbox();
			refreshOpenThread();
		}
		else if (d.requeue) {
			const m = D.messages.find((x) => x.id === d.requeue);
			if (m.rs) m.rs[d.a] = "pending"; else m.status = "pending";
			m.note = null;
			if (!$("#inbox").hidden) renderInbox();
			refreshOpenThread();
		}
		else if (d.unchip) { S.recips[S.conv] = d.unchip === "*" ? [] : recips().filter((a) => a !== d.unchip); renderChips(); }
		else if (d.pick) { pickMention(d.pick); }
		else if ("goHome" in d) { savePos(); S.m = "home"; applyBody(); renderRail(); route(); }
		else if (t.id === "to-add") { mentionMenu(""); }
		else if (t.id === "send") send();
		else if (t.id === "new-conv" || "newConv" in d) newConv();
		else if (t.id === "continue-archive") newConv(`Continuación de ${conv(S.conv).title}`);
		else if (t.id === "tools-back") closeTools();
		else if (d.tool) { S.tools.tool = d.tool; S.tools.file = S.tools.change = null; renderTools(); route(); }
		else if (d.file) { S.tools.file = d.file; renderTools(); }
		else if (d.change) { S.tools.change = d.change; renderTools(); }
		else if ("fileBack" in d) { S.tools.file = S.tools.change = null; renderTools(); }
		else if (t.id === "new-pill") { const th = $("#thread"); th.scrollTo({ top: th.scrollHeight, behavior: "smooth" }); }
		else if (t.id === "works-more" || t.id === "works-toggle") { S.showClosed = !S.showClosed; renderRail(); }
		else if (t.id === "conv-menu") showMenu(t, `<button class="row">Renombrar tema</button><button class="row">Archivar tema</button><hr><button class="row" data-tools="${convPeople(S.conv)[0] || teamOf(S.project)[0]}|main|files">Herramientas…</button>`);
	});
	$("#scrim").addEventListener("click", () => { hideMenu(); closeInbox(); });
	document.addEventListener("keydown", (e) => { if (e.key === "Escape") { hideMenu(); closeInbox(); $("#mention-pop").hidden = true; } });
	$("#sel-agent").addEventListener("change", (e) => { S.tools.agent = e.target.value; S.tools.ws = "main"; S.tools.file = S.tools.change = null; renderTools(); route(); });
	$("#sel-ws").addEventListener("change", (e) => { S.tools.ws = e.target.value; S.tools.file = S.tools.change = null; renderTools(); route(); });
	$("#thread").addEventListener("scroll", () => { if (atBottom($("#thread"))) { $("#new-pill").hidden = true; let ch = false; for (const m of msgsOf(S.conv)) if (m.unseen) { m.unseen = false; ch = true; } if (ch) renderRail(); } }, { passive: true });

	// composer: @ menciones, Enter envía en desktop, Ctrl/⌘+Enter siempre
	const ta = $("#input");
	function autoGrow() { ta.style.height = "auto"; ta.style.height = `${Math.min(ta.scrollHeight, innerHeight * 0.4)}px`; }
	function mentionQuery() { const v = ta.value.slice(0, ta.selectionStart); const m = v.match(/@([a-z]*)$/); return m ? m[1] : null; }
	function pickMention(k) {
		const q = mentionQuery();
		if (q !== null) { const pos = ta.selectionStart; ta.value = ta.value.slice(0, pos - q.length - 1) + ta.value.slice(pos); ta.selectionStart = ta.selectionEnd = pos - q.length - 1; }
		addRecip(k);
		$("#mention-pop").hidden = true; ta.focus();
	}
	ta.addEventListener("input", () => { autoGrow(); const q = mentionQuery(); if (q !== null) mentionMenu(q); else $("#mention-pop").hidden = true; });
	ta.addEventListener("keydown", (e) => {
		const pop = $("#mention-pop");
		if (!pop.hidden) {
			const opts = [...pop.querySelectorAll("[role=option]")];
			const i = opts.findIndex((o) => o.getAttribute("aria-selected") === "true");
			if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); const j = (i + (e.key === "ArrowDown" ? 1 : -1) + opts.length) % opts.length; opts.forEach((o, k) => o.setAttribute("aria-selected", String(k === j))); return; }
			if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pickMention(opts[i].dataset.pick); return; }
		}
		if (e.key === "Enter" && (e.ctrlKey || e.metaKey || (!mobile() && !e.shiftKey))) { e.preventDefault(); send(); }
	});

	function newConv(title = "") {
		const dlg = $("#new-dialog");
		$("#nd-title").value = title; $("#nd-body").value = "";
		$("#nd-team").innerHTML = teamOf(S.project).map((a) => `<label><input type="checkbox" value="${a}">@${a}</label>`).join("") + `<label><input type="checkbox" value="*">Todo el equipo</label>`;
		dlg.showModal();
		dlg.onclose = () => {
			if (dlg.returnValue !== "ok" || !$("#nd-title").value.trim()) return;
			const id = `c${Date.now()}`;
			D.convs.push({ id, project: S.project, title: $("#nd-title").value.trim() });
			const picked = [...dlg.querySelectorAll("input[type=checkbox]:checked")].map((i) => i.value);
			S.recips[id] = picked.includes("*") ? [...teamOf(S.project)] : picked;
			openConv(id);
			const body = $("#nd-body").value.trim();
			if (body && S.recips[id].length) { ta.value = body; send(); }
		};
	}

	// ── Arranque ──
	if (!fromHash()) { if (mobile()) { S.m = "home"; applyBody(); renderRail(); renderChatChrome(); renderThread(); } else openConv("ui"); }
	if (!FREEZE) setInterval(tick, 1000);
	window.__S = S;
})();
