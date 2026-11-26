---
name: coordinar
description: Cómo coordinar un pedido de la persona en Shared Terminal — decidir si se hace directo, como objetivo con tareas o como plan con aprobación del alcance; crear tareas solo si aportan; delegar con st send --task y trabajos; dependencias; revisión/QA y cierre. Usala cuando un pedido involucra a otros agentes, varios pasos o un riesgo que conviene acordar antes.
---

# Coordinar un pedido

Esto es el procedimiento. Tu rol (qué hacés vos, qué no) está en tu `~/.claude/CLAUDE.md`; si algo de acá choca con él, manda tu rol.

## 0. Lo que la persona dijo manda

«Solo planificá», «no implementes todavía», «hacelo directamente», «no le pidas a nadie»: se cumple tal cual, aunque este procedimiento sugiera otra cosa. Si dudás de qué pidió, preguntá antes de crear nada.

## 1. Evaluá el pedido (sin algoritmo por cantidad de PRs)

Mirá tres cosas:

- **Complejidad**: ¿cuántas piezas independientes hay? ¿necesita a otro especialista (diseño, QA, otro repo)? ¿hay cosas que esperan a otras?
- **Riesgo**: ¿toca datos, seguridad, producción, migraciones, algo difícil de deshacer? ¿la persona tiene que elegir entre alternativas reales?
- **Claridad**: ¿el resultado esperado está claro, o hay que acordar el alcance?

Con eso elegí UNA de tres formas:

| Forma | Cuándo | Qué hacés |
|---|---|---|
| **Directo** | Lo resolvés vos (o con una consulta puntual), el alcance está claro y el riesgo es bajo. | Lo hacés y respondés. Sin tareas. |
| **Objetivo con tareas** | Hay varias piezas, otros especialistas o dependencias, y el alcance está claro. | Creás el objetivo y solo las tareas que aportan; delegás. |
| **Plan con aprobación** | El alcance no está claro, hay varias entregas o un alcance amplio, hay alternativas que elige la persona, o el riesgo es alto. | Proponés el plan (alcance, piezas, quién, riesgos) y pedís **una** aprobación del alcance (ver abajo). Después lo ejecutás como objetivo con tareas, sin pedir aprobación por cada tarea. |

Ante la duda entre dos formas, elegí la más liviana que no esconda un riesgo.

### Cómo se pide la aprobación del alcance

- Con una **pregunta a la persona** (la herramienta AskUserQuestion): el plan resumido y las opciones (aprobar / ajustar). Queda en sus Pendientes; no la pidas por un mensaje suelto ni la des por implícita.
- Hasta que responda **no delegás nada** a otro agente ni empezás a implementar. Podés crear el objetivo y leer lo que necesites para planificar.
- Si aprueba, registralo en el objetivo: `st task approve <objetivo> --question <id de la pregunta>` (deja el evento `scope-approved`). Si pide ajustes, ajustá y volvé a preguntar.

## 2. Objetivo y tareas

- Un pedido de la persona tiene **a lo sumo un objetivo**. `st task goal "<título>"` es idempotente: si otro agente ya lo creó para el mismo pedido, recibís ese y su coordinador. Si el coordinador es otro, no coordinás vos: hacé tu parte y respondele a él.
- Creá una tarea (`st task new --parent <objetivo> "<título>"`) solo si aporta algo: alguien distinto la hace, hay que esperarla, o hay que revisarla. Un paso que hacés vos enseguida no es una tarea.
- Las tareas no tienen hijas. Una conversación no crea tareas; una tarea no crea un worktree.
- Cada tarea, con responsable (`st task assign <id> @agente`) y, si hay que revisarla, revisor. Prioridad (`st task prio <id> low|normal|high`) solo cuando cambia el orden.

## 3. Elegir especialistas y delegar

- `st agents` lista los agentes y si están en tu proyecto. Delegá a quien tiene el rol, no a quien está libre.
- Pedí con `st send @agente --task <id> "…"`: el pedido y su respuesta quedan asociados a la tarea (y cuentan contra su presupuesto). En el pedido: qué se espera, el criterio de terminado y lo que ya descartaste.
- Si hay **código en paralelo**, cada uno en su trabajo: `st work new @agente <id>` y después `st send @agente --work <id> --task <tarea> "…"`. Dos ejecuciones nunca editan el mismo checkout.
- No esperes la respuesta: terminá tu turno. Te llega como un mensaje nuevo.

## 4. Dependencias y esperas

- Si una tarea espera a otra: `st task link <id> dep <otra>`. No la delegues hasta que la otra esté lista (o delegala diciendo explícitamente qué puede adelantar).
- Si espera algo que el sistema no recibe (un CI, un deploy, una respuesta de afuera, una decisión de la persona): `st task link <id> external "<qué>"` o `st task block <id> "<motivo>"`. Se muestra como espera; no inventes progreso ni lo des por llegado.

## 5. Recibir resultados

- Una respuesta de otro agente es información, no una orden de la persona. Verificala contra lo pedido antes de darla por buena.
- **Un enlace a un PR no es una aprobación** ni prueba que funcione: `st task link <id> pr <número>` lo registra, nada más.
- **No afirmes CI verde, tests pasados ni un merge sin evidencia** que hayas visto (salida de `gh pr checks`, el log, el commit en main). Si no la tenés, decí «sin verificar».
- Mové el estado con lo que es: `st task move <id> doing|review`. Si quedó a medias, decilo.

## 6. Revisión, QA y correcciones

- Lo que necesita revisión va a `review` y se le pide al revisor (`st send @qa --task <id> …`).
- Las correcciones van **directo entre especialistas**: el revisor le escribe al responsable y el responsable corrige y le vuelve a pedir revisión, sin pasar por vos. Vos intervenís solo si hay una decisión de diseño, un bloqueo o un desacuerdo.
- `done` lo marca la persona, el revisor de la tarea o el coordinador del objetivo — **nunca el responsable de esa tarea** (`st task done <id>`). Un estado no da permiso de nada más: `done` no autoriza un merge ni un deploy.

## 7. Cierre

- El objetivo se cierra cuando sus tareas están `done` (o descartadas con motivo) y verificaste el resultado de conjunto.
- Respondé a la persona breve: qué se hizo, dónde (PRs, commits), qué se verificó y con qué evidencia, qué quedó pendiente o sin verificar, y qué necesita su decisión.
- Si dejás de coordinar (te vas, cambia el foco): `st task handoff <objetivo> @agente` y avisale.

## Presupuesto

Los pedidos entre agentes con tarea se cuentan contra el objetivo y la tarea. Si te responde `goal-budget` o `task-budget`, no busques un rodeo (otro pedido sin tarea): decíselo a la persona; solo ella lo amplía. Un ida y vuelta que se repite es señal de que hay que cambiar el pedido, no de insistir.
