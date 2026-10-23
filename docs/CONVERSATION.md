# Conversation & Agent Activity — contrato técnico (Fase 3)

Estado: **v1.3 (3.0a, tras las rondas 1 a 3 de revisión Work), vinculante para los PRs 3.0b–3.4.** El
razonamiento está en [docs/design/phase3-conversation-activity.md](./design/phase3-conversation-activity.md);
este archivo define lo que el código debe cumplir y lo que cada PR debe demostrar. Cambiar un
contrato exige un PR de docs antes o junto con el código.

Convenciones: *MUST*/*MUST NOT* son requisitos verificados por test; *SHOULD* son requisitos
verificados en revisión. "Bytes" significa siempre bytes UTF-8 del contenido, salvo donde se dice
"bytes del cuerpo" (serialización JSON en el cable).

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
| Archivo de hooks por sesión | host `<WORKSPACE_ROOT>/.claude-managed/<st_session_id>/conversation.json`, montado **ro** en `/etc/claude-code/managed-settings.d/` | backend, según la tabla §2.4 |
| Token de ingesta | env `ST_INGEST_TOKEN` del contenedor (32 bytes aleatorios, hex) | backend, en `spawn`/`startContainer`, solo si la sesión está *solicitada* (§2.4) |
| Estado solicitado | D1 `sessions.conversation_requested INTEGER NOT NULL DEFAULT 0` | API admin / allowlist / comando de emergencia |
| Estado efectivo | derivado: `ingest_token_hash IS NOT NULL` ∧ archivo presente ∧ contenedor arrancado con el token | backend (`reconcile` lo recalcula) |

Reglas:

- El directorio host `.claude-managed/<sid>` *MUST* existir (vacío si no aplica) antes de
  `container.start()`, igual que `.uploads/<sid>`; el bind es siempre `ro`.
- La imagen *MUST* comportarse de forma idéntica a la actual cuando el directorio montado está
  vacío (smoke test: `claude -p hola` no produce ninguna petición saliente a `st-backend`).
- `CONVERSATION_ENABLED=false` (default) ⇒ la ingesta rechaza todo (`disabled`), la habilitación
  responde 409 `conversation-disabled`, y el `reconcile` de arranque **borra** cualquier
  `conversation.json` existente (apagado global persistente aunque haya filas solicitadas).

### 2.2 Contenido de `conversation.json`

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "/opt/st/hooks/session-start.sh", "async": true }] }],
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
- El hook `SessionStart` es `async: true` y **no lleva `timeout`**: la documentación oficial dice
  que `timeout` no se aplica a hooks de comando asíncronos, así que el script se acota a sí mismo
  (§2.3).
- Ningún hook de este archivo *MUST* devolver un cuerpo con `decision`, `permissionDecision`,
  `continue`, `updatedInput`, `additionalContext` ni `displayContent`: el receptor responde **204 sin
  cuerpo** en todos los casos (test).

### 2.3 `session-start.sh`

Entrada: JSON de `SessionStart` por stdin. Comportamiento:

1. Primera línea ejecutable: `exec timeout -k 1 5 /opt/st/hooks/session-start-body.sh "$@"` (o el
   equivalente en un solo archivo con `[ -z "$ST_HOOK_WRAPPED" ] && ST_HOOK_WRAPPED=1 exec timeout
   -k 1 5 "$0"`). **El script entero, con todos sus subprocesos, termina en ≤ 6 s pase lo que pase.**
2. Si `ST_INGEST_TOKEN` está vacío o no definido: exit 0 sin salida ni red.
3. Construye el JSON de salida = entrada + `{ "st": { "claude_version", "tmux_session", "pane",
   "argv_flags" } }` donde:
   - `claude_version` = `timeout 3 claude --version` (null si falla);
   - `tmux_session` = `timeout 1 tmux display-message -p '#S'` (null si falla o no hay tmux);
   - `pane` = `$TMUX_PANE` o null;
   - `argv_flags` = **solo** las banderas del proceso padre que estén en la allowlist
     `-p --print --bare --resume --continue --fork-session --agent --agent-name --agent-id
     --teammate-mode --dangerously-skip-permissions --permission-mode`, sin valores salvo el de
     `--agent-name`/`--agent-type`/`--teammate-mode`/`--permission-mode` (≤ 64 bytes cada uno).
     Nunca se persiste el argv completo (puede llevar `--append-system-prompt`, rutas o secretos).
4. `curl --silent --max-time 2 -X POST -H 'Content-Type: application/json' -H "Authorization: Bearer
   $ST_INGEST_TOKEN" -H "X-ST-Session: $SESSION_ID" -H "X-ST-Tmux-Pane: $TMUX_PANE" --data-binary
   @- http://st-backend:3001/ingest/claude/hook`. Cualquier fallo ⇒ exit 0.
5. Nunca escribe en stdout. Errores a stderr solo con `ST_HOOKS_DEBUG=1`.

### 2.4 Activación: estado solicitado frente a estado efectivo

El env de un contenedor Docker es inmutable; el archivo montado y D1 no lo son. Por eso hay dos
estados y una tabla de transiciones. *MUST* implementarse exactamente así y cubrirse con tests:

| Acción | Contenedor | Token en env | `ingest_token_hash` | `conversation.json` | Resultado / respuesta |
| --- | --- | --- | --- | --- | --- |
| Habilitar (`requested=1`) | parado | se generará en `start` | NULL hasta `start` | se escribe en `start` | `{enabled:true, effective:false, effectiveAfterRestart:true}` |
| Habilitar | corriendo **sin** token | ausente (inmutable) | NULL | **no se escribe** (hooks sin token solo generarían tráfico rechazado) | `{enabled:true, effective:false, effectiveAfterRestart:true}` |
| Habilitar | corriendo **con** token (fue deshabilitada y rehabilitada sin reinicio) | presente | se **restaura** el hash guardado en `ingest_token_hash_suspended` | se reescribe | `{enabled:true, effective:true}`; el CLI recarga o aplica al siguiente start |
| Deshabilitar (`requested=0`) | corriendo con token | presente (inmutable, inofensivo) | se mueve a `ingest_token_hash_suspended`, queda NULL ⇒ **la ingesta rechaza desde ya** | se borra ⇒ el CLI deja de emitir al recargar o en el siguiente start | `{enabled:false, effective:false, emissionStopsAfterRestart:<bool según recarga verificada>}` |
| Deshabilitar | parado | — | NULL | se borra | `{enabled:false, effective:false}` |
| Emergencia `npm run conversation:disable -- <sid>\|--all` | cualquiera | — | **NULL** en D1 y `conversation_requested=0` (persistente: el siguiente `start` no regenera nada) | borrado | orden estricto §2.5: marca de revocación → D1 → archivos; confirma éxito solo al terminar los tres pasos; falla (≠ 0) si D1 no responde, dejando la marca puesta |
| `start` / `spawn` | — | nuevo si `requested=1` ∧ `CONVERSATION_ENABLED` | nuevo hash o NULL | escrito si `requested=1` ∧ `CONVERSATION_ENABLED`, si no borrado | — |
| `reconcile` (arranque del backend) | cada sesión `running` | — | — | archivo presente ⇔ `requested=1` ∧ hash no NULL ∧ `CONVERSATION_ENABLED`; se corrigen desajustes (borrar huérfanos; nunca crear sin token) | log por corrección |

Invariantes:

- **La ingesta deja de aceptar antes de que el flip se confirme al operador**, tanto por la API
  (invalidación pre/post en proceso) como por el comando de emergencia (marca de revocación §2.5),
  independientemente de cuándo deje de emitir el CLI.
- Un archivo `conversation.json` *MUST NOT* existir si `ingest_token_hash IS NULL` para esa sesión.
- "Efectivo" se informa en `GET /api/sessions/:id/conversations` como `capture: { requested,
  effective, effectiveAfterRestart }`, para que la UI no prometa captura que no ocurre.
- La recarga en caliente del CLI es *informativa*: el smoke test la mide y el campo
  `emissionStopsAfterRestart` se fija según el resultado para la versión fijada. Hasta tener la
  medición, se asume **false** (no recarga) y la documentación de operador lo dice.

### 2.5 Revocación entre procesos (comando de emergencia)

El comando corre en otro proceso y no puede invalidar la cache de tokens del receptor. Por eso la
autorización de ingesta tiene **dos** fuentes y la revocación es un archivo que ambos procesos ven:

- Marca por sesión: `<WORKSPACE_ROOT>/.conversations/<st_session_id>/REVOKED`. Marca global:
  `<WORKSPACE_ROOT>/.conversations/REVOKED_ALL`. (Este directorio no se monta en ningún
  contenedor de sesión.) Contenido: `{ "at": <ISO>, "by": "cli|api", "reason"? }`. Se escriben con
  `write` a temporal + `fsync` + `rename` (atómico).
- **Receptor**: en **cada** evento, como último paso de la autorización y antes de encolar, hace
  `stat` de ambas marcas. **No hay cache del resultado, ni positivo ni negativo**: un resultado
  negativo cacheado permitiría aceptar un evento después del `rename` (contraejemplo: stat a t=0,
  rename a t=10 ms, evento aceptado por cache a t=20 ms). Coste: dos `stat` por evento aceptado
  (microsegundos; a R1 máximo son 100 `stat`/s por sesión). Marca presente ⇒ 204
  `ingest_rejected{reason=revoked}`, entrada de cache de tokens eliminada, y el archivo
  `conversation.json` de esa sesión se borra si existe (el receptor converge aunque el comando se
  haya interrumpido antes del paso 3). La cache de tokens tiene además TTL de 60 s.
- **Eventos ya autorizados**: una autorización que terminó antes del `rename` pudo dejar un evento
  en la cola por conversación (acotada por L6). Esos eventos **se persisten** (fueron emitidos
  legítimamente antes del corte); al observar la marca por primera vez, el receptor añade un único
  `gap{reason: revoked}` al final de cada cola afectada y la UI lo muestra como "captura revocada".
  No se descartan, porque descartar perdería datos legítimos y no mejora la garantía, que trata
  sobre aceptar, no sobre persistir.
- **Comando** `conversation:disable`, orden estricto por sesión: (1) escribir la marca y `fsync`
  del directorio; (2) D1: `conversation_requested=0`, `ingest_token_hash=NULL`,
  `ingest_token_hash_suspended=NULL`; (3) borrar `conversation.json`. Imprime `revoked <sid>` solo
  tras (3). Si (2) falla: sale ≠ 0, deja la marca puesta (el corte sigue vigente) y lo dice; no
  pasa a (3).
- **API** (`PATCH … {enabled:false}`): mismos tres pasos, más la invalidación pre/post en proceso.
  `{enabled:true}` es la única operación que **quita** la marca por sesión (tras actualizar D1); la
  marca global solo la quita `npm run conversation:enable-all` explícito. Con marca global presente,
  `PATCH {enabled:true}` responde 409 `revoked-globally`.
- `reconcile` al arrancar: una marca presente fuerza `conversation_requested=0` y hash NULL en D1 si
  D1 dijera otra cosa (la marca gana), y borra el archivo de hooks.

Garantía: **toda autorización que comience después de que el `rename` de la marca retorne
rechaza el evento**, en cualquier proceso receptor de esa máquina, con cache de tokens poblada o
no. Las autorizaciones que comenzaron antes pueden completarse y sus eventos persistirse según el
punto anterior.

Regresión obligatoria (3.0b): dos procesos reales (el receptor con su cache de tokens ya poblada
por un evento aceptado, y el comando ejecutado con `child_process`), sin reiniciar el receptor: el
evento enviado **inmediatamente** después del retorno del comando, sin esperar ningún intervalo,
es rechazado con `reason=revoked`; el test se repite 100 veces para cubrir el intercalado. Variante
con D1 simulado caído: el comando sale ≠ 0, la marca queda, el evento sigue rechazado y
`conversation.json` sigue presente hasta que el receptor lo borra al procesar el siguiente evento.
Variante con cola poblada: los eventos ya autorizados antes del `rename` aparecen persistidos,
seguidos de exactamente un `gap revoked`.

---

## 3. Endpoint de ingesta

`POST /ingest/claude/hook` — fuera de `/api`, montado antes de `express.json`, `cookieParser` y
CORS, con parser JSON propio limitado a **L5 bytes del cuerpo**.

### 3.1 Autenticación y respuesta

| Condición | Respuesta | Efecto |
| --- | --- | --- |
| Falta `Authorization` o `X-ST-Session` | 204 | contador `ingest_rejected{reason=missing_auth}` |
| Sesión con `conversation_requested=0`, o `CONVERSATION_ENABLED=false` | 204 | `ingest_rejected{reason=disabled}` |
| Marca de revocación presente (§2.5) | 204 | `ingest_rejected{reason=revoked}`; entrada de cache eliminada; `conversation.json` borrado |
| Token no coincide con `ingest_token_hash`, o sesión no `running` | 204 | `ingest_rejected{reason=bad_token\|not_running}` |
| `Content-Length` ausente, > L5, o cuerpo que supera L5 al leerse, o JSON inválido | 204 | `ingest_rejected{reason=too_large\|invalid_json}` + `gap malformed` si se identificó la conversación (§3.3) |
| Más de **G2** cuerpos grandes en vuelo | 204 | descartado + `gap backpressure{scope: ingest}` |
| Evento válido | 204 | encolado; persistencia asíncrona |

- *MUST* responder siempre 204 con cuerpo vacío en ≤ 50 ms p99 con el disco sano (la persistencia
  no está en el camino de la respuesta).
- *MUST NOT* devolver 401/403/429.
- Rate limit por sesión ST, **token bucket**: R1 = 500 eventos de capacidad, recarga 50/s; R2 =
  capacidad **24 MiB**, recarga 24 MiB/60 s, consumo = `Content-Length`. Con el bucket lleno, un solo
  evento de L5 bytes siempre cabe (capacidad ≥ L5). Exceso ⇒ descartado + un único
  `gap{reason: rate_limited, dropped: n, dropped_bytes}` por ventana de 10 s.
- Cola por conversación acotada en **L6** y total del proceso en **G1**; overflow ⇒ descartado +
  `gap{reason: backpressure, scope: conversation|global}`.

### 3.2 Headers de correlación

| Header | Origen | Validación |
| --- | --- | --- |
| `X-ST-Session` | `$SESSION_ID` del contenedor | *MUST* existir en `sessions` y coincidir con el token. El `session_id` del cuerpo (Claude) se asocia a esta sesión ST; un `session_id` ya asociado a **otra** sesión ST ⇒ descartado (`ingest_rejected{reason=session_mismatch}`). |
| `X-ST-Tmux-Pane` | `$TMUX_PANE` | `^%\d{1,6}$` o vacío (sin tmux: `-p` del exec API). |

### 3.3 Cuerpos que no se pueden parsear

Si el cuerpo excede L5 o no es JSON, el receptor no conoce el `session_id` de Claude. Para no
perder la transición de estado en silencio, el `gap malformed` se escribe en la conversación
**activa más reciente de esa sesión ST con el mismo `X-ST-Tmux-Pane`** (si hay exactamente una
candidata); si no hay candidata única, se cuenta en `ingest_rejected` y en
`sessions_conversation_stats.unattributed_gaps` para que el admin lo vea agregado.

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
| `session_start` | `SessionStart` (+`st` del script) | `source`, `agent_type?`, `model?`, `session_title?`, `claude_version?`, `tmux_session?`, `argv_flags?`, `cwd`, `transcript_path` | — |
| `session_end` | `SessionEnd` | `reason` | — |
| `user_prompt` | `UserPromptSubmit` | `prompt`, `source?`, `session_title?` | **L1** (truncado visible) |
| `assistant_delta` | `MessageDisplay` | `message_id`, `index`, `final`, `delta` | acumulado por `message_id` ≤ **L2** |
| `tool_start` | `PreToolUse` | `tool_use_id`, `tool_name`, `summary` (§4.3), `mcp_server?` | **L4** |
| `tool_end` | `PostToolUse` | `tool_use_id`, `tool_name`, `ok: true`, `duration_ms?`, `response_bytes` | — |
| `tool_failed` | `PostToolUseFailure` | `tool_use_id`, `tool_name`, `ok: false`, `is_interrupt?`, `duration_ms?`, `error_bytes`, y `error` **solo** según §4.3.3 | L4 |
| `turn_end` | `Stop` | `last_assistant_message`, `background_tasks[]` (solo `id`, `type`, `status`), `session_crons_count` | `last_assistant_message` ≤ **L3** (truncado visible) |
| `turn_failed` | `StopFailure` | `error` (enum del CLI), `error_details?` | L4 |
| `agent_start` | `SubagentStart` | `agent_id`, `agent_type` | — |
| `agent_end` | `SubagentStop` | `agent_id`, `agent_type`, `last_assistant_message`, `agent_transcript_path`, `background_tasks[]` (ídem) | **L3** |
| `notification` | `Notification` | `notification_type`, y `message`/`title` **solo** según §4.3.3 | L4 |
| `permission_request` | `PermissionRequest` | `tool_name`, `summary` (§4.3) | L4 |
| `compact` | `PreCompact`/`PostCompact` | `phase: pre\|post`, `trigger` | (sin `compact_summary`) |
| `task_created` / `task_completed` | `TaskCreated`/`TaskCompleted` | `task_id`, `task_subject`, `teammate_name?` | `task_subject` ≤ L4 (sin `task_description`) |
| `teammate_idle` | `TeammateIdle` | `teammate_name` | — |
| `gap` | backend | `reason`, `scope?`, `dropped?`, `dropped_bytes?`, `range?`, `detail?` | — |
| `probe` | backend | `status`, `waitingFor?`, `found: boolean` | — |
| `composer_send` | backend (3.2) | `clientMessageId`, `result`, `prompt_id?` | — |

Campos no listados *MUST NOT* persistirse (parser tolerante: se descartan y se cuentan en
`ingest_fields_dropped`). `prompt` y `last_assistant_message` son el contenido de la conversación:
pueden contener lo que el usuario y el agente hayan escrito, con el mismo nivel de sensibilidad
que el transcript del CLI; esa es la razón del owner-only y de la retención de §9.

### 4.3 Política de redacción de entradas de herramientas

**Principio (nivel 0, único nivel en 3.x): el resumen persistido solo contiene identificadores
estructurales, nunca argumentos completos ni texto libre.** Una denylist de nombres de clave no
elimina secretos embebidos en valores (`command`, URLs, cabeceras, asignaciones de entorno), así que
no se usa como garantía: los valores libres directamente no se persisten.

#### 4.3.1 `summarizeToolInput(tool_name, tool_input) → summary`

Función pura con tests de tabla:

| Herramienta | `summary` persistido | Lo que **no** se persiste |
| --- | --- | --- |
| `Bash` | `programs`: nombre base del **primer** token de cada segmento separado por `\|`, `&&`, `\|\|`, `;` (máx. 8, cada uno ≤ 32 bytes, solo `[A-Za-z0-9._-]`), saltando asignaciones simples `VAR=…`; un segmento que empieza por `sudo`, `env`, `nohup`, `time`, `exec`, `export`… o por una bandera se **omite** (no se adivina dónde empieza el programa). **Si el comando contiene comillas, backslash, `$`, `(`, `)`, `{`, `}`, `<` o `>`, la sintaxis es ambigua y `programs` se omite por completo (`programs_omitted: true`)** — nunca se tokeniza shell. `command_bytes`; `run_in_background?` | `command` completo, `description`, cualquier argumento, URL, cabecera, variable |
| `Read`, `Edit`, `Write`, `MultiEdit`, `NotebookEdit` | `file_path` (≤ 512 bytes), `offset`/`limit` en Read | contenido, `old_string`/`new_string` |
| `Grep`, `Glob` | `path` (≤ 512) y `pattern_bytes` | `pattern` (puede ser un valor buscado) |
| `Agent` | `subagent_type`, `description` (≤ 128; es un rótulo de 3-5 palabras por contrato del tool) | `prompt` |
| `WebFetch` | `host` (solo el host de `url`) | ruta, query, `prompt` |
| `WebSearch` | `query_bytes` | `query` |
| `TodoWrite`, `TaskCreate`… | `count` de ítems | textos |
| `mcp__*` y desconocidas | lista de **nombres** de claves de primer nivel (≤ 16, ≤ 64 bytes cada uno) | cualquier valor |

Ejemplos que *MUST* estar en el test (entrada → `summary`):

| `tool_input` | `summary` |
| --- | --- |
| `{"command":"curl -H 'Authorization: Bearer SECRETO' https://example.test"}` | `{"command_bytes":61,"programs_omitted":true}` (comillas ⇒ ambiguo) |
| `{"command":"curl https://example.test"}` | `{"programs":["curl"],"command_bytes":25}` |
| `{"command":"AWS_SECRET_ACCESS_KEY=abc aws s3 ls \| head"}` | `{"programs":["aws","head"],"command_bytes":45}` |
| `{"command":"git clone https://user:tok3n@github.com/x/y.git && cd y"}` | `{"programs":["git","cd"],"command_bytes":57}` |
| `{"command":"echo $TOKEN \| base64 -d > /tmp/k"}` | `{"command_bytes":33,"programs_omitted":true}` (`$`/`>` ⇒ ambiguo) |
| `{"command":"curl -d \"user\|password123\" https://x"}` | `{"command_bytes":37,"programs_omitted":true}` (un separador dentro de comillas nunca produce un "programa") |
| `{"url":"https://api.example.test/v1/users?api_key=XYZ","prompt":"…"}` | `{"host":"api.example.test"}` |
| `{"pattern":"sk-live-[0-9a-z]+","path":"src"}` | `{"path":"src","pattern_bytes":17}` |
| `{"server":"x","headers":{"Authorization":"Bearer Y"},"body":"…"}` (MCP) | `{"keys":["server","headers","body"]}` |

#### 4.3.2 Lo que sí puede contener secretos y se persiste a sabiendas

- `user_prompt.prompt` y `last_assistant_message` (contenido de la conversación).
- `file_path` (una ruta puede ser reveladora; se acepta como identificador).
- `Agent.description` (rótulo breve escrito por el modelo).

Esto se documenta en SECURITY.md junto con la retención y el owner-only; no se afirma ninguna
"eliminación de secretos".

#### 4.3.3 Texto libre de errores y notificaciones

| Campo | Regla |
| --- | --- |
| `tool_failed.error` | Se persiste (≤ 512 bytes) solo si `tool_name ∉ {Bash, mcp__*}`. Para Bash y MCP solo `error_bytes` y, si se puede extraer con `/exit code (\d+)/i`, `exit_code`. |
| `notification.message`, `title` | Se persisten (≤ L4) solo para `notification_type ∈ {idle_prompt, agent_completed, agent_needs_input, auth_success, elicitation_complete, quota_*}`. Para `permission_prompt` y el resto solo `notification_type`. |
| `turn_failed.error_details` | ≤ 512 bytes; el CLI ya lo produce sin contenido de usuario. |

### 4.4 Límites unificados

Contenido (bytes UTF-8 del valor) frente a cuerpo (bytes del JSON serializado por el CLI). La
serialización JSON puede multiplicar: `\n` ×2, caracteres de control `\u00XX` ×6, `"` y `\` ×2.
Por eso **L5 ≥ 6 × L3 + 1 MiB de envoltura**.

| Id | Qué | Valor | Al exceder |
| --- | --- | --- | --- |
| **L1** | `user_prompt.prompt` (contenido) | 64 KiB | truncar + `truncated: true, original_bytes` |
| **L2** | texto acumulado de un `message_id` (contenido), con la ventana de §4.4.1 | 1 MiB | el delta que cruza se corta (UTF-8) con `truncated: true, original_bytes`; los siguientes se descartan, salvo un `final`, que se persiste vacío con el flag |
| **L3** | `last_assistant_message` (`turn_end`, `agent_end`) (contenido) | **1 MiB** | truncar + `truncated: true, original_bytes`; la UI lo dice en "Copiar informe" |
| **L4** | strings auxiliares (`summary`, `error`, `message`, `task_subject`, …) (contenido) | 2 KiB | truncar con marcador `…[+N chars]` |
| **L5** | cuerpo HTTP de ingesta (bytes del cuerpo) | **8 MiB** | 204 + `gap malformed{reason: too_large}` según §3.3 |
| **L6** | cola en memoria por conversación | 256 eventos o 8 MiB | `gap backpressure{scope: conversation}` |
| **L7** | archivo `events.jsonl` | 64 MiB | rotar a `.1` (una sola generación; `.1` anterior se borra) + `gap{reason: rotated}` al inicio del nuevo; `first_retained_seq` en el índice |
| **L8** | eventos montados en el DOM | 500 eventos **y** 8 MiB de texto | ventana por `seq`; los no montados son placeholders; "Copiar informe" pide el evento al servidor si no está montado |
| **G1** | suma de colas en memoria de todas las conversaciones | 64 MiB | `gap backpressure{scope: global}` en la conversación cuya cola es mayor |
| **G2** | cuerpos de ingesta > 1 MiB en vuelo simultáneos | 4 | 204 + `gap backpressure{scope: ingest}` |
| **G3** | bytes en vuelo por socket WS (`bufferedAmount` + frame a enviar), comprobado **antes de cada frame**, no por lote | replay: ≤ 2 MiB, con una única excepción de un frame cuando el buffer está vacío (máx. en vuelo = 2 MiB + el **frame serializado** más grande; un contenido de L3 escapado puede serializar a ~6 MiB, así que la cota es ~8 MiB, no L3); live: resync a 8 MiB (§6.1) | esperar `drain`, 1013 o `resync`; nada se pierde: el cliente re-suscribe desde su último `seq` |
| **G4** | índices (`index.json`) residentes en memoria | LRU de 64 conversaciones; cada índice ≤ 4 MiB (se resume por turnos, no por eventos) | desalojo; recarga desde disco al siguiente acceso |
| **G5** | bytes por respuesta de `GET …/events` | 8 MiB | corta antes y devuelve `hasMore: true` |
| **R1/R2** | tasa por sesión ST | §3.1 | `gap rate_limited` |

Garantía (test obligatorio): para cualquier `last_assistant_message` de ≤ L3 bytes formado por
cualquiera de estos repertorios: `\n` puro, `\u0001` puro, `"`/`\` puro, emoji de 4 bytes, texto
mixto, la serialización `JSON.stringify` del input completo del hook `Stop` (con `background_tasks`
de 50 entradas y `transcript_path` de 512 bytes) **es ≤ L5** y **≤ capacidad de R2**. Un informe que
supere L3 en contenido se trunca de forma visible; un cuerpo que supere L5 se trata según §3.3.
**Ningún truncado es silencioso.**

#### 4.4.1 Alcance de L2: mensajes activos y ventana de sellados

L2 **no es una garantía histórica absoluta por `message_id`**. Se mantiene, por conversación:

- para todo mensaje **activo** (sin `final` recibido), hasta `MESSAGE_OPEN_MAX` = 256 a la vez; si se supera, el activo más antiguo se **sella** (no se olvida);
- para los **últimos 4.096 ids sellados** (`MESSAGE_SEALED_MAX`): un id sellado por `final` o por el cupo de activos descarta cualquier delta posterior.

La ventana de sellados es FIFO y vive en el índice (snapshot + reconstrucción desde el archivo con las mismas reglas que en vivo). **Cuando un id sale de la ventana, una reaparición posterior de ese id inicia un presupuesto L2 nuevo.** Es una cota deliberada de memoria (≈150 KiB por conversación), aceptada por el responsable el 2026-10-22; no hay persistencia auxiliar. En la práctica el CLI no reutiliza `message_id`, así que el caso solo aparece con ids repetidos de forma anómala.

### 4.5 `gap`: representación de pérdidas

| `reason` | Cuándo | UI |
| --- | --- | --- |
| `rate_limited` | R1/R2 excedidos | "N eventos omitidos por volumen" |
| `backpressure` (`scope: conversation\|global\|ingest`) | L6 / G1 / G2 | "N eventos omitidos (backend saturado)" |
| `malformed` | evento no reconocido / demasiado grande | "Evento no reconocido o demasiado grande (versión del CLI)" |
| `missing_delta` | `assistant_delta.index` no consecutivo | "[… fragmento perdido …]" en el mensaje |
| `missing_prompt` | `turn_end` sin `user_prompt` para su `prompt_id` | "Prompt no capturado" antes del informe |
| `backend_restart` | al reiniciar el backend, por conversación no terminada | "Posible actividad perdida entre HH:MM y HH:MM" |
| `rotated` | L7 | "Historial anterior archivado" |
| `revoked` | captura revocada mientras había eventos autorizados en cola (§2.5) | "Captura revocada a las HH:MM" |
| `history_rotated` | cliente pide `after`/`before` anterior a `first_retained_seq` | "Eventos anteriores ya no disponibles (seq a–b)" |
| `history_unavailable` | conversación conocida por `resume` sin eventos previos | "El historial anterior a la activación no está disponible" |

`claude_conversations.gaps_count` se incrementa por cada `gap` persistido.

### 4.6 Identidad de eventos y deduplicación

Compartir `prompt_id`, turno o pane **nunca** es criterio de duplicado. La deduplicación solo se
aplica con la identidad de la tabla; donde no hay identidad natural se usa el *hash del payload
completo* en una ventana corta, que colapsa reintentos idénticos sin tocar eventos distintos.

| `ev` | Identidad (todas incluyen `session_id` de Claude) | Tratamiento del repetido |
| --- | --- | --- |
| `user_prompt` | `prompt_id` si está presente; si falta, hash del payload en ventana de 10 s | descartar, `dedupe_dropped++` |
| `assistant_delta` | `agent_id?` + `message_id` + `index` | descartar |
| `tool_start` / `tool_end` / `tool_failed` | `ev` + `tool_use_id` | descartar |
| `agent_start` / `agent_end` | `ev` + `agent_id` | descartar |
| `task_created` / `task_completed` | `ev` + `task_id` | descartar |
| `turn_end` / `turn_failed` | **sin identidad natural** (`Stop` puede dispararse varias veces en un mismo `prompt_id` cuando un hook bloquea y el turno continúa): hash del payload en ventana de 10 s | solo se descarta si el payload es idéntico dentro de la ventana |
| `teammate_idle` | `teammate_name` + hash del payload, ventana 10 s | idem |
| `notification`, `permission_request`, `compact`, `session_start`, `session_end` | hash del payload en ventana de 10 s | idem |

Hash = SHA-256 del JSON canónico del input del hook (claves ordenadas) **antes** de redactar.
Ventana = 10 s desde la recepción del original; tamaño de la tabla por conversación ≤ 4096 entradas
(LRU).

Casos que *MUST* estar en el test:

1. Dos `SubagentStop` del mismo `prompt_id` con `agent_id` distintos ⇒ **ambos persistidos**.
2. Dos `TaskCreated` del mismo turno con `task_id` distintos ⇒ ambos.
3. Dos `Notification{idle_prompt}` idénticas separadas 60 s ⇒ ambas; separadas 1 s ⇒ una.
4. Dos `Stop` consecutivos del mismo `prompt_id` con `last_assistant_message` distinto ⇒ ambos;
   idénticos en 1 s ⇒ uno.
5. Dos `PostToolUse` con el mismo `tool_use_id` (reintento) ⇒ uno.
6. `MessageDisplay` mismo `message_id`/`index` repetido ⇒ uno; `index` distinto ⇒ ambos.
7. Dos subagentes emitiendo `PreToolUse` en paralelo con `tool_use_id` distintos ⇒ ambos.

---

## 5. Conversaciones: filas, estados y binding

### 5.1 Creación y enriquecimiento

- Cualquier evento con `session_id` desconocido crea la fila (`kind: unknown`). `session_start`
  fija `kind` (`interactive` por defecto; `headless` si `argv_flags` contiene `-p`/`--print`;
  `teammate` si contiene `--agent-name`/`--agent-id`), `claude_version`, `title` (`session_title`) y
  binding.
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
4 por usuario / 16 global para lecturas de archivo, **G5** bytes por respuesta.

| Método | Ruta | Respuesta |
| --- | --- | --- |
| GET | `/api/sessions/:id/conversations` | `{ capture: { requested, effective, effectiveAfterRestart }, conversations: [{ sessionId, kind, title, status, statusEvidence, statusAt, tabId, paneId, startedAt, endedAt, lastEventAt, lastSeq, firstRetainedSeq, eventsCount, gapsCount, claudeVersion, parentSessionId, parentInferred, canSendInput }] }` |
| GET | `/api/sessions/:id/conversations/:cid/events?before=<seq>&limit=<n≤500>` | `{ events: [...], hasMore, firstRetainedSeq }` (orden ascendente por `seq`; `before` exclusivo; `before ≤ firstRetainedSeq` ⇒ `events: []`, `hasMore: false`) |
| GET | `/api/sessions/:id/conversations/:cid/events/:seq` | un evento (para "Copiar informe" de eventos no montados) |
| GET | `/api/sessions/:id/conversations/:cid/agents` | `{ agents: [{ agentId, agentType, status, startedSeq, endedSeq?, toolCount, hasResult }] }` |
| WS | `/ws/conversation/<id>` | ver §6.1 |

`canSendInput` *MUST* ser `false` siempre mientras 3.2 no esté desplegado y activado.

### 6.1 Protocolo WS y contrapresión

Cliente → servidor: `{type:"subscribe", conv:<cid>, after:<seq>}`, `{type:"unsubscribe", conv}`.
Servidor → cliente: `{type:"hello", conversations:[{cid,lastSeq,firstRetainedSeq,status}]}`,
`{type:"event", conv, event}`, `{type:"gap", conv, reason:"history_rotated", from, to}`,
`{type:"status", conv, status, evidence, at}`, `{type:"resync", conv, fromSeq}`, `{type:"error", code}`.

- Tras `subscribe`, el servidor *MUST* enviar todos los eventos persistidos con `seq > after` y
  `seq ≥ firstRetainedSeq` en orden y después los nuevos sin huecos ni duplicados (listener armado
  antes del replay, cola drenada en orden). Si `after < firstRetainedSeq - 1`, antecede un frame
  `gap history_rotated`.
- Replay con **presupuesto de bytes por frame**, no por lote: el servidor lee el archivo en lotes
  de 200 eventos solo como unidad de E/S, pero antes de enviar **cada** frame calcula su tamaño
  serializado `f` y envía solo si `socket.bufferedAmount + f ≤ 2 MiB`. Si no cabe, espera `drain`
  hasta 30 s; si sigue sin caber, cierra con código **1013** y el cliente reintenta con backoff
  desde su último `seq` recibido. Única excepción: un frame con `f > 2 MiB` se envía cuando
  `bufferedAmount == 0`, de modo que lo máximo en vuelo durante un replay es **2 MiB + el frame
  serializado más grande**. Ese frame no está acotado por L3: el escapado JSON multiplica el
  contenido (un `last_assistant_message` de 1 MiB de `\u0001` serializa a ~6 MiB), así que la cota
  real es ~8 MiB. Sesenta informes de 1 MiB consecutivos producen, para un cliente que no drena,
  como máximo esa cota y después 1013, nunca 60 MiB.
- Live: misma comprobación por frame contra 8 MiB; si no cabe, el servidor deja de reenviar
  eventos a esa suscripción, envía un único `resync{fromSeq: <último enviado>}` cuando el buffer
  baja de 2 MiB, y el cliente re-suscribe con `after = fromSeq`. Nada se pierde porque todo está
  persistido.
- `bufferedAmount` es la cuenta de bytes pendientes de la librería `ws` (`socket.bufferedAmount`);
  el test de cliente lento (§10, 3.1) usa un socket cuyo lado receptor no lee, con 60 eventos de
  1 MiB persistidos **de los cuales al menos uno es contenido de `\u0001` puro** (frame ~6 MiB), y
  afirma que el máximo de `bufferedAmount` observado es ≤ 2 MiB + el frame serializado más grande
  y que el cierre es 1013.
- Máximo 8 suscripciones por socket; un socket por pestaña del navegador; máximo 4 sockets de
  conversación por usuario (el quinto recibe `error{code:"too-many-sockets"}` y 1008).

---

## 7. Comando y endpoint de activación (3.0d)

| Superficie | Auth | Efecto |
| --- | --- | --- |
| `PATCH /api/admin/sessions/:id/conversation {enabled}` | admin | aplica la fila correspondiente de §2.4 y devuelve `{ enabled, effective, effectiveAfterRestart }` |
| `CONVERSATION_ALLOW_USERS=<id,id>` | env | sesiones nuevas de esos usuarios nacen con `conversation_requested=1` |
| `npm run conversation:disable -- <sid>\|--all` | shell host | fila "Emergencia" de §2.4 con el orden de §2.5: marca de revocación, D1, archivos; si D1 falla, deja la marca, no borra archivos y sale ≠ 0 |
| `npm run conversation:enable-all` | shell host | quita `REVOKED_ALL`; no toca filas ni marcas por sesión |
| `GET /api/admin/stats` → `conversation` | admin | `{ enabledSessions, effectiveSessions, eventsSinceBoot, rejectedSinceBoot{byReason}, gapsSinceBoot, unattributedGaps, bytesOnDisk, queueBytesNow, queueBytesMax, wsResyncsSinceBoot }`; **sin** títulos ni ids de conversación |

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
  sesión; `.claude-managed/` **no** (se regenera desde D1 en `reconcile`).
- SECURITY.md recibe la sección "Conversation events at rest" con este contrato, incluida §4.3.2.

---

## 10. Criterios de aceptación por PR

### 3.0b backend (desactivado)

- [ ] Migración v16: `claude_conversations`; `sessions.ingest_token_hash`,
      `sessions.ingest_token_hash_suspended`, `sessions.conversation_requested` (default 0).
- [ ] Con `CONVERSATION_ENABLED=false`: `spawn` no escribe `conversation.json`, no inyecta token;
      el endpoint responde 204 y `ingest_rejected{disabled}` crece; `reconcile` borra archivos
      huérfanos; ningún archivo bajo `.conversations/`.
- [ ] Tabla §2.4 completa como test de tabla (cada fila: estado inicial → acción → D1, archivo,
      respuesta), incluido el comando de emergencia con D1 caído (no borra archivos, sale ≠ 0) y la
      invalidación inmediata de la cache de tokens al deshabilitar por API.
- [ ] Revocación entre procesos (§2.5): la regresión de dos procesos con cache poblada, en sus tres
      variantes (D1 sano con envío inmediato ×100, D1 caído, cola poblada ⇒ persistidos + un `gap
      revoked`); ausencia de cualquier cache del `stat` de marcas (test: marcar entre dos eventos
      consecutivos sin pausa ⇒ el segundo rechazado); `reconcile` con marca presente y D1
      discordante; `PATCH {enabled:true}` quita la marca por sesión y responde 409 con marca global.
- [ ] Con la bandera activa y una sesión solicitada (dockerode mock): archivo generado byte a byte
      igual a §2.2 (con `PORT` real); bind ro; token de 64 hex y hash.
- [ ] Ingesta: todas las filas de §3.1; §3.2 (`session_mismatch`); §3.3 (atribución del `gap` por
      pane única / no única); token bucket R1/R2 con un evento de L5 bytes aceptado con bucket lleno;
      G1/G2 con `gap backpressure{scope}`; L1–L7; `summarizeToolInput` (tablas §4.3.1 completas,
      incluidos los siete ejemplos) y §4.3.3; `gap` de §4.5; `seq` monótono bajo concurrencia; 204
      antes de persistir (fallo de disco simulado ⇒ 204 + `gap backpressure`).
- [ ] Deduplicación: los siete casos de §4.6.
- [ ] L2 (§4.4.1): presupuesto acumulado por mensaje activo, cupo de 256 activos, ventana de 4.096 sellados, y reapertura de presupuesto solo tras expulsar un id de la ventana; todo equivalente tras reinicio.
- [ ] Serialización: la garantía de §4.4 (cinco repertorios × L3) con `JSON.stringify` del input
      completo de `Stop` ≤ L5 y ≤ capacidad R2.
- [ ] Máquina de estados: tabla §5.3 completa; prioridad hook/probe por `status_at`.
- [ ] Reinicio: `last_seq` y `first_retained_seq` se recuperan del archivo aunque D1 diga otra cosa;
      `gap backend_restart`; G4 (LRU de índices) medido con 100 conversaciones abiertas.
- [ ] Sin llamadas D1 por evento (contador `getD1CallsSinceBoot` estable durante 1000 eventos).
- [ ] Hard delete purga; soft delete conserva; `isRestrictedPath` sigue denegando `.st/`.
- [ ] `docs/DEPLOYMENT.md`: alias `st-backend`, variables nuevas, kill switch (API y emergencia),
      estado solicitado/efectivo, rotación = restart.

### 3.0c imagen

- [ ] Directorio vacío + script presentes; pin 2.1.308; el script termina en ≤ 6 s con
      `st-backend` sin resolver, con un receptor que acepta y nunca responde, y con `claude --version`
      colgado (simulado con un `claude` falso en PATH).
- [ ] Smoke test: sin archivo ⇒ cero peticiones a un receptor local (servidor en el propio test);
      con archivo ⇒ `session_start`, `user_prompt`, `assistant_delta{final}`, `turn_end`, `session_end`
      con los campos de §4.2; receptor cerrado ⇒ duración de `claude -p` ≤ base + 1 s × eventos;
      borrar el archivo ⇒ la siguiente sesión no emite; medición (informativa, registrada en el PR y
      en §2.4) de si una sesión interactiva ya abierta deja de emitir al borrar el archivo.
- [ ] README de la imagen: sección "Conversation hooks (managed settings)".

### 3.0d activación

- [ ] Endpoint admin + allowlist + stats según §7; habilitar/deshabilitar refleja D1 y archivo en
      ≤ 1 s; respuesta con `effective`/`effectiveAfterRestart` correcta en cada fila de §2.4; stats
      sin títulos/ids.
- [ ] Prueba manual documentada en el PR: una sesión real habilitada produce eventos visibles en
      `GET …/conversations` y en el archivo; deshabilitar corta la ingesta de inmediato y la emisión
      según lo medido en 3.0c.

### 3.1 vista

- [ ] Overlay Chat con `viewSwitch`; owner-only en todas las rutas (403→404); `canSendInput=false`;
      `capture.effective=false` se muestra como aviso ("captura no activa").
- [ ] Replay + live determinista (test del broadcaster); paginación hacia atrás; `firstRetainedSeq`
      y `gap history_rotated`; G3 con **eventos grandes**: cliente que no lee + 60 eventos de 1 MiB
      (uno de ellos `\u0001` puro, frame ~6 MiB) ⇒ `bufferedAmount` máximo ≤ 2 MiB + frame
      serializado mayor, cierre 1013, y al reconectar desde el último
      `seq` recibido no hay pérdida ni duplicado; en live, `resync` sin pérdida ni duplicado;
      20k eventos < 500 ms.
- [ ] "Copiar informe" copia `last_assistant_message` sin alteraciones (desde el DOM o vía
      `GET …/events/:seq`); con `truncated` lo indica.
- [ ] `gap` y `truncated` visibles; eventos `agent_id` fuera del hilo principal; estados con
      evidencia y hora; móvil: una columna, sin scroll horizontal, composer deshabilitado con motivo;
      L8 respetado con 20k eventos (memoria del tab medida en el PR).

### 3.2 composer (condicionado)

- [ ] §8.1 completo; resultados de §8.2 en el PR; issue #444 cerrado.

### 3.3 agentes y teams

- [ ] Vista de subagente con resultado final y herramientas; forks/`-p`/teammates como
      conversaciones; Chat como vista inicial configurable.

### 3.4 notificaciones y backfill

- [ ] Push solo al owner, solo en transiciones a `waiting_*`; backfill solo con bandera, eventos
      `imported`, nunca rompe la vista ante formato desconocido.
