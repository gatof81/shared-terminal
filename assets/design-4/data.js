// Prototipo 4 — datos de ejemplo (ficticios). Nada de esto se mueve solo:
// la "actividad" es un dato que vendría del backend (estado derivado), no un temporizador.
window.PROTO_DATA = () => ({
	project: { id: "hz", name: "Educación HZ" },
	agents: {
		arq: { name: "arq", hue: 25, team: "ocupado en «Login con OAuth»" },
		dev: { name: "dev", hue: 350, team: "ocupado en «Login con OAuth» · 1 en cola" },
		qa: { name: "qa", hue: 0, team: "ejecución interrumpida" },
		ux: { name: "ux", hue: 200, team: "disponible" },
	},
	topics: [
		{ id: "login", title: "Login con OAuth", sub: "@dev trabajando…" },
		{ id: "ci", title: "Optimización de CI", sub: "ejecución interrumpida", err: true },
		{ id: "ui", title: "Rediseño de UI/UX" },
	],
	// status: todo | doing | review | done (DECLARADO, lo escriben las personas/agentes)
	// act: actividad DERIVADA (la calcula el backend al leer; nunca se escribe sobre status)
	//   running {who, topic, since} · queued {who, behind} · uncertain {who} · waitOwner {who, q}
	//   work {id, active}
	tasks: [
		{
			id: 20, goal: true, title: "Login con OAuth", status: "doing", prio: "high",
			assignee: "arq", coordinator: "arq", reviewer: null,
			budget: { used: 31, limit: 40 }, topic: "login",
			desc: "Iniciar sesión con el proveedor OAuth (PKCE) y migrar las sesiones al esquema nuevo. Pedido del owner en «Login con OAuth».",
			links: [],
			history: [
				["10:02", "arq", "creó el objetivo desde tu mensaje en «Login con OAuth»"],
				["10:03", "arq", "creó 5 tareas y se asignó como coordinador"],
				["10:40", "arq", "movió a En progreso"],
			],
		},
		{
			id: 21, parent: 20, title: "Callback OAuth en el backend", status: "doing", prio: "high",
			assignee: "dev", reviewer: "qa", topic: "login", req: { used: 6, limit: 12 },
			act: [{ k: "running", who: "dev", topic: "Login con OAuth", since: "10:41" }, { k: "work", id: "oauth-callback", active: true }],
			desc: "Endpoint /auth/callback: intercambio del código, validación de state y alta de la sesión.",
			links: [["work", "oauth-callback"]],
			history: [
				["10:03", "arq", "creó la tarea y la asignó a @dev"],
				["10:41", "dev", "movió a En progreso"],
				["10:41", "dev", "enlazó el trabajo ⎇ oauth-callback"],
			],
		},
		{
			id: 22, parent: 20, title: "Pantalla de login y estados de error", status: "review", prio: "normal",
			assignee: "ux", reviewer: "qa", topic: "login", req: { used: 4, limit: 12 },
			act: [{ k: "queued", who: "qa", behind: "su ejecución interrumpida en #32" }],
			desc: "Botón del proveedor, error de red, cuenta sin permiso y sesión vencida.",
			links: [["pr", "812"]],
			history: [
				["10:03", "arq", "creó la tarea y la asignó a @ux"],
				["10:50", "ux", "movió a En revisión y enlazó PR #812"],
				["10:51", "ux", "pidió revisión a @qa"],
			],
		},
		{
			id: 23, parent: 20, title: "Tests e2e del login", status: "todo", prio: "normal",
			assignee: "qa", reviewer: "arq", topic: "login", deps: [21],
			desc: "Flujo completo contra el mock del proveedor; desktop y móvil.",
			links: [],
			history: [["10:03", "arq", "creó la tarea, dependiente de #21"]],
		},
		{
			id: 24, parent: 20, title: "Registrar la app en el proveedor", status: "todo", prio: "high",
			assignee: "arq", reviewer: null, topic: "login",
			blocked: "Falta el client secret: solo el owner tiene acceso a la consola del proveedor.",
			external: "Alta de la app en la consola del proveedor",
			act: [{ k: "waitOwner", who: "arq", q: "¿Usamos la cuenta de la organización o una nueva?" }],
			desc: "Dar de alta la app, cargar los redirect URIs de producción y de preview.",
			links: [],
			history: [
				["10:03", "arq", "creó la tarea"],
				["10:30", "arq", "la bloqueó: «Falta el client secret…»"],
				["10:31", "arq", "te preguntó: «¿Usamos la cuenta de la organización…?»"],
			],
		},
		{
			id: 25, parent: 20, title: "Migrar sesiones al esquema nuevo", status: "done", prio: "normal",
			assignee: "dev", reviewer: "arq", topic: "login", doneBy: "arq", doneAt: "10:38",
			act: [{ k: "work", id: "sesiones-v2", active: true }],
			desc: "Agregar la columna provider y migrar las sesiones existentes.",
			links: [["work", "sesiones-v2"], ["pr", "809"]],
			history: [
				["10:03", "arq", "creó la tarea y la asignó a @dev"],
				["10:20", "dev", "movió a En revisión"],
				["10:38", "arq", "aprobó: Terminado"],
			],
		},
		{
			id: 30, goal: true, title: "Optimización de CI", status: "doing", prio: "normal",
			assignee: "dev", coordinator: "dev", reviewer: null,
			budget: { used: 40, limit: 40 }, topic: "ci",
			desc: "Bajar el tiempo del pipeline de PR por debajo de 8 minutos.",
			links: [],
			history: [
				["09:10", "dev", "creó el objetivo desde tu mensaje en «Optimización de CI»"],
				["10:12", "sistema", "presupuesto agotado (40/40): se rechazó un pedido de @dev a @qa"],
			],
		},
		{
			id: 31, parent: 30, title: "Cache de dependencias en CI", status: "doing", prio: "normal",
			assignee: "dev", reviewer: "qa", topic: "ci", req: { used: 5, limit: 12 },
			act: [{ k: "queued", who: "dev", behind: "#21 Callback OAuth en el backend" }],
			desc: "Cachear node_modules por hash del lockfile.",
			links: [["work", "ci-cache"]],
			history: [["09:12", "dev", "movió a En progreso"]],
		},
		{
			id: 32, parent: 30, title: "Dividir la suite e2e en shards", status: "doing", prio: "high",
			assignee: "qa", reviewer: "dev", topic: "ci", req: { used: 12, limit: 12 },
			act: [{ k: "uncertain", who: "qa" }],
			desc: "Cuatro shards en el job de PR; medir contra la corrida actual.",
			links: [],
			history: [
				["09:15", "qa", "movió a En progreso"],
				["10:05", "sistema", "la ejecución de @qa se interrumpió"],
				["10:12", "sistema", "presupuesto de la tarea agotado (12/12)"],
			],
		},
		{
			id: 33, parent: 30, title: "Medir tiempos actuales del pipeline", status: "done", prio: "low",
			assignee: "qa", reviewer: "dev", topic: "ci", doneBy: "dev", doneAt: "09:40",
			desc: "Línea de base de 10 corridas.", links: [],
			history: [["09:40", "dev", "aprobó: Terminado"]],
		},
		{
			id: 34, parent: 30, title: "Evaluar un runner propio", status: "todo", prio: "low",
			assignee: "dev", reviewer: null, topic: "ci", desc: "Solo si el cache no alcanza.", links: [],
			history: [["09:12", "dev", "creó la tarea"]],
		},
		{
			id: 40, title: "Actualizar el README de despliegue", status: "todo", prio: "normal",
			assignee: "arq", reviewer: null, topic: "ui", desc: "Reflejar el cambio de puertos.", links: [],
			history: [["11:00", "arq", "creó la tarea desde tu mensaje en «Rediseño de UI/UX»"]],
		},
		{
			id: 41, title: "Contraste de los chips de estado", status: "review", prio: "normal",
			assignee: "ux", reviewer: null, topic: "ui", desc: "Llevar los chips a AA sobre todas las superficies.",
			links: [["pr", "815"]],
			history: [["11:20", "ux", "movió a En revisión y enlazó PR #815"]],
		},
	],
	olderDone: 14,
});
