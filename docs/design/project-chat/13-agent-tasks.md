# Project Chat — tareas independientes por agente (propuesta de diseño, sin implementar)

Estado: **propuesta, 2026-11-06. Sólo diseño.** No hay backend, UI ni migraciones de tareas, y nada
de esto se implementa sin la aprobación de las decisiones de §8. Cambia un no-objetivo del RFC
(«tareas tipo Jira», 02 §2) **sólo en lo que dice §1**: no es un Jira, y no amplía G3-2, que sigue en
NO-GO. Los gates de Channels (G1–G12, G3, PASS-A/PASS-B, R8) no cambian. Los que siguen siendo
obligatorios están en §9.

Referencias: [01-vision.md](./01-vision.md) §5, [02-architecture-rfc.md](./02-architecture-rfc.md)
§2, §5.4–§5.6 y §9, [03-protocol.md](./03-protocol.md) §1, §3, §3.1, §7 y §9,
[05-roadmap.md](./05-roadmap.md), [10-g3-sender-identity.md](./10-g3-sender-identity.md).

## 0. Regla fundamental y ejemplo

**Un agente no interrumpe un trabajo no relacionado cuando recibe una instrucción nueva.**

Claude A está ejecutando T-101. B necesita un preflight de VM100:

| Acción de B | Qué pasa | Qué **no** pasa |
| --- | --- | --- |
| `CREATE` T-102 para A | T-102 queda `queued` en la cola de A | nada llega a la conversación de A; T-101 sigue |
| `UPDATE T-102` | se reescribe la definición guardada de T-102 (versión +1) | A no se entera: T-102 todavía no empezó |
| `CHANGE T-101` | se registra un pedido de cambio **de T-101**; se entrega a A en un punto seguro | ninguna escritura en el Terminal; T-102 no se toca |
| `STOP T-101` | se registra un pedido de detener **sólo T-101**; A lo toma en un punto seguro y deja su estado recuperable | no se detiene la sesión Docker, el proceso `claude` ni otra tarea |

## 1. Qué es y qué no es una tarea

Una **tarea** es una unidad de trabajo **direccionable** asignada a un agente: tiene identidad
estable, un único asignado, un creador, un estado, una versión y una definición (texto). Sirve para
que las instrucciones digan **a qué trabajo** se refieren y para que trabajo nuevo **espere** en vez
de mezclarse con el que está en curso.

No es un gestor de proyectos: no hay tableros, prioridades, estimaciones, fechas, dependencias,
subtareas, etiquetas ni flujos configurables (lista completa en §7).

La propuesta tiene tres capas, que se aprueban y se implementan por separado:

| Capa | Contenido | Depende de |
| --- | --- | --- |
| **A — contrato mínimo** (§2) | identidad, direccionamiento, estados, versiones, idempotencia, los tres niveles de confirmación | sólo de esta aprobación; se fija como texto |
| **B — cola y ejecución** (§3, §5, §6) | cola persistente, despacho, puntos seguros, `CHANGE`/`STOP` de tareas activas, recuperación; tareas creadas por el owner | GO de Channels (P6 del roadmap) y gates TG1–TG4 |
| **C — instrucciones de agentes** (§4) | un agente crea o pide cambiar/detener tareas de otro, siempre con aprobación humana | capa B **y** GO de G3-2 (hoy NO-GO) |

## 2. Contrato mínimo de identidad y direccionamiento (capa A)

Es lo único que esta propuesta pide fijar ahora, como texto. No depende de Channels ni de G3-2.

### 2.1 Identidades

| Id | Formato | Lo asigna | Estable en… |
| --- | --- | --- | --- |
| `task_id` | UUID v4 | backend en `CREATE` | la vida de la tarea; **es la identidad** |
| `task_key` | `T-<n>`, `n` entero por proyecto, nunca reutilizado | backend en `CREATE` | la vida de la tarea; alias legible, nunca la identidad en el protocolo |
| `assignee_agent_id` | `agent_id` (03 §1) | creador | la vida de la tarea: **no se reasigna** en v1 (reasignar = `STOP`/cancelar y crear otra) |
| `creator` | `user:<id>` \| `agent:<agent_id>` | backend, del principal autenticado | siempre; nunca sale del cuerpo |
| `rev` | entero, +1 en **cada** transición de estado o de definición | backend | hasta la siguiente transición |
| `version` | entero, +1 sólo cuando cambia la **definición** | backend | hasta el siguiente cambio aplicado |
| `instruction_id` | UUID v4 | backend al recibir una instrucción | siempre |
| `client_instruction_id` | UUID v4 | quien emite (UI o `st-channel`) | un intento de emitir **esa** instrucción |
| `attempt_id` | UUID v4 | backend en cada despacho | un despacho de la tarea a un runtime |

### 2.2 Sobre de una instrucción

```jsonc
{
  "verb": "CREATE | UPDATE | CHANGE | STOP",
  "task_id": "…",            // obligatorio salvo en CREATE
  "assignee_agent_id": "…",  // sólo en CREATE
  "if_rev": 7,               // obligatorio salvo en CREATE
  "definition": "…",         // CREATE, UPDATE, CHANGE (≤ 16 KiB, como M1)
  "reason": "…",             // STOP, opcional, ≤ 500
  "client_instruction_id": "…"
}
```

Reglas (*MUST* cuando se vuelva contrato):

1. **Toda instrucción nombra su tarea por `task_id`.** No existe «la tarea actual» implícita. El
   servidor **nunca** interpreta `STOP` o `T-101` escritos en el texto de un mensaje, igual que nunca
   lee menciones del texto (R11).
2. **Verbo y estado tienen que coincidir.** `UPDATE` sólo vale sobre una tarea que todavía no empezó
   (`queued`, `awaiting_approval`); `CHANGE` sólo sobre una activa. Si la tarea cambió de estado entre
   que el emisor la leyó y su instrucción llegó, la respuesta es 409 (`task-active` o
   `task-not-active`) y el emisor decide de nuevo. Así un `UPDATE` pensado para trabajo pendiente nunca
   se convierte en silencio en un cambio de trabajo en curso.
3. **`if_rev` es un CAS.** Si no coincide con `rev` ⇒ 409 `stale-rev` con el `rev` y el estado
   actuales. Nada se aplica sobre una lectura vieja.
4. **Idempotencia por (`creator`, `client_instruction_id`).** El mismo id con el mismo cuerpo repite la
   respuesta guardada; con otro cuerpo ⇒ 409 `idempotency-conflict`. Nunca se crea una tarea dos
   veces ni se aplica una instrucción dos veces.
5. **La autoría la estampa el backend** desde el principal autenticado (cookie del owner, o las tres
   comprobaciones de autorización de una sesión, 03 §6.2). Ningún campo del cuerpo aporta identidad.

### 2.3 Estados

```mermaid
stateDiagram-v2
  [*] --> awaiting_approval: CREATE por un agente
  [*] --> queued: CREATE por el owner
  awaiting_approval --> queued: aprobada
  awaiting_approval --> cancelled: rechazada / STOP
  queued --> cancelled: STOP
  queued --> dispatching: despacho (capa B)
  dispatching --> active: aceptación verificada (channel_prompt con task_id)
  dispatching --> dispatch_uncertain: sin evidencia
  dispatch_uncertain --> queued: evidencia de que no se tomó + decisión humana
  active --> completed: informe del agente + turn_end
  active --> stopped: STOP confirmado (§3.5)
  active --> interrupted: el runtime terminó sin informe
  active --> failed: informe de fallo del agente
```

Terminales: `completed`, `stopped`, `cancelled`, `failed`, `interrupted`. `stopped` e `interrupted`
conservan el workspace y el último informe del agente: son recuperables a mano, nunca se reanudan
solos (§7).

Los pedidos sobre una tarea activa **no** son estados de la tarea: son instrucciones con su propio
estado (§2.4). Una tarea `active` con un `STOP` pedido sigue `active` hasta que haya evidencia.

### 2.4 Tres confirmaciones distintas

| Nivel | Significa | Lo produce |
| --- | --- | --- |
| **recibida** | la instrucción está persistida, con `instruction_id` | backend: 202 con `{instruction_id, task_id, rev}` |
| **aplicada** | sobre una tarea pendiente: la definición guardada cambió (`version` +1) o la tarea quedó `cancelled`. Sobre una activa: el **agente** acusó la instrucción con `task_ack(instruction_id, version)` | pendiente: backend (CAS, inmediato). Activa: evidencia del contenedor del agente |
| **detenida** | sólo para `STOP` sobre una activa: el trabajo de esa tarea terminó | evidencia de §3.5; nunca un plazo vencido |

Estado de cada instrucción: `received` → `waiting_safe_point` → `delivered` → `acknowledged` |
`refused{…}` | `superseded{…}`; o `applied` directo en una tarea pendiente; o `rejected{…}` (409/403)
sin efecto. La UI muestra los tres niveles por separado: «STOP recibido», «STOP aceptado por A»,
«T-101 detenida».

## 3. Cola y ejecución (capa B: futura, depende del GO de Channels)

### 3.1 Cola persistente

- Cada agente tiene una cola FIFO de tareas `queued`. Una tarea nueva **nunca** se inserta en la
  conversación activa: espera.
- **Una tarea activa por agente** en v1 (decisión TD2). El CLI interactivo procesa un turno por vez, y
  dos tareas activas en el mismo proceso mezclarían contexto y atribución.
- **Despacho:** la siguiente tarea `queued` se presta como una entrega más del monitor (03 §3), con
  `task_id`, `attempt_id` y `version` en la `meta`, sólo si se cumplen **todas** las condiciones de
  RFC §5.5 **y** el agente no tiene ninguna tarea `active` ni `dispatching`/`dispatch_uncertain`. El
  contenido entregado es la definición en esa `version`; un `UPDATE` posterior ya no la alcanza
  (regla 2 de §2.2).
- El despacho usa las mismas reglas de entrega: sin reintentos automáticos. Sin `channel_prompt` ⇒
  `dispatch_uncertain`, y la cola del agente **queda frenada** (no se presta la siguiente) hasta que
  haya evidencia o decida la persona.

### 3.2 Puntos seguros

Un cambio o una detención de una tarea activa se aplican **sólo** en un punto seguro, y lo aplica el
agente, no el backend:

| Punto seguro | Cuándo | Cómo llega la instrucción |
| --- | --- | --- |
| **SP1 — fin de turno** | el agente está en su prompt con identidad verificada (RFC §5.5 condición 2) y no hay otra entrega en vuelo | el monitor presta una **entrega de control** con `task_id`, `instruction_id`, `verb` y `version`, por el mismo camino que cualquier mensaje |
| **SP2 — checkpoint del agente** | dentro de un turno largo, cuando el agente llama a la herramienta MCP `task_checkpoint(task_id)` de `st-channel` entre dos pasos | el resultado de la herramienta trae las instrucciones pendientes de **esa** tarea |

Nunca, en ningún caso: `tmux send-keys`, Escape o Ctrl-C, señales a procesos, `docker stop`/`kill`,
reiniciar el CLI, recrear el contenedor ni el Composer. Si el agente no llega a un punto seguro, la
instrucción queda `waiting_safe_point` y la UI muestra su antigüedad. La salida de emergencia es la de
hoy y es **humana**: la persona abre el Terminal o el Control Directo. Eso queda fuera del contrato de
tareas, y si la persona lo hace la tarea no pasa a `stopped` por eso (§3.5).

### 3.3 `CHANGE` sobre una tarea activa

1. `received` con `if_rev`; a lo sumo **un** `CHANGE` sin resolver por tarea (otro ⇒ 409
   `change-pending`; el emisor puede retirarlo y mandar uno nuevo).
2. En SP1 o SP2 el agente recibe la definición nueva marcada como **cambio de T-101 a la versión
   v+1**, no como una tarea nueva.
3. El agente responde `task_ack(instruction_id, applied, version: v+1)` o
   `task_ack(instruction_id, refused, reason)`. Sólo con `applied` la tarea pasa a `version` v+1.
4. Un `STOP` posterior deja el `CHANGE` en `superseded{stop}`.

### 3.4 `STOP` sobre una tarea activa

1. `received`; desde ese momento la tarea no recibe más `CHANGE`.
2. En SP1 o SP2 el agente recibe «detener T-101». Lo esperado del agente (instrucciones del adaptador,
   su CLAUDE.md): dejar el trabajo en un estado recuperable (nada a medio escribir que rompa el
   workspace; nada se borra) y publicar `task_report(task_id, stopped, summary)`, con lo hecho y lo
   que falta.
3. `task_ack(instruction_id, acknowledged)` sólo dice «lo voy a detener». No es la confirmación.

### 3.5 Qué cuenta como «efectivamente detenida»

Una tarea pasa a `stopped` sólo con las tres cosas, persistidas:

1. un `task_report{stopped}` del `attempt_id` vigente;
2. el `turn_end` del turno que lo contiene, sin otra entrada que haya compartido ese turno (las mismas
   condiciones de atribución de 03 §3.1);
3. después, el agente en su prompt con identidad verificada (probe), sin entrega de esa tarea en vuelo.

Es «lo que reporta el contenedor del agente», con la misma consecuencia aceptada que 03 §7. Si el
runtime muere antes, la tarea pasa a `interrupted` y el `STOP` a `superseded{runtime-retired}`: **un
STOP pedido nunca se convierte en un STOP confirmado** por un plazo, un reinicio o una intervención
manual.

### 3.6 Informes del agente

Herramientas MCP de `st-channel` (además de las de 03 §6.3), todas con `client_instruction_id` y
siempre sobre el `attempt_id` vigente; la de un intento anterior se registra y no cambia nada:

| Herramienta | Uso |
| --- | --- |
| `task_checkpoint(task_id)` | SP2: devuelve las instrucciones pendientes de esa tarea |
| `task_ack(instruction_id, applied\|refused\|acknowledged, version?, reason?)` | acusar una instrucción |
| `task_report(task_id, completed\|stopped\|failed, summary)` | fin del trabajo de la tarea |

Un agente sólo informa sobre **sus** tareas (asignado = su `agent_id`).

## 4. Permisos

| Actor | Puede | No puede |
| --- | --- | --- |
| Owner | todo: crear, aprobar, rechazar, `UPDATE`, `CHANGE`, `STOP`, frenar o liberar la cola de un agente | reasignar una tarea activa (v1) |
| Agente creador (capa C) | `CREATE` para **otro** agente del mismo proyecto ⇒ siempre `awaiting_approval`; `UPDATE` de lo que creó mientras no empezó (si ya estaba aprobada, vuelve a `awaiting_approval`); **pedir** `CHANGE`/`STOP` de lo que creó, que también esperan aprobación humana | tocar tareas que no creó; crear tareas para sí mismo; saltar la aprobación |
| Agente asignado | `task_checkpoint`, `task_ack` y `task_report` de sus tareas | cambiar su definición, reasignarla, crear tareas sin aprobación |
| Admin / lead | nada (R5) | — |

- Una tarea **no** otorga permisos. Su texto no autoriza un deploy ni ninguna acción sensible: esas
  siguen necesitando la aprobación humana de siempre, fuera del sistema de tareas, aunque la tarea
  diga «desplegá».
- Las instrucciones emitidas por un agente dependen de la autenticidad del emisor: **están bloqueadas
  mientras G3-2 esté en NO-GO.** Esta propuesta no la amplía ni la adelanta.

## 5. Concurrencia

- **Escritor único:** el backend, bajo un candado por proyecto en el proceso, como el log de la
  conversación anfitriona. Toda transición es CAS sobre `rev` dentro del candado, después del fsync.
- **Carreras resueltas por la regla 2 de §2.2:** `UPDATE` contra despacho (gana uno; si gana el
  despacho, el `UPDATE` es 409 `task-active`), `STOP` contra despacho (si gana el `STOP`, la tarea
  queda `cancelled` y no se presta), `CHANGE` contra `task_report{completed}` (el `CHANGE` queda
  `superseded{completed}`).
- **Intentos:** cada despacho tiene su `attempt_id`; acks e informes de un intento anterior no cambian
  estados.
- **Mensajes libres con una tarea activa:** se entregan sólo en SP1, como hoy, y el turno que procesan
  queda **fuera** de la tarea. Si comparten turno con trabajo de la tarea, ese turno queda
  `ended_unattributed{mixed-input}` (03 §3.1). La UI avisa antes de enviar (decisión TD8).

## 6. Persistencia y recuperación

- **Almacén** (recomendado, TD7): un log append-only por proyecto,
  `<WORKSPACE_ROOT>/.projects/<project_id>/tasks.events.jsonl`, más un snapshot atómico del índice
  (tareas, `rev`, cola, ventana de `client_instruction_id`), con el formato y el fsync de
  `conversation/store.ts` y `paneRecord.ts`. Sin tabla D1 en el MVP: un solo almacén, sin divergencia
  D1/log que reconciliar, y el texto de las tareas (que es contenido) nunca entra en D1.
- **Reinicio del backend:** el índice se reconstruye desde el log. Nada desaparece. Despachos y
  entregas de control en vuelo ⇒ `uncertain{orphaned}` por las reglas de 03 §9; nunca se represtan
  solos. Una instrucción `received`/`waiting_safe_point` sigue igual. Un `STOP` pedido sigue pedido:
  la confirmación exige evidencia **nueva** de §3.5. La ventana de idempotencia está en el snapshot,
  así que un reintento del cliente después del reinicio repite la respuesta y no duplica nada.
- **Reinicio del agente** (salida del CLI, parada o recreación del contenedor): la tarea activa pasa a
  `interrupted` y su `STOP` pendiente, si había, a `superseded{runtime-retired}`. Las tareas `queued`
  siguen en la cola. La siguiente se presta sólo cuando la persona libera la cola (un `interrupted`
  frena la cola como un `dispatch_uncertain`).
- **Log ilegible:** el proyecto queda `tasks-unverifiable`: no se despacha ni se acepta ninguna
  instrucción (409) y nada se infiere sin el archivo.

## 7. Fuera del MVP (expresamente)

Tableros, prioridades, estimaciones, fechas límite, SLAs, etiquetas, búsqueda; dependencias entre
tareas y subtareas; flujos o estados configurables; tareas asignadas a humanos o a varios agentes;
reasignar una tarea activa; varias tareas activas por agente; **reanudar** una tarea `stopped` o
`interrupted` (en v1 se crea otra tarea que la referencia en el texto); reintentos o redespachos
automáticos; interrupción forzada de un turno; tareas entre proyectos; comentarios, adjuntos y
notificaciones push propias; permisos por tarea más allá de owner/creador/asignado; integración con
Jira, Linear o GitHub Issues; agentes que crean tareas sin aprobación humana.

## 8. Decisiones que requieren aprobación del responsable

| # | Decisión | Recomendación |
| --- | --- | --- |
| TD1 | Reemplazar el no-objetivo «tareas tipo Jira» por «tareas direccionables mínimas (§1), sin gestión de proyectos (§7)» en 01 y 02 | sí, con el límite de §7 |
| TD2 | Una tarea activa por agente en v1 | sí |
| TD3 | Despacho: automático FIFO cuando el agente está libre (tareas del owner o aprobadas), con un control «frenar cola» por agente; alternativa: siempre manual («Iniciar») | automático con freno, y la cola se frena sola ante `dispatch_uncertain` o `interrupted` |
| TD4 | Toda tarea creada por un agente, y todo `CHANGE`/`STOP` que un agente pida, requieren aprobación humana; sin aristas `allow` para tareas en v1 | sí (coherente con R4/R13); además, bloqueado hasta el GO de G3-2 |
| TD5 | Puntos seguros = SP1 (fin de turno) + SP2 (`task_checkpoint`); ninguna interrupción forzada; la vía manual (Terminal) queda fuera del contrato | sí |
| TD6 | Definición de «detenida» de §3.5 (informe + `turn_end` limpio + prompt verificado), aceptando que es lo que reporta el contenedor | sí |
| TD7 | Almacén: log por proyecto + snapshot, sin tabla D1 en el MVP | sí; una tabla D1 sólo si hace falta listar tareas entre proyectos |
| TD8 | Mensajes libres al agente con una tarea activa: permitidos sólo en SP1, fuera de la tarea, con aviso en la UI; alternativa: exigir elegir «como `CHANGE` de T-101» o «como tarea nueva» | permitidos con aviso |
| TD9 | `task_key` = `T-<n>` por proyecto, nunca reutilizado | sí |
| TD10 | El Composer/Control Directo no es un canal de instrucciones de tareas; un envío manual durante una tarea activa es un mensaje libre (TD8) | sí |
| TD11 | Reanudar `stopped`/`interrupted` queda fuera del MVP | sí |

## 9. Gates de la POC que siguen siendo obligatorios

Ninguno se relaja por esta propuesta:

- **G1–G12 de Channels** y la POC completa con su GO separado: todo despacho y toda entrega de control
  es una entrega del monitor.
- **G3** (evidencia de aceptación, `channel_prompt`): `active` exige el `channel_prompt` del despacho.
- **R8 y 03 §3.1** (atribución): `completed` y `stopped` exigen un `turn_end` atribuible.
- **PASS-A/PASS-B** para la integridad hasta el backend.
- **G3-2** (autenticidad del emisor entre agentes): toda instrucción emitida por un agente. Sigue en
  NO-GO.

Gates **nuevos** que la propuesta agrega a la POC (sin ejecutar; necesitan su propia autorización):

| # | Hipótesis | PASS |
| --- | --- | --- |
| TG1 | Una herramienta MCP de `st-channel` llamada **dentro** de un turno largo devuelve instrucciones nuevas (SP2) | el resultado llega en el mismo turno y el agente lo acusa con `task_ack` |
| TG2 | Una entrega de control en SP1 se distingue de una tarea nueva y el agente la aplica a la tarea correcta | `task_ack` con el `instruction_id` y la `version` correctos, sin efectos sobre otra tarea |
| TG3 | Un `STOP` en SP2 termina el turno con un informe y deja el agente en su prompt | las tres condiciones de §3.5, con el proceso `claude` y el contenedor intactos |
| TG4 | Reinicio del backend y salida del CLI con un `STOP` pedido | ninguna tarea perdida, ninguna instrucción aplicada dos veces, ningún `STOP` confirmado sin evidencia nueva |

Si TG1 falla, SP2 se cae y sólo queda SP1: un `CHANGE`/`STOP` de una tarea en un turno largo espera
al fin del turno. Es una degradación aceptable, no un NO-GO de la propuesta.
