# Fase 3 — Conversation & Agent Activity: diseño

Estado: **v1.1, arquitectura general aprobada el 2026-10-22** con los ajustes de la §9 (incluida
la ronda 1 de revisión Work). Este
documento es la base de la fase; el contrato técnico vinculante (endpoints, eventos, límites,
criterios de aceptación) vive en [docs/CONVERSATION.md](../CONVERSATION.md). Ningún PR de esta
fase implementa algo que contradiga este diseño sin actualizarlo primero.

Fases previas: Workspace Explorer (#442) y Git Changes (#443), mergeadas y desplegadas.

---

## 0. Resumen ejecutivo

La conclusión central de la investigación es que **hoy existe una vía oficial, de bajo costo y sin
scraping para leer la conversación de Claude Code**: los hooks de Claude Code, en particular
`MessageDisplay` (texto del asistente en streaming, con `turn_id` y `message_id`), `UserPromptSubmit`
(prompt del usuario, con `prompt_id`), `PreToolUse`/`PostToolUse` (herramientas), `Stop`
(`last_assistant_message` = informe final del turno), `SubagentStart`/`SubagentStop` (`agent_id`,
`last_assistant_message` del subagente) y `Notification` (`permission_prompt`, `idle_prompt`, …).
Todos están implementados en la 2.1.308 instalada en los contenedores (verificado en el binario y
en la documentación oficial) y pueden enviarse por **HTTP (`type: "http"`) directamente al backend
por la red `sessions-net`**, sin spawnear un proceso por evento.

Para **enviar input** no existe una API oficial que inyecte un turno de usuario en una sesión
interactiva ya corriendo. Las alternativas oficiales (mensajería entre sesiones por socket,
Channels, Remote Control, `claude --bg`) o bien requieren relanzar la sesión, o bien entregan el
texto como "mensaje de otra sesión / evento" con menos autoridad que un turno del usuario, o bien
dependen de los servidores de Anthropic. La vía **candidata** para 3.2 es la que ya usa el terminal:
pegar el texto en el pane de tmux donde corre esa conversación (bracketed paste + Enter), con
precondiciones verificadas y confirmación de entrega por el hook `UserPromptSubmit`. **Su
implementación no está aprobada todavía** (§5.4).

Decisiones vigentes:

1. **Fuente de verdad de la conversación = eventos de hooks oficiales**, persistidos por el backend
   en archivos append-only en el host (fuera del bind mount del workspace), con metadatos mínimos en
   D1. Los transcripts JSONL de `.st/claude-state/projects/` quedan como *backfill opcional* y
   explícitamente frágil (Anthropic los documenta como formato interno que cambia entre versiones).
2. **Identidad de conversación = `session_id` de Claude Code**, nunca el tab de tmux. El binding
   conversación↔pane es un dato que cambia (`/clear`, `--resume`, `/fork`).
3. **tmux sigue siendo el host persistente** de los procesos `claude`; no se reemplaza ni se altera
   su persistencia.
4. **Configuración de hooks entregada por el backend, no horneada en la imagen**: la imagen solo
   crea `/etc/claude-code/managed-settings.d/` (vacío) y el script `session-start.sh`; el backend
   monta en ese directorio, solo lectura, un archivo de hooks que escribe únicamente cuando la
   función está activada. Sin archivo no hay emisión: apagar no requiere rebuild (§4.1).
5. **Orden operativo**: (a) backend receptor desplegado y desactivado, (b) imagen con el directorio y
   el script, pin de Claude subido a 2.1.308, (c) activación progresiva por sesión/usuario y luego
   global. Ningún despliegue parcial deja hooks apuntando a un receptor inexistente.
6. **Privacidad por defecto**: se guardan prompts del usuario, texto del asistente e informes
   finales; **no** se guardan respuestas de herramientas ni argumentos de herramientas. El resumen
   persistido de una herramienta contiene solo identificadores estructurales (programas de un
   comando, ruta de archivo, host de una URL), nunca texto libre; no se promete "eliminación de
   secretos" por denylist de claves (§3.3, CONVERSATION.md §4.3). Títulos, nombres y metadatos
   derivados de conversaciones son **owner-only**.
7. **Un informe final nunca se trunca en silencio**: límites unificados en CONVERSATION.md; lo que
   exceda se marca `truncated` de forma visible y se ofrece la ruta al Terminal.
8. **Persistido = escrito en el archivo de eventos con `seq` asignado.** Toda pérdida (rate limit,
   receptor caído, evento malformado, desorden irresoluble) se representa con un evento `gap`
   visible, nunca con continuidad inventada.

---

## 1. Diagnóstico de capacidades reales del entorno actual

### 1.1 Lo que ya existe en Shared Terminal (reutilizable)

| Pieza | Estado hoy | Uso en Fase 3 |
| --- | --- | --- |
| Tabs | Un tab **es** una sesión tmux `tab-<hex>` creada por `createTab` (`dockerManager.ts:2366`); no hay tabla D1 de tabs; la etiqueta vive en la opción tmux `@tab-label`. | El binding conversación↔pane usa `session_name`/`pane_id` de tmux; nunca asumimos 1 tab = 1 conversación. |
| WS terminal | JSON frames `input`/`resize`/`output`/`status`; observadores con input descartado (`wsHandler.ts`). | Patrón de auth + replay determinista a replicar en `/ws/conversation/<sid>`. |
| `BootstrapBroadcaster` | Ring de 256 KiB por sesión, replay en microtask, GC a 60 s. | Plantilla directa para el broadcaster de conversación. |
| `execCapture` / `streamExec` | Exec dentro del contenedor con `timeout`, cap de bytes, drenado. | `claude agents --json` (probe) y, si se aprueba 3.2, comandos `tmux` del composer. |
| `.st/claude-state` | `~/.claude` → `workspace/.st/claude-state` (transcripts, `settings.json`, `sessions/`), `~/.claude.json` → `.st/claude.json`. Sobrevive soft delete; purga solo con `?hard=true`. | Nada de Fase 3 lee esto en el camino caliente. Backfill opcional (frágil). |
| `isRestrictedPath` | `.st/` denegado en Files/Git (credenciales + transcripts). | Se mantiene; la Conversation view no pasa por Files. |
| `sessions-net` | Backend (`app`) y contenedores en la misma red Docker; DNS embebido por nombre. | Los hooks HTTP llegan al backend por un alias estable (`st-backend`) sin publicar puertos. Si el backend no está, el nombre no resuelve y el hook falla al instante (sin timeout). |
| Bind mounts por sesión | Workspace (rw) y `.uploads` (ro) con rationale TOCTOU en `dockerManager.ts`. | Tercer mount (ro): el archivo de hooks managed (§4.1). |
| `buildContainerEnv` | Inyecta `SESSION_ID`, `SESSION_NAME` y env del usuario. | Añadir `ST_INGEST_TOKEN` (por arranque de contenedor) solo cuando la función está activada. |
| `agentSeed` | **Sobreescribe `~/.claude/settings.json` entero** (`bootstrap/agentSeed.ts:81`). | Motivo para no poner los hooks en user settings. |
| `push_subscriptions` (v14) + `readSessionBellFlag` | Push basado en la campana de tmux. | 3.4: push por evento (`permission_prompt`, `Stop`) en lugar de campana. |
| `assertCanObserve` / `assertCanOperate` / `assertOwnedByOr404` | Tiers de autorización y auditoría `session_observe_log` (`mode`). | Contenido y metadatos de conversación = **owner-only**; el composer (si se aprueba) = owner, admin con auditoría `operate`. |
| Frontend | `viewSwitch.ts` (Terminal/Files/Git), overlays `inert`, `markdown.ts` textContent-only, `ui.ts`, FIFO `enqueue` en `gitView.ts`, breakpoint 768 px, key bar. | Cuarta vista "Chat"; render Markdown reutilizado; misma disciplina de concurrencia. |
| Migraciones | Ledger v15 (`external_ref`). | Nuevas tablas = v16+ append-only. |

Nada de "hooks de Claude Code", "transcript" ni "conversation" existe en código; el único "hook"
del repo es el de ciclo de vida (`postCreate`/`postStart`).

### 1.2 Claude Code dentro de los contenedores (evidencia tomada en un contenedor real)

| Hecho | Evidencia |
| --- | --- |
| Pin de imagen **2.1.207**, pero el workspace auto-actualiza. | `session-image/Dockerfile:273`; `.st/claude-state/.last-update-result.json` → `2.1.306 → 2.1.308`; `claude --version` = 2.1.308. |
| `claude` corre con `--dangerously-skip-permissions` (alias en `.bashrc`). | `ps`: `claude --dangerously-skip-permissions`. Relevante: la sesión queda en la clase "bypass" para la mensajería cross-session (§5.1). |
| Workspace confiado (`hasTrustDialogAccepted: true`). Los hooks de settings **no** están gateados por trust. | `~/.claude.json`; tabla "What runs before you trust a folder" de la doc de permisos: *Hooks in settings files → Used / Used*. |
| El CLI publica un **registro de sesión** con estado. | `~/.claude/sessions/<pid>.json`: `sessionId`, `cwd`, `version`, `kind: interactive`, `status: busy\|waiting`, `waitingFor: "input needed"`, `tmux: "tab-c45e…:@0.%0"`, `messagingSocketPath`. Formato **no documentado**; la vía documentada equivalente es `claude agents --json`. |
| `claude agents --json` funciona en el contenedor y es barato. | Devuelve `{pid,cwd,kind,startedAt,sessionId,name,status}` en **0.17 s**. |
| Transcripts: `projects/<slug>/<session_id>.jsonl` + `<session_id>/subagents/agent-<id>.jsonl` + `.meta.json`. | Observado. Anthropic: formato *"internal to Claude Code and changes between versions"*. |
| Socket de inbox cross-session en `/tmp/cc-socks/<pid>.sock` + clave en `~/.claude/sessions/<pid>.<sha>.key`. | Observado; documentado en *Message your other Claude Code sessions*. |
| Hallazgo incidental: **36 clientes tmux `new-session -A` colgados** de reconexiones de 22 h. | Issue independiente [#444](https://github.com/gatof81/shared-terminal/issues/444); se corrige antes de cualquier trabajo de composer. |

### 1.3 Capacidades de Claude Code 2.1.308 verificadas (doc oficial + strings del binario)

Hooks disponibles (todos presentes en el binario 2.1.308; campos extraídos del esquema embebido):

| Hook | Campos específicos (además de los comunes) | Bloqueante / timeout | Uso en Fase 3 |
| --- | --- | --- | --- |
| `SessionStart` | `source: startup\|resume\|clear\|compact\|fork`, `agent_type?`, `model?`, `session_title?`, (resume/fork) `seconds_since_last_response`, `context_tokens` | no / 600 s | Alta/rebind de conversación; solo `command`/`mcp_tool` (no http) → script mínimo de registro, **asíncrono**: puede llegar después del primer `UserPromptSubmit`. |
| `SessionEnd` | `reason: clear\|resume\|logout\|prompt_input_exit\|other` | no / presupuesto 1.5 s | Cierre de conversación; puede llegar tarde o perderse. |
| `UserPromptSubmit` | `prompt`, `source?: user\|sdk\|system\|loop_wakeup\|schedule_wakeup\|poll_event`, `session_title?` | sí / 30 s | Mensaje de usuario y, si 3.2 se aprueba, ack del composer. `source` distingue el turno humano de mensajes inyectados. |
| `MessageDisplay` | `turn_id`, `message_id`, `index`, `final`, `delta` (líneas completas; `final` cierra el mensaje) | display-only / **10 s** | Texto del asistente en streaming. Documentado como display-only: no altera lo guardado. |
| `PreToolUse` / `PostToolUse` / `PostToolUseFailure` | `tool_name`, `tool_input`, `tool_use_id`, `tool_response` / `error`, `duration_ms`, `mcp_server?` | Pre sí / Post no / 600 s | Tarjetas de herramienta. Por privacidad solo se persiste un resumen de `tool_input` y nunca `tool_response` (§3.3). |
| `Stop` | `stop_hook_active`, `last_assistant_message`, `background_tasks[]`, `session_crons[]` | sí / 600 s | Fin de turno; **informe final canónico**; distingue "terminó" de "pausado esperando background". No dispara en interrupción del usuario. |
| `StopFailure` | `error` (rate_limit, overloaded, …), `last_assistant_message` (texto del error) | no | Estado `error`. |
| `SubagentStart` / `SubagentStop` | `agent_id`, `agent_type`, `agent_transcript_path`, `last_assistant_message`, `background_tasks[]` | Stop sí | Ficha de subagente + **resultado final**. |
| `Notification` | `message`, `title?`, `notification_type` (`permission_prompt`, `idle_prompt`, `agent_needs_input`, `agent_completed`, `elicitation_*`, …) | no | Evidencia de "esperando permiso" / "idle". |
| `PermissionRequest` / `PermissionDenied` | `tool_name`, `tool_input`, `permission_suggestions` / `reason` | decide | Estado "esperando permiso" (no aplica con `--dangerously-skip-permissions`, pero sí si el usuario quita el alias). |
| `PreCompact` / `PostCompact` | `trigger`, `compact_summary` | | Marcador en el chat (`compact_summary` no se persiste por defecto). |
| `TaskCreated` / `TaskCompleted` / `TeammateIdle` | `task_id`, `task_subject`, `task_description?`, `teammate_name?`; `team_name` **deprecado** | sí | Agent Teams (lectura). |
| `PostToolBatch`, `UserPromptExpansion`, `ConfigChange`, `InstructionsLoaded`, `CwdChanged`, `FileChanged`, `DirectoryAdded`, `Pre/PostModelSwitch`, `Elicitation*`, `Worktree*`, `Setup` | — | | No usados en v1 (ruido). |

Campos comunes a todos (esquema 2.1.308): `session_id`, `transcript_path`, `cwd`,
`prompt_id?` ("UUID correlating a user prompt with all subsequent events until the next prompt"),
`permission_mode?`, `agent_id?` ("Present only when the hook fires from within a subagent"),
`agent_type?`, `hook_event_name`. **No hay timestamp ni número de secuencia** en el payload: el
orden lo establece el backend al recibir (§4.6).

Transporte y semántica de hooks relevantes:

- `type: "http"`: POST del JSON de entrada con `Content-Type: application/json`; `headers` con
  interpolación `$VAR` **solo** para variables listadas en `allowedEnvVars`; 2xx vacío = ok; fallo de
  conexión/timeout = **error no bloqueante** (el agente sigue). No hay `async` para http. El timeout
  por defecto es 600 s (10 s en `MessageDisplay`): se fija `timeout: 1` para que un receptor caído
  cueste como mucho un segundo por evento, y la resolución DNS fallida (`st-backend` ausente) cuesta
  cero. `url` **no** interpola variables → alias DNS estable.
- `type: "command"` con `async: true`: no bloquea, pero spawnea un proceso por evento. Solo para
  `SessionStart` (http no está soportado ahí).
- Hooks de settings aplican dentro de subagentes (con `agent_id`) y de teammates in-process; los de
  un evento corren **en paralelo** entre sí.
- Hot reload: Claude Code vigila los archivos de settings (incluidos los managed en archivo) y
  recarga `hooks` sin reiniciar. Se verifica en el smoke test, no se asume.
- Managed settings: `/etc/claude-code/managed-settings.json` y el directorio documentado
  `managed-settings.d/*.json` (fusionados). Nada por debajo los anula; las listas (hooks) se
  **fusionan** con las del usuario.

Otras capacidades oficiales verificadas:

| Capacidad | Estado | Nota |
| --- | --- | --- |
| `claude agents --json` | Documentado: *"the supported way to read session state from outside Claude Code"*. | `status: busy\|waiting\|idle`, `waitingFor: permission prompt\|input needed\|sandbox request\|worker request\|dialog open`, `sessionId`, `name`, `pid`, `kind`. Sin tmux pane, sin versión. |
| Mensajería cross-session (`SendMessage`/`ListAgents`, socket inbox) | Documentado, ≥ 2.1.224; mismo contenedor OK, host↔contenedor no. | Solo se documenta la línea `{"type":"auth","token":…}`; el **frame del mensaje no está documentado**. El receptor trata el mensaje como "de otra sesión, no del usuario" y, en clase bypass, lo **retiene para aprobación** salvo que venga de un hijo propio o `crossSessionInbound: accept`. |
| Channels (`--channels`) | Research preview; requiere relanzar con flag; auth claude.ai/Console; entrega como `<channel>` event, no turno de usuario. | No para input del usuario. |
| Remote Control | Requiere login claude.ai, transcript en servidores de Anthropic, poco confiable en estos contenedores. | Descartado por producto. |
| `claude --bg` / agent view / `claude attach` | Supervisor propio (`~/.claude/daemon`, `jobs/<id>/state.json` "not a stable interface"); reemplazaría a tmux. | Fuera de alcance. |
| Agent Teams | `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`; teammates = sesiones completas con **propio `session_id`**; `--teammate-mode in-process\|tmux\|auto`; config en `~/.claude/teams/<team>/config.json` (se borra al terminar), tareas en `~/.claude/tasks/<team>/`; `SendMessage` 1:1; no hay API externa para hablarle a un teammate. | Lectura vía hooks; DM a teammates = no soportado en v1. |
| Subagentes | `agent_id` nuevo por invocación; transcript propio; `SendMessage` al `agent_id` para retomar. | Lectura vía hooks. |
| Transcripts JSONL | Explícitamente internos. | Solo backfill opcional. |

### 1.4 Identificadores y correlación

| Identificador | Origen | Estable en… | Observaciones |
| --- | --- | --- | --- |
| `session_id` (Claude) | todos los hooks, `claude agents --json` | la conversación. `--resume` conserva el id (SessionStart `source: resume`); `/clear` y `/fork` crean uno nuevo (`source: clear\|fork`). | **Es la clave de conversación.** |
| `prompt_id` | hooks (común) | un turno de usuario y todos sus eventos hasta el siguiente prompt. | Ausente hasta el primer input del proceso. |
| `turn_id`, `message_id` | `MessageDisplay` | mensaje del asistente (todas sus `delta`). | `message_id` ≠ `msg_…` de la API; no correlaciona con el transcript. |
| `tool_use_id` | Pre/PostToolUse | una llamada a herramienta. | Clave de la tarjeta. |
| `agent_id`, `agent_type` | hooks dentro de subagente / teammate in-process; `SubagentStart/Stop` | la instancia de subagente. | El `session_id` del evento es el del padre. |
| `task_id`, `teammate_name` | hooks de teams | | `team_name` deprecado. |
| `TMUX_PANE` (env) / `#{session_name}` | entorno heredado por el hook (claude corre dentro del pane) | el pane mientras no se mueva. | Permite el binding conversación↔tab sin leer el registro no documentado. |
| `SESSION_ID` (ST) | env del contenedor | la sesión de Shared Terminal. | Va en header del hook; el backend lo verifica contra el token. |

---

## 2. Tabla de funciones

Leyenda: **A** viable con interfaces oficiales · **B** viable con limitaciones · **C** frágil (interfaz
interna) · **D** no soportada.

| # | Función deseada | Clase | Cómo / limitación |
| --- | --- | --- | --- |
| 1 | Leer la conversación principal como chat (usuario, asistente, herramientas) | **A** | Hooks `UserPromptSubmit` + `MessageDisplay` + `Pre/PostToolUse` + `Stop`. Solo desde que los hooks están activos; sin *thinking*; sin tokens parciales (líneas completas). |
| 2 | Historial previo a la activación / con receptor caído | **C** | Backfill desde transcript JSONL (interno). Opcional, con parser tolerante y bandera. Por defecto: huecos marcados con `gap`. |
| 3 | Enviar mensaje a la conversación principal existente | **B (candidata, no aprobada)** | tmux paste en el pane ligado + ack por `UserPromptSubmit`. Requiere la validación de §5.4 antes de aprobar. |
| 4 | Copiar mensaje / respuesta / informe en Markdown | **A** | Texto crudo de `MessageDisplay` (concatenado) y `Stop.last_assistant_message` (canónico, nunca truncado en silencio). |
| 5 | Ver herramientas y progreso sin ruido; expandir detalles | **A/B** | Tarjetas colapsadas por `tool_use_id` con resumen redactado; el detalle completo no se persiste por defecto (privacidad) → "ver en Terminal". |
| 6 | Navegar entre varias conversaciones del mismo proyecto | **A** | Una conversación por `session_id`; listado por sesión ST con binding a tab/pane. |
| 7 | Ver subagentes y agentes en background | **A** | `SubagentStart/Stop` (+ `background_tasks[]` en `Stop`). |
| 8 | Expandir un subagente: su conversación y su resultado final | **B** | Resultado final: **A** (`SubagentStop.last_assistant_message`). Actividad de herramientas: **A** (hooks con `agent_id`). Texto intermedio del subagente: no lo cubre `MessageDisplay` → solo transcript (**C**). |
| 9 | Seguir varios agentes paralelos sin perder la conversación principal | **A** | Panel Activity alimentado por `agent_id`; el hilo principal se filtra por `agent_id` ausente. |
| 10 | Estados con evidencia | **A/B** | Hooks + `claude agents --json` (probe). Una interrupción con Esc no emite `Stop`; se recupera con probe o `idle_prompt`. |
| 11 | Cerrar el navegador y volver horas después | **A** | Eventos persistidos en el host por el backend; replay paginado; estado reconciliado al abrir. |
| 12 | Experiencia móvil | **A** | Vista propia (no xterm), composer nativo, listas de una columna. |
| 13 | Agent Teams: ver líder/teammates/tareas | **B** | `TaskCreated/Completed`, `TeammateIdle`, hooks in-process con `agent_id`. En modo tmux cada teammate es otra sesión con su `session_id` y su pane: conversación hermana; la relación con el líder no viene en ningún hook. |
| 14 | Mensaje directo a un teammate desde la UI | **D** | Sin interfaz externa. Alternativa: pedirle al líder que lo reenvíe. |
| 15 | Enviar el resultado de un agente a otro agente desde la UI | **B** (postergar) | Copiar informe + pegar en el composer de la otra conversación. Automatizarlo hereda las garantías (y la aprobación pendiente) de 3.2. |
| 16 | Responder prompts de permiso desde la UI | **B** (postergar) | Hoy no hay prompts (bypass). Misma clase de riesgo que 3.2. |
| 17 | Inyección por socket de inbox cross-session | **C** | Frame no documentado; el receptor lo trata como "de otra sesión". No para el input del usuario. |
| 18 | Channels / Remote Control / `--bg` como canal de input | **D** (por producto) | Requieren relanzar, claude.ai o reemplazar tmux. |
| 19 | Thinking / tokens parciales | **D** | Ningún hook lo expone. |
| 20 | Conversaciones `claude -p` del exec API (agenthub) | **A** (observar) | Los hooks también disparan en `-p`; aparecen como `kind: headless`, solo lectura. |

---

## 3. Arquitectura propuesta y modelo de datos

### 3.1 Entidades y relaciones

```
Sesión ST (sessions.session_id) ── 1:1 ── contenedor (st-<sid12>)
   │
   ├── tabs tmux (session_name "tab-…", panes %N)         ← existen hoy, sin tabla
   │
   └── Conversaciones Claude (claude_conversations.session_id)   ← NUEVO
          ├── binding actual: tab_id + pane_id (puede cambiar; puede ser NULL)
          ├── kind: interactive | headless | teammate
          ├── turnos (prompt_id) → mensajes (message_id) → tool calls (tool_use_id)
          ├── agentes (agent_id) con parent = session_id       ← derivados de eventos
          └── eventos (archivo append-only en el host)
```

Reglas:

- Un **tab** puede hospedar sucesivas conversaciones (`/clear`, `--resume`, `/fork`, cerrar y abrir
  `claude`) y puede no hospedar ninguna (shell). Una conversación puede cambiar de pane (`--resume`
  en otro tab). El binding se actualiza en cada `SessionStart` y se cierra en `SessionEnd`.
- **Cualquier evento puede crear la conversación.** `SessionStart` es asíncrono y puede llegar
  después del primer `UserPromptSubmit`; la fila se crea con el primer evento recibido de un
  `session_id` desconocido (`kind: unknown`) y `SessionStart` la enriquece cuando llega.
- **Subagente** (`agent_id`): hijo de una conversación; vive dentro de un turno (o en background).
  No tiene composer: solo se observa. La navegación padre→subagente→resultado forma parte del
  modelo desde 3.1 (la vista llega en 3.3).
- **Fork** (`SessionStart.source = fork`): conversación nueva; `parent_session_id` no viene en el
  hook; se vincula heurísticamente al pane de origen y se marca `parent_inferred: true`.
- **Teammate in-process**: eventos con `agent_id` dentro del `session_id` del líder → agente.
  **Teammate tmux**: conversación hermana `kind: teammate` (inferido por `argv` en `SessionStart`).
- **Headless** (`claude -p`, exec API): `kind: headless`, observable, sin composer.
- **Puede recibir input directamente** ⇔ `kind = interactive` ∧ binding activo ∧ pane existe ∧
  último estado con evidencia ∈ {waiting_input, idle} ∧ 3.2 aprobado y activado. Todo lo demás es
  solo observable; la UI lo muestra así y el backend lo rechaza (409).

### 3.2 Estados y evidencia

| Estado | Evidencia que lo establece | Evidencia que lo invalida |
| --- | --- | --- |
| `running` | `UserPromptSubmit` recibido y ningún `Stop`/`StopFailure` posterior; o probe `status: busy`. | `Stop`, `StopFailure`, `SessionEnd`, probe `waiting/idle`, proceso ausente. |
| `waiting_input` | `Stop` (y `background_tasks` vacío); `Notification idle_prompt`; probe `waiting` + `waitingFor: input needed` o `idle`. | nuevo `UserPromptSubmit`. |
| `waiting_background` | `Stop` con `background_tasks` no vacío. | `SubagentStop`/`Stop` posterior. |
| `waiting_permission` | `PermissionRequest`, `Notification permission_prompt`, probe `waitingFor: permission prompt`. | `PreToolUse`/`PostToolUse` siguiente. |
| `error` | `StopFailure`. | nuevo prompt. |
| `ended` | `SessionEnd` (con `reason`) confirmado por silencio (§4.6), o probe sin ese `sessionId` con contenedor corriendo. | cualquier evento posterior del mismo `session_id`. |
| `disconnected` | contenedor no `running`. | contenedor `running`. |
| `unknown` | contenedor `running`, sin eventos en N min y probe fallido/ambiguo; o fila creada por un evento sin `SessionStart` aún. | cualquier evento o probe exitoso. |

Cada estado lleva `status_evidence` (`hook:Stop`, `probe:waiting`, `reconcile:boot`…) y
`status_at`, y la UI lo muestra ("Esperando input · según Stop hace 2 h").

### 3.3 Almacenamiento y privacidad

Principio: **D1 solo guarda metadatos operativos; el contenido de conversación nunca entra en D1**.
Segundo principio (decisión 6): **se guarda lo que el usuario escribió y lo que el asistente le
dijo; no se guarda lo que las herramientas vieron**.

Qué se persiste por defecto:

| Dato | Se guarda | Detalle |
| --- | --- | --- |
| Prompt del usuario (`UserPromptSubmit.prompt`) | sí, completo hasta el límite L1 | es contenido del usuario hacia el agente. |
| Texto del asistente (`MessageDisplay.delta`) | sí, acumulado por `message_id` hasta L2 | lo que el usuario vio en pantalla. |
| Informe final (`Stop`/`SubagentStop.last_assistant_message`) | sí, completo hasta L3 | requisito de copia; truncado solo visible. |
| Herramienta: `tool_name`, `tool_use_id`, duración, ok/fallo, `agent_id` | sí | operativo. |
| Herramienta: `tool_input` | **solo identificadores estructurales** (L4) | `Bash` → nombres de los programas del pipeline y tamaño del comando (nunca el comando: `curl -H 'Authorization: Bearer X' …` se persiste como `programs: ["curl"]`); `Edit`/`Write`/`Read` → `file_path`; `Grep`/`Glob` → `path` y tamaño del patrón; `Agent` → `subagent_type` + `description`; `WebFetch` → host; `WebSearch` → tamaño; MCP/otras → solo nombres de claves. Tabla y ejemplos obligatorios en CONVERSATION.md §4.3.1. Una denylist de claves no protege valores libres, por eso no hay valores libres. |
| Herramienta: `tool_response` | **no** | solo `response_bytes`. |
| `PostToolUseFailure.error` | condicionado | solo para herramientas que no sean `Bash` ni MCP (el error de un comando suele contener el comando); para esas, `error_bytes` y `exit_code`. |
| `Notification.message`, `title` | condicionado | solo para tipos cuyo texto no deriva de un comando (`idle_prompt`, `agent_completed`, …); `permission_prompt` guarda solo el tipo. |
| `SessionStart` `argv` | **solo banderas de una allowlist** | nunca el argv completo (`--append-system-prompt`, rutas). |
| `PostCompact.compact_summary` | **no** | solo el marcador. |
| `transcript_path`, `cwd`, `agent_transcript_path` | sí (metadato) | rutas, no contenido. |
| Cualquier campo desconocido | **no** | parser tolerante: se descarta, se cuenta. |

Una futura opción por sesión `conversation.captureToolDetail` podrá ampliar esto; no forma parte de
3.x hasta que haya una necesidad concreta.

D1 (migración v16, append-only):

```sql
CREATE TABLE claude_conversations (
  session_id        TEXT PRIMARY KEY,          -- Claude session_id (uuid)
  st_session_id     TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  kind              TEXT NOT NULL,             -- unknown|interactive|headless|teammate
  parent_session_id TEXT, parent_inferred INTEGER NOT NULL DEFAULT 0,
  title             TEXT,                      -- session_title si llega; si no, derivado del 1er prompt (owner-only)
  tab_id            TEXT, pane_id TEXT,        -- binding actual (NULL = sin pane conocido)
  status            TEXT NOT NULL,             -- §3.2
  status_evidence   TEXT NOT NULL, status_at TEXT NOT NULL,
  started_at        TEXT NOT NULL, ended_at TEXT, end_reason TEXT,
  last_event_at     TEXT NOT NULL, last_prompt_id TEXT, last_seq INTEGER NOT NULL DEFAULT 0,
  claude_version    TEXT,                      -- de SessionStart (command hook)
  events_bytes      INTEGER NOT NULL DEFAULT 0, events_count INTEGER NOT NULL DEFAULT 0,
  gaps_count        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_claude_conv_st ON claude_conversations(st_session_id, last_event_at);
ALTER TABLE sessions ADD COLUMN ingest_token_hash TEXT;            -- sobrevive reinicios del backend
ALTER TABLE sessions ADD COLUMN ingest_token_hash_suspended TEXT;  -- deshabilitada en caliente; se restaura al rehabilitar
ALTER TABLE sessions ADD COLUMN conversation_requested INTEGER NOT NULL DEFAULT 0;  -- estado solicitado
```

Escrituras a D1 acotadas: upsert en creación/`SessionStart`/cierre, cambio de estado, y un
"heartbeat" de `last_event_at`/`last_seq`/contadores como máximo cada 30 s por conversación
(coalescido). Los eventos individuales **no** tocan D1.

Host (fuera del bind mount, al lado de `.uploads`):

```
<WORKSPACE_ROOT>/.conversations/<st_session_id>/<claude_session_id>.events.jsonl   (append-only)
<WORKSPACE_ROOT>/.conversations/<st_session_id>/<claude_session_id>.index.json     (snapshot)
<WORKSPACE_ROOT>/.claude-managed/<st_session_id>/conversation.json                 (hooks, ro mount)
```

- Cada línea: `{seq, ts, ev, prompt_id?, turn_id?, agent_id?, ...payload normalizado}`. `seq` lo
  asigna el backend (monótono por conversación) → orden determinista y cursor de replay.
- **Persistido** = la línea fue escrita en el archivo y `seq` asignado. Solo los eventos persistidos
  se difunden por WS y se cuentan en `events_count`. El 204 al hook no significa persistido.
- `index.json`: resumen (turnos, mensajes, agentes, último estado, `last_seq` incluido) reescrito
  atómicamente cada N eventos / T segundos; al abrir se carga el snapshot + la cola desde `last_seq`.
- Límites unificados (L1–L8, G1–G5, R1/R2) y rotación: tabla única en CONVERSATION.md §4.4. Aquí
  solo los principios: el informe final (L3, 1 MiB de contenido) es el límite de contenido más alto;
  el cuerpo de ingesta (L5, 8 MiB) se dimensiona para el **peor caso de escapado JSON** (×6) de un
  informe de L3, con test de serialización obligatorio; superar L3 produce `truncated: true`
  visible; además de las cotas por conversación hay cotas agregadas de proceso (colas totales,
  cuerpos grandes en vuelo, buffer WS por socket, índices residentes, bytes por respuesta).
- Retención: viven mientras viva la sesión ST (soft delete los conserva; `?hard=true` los purga bajo
  `WORKSPACE_ROOT/.conversations` y `.claude-managed`). `CONVERSATION_TTL_DAYS` opcional para
  conversaciones `ended`. Mismo contrato operador que `.st/claude-state`, documentado en SECURITY.md.

### 3.4 Autorización

| Superficie | Tier | Motivo |
| --- | --- | --- |
| Listar conversaciones, títulos, estados, agentes de una sesión | **owner-only** (`assertOwnedByOr404`) | Decisión 6: títulos y metadatos derivados son contenido. Admin/lead no los ven; `/api/admin/stats` solo expone contadores agregados sin identificar conversaciones. |
| Leer contenido (eventos, mensajes) | **owner-only** | Igual criterio que Files/Git. |
| Enviar mensaje (si 3.2 se aprueba) | owner, o admin con fila `session_observe_log mode='operate'` | El admin ya puede teclear en el terminal; el composer no amplía poder. Lead: no. |
| Ingesta de hooks | token por arranque de contenedor (`ST_INGEST_TOKEN`) + `SESSION_ID` en header, validado contra `ingest_token_hash` | Autoriza únicamente auto-reportar eventos de esa sesión. Visible para cualquier proceso del contenedor (es el propio usuario). |
| Activación por sesión | admin (`PATCH /admin/sessions/:id/conversation`) o config global | Despliegue progresivo (§4.1). Distingue estado **solicitado** (D1) de **efectivo** (token en el contenedor + archivo montado): tabla de transiciones en CONVERSATION.md §2.4. |

---

## 4. Captura, transmisión y persistencia de eventos

### 4.1 Entrega de la configuración de hooks (sin rebuild para apagar)

Componentes:

1. **Imagen** (inerte por sí sola): crea `/etc/claude-code/managed-settings.d/` vacío, instala
   `/opt/st/hooks/session-start.sh` (root, 0755) y sube el pin a 2.1.308. Sin archivo de hooks la
   imagen se comporta exactamente como hoy.
2. **Backend** (receptor): cuando `CONVERSATION_ENABLED=true` y la sesión está habilitada, al
   crear/arrancar el contenedor escribe `<WORKSPACE_ROOT>/.claude-managed/<sid>/conversation.json`
   y lo monta **solo lectura** en `/etc/claude-code/managed-settings.d/` (tercer bind, junto a
   workspace y uploads; root-owned dentro del contenedor, como exige managed settings en Linux). En
   el mismo arranque inyecta `ST_INGEST_TOKEN`. Si la función está apagada, no escribe el archivo,
   monta el directorio vacío y no inyecta token: **cero emisión**.
3. **Kill switch**: deshabilitar (endpoint admin o `npm run conversation:disable -- [sid|--all]`)
   hace **dos** cosas en este orden: (a) en D1 pone `conversation_requested=0` y anula
   `ingest_token_hash`, con lo que la ingesta rechaza desde ese instante y el siguiente `start` no
   regenera nada; (b) borra `conversation.json`, con lo que el CLI deja de emitir cuando recargue los
   managed settings o, si la versión fijada no recarga, en el siguiente `POST /start`. El comando de
   emergencia falla si D1 no responde en lugar de dejar solo los archivos borrados. Porque el env de
   un contenedor es inmutable, **habilitar una sesión que ya corre sin token no escribe el archivo**
   (sería tráfico sin receptor que lo acepte) y responde `effectiveAfterRestart: true`.
4. **Orden de despliegue** (decisión 5): 3.0b backend con endpoint que responde 204 y descarta
   (flag apagado) → 3.0c imagen → 3.0d activación por allowlist de sesiones/usuarios → global. En
   ningún punto hay hooks configurados sin receptor: el archivo solo existe si el backend lo creó,
   y el backend solo lo crea si el endpoint existe. Si el backend se reinicia, `st-backend` no
   resuelve en DNS y el hook falla en milisegundos (sin esperar `timeout`).

Contenido de `conversation.json` (esquema completo en CONVERSATION.md):

```json
{
  "hooks": {
    "SessionStart":     [{ "hooks": [{ "type": "command", "command": "/opt/st/hooks/session-start.sh", "async": true }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "http", "url": "http://st-backend:3001/ingest/claude/hook", "timeout": 1, "headers": H, "allowedEnvVars": E }] }],
    "MessageDisplay":   [ … idem … ], "PreToolUse": [{ "matcher": "*", … }], "PostToolUse": [ … ],
    "PostToolUseFailure": [ … ], "Stop": [ … ], "StopFailure": [ … ], "SubagentStart": [ … ],
    "SubagentStop": [ … ], "Notification": [ … ], "PermissionRequest": [ … ],
    "PreCompact": [ … ], "PostCompact": [ … ], "TaskCreated": [ … ], "TaskCompleted": [ … ],
    "TeammateIdle": [ … ], "SessionEnd": [ … ]
  }
}
```

`H = { "Authorization": "Bearer $ST_INGEST_TOKEN", "X-ST-Session": "$SESSION_ID", "X-ST-Tmux-Pane": "$TMUX_PANE" }`,
`E = ["ST_INGEST_TOKEN", "SESSION_ID", "TMUX_PANE"]`. `st-backend` es un alias del servicio `app`
en `sessions-net`.

- `session-start.sh` (único hook `command`, una vez por sesión, async): lee stdin, añade
  `claude_version`, `tmux_session` (`tmux display-message -p '#S'`), `pane` y las banderas del argv
  del proceso padre que estén en una allowlist (para `--agent-name`/`-p`), y hace `curl --max-time 2`
  al mismo endpoint. Si `ST_INGEST_TOKEN` está vacío, sale 0 sin hacer nada. Como la documentación
  oficial dice que `timeout` **no** se aplica a hooks `async`, el script se envuelve a sí mismo en
  `timeout -k 1 5` y acota cada subproceso (`claude --version`, `tmux`, `curl`) por separado.
- `PreToolUse` como http **devuelve 2xx vacío**: nunca decide permisos. `Stop`, `SubagentStop`,
  `TaskCreated/Completed`, `TeammateIdle` idem: nunca `decision: block`. Invariante del endpoint
  (siempre 204, cuerpo vacío), verificada en test.
- Por qué managed y no `~/.claude/settings.json`: `agentSeed` lo sobreescribe, el usuario puede
  borrarlo, y queremos la misma observabilidad en `-p`/subagentes/teammates. Trade-off: `/status`
  mostrará "Managed settings"; se documenta en el README de la imagen. `allowManagedHooksOnly`
  **no** se activa.
- Smoke test de imagen: con un `conversation.json` de prueba montado y un receptor HTTP local,
  `claude -p "hola"` debe producir `SessionStart`, `UserPromptSubmit`, `MessageDisplay(final)`,
  `Stop`, `SessionEnd` con los campos del contrato; con el receptor apagado, el `-p` no debe tardar
  más de 1 s extra por evento; al borrar el archivo, la siguiente sesión no emite. La deriva de
  versión se convierte en fallo de CI. Auto-update se mantiene (decisión existente) con parser
  tolerante.

### 4.2 Ingesta en el backend

`POST /ingest/claude/hook` (montado **antes** de `express.json` global, con su propio parser
limitado a L5; sin cookies, sin CORS, sin CSRF: auth por Bearer).

1. Validar `Authorization` contra `ingest_token_hash` de `sessions[X-ST-Session]` (cache en
   memoria; D1 solo en miss) y `status = running`. Fallo → 204 igualmente (nunca ruido hacia el
   agente), contador `ingest_rejected`.
2. Validar forma mínima (`hook_event_name`, `session_id`) con zod tolerante; normalizar y
   **redactar/recortar** según §3.3 y los límites L1–L6.
3. Dedupe **por identidad de cada tipo de evento** (tabla en CONVERSATION.md §4.6): `tool_use_id`,
   `message_id+index`, `agent_id`, `task_id`, `prompt_id`. Donde no hay identidad natural (`Stop`
   puede dispararse varias veces en el mismo `prompt_id`; notificaciones; `SessionStart/End`) solo
   se descarta un payload **idéntico** dentro de 10 s. Compartir turno o pane nunca es criterio de
   duplicado: dos `SubagentStop` del mismo turno con `agent_id` distintos se persisten ambos.
4. Encolar; responder 204 **antes** de persistir (el hook no espera al disco). Un worker por
   conversación asigna `seq`, hace append, actualiza el índice en memoria, difunde por WS y programa
   el flush de `index.json` y el heartbeat D1.
5. Tasa por sesión ST con token bucket (R1 eventos, R2 bytes, capacidad ≥ L5 para que un informe
   grande aislado nunca se rechace); el exceso se descarta con un `gap rate_limited` persistido.
6. Cotas de memoria: cola por conversación (L6) **y** suma de colas del proceso (G1) **y** cuerpos
   grandes en vuelo (G2); cualquier overflow descarta con `gap backpressure{scope}`. Un cuerpo que
   no se puede parsear (más de L5 o JSON inválido) produce un `gap malformed` atribuido por pane
   cuando la atribución es única; si no, un contador agregado para el admin.

### 4.3 Entrega al navegador

`GET /api/sessions/:id/conversations` (owner; metadatos + estado + contadores + `gaps_count`).
`GET /api/sessions/:id/conversations/:cid/events?before=<seq>&limit=200` (owner; paginación hacia
atrás por `seq`; `InFlightLimiter` como Files).
`GET /api/sessions/:id/conversations/:cid/agents` (owner; derivado del índice).
`WS /ws/conversation/<sid>` (owner; misma auth que `/ws/bootstrap`): frames JSON
`{type:"event", conv, seq, …}`, `{type:"status", conv, status, evidence}`, `{type:"hello", cursors}`.
El cliente envía `{type:"subscribe", conv, after:<seq>}`; el servidor replay desde `after` y luego
live, con la misma técnica del terminal (listener armado antes del replay, cola drenada en orden)
para que la secuencia visible sea determinista. Un WS por sesión ST cubre todas sus conversaciones.
Contrapresión (G3): el replay va por lotes y espera `drain` si el buffer del socket supera 2 MiB
(cierre 1013 si no drena en 30 s); en live, un cliente que acumula más de 8 MiB deja de recibir y
recibe un `resync{fromSeq}` cuando drena, tras lo cual re-suscribe desde ese `seq`. Nada se pierde
porque la fuente es el archivo. Un cursor anterior al historial retenido (tras rotación L7) recibe
un frame `gap history_rotated` y continúa desde `firstRetainedSeq`.

### 4.4 Probe y reconciliación

- `docker exec … claude agents --json` (`execCapture`, cap 64 KiB, timeout 5 s): al abrir la vista,
  y cada 60 s **solo** mientras haya una Conversation view abierta para esa sesión.
- Al arrancar el backend: para cada sesión `running`, un probe único marca `ended` las conversaciones
  cuyo `sessionId` no aparece y `unknown` las que aparecen sin eventos recientes; además escribe un
  evento `gap reason: backend_restart` en cada conversación no terminada (hubo una ventana sin
  receptor).
- Fallos del probe no cambian estado (quedan como evidencia "probe failed" en el log).

### 4.5 Overhead estimado

| Componente | Coste |
| --- | --- |
| Hook http por evento | 1 request HTTP keep-alive en red Docker (~1-3 ms), sin proceso nuevo. `MessageDisplay` sostiene cada flush hasta la respuesta: latencia visual ≤ unos ms. Receptor caído: fallo DNS inmediato, o ≤ 1 s si el contenedor del backend existe pero no responde. |
| `session-start.sh` | 1 proceso (`sh` + `curl` + `claude --version` ~0.2 s) por conversación. |
| Backend | append de líneas + broadcast; memoria acotada por conversación. Sin D1 por evento. |
| Probe | 0.17 s CPU por sesión abierta por minuto. |
| Red/browser | Solo eventos de las conversaciones suscritas; `delta` por líneas, no por token. |

### 4.6 Orden, carreras, reinicios y rotación (decisión 6 del usuario)

Los hooks no llevan timestamp ni secuencia; los de un mismo evento corren en paralelo; `SessionStart`
es asíncrono; `SessionEnd` puede llegar tarde o nunca. Reglas:

| Situación | Regla |
| --- | --- |
| Evento de un `session_id` desconocido | Crea la conversación (`kind: unknown`, `status: running` si es `UserPromptSubmit`). `SessionStart` posterior enriquece sin resetear `seq`. |
| `PostToolUse` antes que `PreToolUse` (mismo `tool_use_id`) | Ambos se persisten en orden de llegada; el índice cierra la tarjeta cuando tiene ambos; si solo llega Post, la tarjeta nace "completada" sin inicio. |
| `MessageDisplay` con `index` no consecutivo | Se persiste y se inserta `gap reason: missing_delta` con el rango faltante; el texto mostrado marca "[… fragmento perdido …]". |
| `Stop` sin `UserPromptSubmit` para ese `prompt_id` | Se persiste; se inserta `gap reason: missing_prompt`; el informe sigue siendo copiable. |
| `SessionEnd` | Marca `ending`; se confirma `ended` tras 5 s sin eventos de ese `session_id`. Un evento posterior (p. ej. `SessionStart(resume)` adelantado) reabre y descarta el cierre. `SessionEnd(reason: clear)` seguido de `SessionStart(clear)` con **otro** `session_id` en el mismo pane: la nueva conversación hereda el binding y la anterior cierra. |
| Dos conversaciones reclaman el mismo pane | Gana la más reciente por llegada; la anterior pierde el binding (`pane_id = NULL`) y se marca `unknown` hasta que un probe o evento la aclare. |
| Reinicio del backend | `ingest_token_hash` en D1 valida tokens existentes; el índice en memoria se reconstruye desde `index.json` + cola al primer acceso; `last_seq` viene del archivo (fuente de verdad), no de D1; se escribe `gap reason: backend_restart` (§4.4). |
| Reinicio del contenedor (`POST /start`) | Token nuevo e `ingest_token_hash` nuevo; eventos con token viejo → 204 descartado (`ingest_rejected`). Las conversaciones quedan `disconnected` hasta el siguiente evento/probe. |
| Rotación manual de token | El env de un contenedor es inmutable, así que rotar = `POST /stop` + `POST /start` (token nuevo). Un endpoint admin de rotación en caliente queda fuera de alcance; se documenta en DEPLOYMENT.md. |
| Habilitar/deshabilitar con el contenedor corriendo | Deshabilitar: D1 primero (ingesta rechaza ya), archivo después (emisión cesa al recargar o al siguiente start); el token queda en el env pero sin hash es inerte. Rehabilitar sin reinicio: se restaura el hash suspendido y se reescribe el archivo. Habilitar una sesión que nunca tuvo token: nada hasta el siguiente start. Tabla completa en CONVERSATION.md §2.4. |
| Evento duplicado (reintento del hook) | Dedupe §4.2. |
| Evento malformado | Se descarta y se persiste `gap reason: malformed` (con `hook_event_name` si se pudo leer) para que la deriva de versión sea visible al usuario, no silenciosa. |

### 4.7 Huecos conocidos y mitigación

| Hueco | Mitigación |
| --- | --- |
| Receptor caído → eventos perdidos (hook falla no bloqueante) | `gap` al reiniciar + `Stop.last_assistant_message` reconstruye el último informe; 3.4: backfill opcional desde transcript. |
| Conversaciones anteriores a la activación | Aparecen al siguiente `SessionStart` (resume) sin historial; marcador "historial anterior no disponible" + enlace a Terminal. |
| Interrupción con Esc (no hay `Stop`) | `idle_prompt` (60 s) o probe → `waiting_input` con evidencia `probe`. |
| SIGKILL del contenedor | `reconcile` + probe al arrancar → `disconnected`/`ended`. |
| Texto intermedio de subagentes | Fuera de alcance de hooks; se muestra actividad de herramientas + resultado final. |
| Auto-update rompe un campo | Parser tolerante + `gap malformed` + smoke test en CI por versión. |

---

## 5. Envío de mensajes (3.2) — estrategia candidata, no aprobada

### 5.1 Opciones evaluadas

| Opción | ¿Oficial? | ¿Sin relanzar? | Autoridad del mensaje | Veredicto |
| --- | --- | --- | --- | --- |
| **tmux paste al pane** (`load-buffer` + `paste-buffer -p` + `send-keys Enter`) | tmux sí; es lo que hace hoy el terminal web | sí | **turno de usuario real** | **Candidata** |
| Socket inbox cross-session | feature documentada; frame no documentado | sí | "mensaje de otra sesión": no puede aprobar, puede quedar retenido (clase bypass) | Frágil; no para input del usuario. |
| Channels (`--channels` + MCP server propio) | research preview | **no** | evento `<channel>`, no turno | No en v1. |
| Remote Control | sí | sí (`/rc`) | turno de usuario | Depende de claude.ai; transcript en servidores de Anthropic. Descartada. |
| `claude --bg` + `claude attach`/reply | research preview | — | turno | Reemplaza a tmux. Descartada. |
| `claude -p --resume <id>` por mensaje | sí | — | turno | Segunda instancia por mensaje y colisión con la interactiva. Descartada. |

### 5.2 Diseño candidato del envío

`POST /api/sessions/:id/conversations/:cid/messages` body `{ text, clientMessageId }`.

Precondiciones (todas del lado del servidor; el cliente **no** elige pane, tab ni teclas):

1. Autorización (§3.4). `cid` debe ser `kind: interactive` con binding activo (`tab_id`, `pane_id`).
2. `clientMessageId` no visto (idempotencia) y **lock por conversación** (otro cliente recibe 409
   `send-in-progress`).
3. Probe `claude agents --json`: el `sessionId` existe, `kind: interactive`, `status ∈ {waiting, idle}`
   y `waitingFor ∈ {∅, "input needed"}`. `busy` → 409 `busy`. `permission prompt`/`dialog open` →
   409 `needs-terminal`.
4. Estado del pane (`tmux display -p -t <pane> '#{pane_current_command} #{pane_in_mode} #{pane_dead} #{pane_pid}'`):
   proceso en foreground `claude`/`node` y `pane_pid` ancestro del `pid` del probe; `pane_in_mode`
   → 409 (no se cancela el modo del usuario); `pane_dead` → 409.
5. Envío: `tmux load-buffer -b st-<cid> -` → `tmux paste-buffer -p -d -b st-<cid> -t <pane>` →
   `tmux send-keys -t <pane> Enter`. Texto ≤ L1; sin bytes de control salvo `\n`, `\t`.
6. **Ack**: esperar ≤ 8 s un `UserPromptSubmit` de ese `session_id` con `source = user` cuyo
   `prompt` **normalizado** coincida con el enviado. Resultado `delivered` (con `prompt_id`) o
   `unconfirmed` (la UI lo marca y sugiere mirar el Terminal; no se reintenta automáticamente).
7. Auditoría: evento `composer_send {clientMessageId, result}` persistido; cross-user →
   `session_observe_log mode='operate'`.

**Ante cualquier incertidumbre en 3-6, se falla sin enviar** (409 con razón). Nunca se envía "por si
acaso".

### 5.3 Lo que no haremos

No hablaremos con el socket de inbox desde el backend (frame interno), no lanzaremos una segunda
instancia por mensaje, no usaremos Channels/Remote Control para input, no leeremos
`~/.claude/sessions/*.json` ni `/tmp/cc-socks` en producción.

### 5.4 Validación requerida antes de aprobar 3.2

Experimentos con el CLI real en un contenedor de prueba, documentados con resultados en
CONVERSATION.md antes de abrir el PR 3.2:

1. **Pane**: `paste-buffer -p` + `Enter` con el composer vacío, con texto a medio escribir, en
   copy-mode, con un diálogo abierto (`/config`), con `claude` en `busy`. Resultado esperado y real.
2. **Cambios de conversación**: `/clear`, `/resume` a otra conversación, `/fork` y `exit`+`claude`
   en el mismo pane; verificar que el binding se actualiza antes de que un envío pueda ir al destino
   equivocado (ventana de carrera medida).
3. **Prompts multilínea**: saltos de línea, bloques de código, líneas que empiezan con `/`
   (comando) o `!` (bash), `@` (mención), texto largo (L1).
4. **Normalización de `UserPromptSubmit.prompt`**: qué transforma el CLI (recorte de espacios,
   CRLF, expansión de comandos, menciones) para definir la función de comparación del ack.
5. **Bracketed paste**: confirmar que el CLI no envía al pegar y sí al `Enter`, y qué pasa con
   `paste-buffer` sin `-p`.
6. **Clientes tmux**: el issue de clientes acumulados debe estar resuelto; de lo contrario el pane
   puede tener tamaños inconsistentes entre clientes.

---

## 6. Diseño UX

### 6.1 Navegación

Cuarta vista en `#view-switch`: **Terminal · Files · Git · Chat**. Mismo overlay absoluto sobre
`#terminal-area`, `inert` sobre el terminal, `onViewChange`/`onSessionSync`. Sesiones no running
abren en Files como hoy; Chat se habilita si hay conversaciones persistidas (lectura) aunque el
contenedor esté parado (estado `disconnected`, composer deshabilitado).

Chat es la **futura pantalla principal**: a partir de 3.3, al abrir una sesión se entra en Chat
cuando existe al menos una conversación `interactive` con eventos (configurable por usuario:
"vista inicial"); el Terminal sigue a un toque.

### 6.2 Desktop (≥ 768 px)

```
┌ toolbar: [nombre sesión · estado] [Terminal][Files][Git][Chat] … ───────────────┐
├──────────────┬──────────────────────────────────────────┬──────────────────────┤
│ Conversacio- │ Hilo principal                            │ Activity             │
│ nes          │  ┌ usuario ─────────────────┐ [Copiar]    │ ● Explore (a63f…)    │
│ ● workspace- │  │ …                        │             │   running · 3 tools  │
│   d7  busy   │  └──────────────────────────┘             │ ○ Plan (a416…) done  │
│ ○ api-worker │  ┌ asistente ───────────────┐ [Copiar MD] │   [ver resultado]    │
│   waiting    │  │ markdown renderizado     │             │ Teams: líder + 2     │
│ ○ -p #4 end  │  └──────────────────────────┘             │ Tareas: 3/5          │
│              │  ▸ Bash · npm test · 1.2 s  (colapsado)   │ ─────────────────    │
│ [tab-…] ↔    │  ▸ Edit · src/x.ts                        │ Estado: esperando    │
│   terminal   │  ⚠ 2 eventos perdidos (receptor caído)    │ input · Stop · 18:21 │
│              │  ┌ asistente (final) ───────┐ [Copiar MD] │ Versión 2.1.308      │
├──────────────┴──────────────────────────────────────────┴──────────────────────┤
│ Composer [Escribí un mensaje…                      ] [Enviar]  ⚠ estado/ack     │
└────────────────────────────────────────────────────────────────────────────────┘
```

- Lista de conversaciones: nombre (`session_title`/`name`/primer prompt), `kind`, estado con
  evidencia, tab ligado (clic → salta al Terminal en ese tab). `headless` y `teammate` agrupadas.
- Hilo: burbujas de usuario (texto plano), asistente (Markdown vía `markdown.ts`), tarjetas de
  herramienta colapsadas (icono por `tool_name`, resumen redactado de una línea, duración, ok/fallo);
  expandir muestra el resumen y "detalle no guardado · ver en Terminal". Marcadores: compactación,
  resume, fork, **gap** (con razón y rango) y **truncado** (con tamaño).
- Cada mensaje del asistente tiene **Copiar Markdown**; el último `Stop` de cada turno tiene
  **Copiar informe** (`last_assistant_message` íntegro; si está `truncated`, el botón lo dice y
  copia lo disponible). Selección múltiple → "Copiar turno completo".
- Activity: agentes (`agent_type`, `agent_id` corto, estado, nº de herramientas, duración), clic abre
  el subagente **en el mismo panel central** con breadcrumb "← volver al hilo"; el resultado final
  arriba, la actividad de herramientas debajo. Teams: líder, teammates, tareas.
- Streaming: `MessageDisplay.delta` se añade por líneas con un cursor; `final` cierra la burbuja.
- Estado y evidencia visibles siempre; "desconocido" se muestra en gris con "verificar" (probe).

### 6.3 Mobile (< 768 px)

- Una columna, tres pantallas apiladas: **Conversaciones → Hilo → Agente**. Activity por un botón
  "Agentes (N)" en la cabecera del hilo (drawer inferior).
- Composer fijo abajo (deshabilitado hasta 3.2), textarea nativa, Enter = nueva línea, Ctrl/Cmd+Enter
  o botón = enviar. Chip de estado sobre el composer que explica por qué no se puede enviar y ofrece
  "Abrir terminal".
- Tarjetas colapsadas por defecto; "Copiar" en el menú largo de cada mensaje.
- Reanudar: al volver horas después, la vista carga el snapshot, salta al final, muestra "N nuevos
  eventos desde tu última visita" y reconcilia el estado con un probe.
- Notificaciones (3.4): push cuando una conversación pasa a `waiting_input` o `waiting_permission`
  (reutiliza `push_subscriptions`); tocar la notificación abre esa conversación.

### 6.4 Accesibilidad y seguridad del render

Todo el DOM se construye con `textContent`/`el()` (sin `innerHTML`), límites de elementos de
`markdown.ts`, listas virtualizadas por ventana de `seq` (máx. 500 eventos montados), foco gestionado
al cambiar de pantalla, `aria-live="polite"` para nuevos mensajes del asistente (solo `final`).

---

## 7. Plan de implementación incremental (PRs pequeños)

| PR | Alcance | Criterios de aceptación (resumen; detalle en CONVERSATION.md) |
| --- | --- | --- |
| **3.0a** `docs: diseño Fase 3 y contrato de conversación` | Este documento + `docs/CONVERSATION.md`. | Revisado y aprobado; sin código. |
| **3.0b** `feat(backend): receptor de conversación (desactivado)` | `ingest_token_hash` (v16) y `claude_conversations`; `POST /ingest/claude/hook`; `conversationStore.ts`; máquina de estados; probe + reconcile; `GET …/conversations`; `CONVERSATION_ENABLED=false` por defecto; escritura/borrado de `conversation.json` y tercer bind; comando `conversation:disable`. | Con la bandera apagada: ningún archivo de hooks, ningún token, 204 y descarte; tests de auth, redacción, límites, dedupe, `seq`, gaps, estados, reinicio; sin D1 por evento. |
| **3.0c** `feat(session-image): soporte de hooks de conversación` | `managed-settings.d/` vacío, `session-start.sh` autoacotado (`timeout -k 1 5`), pin 2.1.308, smoke test con receptor local, README. | Imagen sin archivo montado = comportamiento idéntico a hoy (test); con archivo = eventos del contrato; receptor apagado = ≤ 1 s extra por evento; el script termina en ≤ 6 s con receptor colgado o `claude` colgado; borrado del archivo = sin emisión en la siguiente sesión; medición informativa de la recarga en caliente. |
| **3.0d** `feat: activación progresiva` | Allowlist por sesión/usuario (`PATCH /admin/sessions/:id/conversation`, `CONVERSATION_ALLOW_USERS`), métricas en `/api/admin/stats` (eventos/s, rechazados, gaps, bytes; sin títulos). | Activar una sesión produce eventos solo para ella; desactivar para de emitir sin reinicio (o al siguiente start, documentado). |
| **3.1** `feat: Conversation view (lectura)` | Vista Chat desktop+mobile; `GET …/events`; `WS /ws/conversation`; render usuario/asistente/herramientas; copiar Markdown/informe; estados; marcadores gap/truncado/compact/resume; modelo de navegación a subagentes (sin vista propia aún). | Replay determinista; 20k eventos < 500 ms (snapshot); copiar informe = `last_assistant_message` byte a byte; gaps y truncados visibles; owner-only. |
| **3.2** `feat: composer` (**requiere aprobación tras §5.4**) | `POST …/messages`; precondiciones, lock, idempotencia, probe, tmux paste, ack; auditoría. | Resultados de §5.4 adjuntos al PR; doble clic → un envío; `busy` → 409; ack timeout → `unconfirmed` sin reintento; `\n` no envía; observadores/lead → 403; el cliente no nombra pane/tab. |
| **3.3** `feat: agentes, conversaciones paralelas y teams` | Panel Activity; vista de subagente; forks y `-p` como conversaciones; teams; Chat como vista inicial. | Eventos con `agent_id` nunca en el hilo principal; subagente background visible tras `Stop`; sin composer en no-interactivas. |
| **3.4** `feat: notificaciones, reanudación y backfill` | Push por `waiting_*`; "N nuevos desde tu visita"; backfill opcional desde transcript tras bandera; refinamientos. | Push solo al owner; backfill nunca sin bandera ni rompe la vista. |

Dependencias: 3.0b → 3.0c → 3.0d (orden operativo). 3.1 requiere 3.0d activo en al menos una
sesión. 3.2 depende de 3.1, de §5.4 y del issue de clientes tmux. 3.3 solo de 3.1.

---

## 8. Riesgos, alternativas y qué postergar

| Riesgo | Prob. | Impacto | Mitigación |
| --- | --- | --- | --- |
| Deriva de versión de Claude Code (auto-update) rompe un campo de hook | media | medio | Smoke test por versión, parser tolerante, `gap malformed` visible, `claude_version` por conversación. |
| `MessageDisplay` sostiene cada flush hasta la respuesta HTTP | baja | bajo | 204 inmediato antes de persistir; `timeout: 1`. |
| Despliegue parcial deja hooks sin receptor | — | medio | Por construcción no ocurre: el archivo de hooks lo escribe el backend que tiene el receptor. |
| Doble envío / envío al pane equivocado (3.2) | baja | alto | §5.2 + §5.4; fallar sin enviar. |
| Contenido sensible en el host en claro | — | medio | Solo prompts/asistente/informes; sin respuestas de herramientas; fuera del bind mount; owner-only; purga en hard delete. |
| Volumen de eventos | media | medio | Redacción y límites en ingesta, rate limit con `gap`, cola acotada, rotación de archivo. |
| Teams en modo tmux: relación líder↔teammate no observable por hook | media | bajo | Mostrar como hermanas; no inventar jerarquía. |
| Hooks managed sorprenden a usuarios avanzados (`/status`) | baja | bajo | Documentado; listas fusionadas; nada se bloquea. |

Postergar explícitamente: responder permisos desde la UI, DM a teammates, "enviar resultado de un
agente a otro" automatizado, texto intermedio de subagentes, captura de detalle de herramientas,
cifrado de eventos en reposo, Channels como canal de notificaciones, lectura admin de contenido.

---

## 9. Historial de decisiones

**2026-10-22 — v0 revisada y arquitectura general aprobada** con estos ajustes, ya incorporados:

1. Hooks oficiales como fuente principal; `session_id` de Claude como identidad; tmux como host
   persistente. (§0)
2. Orden operativo: receptor desactivado → hooks en la imagen → activación progresiva; apagado sin
   rebuild (archivo managed montado por el backend); sin timeouts repetidos en despliegues
   parciales. (§4.1)
3. Privacidad: sin respuestas de herramientas ni parámetros sensibles por defecto; títulos y
   metadatos owner-only. (§3.3, §3.4)
4. Límites unificados (CONVERSATION.md); informe completo copiable, truncado solo visible;
   definición de "persistido" y de `gap`. (§3.3, §4.2)
5. tmux paste + ack queda como candidata para 3.2, **no aprobada**; validación §5.4; ante duda,
   fallar sin enviar.
6. Desorden, `SessionStart` asíncrono, `SessionEnd` tardío, reinicios y rotación de token. (§4.6)
7. Issue independiente por los clientes tmux acumulados (#444); se corrige antes del composer.
8. Roadmap incremental; Chat como futura pantalla principal; navegación a subagentes en el modelo
   desde el inicio. (§3.1, §6.1)

**2026-10-22 — revisión Work, ronda 1 (C1–C5), incorporada en CONVERSATION.md v1.1:**

- C1: deduplicación por identidad de tipo de evento (`agent_id`, `task_id`, `tool_use_id`,
  `message_id+index`, `prompt_id`); sin identidad natural, solo payload idéntico en 10 s; casos de
  dos agentes y dos tareas en el mismo turno como tests obligatorios. (§4.2; CONVERSATION.md §4.6)
- C2: el resumen de herramientas solo guarda identificadores estructurales; `Bash` persiste nombres
  de programas y tamaño, nunca el comando; ejemplos con cabeceras, asignaciones de entorno y URLs
  con credenciales; sin promesa de eliminación de secretos; `argv` por allowlist; `error` y
  `message` condicionados. (§3.3; CONVERSATION.md §4.3)
- C3: estado solicitado (D1) frente a efectivo (token + archivo); tabla de transiciones; la ingesta
  deja de aceptar en el flip de D1; el comando de emergencia escribe D1 antes de borrar archivos;
  habilitar en caliente sin token no escribe el archivo. (§4.1, §4.6; CONVERSATION.md §2.4)
- C4: L3 = 1 MiB de contenido, L5 = 8 MiB de cuerpo (peor caso ×6 de escapado JSON + envoltura),
  R2 como token bucket con capacidad ≥ L5; test de serialización obligatorio. (CONVERSATION.md §4.4)
- C5: cotas agregadas G1–G5 (colas totales, cuerpos grandes en vuelo, buffer WS con pausa/1013/
  `resync`, índices residentes, bytes por respuesta), cursor anterior al historial retenido
  (`firstRetainedSeq`, `gap history_rotated`), L8 en bytes además de eventos. (§4.3; CONVERSATION.md
  §4.4, §6.1)
- Menor: `timeout` no aplica a hooks `async`; el script se autoacota con `timeout -k 1 5` y acota
  cada subproceso. (§4.1; CONVERSATION.md §2.3)

---

## Apéndice A — Comandos de evidencia usados

- `claude --version` → 2.1.308; `time claude agents --json` → 0.17 s.
- Esquemas de hooks: strings del binario `@anthropic-ai/claude-code-linux-x64/claude` 2.1.308
  (`hook_event_name:A("…")`), comparados con `npm pack @anthropic-ai/claude-code-linux-x64@2.1.207`
  (los nombres de todos los hooks existen también en 2.1.207; los campos no se pudieron extraer por
  el minificado distinto → el smoke test los verifica, no se asumen).
- Docs oficiales: `hooks`, `cross-session-messaging`, `agent-view`, `settings`, `managed-settings`,
  `permissions` ("What runs before you trust a folder"), `env-vars`, `sub-agents`, `agent-teams`,
  `sessions`, CHANGELOG (último 2.1.308).
- Estado local: `~/.claude/sessions/<pid>.json`, `~/.claude/projects/<slug>/…`, `tmux list-clients`.
