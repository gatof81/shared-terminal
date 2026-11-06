# Project Chat — alineación de arquitectura y UX (#512 ↔ #554) y contrato backend/frontend

Estado: **revisión y propuesta, 2026-11-06. Nada implementado ni autorizado.** Contrasta la propuesta
UX de Claude A (PR draft #554, `docs/design/ux-projects-agents.md` en `ab00778`) con la arquitectura de
este directorio:

- 02 (RFC), 03 (protocolo, con `agent_bindings` desde `b7ea0e2`) y 05 (roadmap);
- 06 (UX de la conversación del agente);
- 13 (tareas: TD1–TD11 aprobadas como arquitectura);
- 14 (equipos: AD1–AD12 aprobadas como arquitectura).

No modifica #554 ni contratos aprobados. Lo que propone cambiar está marcado **(pendiente de
aprobación)**. G3-2 sigue en NO-GO y los gates de Channels, G3, PASS-A/PASS-B, R8 y TG1–TG5 no cambian.

## 0. Resumen

- **#554 y #512 comparten el modelo.**
  - Project, Agent y Session están separados, y un agente puede tener muchas sesiones.
  - Chat ≠ Task: un mensaje nunca crea una tarea ni autoriza nada.
  - Los verbos se dirigen a una tarea y la UI separa recibido, aplicado y detenido.
  - Los estados vienen con evidencia y antigüedad, y desconocido nunca se muestra como cero.
  - Las acciones visibles salen de `can` del servidor, y los deploys siempre requieren una persona.
  - Los enlaces `#/sessions/…` se conservan.
- **Hay cinco diferencias bloqueantes**, todas de contrato y no de dirección (§2):
  1. el conjunto de estados de tarea;
  2. el «Project Chat» como canal de proyecto con hilos;
  3. evidencias sin marca de «afirmada»;
  4. el rol que sale de una plantilla con permisos heredados;
  5. `members[]` en Project, contra owner-only.
- **Contrato propuesto** (§3): reusa las rutas de 03 §6.1 y agrega **cuatro** lecturas justificadas,
  más los verbos de tareas de 13. No agrega ningún WebSocket nuevo.
- **Próximo incremento** (§5):
  - ya permitido por los gates actuales: el contrato, *fixtures* para el mock del frontend y los
    refactors de solo frontend que A ya identificó;
  - **con una decisión tuya:** «P3a», el directorio de proyectos, agentes y vínculos detrás de una
    bandera, desacoplado de Channels.

## 1. Matriz de compatibilidad (los 10 puntos pedidos)

| # | Capacidad | #512 (arquitectura) | #554 (UX) | Veredicto |
| --- | --- | --- | --- | --- |
| 1 | Project como frontera de recursos y permisos | owner-only (R5); handles únicos; aristas e invitados sólo del mismo proyecto (R14, AD12) | Project con `members[]` (personas y roles), `policies`, `repos[]` | **B5**: `members[]` contradice owner-only. `repos`/`policies` = **F** |
| 2 | Agent independiente de Session | `project_agents` sin sesión + `agent_bindings` (AD1) | `currentSessionId`, `sessions[]` (historial), D-4 «vínculo explícito» | **compatible**; nombres a alinear (**C1**) |
| 3 | `agent_bindings` y cambios futuros de sesión | vínculo con `epoch`; `active`/`draining`/`retired`; cambio de vínculo no implementado (AD2) | eventos `session.attached`/`session.detached` | **compatible**; los eventos se llaman `binding.*` y llevan `bindingId`/`epoch` (**C1**) |
| 4 | Roles configurables, plantillas, varios agentes del mismo rol | rol = texto libre (AD3); plantilla copiada con versión, sin permisos heredados en vivo (AD4) | `roleTemplateId`; `RoleTemplate.defaultPermissions`; «los roles vienen de plantillas» | **B4**: el rol no puede depender de la plantilla ni heredar permisos |
| 5 | Chat, Task y Authorization separados | tres sobres: `message`, `work_request`, `authorization` (14 §4.1) | Chat ≠ Task; «crear tarea desde un mensaje» explícito; aprobación de deploy humana | **compatible** en principio; la aprobación de deploy es **D-UX5** (§4) |
| 6 | Tareas en cola sin interrumpir | cola `paused` por defecto, `auto` explícito con acreditación (TD3); `chat` retenido (TD8) | «queued» y una tarea activa; sin control de la cola | **C3**: falta mostrar el modo de la cola, la acreditación y los mensajes retenidos |
| 7 | Estados de entrega, ejecución, incertidumbre y recuperación | entregas (03 §3, 06 §3); tareas: 10 estados (13 §2.3); instrucciones: 8 estados (13 §2.4) | tareas: queued, active, blocked, interrupted, completed; instrucción con `receivedAt`/`appliedAt`/`stoppedAt` | **B1**: faltan `dispatch_uncertain`, `stopped`, `cancelled`, `failed`, `awaiting_approval`, y en el registro de instrucciones `refused`/`superseded`/`acknowledged`; `blocked` no existe |
| 8 | Permisos delegados futuros sin elevar privilegios | 13 §4.1: permiso del owner, acotado y revocable; nunca deploys | `permissions` (resumen), `can` por respuesta | **compatible**; `can` lleva el motivo (**C2**) |
| 9 | Agentes desconectados, ocupados, detenidos | elegibilidad (02 §5.5); el monitor nunca arranca contenedores | «working, waiting, blocked, disconnected» con evidencia; nada se inicia solo | **compatible**; falta `stopped` (sesión detenida) distinto de `disconnected` (**C4**) |
| 10 | Trazabilidad: tareas, mensajes, sesiones, commits, PRs, evidencias | `binding_id` en cada evidencia; `task_refs[]`; `evidence[]` con `verification: claimed` (14 §4.4) | `refs[]` tipados; el wireframe muestra «QA ✓» | **B3**: sin `verification`, la UI presentaría como verificado algo afirmado |

Otras coincidencias, sin acción:

| Tema | Coincidencia |
| --- | --- |
| Nombres | D-1, «Subagentes» para los del CLI. Se recomienda aceptarlo |
| Pertenencia | D-2, un agente en un solo proyecto: igual que AD12 |
| Vínculo | D-4, explícito y del owner, nunca inferido: igual que 14 §3.2 |
| Sesiones existentes | sin asignar, enlaces intactos, sin agrupar por nombre: igual que 14 §6 |
| Historial privado | chip opaco: compatible (owner-only lo hace casi siempre visible) |

## 2. Diferencias

### 2.1 Bloqueantes (antes de escribir contratos vinculantes)

| Id | Diferencia | Por qué bloquea | Propuesta (pendiente de aprobación) |
| --- | --- | --- | --- |
| **B1** | Estados de tarea: #554 usa 5 (`queued`, `active`, `blocked`, `interrupted`, `completed`) y los presenta como decisión del owner; 13 (TD aprobadas) define 10, más los estados de cada instrucción | Con 5 estados la UI no puede distinguir «detenida según el agente» de «completada», «cancelada antes de empezar» de «falló», ni «despacho incierto» de «activa». Son justo las distinciones de TD6 y de 13 §2.4. Un contrato con 5 pierde información que el backend tiene | **Canónicos = los de 13.** Los 5 de #554 son **grupos de presentación** (§3.4). `blocked` no es un estado: es la lista `attention[]` con motivos (`awaiting_approval`, `dispatch_uncertain`, `waiting_safe_point`, `agent_offline`, `queue_paused`, `needs_permission`). El registro de instrucciones usa los estados de 13 §2.4 y no tres marcas de tiempo sueltas |
| **B2** | `/projects/<pid>/channel[/<threadId>]`: canal del proyecto con hilos y `message.created{threadId}` | La arquitectura tiene **una conversación anfitriona por agente** con invitados (R10–R15), y la vista de proyecto es una **proyección** (AD7). Un canal de proyecto con hilos sería otra fuente de verdad de los mismos mensajes, o una entidad nueva sin anfitrión, que choca con R10 | Rutas: `#/projects/<pid>/agents/<aid>/chat[/<chatId>]` (la conversación anfitriona, el mismo componente que la vista Chat de la sesión, 06 §1) y `#/projects/<pid>/activity` (proyección de solo lectura). `threadId` = `chatId`. Un canal de proyecto real sólo con necesidad probada y decisión propia (AD7) |
| **B3** | `refs[]` sin estado de verificación; el wireframe muestra «QA ✓» | Una afirmación del agente («los tests pasan») se vería como un hecho. AD10: en el MVP las evidencias son **afirmadas** | Cada `ref` de tipo evidencia lleva `verification: "claimed"` (MVP), `claimedBy`, `bindingId`. La UI dice «según @qa-hz». ✓ sólo con `backend-verified`/`human-verified` (futuro) |
| **B4** | `roleTemplateId` en Agent y `RoleTemplate.defaultPermissions` | AD3/AD4: el rol es texto libre; la plantilla se **copia** al crear (`templateId` + `templateVersion`, sólo procedencia); los permisos nunca vienen de una plantilla sin confirmación del owner. Con `roleTemplateId` como referencia viva, editar una plantilla cambiaría agentes existentes y sus permisos | Agent: `role` (texto), `template: {templateId, templateVersion} \| null` (procedencia). `RoleTemplate` queda **futuro** (E3), sin `defaultPermissions` en el MVP |
| **B5** | `Project.members[]` (personas y roles) | R5 / 01 §5: proyectos de **un** owner en fase 1; compartir entre personas está fuera | Project en el MVP: `ownerUserId` implícito, sin `members`. Compartir es una decisión futura con su propio modelo de permisos |

### 2.2 Convenientes (incrementales)

| Id | Mejora |
| --- | --- |
| **C1** | Agent expone `binding` (vigente) y `bindings[]` (historial: `bindingId`, `epoch`, `sessionId`, `state`, `createdAt`, `retiredAt`, `retireReason`) en vez de `currentSessionId`/`sessions[]`. Eventos `binding.created`/`binding.retired`. Session gana `binding: {projectId, agentId, bindingId, epoch} \| null`, **derivado** de `agent_bindings` (sin columna nueva en `sessions`) |
| **C2** | `can` por acción con motivo: `{"update": {"allowed": false, "reason": "task-active"}}`. Así la UI explica el botón deshabilitado («usá Cambiar, la tarea ya está activa») sin repetir la regla. Responde D-7 |
| **C3** | Cola del agente visible: `queue: {mode: paused\|auto, accreditation: {by, at, runtime} \| null, lostReason?, depth, heldChats}`; un mensaje `held{task-active}` se muestra como «retenido hasta que termine T-n» con la opción explícita «intercalar ahora» (TD8) |
| **C4** | Disponibilidad del agente: `working`, `ready`, `needs_you`, `disconnected`, `stopped` (sesión detenida), `unknown`, cada una con `{source, at}` (§3.3). Responde D-5 |
| **C5** | Rutas anidadas bajo el proyecto (`/api/projects/:pid/agents/:aid`, `/api/projects/:pid/tasks/:tid`) en vez de `/api/agents/:aid` y `/api/tasks/:tid`: un único chequeo de propiedad por el proyecto, 404 uniforme para lo ajeno, y el `projectId` siempre presente para las claves de `viewPolicy` |
| **C6** | «Crear tarea desde este mensaje» envía `task.create` con `refs: [{kind: message, chatId, msgId}]`; no copia autoría ni autorización del mensaje |

### 2.3 Futuro (no retrasa el MVP)

`repos[]` y `policies` del proyecto (hoy los repos son de cada sesión); `RoleTemplate` y creación desde
plantillas (E3); compartir proyectos entre personas; tareas sin asignado / cola por proyecto (D-6);
Activity v2 por WebSocket (`/ws/activity`); aprobaciones de deploy como flujo del sistema (D-UX5);
cambio de vínculo con UI (E4); varias sesiones por agente (E9); verificación de evidencias (E8).

## 3. Contrato backend/frontend propuesto

### 3.1 Principios

1. **El servidor decide todo.** `can` es una cortesía para la UI; cada comando se vuelve a comprobar.
2. **Identificadores estables:** `projectId`, `agentId`, `bindingId`, `chatId`, `participationId`,
   `msgId`, `taskId` (UUID v4); alias legibles `@handle` y `T-<n>`, nunca usados como identidad.
3. **Todo estado mostrado lleva evidencia:** `{value, source, at}`. Ausente o viejo ⇒ `unknown`.
4. **Aditivo y detrás de banderas.** Con la bandera apagada, ninguna respuesta cambia y la UI es la de
   hoy (`GET /api/auth/status → features.projects`).
5. **Owner-only en el MVP** (R5): lo ajeno es 404, como lo inexistente.

### 3.2 Entidades (MVP) — ejemplo Educación HZ

```jsonc
// GET /api/projects/:pid   (nueva lectura; justificación en §3.5)
{
  "projectId": "6b1f…", "name": "Educación HZ", "createdAt": "2026-11-10T13:00:00Z", "archivedAt": null,
  "agents": [
    { "agentId": "a-arch…", "handle": "architect-hz", "role": "Architect", "provider": "claude-code",
      "template": null,
      "binding": { "bindingId": "b-1…", "epoch": 1, "sessionId": "3f2a…", "state": "active" },
      "availability": { "value": "ready", "source": "probe", "at": "2026-11-10T14:02:11Z" },
      "queue": { "mode": "paused", "accreditation": null, "depth": 0, "heldChats": 0 },
      "activeTask": null },
    { "agentId": "a-dev1…", "handle": "developer-hz", "role": "Developer", "provider": "claude-code",
      "template": { "templateId": "t-dev…", "templateVersion": 3 },
      "binding": { "bindingId": "b-2…", "epoch": 1, "sessionId": "a724…", "state": "active" },
      "availability": { "value": "working", "source": "hook", "at": "2026-11-10T14:02:40Z" },
      "queue": { "mode": "paused", "accreditation": null, "depth": 1, "heldChats": 1 },
      "activeTask": { "taskId": "t-…101", "taskKey": "T-101", "title": "Corregir login" } },
    { "agentId": "a-dev2…", "handle": "developer-hz-2", "role": "Developer", "binding": null,
      "availability": { "value": "unknown", "source": "none", "at": null } /* sin sesión vinculada */ },
    { "agentId": "a-qa…", "handle": "qa-hz", "role": "QA & Release",
      "binding": { "bindingId": "b-3…", "epoch": 1, "sessionId": "9c0d…", "state": "active" },
      "availability": { "value": "stopped", "source": "session", "at": "2026-11-10T12:40:00Z" } },
    { "agentId": "a-des…", "handle": "designer-hz", "role": "Designer",
      "availability": { "value": "needs_you", "source": "hook", "at": "2026-11-10T14:01:58Z" } }
  ],
  "counts": { "tasks": { "pending": 2, "inProgress": 1, "needsAttention": 1, "done": 7 } },
  "can": { "createAgent": { "allowed": true }, "archive": { "allowed": true } },
  "generatedAt": "2026-11-10T14:02:45Z"
}
```

```jsonc
// GET /api/projects/:pid/agents/:aid   (nueva lectura) — detalle con historial de vínculos
{
  "agentId": "a-dev1…", "projectId": "6b1f…", "handle": "developer-hz", "role": "Developer",
  "provider": "claude-code",
  "capabilities": { "capture": true, "channels": false, "directControl": true },   // declaradas por el adaptador (02 §5.2); channels=true sólo tras el GO
  "binding": { "bindingId": "b-2…", "epoch": 1, "sessionId": "a724…", "state": "active", "createdAt": "…" },
  "bindings": [ /* historial completo; en el MVP, sólo epoch 1 */ ],
  "availability": { "value": "working", "source": "hook", "at": "…" },
  "queue": { "mode": "paused", "accreditation": null, "lostReason": null, "depth": 1, "heldChats": 1 },
  "hostChat": { "chatId": "c-…", "participantsVersion": 4 },
  "can": { "remove": { "allowed": false, "reason": "deliveries-in-flight" },
           "setQueueAuto": { "allowed": false, "reason": "feature-not-enabled" } }
}
```

```jsonc
// GET /api/sessions  (existente) — cada fila gana un campo derivado, sólo con la bandera encendida
{ "sessionId": "a724…", "name": "hz-dev", "status": "running", /* … campos actuales sin cambios … */
  "binding": { "projectId": "6b1f…", "agentId": "a-dev1…", "handle": "developer-hz", "bindingId": "b-2…", "epoch": 1 } }
// binding: null ⇒ «Sesiones sin asignar»
```

### 3.3 Disponibilidad del agente (C4)

| `value` | Evidencia | Atención (#550, opción A) |
| --- | --- | --- |
| `working` | conversación viva `busy`/`waiting_background` con evidencia fresca (< 10 min) | trabajando |
| `ready` | `waiting_input` con identidad verificada y fresca | listo (no «needs you») |
| `needs_you` | `waiting_permission` fresca | needs you |
| `disconnected` | sesión `running` sin runtime registrado o con el runtime retirado | — |
| `stopped` | sesión del vínculo no está `running` | — |
| `unknown` | sin vínculo, sin evidencia o evidencia vieja | nunca se cuenta como cero |

### 3.4 Tareas: estados canónicos y grupos de presentación (B1)

| Grupo de la UI (#554) | Estados canónicos (13 §2.3) | Texto |
| --- | --- | --- |
| Pendiente | `awaiting_approval`, `queued` | «espera tu aprobación» / «en cola (cola en pausa)» |
| En curso | `dispatching`, `active` | «enviando» / «activa en @developer-hz» |
| Necesita atención | `dispatch_uncertain`, `interrupted`, o cualquier `attention[]` no vacío | «no sabemos si la tomó» / «interrumpida: el runtime terminó» |
| Terminada | `completed`, `stopped`, `cancelled`, `failed` | «completada según el agente» / «detenida según el agente» / «cancelada antes de empezar» / «falló» |

```jsonc
// GET /api/projects/:pid/tasks/:tid   (T1+)
{
  "taskId": "t-…101", "taskKey": "T-101", "projectId": "6b1f…",
  "assigneeAgentId": "a-dev1…", "creator": "user:u-1", "state": "active", "rev": 7, "version": 2,
  "definition": "Corregir el login que falla con SSO…",
  "attempt": { "attemptId": "att-…", "bindingId": "b-2…", "startedAt": "…" },
  "attention": [ { "reason": "waiting_safe_point", "instructionId": "i-…", "since": "…" } ],
  "instructions": [
    { "instructionId": "i-…", "verb": "STOP", "by": "user:u-1", "state": "acknowledged",
      "receivedAt": "…", "deliveredAt": "…", "acknowledgedAt": "…", "appliedAt": null },
    { "instructionId": "i-…", "verb": "CHANGE", "state": "superseded", "reason": "stop" }
  ],
  "refs": [
    { "kind": "message", "chatId": "c-…", "msgId": "m-…" },
    { "kind": "pr", "ref": "gatof81/educacion-hz#612", "verification": "claimed", "claimedBy": "agent:a-dev1…", "bindingId": "b-2…" },
    { "kind": "test_report", "ref": "…", "verification": "claimed", "claimedBy": "agent:a-qa…", "bindingId": "b-3…" }
  ],
  "report": null,   // task_report: {state, summary, externalEffects} cuando llega
  "can": { "update": { "allowed": false, "reason": "task-active" },
           "change": { "allowed": false, "reason": "stop-pending" },
           "stop":   { "allowed": false, "reason": "stop-pending" } }
}
```

### 3.5 Operaciones y rutas

**MVP del directorio (P3a, §5; todo owner-only y detrás de la bandera):**

| Ruta | Estado | Justificación |
| --- | --- | --- |
| `POST /api/projects`, `GET /api/projects` | ya en 03 §6.1 | — |
| `GET /api/projects/:pid` | **nueva** | la vista de proyecto de #554 necesita agentes + disponibilidad + conteos en **una** lectura; sin ella, N llamadas por proyecto (el costo que #550 ya identificó) |
| `POST /api/projects/:pid/agents` `{handle, role, sessionId?, clientRequestId}` | ya en 03, **ajustada**: `sessionId` opcional crea el vínculo `epoch 1`; `role` libre | AD1/AD3 |
| `GET /api/projects/:pid/agents` | ya en 03 | selector `@`, lista del equipo |
| `GET /api/projects/:pid/agents/:aid` | **nueva** | página del agente con el historial de vínculos (C1) |
| `DELETE /api/projects/:pid/agents/:aid` | ya en 03 | retira el vínculo; 409 si hay entregas no terminales |
| `GET /api/sessions` | existente, **+ `binding` derivado** | «Sesiones sin asignar» y breadcrumb sin otra llamada |

**Tareas (T1–T2, cada fase con su GO):**

| Ruta | Fase | Nota |
| --- | --- | --- |
| `POST /api/projects/:pid/tasks` | T1 | `CREATE`: `{assigneeAgentId, definition, refs?, clientInstructionId}` → 202 `{taskId, taskKey, rev, instructionId}` |
| `GET /api/projects/:pid/tasks?agent=&group=` | T1 | lista compacta |
| `GET /api/projects/:pid/tasks/:tid` | T1 | detalle (§3.4) |
| `POST /api/projects/:pid/tasks/:tid/instructions` | T1 (`UPDATE`, `STOP` de pendientes) / T2 (`CHANGE`, `STOP` de activas) | `{verb, ifRev, definition?, reason?, clientInstructionId}` → 202 `{instructionId, state}`: coincide con la ruta de #554 |
| `PATCH /api/projects/:pid/agents/:aid/queue` | T2 | `{mode, accreditation?}` (TD3); sin esta ruta no hay forma de pasar a `auto` |

**Tiempo real:** `WS /ws/project/<pid>` (ya en 03 §6.1, sin ruta nueva) gana suscripciones `agents` y
`tasks`. Los eventos son `agent.availability`, `binding.created`/`binding.retired`, `task.state`,
`task.instruction`, más los de las conversaciones. Cada uno lleva `seq` por proyecto para la reanudación
`subscribe{…, after}` sin huecos, igual que la captura. Hasta que exista, la UI hace polling de
`GET /api/projects/:pid`, que es barato por diseño.

**Futuro:** `RoleTemplate` (E3), `/ws/activity` y `/api/activity` extendido (#550), aprobaciones de
instrucciones de agentes (capa C, tras G3-2), cambio de vínculo (E4).

### 3.6 Errores y concurrencia

| Código | Cuándo | La UI |
| --- | --- | --- |
| 404 | proyecto, agente o tarea ajena o inexistente | «no encontrado» (no distingue) |
| 409 `handle-taken` / `session-taken` | alta de agente | explica |
| 409 `binding-draining` / `deliveries-in-flight` | retirar un agente o su vínculo con trabajo en vuelo | espera |
| 409 `stale-rev` (+ `rev` y `state` actuales) | `ifRev` viejo | recarga y muestra el cambio, conserva el borrador |
| 409 `task-active` / `task-not-active` | `UPDATE` sobre activa / `CHANGE` sobre pendiente | ofrece el verbo correcto, sin convertirlo |
| 409 `change-pending` / `stop-pending` | segunda instrucción | muestra la pendiente |
| 409 `idempotency-conflict` | mismo `clientInstructionId`/`clientRequestId` con otro cuerpo | error de cliente |
| 409 `tasks-unverifiable` | log de tareas ilegible | «no se puede verificar; nada se despacha» |
| 409 `participants-changed` | 03 §6.1 | conserva el borrador |
| 403 `feature-disabled` | bandera apagada | oculta |

Idempotencia: todo `POST` lleva `clientRequestId` / `clientMessageId` / `clientInstructionId`, que se
crea **por clic**, y nunca se reintenta solo (como el Composer).

### 3.7 Historial y compatibilidad

- `#/sessions/<sid>/…`, las claves `st.view.*`, `st.chat.last.*` y `st.draft.*` no cambian. Las
  claves nuevas llevan prefijo de entidad (`st.project.<pid>.*`, `st.agent.<aid>.*`).
- Vincular una sesión no cambia nada de la sesión (contenedor, token, captura, conversaciones del CLI).
  Desvincular retira el vínculo y conserva el historial: el `bindingId` sigue resolviendo en el
  detalle del agente.
- Nada se agrupa por nombre: una sesión entra a un proyecto sólo por una acción del owner.
- Las conversaciones del CLI de una sesión se muestran en el agente **a través** del vínculo; no se
  copian. Las de antes del vínculo se ven igual desde la sesión.

## 4. Decisiones que necesitan aprobación

| # | Decisión | Opciones | Recomendación |
| --- | --- | --- | --- |
| D-UX1 (B1) | Estados de tarea del contrato | (a) los 10 de 13 + grupos de presentación; (b) los 5 de #554 | **(a)**: TD aprobadas; los 5 quedan como grupos |
| D-UX2 (B2) | Dónde vive la conversación en la navegación (responde D-3) | (a) `…/agents/<aid>/chat` + `…/activity` como proyección; (b) canal de proyecto con hilos | **(a)**; B define el protocolo y la API, A la UI reutilizando la vista Chat |
| D-UX3 (B4) | Rol y plantilla | (a) rol libre + procedencia de plantilla; (b) `roleTemplateId` vivo | **(a)** (AD3/AD4) |
| D-UX4 (B5) | `members[]` | (a) fuera del MVP; (b) incluir | **(a)** (R5) |
| D-UX5 | Aprobación de deploys en la UI (D-8) | (a) fuera del sistema: un pedido de deploy de un agente es un mensaje o una tarea para una persona, y «aprobar» no ejecuta nada; (b) flujo del sistema que habilita el deploy | **(a)** en el MVP; (b) sería un verbo sensible nuevo con su propio diseño |
| D-UX6 | Tareas sin asignado (D-6) | (a) no en el MVP (13: asignado obligatorio); (b) cola por proyecto | **(a)** |
| D-UX7 | Nombres (D-1) | «Subagentes» para los del CLI | aceptar |
| D-UX8 | Desacoplar el directorio (P3a) de la POC de Channels | (a) P3a después del GO de la POC (roadmap actual); (b) P3a ahora, detrás de una bandera, sin conversaciones ni entregas | **(b)**: no usa Channels, y es la base que necesita el MVP de A (§5) |

## 5. Roadmap de la próxima etapa y próximo incremento

### 5.1 Qué permiten hoy los gates

| Fase | Gate | Estado |
| --- | --- | --- |
| P0, T0, E0, E1 | docs | **hecho** (este PR) |
| P1 (POC de Channels) | GO separado; G3 sin cumplir (`source` ausente); PASS-B1 INCONCLUSIVE; B2/B3 no autorizados | bloqueado |
| P2+ (contrato vinculante, P3–P9) | GO de la POC | bloqueado **según el roadmap**; P3 no depende técnicamente de Channels (D-UX8) |
| T1–T3 | T0 + P3 (+ P6 y G3-2 para T2/T3) | bloqueado |
| G3-1 | `observe` necesita su autorización; `true`, PASS de `observe` | release en curso (A) |
| G3-2 | NO-GO | — |

### 5.2 Incremento recomendado

**Sin decisión nueva (se puede empezar ya):**
1. **B:** este contrato, más *fixtures* JSON de §3.2–§3.4 (Educación HZ) para el `mockBackend.ts` de A:
   [`fixtures/educacion-hz.json`](./fixtures/educacion-hz.json). Son datos de diseño, no código del
   frontend, y siguen la recomendación de D-UX1–D-UX8 (cambian si se decide otra cosa).
2. **A** (su §12, solo frontend): `statusView.ts`, la unión tipada de rutas y el modelo «fila de
   entidad», con los *fixtures* como datos.

**Con D-UX8 (b): «P3a — directorio de proyecto»**, un PR de backend detrás de
`PROJECTS_ENABLED` (apagada por defecto, comportamiento neutro):

- **Migración v19:** `projects`, `project_agents` (sin sesión), `agent_bindings` (03 §2.1). Sin
  `chats`, `chat_participants` ni aristas.
- **Rutas de §3.5 «MVP del directorio»** y `binding` derivado en `GET /api/sessions`.
- **Sin** entregas, conversaciones, Channels, tareas ni cambios de vínculo.
- **Criterios de aceptación:**
  - con la bandera apagada, respuestas byte-idénticas (test);
  - 404 para lo ajeno;
  - índices únicos de vínculo vivo por agente y por sesión (test de carrera: dos altas con la misma
    sesión ⇒ una 409);
  - quitar un agente retira su vínculo y conserva el historial;
  - el hard delete de una sesión con vínculo vivo ⇒ 409 `agent-active` (03 §2.1);
  - `GET /api/projects/:pid` hace ≤ 3 lecturas D1, ningún probe ni llamada a Docker (la disponibilidad
    sale del estado de captura, como `GET …/conversations?capture=0`);
  - `binding` en `/api/sessions` sin una lectura D1 por fila.
- **Riesgos:**
  - fijar el esquema antes del contrato vinculante (P2). Mitigación: el esquema sólo cubre identidad y
    vínculo, que no dependen del transporte; la migración es aditiva;
  - costo de D1 en el hot path. Mitigación: caché como `portMappings`.
- **Tests:** CRUD, propiedad, carrera de índices, compatibilidad con la bandera apagada, derivación de
  `binding`, migración sobre un D1 con datos reales anonimizados (fixture).
- **Deploy:** no forma parte de este incremento; tendría su propio GO.

### 5.3 Evidencia que falta para desbloquear lo siguiente

| Para | Falta |
| --- | --- |
| P2 (contrato vinculante) y P4–P9 | GO de la POC: G1–G12, **G3** (`source` en `UserPromptSubmit`, ausente en 2.1.314/2.1.317) o su sustituto aprobado; PASS-B1 válido; B2/B3 |
| T2 (despacho, CHANGE/STOP de activas) | P6 + TG1–TG5 en la POC |
| T3 y cualquier solicitud entre agentes | GO de G3-2 (hoy NO-GO) |
| `true` de G3-1 | ventana `observe` ≥ 24 h con PASS (11 §5–§6) |
| Aislamiento entre proyectos | redes por proyecto (#291, E7) |
