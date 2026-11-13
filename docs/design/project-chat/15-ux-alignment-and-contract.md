> **Documento histórico (investigación de #512), no es un contrato vigente.** Se incorpora a main
> porque `docs/PROJECTS.md` lo cita como fuente de diseño. Los contratos vinculantes son
> [`docs/PROJECTS.md`](../../PROJECTS.md), [`docs/PROJECT_CONVERSATION.md`](../../PROJECT_CONVERSATION.md) y
> [`docs/CONVERSATION.md`](../../CONVERSATION.md): ante cualquier diferencia, mandan ellos. Los enlaces a otros
> documentos de #512 que no están en main apuntan a archivos que solo existen en la rama
> `docs/project-chat-channels` (conservada).

# Project Chat — alineación de arquitectura y UX (#512 ↔ #554) y contrato backend/frontend

Estado: **revisión 2026-11-06; decisiones D-UX0–D-UX10 y enmiendas E-1–E-9 APROBADAS el 2026-11-07
(§4.1). Los cinco conflictos de la revisión de compatibilidad de A y el vocabulario único: §6
(2026-11-07).** P3a está en desarrollo en el PR draft #557 (sin merge ni deploy), con contrato vinculante en
`docs/PROJECTS.md` de esa rama; el resumen para A es [16](./16-p3a-interfaces-for-a.md). Contrasta la
propuesta UX de Claude A (PR draft #554, `docs/design/ux-projects-agents.md` en `ab00778`) con la
arquitectura de este directorio:

- 02 (RFC), 03 (protocolo, con `agent_bindings` desde `b7ea0e2`), 05 (roadmap) y 06 (UX de la
  conversación del agente);
- 13 (tareas, TD1–TD11 aprobadas como arquitectura) y 14 (equipos, AD1–AD12 aprobadas como
  arquitectura).

No modifica #554. Lo que cambia un texto aprobado figura como **enmienda** (§3.8), con lo vigente y lo
propuesto lado a lado; las nueve quedaron aprobadas el 2026-11-07 como contratos de diseño, cada una en
su fase. G3-2 sigue en
NO-GO, y los gates de Channels, G3, PASS-A/PASS-B, R8 y TG1–TG5 no cambian.

Lo revisó un revisor independiente (una ronda, veredicto SHOULD-FIX); sus hallazgos están incorporados
en esta versión.

## 0. Resumen

- **#554 y #512 comparten la dirección:**
  - Project, Agent y Session separados; un agente tiene muchas sesiones a lo largo del tiempo;
  - Chat ≠ Task; los verbos se dirigen a una tarea, y recibido, aplicado y detenido son estados
    distintos;
  - los estados se muestran con evidencia y antigüedad, y un desconocido nunca aparece como cero;
  - la UI usa el `can` que da el servidor, y los deploys siempre requieren una persona;
  - los enlaces `#/sessions/…` se conservan y nada se inicia solo.
- **Hay una cuestión de precedencia que sólo puede resolver el responsable (D-UX0).** El preámbulo de
  #554 atribuye al responsable, con fecha 2026-11-06, tres decisiones que contradicen otras aprobadas
  el mismo día:
  1. estados de tarea «queued, active, blocked, interrupted, completed», contra TD1–TD11 (13 §2.3);
  2. «los roles vienen de plantillas», contra AD3/AD4;
  3. «Project agrupa agentes, recursos, repositorios y políticas». No contradice ninguna decisión
     aprobada: hoy los repos son de cada sesión (14 §1), así que repos y políticas de proyecto serían
     una capacidad **futura**. Se pide confirmar que quedan fuera del MVP.
- **Seis diferencias bloqueantes de contrato** (§2.1, B1–B6). Además de las anteriores: el canal de
  proyecto con hilos, las evidencias sin marca de «afirmada», `members[]` y el acceso de
  admin/lead/observe.
- **Contrato propuesto** (§3): una sola lectura nueva en P3a (más las de tareas en T1), y cada campo
  etiquetado con su fase.
- **Próximo incremento:**
  - ya permitido por los gates: este contrato, los *fixtures* y los refactors de solo frontend que A
    identificó;
  - **con una decisión del responsable (D-UX8):** «P3a», el directorio de proyecto. P3a **no**
    satisface la dependencia P3 de T1.

## 1. Matriz de compatibilidad

| # | Capacidad | #512 | #554 | Veredicto |
| --- | --- | --- | --- | --- |
| 1 | Project como frontera de recursos y permisos | owner-only (R5); handles únicos; invitados y aristas sólo del mismo proyecto (R14, AD12) | `members[]`, `policies`, `repos[]`; admin, lead y observe «mantienen su significado» (§10); agentes creados «por un camino admin» (§5) | **B5**, **B6**; `repos`/`policies`: **D-UX0** |
| 2 | Agent independiente de Session | `project_agents` sin sesión + `agent_bindings` (AD1) | `currentSessionId`, `sessions[]`; D-4 «vínculo explícito» | **compatible**; nombres (**C1**) |
| 3 | `agent_bindings` y cambios futuros | `epoch`; estados `active`/`draining`/`retired`; cambio de vínculo no implementado (AD2) | eventos `session.attached`/`detached` | **compatible**; eventos `binding.*` (**C1**) |
| 4 | Roles, plantillas, varios agentes del mismo rol | rol libre (AD3); plantilla copiada con versión, sin referencia viva y sin permisos sin confirmación del owner (AD4, 14 D-T) | `roleTemplateId` como referencia; «los roles vienen de plantillas» | **B4** + **D-UX0** |
| 5 | Chat, Task y Authorization separados | tres sobres (14 §4.1) | Chat ≠ Task; «crear tarea desde un mensaje» explícito; aprobación de deploy humana | **compatible**; el deploy queda en **D-UX5** |
| 6 | Tareas en cola sin interrumpir | cola `paused` por defecto, `auto` explícito con acreditación (TD3); `message` retenido (TD8) | `queued`, una tarea activa; sin control de la cola | **C3** |
| 7 | Entrega, ejecución, incertidumbre, recuperación | entregas (03 §3, 06 §3); tareas: 10 estados (13 §2.3); instrucciones (13 §2.4) | 5 estados de tarea; `interrupted` no terminal («queued → active → blocked/interrupted → completed»); instrucción con tres marcas de tiempo | **B1** + **D-UX0** |
| 8 | Permisos delegados futuros | 13 §4.1 | `permissions` (resumen) y `can` | **compatible** (**C2**) |
| 9 | Agentes desconectados, ocupados, detenidos | presencia de 06 §5; el monitor nunca arranca contenedores | working, waiting, blocked, disconnected, con evidencia; nada se inicia solo | **compatible**; usar el vocabulario de 06 §5 (**C4**) |
| 10 | Trazabilidad | `binding_id` en cada evidencia; `evidence[]` con `verification: claimed` (14 §4.4) | `refs[]` tipados; el wireframe muestra «QA ✓» | **B3** |

Coincidencias sin acción:

| Tema | Coincidencia |
| --- | --- |
| Nombres | D-1, «Subagentes» para los del CLI: se recomienda aceptarlo |
| Pertenencia | D-2, un agente en un solo proyecto: igual que AD12 |
| Vínculo | D-4, explícito y del owner, nunca inferido: igual que 14 §3.2 |
| Sesiones existentes | sin asignar, enlaces intactos, sin agrupar por nombre: igual que 14 §6 |
| Historial privado | se muestra como chip opaco |

## 2. Diferencias

### 2.1 Bloqueantes

| Id | Diferencia | Por qué bloquea | Propuesta |
| --- | --- | --- | --- |
| **B1** | Estados de tarea: #554 usa 5 (`queued`, `active`, `blocked`, `interrupted`, `completed`) y trata `interrupted` como no terminal. 13 define 10 (`awaiting_approval`, `queued`, `dispatching`, `dispatch_uncertain`, `active`, `completed`, `stopped`, `cancelled`, `failed`, `interrupted`, este último terminal y sin reanudación, TD11) más los estados de instrucción (13 §2.4) | Con 5 estados la UI no distingue «detenida según el agente» de «completada», «cancelada antes de empezar» de «falló», ni «despacho incierto» de «activa», que son justo las distinciones de TD6 y 13 §2.4 | **Canónicos = los de 13.** Los de #554 pasan a ser **grupos de presentación** (§3.4); `blocked` pasa a ser **avisos**. El registro de instrucciones usa los estados de 13 §2.4 |
| **B2** | `/projects/<pid>/channel[/<threadId>]`: un canal de proyecto con hilos, con `message.created{threadId}` | La arquitectura tiene **una conversación anfitriona por agente** con invitados (R10–R15), y la vista de proyecto es una **proyección** (AD7). Un canal con hilos sería otra fuente de verdad, o una entidad nueva sin anfitrión, en contra de R10 | D-UX2 |
| **B3** | `refs[]` sin estado de verificación, y «QA ✓» en el wireframe | Una afirmación del agente se vería como un hecho (AD10) | Las referencias de evidencia llevan `verification: "claimed"` (MVP), `claimedBy` y `bindingId`; la UI dice «según @qa-hz». ✓ sólo con verificación (E8, futuro) |
| **B4** | `roleTemplateId` como referencia viva del agente | AD4: la plantilla se **copia**, y una referencia viva cambiaría agentes existentes al editarla. 14 D-T prevé un perfil de permisos *sugerido* en la plantilla, pero sólo se aplica con la confirmación del owner al crear el agente | Agent: `role` (texto) + `template: {templateId, templateVersion} \| null`, sólo como procedencia y **desde E3**. En P3a la columna queda reservada y siempre `null` (14 D-T) |
| **B5** | `Project.members[]` | R5 y 01 §5: proyectos de **un** owner en fase 1 | Sin `members` en el MVP; compartir proyectos es una decisión futura |
| **B6** | Admin, lead y observe sobre proyectos (#554 §10, D-7); agentes creados «por un camino admin» (#554 §5) | R5; 03 §7 «Admin / lead: nada en v1 (404)»; 13 §4 dice lo mismo | Sin acceso de admin, lead ni observe a proyectos, agentes ni tareas en v1. Los agentes los crea **sólo el owner**, con `POST …/agents` |

### 2.2 Convenientes

| Id | Mejora |
| --- | --- |
| **C1** | Agent expone `binding` (el vigente) y, en el detalle, `bindings[]` (el historial). Los eventos son `binding.created`/`binding.retired`. Session gana un `binding` **derivado**, sin columna nueva en `sessions` |
| **C2** | `can` por acción, con motivo: `{"update": {"allowed": false, "reason": "task-active"}}` (responde la parte «por acción» de D-7) |
| **C3** | Cola visible: `queue: {mode, accreditation, lostReason, depth}` (T2), y mensajes `held{task-active}` con un «intercalar ahora» explícito (TD8, P6) |
| **C4** | Presencia con el vocabulario **de 06 §5** (§3.3), sin inventar uno nuevo |
| **C5** | Rutas anidadas bajo el proyecto: un solo chequeo de propiedad, un 404 uniforme y el `projectId` siempre disponible para `viewPolicy` |
| **C6** | «Crear tarea desde este mensaje» envía un `work_request{verb: CREATE}` con `refs: [{kind: message, chatId, msgId}]`. No copia la autoría ni la autorización del mensaje |

### 2.3 Futuro

`repos[]` y `policies` de proyecto (sujetos a D-UX0); `RoleTemplate` y creación de agentes desde
plantillas (E3); compartir proyectos; tareas sin asignado (D-6); Activity v2 (E6); aprobaciones de
deploy como flujo del sistema (D-UX5); cambio de vínculo y vincular agentes sin sesión (E4); varias
sesiones por agente (E9); verificación de evidencias (E8).

## 3. Contrato backend/frontend propuesto

### 3.1 Principios

1. **El servidor decide todo.** `can` es una cortesía para la UI; cada comando se vuelve a
   comprobar.
2. **Identificadores estables** (UUID v4): `projectId`, `agentId`, `bindingId`, `chatId`,
   `participationId`, `msgId`, `taskId` e `instructionId`. Los alias `@handle` y `T-<n>` nunca son
   identidad.
3. **Todo estado que se muestra lleva evidencia** `{value, source, at}`. Si falta o está vieja, el
   valor es `unknown`.
4. **Bandera:** todo va detrás de `PROJECT_CHAT_ENABLED` (02 §8). Encenderla para P3a habilita sólo
   P3a; cada fase posterior llega con su propia sub-bandera o GO (02 §8: «y por agente»).
   - Con la bandera apagada, las rutas no se montan (404) y las respuestas existentes quedan
     byte-idénticas.
   - La UI se entera por `features.projectChat` en `GET /api/auth/status`, que es una superficie
     nueva (E-6).
5. **Owner-only** (R5): lo ajeno da 404, igual que lo inexistente. No hay admin, lead ni observe (B6).
6. **Cada campo lleva su fase.** Un campo de una fase que todavía no está habilitada no aparece y nunca
   se simula. La única excepción son las columnas **reservadas** (como `template`), que aparecen siempre
   como `null`.

### 3.2 Entidades (ejemplo: Educación HZ)

Los ejemplos son de **P3a**. Los campos de otras fases (`T1`, `T2`, `P3` completo, `P6`) aparecen
comentados. *Fixtures*: [`fixtures/educacion-hz.json`](./fixtures/educacion-hz.json).

```jsonc
// GET /api/projects/:pid/agents   (existe en 03 §6.1; forma enmendada E-2, §3.8)
{
  "projectId": "6b1f2c3d-…", "generatedAt": "2026-11-10T14:02:45Z",
  "agents": [
    { "agentId": "a0…a1", "handle": "architect-hz", "role": "Architect", "provider": "claude-code",
      "template": null,
      "binding": { "bindingId": "b0…b1", "epoch": 1, "sessionId": "3f2a…", "state": "active" },
      "presence": { "value": "waiting_input", "source": "probe", "at": "2026-11-10T14:02:11Z" }
      // T1: "activeTask"   T2: "queue"   P6: "runtime": {registered, degraded?, reason?}
    },
    { "agentId": "a0…a2", "handle": "developer-hz", "role": "Developer", "provider": "claude-code",
      "template": null,
      "binding": { "bindingId": "b0…b2", "epoch": 1, "sessionId": "a724…", "state": "active" },
      "presence": { "value": "working", "source": "hook", "at": "2026-11-10T14:02:40Z" } },
    { "agentId": "a0…a3", "handle": "developer-hz-2", "role": "Developer", "provider": "claude-code",
      "template": null,
      "binding": { "bindingId": "b0…b5", "epoch": 1, "sessionId": "7e11…", "state": "active" },
      "presence": { "value": "unknown", "source": "capture", "at": "2026-11-10T13:31:02Z" } },  // evidencia vieja (> 10 min)
    { "agentId": "a0…a4", "handle": "qa-hz", "role": "QA & Release",
      "binding": { "bindingId": "b0…b3", "epoch": 1, "sessionId": "9c0d…", "state": "active" },
      "presence": { "value": "disconnected", "source": "session", "at": "2026-11-10T12:40:00Z" } },  // sesión detenida
    { "agentId": "a0…a5", "handle": "designer-hz", "role": "Designer",
      "binding": { "bindingId": "b0…b4", "epoch": 1, "sessionId": "d5e6…", "state": "active" },
      "presence": { "value": "needs_attention", "detail": "waiting_permission", "source": "hook", "at": "2026-11-10T14:01:58Z" } }
  ],
  "can": { "createAgent": { "allowed": true } }
}
```

```jsonc
// GET /api/projects/:pid/agents/:aid   (lectura NUEVA: E-3) — detalle con el historial de vínculos
{
  "agentId": "a0…a2", "projectId": "6b1f2c3d-…", "handle": "developer-hz", "role": "Developer",
  "provider": "claude-code", "template": null,
  "capabilities": { "capture": true, "channels": false, "directControl": true },  // declaradas por el adaptador (02 §5.2); channels sólo tras el GO
  "binding": { "bindingId": "b0…b2", "epoch": 1, "sessionId": "a724…", "state": "active", "createdAt": "2026-11-10T13:05:00Z" },
  "bindings": [ { "bindingId": "b0…b2", "epoch": 1, "sessionId": "a724…", "state": "active",
                  "createdAt": "2026-11-10T13:05:00Z", "retiredAt": null, "retireReason": null } ],
  "presence": { "value": "working", "source": "hook", "at": "2026-11-10T14:02:40Z" },
  "can": { "remove": { "allowed": true } }
  // P3 completo: "hostChat"   T2: "queue", "can.setQueueAuto"
}
```

```jsonc
// GET /api/sessions   (existente; enmienda E-4) — sólo con la bandera encendida, cada fila gana:
{ "sessionId": "a724…", "name": "hz-dev", "status": "running" /* …campos actuales sin cambios… */,
  "binding": { "projectId": "6b1f2c3d-…", "agentId": "a0…a2", "handle": "developer-hz", "bindingId": "b0…b2", "epoch": 1 } }
// "binding": null ⇒ «Sesiones sin asignar»
```

### 3.3 Presencia del agente (C4, sobre 06 §5)

| `value` | 06 §5 | Fuente | Fase | Atención (#550, opción A) |
| --- | --- | --- | --- | --- |
| `working` | trabajando | conversación viva `running`/`waiting_background` con evidencia fresca (< 10 min) | P3a | trabajando |
| `waiting_input` | esperando input | `waiting_input` fresco; **verificado sólo si `source: probe`** (`hook:Stop` lo pone sin comprobar identidad, CONVERSATION.md §5.3) | P3a | «listo», no «necesita atención» |
| `needs_attention` | esperando permiso | `waiting_permission`, indicado en `detail`. `needs-terminal` es una precondición que el Composer comprueba en cada envío (3.2): nunca se muestra como presencia | P3a | necesita atención |
| `disconnected` | desconectado | la sesión del vínculo no está `running`, o la conversación que decide (ver abajo) está `disconnected` o `ended` (por hook `SessionEnd` o por `probe:absent`) | P3a | — |
| `no_channel` | mensajería no disponible | runtime no registrado | **P6** | — |
| `degraded` | la mensajería no responde | runtime `degraded` | **P6** | necesita atención |
| `ambiguous` | ambiguo | dos runtimes | **P6** | necesita atención |
| `unknown` | — | sin evidencia, con evidencia vieja, o estados de captura `error`/`ending` | P3a | nunca cuenta como cero |

**Qué conversación decide:** la más reciente de la sesión vinculada que tenga un pane ligado en el
arranque actual del contenedor (CONVERSATION.md §5.2, bindings por arranque). Una conversación vieja
`ended` (por ejemplo, tras `/clear`) no hace parecer desconectado a un agente vivo.

**En P3a** la presencia sale **sólo** de `sessions.status` y del estado de la captura, igual que
`GET …/conversations?capture=0`, sin probe ni Docker. Ningún agente aparece como `no_channel` porque
Channels todavía no exista.

### 3.4 Tareas (T1+): estados canónicos y grupos de presentación (B1)

**Cada tarea va en un solo grupo, según su estado.** Así no hay ambigüedad y los conteos salen
directamente de la lista:

| Grupo | Estados (13 §2.3) | Texto |
| --- | --- | --- |
| Pendiente | `awaiting_approval`, `queued` | «espera tu aprobación» / «en cola» (+ «cola en pausa») |
| En curso | `dispatching`, `active` | «enviando» / «activa en @developer-hz» |
| Requiere tu decisión | `dispatch_uncertain` | «no sabemos si la tomó; no se envía nada más» |
| Terminada | `completed`, `stopped`, `cancelled`, `failed`, `interrupted` | «completada según el agente» / «detenida según el agente» / «cancelada antes de empezar» / «falló» / ⚠ «interrumpida: el runtime terminó sin informe» (terminal, TD11) |

**Avisos** (`notices[]`): no cambian el grupo ni reemplazan estados. Son `waiting_safe_point` y
`awaiting_stop_report` (instrucciones, 13 §2.4 y §3.5), `agent-offline` (14 §5), `queue-paused`
(13 §3.1) y `blocked` (§6.2: sólo con evidencia y un motivo explícito; **no** es un estado).

```jsonc
// GET /api/projects/:pid/tasks/:tid   (lectura nueva E-5, de T1; este ejemplo muestra datos de T2:
// despacho, intento y STOP de una tarea activa. En T1 sólo existen queued/cancelled (awaiting_approval
// desde T3) e instrucciones UPDATE/STOP sobre pendientes, aplicadas por el backend)
{
  "taskId": "70…0101", "taskKey": "T-101", "projectId": "6b1f2c3d-…",
  "assigneeAgentId": "a0…a2", "creator": "user:u-1", "state": "active", "rev": 7, "version": 2,
  "definition": "Corregir el login que falla con SSO…",
  "attempt": { "attemptId": "e0…01", "bindingId": "b0…b2", "startedAt": "2026-11-10T13:20:00Z" },
  "notices": [ { "kind": "awaiting_stop_report", "instructionId": "10…02", "since": "2026-11-10T14:01:12Z" } ],
  "instructions": [
    { "instructionId": "10…01", "verb": "CHANGE", "by": "user:u-1", "state": "superseded", "reason": "stop",
      "receivedAt": "2026-11-10T13:58:00Z" },
    { "instructionId": "10…02", "verb": "STOP", "by": "user:u-1", "state": "acknowledged",
      "receivedAt": "2026-11-10T14:00:05Z", "deliveredAt": "2026-11-10T14:01:10Z", "acknowledgedAt": "2026-11-10T14:01:12Z" }
  ],
  "refs": [
    { "kind": "message", "chatId": "c0…02", "msgId": "f0…09" },
    { "kind": "pr", "ref": "example-org/educacion-hz#612", "verification": "claimed", "claimedBy": "agent:a0…a2", "bindingId": "b0…b2" },
    { "kind": "message", "chatId": "c0…02", "msgId": "f0…11", "note": "resultado de QA publicado por @qa-hz; la evidencia vive en ese mensaje" }
  ],
  "report": null,
  "can": { "update": { "allowed": false, "reason": "task-active" },
           "change": { "allowed": false, "reason": "stop-pending" },
           "stop":   { "allowed": false, "reason": "stop-pending" } }
}
```

La evidencia de QA no se agrega como afirmación a la tarea del desarrollador: un agente sólo informa
sobre **sus** tareas (13 §3.6). La evidencia llega en un mensaje de @qa-hz, dentro de su `evidence[]`,
y la tarea **referencia** ese mensaje.

### 3.5 Superficies nuevas o cambiadas

| Superficie | Fase | Tipo | Justificación |
| --- | --- | --- | --- |
| `POST /api/projects`, `GET /api/projects` | P3a | existe en 03; **E-9** para `POST` | `clientRequestId` |
| `POST /api/projects/:pid/agents` | P3a | existe en 03; **E-1** | `role` (AD3) y `clientRequestId` para idempotencia |
| `GET /api/projects/:pid/agents` | P3a | existe en 03; **E-2** | presencia de 06 §5 y `binding`; runtime y cola aparecen en su fase |
| `GET /api/projects/:pid/agents/:aid` | P3a | **nueva (E-3)** | página del agente con el historial de vínculos. Meterlo en la lista la haría crecer con cada vínculo |
| `DELETE /api/projects/:pid/agents/:aid` | P3a | existe en 03, **sin cambios** | retira el agente y su vínculo (`retired`, `agent-removed`). Entregas no terminales ⇒ `failed{agent-removed}` (03), que en P3a no existen |
| `GET /api/sessions` | P3a | existe; **E-4** | `binding`, para «Sesiones sin asignar» y el breadcrumb |
| `GET /api/auth/status` → `features.projectChat` | P3a | **E-6** | para que la UI sepa si la superficie existe |
| `POST /api/projects/:pid/tasks`, `GET …/tasks`, `GET …/tasks/:tid` | T1 | **nuevas (E-5)** | 13 §2: `CREATE` y lecturas |
| `POST /api/projects/:pid/tasks/:tid/instructions` | T1 (`UPDATE`, `STOP` de pendientes) / T2 (`CHANGE`, `STOP` de activas) | **nueva (E-5)** | 13 §2.2; coincide con la ruta de #554 |
| `PATCH /api/projects/:pid/agents/:aid/queue` | T2 | **nueva** | TD3: es la única forma de pasar a `auto` con acreditación |
| `WS /ws/project/<pid>` | P3 completo / T1 | existe en 03; **E-7** | ver «Tiempo real» |

**Descartadas:**
- `GET /api/projects/:pid`: es redundante con `GET /api/projects` + `GET …/agents`. El hub de todos los
  proyectos usa `/api/activity` (#550), que tiene su propio diseño.
- Una ruta para vincular un agente sin sesión: en P3a `sessionId` es **obligatorio**, como en 03.
  Vincular después es E4.

**Tiempo real:**
- En P3a no hay WebSocket: la UI hace *polling* de `GET …/agents`.
- Desde T1, `WS /ws/project/<pid>` gana `subscribe{tasks, after}`. Los eventos `task.state` y
  `task.instruction` llevan el `seq` del **log de tareas** (13 §6), así que la reanudación no tiene
  huecos.
- La **presencia** y los **vínculos** son estado derivado y no tienen log. Se envían como *snapshot* al
  suscribirse y como deltas después, con `resync` si hay un corte; para ellos no se promete «sin
  huecos».

### 3.6 Errores y concurrencia

| Código | Cuándo | Origen | La UI |
| --- | --- | --- | --- |
| 404 | ajeno, inexistente, o bandera apagada | 03 / 02 §8 | «no encontrado» |
| 409 `handle-taken` / `session-taken` | alta de agente | 03 | explica |
| 409 `binding-draining` | cambio de vínculo o reasignación de una sesión con algo en vuelo del vínculo anterior (E4); reemplaza a `previous-agent-in-flight` de 10 (R-G6) | 14 §3.2 | — (no existe en P3a) |
| 409 `agent-active` | hard delete de una sesión con vínculo vivo | 03 §2.1 | «quitá el agente primero» |
| 409 `stale-rev` | `ifRev` viejo | 13 | recarga y conserva el borrador |
| 409 `task-active` / `task-not-active` | el verbo no corresponde al estado | 13 | ofrece el verbo correcto sin convertirlo |
| 409 `change-pending` | segundo `CHANGE` | 13 | muestra el pendiente |
| 409 `stop-pending` | `CHANGE` o `STOP` con un `STOP` ya recibido | **nuevo (E-5)** | «ya pediste detenerla» |
| 409 `idempotency-conflict` | mismo id de cliente con otro cuerpo | 13 | error de cliente |
| 409 `tasks-unverifiable` | log de tareas ilegible | 13 §6 | «no se puede verificar; nada se despacha» |
| 409 `participants-changed` | 03 §6.1 | 03 | conserva el borrador |
| 409 `agent-limit` / `project-limit` | 32 agentes / 50 proyectos | PROJECTS.md §4.7 (P3a) | «llegaste al máximo» |
| 503 `outcome-unknown` | resultado no confirmado | PROJECTS.md §3 (P3a) | «Reintentar» con el mismo id |
| 400 `not-a-participant` | un destinatario (`to`) fuera de la conversación, en `POST /api/chats/:cid/messages` | 03 §6.1 | explica y conserva el borrador |
| 403 `not-a-participant` / `not-bound` | lado del agente: no participa / no tiene vínculo vivo | 03 §6.2–§6.3 | (no llega a la UI de la persona) |
| 403 `not-task-creator` / `not-task-assignee` | verbo sobre una tarea ajena | 13, 03 §10 | explica |

**Idempotencia:** cada `POST` **nuevo o enmendado en este documento** lleva un id de cliente
(`clientRequestId`, `clientInstructionId`; `clientMessageId` ya existe en 03), creado en cada clic.
Igual que el Composer, nunca se reintenta solo. Los demás `POST` de 03 (`archive`, `collab`,
`decision`, `approve`, `cancel`, `channel/retry`) no cambian aquí: su idempotencia se decide en P3
completo.

### 3.7 Historial y compatibilidad

- No cambian `#/sessions/<sid>/…` ni las claves `st.view.*`, `st.chat.last.*` y `st.draft.*`. Las claves
  nuevas llevan prefijo de entidad: `st.project.<pid>.*` y `st.agent.<aid>.*`.
- Vincular una sesión no cambia nada de ella: ni el contenedor, ni el token, ni la captura, ni las
  conversaciones del CLI.
- Quitar un agente retira su vínculo y conserva el historial: el `bindingId` sigue resolviendo en el
  detalle del agente archivado.
- Nada se agrupa por nombre: una sesión entra a un proyecto sólo por una acción del owner.
- Las conversaciones del CLI se muestran en el agente a través del vínculo, sin copiarlas.

### 3.8 Enmiendas a textos aprobados (aprobadas 2026-11-07, cada una en su fase)

| Id | Texto vigente | Propuesta |
| --- | --- | --- |
| E-1 | 03 §6.1 `POST …/agents {handle, sessionId}` | `{handle, role, sessionId, clientRequestId}` (P3a; `template` recién en E3); crea el agente y su `agent_bindings{epoch: 1}` |
| E-2 | 03 §6.1 `GET …/agents` → `state`, `statusEvidence`, `runtime`, `queueDepth` | `presence{value, detail?, source, at}` (06 §5), `binding` y `template`; `runtime` (P6) y `queue` (T2) aparecen en su fase |
| E-3 | — | `GET /api/projects/:pid/agents/:aid` |
| E-4 | `GET /api/sessions` sin datos de proyecto | + `binding` derivado, sólo con la bandera encendida |
| E-5 | 13 no define rutas HTTP | las rutas de tareas de §3.5 y el código `stop-pending` |
| E-6 | `GET /api/auth/status` sin `features` | `features.projectChat: boolean` |
| E-7 | 03 §6.1 `WS /ws/project/<pid>` con `subscribe{chat, after}` | + `subscribe{tasks, after}`, con el seq del log de tareas, y `subscribe{agents}`, con *snapshot* + deltas y sin garantía de huecos |
| E-8 | 06 §1: conversación en `#/sessions/<sid>/chat/<chatId>`; 05 P7: «no es una pantalla de proyecto» | ver D-UX2 |
| E-9 | 03 §6.1 `POST /api/projects {name}` | `{name, clientRequestId}` |

## 4. Decisiones (aprobadas 2026-11-07)

Las recomendaciones de la tabla quedaron aprobadas tal cual; las precisiones del responsable están en
§4.1.

| # | Decisión | Opciones | Recomendación |
| --- | --- | --- | --- |
| **D-UX0** | Precedencia. #554 atribuye al responsable los 5 estados y «los roles vienen de plantillas», que contradicen TD1–TD11 y AD3/AD4; y los repos/políticas de proyecto, que se piden confirmar como futuros | (a) valen TD, AD y R5; (b) vale lo que cita #554 y se revisan 13 y 14 | **(a)**. Si el responsable confirma (b), se reabren 13 §2.3 y AD3/AD4 |
| D-UX1 (B1) | Estados de tarea del contrato | (a) los 10 de 13 + grupos; (b) los 5 de #554 | **(a)** |
| D-UX2 (B2, E-8) | Dónde vive la conversación | (a) `#/projects/<pid>/agents/<aid>/chat[/<chatId>]`, con `#/sessions/<sid>/hostchat/<chatId>` como alias. El alias tiene segmento propio porque `#/sessions/<sid>/chat/<detail>` ya lleva el `cid` de la captura y los dos son UUID; esto corrige también 06 §1. Es **sólo una redirección**: resuelve `chatId` → agente anfitrión → `#/projects/<pid>/agents/<aid>/chat/<chatId>`, ignora `<sid>` (o responde «no encontrado» si la conversación no es del owner) y nunca se guarda como vista y la actividad del proyecto como proyección (E6); (b) un canal de proyecto con hilos | **(a)**, que enmienda 06 §1 y 05 P7. Con AD1 la conversación pertenece al **agente**, así que una URL atada a la sesión se rompe cuando cambia el vínculo. Se usa el mismo componente que la vista Chat: B define el protocolo y A la UI |
| D-UX3 (B4) | Rol y plantilla | (a) rol libre + procedencia; (b) `roleTemplateId` vivo | **(a)** |
| D-UX4 (B5) | `members[]` | (a) fuera del MVP; (b) incluir | **(a)** |
| D-UX5 | Aprobación de deploys (D-8) | (a) fuera del sistema: el pedido es un mensaje o una tarea para una persona, y «aprobar» no ejecuta nada; (b) un flujo del sistema | **(a)** en el MVP |
| D-UX6 | Tareas sin asignado (D-6) | (a) no; (b) cola por proyecto | **(a)** |
| D-UX7 | Nombres (D-1) | «Subagentes» | aceptar |
| D-UX8 | Directorio P3a antes del GO de la POC | (a) P3 entero tras el GO, como hoy; (b) **P3a** ahora, detrás de la bandera, sin conversaciones, entregas, tareas ni Channels | **(b)**: identidad y vínculo no dependen del transporte. P3a **no** satisface la dependencia P3 de T1, que sigue tras el GO |
| D-UX9 (B6) | Acceso de admin, lead y observe; quién crea los agentes | (a) sólo el owner en v1 (R5); (b) los tiers de hoy | **(a)** |
| D-UX10 | Enmiendas E-1 a E-9 | aprobar o ajustar | aprobarlas junto con lo anterior |

### 4.1 Registro de la aprobación (2026-11-07)

El responsable (con ChatGPT) aprobó D-UX0–D-UX10 según las recomendaciones, con estas precisiones:

- TD1–TD11, AD1–AD12 y R5 son los contratos canónicos (D-UX0 = a).
- Los 10 estados de tarea de 13 son los reales; los grupos de la UI son sólo presentación.
- La conversación pertenece al agente lógico: ruta canónica por proyecto/agente, compatibilidad con las
  rutas existentes.
- Roles libres, plantillas copiadas, sin herencia de permisos en vivo.
- Proyectos owner-only en v1: sin `members[]` ni accesos admin/lead/observe.
- Las evidencias que reporta un agente siguen siendo `claimed`, nunca verificadas.
- Las tareas requieren asignado en el MVP.
- Los agentes internos del CLI se llaman «Subagentes».
- Aprobaciones de deploy fuera del flujo de tareas en el MVP, sin impedir una integración futura con
  autorizaciones específicas.
- E-1–E-9 aprobadas como contratos de diseño, respetando fases y dependencias.

**GO de desarrollo de P3a** en rama propia (no en #512), PR draft contra main, sin merge, deploy ni
migración en producción. P3a es una excepción acotada a la dependencia del GO de Channels y **no**
desbloquea P3 completo, T1, T2 ni T3.

### 4.2 Notas de implementación de P3a (#557)

No cambian el significado de la API; quedan registradas porque difieren del texto de 03 §2.1 o lo
precisan:

| Id | Nota | Motivo |
| --- | --- | --- |
| N-1 | `agent_bindings.st_session_id` **sin FK** a `sessions` | D1 aplica las FK: bloquearía para siempre el hard delete de toda sesión vinculada alguna vez; `CASCADE` borraría el historial |
| N-2 | Tabla `project_agent_creations` y columnas `client_request_id`/`request_hash` en `projects` | registros durables de idempotencia (E-1, E-9) |
| N-3 | Alta de agente + vínculo en **una** sentencia (trigger), baja con trigger que retira el vínculo | D1 por HTTP no tiene transacciones entre llamadas (condición A del GO) |
| N-4 | 503 `outcome-unknown` cuando la respuesta se pierde y la relectura no encuentra el registro | una escritura tardía todavía puede aplicarse; el cliente reintenta con el mismo id |
| N-5 | La guardia 409 `agent-active` del hard delete actúa **siempre**, con la bandera encendida o apagada (corregido el 2026-11-09; la versión anterior decía «sólo con la bandera encendida», que contradecía PROJECTS.md §1/§6 y el código desde #557 `962dd3f`) | los vínculos sobreviven a la bandera: sin la guardia, apagar la bandera dejaría borrar una sesión vinculada. Sin vínculos, la guardia nunca rechaza, así que con la bandera apagada y sin agentes la API existente no cambia (condición B). Un vínculo a una sesión que se borró por otro camino se lee `session-gone` |
| N-6 | Los handles de agentes quitados quedan reservados | 03 `UNIQUE (project_id, handle)` sin cambios |
| N-7 | `binding` ausente en `/api/sessions` = lectura fallida; `features` ausente = bandera apagada | respuestas byte-idénticas con la bandera apagada |
| N-8 | `project_agent_edges`, `chats` y `chat_participants` no se crean | son P3 |

## 5. Roadmap de la próxima etapa

### 5.1 Qué permiten hoy los gates

| Fase | Gate | Estado |
| --- | --- | --- |
| P0, T0, E0 | docs | hechas |
| E1 (`agent_bindings` en 03 §1 y §2.1) | docs | hecha en `b7ea0e2` |
| P1 (POC de Channels) | GO separado; G3 sin cumplir (`source` ausente); PASS-B1 INCONCLUSIVE; B2 y B3 sin autorizar | bloqueada |
| P2 en adelante (contrato vinculante, P3–P9) | GO de la POC | bloqueadas según 05. P3a (sólo identidad y vínculo) se propone con D-UX8 |
| T1 | T0 + P3 completo (no P3a) | bloqueada |
| T2 | T1 + P6 + TG1–TG5 | bloqueada |
| T3 | T2 + P8 + G3-2 | bloqueada |
| Release de G3-1 | merge de #555, preflight de A y autorización explícita | **nada ejecutado** (11: «Procedimiento final, nada ejecutado»); falta el preflight de A (11 §8.A) |
| G3-1 `observe` / `true` | `observe` necesita autorización propia; `true`, el PASS de `observe` | pendientes |
| G3-2 | — | NO-GO |

### 5.2 Incremento recomendado

**Sin decisión nueva (se puede empezar ya):**
1. **B:** este contrato y [`fixtures/educacion-hz.json`](./fixtures/educacion-hz.json), datos de diseño
   para el `mockBackend.ts` de A. Siguen las recomendaciones de §4 y cambian si se decide otra cosa.
2. **A** (su §12, solo frontend): `statusView.ts`, la unión tipada de rutas y la «fila de entidad», con
   los *fixtures* como datos.

**Con D-UX8 (b) y D-UX10: «P3a — directorio de proyecto»**, un PR de backend detrás de
`PROJECT_CHAT_ENABLED` (con la bandera apagada, las rutas no existen).

**Alcance:**
- migración v19: `projects`, `project_agents` (sin sesión) y `agent_bindings` (03 §2.1). Sin `chats`,
  `chat_participants` ni aristas;
- las rutas P3a de §3.5, el `binding` derivado en `GET /api/sessions` y `features.projectChat`;
- **sin** entregas, conversaciones, Channels, tareas, cola ni cambios de vínculo.

**Criterios de aceptación:**
- con la bandera apagada, las respuestas existentes son byte-idénticas y las rutas nuevas dan 404
  (test);
- 404 para lo ajeno, también para admin y lead;
- a lo sumo un vínculo vivo por agente y por sesión. Test de carrera: dos altas con la misma sesión dan
  una sola ganadora y un 409 `session-taken`;
- quitar un agente retira su vínculo (`agent-removed`) y conserva el historial;
- el hard delete de una sesión con vínculo vivo da 409 `agent-active`;
- `GET …/agents` hace ≤ 2 lecturas D1, sin probe ni Docker;
- el `binding` de `/api/sessions` no hace una lectura D1 por fila: una sola lectura de los vínculos
  vivos del owner, con una caché invalidada antes y después de cada escritura (como `portMappings`);
- idempotencia por `clientRequestId`.

**Riesgos:**
- *Fijar el esquema antes de P2.* Mitigación: sólo cubre identidad y vínculo, que no dependen del
  transporte, y la migración es aditiva.
- *Costo en D1.* Mitigación: la caché.
- *Usar P3a para adelantar T1.* Mitigación: la regla explícita de D-UX8.

**Tests:** rutas y propiedad; carrera de índices; bandera apagada; derivación de `binding`; migración
sobre un D1 con un *fixture* realista.

**Deploy:** no forma parte de este incremento; tiene su propio GO.

### 5.3 Evidencia que falta para lo siguiente

| Para | Falta |
| --- | --- |
| P2 y P4–P9 | GO de la POC: G1–G12, **G3** (`source` en `UserPromptSubmit`, que falta en 2.1.314 y 2.1.317) o un sustituto aprobado, PASS-B1 válido, B2 y B3 |
| T1 | P3 completo (GO de la POC) |
| T2 | P6 + TG1–TG5 en la POC |
| T3 y cualquier solicitud entre agentes | P8 + GO de G3-2 |
| `true` de G3-1 | el release desplegado y la ventana `observe` de ≥ 24 h con PASS (11 §5–§6) |
| Aislamiento entre proyectos | redes por proyecto (#291, E7) |

## 6. Revisión de compatibilidad de A (#554, 2026-11-07): decisiones y vocabulario único

A comparó #554 con este directorio y lo publicó en #554. El responsable decidió los cinco conflictos el
mismo día. Esta sección los registra y fija **un solo vocabulario**. Para el backend, el modelo y el
protocolo de este directorio son la fuente de verdad, y A adapta #554 a esto. No se implementa nada
nuevo.

### 6.1 Decisiones del responsable

| # | Conflicto | Decisión | Qué implica para la UI |
| --- | --- | --- | --- |
| 1 | Modelo de Project Chat | **Conversaciones anfitrionas por agente**, con invitados y destinatarios explícitos (`to[]`; el servidor nunca lee `@`). **Project Activity** es una proyección de sólo lectura sobre conversaciones y tareas, sin otro almacén de mensajes (AD7) | En el MVP no hay conversación de proyecto con hilos. A futuro puede existir una conversación a nivel proyecto (AD7: un tipo propio, en su propio log) sin cambiar las identidades de los agentes ni copiar mensajes existentes |
| 2 | Estado `blocked` | **No hay estado persistente `blocked`.** Los 10 estados de 13 §2.3 son los canónicos | La UI puede mostrar «bloqueada» sólo como **aviso**, con evidencia y un motivo explícito (§6.2). Nunca lo deduce del silencio o de la falta de eventos |
| 3 | Deploy y autorizaciones | Los deploys siguen **fuera** del protocolo de tareas. A tiene autorización permanente del owner para deploys GREEN que cumplan los gates; YELLOW y RED conservan sus restricciones. **Una tarea nunca autoriza un deploy** | No hay botón de aprobación de producción mientras no exista un contrato `authorization` específico para deploys. Una tarea puede pedir un deploy como texto, y la UI muestra «requiere autorización humana fuera del sistema»; ese texto no es una autorización ni activa la autorización permanente de A |
| 4 | Permisos | **Owner-only** para Projects, Agents y Project Chat (R5). Los permisos de las sesiones no cambian, y no hay permisos por proyecto para otros usuarios | admin, lead y observe reciben 404 en las superficies de proyecto; observe/operate siguen sólo en el workbench de la sesión |
| 5 | Terminología | **Channels** es sólo el transporte interno (`st-channel`, `/ingest/channel/*`) | La UI dice **Project Chat**, **Conversation** y **Project Activity**, nunca «canal» ni «channel» |

### 6.2 «Bloqueada»: un aviso, no un estado

Tiene la misma forma que el resto de `notices[]` (§3.4), con su evidencia:

```jsonc
{ "kind": "blocked", "reason": "waiting_permission",   // motivo explícito, nunca vacío
  "evidence": { "source": "hook", "at": "2026-11-10T14:03:00Z", "bindingId": "b0…b2" } }
```

| Fuente admitida | `reason` | `evidence.source` | Desde |
| --- | --- | --- | --- |
| La presencia del agente es `needs_attention` con `detail: "waiting_permission"` (§3.3), en el vínculo del intento en curso | `waiting_permission` | la de la presencia (`hook` o `probe`) | T2 (necesita despacho e intento) |
| El propio agente informa que está bloqueado en esa tarea y da un motivo (`task_report`, capa B) | el texto del agente | `agent`; como toda evidencia de agente, `verification: "claimed"` (14 §4.4) | capa B |

Reglas:

- el aviso va **sólo** en la tarea `active` del agente, y sólo cuando el `bindingId` del intento es el
  del vínculo cuya presencia lo indica. Una tarea `queued` de ese agente, o una presencia que viene de
  trabajo fuera de la tarea (por ejemplo, Direct control), no la muestra «bloqueada»;
- no hay ninguna otra fuente. Tres situaciones parecidas **no** son «bloqueada»: una instrucción que
  espera un punto seguro es `waiting_safe_point` (su propio aviso, con su antigüedad); un agente sin
  vínculo vivo es `agent-offline`; una presencia vieja es `unknown · stale`;
- el aviso no cambia el grupo de la tarea ni su estado, y desaparece cuando su evidencia deja de valer.

### 6.3 Vocabulario único

**Entidades e ids** (los nombres de #554 quedan reemplazados):

| Concepto | Nombre canónico (API / UI) | Antes en #554 | Fuente |
| --- | --- | --- | --- |
| Proyecto | `projectId`, `name` · «Project» | — | PROJECTS.md §4 |
| Agente | `agentId` (la identidad) + `handle` (alias `@handle`, no identifica) + `role` (texto libre) + `provider` · «Agent». La tabla es `project_agents` | `name` | 03 §2.1, PROJECTS.md §2 |
| Plantilla | `template{templateId, templateVersion}`, copiada al crear; `null` hasta que existan las plantillas | `RoleTemplate`, `roleTemplateId` | AD4, E-3 |
| Vínculo | `binding{bindingId, epoch, sessionId, state}`, con el historial en `bindings[]` | `currentSessionId`, `sessions[]` | AD1, PROJECTS.md §4.5 |
| Cambio de vínculo | eventos de vínculo (`active` → `draining` → `retired`) | `session.attached/detached` | 14 §3.2 (sin implementar) |
| Conversación | `chatId` · «Conversation»; su anfitrión es un agente | `threadId` | 03 §1 |
| Autor | `author{kind: human\|agent, agentId?}` | `authorId` | 03 §2.2 |
| Destinatarios | `to[]` (`agentId`s, siempre explícitos) | `recipients[]` | 03 §6.1 |
| Referencias de un **mensaje** | `evidence[]{…, verification: "claimed"}` (afirmaciones del agente), `taskRefs[]` (contexto; nunca cambian una tarea), `context[]` (mensajes que cita la persona) | `refs[]` del mensaje | 14 §4.2–§4.3 |
| Referencias de una **tarea** | `refs[]` se queda: `{kind: message, chatId, msgId}` o, en las de evidencia, con `verification`, `claimedBy` y `bindingId` (B3) | `refs[]` de la tarea | §3.4, C6 |
| Subagente | «Subagentes»: los agentes internos del CLI | — | D-UX7 |

**Tipos de envío: los tres sobres de AD6, y ninguno más.** TD8 usaba otros nombres para lo mismo;
desde el 2026-11-07 valen estos:

| Sobre | Qué hace | Ruta | Antes |
| --- | --- | --- | --- |
| `message` | conversación. `kind: request\|info\|progress\|result\|question` es una **etiqueta** para mostrar, nunca un verbo: un `kind: request` no crea ni cambia nada | `POST /api/chats/:cid/messages` | `chat` (TD8) |
| `work_request{verb}` | `CREATE` crea una tarea; `UPDATE`, `CHANGE` y `STOP` actúan sobre una (13 §2.2) | `POST /api/projects/:pid/tasks` (`CREATE`), `POST …/tasks/:tid/instructions` (los otros tres) | `task.create` y `task.change` (TD8); `kind: update/change/stop` en #554 |
| `authorization` | aprueba o rechaza una solicitud; otorga o revoca un permiso | **[FUTURO]**: en el MVP no tiene ruta, y ninguna autoriza deploys | — |

Una instrucción (un `work_request` sobre una tarea) recorre `received → waiting_safe_point →
delivered → acknowledged → applied | refused | superseded | rejected` (13 §2.4). Cada paso lleva su
hora (`receivedAt`, `deliveredAt`, `acknowledgedAt`, …, como en el ejemplo de §3.4). Las tres de #554
corresponden así: `receivedAt` = `received`; `appliedAt` = el estado `applied`; `stoppedAt` = la
evidencia de `STOP` de 13 §3.5 (las tres confirmaciones de 03 §10).

**Errores:** el índice único es §3.6. Desde hoy `previous-agent-in-flight` no existe; se llama
`binding-draining`. Los errores de P3a, con su texto, están en 16 §4.

**Palabras de la UI:** Project Chat, Conversation, Project Activity, Agent y Subagentes. «Channel» y
«canal» no aparecen en la UI: `no_channel` se muestra como «mensajería no disponible» y `degraded`
como «la mensajería no responde».

### 6.4 Lo que #554 suponía y este directorio no especificaba

| Supuesto de #554 | Estado | Dónde |
| --- | --- | --- |
| `can` y descubrimiento de capacidades | **especificado; implementado en el PR draft #557 (sin merge)**: `features.projectChat`; `can.createProject`, `can.createAgent` y `can.remove` como `{allowed, reason?}` | 16 §1 y §3; PROJECTS.md §4 |
| Endpoints de actividad, WS y nombres de eventos | **diseñado, sin implementar**: `WS /ws/project/<pid>` con `task.state` y `task.instruction` desde T1; presencia y vínculos como *snapshot* más deltas. En P3a, *polling* | §3.5 «Tiempo real»; E-7 |
| Rutas REST de tareas | **diseñadas (E-5), sin implementar** | §3.5 |
| Estado `blocked` | **decidido: no existe**; es un aviso con evidencia | §6.2 |
| Forma y frescura de la evidencia de estado | **especificado; implementado en #557 (draft)**: `presence{value, detail?, source, at, verified?}`; una afirmación cuya evidencia tiene ≥ 10 min se muestra como `unknown · stale` | 16 §3–§4; PROJECTS.md §5 |
| Historial de vínculos y «sesiones sin asignar» | **especificado; implementado en #557 (draft)**: `GET …/agents/:aid` → `bindings[]`; `GET /api/sessions` → `binding` (objeto; `null` = sin asignar; ausente = desconocido) | 16 §2 y §4 |
| `members`, `repos` y `policies` del proyecto | **fuera del MVP** (D-UX4, R5). `repos` y `policies` no forman parte del modelo | §4 |

### 6.5 Contradicciones internas corregidas (las cuatro que señaló A)

1. La tabla se llama `project_agents` en todos los documentos (14 §2 y §6, AD1). Se agrega que
   `agent_bindings` no tiene FK a `sessions` (03 §2.1, 14 §2), como en la v19 de #557 (02 §9 y 14 D-T incluidos).
2. Los tipos de envío son los tres sobres de AD6 (13 §5 y TD8; 02 §9; 15 §1 y C6; 03 §10).
3. `previous-agent-in-flight` pasa a llamarse `binding-draining` (03 §6.1, 15 §3.6, con una nota en 10).
4. 14 §9 agrega 403 `not-task-assignee`, 409 `tasks-unverifiable` y 409 `stop-pending`, y remite al
   índice de §3.6.

Otros cambios del mismo paso:

- 03 §6.1 tiene ahora las formas que implementó P3a (`clientRequestId`, lecturas del agente);
- 03 §10 dice que TD1–TD11 son arquitectura aprobada;
- 06 §5 y 03 (`runtime`, `channel/retry`) dejaron de usar «canal» como texto de la UI; la ruta conserva su nombre interno.
