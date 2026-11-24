// Datos simulados del prototipo 3A. Nada de esto toca el producto.
window.DATA = (() => {
	const agents = {
		architect: { hue: 210, role: "Arquitectura" },
		developer: { hue: 28, role: "Implementación" },
		designer: { hue: 285, role: "UI/UX" },
		qa: { hue: 150, role: "Revisión y pruebas" },
		arq: { hue: 200, role: "Planificación" },
		dev: { hue: 350, role: "Contenido" },
	};
	const projects = [
		{ id: "st", name: "Shared Terminal", mark: "ST", team: ["architect", "developer", "designer", "qa"] },
		{ id: "hz", name: "Educación HZ", mark: "HZ", team: ["arq", "dev"] },
		{ id: "notas", name: "Notas personales", mark: "NP", team: [] },
	];
	const convs = [
		{ id: "ui", project: "st", title: "Rediseño de UI/UX" },
		{ id: "ci", project: "st", title: "Optimización de CI" },
		{ id: "be", project: "st", title: "Mejoras del backend" },
		{ id: "res", project: "st", title: "Investigación: equipos y chats" },
		{ id: "hz1", project: "hz", title: "Plan de clases de diciembre" },
		{ id: "hz2", project: "hz", title: "Banco de ejercicios" },
		{ id: "arch-dev", project: "st", title: "@developer · chat individual", archive: true, note: "142 mensajes · hasta 24/11/2026" },
		{ id: "arch-arc", project: "st", title: "@architect · chat individual", archive: true, note: "96 mensajes · hasta 24/11/2026" },
		{ id: "arch-pc", project: "st", title: "Project Chat anterior", archive: true, note: "311 mensajes · hasta 24/11/2026" },
	];
	const works = [
		{ id: "ci-cache", project: "st", agent: "developer", state: "activo", conv: "ci", branch: "work/ci-cache", base: "main@3bda155", ports: "20000–20099" },
		{ id: "ui-tokens", project: "st", agent: "designer", state: "activo", conv: "ui", branch: "work/ui-tokens", base: "main@3bda155", ports: "20100–20199" },
		{ id: "fix-761", project: "st", agent: "developer", state: "cerrado", conv: "be", branch: "work/fix-761", base: "main@40ed58f", ports: "—", pr: "#761 mergeado" },
	];
	let n = 0;
	const M = (o) => ({ id: `m${++n}`, status: "done", to: [], ...o });
	const filler = [
		["owner", ["designer"], "Antes de rediseñar, mirá cómo se usa hoy Project Chat en el teléfono."],
		["designer", ["owner"], "Hecho: 6 capturas a 390 px. El mismo mensaje aparece en Project Chat y en el chat individual; en el teléfono eso duplica lo que hay que revisar."],
		["owner", ["designer"], "¿Y la barra lateral?"],
		["designer", ["owner"], "Mezcla tres árboles (proyectos, agentes sin proyecto, sesiones). Para encontrar a quién le toca responder hay que abrir cada agente."],
		["owner", ["designer", "developer"], "Quiero que el equipo sea del proyecto, no de cada pantalla."],
		["developer", ["owner"], "Técnicamente ya es así: `acp_agents.project_id`. Lo que no existe es el tema: el alcance de un mensaje es el proyecto entero."],
		["designer", ["owner"], "Entonces la unidad nueva es la conversación: un tema dentro del proyecto, con el equipo compartido."],
		["owner", ["designer"], "Bien. ¿Y Files/Git/Terminal?"],
		["designer", ["owner"], "Quedan como herramientas del entorno de cada agente: elegís agente → workspace → herramienta. No dependen del chat."],
	];
	const messages = [];
	filler.forEach(([from, to, body], i) => messages.push(M({ conv: "ui", from, to, body, t: `09:${String(10 + i * 3).padStart(2, "0")}` })));
	messages.push(
		M({ conv: "ui", from: "owner", to: ["designer", "developer"], body: "Quiero un único sistema de chat por proyecto, con conversaciones independientes por tema. Proponé la navegación.", t: "10:02" }),
		M({ conv: "ui", from: "designer", to: ["owner"], body: "Propuesta: el proyecto es el espacio; a la izquierda conversaciones, equipo y trabajos; en el centro el tema abierto; las herramientas se abren en una vista propia y Volver te deja donde estabas.", t: "10:09", work: "ui-tokens" }),
		M({ id: "c1", conv: "ui", from: "designer", to: ["developer"], kind: "consult", body: "¿El composer actual admite varios destinatarios como lista, o hay que cambiar el modelo?", t: "10:11" }),
		M({ conv: "ui", from: "developer", to: ["designer"], kind: "reply", replyTo: "c1", body: "Ya es una lista (`recipients[]`, una fila por destinatario bajo un mismo `client_id`). Falta solo la opción «todo el equipo».", t: "10:14" }),
		M({ conv: "ui", from: "system", body: "@qa se sumó a este tema (mencionado por @designer).", t: "10:15" }),
		M({ id: "q-ui-run", conv: "ui", from: "owner", to: ["designer"], body: "Prepará un prototipo navegable con datos simulados.", t: "10:20", status: "running", activity: "Editando design/3a/proto.css · 4 min" }),
		M({ conv: "ui", from: "owner", to: ["architect", "developer", "designer", "qa"], team: true, body: "Mañana reviso el prototipo con ustedes: anoten acá lo que los bloquee.", t: "10:22",
			rs: { architect: "pending", developer: "pending", designer: "pending", qa: "done" } }),
		M({ conv: "ui", from: "qa", to: ["owner"], body: "Sin bloqueos de mi lado; preparo los criterios de aceptación cuando esté la propuesta.", t: "10:23" }),
		M({ id: "q-ui-dev", conv: "ui", from: "owner", to: ["developer"], body: "Cuando puedas: ¿cuánto cuesta reanudar una sesión ACP que estuvo inactiva?", t: "10:24", status: "pending" }),

		M({ conv: "ci", from: "owner", to: ["qa", "developer"], body: "El job de e2e tarda 14 minutos. Quiero bajarlo sin perder cobertura.", t: "08:40" }),
		M({ conv: "ci", from: "qa", to: ["owner"], body: "Medí 5 corridas: 6 min son instalación de navegadores y `vite build` repetido por shard. Propongo caché de Playwright y un build compartido.", t: "08:58" }),
		M({ conv: "ci", from: "owner", to: ["developer"], body: "Implementalo en un trabajo aparte.", t: "09:01" }),
		M({ conv: "ci", from: "developer", to: ["owner"], body: "Abrí el trabajo `ci-cache` (rama work/ci-cache, base main@3bda155).", t: "09:03", work: "ci-cache" }),
		M({ id: "ci-run", conv: "ci", from: "owner", to: ["developer"], body: "Seguí con el build compartido y avisá a @qa cuando esté para medir.", t: "09:40", status: "running", work: "ci-cache", activity: "npm run test:e2e · 212/318 · 6 min" }),
		M({ id: "c2", conv: "ci", from: "qa", to: ["developer"], kind: "consult", body: "Cuando termines, pasame el SHA para medir 3 corridas contra main.", t: "09:52", status: "pending" }),
		M({ id: "ci-unc", conv: "ci", from: "owner", to: ["qa"], body: "Medí también la variante sin shards.", t: "09:55", status: "uncertain",
			cut: { at: "09:57", why: "se reinició el runner de @qa", last: "Bash · npm run test:e2e -- --shard=1/1 (sin resultado)" } }),
		M({ conv: "ci", from: "qa", to: ["owner"], kind: "report", reportFor: "ci-unc", body: "Informe de la interrupción (solo lectura): llegué a lanzar 1 corrida sin shards, que quedó a la mitad. No hice commits ni cambié archivos; quedó un proceso de Playwright que ya no corre.", t: "09:58" }),

		M({ conv: "be", from: "owner", to: ["architect"], body: "Diseñá sesiones ACP por agente y conversación, abiertas bajo demanda, sin un worktree por chat.", t: "09:15" }),
		M({ id: "c3", conv: "be", from: "architect", to: ["developer"], kind: "consult", body: "¿Abrir la sesión ACP por tema rompe la afinidad de slots de #756?", t: "09:20" }),
		M({ conv: "be", from: "owner", to: ["architect"], body: "Considerá también qué pasa con los trabajos abiertos.", t: "09:31" }),
		M({ id: "c3r", conv: "be", from: "developer", to: ["architect"], kind: "reply", replyTo: "c3", body: "No la rompe: la afinidad sigue siendo por contexto y el tema pasa a ser un contexto más. Cambia solo la clave.", t: "09:47" }),
		M({ conv: "be", from: "system", kind: "late", body: "", link: "c3r", ref: { who: "developer", of: "architect", at: "09:20" }, t: "09:47" }),
		M({ conv: "be", from: "architect", to: ["owner"], body: "Esquema listo: la sesión es (agente, conversación); se reanuda al llegar un mensaje y se libera inactiva. Me falta una decisión tuya.", t: "09:48" }),
		M({ id: "qst", conv: "be", from: "architect", to: ["owner"], kind: "question", body: "¿Cuándo liberamos una sesión inactiva?", options: ["A los 10 min sin mensajes", "Solo al llegar al tope de slots", "Lo hablamos"], t: "09:49", status: "open" }),

		M({ conv: "res", from: "owner", to: ["architect"], body: "Investigá cómo organizar equipos, chats múltiples y seguimiento de trabajos.", t: "08:05" }),
		M({ id: "res-new", conv: "res", from: "architect", to: ["owner"], kind: "result", body: "Informe listo. Recomiendo: proyecto → conversaciones; una bandeja «Te esperan»; trabajos con 4 estados visibles. Detalle en docs/research/780.md.", t: "10:31", unseen: true }),

		M({ conv: "hz1", from: "owner", to: ["arq"], body: "Armá el plan de diciembre con 3 evaluaciones.", t: "Ayer" }),
		M({ id: "hz-q", conv: "hz1", from: "arq", to: ["owner"], kind: "question", body: "¿La evaluación final es oral o escrita?", options: ["Oral", "Escrita"], t: "10:12", status: "open" }),
		M({ conv: "hz2", from: "owner", to: ["dev"], body: "Generá 20 ejercicios de fracciones.", t: "Ayer" }),
		M({ conv: "hz2", from: "dev", to: ["owner"], body: "Listos los 20, con soluciones.", t: "Ayer" }),

		M({ conv: "arch-dev", from: "owner", to: ["developer"], body: "Revisá el PR #728.", t: "21/11" }),
		M({ conv: "arch-dev", from: "developer", to: ["owner"], body: "Revisado y corregido: los tres puntos de #687.", t: "21/11" }),
		M({ conv: "arch-arc", from: "owner", to: ["architect"], body: "Plan de simplificación.", t: "20/11" }),
		M({ conv: "arch-arc", from: "architect", to: ["owner"], body: "Programa #649 con P1–P6 en integration/simplify.", t: "20/11" }),
		M({ conv: "arch-pc", from: "owner", to: ["architect", "developer", "designer", "qa"], body: "Pueden borrar sus worktrees viejos.", t: "23/11" }),
		M({ conv: "arch-pc", from: "designer", to: ["owner"], body: "No tenía worktrees viejos: solo queda el principal.", t: "23/11" }),
	);

	const tree = {
		main: [
			["d", ".github/"], ["d", "backend/"], ["d", "frontend/"], ["d", "docs/"], ["f", "CLAUDE.md"], ["f", "README.md"], ["f", "package.json"],
		],
		"ci-cache": [
			["d", ".github/", "M"], ["d", "backend/"], ["d", "frontend/", "M"], ["d", "docs/"], ["f", "CLAUDE.md"], ["f", "README.md"], ["f", "package.json"],
		],
	};
	const changes = {
		main: [],
		"ci-cache": [
			{ path: ".github/workflows/ci.yml", st: "M", add: 12, del: 3 },
			{ path: "frontend/playwright.config.ts", st: "M", add: 4, del: 1 },
		],
	};
	return { agents, projects, convs, works, messages, tree, changes };
})();
