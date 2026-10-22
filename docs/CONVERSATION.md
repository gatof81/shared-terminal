# Conversation & Agent Activity — contrato técnico (Fase 3)

Estado: **v1 (3.0a), vinculante para los PRs 3.0b–3.4.** El razonamiento está en
[docs/design/phase3-conversation-activity.md](./design/phase3-conversation-activity.md); este
archivo define lo que el código debe cumplir y lo que cada PR debe demostrar. Cambiar un contrato
exige un PR de docs antes o junto con el código.

Convenciones: *MUST*/*MUST NOT* son requisitos verificados por test; *SHOULD* son requisitos
verificados en revisión.

---

## 1. Interfaces en las que nos apoyamos

| Interfaz | Documentación oficial | Versión mínima | Uso |
| --- | --- | --- | --- |
| Hooks `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `MessageDisplay`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Stop`, `StopFailure`, `SubagentStart`, `SubagentStop`, `Notification`, `PermissionRequest`, `PreCompact`, `PostCompact`, `TaskCreated`, `TaskCompleted`, `TeammateIdle` | code.claude.com/docs/en/hooks | 2.1.308 (pin de imagen) | Captura |
| Hook `type: "http"` con `headers` + `allowedEnvVars` | idem | 2.1.308 | Transporte |
| Managed settings en archivo: `/etc/claude-code/managed-settings.d/*.json` | code.claude.com/docs/en/managed-settings | 2.1.308 | Entrega de la configuración |
| `claude agents --json` | code.claude.com/docs/en/agent-view | 2.1.308 | Probe de estado |
| Variables `TMUX_PANE` (tmux) y `SESSION_ID` (Shared Terminal) | tmux(1); `buildContainerEnv` | — | Binding y auth |

### 1.1 Interfaces internas prohibidas

El código de Fase 3 *MUST NOT* leer ni escribir, en el camino caliente ni en tests de integración:

- `~/.claude/sessions/*.json`, `~/.claude/sessions/*.key`, `/tmp/cc-socks*` (registro y socket de
  mensajería; formato interno).
- `~/.claude/projects/**/*.jsonl` (transcripts; formato interno). Única excepción: el backfill
  opcional de 3.4, detrás de `CONVERSATION_TRANSCRIPT_BACKFILL=true`, con parser tolerante y marca
  `imported: true` en cada evento.
- `~/.claude/teams/**`, `~/.claude/tasks/**`, `~/.claude/jobs/**`, `~/.claude/daemon/**`.
- Scraping del stream ANSI del terminal como fuente de mensajes.

---

## 2. Entrega de hooks y ciclo de activación

### 2.1 Archivos y montajes

| Qué | Dónde | Quién lo escribe |
| --- | --- | --- |
| Directorio managed vacío | `/etc/claude-code/managed-settings.d/` (imagen, root 0755) | Dockerfile |
| Script de registro | `/opt/st/hooks/session-start.sh` (imagen, root 0755) | Dockerfile |
| Archivo de hooks por sesión | host `<WORKSPACE_ROOT>/.claude-managed/<st_session_id>/conversation.json`, montado **ro** en `/etc/claude-code/managed-settings.d/` | backend, en `spawn`/`startContainer`, solo si la sesión está habilitada |
| Token de ingesta | env `ST_INGEST_TOKEN` del contenedor (32 bytes aleatorios, hex) | backend, solo si la sesión está habilitada; hash SHA-256 en `sessions.ingest_token_hash` |

Reglas:

- El directorio host `.claude-managed/<sid>` *MUST* existir (vacío si la sesión no está habilitada)
  antes de `container.start()`, igual que `.uploads/<sid>`; el bind es siempre `ro`.
- Sesión no habilitada ⇒ *MUST NOT* existir `conversation.json` y *MUST NOT* inyectarse
  `ST_INGEST_TOKEN`. Test: `docker inspect` del contenedor no contiene la variable y el directorio
  montado está vacío.
- `CONVERSATION_ENABLED=false` (default) ⇒ ninguna sesión está habilitada, el endpoint de ingesta
  responde 204 y descarta, el comando/endpoint de habilitación responde 409 `conversation-disabled`.
- Habilitación por sesión: `PATCH /api/admin/sessions/:id/conversation {enabled: boolean}` (3.0d).
  Habilitar escribe el archivo; si el contenedor ya corre, el archivo aparece dentro del montaje ro
  (mismo directorio host) y el CLI lo recarga en caliente; si no recarga, aplica en el siguiente
  `POST /start`. Deshabilitar borra el archivo (mismo efecto).
- `npm run conversation:disable -- <sid>|--all` (host, dentro del contenedor del backend, patrón de
  `backup.ts`) borra los archivos sin pasar por la API: es el kill switch de emergencia.
- La imagen *MUST* comportarse de forma idéntica a la actual cuando el directorio montado está
  vacío (smoke test: `claude -p hola` no produce ninguna petición saliente a `st-backend`).

### 2.2 Contenido de `conversation.json`

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "/opt/st/hooks/session-start.sh", "async": true, "timeout": 5 }] }],
    "UserPromptSubmit":   [{ "hooks": [HTTP] }],
    "MessageDisplay":     [{ "hooks": [HTTP] }],
    "PreToolUse":         [{ "matcher": "*", "hooks": [HTTP] }],
    "PostToolUse":        [{ "matcher": "*", "hooks": [HTTP] }],
    "PostToolUseFailure": [{ "matcher": "*", "hooks": [HTTP] }],
    "Stop":               [{ "hooks": [HTTP] }],
    "StopFailure":        [{ "hooks": [HTTP] }],
    "SubagentStart":      [{ "hooks": [HTTP] }],
    "SubagentStop":       [{ "hooks": [HTTP] }],
    "Notification":       [{ "hooks": [HTTP] }],
    "PermissionRequest":  [{ "hooks": [HTTP] }],
    "PreCompact":         [{ "hooks": [HTTP] }],
    "PostCompact":        [{ "hooks": [HTTP] }],
    "TaskCreated":        [{ "hooks": [HTTP] }],
    "TaskCompleted":      [{ "hooks": [HTTP] }],
    "TeammateIdle":       [{ "hooks": [HTTP] }],
    "SessionEnd":         [{ "hooks": [HTTP] }]
  }
}
```

donde `HTTP` es exactamente:

```json
{
  "type": "http",
  "url": "http://st-backend:3001/ingest/claude/hook",
  "timeout": 1,
  "headers": {
    "Authorization": "Bearer $ST_INGEST_TOKEN",
    "X-ST-Session": "$SESSION_ID",
    "X-ST-Tmux-Pane": "$TMUX_PANE"
  },
  "allowedEnvVars": ["ST_INGEST_TOKEN", "SESSION_ID", "TMUX_PANE"]
}
```

- `st-backend` *MUST* ser un alias del servicio `app` en `sessions-net` (`docker-compose.yml`,
  `networks.sessions-net.aliases`). El puerto es el `PORT` del backend; el archivo se genera con el
  valor real.
- `timeout: 1` es deliberado: un receptor presente pero colgado cuesta ≤ 1 s por evento; un receptor
  ausente falla en DNS sin esperar. *MUST NOT* subirse sin cambiar este documento.
- Ningún hook de este archivo *MUST* devolver un cuerpo con `decision`, `permissionDecision`,
  `continue`, `updatedInput`, `additionalContext` ni `displayContent`: el receptor responde **204 sin
  cuerpo** en todos los casos (test).

### 2.3 `session-start.sh`

Entrada: JSON de `SessionStart` por stdin. Comportamiento:

1. Si `ST_INGEST_TOKEN` está vacío o no definido: exit 0 sin salida ni red.
2. Construye el JSON de salida = entrada + `{ "st": { "claude_version": "<claude --version>",
   "tmux_session": "<tmux display-message -p '#S' o null>", "pane": "$TMUX_PANE o null",
   "argv": ["<argv del proceso padre, máx. 32 entradas, cada una recortada a 256 bytes>"] } }`.
3. `curl --silent --max-time 2 -X POST -H 'Content-Type: application/json' -H "Authorization: Bearer
   $ST_INGEST_TOKEN" -H "X-ST-Session: $SESSION_ID" -H "X-ST-Tmux-Pane: $TMUX_PANE" --data-binary
   @- http://st-backend:3001/ingest/claude/hook`. Cualquier fallo ⇒ exit 0.
4. Nunca escribe en stdout (un JSON en stdout sería interpretado por el CLI). Errores a stderr solo
   con `ST_HOOKS_DEBUG=1`.

---

## 3. Endpoint de ingesta

`POST /ingest/claude/hook` — fuera de `/api`, montado antes de `express.json`, `cookieParser` y
CORS, con parser JSON propio limitado a **L5**.

### 3.1 Autenticación y respuesta

| Condición | Respuesta | Efecto |
| --- | --- | --- |
| Falta `Authorization` o `X-ST-Session` | 204 | contador `ingest_rejected{reason=missing_auth}` |
| Token no coincide con `ingest_token_hash` de esa sesión, o sesión no `running`, o sesión no habilitada | 204 | `ingest_rejected{reason=bad_token\|not_running\|disabled}` |
| Cuerpo > L5 o JSON inválido | 204 | `ingest_rejected{reason=too_large\|invalid_json}` + `gap malformed` si se identificó `session_id` |
| Evento válido | 204 | encolado; persistencia asíncrona |

- *MUST* responder siempre 204 con cuerpo vacío en ≤ 50 ms p99 con el disco sano (la persistencia
  no está en el camino de la respuesta).
- *MUST NOT* devolver 401/403/429 (el CLI mostraría errores de hook al usuario; la observabilidad
  nunca produce ruido en el agente).
- Rate limit por sesión ST: **R1 = 500 eventos / 10 s** y **R2 = 4 MiB / 10 s** (ventana fija).
  Exceso ⇒ descartado + un único `gap{reason: rate_limited, dropped: n}` por ventana.
- Cola por conversación acotada en **L6**; overflow ⇒ descartado + `gap{reason: backpressure}`.

### 3.2 Headers de correlación

| Header | Origen | Validación |
| --- | --- | --- |
| `X-ST-Session` | `$SESSION_ID` del contenedor | *MUST* existir en `sessions` y coincidir con el token. El `session_id` del cuerpo (Claude) se asocia a esta sesión ST; un `session_id` ya asociado a **otra** sesión ST ⇒ descartado (`ingest_rejected{reason=session_mismatch}`). |
| `X-ST-Tmux-Pane` | `$TMUX_PANE` | `^%\d{1,6}$` o vacío (sin tmux: `-p` del exec API). |

---

## 4. Modelo de eventos persistidos

### 4.1 Envoltura

```json
{ "seq": 1234, "ts": "2026-10-22T18:21:07.123Z", "ev": "assistant_delta",
  "prompt_id": "…", "turn_id": "…", "agent_id": null, "pane": "%0", "data": { … } }
```

- `seq`: entero ≥ 1, estrictamente creciente por conversación, asignado por el backend al persistir.
- `ts`: hora de recepción en el backend (los hooks no traen timestamp).
- `agent_id`: `null` para el hilo principal; presente para subagentes y teammates in-process.
- **Persistido** ⇔ la línea está en `<cid>.events.jsonl` con `seq`. Solo eventos persistidos se
  envían por WS, se cuentan en `events_count` y se consideran "recibidos" por la UI.

### 4.2 Eventos y datos (normalizados desde los hooks)

| `ev` | Hook origen | `data` (campos persistidos) | Límite |
| --- | --- | --- | --- |
| `session_start` | `SessionStart` (+`st` del script) | `source`, `agent_type?`, `model?`, `session_title?`, `claude_version?`, `tmux_session?`, `argv?`, `cwd`, `transcript_path` | — |
| `session_end` | `SessionEnd` | `reason` | — |
| `user_prompt` | `UserPromptSubmit` | `prompt`, `source?`, `session_title?` | **L1** (truncado visible) |
| `assistant_delta` | `MessageDisplay` | `message_id`, `index`, `final`, `delta` | acumulado por `message_id` ≤ **L2** |
| `tool_start` | `PreToolUse` | `tool_use_id`, `tool_name`, `summary` (§4.3), `mcp_server?` | **L4** |
| `tool_end` | `PostToolUse` | `tool_use_id`, `tool_name`, `ok: true`, `duration_ms?`, `response_bytes` | — |
| `tool_failed` | `PostToolUseFailure` | `tool_use_id`, `tool_name`, `ok: false`, `error`, `is_interrupt?`, `duration_ms?` | `error` ≤ **L4** |
| `turn_end` | `Stop` | `last_assistant_message`, `background_tasks[]` (solo `id`, `type`, `status`, `description` ≤ L4), `session_crons_count` | `last_assistant_message` ≤ **L3** (truncado visible) |
| `turn_failed` | `StopFailure` | `error`, `error_details?` | L4 |
| `agent_start` | `SubagentStart` | `agent_id`, `agent_type` | — |
| `agent_end` | `SubagentStop` | `agent_id`, `agent_type`, `last_assistant_message`, `agent_transcript_path`, `background_tasks[]` | **L3** |
| `notification` | `Notification` | `notification_type`, `message`, `title?` | L4 |
| `permission_request` | `PermissionRequest` | `tool_name`, `summary` | L4 |
| `compact` | `PreCompact`/`PostCompact` | `phase: pre\|post`, `trigger` | (sin `compact_summary`) |
| `task_created` / `task_completed` | `TaskCreated`/`TaskCompleted` | `task_id`, `task_subject`, `teammate_name?` | `task_subject` ≤ L4 |
| `teammate_idle` | `TeammateIdle` | `teammate_name` | — |
| `gap` | backend | `reason`, `dropped?`, `range?`, `detail?` | — |
| `probe` | backend | `status`, `waitingFor?`, `found: boolean` | — |
| `composer_send` | backend (3.2) | `clientMessageId`, `result`, `prompt_id?` | — |

Campos no listados *MUST NOT* persistirse (parser tolerante: se descartan y se cuentan en
`ingest_fields_dropped`).

### 4.3 Resumen redactado de `tool_input` (`summary`)

Función pura `summarizeToolInput(tool_name, tool_input): string` con tests de tabla:

| Herramienta | `summary` |
| --- | --- |
| `Bash` | `command` recortado a L4; `description` si existe, antes |
| `Read`, `Edit`, `Write`, `MultiEdit`, `NotebookEdit` | `file_path` (+ `offset/limit` en Read) |
| `Grep`, `Glob` | `pattern` (+ `path`) |
| `Agent` | `description` + `subagent_type` |
| `WebFetch`, `WebSearch` | `url` / `query` con query string eliminado |
| `mcp__*` y desconocidas | lista de **nombres** de claves de primer nivel, nunca valores |

Nunca, para ninguna herramienta, se persiste el valor de una clave cuyo nombre contenga (sin
distinguir mayúsculas) `token`, `secret`, `password`, `passwd`, `key`, `authorization`, `cookie`,
`credential`, `env`. `tool_response` *MUST NOT* persistirse en ningún caso en 3.x.

### 4.4 Límites unificados

| Id | Qué | Valor | Al exceder |
| --- | --- | --- | --- |
| **L1** | `user_prompt.prompt` | 64 KiB | truncar + `truncated: true, original_bytes` |
| **L2** | texto acumulado de un `message_id` | 1 MiB | descartar deltas siguientes + `truncated: true` en el último persistido |
| **L3** | `last_assistant_message` (`turn_end`, `agent_end`) | **2 MiB** | truncar + `truncated: true, original_bytes`; la UI lo dice en el botón "Copiar informe" |
| **L4** | strings auxiliares (`summary`, `error`, `message`, `task_subject`, …) | 2 KiB | truncar con marcador `…[+N chars]` |
| **L5** | cuerpo HTTP de ingesta | **4 MiB** | 204 + `gap malformed{reason: too_large}` |
| **L6** | cola en memoria por conversación | 256 eventos o 8 MiB | `gap backpressure` |
| **L7** | archivo `events.jsonl` | 64 MiB | rotar a `.1` (una sola generación) + `gap{reason: rotated}` al inicio del nuevo |
| **L8** | eventos montados en el DOM | 500 | ventana por `seq` |

L3 > L5 no es posible, de ahí L5 = 4 MiB: un informe de 2 MiB cabe con margen en el cuerpo del
hook. **Ningún truncado es silencioso**: cada uno deja `truncated: true` en el evento y la UI lo
muestra junto al contenido afectado.

### 4.5 `gap`: representación de pérdidas

| `reason` | Cuándo | UI |
| --- | --- | --- |
| `rate_limited` | R1/R2 excedidos | "N eventos omitidos por volumen" |
| `backpressure` | L6 lleno | "N eventos omitidos (backend saturado)" |
| `malformed` | evento no reconocido / demasiado grande | "Evento no reconocido (versión del CLI)" |
| `missing_delta` | `assistant_delta.index` no consecutivo | "[… fragmento perdido …]" en el mensaje |
| `missing_prompt` | `turn_end` sin `user_prompt` para su `prompt_id` | "Prompt no capturado" antes del informe |
| `backend_restart` | al reiniciar el backend, por conversación no terminada | "Posible actividad perdida entre HH:MM y HH:MM" |
| `rotated` | L7 | "Historial anterior archivado" |
| `history_unavailable` | conversación conocida por `resume` sin eventos previos | "El historial anterior a la activación no está disponible" |

`claude_conversations.gaps_count` se incrementa por cada `gap` persistido.

---

## 5. Conversaciones: filas, estados y binding

### 5.1 Creación y enriquecimiento

- Cualquier evento con `session_id` desconocido crea la fila (`kind: unknown`). `session_start`
  fija `kind` (`interactive` por defecto; `headless` si `argv` contiene `-p`/`--print`; `teammate`
  si contiene `--agent-name`/`--agent-id`), `claude_version`, `title` (`session_title`) y binding.
- `title` por defecto = primeros 80 caracteres del primer `user_prompt` con `source` ausente o
  `user`; `session_title` lo reemplaza cuando llega.
- `user_prompt.source ∈ {system, loop_wakeup, schedule_wakeup, poll_event, sdk}` se persiste con
  esa marca y la UI lo muestra como "mensaje inyectado", no como burbuja del usuario.

### 5.2 Binding tab/pane

- `pane_id` = `X-ST-Tmux-Pane` del último `session_start` o, si no hay, del primer evento con pane.
  `tab_id` = `tmux_session` del script; si falta, se resuelve por `tmux list-panes -a -F
  '#{pane_id} #{session_name}'` (exec, cacheado 60 s).
- Dos conversaciones con el mismo `pane_id`: la más reciente conserva el binding; la anterior pasa a
  `pane_id = NULL`, `status = unknown`, evidencia `binding_lost`.
- `session_end` con `reason: clear|resume` deshace el binding al confirmarse.

### 5.3 Máquina de estados

Tabla única (`conversationState.ts`, test de tabla):

| Estado actual | Entrada | Estado siguiente | Evidencia |
| --- | --- | --- | --- |
| * | `user_prompt` (`source` user/ausente) | `running` | `hook:UserPromptSubmit` |
| `running` | `turn_end` con `background_tasks` vacío | `waiting_input` | `hook:Stop` |
| `running` | `turn_end` con `background_tasks` no vacío | `waiting_background` | `hook:Stop` |
| `running`/`waiting_*` | `turn_failed` | `error` | `hook:StopFailure` |
| * | `notification{permission_prompt}` o `permission_request` | `waiting_permission` | `hook:Notification` |
| `waiting_permission` | `tool_start`/`tool_end` | `running` | hook |
| * | `notification{idle_prompt}` | `waiting_input` | `hook:Notification` |
| * | `session_end` | `ending` → `ended` tras 5 s sin eventos | `hook:SessionEnd` |
| `ending` | cualquier evento del mismo `session_id` | estado según el evento | — |
| * | `probe{found:false}` con contenedor running | `ended` | `probe:absent` |
| * | `probe{status}` | `busy`→`running`, `waiting`+`input needed`→`waiting_input`, `waiting`+`permission prompt`→`waiting_permission`, `idle`→`waiting_input` | `probe:<status>` |
| * | contenedor no running | `disconnected` | `reconcile` |
| * | sin eventos ni probe exitoso en 10 min con contenedor running | `unknown` | `timeout` |

Un probe exitoso *MUST* tener prioridad sobre el último hook si es más reciente; un hook *MUST*
tener prioridad sobre un probe anterior. Se decide por `status_at`.

---

## 6. API y WS (3.1)

Todas owner-only (`assertOwnedByOr404`), rate limit `conversationIp` (300/min), `InFlightLimiter`
4 por usuario / 16 global para lecturas de archivo.

| Método | Ruta | Respuesta |
| --- | --- | --- |
| GET | `/api/sessions/:id/conversations` | `{ conversations: [{ sessionId, kind, title, status, statusEvidence, statusAt, tabId, paneId, startedAt, endedAt, lastEventAt, lastSeq, eventsCount, gapsCount, claudeVersion, parentSessionId, parentInferred, canSendInput }] }` |
| GET | `/api/sessions/:id/conversations/:cid/events?before=<seq>&limit=<n≤500>` | `{ events: [...], hasMore }` (orden ascendente por `seq`; `before` exclusivo) |
| GET | `/api/sessions/:id/conversations/:cid/agents` | `{ agents: [{ agentId, agentType, status, startedSeq, endedSeq?, toolCount, hasResult }] }` |
| WS | `/ws/conversation/<id>` | ver §6.1 |

`canSendInput` *MUST* ser `false` siempre mientras 3.2 no esté desplegado y activado.

### 6.1 Protocolo WS

Cliente → servidor: `{type:"subscribe", conv:<cid>, after:<seq>}`, `{type:"unsubscribe", conv}`.
Servidor → cliente: `{type:"hello", conversations:[{cid,lastSeq,status}]}`, `{type:"event", conv,
event}`, `{type:"status", conv, status, evidence, at}`, `{type:"error", code}`.

- Tras `subscribe`, el servidor *MUST* enviar todos los eventos persistidos con `seq > after` en
  orden y después los nuevos sin huecos ni duplicados (listener armado antes del replay, cola
  drenada en orden; test idéntico en espíritu al de `flushTail` del terminal).
- Máximo 8 suscripciones por socket; un socket por pestaña del navegador.

---

## 7. Comando y endpoint de activación (3.0d)

| Superficie | Auth | Efecto |
| --- | --- | --- |
| `PATCH /api/admin/sessions/:id/conversation {enabled}` | admin | escribe/borra `conversation.json`; si el contenedor corre y la función se habilita, genera y aplica token solo en el siguiente `start` (env inmutable) y responde `{ enabled, effectiveAfterRestart: boolean }` |
| `CONVERSATION_ALLOW_USERS=<id,id>` | env | sesiones nuevas de esos usuarios nacen habilitadas |
| `npm run conversation:disable -- <sid>|--all` | shell host | borra archivos; no toca D1 |
| `GET /api/admin/stats` → `conversation` | admin | `{ enabledSessions, eventsSinceBoot, rejectedSinceBoot, gapsSinceBoot, bytesOnDisk, queueDepthMax }`; **sin** títulos ni ids de conversación |

---

## 8. Composer (3.2) — contrato condicionado

Se implementa únicamente si el usuario aprueba 3.2 tras la validación de §8.2. Hasta entonces
`POST /api/sessions/:id/conversations/:cid/messages` no existe.

### 8.1 Contrato

Body `{ text: string ≤ L1, clientMessageId: uuid }`. Respuestas:

| Código | `error` | Cuándo |
| --- | --- | --- |
| 202 | — | `{ result: "delivered", promptId }` o `{ result: "unconfirmed" }` |
| 409 | `not-interactive` | `kind ≠ interactive` o sin binding |
| 409 | `busy` | probe `busy` |
| 409 | `needs-terminal` | probe `waitingFor ∉ {∅, input needed}`, `pane_in_mode`, `pane_dead`, foreground ≠ claude |
| 409 | `send-in-progress` | lock tomado |
| 409 | `probe-failed` | probe sin respuesta: **no se envía** |
| 403 | — | observadores, lead |

Invariantes (*MUST*, con tests sobre un `tmux` simulado):

1. El cliente nunca nombra pane, tab, ventana ni teclas.
2. Un `clientMessageId` produce como máximo un `paste-buffer`.
3. Ante cualquier precondición no verificable, no se envía.
4. `\n` en `text` no produce `Enter`; solo el `send-keys Enter` final.
5. El ack compara `normalize(text) === normalize(prompt)` con `normalize` definida tras §8.2.
6. Todo envío deja un `composer_send` persistido y, si es cross-user, una fila `operate`.

### 8.2 Validación previa (resultados a adjuntar al PR 3.2)

Experimentos con el CLI 2.1.308 real en un contenedor de prueba, cada uno con resultado esperado,
observado y decisión:

1. Paste + Enter con composer vacío / con texto a medio escribir / en copy-mode / con `/config`
   abierto / con Claude `busy`.
2. `/clear`, `/resume <otra>`, `/fork`, `exit` + `claude` en el mismo pane: latencia entre el cambio
   y la actualización del binding; tamaño de la ventana de carrera.
3. Prompts multilínea, bloques de código, líneas que empiezan por `/`, `!`, `@`, texto de tamaño L1.
4. Qué transforma el CLI en `UserPromptSubmit.prompt` respecto al texto pegado (espacios, CRLF,
   menciones, comandos) → definición de `normalize`.
5. `paste-buffer` con y sin `-p`.
6. Issue #444 (clientes tmux acumulados) cerrado y verificado (`tmux list-clients` = clientes vivos).

---

## 9. Retención y purga

- Soft delete (`DELETE /api/sessions/:id`): conserva `.conversations/<sid>` y `.claude-managed/<sid>`.
- Hard delete (`?hard=true`): purga ambos (mismo guard de ruta que `purgeWorkspace`).
- `CONVERSATION_TTL_DAYS` (opcional, unset = sin TTL): conversaciones `ended` con
  `ended_at` más antiguo se purgan (archivo + fila) en un sweeper diario.
- Backup (#240): `claude_conversations` entra en `TABLES`; `.conversations/` entra en el tarball por
  sesión; `.claude-managed/` **no** (se regenera).
- SECURITY.md recibe la sección "Conversation events at rest" con este contrato.

---

## 10. Criterios de aceptación por PR

### 3.0b backend (desactivado)

- [ ] Migración v16; `ingest_token_hash` NULL para sesiones existentes.
- [ ] Con `CONVERSATION_ENABLED=false`: `spawn` no escribe `conversation.json`, no inyecta token;
      el endpoint responde 204 y `ingest_rejected{disabled}` crece; ningún archivo bajo
      `.conversations/`.
- [ ] Con la bandera activa y una sesión habilitada (test de integración con dockerode mock):
      archivo generado byte a byte igual a §2.2 (con `PORT` real); bind ro; token de 64 hex y hash.
- [ ] Ingesta: tests de §3.1 (todas las filas), §3.2 (`session_mismatch`), dedupe, L1–L6, R1/R2,
      `summarizeToolInput` (tabla §4.3 + claves sensibles), `gap` de §4.5, `seq` monótono bajo
      concurrencia, 204 antes de persistir (fallo de disco simulado ⇒ 204 + `gap backpressure`).
- [ ] Máquina de estados: tabla §5.3 completa como test de tabla; prioridad hook/probe por `status_at`.
- [ ] Reinicio: `last_seq` se recupera del archivo aunque D1 diga otra cosa; `gap backend_restart`.
- [ ] Sin llamadas D1 por evento (contador `getD1CallsSinceBoot` estable durante 1000 eventos).
- [ ] Hard delete purga; soft delete conserva; `isRestrictedPath` sigue denegando `.st/`.
- [ ] `docs/DEPLOYMENT.md`: alias `st-backend`, variables nuevas, kill switch, rotación = restart.

### 3.0c imagen

- [ ] Directorio vacío + script presentes; pin 2.1.308; smoke test: sin archivo ⇒ cero peticiones a
      un receptor local (servidor en el propio test); con archivo ⇒ `session_start`, `user_prompt`,
      `assistant_delta{final}`, `turn_end`, `session_end` con los campos de §4.2; receptor cerrado ⇒
      duración de `claude -p` ≤ base + 1 s × eventos; borrar el archivo ⇒ la siguiente sesión no
      emite; (informativo) recarga en caliente.
- [ ] README de la imagen: sección "Conversation hooks (managed settings)".

### 3.0d activación

- [ ] Endpoint admin + allowlist + stats; habilitar/deshabilitar refleja el archivo en ≤ 1 s;
      stats sin títulos/ids.
- [ ] Prueba manual documentada en el PR: una sesión real habilitada produce eventos visibles en
      `GET …/conversations` y en el archivo; deshabilitar para la emisión (o al siguiente start).

### 3.1 vista

- [ ] Overlay Chat con `viewSwitch`; owner-only en todas las rutas (403→404); `canSendInput=false`.
- [ ] Replay + live determinista (test del broadcaster); paginación hacia atrás; 20k eventos < 500 ms.
- [ ] "Copiar informe" copia `last_assistant_message` sin alteraciones; con `truncated` lo indica.
- [ ] `gap` y `truncated` visibles; eventos `agent_id` fuera del hilo principal; estados con
      evidencia y hora; móvil: una columna, sin scroll horizontal, composer deshabilitado con motivo.

### 3.2 composer (condicionado)

- [ ] §8.1 completo; resultados de §8.2 en el PR; issue de clientes tmux cerrado.

### 3.3 agentes y teams

- [ ] Vista de subagente con resultado final y herramientas; forks/`-p`/teammates como
      conversaciones; Chat como vista inicial configurable.

### 3.4 notificaciones y backfill

- [ ] Push solo al owner, solo en transiciones a `waiting_*`; backfill solo con bandera, eventos
      `imported`, nunca rompe la vista ante formato desconocido.
