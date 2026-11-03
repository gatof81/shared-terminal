# Project Chat + Agent Monitor + Channels — RFC de arquitectura

Estado: **borrador para revisión (2026-11-02)**. No vinculante. Nada de esto se implementa hasta que
la POC ([04-poc.md](./04-poc.md)) dé GO y el responsable apruebe las decisiones abiertas (§9). El
contrato vinculante, si se aprueba, se redacta como documento propio (ver roadmap, fase P2) con el
mismo estilo que [CONVERSATION.md](../../CONVERSATION.md).

Documentos hermanos: [visión](./01-vision.md) · [protocolo](./03-protocol.md) ·
[POC](./04-poc.md) · [roadmap](./05-roadmap.md) · [UX](./06-ux.md) ·
[revisión independiente](./07-review.md).

---

## 1. Contexto

Shared Terminal ya tiene, en producción o detrás de banderas:

| Pieza | Qué hace | Dónde | Reutilizable para Project Chat |
| --- | --- | --- | --- |
| Captura de conversación (3.0b–3.0d) | Hooks del CLI → relay loopback → `POST /ingest/claude/hook` → log append-only por conversación en el host | `backend/src/conversation/`, CONVERSATION.md §2–§5 | **Sí**: es la fuente de evidencia de "el agente aceptó el mensaje" y "terminó el turno". |
| Estado del CLI | Máquina de estados por evidencia (hooks + `claude agents --json`), identidad verificada por pane y pid | `state.ts`, `probe.ts`, §5.3 (v1.7.2–v1.7.4) | **Sí**: decide cuándo un agente está en su prompt. |
| Vista Chat (3.1) | Lectura de la conversación por WS con replay sin huecos | `conversation/ws.ts`, `frontend/src/chatView.ts` | **Sí**: el hilo del agente se sigue mostrando ahí. |
| Composer (3.2) | Escribe en el pane por tmux con exclusión durable por pane | `conversation/composer.ts`, §8 | **No como transporte**. Queda como Control Directo. |
| Activación y recreación (3.0d) | Estado solicitado/efectivo, managed settings montados ro, recreación del contenedor | `activation.ts`, `captureAuth.ts`, `recreate/` | **Sí**: el mismo mecanismo entrega la configuración del canal. |
| Locks y registros durables | `sessionLifecycleLock`, registros atómicos con fsync | `sessionLifecycleLock.ts`, `paneRecord.ts`, `recreateAttempt.ts` | **Sí** (patrones). |
| Autorización | owner / admin / lead con `assertOwnedBy*`, `assertCanObserve`, `assertCanOperate` | `sessionManager.ts`, `routes/shared.ts` | **Sí**; Project Chat es owner-only en v1. |

El problema: hoy un mensaje del Chat a Claude sólo puede viajar por tmux (Composer), con todas las
precondiciones de §8.1.3 y su riesgo residual (§8.1.10: texto mezclado con lo tecleado, Enter
consumido por un diálogo, `misdelivered`). Además no existe ningún modelo de proyecto, de agente
estable, ni de mensajes entre agentes.

## 2. Objetivos y no-objetivos

Objetivos:

1. Un chat por proyecto donde humanos y agentes intercambian mensajes con menciones.
2. Entrega a una sesión interactiva **existente** sin escribir en tmux.
3. Separar tres hechos: **transportado**, **aceptado** (evidencia de que el agente lo tomó) y
   **resultado**.
4. Un único historial por hecho: ningún mensaje vive en dos almacenes que puedan divergir.
5. Fallo cerrado: sin reintentos automáticos que puedan duplicar un turno.
6. Reutilizar backend, captura, activación y almacenamiento existentes; ningún servicio nuevo fuera
   del contenedor, ninguna base de datos ni cola nueva.

No-objetivos (fase 1): tareas tipo Jira, asignaciones con estados de flujo, proyectos con varios
humanos, edición de mensajes, adjuntos, relay de permisos, agentes headless (`-p`), teammates.

## 3. Evidencia sobre Claude Code Channels

Fuentes: documentación oficial (`code.claude.com/docs/en/channels`, `channels-reference`, `mcp`,
`hooks`), CHANGELOG del CLI, issues públicos de `anthropics/claude-code`, plugins oficiales
(`claude-plugins-official/external_plugins/telegram`, `fakechat`) y **strings del binario 2.1.314**
instalado en esta máquina (`claude.exe`, no ejecutado). Nada se probó contra una sesión real
(límite de esta fase). Las citas de la documentación pasaron por un extractor web: se revalidan
contra la página antes de la POC.

### 3.1 Capacidades

Leyenda: **D** documentado · **B** observado en el binario 2.1.314 · **O** observado manualmente por
el responsable el 2026-11-02 con su suscripción y `fakechat` oficial (exploratorio, sin hooks; 04-poc.md
§1.8) · **I** reportado en un issue (no verificado) · **H** hipótesis · **—** sin evidencia.

| # | Capacidad | Evidencia | Estado |
| --- | --- | --- | --- |
| C1 | Un servidor MCP con `capabilities.experimental['claude/channel']` empuja `notifications/claude/channel {content: string, meta?: Record<string,string>}` | D (channels-reference); B (`v$t` = `{method:"notifications/claude/channel", params:{content, meta?}}`) | **Comprobado en doc + binario** |
| C2 | El CLI lo convierte en una entrada de su cola de comandos: `enqueue({mode:"prompt", value:<channel source="…" k="v">content</channel>, priority:"next", isMeta:true, origin:{kind:"channel", server}, skipSlashCommands:true, skipAttachments:true})` | B | **Observado en binario**. `skipSlashCommands` ⇒ un `/` inicial no se interpreta como comando (a confirmar en POC) |
| C3 | Claves de `meta` que no cumplen `^[a-zA-Z_][a-zA-Z0-9_]*$` se descartan en silencio | D; B (`dropped N meta key(s)`) | Comprobado (doc + binario) |
| C4 | Entrega a una sesión **interactiva ya abierta** (el servidor es hijo stdio del CLI) | D ("spawns it as a subprocess and communicates over stdio"; "Events only arrive while the session is open"); **O** 3/3 | **Observado** con `fakechat`; con nuestro servidor, **H** |
| C5 | **Despertar** una sesión en su prompt | D (sólo como ejemplo en el quickstart); I #44380 "Channel messages don't wake idle sessions" (abierto); **O** 3/3, una tras ≈ 3 min sin mensajes; **O** prueba instrumentada T (2026-11-03): despertar y flujo bidireccional tras 32 s de inactividad observada | **Observado en muestra mínima**; tras ≥ 1 h y con fiabilidad, **H** — criterio de la fase 0 |
| C6 | Recibir mientras Claude trabaja | D: "If several notifications arrive while Claude is busy, they're delivered together on the next turn and Claude handles them as a group"; B: `priority:"next"` | Documentado: **se encolan y se agrupan** (rompe la correlación 1 mensaje ↔ 1 turno) |
| C7 | Confirmación de entrega | D: "Claude Code doesn't acknowledge notifications… resolves when the message is written to the transport… drops the events silently" | **No existe**. Hay que construirla con evidencia externa (§5.4) |
| C8 | `UserPromptSubmit` para la entrada de canal | B: el esquema declara `source` (`system` = "other machine-injected turns (peer/**channel messages**, …)") con la salvedad *"Payloads may omit it while the field rolls out"*; pero en 2.1.314 y 2.1.317 los dos constructores del payload ponen `...!1` donde iría el campo ⇒ **nunca** se emite. I #94675 (abierto; ausente hasta 2.1.316). **O** (prueba T, 2.1.317, 04-poc.md §1.10): hook a +0,05 s con una etiqueta `<channel>` y el `message_id` de Fakechat como atributo; `source` **ausente** | Hook y etiqueta **observados**; `source` **no disponible** en las versiones conocidas ⇒ G3 no se cumple y ninguna entra en `CHANNEL_CLI_VERSIONS`. El origen existe dentro del CLI (C2, transcript) pero no llega al hook; alternativas en 04-poc.md §1.10 |
| C9 | Respuesta | D: herramienta MCP `reply` convencional; I #95011 "Claude does not call the reply tool automatically"; **O** 3/3 cuando el mensaje lo pedía | Documentado; **no determinista** (depende del modelo); por eso el resultado sigue siendo el `turn_end` (R8) |
| C10 | `--resume` / `--continue` | — (docs no dicen nada); I #78028, #90160, #101872, #80707 (flag perdido en re-host/fork/background) | **Hipótesis**; la POC lo mide |
| C11 | Varias sesiones simultáneas | D: "run separate sessions"; un servidor por proceso CLI | Documentado (un proceso de canal por CLI) |
| C12 | Reconexión | B: "Channel notifications re-registered after reconnect"; CHANGELOG 2.1.187 (conexiones caídas tras `/bg`, `/tui`, `/update`) | Parcial; **H** sin pérdidas |
| C13 | Requiere `--channels <servers>` al lanzar; flag oculto en `--help` | D; B (`--channels <servers...>` con `hideHelp()`); **O** | Comprobado |
| C14 | Servidor propio fuera de la allowlist ⇒ `--dangerously-load-development-channels server:<name>` (confirmación al arrancar) o plugin admitido por `allowedChannelPlugins` en managed settings | D; B ("is not on the approved channels allowlist (use --dangerously-load-development-channels for local dev)") | Comprobado; **H** que un marketplace local en la imagen sea admitible; **O**: el plugin oficial `fakechat` se carga con `--channels plugin:…` sin flag de desarrollo |
| C15 | Política: `channelsEnabled` en managed settings. claude.ai Team/Enterprise: apagado por defecto; Console (API key): **encendido salvo que existan managed settings** | B (descripción del setting); D (enterprise controls) | Comprobado. **Nuestros contenedores tienen managed settings** (`managed-settings.d/conversation.json`) ⇒ hay que escribir `channelsEnabled: true`. Planes individuales de claude.ai (Pro/Max): según la doc "skip these checks entirely"; el binario sólo exige el setting a Team/Enterprise. Pero #105326 reporta "not currently available" en Max desde 2026-10-25: **la disponibilidad con la suscripción del responsable es lo primero que comprueba la fase 0**; **O**: disponible con la suscripción del responsable el 2026-11-02 |
| C16 | Sólo proveedor first-party (claude.ai o Console); no Bedrock/Vertex/Foundry. **Para este proyecto sólo se usa la suscripción de claude.ai** (decisión del responsable) | D; B ("channels are not available on third-party providers") | Comprobado |
| C17 | Kill switch remoto: "channels feature is not currently available" | B (gate `Oj()`); I #105326 (Max, desde 2026-10-25, abierto) | **Riesgo**: Anthropic puede apagarlo sin release; **O**: no activado para la suscripción del responsable el 2026-11-02 (el riesgo sigue) |
| C18 | Servidor que negocia la revisión MCP 2026-07-28 ⇒ no se registra como canal | D (mcp: "can't deliver channel messages"); B (`era: modern` ⇒ skip) | Comprobado: nuestro servidor **MUST** negociar la revisión anterior |
| C19 | No funciona en `-p` / Agent SDK | D; I #99658 | Comprobado: sólo agentes interactivos |
| C20 | Con `--channels` activo se desactivan `AskUserQuestion` y las herramientas de plan mode | CHANGELOG 2.1.83 | Documentado; **H** que siga vigente en 2.1.314. Impacto UX en el Terminal |
| C21 | Relay de permisos (`claude/channel/permission`) | D; B | Fuera de alcance: no lo declaramos (§7) |
| C22 | Estado de research preview | D | Riesgo de dependencia permanente hasta GA |

### 3.2 Lo que esto significa

- Channels resuelve **el transporte** (sin tmux, sin pegar en el input, sin carrera con lo tecleado)
  y **nada más**: no confirma, no persiste, no deduplica, agrupa en `busy` y puede no despertar.
- La confirmación tiene que venir de la **captura de hooks** que ya tenemos (C8) — **condicionado**:
  con 2.1.314–2.1.317 el hook no trae `source`, así que hoy no distingue una entrada de canal de un
  texto tecleado con la misma forma (G3, 04-poc.md §1.10). Si el
  `UserPromptSubmit` de la entrada de canal llega con la etiqueta y nuestro identificador, tenemos
  una evidencia tan fuerte como el ack del Composer (§8.1.7), y sin depender de que el modelo llame
  a una herramienta.
- El resultado tiene que venir del `Stop` del turno correlacionado (`turn_end.last_assistant_message`,
  ya persistido), no de que el modelo decida llamar a `reply` (C9).
- El orden y la ausencia de duplicados los garantiza el monitor entregando **un mensaje por agente
  a la vez y sólo con el agente en su prompt** (evita C6).

## 4. Alternativas

| Criterio | A. **Channels** + monitor | B. Hooks (`asyncRewake` / `Stop` block / `additionalContext`) | C. MCP convencional (pull `check_inbox`) | D. Composer (tmux) | E. `claude -p --resume` por mensaje (exec API) |
| --- | --- | --- | --- | --- | --- |
| 1. Entrega a sesión interactiva existente | Sí (D) | Sí, sólo en eventos del ciclo de hooks | Sólo si el modelo llama a la herramienta | Sí | **No**: segunda instancia sobre la misma conversación |
| 2. Despertar en el prompt | Disputado (#44380) | `asyncRewake`: D ("wakes the model on exit code 2"), sin probar con un prompt inactivo | **No** | Sí | n/a |
| 3. Recibir mientras trabaja | Encola y agrupa (D) | `Stop` block: al final del turno; `additionalContext`: sólo en el siguiente prompt | No | Encola en el input (§8.2.1); por eso §8.1.3 lo bloquea | n/a |
| 4. Respuestas/resultados | Hook `Stop` (determinista) + herramienta opcional | Hook `Stop` | Herramienta | Hook `Stop` | stdout del exec |
| 5. Continuidad tras `--resume` | H (issues abiertos) | Sí: los hooks son managed settings, no flags | Sí | Sí | n/a |
| 6. Varios agentes | Un servidor por CLI (D) | Sí | Sí | Lock por pane | Sí |
| 7. Recuperación | Monitor + evidencia | Monitor + evidencia | Monitor | Registro de pane durable | Registro de exec |
| Escribe en tmux | **No** | No | No | **Sí** | No |
| Autoridad del texto para el modelo | `<channel source=…>` con `isMeta` (no es turno humano) | system-reminder "Stop hook feedback" | resultado de herramienta | turno humano | turno humano |
| Estabilidad de la API | **Research preview**, kill switch remoto (C17) | Hooks: interfaz estable que ya usamos (CONVERSATION.md §1); `asyncRewake`: documentado en hooks-guide | Estable | tmux estable; comportamiento del input del CLI validado sólo en 2.1.314 | Estable |
| Cambios en el contenedor | Flag `--channels` en el lanzamiento + servidor + managed settings | Sólo managed settings + script | Servidor MCP | Ninguno | Ninguno |
| Coste/complejidad | Medio | Medio (re-armado por turno, cancelación) | Bajo pero no cumple | Ya existe; alta complejidad acumulada | Bajo pero no cumple |

Descartadas: **C** (no despierta; depende de que el modelo consulte), **E** (crea otra instancia
sobre la misma conversación: viola "no crea sesiones nuevas" y colisiona con la interactiva — ya
descartada en phase3 §5.1), **D como transporte principal** (es lo que el producto quiere dejar de
ampliar; queda como Control Directo).

Quedan **A** (objetivo) y **B** (alternativa evaluada en la POC si A falla en C5 o C10). Ambas
comparten el 90 % del diseño: el monitor, la persistencia, la evidencia por hooks y la UI no
dependen del adaptador. Sólo cambia el proceso que, dentro del contenedor, pone el texto delante del
modelo.

## 5. Decisión propuesta

### 5.1 Componentes

```mermaid
flowchart LR
  subgraph Browser
    UI[Project Chat UI]
  end
  subgraph Backend["Backend (proceso existente)"]
    API[routes/projects.ts]
    MON[projectChat/monitor.ts]
    LOG[(log del proyecto\nhost, append-only)]
    D1[(D1: projects,\nproject_agents)]
    CAP[conversation/service.ts\ncaptura existente]
    CHI[/ingest/channel/*/]
  end
  subgraph Container["Contenedor de sesión (agente)"]
    CLI[claude interactivo\n--channels]
    STC[st-channel\nservidor MCP stdio]
    RELAY[relay.py existente]
  end
  UI -- REST/WS --> API --> MON
  MON --> LOG
  MON --> D1
  STC -- long-poll / POST\n(token de ingesta) --> CHI --> MON
  STC -- notifications/claude/channel --> CLI
  CLI -- hooks --> RELAY -- /ingest/claude/hook --> CAP
  CAP -- evidencia: channel_prompt,\nturn_end, estado --> MON
```

| Componente | Nuevo / reutilizado | Responsabilidad |
| --- | --- | --- |
| `projectChat/monitor.ts` (backend) | **Nuevo módulo**, mismo proceso | Fuente de verdad de mensajes y entregas; elegibilidad; límites; política entre agentes; correlación con la evidencia. |
| Log del proyecto `<WORKSPACE_ROOT>/.projects/<projectId>/chat.events.jsonl` | **Nuevo archivo**: formato de `conversation/store.ts` (seq, snapshot, rotación) pero escritura con fsync y **sin** ruta de descarte (protocolo §2.2) | Contenido y transiciones. El contenido **nunca** entra en D1. |
| D1 `projects`, `project_agents`, `project_agent_edges` | **Nuevas tablas**, migración append-only | Metadatos: propiedad, membresía, handles, política. Sin contenido. |
| `/ingest/channel/*` (backend) | **Nuevas rutas**, montadas como `/ingest/claude/hook` (antes de `express.json`, lector de cuerpo acotado) | API del endpoint de canal autenticada con el token de ingesta de la sesión. |
| `st-channel` (imagen) | **Nuevo proceso**, hijo stdio del CLI, Python stdlib como `relay.py` | Adaptador Channels: registra el runtime, recibe el mensaje del monitor, emite la notificación, expone herramientas de publicación. **Sin estado durable.** |
| Captura de conversación | **Reutilizada**, un clasificador nuevo (`channel_prompt`) | Evidencia de aceptación y de fin de turno. |
| Activación (managed settings + recreación) | **Reutilizada** | Escribe `channelsEnabled`, `allowedChannelPlugins` y el lanzamiento con `--channels` cuando el agente está habilitado. |
| Vista Chat | **Reutilizada** | Hilo de ejecución del agente (herramientas, deltas). |
| Composer | **Congelado** | Control Directo, nunca invocado por el monitor. |

No hay procesos nuevos en el host, ni colas externas, ni otra base de datos.

### 5.2 Modelo

```mermaid
erDiagram
  USER ||--o{ PROJECT : owns
  PROJECT ||--o{ PROJECT_AGENT : has
  PROJECT_AGENT ||--|| ST_SESSION : "runs in (v1: 1 sesión por agente)"
  ST_SESSION ||--o{ RUNTIME : "arranque × proceso claude con st-channel"
  RUNTIME ||--o{ CONVERSATION : "session_id vivo (cambia con /clear, /resume)"
  PROJECT ||--o{ MESSAGE : "log del proyecto"
  MESSAGE ||--o{ DELIVERY : "una por destinatario"
  DELIVERY }o--o| CONVERSATION : "aceptada en (cid, prompt_id)"
```

- **Proyecto**: propiedad de un usuario (owner-only en v1, como las conversaciones, phase3 §3.4).
- **Agente**: identidad lógica estable (`agent_id` UUID + `@handle`), ligada a **una** sesión ST del
  mismo owner. Sobrevive a reinicios del CLI, `--resume`, `/clear`, paradas y recreaciones del
  contenedor.
- **Runtime**: la instancia concreta que puede recibir: (`st_session_id`, generación de arranque
  `startGen` de §5.2 v1.7.2, `endpoint_id` de `st-channel`, `claude_pid`, `pane`). Muere con el
  proceso.
- **Conversación**: el `session_id` de Claude que está vivo en ese proceso; es **evidencia** de dónde
  se procesó un mensaje, nunca la dirección del mensaje.

Los mensajes se dirigen a **agentes**; el monitor resuelve agente → runtime en el momento de entregar
y registra en qué conversación se aceptó.

### 5.3 Un solo historial por hecho

| Hecho | Único lugar donde vive | Cómo aparece en la otra vista |
| --- | --- | --- |
| Texto de un mensaje humano o de un agente al proyecto | Log del proyecto | En la conversación del agente aparece como `channel_prompt` **sin texto** (referencia `st_msg`), igual que `internal_prompt` (§4.2.1) |
| Ejecución del agente (deltas, herramientas, informe final) | Log de la conversación (captura) | En el proyecto aparece como tarjeta de resultado que **referencia** (`cid`, `seq` del `turn_end`) y se renderiza desde la captura |
| Mensaje enviado por Control Directo (Composer) | Log de la conversación (`user_prompt` + `composer_send`) | En el proyecto: marcador "Control directo" con enlace, sin copia |
| Estado del agente (trabajando, esperando, desconectado) | Captura (`state.ts`) + runtime en memoria | Presencia en el roster |

### 5.4 Entrega: transporte, aceptación y resultado

```mermaid
sequenceDiagram
  participant H as Humano (UI)
  participant M as Monitor (backend)
  participant S as st-channel (contenedor)
  participant C as claude (CLI)
  participant K as Captura (hooks)
  H->>M: POST message {to:@dev, text, clientMessageId}
  M->>M: persistir message + delivery queued
  Note over M: elegible ⇔ runtime único ∧ agente en prompt (evidencia verificada) ∧ nada en vuelo
  S->>M: GET /ingest/channel/next (long-poll)
  M-->>S: {msg, lease}
  M->>M: delivery transporting
  S->>C: notifications/claude/channel {content, meta:{st_msg,…}}
  S->>M: POST transported {lease}
  M->>M: delivery transported
  C->>K: UserPromptSubmit (source=system, prompt=<channel … st_msg=…>)
  K->>M: channel_prompt {st_msg, cid, prompt_id}
  M->>M: delivery accepted (cid, prompt_id)
  C->>K: Stop (last_assistant_message)
  K->>M: turn_end {prompt_id, seq}
  M->>M: delivery completed + result ref (cid, seq)
  M-->>H: WS: estados y tarjeta de resultado
```

- **Transportado** = `st-channel` informó que escribió la notificación en el stdio del CLI. No dice
  que el CLI la haya encolado (C7).
- **Aceptado** = la captura persistió un `channel_prompt` con ese `st_msg` desde el pane del runtime.
  Dice que el CLI la convirtió en un turno. No dice nada del resultado.
- **Completado** = llegó el `turn_end` del `prompt_id` aceptado **y ninguna otra entrada compartió
  ese turno** (protocolo §3.1). Sólo entonces el **resultado** es ese informe final (referencia), más
  cualquier publicación explícita del agente con `in_reply_to`. Si otra entrada compartió el turno
  (Terminal, Control Directo, notificación de tarea), o el mensaje se encoló detrás de otro turno, o
  hubo pérdidas de hooks, la entrega termina `ended_unattributed` y el informe no se presenta como
  respuesta al mensaje. La regla mira la secuencia de eventos y no sólo `prompt_id`, porque el CLI
  anuncia una entrada encolada con el `prompt_id` del turno en curso (CONVERSATION.md §8.2.1).
- Sin `channel_prompt` dentro de `T_accept` ⇒ `uncertain`: el CLI puede tenerlo en su cola y
  ejecutarlo más tarde, así que sigue contando como en vuelo. Pasa a `unconfirmed` sólo con evidencia
  de que el CLI ya no lo tiene (protocolo §3 regla 2b). **Nunca** se reenvía solo, ni por Channels
  ni por Composer: la persona decide (nuevo mensaje, o Control Directo explícito), y sólo cuando la
  entrega ya es `unconfirmed`.

### 5.5 Elegibilidad y concurrencia (el monitor evita el agrupamiento)

Un mensaje se entrega a un agente sólo si:

1. hay **exactamente un** runtime registrado para el agente en el arranque actual del contenedor
   (dos ⇒ `runtime-ambiguous`, nada se entrega);
2. la conversación viva de ese runtime (probe: entrada con `pid = claude_pid`) está en
   `waiting_input` **con identidad verificada** (§5.3 v1.7.2, regla de prompt de v1.7.4);
3. el agente no tiene otra entrega `transporting`/`transported`/`accepted` sin completar;
4. el pane no tiene una operación del Composer sin liberar (registro de pane, §8.1.4.1).

Con eso, el caso documentado de agrupamiento en `busy` (C6) sólo puede ocurrir por una carrera con
algo que **no** es el monitor (la persona escribe en el Terminal en el mismo instante, o termina una
tarea en background). Esa carrera se detecta por `prompt_id` dentro de la ventana del turno y la
entrega termina `ended_unattributed{mixed-input}`: nunca se atribuye un informe compartido a un solo
mensaje (protocolo §3.1).

### 5.6 Agente a agente

- Un agente publica con herramientas MCP de `st-channel` (`chat_post`, `chat_send`), nunca escribiendo
  en el chat por otro camino.
- Un mensaje de agente a agente **no se entrega** sin autorización: por defecto queda
  `awaiting_approval` hasta que el owner lo aprueba en la UI. El owner puede declarar aristas
  `from → to` en modo `allow` para un proyecto.
- Toda entrega lleva `from_kind="agent"` en `meta`; las instrucciones del servidor dicen que es una
  petición de un par, no del owner. Esto es **defensa en profundidad**, no la garantía: la garantía
  es que nada llega sin aprobación o arista explícita (los agentes corren con
  `--dangerously-skip-permissions`, así que cualquier texto entregado tiene el poder completo del
  contenedor destino).
- Límites anti-bucle (protocolo §8): profundidad de cadena ≤ 3, ≤ 20 mensajes por cadena, ≤ 10
  mensajes salientes por minuto por agente, ≤ 5 destinatarios, sin auto-envío, cola por agente ≤ 20.

### 5.7 Relación con Composer y Terminal

- El monitor **nunca** llama al Composer. Un fallo de Channels se informa y se detiene.
- El Composer pasa a ser **Control Directo**: acción explícita de la persona, desde el panel del
  agente, con el aviso de que escribe en el terminal. Sin cambios de contrato (§8 sigue vigente).
- Exclusión mutua: el monitor no entrega si el pane tiene un registro del Composer sin liberar
  (regla 4). La regla inversa (el Composer rechaza con 409 si hay una entrega del monitor en vuelo)
  es un cambio pequeño de §8.1.3 que se hace en su propio PR (roadmap P6), no en esta fase.
- El Terminal no cambia. Con `--channels` activo el CLI desactiva `AskUserQuestion` y plan mode
  (C20): por eso el canal se habilita **por agente**, no en todas las sesiones.

## 6. Fallos y recuperación

| Situación | Qué pasa | Qué ve la persona |
| --- | --- | --- |
| CLI sin `--channels`, o canal no registrado (C13–C18) | `st-channel` no arranca o no se registra; no hay runtime | Agente "sin canal" con la razón conocida; mensajes en cola |
| Kill switch remoto (C17) | `st-channel` arranca pero el CLI no registra el handler o descarta la notificación (el gate se evalúa en **cada** notificación, B). Sin señal directa al servidor | La entrega queda `uncertain` → `unconfirmed{no-evidence}` (regla 2b (c)); el runtime pasa a `degraded` en el **primer** caso y no recibe nada más; la cola se conserva y se ve "retenido". Sale sólo por un runtime nuevo o por acción del owner. Nunca Composer (protocolo §6.4) |
| `st-channel` muere antes de informar `transported` | Lease vence (`T_lease`) | `uncertain` (pudo llegar o no) hasta la evidencia de la regla 2b; nada se reenvía |
| Backend se reinicia | Al abrir el log, toda entrega `transporting`/`transported` sin `accepted` pasa a `uncertain{orphaned}`; un `channel_prompt` tardío la lleva a `accepted{late}`; `queued` sigue en cola | Igual que arriba |
| Contenedor se para | Runtime retirado (`startGen` cambia en `onSessionDown`); entregas en vuelo ⇒ `unconfirmed`/`interrupted`; `queued` sigue esperando | Agente "desconectado"; cola visible |
| CLI sale (`exit`, crash) sin parar el contenedor | `startGen` **no** cambia; el runtime se retira por `bye`, por la comprobación de `pid` en el siguiente `hello`/`next`, o por silencio (60 s) | Igual; un `claude --resume` inmediato no queda `ambiguous` |
| `claude --resume` | Nuevo proceso ⇒ nuevo `st-channel` ⇒ nuevo runtime (si el alias lleva `--channels`); conversación reanudada | Agente vuelve a estar disponible |
| `/resume` o `/clear` dentro del CLI | Mismo proceso y runtime; cambia la conversación viva | Los mensajes siguientes se aceptan en la conversación nueva; el historial lo muestra |
| Hook perdido (relay) | Sin `channel_prompt` ⇒ `uncertain` y después `unconfirmed` aunque Claude haya trabajado | Explicación "sin evidencia"; el `turn_end` posterior se muestra en el hilo del agente |
| Dos `claude` con canal en el mismo contenedor | `runtime-ambiguous` | Aviso con la acción (cerrar uno) |
| Disco lleno en el host | Escritura del log falla ⇒ el `POST` responde 503, nada se entrega | Error inmediato |

Principio: **at-most-once en el transporte, evidencia para confirmar, la persona decide el
reintento**. Es la misma política que el Composer (§8.1.7) y la que pidió el responsable.

## 7. Seguridad

- **Aislamiento**: proyectos owner-only; todos los agentes de un proyecto pertenecen al owner; una
  sesión pertenece como mucho a un proyecto activo. Admin/lead no leen el chat en v1 (decisión
  abierta §9).
- **Autenticación del endpoint**: token de ingesta de la sesión (`ST_INGEST_TOKEN`, creado con el
  contenedor y conservado entre stop/start), validado contra `ingest_token_hash` + `SESSION_ID`.
  Autoriza sólo a: registrar runtimes de **esa** sesión, recibir mensajes de **su** agente y publicar
  **como** ese agente en **su** proyecto. Cualquier proceso del contenedor tiene el token: la
  evidencia de aceptación es tan fiable como el contenedor del agente, nunca más (protocolo §7).
- **Prompt injection**: (1) entre agentes, aprobación o arista explícita (§5.6); (2) el contenido de
  mensajes de agentes se marca `from_kind="agent"`; (3) el CLI escapa `content` y `meta` (B: `Bd`,
  `EPt`) — **H**, la POC lo prueba con un `</channel>` y atributos falsos dentro del contenido;
  (4) el clasificador de `channel_prompt` acepta sólo una etiqueta bien formada cuyo `st_msg` exista
  en una entrega `transported` de ese runtime; un texto humano que imite la etiqueta no confirma nada.
- **Sin relay de permisos**: `st-channel` no declara `claude/channel/permission` (quien responde por
  el canal podría aprobar herramientas, D).
- **Sin flag de desarrollo en producción**: la POC usa `--dangerously-load-development-channels`; la
  producción usa un plugin en un marketplace local de la imagen, admitido por `allowedChannelPlugins`
  en managed settings (C14, **H**). Si eso no funciona, la decisión vuelve al responsable (§9).
- **Auditoría**: un envío de admin sobre sesión ajena no existe en v1 (owner-only). Las aprobaciones
  agente→agente quedan en el log del proyecto con el usuario que aprobó.

## 8. Compatibilidad

- Todo detrás de `PROJECT_CHAT_ENABLED` (backend) y por agente; apagado ⇒ sin rutas, sin archivos,
  sin cambios en managed settings (como `CONVERSATION_ENABLED`).
- Migraciones D1 append-only (v18+), sólo tablas nuevas. Ninguna columna existente cambia.
- La captura gana un tipo de evento (`channel_prompt`) y un clasificador; los clientes antiguos que
  no lo conocen lo ignoran (el parser del frontend ya tolera tipos desconocidos — **a verificar** en
  P3). La copia idéntica en el frontend sigue la regla de `internalPrompt.ts`.
- Habilitar un agente en una sesión existente necesita recrear el contenedor (imagen con
  `st-channel` + alias con `--channels`), con el motor de 3.0d. Ninguna sesión cambia sin que el
  admin lo pida.
- Versión del CLI: lista explícita `CHANNEL_CLI_VERSIONS`, como `COMPOSER_CLI_VERSIONS`; fuera de la
  lista el agente queda "canal no validado" y no recibe. Revalidar exige autenticación first-party
  real (C16–C17: el mock del smoke no sirve), así que no puede ser un job de CI ordinario. Con el
  auto-update de los workspaces, cada versión nueva dejaría a los agentes sin canal hasta revalidar.
  Decisión (R9): **fijar la versión del CLI en las sesiones de agente** (sin auto-update) y
  revalidar con una corrida manual firmada antes de subir el pin, autenticada con la suscripción del
  responsable y sin gasto adicional (mismas reglas que la POC, 04-poc.md §1.4).

## 9. Decisiones del responsable (2026-11-02)

La dirección está aprobada **conceptualmente**. No están autorizados: ejecutar la POC, implementar
el monitor, mergear ni desplegar.

| # | Decisión | Resolución del responsable |
| --- | --- | --- |
| R1 | Dependencia de un research preview con kill switch remoto | **Sí, condicional a una POC exitosa.** Channels puede ser el transporte principal, pero no una dependencia indispensable del producto: degradación visible y ningún fallback automático (protocolo §6.4) |
| R2 | Alternativa si Channels no despierta o no sobrevive a `--resume` | **Sí, evaluar `asyncRewake`** (POC E13) si Channels falla. **No** se aprueba automáticamente para producción |
| R3 | Agente ↔ sesión | **1:1** |
| R4 | Agente → agente | **Aprobación humana por defecto** y reglas explícitas (aristas `allow`) |
| R5 | Visibilidad | **Owner-only en v1** |
| R6 | Carga del canal | **Plugin local autorizado** (`allowedChannelPlugins`); **sin** flags de desarrollo en producción |
| R7 | Alcance | Channels **sólo** en sesiones configuradas como agentes |
| R8 | Resultado | `turn_end` del turno aceptado, **siempre que la correlación sea inequívoca** (protocolo §3.1; si no, `ended_unattributed`) |
| R9 | Versión del CLI | **Fijada** en sesiones de agente; se actualiza sólo tras validación (con la suscripción, sin gasto adicional). Las sesiones convencionales no cambian |
| — | Autenticación de la POC (**decisión definitiva**, reemplaza la propuesta anterior de API key de Console) | **Sólo la suscripción de Claude del responsable**, con el login oficial de Claude Code. Sin Console ni API keys de pago. Sin extraer ni reutilizar tokens OAuth o credenciales de sesiones existentes |
| — | Consumo de la POC | **Ningún gasto adicional**: sólo lo incluido en la suscripción, con el uso extra desactivado. La propuesta anterior de USD 30 queda sin efecto |
| — | Secuencia | Primero **sólo la fase 0** con `fakechat`, previa autorización para esa prueba: disponibilidad con la suscripción y despertar de una sesión inactiva. Bloqueo de Channels para la suscripción ⇒ **NO-GO**, sin cambiar a API. Si funciona ⇒ resultados y **GO separado** para la POC completa (04-poc.md §1.7, §7) |
