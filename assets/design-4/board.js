// Prototipo 4 — tablero de tareas. Vanilla, sin dependencias, datos en data.js.
// Nada cambia solo: cada cambio sale de una acción del owner en este prototipo.
"use strict";

const ST = { todo: "Por hacer", doing: "En progreso", review: "En revisión", done: "Terminado" };
const ORDER = ["todo", "doing", "review", "done"];
const PHONE_ORDER = ["doing", "review", "todo", "done"];
const PRIO = { high: "Alta", normal: "Normal", low: "Baja" };

let D = PROTO_DATA();
let scenario = "normal";
let conflictNext = false;
const conflicts = new Map(); // taskId → {by, what, tried, retry}
let wide = true;
let selected = null;
let lastFocus = null;
let flashId = null;

const $ = (s, r = document) => r.querySelector(s);
const app = $("#app");

function h(tag, attrs = {}, ...kids) {
	const e = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) {
		if (v == null || v === false) continue;
		if (k === "class") e.className = v;
		else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
		else if (k === "style") e.style.cssText = v;
		else e.setAttribute(k, v === true ? "" : v);
	}
	for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(String(k)));
	return e;
}
// Íconos en SVG: los glifos (⛔ ⧗ ▣) no existen en todas las fuentes del sistema.
const ICONS = {
	block: '<circle cx="8" cy="8" r="6"/><path d="M3.8 12.2 12.2 3.8"/>',
	ext: '<circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 1.5"/>',
	dep: '<path d="M4 3v5a3 3 0 0 0 3 3h5M9.5 8.5 12 11l-2.5 2.5"/>',
	budget: '<rect x="2.5" y="4" width="11" height="8" rx="1.5"/><path d="M2.5 7h11"/>',
	warn: '<path d="M8 2.5 14 13H2z"/><path d="M8 6.5v3M8 11.2v.3"/>',
	board: '<rect x="2" y="2.5" width="3.5" height="11" rx="1"/><rect x="6.25" y="2.5" width="3.5" height="7" rx="1"/><rect x="10.5" y="2.5" width="3.5" height="9" rx="1"/>',
	chat: '<path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"/>',
	pr: '<circle cx="4.5" cy="4" r="1.5"/><circle cx="4.5" cy="12" r="1.5"/><circle cx="11.5" cy="12" r="1.5"/><path d="M4.5 5.5v5M11.5 10.5V7a2 2 0 0 0-2-2H7.5M9 3.5 7.5 5 9 6.5"/>',
	inbox: '<path d="M2 9.5V13h12V9.5M2 9.5 4 3h8l2 6.5M2 9.5h3.5l1 1.5h3l1-1.5H14"/>',
};
function ic(name) {
	const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	s.setAttribute("viewBox", "0 0 16 16");
	s.setAttribute("class", "svg");
	s.setAttribute("aria-hidden", "true");
	s.innerHTML = ICONS[name];
	return s;
}
const T = (id) => D.tasks.find((t) => t.id === id);
const kids = (g) => D.tasks.filter((t) => t.parent === g.id);
const goalOf = (t) => (t.parent ? T(t.parent) : null);
const ag = (n) => D.agents[n];
function av(n, cls = "sm") {
	const a = ag(n);
	return h("span", { class: `av ${cls}`, style: `--h:${a.hue}`, "aria-hidden": "true" }, n[0].toUpperCase());
}
function who(n, cls = "sm") {
	return h("span", { class: "who", style: `--h:${ag(n).hue}` }, av(n, cls), h("b", {}, `@${n}`));
}
const live = (t) => (t.act || []).some((a) => a.k === "running" || (a.k === "work" && a.active));
const awaitingOwner = (t) => t.status === "review" && !t.reviewer;
function toast(msg) {
	const box = $("#toast");
	box.replaceChildren(h("div", {}, msg));
	clearTimeout(toast.t);
	toast.t = setTimeout(() => box.replaceChildren(), 3200);
}

// ── Routing ──────────────────────────────────────────────────────────
function go(hash, replace) {
	if (replace) history.replaceState(null, "", hash);
	else history.pushState(null, "", hash);
	route();
}
function route() {
	const phone = matchMedia("(max-width: 720px)").matches;
	let hash = location.hash || (phone ? "#/rail" : "#/board");
	if (!phone && hash === "#/rail") hash = "#/board";
	const m = hash.match(/^#\/(rail|board|topic)(?:\/(t|c)\/(\w+))?(?:\/m(\d+))?/) || [];
	const view = m[1] || "board";
	if (view === "topic") {
		app.dataset.screen = "topic";
		selected = null;
		renderTopic(m[3], m[4] ? +m[4] : null);
	} else {
		app.dataset.screen = view === "rail" ? "rail" : m[2] === "t" ? "detail" : "board";
		selected = m[2] === "t" ? +m[3] : null;
		$("#topic").hidden = true;
		$("#board").hidden = false;
		renderBoard();
	}
	renderRail(view);
	renderDetail();
}
addEventListener("popstate", route);

// ── Rail (3B + una fila «Tablero») ───────────────────────────────────
function boardSummary() {
	const open = D.tasks.filter((t) => !t.goal && t.status !== "done");
	const parts = [`${open.length} abiertas`];
	const b = D.tasks.filter((t) => t.blocked && t.status !== "done").length;
	if (b) parts.push(`${b} bloqueada${b > 1 ? "s" : ""}`);
	const r = D.tasks.filter(awaitingOwner).length;
	if (r) parts.push(`${r} por aprobar`);
	return { text: parts.join(" · "), warn: b > 0 || r > 0 };
}
function renderRail(view) {
	const rail = $("#rail");
	const s = scenario === "normal" || scenario === "stale" ? boardSummary() : null;
	rail.replaceChildren(
		h("div", { class: "rail-head" }, D.project.name, h("span", { class: "muted small" }, "▾")),
		h(
			"div",
			{ class: "rail-scroll" },
			h("button", { class: "attn", onclick: () => toast("Abre Pendientes (3B)") }, "1 te espera · 1 interrupción"),
			h("div", { class: "sec" }, "Conversaciones", h("button", { class: "plus", "aria-label": "Nueva conversación" }, "+")),
			D.topics.map((tp) =>
				h(
					"button",
					{ class: `row${view === "topic" && location.hash.includes(`/c/${tp.id}`) ? " active" : ""}`, onclick: () => go(`#/topic/c/${tp.id}`) },
					h("span", { class: "main" }, h("span", { class: "t" }, tp.title), tp.sub && h("span", { class: `s ${tp.err ? "e" : "a"}` }, tp.sub)),
				),
			),
			h("button", { class: "row" }, h("span", { class: "faint" }, "Conversaciones archivadas")),
			h("div", { class: "sec" }, "Tareas"),
			h(
				"button",
				{ class: `row${view === "board" ? " active" : ""}`, onclick: () => go("#/board"), "aria-current": view === "board" ? "page" : null },
				h("span", { class: "board-ico" }, ic("board")),
				h(
					"span",
					{ class: "main" },
					h("span", { class: "t" }, "Tablero"),
					h("span", { class: `s${s?.warn ? " w" : ""}` }, s ? s.text : scenario === "empty" ? "Sin tareas" : "No se pudo cargar"),
				),
			),
			h("div", { class: "sec" }, "Equipo", h("button", { class: "plus", "aria-label": "Nuevo agente" }, "+")),
			Object.values(D.agents).map((a) =>
				h(
					"div",
					{ class: "row" },
					av(a.name, ""),
					h(
						"span",
						{ class: "main" },
						h("span", { class: "t" }, `@${a.name}`),
						h("span", { class: `s ${a.team.startsWith("ocupado") ? "a" : a.team.includes("interrump") ? "e" : ""}` }, a.team),
					),
				),
			),
			h("div", { class: "sec" }, "Trabajos"),
			["oauth-callback", "sesiones-v2", "ci-cache"].map((w) =>
				h("div", { class: "row" }, h("span", { class: "main" }, h("span", { class: "t mono" }, `⎇ ${w}`))),
			),
			h("div", { class: "sec" }, "Archivo · solo lectura"),
			h("div", { class: "row" }, h("span", { class: "main" }, h("span", { class: "t" }, "Project Chat y chats individuales"))),
		),
		h("div", { class: "rail-foot" }, "Sesiones  ·  Ajustes"),
	);
}

// ── Tablero ──────────────────────────────────────────────────────────
function header() {
	const goals = D.tasks.filter((t) => t.goal).length;
	const open = D.tasks.filter((t) => !t.goal && t.status !== "done").length;
	return h(
		"header",
		{ class: "bar" },
		h("button", { class: "back", "aria-label": "Volver al proyecto", onclick: () => go("#/rail") }, "‹"),
		h(
			"div",
			{ class: "grow" },
			h("h1", { id: "board-title" }, "Tablero"),
			h("div", { class: "sub" }, scenario === "normal" || scenario === "stale" ? `${D.project.name} · ${goals} objetivos · ${open} tareas abiertas` : D.project.name),
		),
		h("button", { class: "legend-btn", onclick: legend, "aria-haspopup": "dialog", "aria-label": "Cómo se lee el tablero" }, h("span", { class: "lg-long" }, "Cómo se lee"), h("span", { class: "lg-short", "aria-hidden": "true" }, "?")),
		h("button", { class: "icon-btn inbox m-only", "aria-label": "Pendientes (2)", onclick: () => toast("Abre Pendientes (3B)") }, ic("inbox"), h("b", { class: "badge" }, "2")),
	);
}
function renderBoard() {
	const b = $("#board");
	wide = $("#main").clientWidth >= 860;
	const nodes = [header()];
	if (scenario === "error") {
		nodes.push(
			h(
				"div",
				{ class: "empty" },
				h("h2", {}, "No se pudo cargar el tablero"),
				h("p", {}, "El servidor no respondió (503). Las conversaciones siguen funcionando."),
				h("button", { class: "btn primary", onclick: () => setScenario("normal") }, "Reintentar"),
			),
		);
	} else if (scenario === "empty") {
		nodes.push(
			h(
				"div",
				{ class: "empty" },
				h("h2", {}, "Todavía no hay tareas en este proyecto"),
				h(
					"p",
					{},
					"Las crean los agentes cuando un pedido tuyo necesita varios pasos o varias personas. Los pedidos simples se resuelven en la conversación, sin tareas.",
				),
				h("button", { class: "btn", onclick: () => go(`#/topic/c/${D.topics[0].id}`) }, "Ir a las conversaciones"),
			),
		);
	} else {
		if (scenario === "stale")
			nodes.push(
				h(
					"div",
					{ class: "banner err", role: "status" },
					h("span", { class: "grow" }, "No se pudo actualizar. Mostrando lo cargado a las 10:52; los cambios en vivo están en pausa."),
					h("button", { class: "btn sm", onclick: () => setScenario("normal") }, "Reintentar"),
				),
			);
		nodes.push(wide ? kanban() : list());
	}
	b.replaceChildren(...nodes);
	if (flashId) {
		const c = b.querySelector(`[data-id="${flashId}"]`);
		c?.classList.add("flash");
		flashId = null;
	}
}

function counts() {
	const c = { todo: 0, doing: 0, review: 0, done: 0 };
	for (const t of D.tasks) if (!t.goal) c[t.status]++;
	return c;
}
function kanban() {
	const c = counts();
	const wrap = h(
		"div",
		{ class: "kb" },
		h(
			"div",
			{ class: "kb-cols", role: "presentation" },
			ORDER.map((s) => h("div", { class: "col-h" }, ST[s], h("span", { class: "n" }, c[s]))),
		),
	);
	for (const g of D.tasks.filter((t) => t.goal)) wrap.append(lane(g, kids(g)));
	const loose = D.tasks.filter((t) => !t.goal && !t.parent);
	if (loose.length) wrap.append(lane(null, loose));
	wrap.append(h("div", { class: "older" }, h("button", { class: "link", onclick: () => toast("Carga la página siguiente de terminadas") }, `Ver ${D.olderDone} terminadas anteriores`)));
	return wrap;
}
function goalMeta(g) {
	const ch = kids(g);
	const done = ch.filter((t) => t.status === "done").length;
	const full = g.budget.used >= g.budget.limit;
	return h(
		"span",
		{ class: "meta" },
		h("span", {}, ST[g.status]),
		h("span", { class: "sep" }, "·"),
		h("span", {}, "coordina "),
		who(g.coordinator, "xs"),
		h("span", { class: "sep" }, "·"),
		h("span", {}, `${done}/${ch.length} terminadas`),
		h("span", { class: "sep" }, "·"),
		full
			? h("span", { class: "alert" }, `Presupuesto agotado ${g.budget.used}/${g.budget.limit}`)
			: h("span", {}, `${g.budget.used}/${g.budget.limit} pedidos`),
	);
}
function lane(g, tasks) {
	const head = g
		? h(
				"div",
				{ class: "lane-h" },
				h(
					"button",
					{ class: "gt", onclick: () => openTask(g.id), "aria-label": `Objetivo ${g.title}, abrir detalle` },
					h("span", { class: "goal-mark", "aria-hidden": "true" }, "◆"),
					h("span", { class: "tt" }, g.title),
					h("span", { class: "muted mono" }, `#${g.id}`),
				),
				goalMeta(g),
				g.budget.used >= g.budget.limit && h("button", { class: "btn sm", onclick: () => budgetDlg(g) }, "Ampliar"),
				h("button", { class: "tog", onclick: (e) => goalMenu(g, e.currentTarget), "aria-label": `Acciones del objetivo ${g.title}`, "aria-haspopup": "menu" }, "⋯"),
			)
		: h("div", { class: "lane-h" }, h("span", { class: "gt" }, "Sin objetivo"), h("span", { class: "meta" }, "tareas sueltas"));
	return h(
		"section",
		{ class: `lane${g ? "" : " loose"}`, "aria-label": g ? `Objetivo ${g.title}` : "Tareas sin objetivo" },
		head,
		h(
			"div",
			{ class: "lane-grid" },
			ORDER.map((s) => {
				const col = tasks.filter((t) => t.status === s);
				return h("div", { class: "stack", "aria-label": ST[s] }, col.length ? col.map((t) => card(t, false)) : h("div", { class: "col-empty" }, "—"));
			}),
		),
	);
}

function actLine(a, t, inDetail) {
	const map = {
		running: () => [`@${a.who} trabajando en «${a.topic}» desde ${a.since}`, inDetail && ["Ver en el tema", () => go(`#/topic/c/${t.topic}/m${t.id}`)]],
		queued: () => [`en cola para @${a.who}: detrás de ${a.behind}`, null],
		uncertain: () => [`ejecución de @${a.who} interrumpida`, ["Revisar", () => toast("Abre «Revisar interrupción» (3B)")]],
		waitOwner: () => [`@${a.who} espera tu respuesta${inDetail ? `: «${a.q}»` : ""}`, ["Responder", () => toast("Abre la pregunta (Pendientes, 3B)")]],
		work: () => [`trabajo ⎇ ${a.id} ${a.active ? "activo" : "cerrado"}`, inDetail && ["Herramientas", () => toast(`Abre Herramientas en ⎇ ${a.id}`)]],
	};
	const [text, cta] = map[a.k]();
	return h(
		"div",
		{ class: `act ${a.k}` },
		h("span", { class: "d", "aria-hidden": "true" }),
		h("span", {}, text),
		cta &&
			h(
				"button",
				{
					class: "cta",
					onclick: (e) => {
						e.stopPropagation();
						cta[1]();
					},
				},
				cta[0],
			),
	);
}
function contra(t, inDetail) {
	const out = [];
	if (t.status === "done" && live(t))
		out.push(
			h(
				"div",
				{ class: "flag contra", role: "note" },
				h("span", { class: "i" }, ic("warn")),
				h("span", {}, inDetail ? "Está en Terminado pero hay trabajo activo. El estado no se corrige solo: decidí si vuelve a En progreso o si el trabajo se cierra." : "Terminado, pero con trabajo activo"),
			),
		);
	return out;
}
function flags(t, inDetail) {
	const out = [];
	if (t.blocked) out.push(h("div", { class: "flag block" }, h("span", { class: "i" }, ic("block")), h("span", {}, `Bloqueada: ${t.blocked}`)));
	if (t.external) out.push(h("div", { class: "flag ext" }, h("span", { class: "i" }, ic("ext")), h("span", {}, `Espera algo externo: ${t.external}`)));
	for (const id of t.deps || []) {
		const d = T(id);
		if (d && d.status !== "done") out.push(h("div", { class: "flag dep" }, h("span", { class: "i" }, ic("dep")), h("span", {}, `Depende de #${id} ${inDetail ? `«${d.title}» ` : ""}(${ST[d.status].toLowerCase()})`)));
	}
	if (t.req && t.req.used >= t.req.limit)
		out.push(h("div", { class: "flag spent" }, h("span", { class: "i" }, ic("budget")), h("span", {}, `Presupuesto de la tarea agotado (${t.req.used}/${t.req.limit})`)));
	return out;
}
function card(t, showGoal) {
	const g = goalOf(t);
	const chips = (t.links || []).filter((l) => l[0] !== "dep").map(([k, v]) => h("span", { class: `chip${k === "work" && live({ act: (t.act || []).filter((a) => a.k === "work" && a.id === v) }) ? " live" : ""}` }, k === "work" ? `⎇ ${v}` : `PR #${v}`));
	const el = h(
		"article",
		{
			class: `card${selected === t.id ? " sel" : ""}${t.blocked ? " blocked" : ""}${t.status === "done" && live(t) ? " contra" : ""}`,
			"data-id": t.id,
			tabindex: "0",
			"aria-label": `#${t.id} ${t.title}, ${ST[t.status]}`,
			onclick: () => openTask(t.id),
			onkeydown: (e) => {
				if (e.key === "Enter" && e.target === e.currentTarget) openTask(t.id);
			},
		},
		h(
			"div",
			{ class: "top" },
			h("span", { class: "title" }, t.title),
			h(
				"button",
				{
					class: "kebab",
					"aria-label": `Acciones de #${t.id}`,
					"aria-haspopup": "menu",
					onclick: (e) => {
						e.stopPropagation();
						taskMenu(t, e.currentTarget);
					},
				},
				"⋯",
			),
		),
		h(
			"div",
			{ class: "meta" },
			h("span", { class: "id" }, `#${t.id}`),
			who(t.assignee, "xs"),
			t.prio !== "normal" && h("span", { class: `prio ${t.prio}` }, t.prio === "high" ? "↑ Alta" : "↓ Baja"),
			chips,
		),
		showGoal && h("div", { class: "goal-line" }, g ? `◆ ${g.title}` : "Sin objetivo"),
		flags(t, false),
		contra(t, false),
		t.act?.length ? h("div", { class: "acts" }, t.act.map((a) => actLine(a, t, false))) : null,
		awaitingOwner(t) &&
			h(
				"div",
				{ class: "flag approve" },
				h("span", {}, "Espera tu aprobación"),
				h(
					"button",
					{
						class: "btn sm ok",
						onclick: (e) => {
							e.stopPropagation();
							requestMove(t, "done");
						},
					},
					"Aprobar",
				),
			),
	);
	return el;
}

function list() {
	const wrap = h("div", { class: "ls" });
	const goals = D.tasks.filter((t) => t.goal);
	wrap.append(h("div", { class: "grp-h" }, "Objetivos", h("span", {}, goals.length)));
	wrap.append(
		h(
			"div",
			{ class: "grp" },
			goals.map((g) => {
				const ch = kids(g);
				const done = ch.filter((t) => t.status === "done").length;
				const full = g.budget.used >= g.budget.limit;
				return h(
					"button",
					{ class: "goal-row", onclick: () => openTask(g.id) },
					h("span", { class: "l1" }, h("span", { class: "goal-mark", "aria-hidden": "true" }, "◆"), g.title, h("span", { class: "muted mono" }, `#${g.id}`)),
					h("span", { class: "bar-prog", "aria-hidden": "true" }, h("i", { style: `width:${(done / ch.length) * 100}%` })),
					h(
						"span",
						{ class: "l2" },
						`${ST[g.status]} · ${done}/${ch.length} terminadas · coordina`,
						who(g.coordinator, "xs"),
						full && h("span", { style: "color:var(--c-err-soft);font-weight:600" }, `· presupuesto agotado`),
					),
				);
			}),
		),
	);
	for (const s of PHONE_ORDER) {
		const ts = D.tasks.filter((t) => !t.goal && t.status === s);
		wrap.append(h("div", { class: "grp-h" }, ST[s], h("span", {}, ts.length)));
		wrap.append(h("div", { class: "grp" }, ts.length ? ts.map((t) => card(t, true)) : h("div", { class: "col-empty" }, `Nada ${s === "todo" ? "por hacer" : s === "doing" ? "en progreso" : s === "review" ? "en revisión" : "terminado"}`)));
	}
	wrap.append(h("div", { class: "older", style: "padding:0 16px" }, h("button", { class: "link", onclick: () => toast("Carga la página siguiente de terminadas") }, `Ver ${D.olderDone} terminadas anteriores`)));
	return wrap;
}

// ── Detalle ──────────────────────────────────────────────────────────
function openTask(id) {
	lastFocus = document.activeElement;
	go(`#/board/t/${id}`, location.hash.startsWith("#/board/t/"));
}
function closeDetail() {
	go("#/board");
	const c = lastFocus && document.contains(lastFocus) ? lastFocus : $(`[data-id="${selected}"]`);
	c?.focus();
}
function renderDetail() {
	const d = $("#detail");
	const t = selected != null ? T(selected) : null;
	if (!t || scenario === "error" || scenario === "empty") {
		d.hidden = true;
		if (selected != null && !t) {
			d.hidden = false;
			d.replaceChildren(dBar(null), h("div", { class: "empty" }, h("h2", {}, "Esta tarea ya no existe"), h("button", { class: "btn", onclick: closeDetail }, "Volver al tablero")));
		}
		return;
	}
	d.hidden = false;
	const g = goalOf(t);
	const body = h("div", { class: "d-body" });
	const cf = conflicts.get(t.id);
	if (cf)
		body.append(
			h(
				"div",
				{ class: "conflict", role: "alert" },
				h("strong", {}, "La tarea cambió antes de guardar tu cambio"),
				h("span", {}, `${cf.by} ${cf.what}. Tu cambio («${cf.tried}») no se aplicó. Esto que ves ya es lo actual.`),
				h(
					"div",
					{ class: "acts2" },
					h(
						"button",
						{
							class: "btn sm",
							onclick: () => {
								conflicts.delete(t.id);
								cf.retry();
							},
						},
						`Repetir: ${cf.tried}`,
					),
					h(
						"button",
						{
							class: "btn sm",
							onclick: () => {
								conflicts.delete(t.id);
								renderDetail();
							},
						},
						"Dejarlo así",
					),
				),
			),
		);
	body.append(h("h2", { class: "d-title", id: "d-title" }, h("span", { class: "id" }, `#${t.id}`), t.goal ? "◆ " : "", t.title));
	const last = [...t.history].reverse().find((e) => /movió|aprobó|creó|devolvió/.test(e[2]));
	body.append(
		h(
			"div",
			{ class: "d-state" },
			h(
				"button",
				{ class: `decl ${t.status}`, "aria-haspopup": "menu", onclick: (e) => moveMenu(t, e.currentTarget), "aria-label": `Estado: ${ST[t.status]}. Mover a…` },
				ST[t.status],
				h("span", { class: "caret" }, "▾"),
			),
			last && h("span", { class: "muted small" }, `declarado ${last[1] === "sistema" ? "" : last[1] === "owner" ? "por vos · " : `por @${last[1]} · `}${last[0]}`),
			t.status === "review" && h("button", { class: "btn sm ok", onclick: () => requestMove(t, "done") }, "Aprobar · Terminado"),
		),
	);
	const fl = flags(t, true);
	if (fl.length) body.append(h("div", { class: "declared-flags" }, fl));
	if (!t.goal)
		body.append(
			h(
				"section",
				{ class: "d-sec" },
				h("h3", {}, "Ahora", h("small", {}, "según mensajes y trabajos · no cambia el estado")),
				h("div", { class: "now-box" }, contra(t, true), t.act?.length ? t.act.map((a) => actLine(a, t, true)) : h("span", { class: "muted small" }, "Nadie está trabajando en esta tarea ahora.")),
			),
		);

	const dl = h("dl", { class: "fields" });
	const row = (k, ...v) => dl.append(h("dt", {}, k), h("dd", {}, ...v));
	if (t.goal) row("Coordina", who(t.coordinator), h("button", { class: "link small", onclick: () => coordDlg(t) }, "Cambiar"));
	if (!t.goal) row("Responsable", who(t.assignee), h("button", { class: "link small", onclick: () => reassignDlg(t) }, "Reasignar"));
	if (!t.goal) row("Revisa", t.reviewer ? who(t.reviewer) : h("span", {}, "vos"));
	row(
		"Prioridad",
		h(
			"span",
			{ class: "seg", role: "group", "aria-label": "Prioridad" },
			["low", "normal", "high"].map((p) => h("button", { "aria-pressed": String(t.prio === p), onclick: () => t.prio !== p && apply(t, `Prioridad ${PRIO[p]}`, () => (t.prio = p), `cambiaste la prioridad a ${PRIO[p]}`) }, PRIO[p])),
		),
	);
	if (!t.goal) row("Objetivo", g ? h("button", { class: "link", onclick: () => openTask(g.id) }, `◆ ${g.title}`) : h("span", { class: "muted" }, "Sin objetivo"));
	if (g) row("Coordina", who(g.coordinator));
	if (t.req) row("Pedidos", h("span", { class: t.req.used >= t.req.limit ? "" : "muted" }, `${t.req.used} de ${t.req.limit} de esta tarea`));
	body.append(h("section", { class: "d-sec" }, dl));

	if (t.goal) {
		const full = t.budget.used >= t.budget.limit;
		body.append(
			h(
				"section",
				{ class: "d-sec" },
				h("h3", {}, "Presupuesto", h("small", {}, "pedidos entre agentes")),
				h(
					"div",
					{ class: "budget" },
					h("div", { class: `meter${full ? " full" : ""}`, role: "img", "aria-label": `${t.budget.used} de ${t.budget.limit}` }, h("i", { style: `width:${Math.min(100, (t.budget.used / t.budget.limit) * 100)}%` })),
					h(
						"div",
						{ style: "display:flex;align-items:center;gap:8px" },
						h("span", { class: "grow small" }, full ? `Agotado: ${t.budget.used} de ${t.budget.limit}. Los pedidos nuevos entre agentes se rechazan.` : `${t.budget.used} de ${t.budget.limit} usados`),
						h("button", { class: `btn sm${full ? " primary" : ""}`, onclick: () => budgetDlg(t) }, "Ampliar"),
					),
				),
			),
		);
		const ch = kids(t);
		body.append(
			h(
				"section",
				{ class: "d-sec" },
				h("h3", {}, "Tareas", h("small", {}, `${ch.filter((c) => c.status === "done").length}/${ch.length} terminadas`)),
				h(
					"div",
					{ class: "children" },
					PHONE_ORDER.flatMap((s) =>
						ch
							.filter((c) => c.status === s)
							.map((c) => h("button", { class: "child", onclick: () => openTask(c.id) }, av(c.assignee, "xs"), h("span", {}, c.title, c.blocked ? " · bloqueada" : "", c.status === "done" && live(c) ? " · con trabajo activo" : ""), h("span", { class: "st" }, ST[c.status]))),
					),
				),
			),
		);
	}
	body.append(h("section", { class: "d-sec" }, h("h3", {}, "Descripción"), h("div", { class: "desc" }, t.desc)));
	const tp = D.topics.find((x) => x.id === t.topic);
	body.append(
		h(
			"section",
			{ class: "d-sec" },
			h("h3", {}, "Enlaces"),
			h(
				"div",
				{ class: "links" },
				tp && h("button", { class: "lnk", onclick: () => go(`#/topic/c/${tp.id}/m${t.id}`) }, h("span", { class: "k" }, ic("chat")), h("span", { class: "v" }, `«${tp.title}»`, h("span", { class: "muted small" }, " · donde se pidió")), h("span", { class: "go" }, "Abrir ›")),
				(t.links || []).map(([k, v]) =>
					k === "work"
						? h("button", { class: "lnk", onclick: () => toast(`Abre Herramientas en ⎇ ${v}`) }, h("span", { class: "k" }, "⎇"), h("span", { class: "v mono" }, v), h("span", { class: "go" }, "Herramientas ›"))
						: h("button", { class: "lnk", onclick: () => toast(`Abre PR #${v} en GitHub (pestaña nueva)`) }, h("span", { class: "k" }, ic("pr")), h("span", { class: "v" }, `PR #${v}`), h("span", { class: "go" }, "GitHub ↗")),
				),
			),
		),
	);
	const hist = [...t.history].reverse();
	body.append(
		h(
			"section",
			{ class: "d-sec" },
			h("h3", {}, "Historial", hist.length > 5 && h("button", { class: "link small" }, `Ver todo (${hist.length})`)),
			h("ol", { class: "hist" }, hist.slice(0, 5).map(([tm, by, what]) => h("li", {}, h("time", {}, tm), h("span", {}, by === "sistema" ? what : `@${by === "owner" ? "vos" : by} ${what}`.replace("@vos ", "Vos "))))),
		),
	);
	d.replaceChildren(dBar(g, t), body);
}
function dBar(g, t) {
	return h(
		"div",
		{ class: "d-bar" },
		h("button", { class: "icon-btn", "aria-label": "Volver al tablero", onclick: closeDetail }, matchMedia("(max-width: 720px)").matches ? "‹" : "✕"),
		h("span", { class: "crumb" }, t ? (t.goal ? "Objetivo" : g ? `◆ ${g.title}` : "Sin objetivo") : ""),
		t && h("button", { class: "icon-btn", "aria-label": `Acciones de #${t.id}`, "aria-haspopup": "menu", onclick: (e) => (t.goal ? goalMenu(t, e.currentTarget) : taskMenu(t, e.currentTarget)) }, "⋯"),
	);
}

// ── Acciones ─────────────────────────────────────────────────────────
// Toda escritura lleva la versión leída; el 409 `stale` devuelve la fila actual.
function apply(t, label, mutate, histText) {
	closeMenu();
	if (conflictNext) {
		conflictNext = false;
		$("#sc-409").checked = false;
		const remote = remoteChange(t);
		conflicts.set(t.id, { by: remote.by, what: remote.what, tried: label, retry: () => apply(t, label, mutate, histText) });
		flashId = t.id;
		if (selected !== t.id) openTask(t.id);
		else route();
		toast("No se aplicó: la tarea cambió (409). Releé el detalle.");
		return;
	}
	mutate();
	t.history.push(["ahora", "owner", histText]);
	flashId = t.id;
	route();
	toast(`#${t.id}: ${histText[0].toUpperCase()}${histText.slice(1)}`);
}
function remoteChange(t) {
	// Un cambio ajeno y válido según los permisos de 4A (el responsable nunca marca Terminado).
	const g = goalOf(t);
	if (t.status === "review") {
		const by = t.reviewer || g?.coordinator || t.assignee;
		t.status = "doing";
		t.act = (t.act || []).filter((a) => a.k !== "queued");
		t.history.push(["ahora", by, "la devolvió a En progreso: «falta el caso de sesión vencida»"]);
		return { by: `@${by}`, what: "la devolvió a En progreso («falta el caso de sesión vencida»)" };
	}
	if (t.status === "todo" || t.status === "doing") {
		const by = t.goal ? t.coordinator : t.assignee;
		const next = t.status === "todo" ? "doing" : "review";
		t.status = next;
		t.history.push(["ahora", by, `movió a ${ST[next]}`]);
		return { by: `@${by}`, what: `la movió a ${ST[next]}` };
	}
	const by = t.goal ? t.coordinator : g?.coordinator || t.assignee;
	t.prio = t.prio === "high" ? "normal" : "high";
	t.history.push(["ahora", by, `cambió la prioridad a ${PRIO[t.prio]}`]);
	return { by: `@${by}`, what: `cambió la prioridad a ${PRIO[t.prio]}` };
}
function requestMove(t, s) {
	closeMenu();
	if (s === "done" && live(t)) {
		const act = t.act.find((a) => a.k === "running") || t.act.find((a) => a.k === "work" && a.active);
		return dialog(
			"¿Marcar Terminado con trabajo activo?",
			[
				h("p", {}, act.k === "running" ? `@${act.who} sigue trabajando en esta tarea (desde ${act.since}).` : `El trabajo ⎇ ${act.id} sigue abierto.`),
				h("div", { class: "warnbox" }, "Marcarla Terminado no detiene nada. El tablero va a mostrar la contradicción hasta que ese trabajo termine o se cierre."),
			],
			"Marcar Terminado igual",
			() => doMove(t, s),
		);
	}
	if (t.goal && s === "done") {
		const open = kids(t).filter((c) => c.status !== "done").length;
		if (open)
			return dialog("¿Dar el objetivo por terminado?", [h("p", {}, `Tiene ${open} tareas sin terminar. Quedan como están; podés moverlas después.`)], "Terminar el objetivo", () => doMove(t, s));
	}
	doMove(t, s);
}
function doMove(t, s) {
	const label = s === "done" && t.status === "review" ? "Aprobar · Terminado" : `Mover a ${ST[s]}`;
	apply(t, label, () => {
		t.status = s;
		if (s === "done") (t.doneBy = "owner"), (t.act = (t.act || []).filter((a) => a.k !== "queued"));
	}, s === "done" ? "aprobaste: Terminado" : `moviste a ${ST[s]}`);
}

// ── Menús ────────────────────────────────────────────────────────────
function openMenu(anchor, items) {
	const m = $("#menu");
	m.replaceChildren(
		...items.map((it) =>
			it === "-"
				? h("hr")
				: it.head
					? h("div", { class: "mh" }, it.head)
					: h(
							"button",
							{ role: "menuitem", "aria-disabled": it.disabled ? "true" : null, onclick: () => !it.disabled && it.do() },
							it.label,
							it.x && h("span", { class: "x" }, it.x),
						),
		),
	);
	m.hidden = false;
	m._anchor = anchor;
	const r = anchor.getBoundingClientRect();
	const mw = 240;
	m.style.left = `${Math.max(8, Math.min(innerWidth - mw - 8, r.right - mw))}px`;
	const below = r.bottom + 4;
	m.style.top = `${below + m.offsetHeight > innerHeight - 8 ? Math.max(8, r.top - m.offsetHeight - 4) : below}px`;
	m.querySelector("button:not([aria-disabled])")?.focus();
}
function closeMenu() {
	const m = $("#menu");
	if (m.hidden) return;
	m.hidden = true;
	m._anchor?.focus();
}
document.addEventListener("click", (e) => {
	if (!$("#menu").hidden && !e.target.closest("#menu") && !e.target.closest("[aria-haspopup=menu]")) closeMenu();
});
document.addEventListener("keydown", (e) => {
	const m = $("#menu");
	if (e.key === "Escape") {
		if (!m.hidden) return closeMenu();
		if (!$("#detail").hidden && !$("#dlg").open) closeDetail();
	}
	if (!m.hidden && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
		e.preventDefault();
		const bs = [...m.querySelectorAll("button:not([aria-disabled])")];
		const i = bs.indexOf(document.activeElement);
		bs[(i + (e.key === "ArrowDown" ? 1 : -1) + bs.length) % bs.length].focus();
	}
});
function moveItems(t) {
	return [
		{ head: "Mover a…" },
		...ORDER.map((s) => ({
			label: s === "done" && t.status === "review" ? "Terminado (aprobar)" : ST[s],
			x: t.status === s ? "actual" : null,
			disabled: t.status === s,
			do: () => requestMove(t, s),
		})),
	];
}
function moveMenu(t, a) {
	openMenu(a, moveItems(t));
}
function taskMenu(t, a) {
	openMenu(a, [
		...moveItems(t),
		"-",
		{ head: "Prioridad" },
		...["high", "normal", "low"].map((p) => ({ label: PRIO[p], x: t.prio === p ? "actual" : null, disabled: t.prio === p, do: () => apply(t, `Prioridad ${PRIO[p]}`, () => (t.prio = p), `cambiaste la prioridad a ${PRIO[p]}`) })),
		"-",
		{ label: "Reasignar…", do: () => (closeMenu(), reassignDlg(t)) },
		{ label: "Abrir detalle", do: () => (closeMenu(), openTask(t.id)) },
	]);
}
function goalMenu(g, a) {
	openMenu(a, [
		...moveItems(g),
		"-",
		{ label: "Cambiar coordinador…", do: () => (closeMenu(), coordDlg(g)) },
		{ label: "Ampliar presupuesto…", do: () => (closeMenu(), budgetDlg(g)) },
		{ label: "Abrir detalle", do: () => (closeMenu(), openTask(g.id)) },
	]);
}

// ── Diálogos ─────────────────────────────────────────────────────────
function dialog(title, content, okLabel, onOk, okDisabled) {
	const dlg = $("#dlg");
	const ok = h("button", { class: "btn primary", disabled: okDisabled }, okLabel);
	dlg.replaceChildren(h("h2", {}, title), ...content, h("div", { class: "row-end" }, h("button", { class: "btn", onclick: () => dlg.close() }, "Cancelar"), ok));
	ok.onclick = () => {
		dlg.close();
		onOk(dlg);
	};
	dlg.showModal();
	return { dlg, ok };
}
function agentPicker(name, current, onPick) {
	return h(
		"div",
		{ class: "opts", role: "radiogroup" },
		Object.keys(D.agents).map((n) =>
			h(
				"label",
				{ class: "opt" },
				h("input", { type: "radio", name, value: n, checked: n === current, disabled: n === current, onchange: () => onPick(n) }),
				who(n),
				h("span", { class: "muted small grow" }, n === current ? "actual" : ag(n).team),
			),
		),
	);
}
function reassignDlg(t) {
	let pick = null;
	const running = (t.act || []).find((a) => a.k === "running" && a.who === t.assignee);
	const work = (t.act || []).find((a) => a.k === "work" && a.active);
	const warn = [];
	if (running)
		warn.push(
			h(
				"div",
				{ class: "warnbox" },
				h("strong", {}, `@${running.who} sigue trabajando en esta tarea`),
				h("br"),
				`Ejecución en curso desde ${running.since} en «${running.topic}». Reasignar no la detiene: puede terminar y responder. `,
				work ? `El trabajo ⎇ ${work.id} queda abierto y sigue siendo de @${running.who}.` : "",
			),
		);
	const ui = dialog(
		`Reasignar #${t.id}`,
		[
			h("p", { class: "small" }, t.title),
			agentPicker("ra", t.assignee, (n) => {
				pick = n;
				ui.ok.disabled = false;
			}),
			...warn,
			h("p", { class: "small muted" }, "Solo cambia el responsable. Nadie recibe un mensaje: si hace falta, escribile al nuevo desde la conversación."),
		],
		"Reasignar",
		() => {
			const prev = t.assignee;
			apply(t, `Reasignar a @${pick}`, () => {
				t.assignee = pick;
			}, `reasignaste de @${prev} a @${pick}${running ? ` (la ejecución de @${prev} seguía en curso)` : ""}`);
		},
		true,
	);
}
function coordDlg(g) {
	let pick = null;
	const ui = dialog(
		`Coordinador de «${g.title}»`,
		[
			agentPicker("co", g.coordinator, (n) => {
				pick = n;
				ui.ok.disabled = false;
			}),
			h("p", { class: "small muted" }, "El coordinador crea y asigna las tareas del objetivo y puede aprobarlas. El anterior deja de poder hacerlo; lo que tenga en curso sigue."),
		],
		"Cambiar coordinador",
		() => {
			const prev = g.coordinator;
			apply(g, `Coordinador @${pick}`, () => (g.coordinator = pick), `cambiaste el coordinador de @${prev} a @${pick}`);
		},
		true,
	);
}
function budgetDlg(g) {
	let add = 20;
	const full = g.budget.used >= g.budget.limit;
	dialog(
		`Ampliar el presupuesto de «${g.title}»`,
		[
			h("p", {}, `Usados ${g.budget.used} de ${g.budget.limit} pedidos entre agentes.`),
			h(
				"div",
				{ class: "opts", role: "radiogroup" },
				[10, 20, 40].map((n) =>
					h("label", { class: "opt" }, h("input", { type: "radio", name: "bg", value: n, checked: n === add, onchange: () => (add = n) }), `+${n} pedidos`, h("span", { class: "muted small grow", style: "text-align:right" }, `tope ${g.budget.limit + n}`)),
				),
			),
			full && h("p", { class: "small muted" }, "Los pedidos que se rechazaron no se reintentan solos: el coordinador los vuelve a hacer cuando lo necesite."),
		],
		"Ampliar",
		() => apply(g, `Ampliar presupuesto +${add}`, () => (g.budget.limit += add), `ampliaste el presupuesto en ${add} pedidos`),
	);
}
function legend() {
	const sample = (k, txt) => h("div", { class: `act ${k}` }, h("span", { class: "d" }), h("span", {}, txt));
	const dlg = $("#dlg");
	dlg.replaceChildren(
		h("h2", {}, "Cómo se lee el tablero"),
		h("p", {}, h("strong", {}, "La columna es el estado declarado"), ": lo que dijo el responsable, el coordinador o vos. Solo cambia con «Mover a…»."),
		h("p", {}, h("strong", {}, "Las líneas con punto son lo que pasa ahora"), ", calculado de los mensajes y los trabajos. Nunca mueven la tarea de columna."),
		h(
			"div",
			{ class: "now-box", style: "margin:8px 0 12px" },
			sample("running", "trabajando (una ejecución en curso)"),
			sample("queued", "en cola (el agente está ocupado)"),
			sample("uncertain", "ejecución interrumpida, sin revisar"),
			sample("waitOwner", "espera tu respuesta"),
			sample("work", "trabajo (worktree) activo"),
		),
		h("p", { class: "small" }, "Además: Terminado con trabajo activo (ámbar), bloqueada (borde rojo), espera algo externo, depende de otra tarea, presupuesto agotado."),
		h("div", { class: "row-end" }, h("button", { class: "btn primary", onclick: () => dlg.close() }, "Entendido")),
	);
	dlg.showModal();
}

// ── Tema (solo para mostrar la navegación ida y vuelta) ──────────────
function renderTopic(id, hl) {
	const tp = D.topics.find((x) => x.id === id) || D.topics[0];
	const goal = D.tasks.find((t) => t.goal && t.topic === tp.id);
	$("#board").hidden = true;
	const s = $("#topic");
	s.hidden = false;
	const chip = (t) => h("button", { class: "task-chip", onclick: () => openTask(t.id) }, t.goal ? "◆" : ic("board"), ` #${t.id} ${t.title}`);
	const msgs =
		tp.id === "login"
			? [
					[null, "Vos → @arq", "Necesito login con OAuth (PKCE) y migrar las sesiones. Coordinalo vos.", [], 20],
					["arq", "@arq", "Armé el objetivo con 5 tareas; coordino yo. @dev arranca por el callback.", [T(20)], 20],
					["dev", "@dev", "Tomo el callback; trabajo en ⎇ oauth-callback.", [T(21)], 21],
					["ux", "@ux", "Pantalla lista, PR #812 para revisión de @qa.", [T(22)], 22],
					["arq", "@arq", "¿Usamos la cuenta de la organización o una nueva para registrar la app?", [T(24)], 24],
				]
			: [[null, "Vos → …", "(mensajes del tema)", [], 0]];
	s.replaceChildren(
		h(
			"header",
			{ class: "bar" },
			h("button", { class: "back", "aria-label": "Volver", onclick: () => history.back() }, "‹"),
			h("div", { class: "grow" }, h("h1", {}, tp.title), h("div", { class: "sub" }, D.project.name)),
			goal && h("button", { class: "goal-pill", onclick: () => openTask(goal.id) }, `◆ ${goal.title} · ${kids(goal).filter((k) => k.status === "done").length}/${kids(goal).length}`),
			h("button", { class: "icon-btn", "aria-label": "Más" }, "⋯"),
		),
		h(
			"div",
			{ class: "topic-body" },
			h("p", { class: "muted small", style: "max-width:46rem;margin:0 auto 12px" }, "Tema (3B) reducido a lo que importa aquí: los mensajes asociados a una tarea llevan su chip, y el chip abre la tarea en el tablero."),
			msgs.map(([a, w, b, ts, tid]) =>
				h(
					"div",
					{ class: `tmsg${hl === tid ? " hl" : ""}`, style: a ? "" : "background:#1a2742;border-color:#22406a" },
					h("div", { class: "h" }, a && av(a, "xs"), w),
					h("div", {}, b),
					ts.map(chip),
				),
			),
		),
	);
	if (hl) s.querySelector(".hl")?.scrollIntoView({ block: "center" });
}

// ── Escenarios del prototipo ─────────────────────────────────────────
function setScenario(s) {
	scenario = s;
	for (const r of document.querySelectorAll("[name=sc]")) r.checked = r.value === s;
	route();
}
for (const r of document.querySelectorAll("[name=sc]")) r.addEventListener("change", () => setScenario(r.value));
$("#sc-409").addEventListener("change", (e) => (conflictNext = e.target.checked));
$("#sc-reset").addEventListener("click", () => {
	D = PROTO_DATA();
	conflicts.clear();
	setScenario("normal");
});
const params = new URLSearchParams(location.search);
if (params.get("sc")) scenario = params.get("sc");
if (params.has("noproto")) $("#proto").hidden = true;
if (params.has("protoclosed")) $("#proto").open = false;
new ResizeObserver(() => {
	const w = $("#main").clientWidth >= 860;
	if (w !== wide && !$("#board").hidden) renderBoard();
}).observe($("#main"));
route();
