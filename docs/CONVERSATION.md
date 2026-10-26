# Conversation & Agent Activity — contrato técnico (Fase 3)

Estado: **v1.6 (3.0a, rondas 1 a 3 de revisión Work; en 3.0c, transporte por relay local §2.6, aprobado
por el responsable el 2026-10-23; decisiones de cierre de 3.0c sobre `emissionStopsAfterRestart` y el
par `tool_failed`/`tool_end`, 2026-10-23; en 3.0d, recreación administrativa y activación
progresiva §2.7, diseño aprobado por Work y el responsable el 2026-10-26), vinculante para los PRs
3.0b–3.4.** El razonamiento está en [docs/design/phase3-conversation-activity.md](./design/phase3-conversation-activity.md)
y, para 3.0d, en [docs/design/phase3-3.0d-activation.md](./design/phase3-3.0d-activation.md) (v5,
`ac1024d`); si los dos documentos difieren, manda este;
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
| Hook `type: "http"` con `headers` + `allowedEnvVars` | idem | 2.1.308 | Transporte CLI → relay local (§2.6) |
| Bloqueo de destinos privados de los hooks HTTP (`ERR_HTTP_HOOK_BLOCKED_ADDRESS`) | comportamiento del binario 2.1.308 | 2.1.308 | Restricción: ver nota |
| `python3` de la imagen (solo biblioteca estándar) | docs.python.org/3/library | 3.12 (Ubuntu 24.04) | Relay §2.6 |
| Managed settings en archivo: `/etc/claude-code/managed-settings.d/*.json` | code.claude.com/docs/en/managed-settings | 2.1.308 | Entrega de la configuración |
| `claude agents --json` | code.claude.com/docs/en/agent-view | 2.1.308 | Probe de estado |
| Variables `TMUX_PANE` (tmux) y `SESSION_ID` (Shared Terminal) | tmux(1); `buildContainerEnv` | — | Binding y auth |

Nota (3.0c): antes de enviar un hook `http`, el CLI 2.1.308 resuelve el host y **rechaza** cualquier
dirección de 0/8, 10/8, 100.64/10, 169.254/16, 172.16/12, 192.168/16, fc00::/7, fe80::/10 y `::`
(mensaje `HTTP hook blocked: … resolves to … (private/link-local address). Loopback (127.0.0.1,
::1) is allowed for local dev.`). Solo lo omite si la petición sale por un proxy; ningún setting ni
variable lo desactiva. En `sessions-net`, `st-backend` siempre resuelve a una IP privada, así que
el destino directo de v1.3 nunca funcionó con el CLI real. Es una protección deliberada del CLI:
**no se esquiva** (ni cambiando la subred de `sessions-net` ni con un proxy); los hooks apuntan a
loopback, a un relay dentro del propio contenedor (§2.6), que reenvía al backend.

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
| Relay local | `/opt/st/hooks/relay.py` (imagen, root 0755); proceso escuchando en `127.0.0.1:47613` | Dockerfile; lo lanza el supervisor de `entrypoint.sh` solo con la captura autorizada (§2.6) |
| Directorio de control (3.0d) | host `<WORKSPACE_ROOT>/.st-control/<st_session_id>/` (root, fuera del workspace y de `.claude-managed`), montado **ro** en `/etc/st-control`; contiene a lo sumo `relay.enabled`, `defer-skill-seed` y `recreate-attempt.json` (sin secretos) | backend: `relay.enabled` según §2.7.5, `defer-skill-seed` según §2.7.3, el registro del intento según §2.7.4. Ningún archivo de este directorio es un setting del CLI |
| Siembra de skills | `/opt/st/seed-skills.sh` (imagen, root 0755), la misma que ejecuta el entrypoint | Dockerfile; la ejecuta el entrypoint en cada arranque salvo con `defer-skill-seed` (§2.7.3) |
| Archivo de hooks por sesión | host `<WORKSPACE_ROOT>/.claude-managed/<st_session_id>/conversation.json`, montado **ro** en `/etc/claude-code/managed-settings.d/` | backend, según la tabla §2.4 |
| Token de ingesta | env `ST_INGEST_TOKEN` del contenedor (32 bytes aleatorios, hex) | backend, **solo al crear el contenedor** (`spawn`, o la recreación de §2.7) y solo si la sesión está *solicitada* (§2.4). `startContainer` sobre un contenedor existente no lo cambia (§2.4.1) |
| Estado solicitado | D1 `sessions.conversation_requested INTEGER NOT NULL DEFAULT 0` | API admin / allowlist / comando de emergencia |
| Estado efectivo | derivado, §2.7.6: autorización completa (§2.7.5) ∧ `relay.enabled` ∧ `conversation.json` ∧ relay identificado por un probe en la misma petición | backend; `reconcile` converge marca y archivo hacia ese estado |

Reglas:

- El directorio host `.claude-managed/<sid>` *MUST* existir (vacío si no aplica) antes de
  `container.start()`, igual que `.uploads/<sid>`; el bind es siempre `ro`. Lo mismo el directorio
  de control `.st-control/<sid>` en todo contenedor creado con captura por un backend 3.0d, con
  imagen `io.shared-terminal.conversation-relay="2"`. Un contenedor sin ese montaje nunca es
  efectivo con 3.0d (§2.7.6).
- El directorio de control se borra con la sesión en el hard delete (`onSessionPurged`), no entra
  en el backup, y `reconcile` lo regenera desde D1.
- Permisos del directorio de control: `root:root 0755`, marcas `0644`, `recreate-attempt.json`
  `0600`. El usuario de la sesión *MUST* poder consultar las marcas (buscar en el directorio) y
  *MUST NOT* poder modificarlas (montaje ro, propiedad de root). La imagen trata un directorio
  que no puede examinar como "marca presente" (fail-closed, §2.7.3), así que un `0700` bloquearía
  la siembra para siempre. El backend fija el modo con un `chmod` explícito: `mkdir` no cambia
  los permisos de un directorio que ya existe.
- La imagen *MUST* comportarse de forma idéntica a la actual cuando el directorio montado está
  vacío (smoke test: `claude -p hola` no produce ninguna petición saliente a `st-backend` ni al
  puerto del relay, y no hay ningún proceso relay).
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
  "url": "http://127.0.0.1:47613/ingest/claude/hook",
  "timeout": 1,
  "headers": { "X-ST-Tmux-Pane": "$TMUX_PANE" },
  "allowedEnvVars": ["TMUX_PANE"]
}
```

- El destino es el relay del contenedor (§2.6), en loopback: el único destino que el CLI acepta
  (nota de §1). El puerto `47613` es fijo y es parte del contrato (archivo, script y relay).
- El CLI **no** recibe el token: no hay `Authorization` ni `X-ST-Session` en el archivo. Los añade el
  relay al reenviar, desde su propio entorno. Así un setting de usuario `httpHookAllowedEnvVars` sin
  el token ya no puede vaciarlo (solo puede vaciar el pane), y el token no pasa por el cliente HTTP
  del CLI ni por un proxy de usuario.
- `st-backend` *MUST* seguir siendo un alias del servicio `app` en `sessions-net`
  (`docker-compose.yml`, `networks.sessions-net.aliases`): es el destino fijo del relay. El puerto es
  el `PORT` del backend; el entrypoint se lo pasa al relay (`ST_BACKEND_PORT`, default 3001).
- `timeout: 1` es deliberado: el relay responde tras leer el cuerpo y encolarlo (milisegundos); un
  relay caído rechaza la conexión al instante; un relay detenido sin cerrar el puerto (SIGSTOP)
  cuesta ≤ 1 s por evento bloqueante. *MUST NOT* subirse sin cambiar este documento.
- El hook `SessionStart` es `async: true` y **no lleva `timeout`**: la documentación oficial dice
  que `timeout` no se aplica a hooks de comando asíncronos, así que el script se acota a sí mismo
  (§2.3).
- Ningún hook de este archivo *MUST* devolver un cuerpo con `decision`, `permissionDecision`,
  `continue`, `updatedInput`, `additionalContext` ni `displayContent`: el receptor responde **204 sin
  cuerpo** en todos los casos (test).

### 2.3 `session-start.sh`

Entrada: JSON de `SessionStart` por stdin. Comportamiento (implementado en
`session-image/hooks/session-start.sh`, 3.0c):

1. Primera línea ejecutable: `[ -z "$ST_HOOK_WRAPPED" ] && ST_HOOK_WRAPPED=1 exec timeout -k 1 5
   /bin/bash "$0" "$@"`. **El script entero, con todos sus subprocesos, termina en ≤ 6 s pase lo que
   pase** (`timeout` mata al grupo de procesos completo).
2. Si `ST_INGEST_TOKEN` está vacío o no definido: exit 0 sin salida ni red.
3. Lee como máximo 64 KiB de stdin; si no es un objeto JSON, exit 0 sin red. Construye el JSON de
   salida = entrada + `{ "st": { "claude_version", "tmux_session", "pane", "argv_flags" } }` donde:
   - `claude_version` = `timeout 3 claude --version` (null si falla);
   - `tmux_session` = `timeout 1 tmux display-message -p -t "$TMUX_PANE" '#S'`, solo si `$TMUX` y
     `$TMUX_PANE` están definidos (null si no, o si falla): sin `$TMUX`, un `tmux` sin `-t` respondería
     por el servidor que encuentre, no por el pane del hook;
   - `pane` = `$TMUX_PANE` o null;
   - `argv_flags` = **solo** las banderas del proceso `claude` que disparó el hook que estén en la
     allowlist `-p --print --bare --resume --continue --fork-session --agent --agent-name
     --agent-type --agent-id --teammate-mode --dangerously-skip-permissions --permission-mode`, como
     `--flag` o `--flag=valor`, sin valores salvo el de `--agent-name`/`--agent-type`/`--teammate-mode`
     /`--permission-mode` (≤ 64 bytes; un valor más largo se omite y queda la bandera sola). Ese
     `claude` se busca subiendo por `/proc` **solo a través de** `timeout`, `sh`, `bash` o `dash` (en
     2.1.308 la cadena es script ← `timeout` ← `/bin/sh -c` ← `claude`); cualquier otro ancestro
     corta la búsqueda (`argv_flags: []`), para no tomar las banderas de un `claude` no relacionado más
     arriba. El backend vuelve a filtrar (`filterArgvFlags`). Nunca se persiste el argv completo (puede
     llevar `--append-system-prompt`, rutas o secretos).
4. `curl -q --silent --noproxy '*' --max-time 2 --output /dev/null -X POST -H 'Content-Type:
   application/json' -H "X-ST-Tmux-Pane: $TMUX_PANE" --data-binary @-
   http://127.0.0.1:47613/ingest/claude/hook`, es decir, al relay (§2.6), igual que los hooks HTTP:
   un solo camino y un solo orden hacia el backend. El script no envía el token (lo añade el relay);
   `-q` ignora `~/.curlrc` y `--noproxy '*'` las variables `*_proxy`, para que ninguna redirija la
   petición. Cualquier fallo ⇒ exit 0.
5. Nunca escribe en stdout (el stdout de un hook asíncrono vuelve al agente como contexto). Errores a
   stderr solo con `ST_HOOKS_DEBUG=1`.

### 2.4 Activación: estado solicitado frente a estado efectivo

El env de un contenedor Docker es inmutable; el archivo montado y D1 no lo son. Por eso hay dos
estados y una tabla de transiciones. *MUST* implementarse exactamente así y cubrirse con tests:

| Acción | Contenedor | Token en env | `ingest_token_hash` | `conversation.json` | Resultado / respuesta |
| --- | --- | --- | --- | --- | --- |
| Habilitar (`requested=1`) | **no existe** (`container_id` NULL o inspect 404) | se generará en el siguiente spawn | sin cambio hasta el spawn | se escribe en el spawn | `effective:false`; `effectiveAfterRestart` según §2.7.6, rama sin contenedor: `true` solo con `requested` ∧ flag ∧ sin revocación ∧ imagen actual `="2"` |
| Habilitar | existe **sin** token (detenido o en marcha) | ausente (inmutable) | sin cambio | **no se escribe**, ni `relay.enabled` | `{effective:false, effectiveAfterRestart:false, requiresRecreate:true}`, `pendingReasons: [container-without-capture]`. Solo lo resuelve la recreación (§2.7) |
| Habilitar | existe con token y `ingest_token_hash` ≠ huella del token (§2.7.6) | presente | **sin cambio**: la huella nunca se copia a D1 | **no se escribe**; marca y archivo residuales se retiran | `{effective:false, effectiveAfterRestart:false, requiresRecreate:true}`, `token-mismatch` |
| Habilitar | creado por el backend de 3.0c: con token pero **sin montaje de control** (en marcha o detenido) | presente | sin cambio | **no se escribe nada**; `conversation.json` y `relay.enabled` residuales se retiran (`PATCH` y `reconcile`) | `{effective:false, effectiveAfterRestart:false, requiresRecreate:true}`; no hay reparación sin recrear (§2.7.5) |
| Habilitar | en marcha, **con ambos montajes**, con token y `ingest_token_hash_suspended` = huella (deshabilitada por API sin recrear) | presente | se **restaura** desde `ingest_token_hash_suspended` | procedimiento de §2.7.5: `relay.enabled` → relay identificado → archivo | `effective:true` solo si el relay se identificó; si no, `relay-unavailable` sin archivo |
| Habilitar | en marcha, **con ambos montajes**, con token y correspondencia, sin marca o sin archivo | presente | sin cambio | procedimiento de §2.7.5 | ídem |
| Habilitar | detenido, **con ambos montajes**, con token y correspondencia (o suspendido = huella) | presente | se restaura si estaba suspendido | **no se escribe nada** con el contenedor detenido | `effectiveAfterRestart:true` solo si marca y archivo ya están (§2.7.6); si no, `false` con `requiresRecreate:false` y `pendingReasons: [stopped, hooks-file-missing]`: se arranca y se repite el `PATCH` |
| Deshabilitar (`requested=0`) | corriendo con token | presente (inmutable, inofensivo) | se mueve a `ingest_token_hash_suspended`, queda NULL ⇒ **la ingesta rechaza desde ya** | se borra, y después `relay.enabled` ⇒ el CLI deja de emitir al recargar o en el siguiente start | `{enabled:false, effective:false, emissionStopsAfterRestart:true}` (decisión del responsable, ver abajo) |
| Deshabilitar | parado | — | NULL | se borran archivo y marca | `{enabled:false, effective:false}` |
| Emergencia `npm run conversation:disable -- <sid>\|--all` | cualquiera | — | **NULL** en D1 y `conversation_requested=0` (persistente: el siguiente `start` no regenera nada) | borrados, archivo y después `relay.enabled` | orden estricto §2.5: marca de revocación → D1 → archivos; confirma éxito solo al terminar los tres pasos; falla (≠ 0) si D1 no responde, dejando la marca puesta |
| Recrear (admin, `POST /api/admin/sessions/:id/recreate`) | **detenido**, sin captura válida en 3.0d (sin token, `token-mismatch`, o creado por 3.0c sin montaje de control) | nuevo, en `N` | cambia **en la misma sentencia** que `container_id` (§2.7.2, paso 4) | tras el CAS, procedimiento de §2.7.5 | §2.7 |
| `spawn` (contenedor **creado**: sesión nueva, o `start` sin contenedor existente — §2.4.1) | — | nuevo si `requested=1` ∧ `CONVERSATION_ENABLED` ∧ sin revocación ∧ imagen `="2"` | nuevo hash o NULL | si hay token: hash → `relay.enabled` → archivo antes de crear el contenedor; si no, ambos borrados | — |
| `stop` | en marcha → detenido | sin cambio | sin cambio (el hash sobrevive a `onSessionDown`) | **se conservan** marca y archivo si había autorización de conservación (§2.7.5) | — |
| `start` de un contenedor **existente** (§2.4.1) | — | el que ya tenía (o ninguno) | sin cambio | sin cambio: `start` no escribe, ni repara, ni retira marcas o archivos. Si se conservaron, el supervisor lanza el relay en el boot | — |
| `reconcile` (arranque del backend) | cada sesión | — | — | contenedor **en marcha**: marca y archivo ⇔ autorización completa (escribe con el procedimiento de §2.7.5). Contenedor **detenido**: se conservan si hay autorización de conservación, nunca se escriben, y se retiran si falta. Sin contenedor: se retiran (el siguiente spawn los rehace). Se resuelven además las recreaciones interrumpidas (§2.7.4) | log por corrección |

Invariantes:

- **La ingesta deja de aceptar antes de que el flip se confirme al operador**, tanto por la API
  (invalidación pre/post en proceso) como por el comando de emergencia (marca de revocación §2.5),
  independientemente de cuándo deje de emitir el CLI.
- `conversation.json` y `relay.enabled` *MUST NOT* existir fuera de uno de los tres casos de
  §2.7.5. Esto sustituye a la regla de 3.0b "archivo ⇒ hash no NULL".
  - **Escrito en sitio** con la autorización completa (contenedor en marcha, ambos montajes). En
    este caso `conversation.json` *MUST NOT* escribirse antes de que el relay se haya
    identificado.
  - **Conservado** con la autorización de conservación (contenedor existente, en marcha o
    detenido, ambos montajes), lo que cubre el `stop`.
  - **Preparado por el spawn** antes de crear el contenedor. Aquí no hay relay que identificar:
    lo lanza el supervisor en el boot. Si la creación falla, `reconcile` lo retira.
- "Efectivo" se informa en `GET /api/sessions/:id/conversations` y en el `PATCH` como el bloque
  `capture` de §2.7.6, para que la UI no prometa captura que no ocurre.
- Deshabilitar sin reiniciar deja el relay corriendo (su arranque depende del env, que es
  inmutable): queda inerte, porque el CLI deja de emitir al recargar y el backend rechaza lo que
  llegue. Desaparece cuando el contenedor se recrea (§2.4.1), que ya no inyecta el token; un
  stop + start del mismo contenedor no lo quita.
- La recarga en caliente del CLI es *informativa*, nunca una garantía. **Medido en 3.0c** (CLI
  2.1.308, smoke de Docker con el CLI real): al borrar `conversation.json`, una sesión interactiva ya
  abierta **deja de emitir sin reiniciar** (0 peticiones en su turno siguiente), y al reponerlo
  vuelve a emitir. **Decisión del responsable (2026-10-23):** deshabilitar responde
  `emissionStopsAfterRestart: true` como garantía conservadora: lo único que se promete es que la
  emisión cesa cuando el CLI se reinicia. Nada (código, UI, documentación de operador ni pruebas de
  aceptación) *MUST* depender de la recarga en caliente: vale para el pin 2.1.308, no para los CLIs
  autoactualizados de los workspaces existentes, y la garantía de corte la da el backend, que
  rechaza desde el flip (§2.5), no el CLI.

#### 2.4.1 `start` reutiliza el contenedor existente (hallado en la revisión de 3.0c)

`POST /api/sessions/:id/start` (y el stop + start de un operador) **no recrea** el contenedor si
todavía existe: `startContainer` hace `container.start()` sobre el mismo contenedor, con la misma
imagen, el mismo env y los mismos montajes, y no llama a `prepareSpawn`. Solo se crea un
contenedor nuevo, con token, montaje y la imagen vigente, cuando no hay contenedor: sesión nueva,
`kill`/borrado soft (que lo eliminan) o un contenedor que ya no existe en Docker (id obsoleto).

Consecuencias, sin cambio de ciclo de vida en 3.0c:

- Una sesión que **ya captura** sigue capturando tras stop + start (mismo token, el hash sobrevive
  a `onSessionDown`, el montaje sigue), y una que no capturaba sigue sin capturar.
- "Habilitar" sobre un contenedor existente sin token **no** se vuelve efectivo con stop + start:
  `effectiveAfterRestart` sigue las reglas de §2.7.6.
- Una imagen nueva (o el rollback de imagen) llega a una sesión solo cuando su contenedor se recrea.
- Procedimiento de recreación que conserva workspace y configuración: [DEPLOYMENT.md → Recrear el
  contenedor de una sesión](./DEPLOYMENT.md#recreating-a-session-container). Nunca hard delete.

**Resuelto en 3.0d:** `start` sigue sin cambiar y no recrea nunca. La vía es la **recreación
administrativa explícita** de §2.7 (decisión D1 del responsable). Los demás casos de habilitar
responden según §2.7.6, que nunca promete un efecto que el siguiente `start` no produce. El
procedimiento manual de DEPLOYMENT.md (`docker rm` + `start`) queda solo como emergencia del
operador: pierde la identidad git, los dotfiles y todo lo que haya en la capa (§2.7.1).

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
  `conversation.json` de esa sesión se borra si existe, y después `relay.enabled` (3.0d) (el receptor converge aunque el comando se
  haya interrumpido antes del paso 3). La cache de tokens tiene además TTL de 60 s.
- **Eventos ya autorizados**: una autorización que terminó antes del `rename` pudo dejar un evento
  en la cola por conversación (acotada por L6). Esos eventos **se persisten** (fueron emitidos
  legítimamente antes del corte); al observar la marca por primera vez, el receptor añade un único
  `gap{reason: revoked}` al final de cada cola afectada y la UI lo muestra como "captura revocada".
  No se descartan, porque descartar perdería datos legítimos y no mejora la garantía, que trata
  sobre aceptar, no sobre persistir.
- **Comando** `conversation:disable`, orden estricto por sesión: (1) escribir la marca y `fsync`
  del directorio; (2) D1: `conversation_requested=0`, `ingest_token_hash=NULL`,
  `ingest_token_hash_suspended=NULL`; (3) borrar `conversation.json` y después `relay.enabled`
  (3.0d). Imprime `revoked <sid>` solo tras (3). Si (2) falla: sale ≠ 0, deja la marca puesta (el corte sigue vigente) y lo dice; no
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

### 2.6 Relay local (3.0c)

`/opt/st/hooks/relay.py`, un único proceso Python 3 (solo biblioteca estándar, `python3 -I -S`) por
contenedor con captura. Recibe los hooks del CLI y del script en loopback y los reenvía al backend.
**No es un proxy:** tiene un único destino fijo y nunca devuelve al CLI nada que venga del backend.

**Arranque y vida**

- **3.0d (imagen `conversation-relay="2"`):** el supervisor de `entrypoint.sh` arranca si
  `ST_INGEST_TOKEN` no está vacío, pero **no lanza el relay** mientras no exista
  `/etc/st-control/relay.enabled` o `/etc/claude-code/managed-settings.d/conversation.json`. Este
  último solo cuenta como compatibilidad con contenedores creados por el backend de 3.0c.
  - Comprueba cada 0,5 s con un `[ -e ]` de bash, sin procesos nuevos.
  - Una vez lanzado, que la marca desaparezca no lo detiene: queda inerte (§2.4).
  - Sin token no hay supervisor, ni proceso, ni puerto abierto, ni tráfico.
  - La condición del responsable "arranca solo cuando la captura es efectiva" se cumple porque la
    marca solo existe con la autorización completa (§2.7.5).
- (3.0c, imagen sin la etiqueta) lo arranca solo si `ST_INGEST_TOKEN` no está vacío y
  `conversation.json` existe al arrancar el contenedor.
- Lo vigila un bucle de `bash` del entrypoint: si el relay termina, se relanza tras 1 s, duplicando
  la espera hasta 60 s mientras siga cayendo antes de 60 s de vida (un puerto ocupado no consume CPU
  en bucle). Cada relanzamiento informa `X-ST-Relay-Restarted` (§3.2.1). Ambos mueren con el
  contenedor: no sobreviven a `stop`, y la cola en memoria se pierde con ellos.
- Corre como el usuario de la sesión, que puede matarlo: solo corta su propia captura (los hooks
  fallan al instante con conexión rechazada; Claude sigue igual).
- `stdout`/`stderr` a `/dev/null`. Con `ST_HOOKS_DEBUG=1`, contadores (nunca cuerpos, cabeceras ni
  tokens) a `/tmp/st-relay.log`.

**Entrada**

- *MUST* escuchar solo en `127.0.0.1:47613`. Si el puerto está ocupado, no arranca (bucle con
  espera; captura inactiva en ese contenedor). Un programa del usuario no puede usar ese puerto
  mientras el relay lo tiene.
- Solo `POST /ingest/claude/hook` (ruta exacta, sin query) con `Content-Length` ≤ L5, y
  `GET /st-relay/status` (3.0d, identificación §2.7.6).
  - La identificación responde `204` con `X-ST-Relay: 1` y `X-ST-Relay-Generation: <n>`. No lleva
    cuerpo, ni tokens, ni contadores de contenido, y no reenvía nada.
  - Cualquier otro método o ruta ⇒ 404 vacío y nada se reenvía. Sin `Content-Length`, o mayor que L5 ⇒ 204 sin leer el
  cuerpo, conexión cerrada, contado como perdido.
- Respuesta al CLI: **siempre 204 sin cuerpo**, enviada tras leer el cuerpo y encolarlo (o
  descartarlo), nunca después de hablar con el backend. Lo que responda el backend no llega jamás al
  CLI: un hook no puede decidir, bloquear ni alterar nada.
- De la petición entrante solo se toma el cuerpo, intacto, y `X-ST-Tmux-Pane` si cumple
  `^%\d{1,6}$`. Todo otro header se ignora.
- Concurrencia de entrada: ≤ 16 conexiones en atención; la 17.ª recibe 204 sin leer el cuerpo y se
  cierra, contada como perdida. Lectura con timeout de 2 s por operación de socket.
- **Una petición por conexión:** toda respuesta lleva `Connection: close` y el relay cierra al
  enviarla. *MUST NOT* mantener conexiones keep-alive de entrada. Motivo (medido tras 3.0c, CLI
  real): el CLI (Bun) conserva sockets inactivos 5 s; un relay que cierra los inactivos a los 2 s
  compite con el hook siguiente, que llega a un socket cerrado y el CLI lo muestra como
  "hook error" (4/20 turnos con 1,97 s de separación en local, una vez en CI). Ningún timeout de
  inactividad del relay es seguro frente a un pool que no controlamos (el CLI se autoactualiza);
  una conexión de loopback por hook cuesta décimas de milisegundo.

**Cola y salida**

- FIFO en memoria, acotada a **1024 eventos y 16 MiB** de cuerpos, incluidos los cuerpos que se
  están leyendo (se reserva el `Content-Length` antes de leer). Llena ⇒ el evento entrante se
  descarta y se cuenta (el cuerpo se lee y se tira, sin guardarlo).
- Memoria de cuerpos, por diseño: **16 MiB** de cola + lecturas en curso (una sola copia por cuerpo:
  se recibe directo en un búfer reservado), **más** el cuerpo que se está enviando al backend (≤ L5,
  ya fuera de la cola; se envía sin concatenar, sin copia), más búferes de socket de ≤ 64 KiB por
  conexión. Es decir, ≈ 24 MiB de cuerpos más el intérprete y el asignador. Ningún cuerpo queda
  retenido fuera de ese presupuesto: el handler suelta su referencia al pasarlo a la cola y el hilo de salida la suelta al terminar cada
  envío. El entrypoint arranca el relay con `MALLOC_MMAP_THRESHOLD_=131072` para que cada cuerpo
  grande se devuelva al sistema al liberarse (sin eso, glibc retiene el pico de una ráfaga). Los picos medidos
  (3.0c: con cuerpos pequeños, con 1 MiB y con cuerpos de L5) se informan con su escenario; no son
  una cota universal: el asignador y la versión de Python varían.
- Un solo hilo de salida, **en orden**, con una conexión HTTP/1.1 persistente a
  `http://st-backend:$ST_BACKEND_PORT/ingest/claude/hook`, sin redirecciones (un 3xx es una respuesta
  inesperada) y **sin proxy**: ignora `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` y `NO_PROXY`
  (`http.client`, no `urllib`). Timeout de 2 s por operación (conexión, envío, respuesta). La
  resolución DNS no tiene timeout propio: con `st-backend` sin resolver falla al instante (Docker
  responde NXDOMAIN); un resolvedor colgado detiene la salida y la cola se llena y descarta.
- Cabeceras de salida: `Content-Type: application/json`, `Content-Length`, `Authorization: Bearer
  $ST_INGEST_TOKEN` y `X-ST-Session: $SESSION_ID` del entorno del relay, `X-ST-Tmux-Pane` validado, y
  los `X-ST-Relay-*` de §3.2.1. Nada más.
- Resultado: 2xx ⇒ entregado. Error de conexión, timeout, o estado distinto de 2xx ⇒ el evento se
  cuenta como perdido y la salida entra en **pausa de 1 s**: los eventos que salen de la cola durante
  la pausa se descartan y cuentan sin intentar enviarlos (un backend caído o colgado no deja una
  cola de eventos viejos). Excepción única: una conexión persistente que el backend cerró por
  inactividad se reintenta una vez con una conexión nueva. No hay más reintentos.
- El cuerpo de la respuesta se lee (≤ 64 KiB) y se descarta.

**Contabilidad de pérdidas**

- Cada evento recibido termina en exactamente uno de: *reenviado* (2xx) o *perdido* (contado). Los
  perdidos se agrupan por `session_id` de Claude, leído con una expresión fija sobre los primeros
  128 bytes del cuerpo (`{"session_id":"<uuid>"`, la forma en que el CLI serializa), o, si no se
  puede leer, por pane. Ninguna otra parte del cuerpo se interpreta.
- El acumulado de un grupo viaja en `X-ST-Relay-Dropped`/`-Bytes` del **siguiente evento reenviado**
  de esa conversación (o de ese pane), y se pone a cero solo si ese envío recibe 2xx. Más de 256
  grupos abiertos ⇒ el excedente pasa a un contador sin atribuir (`X-ST-Relay-Unattributed`).
- Lo perdido que no llega a informarse (el contenedor se detiene, el relay muere con la cola llena,
  la conversación no vuelve a emitir) no produce `gap`. Tras un reinicio del relay, el primer evento
  de cada conversación ya conocida lleva `X-ST-Relay-Restarted` y el backend escribe `relay_restart`.
- Un evento "perdido" por timeout pudo haber llegado al backend: el número es una cota superior de
  lo no confirmado, no un recuento exacto de lo no persistido.

**Recepción local frente a persistencia**

El 204 del relay solo significa *recibido en el contenedor*. **No** es entrega ni persistencia: no
hay garantía de entrega, ni reintentos, ni almacenamiento en disco en el contenedor. "Persistido"
sigue siendo solo lo de §4.1 (línea con `seq` en el archivo del host). Entre ambos, toda pérdida que
el relay alcanza a ver se cuenta y, si la conversación vuelve a emitir, aparece como `gap`
(`relay_dropped` o `relay_restart`); las que no, quedan como silencio en el registro, igual que un
evento que el CLI nunca emitió.

**Proxies de la sesión**

- El CLI enruta un hook HTTP por el proxy de `HTTP_PROXY`/`HTTPS_PROXY` salvo que el host del URL
  figure en `NO_PROXY`/`no_proxy` (coincidencia exacta de host, sin excepción implícita para
  loopback). Un proxy no alcanza el loopback del contenedor, así que el evento se perdería.
- Por eso, **solo** cuando la captura es efectiva **y** el env de la sesión define alguna de
  `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` (o sus minúsculas), el backend añade `127.0.0.1` a
  las de `NO_PROXY`/`no_proxy` que existan (conserva su contenido, no toca `*`); si no existe
  ninguna, crea las dos. Nunca crea la que falta junto a la del usuario: un cliente que lee primero
  la minúscula e ignora la otra (el de la API de Claude, medido en 3.0c) perdería sus excepciones. Sin proxy en el
  env de la sesión, el env no cambia. No afecta a ninguna otra conexión de Claude: ningún proxy puede
  servir el loopback del contenedor.
- Un proxy exportado después (en `.bashrc` o a mano) sin `NO_PROXY` hace que los hooks vayan a ese
  proxy y fallen; es configuración del propio usuario y solo afecta a su captura.

---

### 2.7 Recreación administrativa y activación (3.0d)

Diseño y razonamiento: [phase3-3.0d-activation.md](./design/phase3-3.0d-activation.md), v5
(`ac1024d`). Decisiones del responsable, con las recomendaciones de Work:

- **D1:** recreación administrativa explícita; `start` no cambia.
- **D2:** preservación estricta de HOME y de la capa.
- **D3:** solo se reconstruye lo verificable como exacto.
- **D4:** sin bypass destructivo.
- **D5:** nunca una sesión en marcha.
- **D6:** ID inmutable de imagen.
- **D7:** probe fresco del relay, sin caché positiva.

Notación: `O` es el contenedor existente, `N` el nuevo y `H` el hash del token de `N`.

#### 2.7.1 Qué se conserva y qué bloquea

Se conservan, porque son el mismo directorio o están fuera del contenedor:

- el workspace, incluidos el estado y los transcripts del CLI (`--resume`), `~/.npm-global`, VS
  Code CLI, `gh` y `~/.ssh` vía symlinks;
- los uploads;
- la fila de sesión y `session_configs`, con secretos, puertos, caps y hooks;
- el historial de conversaciones.

Las pestañas tmux ya se pierden con el stop.

**Capa del contenedor:** se clasifica `container.changes()` de `O`, detenido.

- **Se permite**, si coincide **exactamente** en tipo y destino, lo que produce el entrypoint:
  - los symlinks `~/.npm-global`, `~/.vscode-cli`, `~/.config/gh`, `~/.claude`, `~/.claude.json` y
    `~/.ssh` a su destino bajo el workspace;
  - `~/.config`;
  - `/tmp/.st-ready`;
  - `/tmp/st-relay.log`;
  - `/tmp/tmux-<uid>/`.
- **`~/.gitconfig`:** se permite solo si contiene exactamente `user.name` y `user.email`, iguales a
  `session_configs`. Se lee con `getArchive`, ≤ 4 KiB. Tras la recreación se reaplica
  gitIdentity.
- **Todo lo demás bloquea** con un código por categoría y su recuento, **nunca rutas**:
  - `layer-home`, que incluye `~/.bash_history`;
  - `layer-gitconfig-modified`;
  - `layer-dotfiles`: toda sesión con dotfiles configurados;
  - `layer-tmp`;
  - `layer-system`.

**Workspace** (`lstat` en el host, sin seguir symlinks):

- `workspace/.npm-global` debe ser un directorio real (`workspace-cli-missing`);
- no debe quedar layout heredado `workspace/.claude` (`workspace-legacy-layout`).

**Skills gestionadas.** Para cada archivo de `/opt/session-skills/**` de la imagen de `N` se
comparan tres versiones:

- **W:** el workspace, leído con el opener de `workspaceFiles.ts` y la prueba `/proc/self/fd`;
- **I_O:** la imagen de `O`, con `getArchive` sobre `O` detenido;
- **I_N:** la imagen de `N`, con `getArchive` sobre `N` creado y sin arrancar.

Resultados:

- W ausente, W = I_N o W = I_O ⇒ se permite;
- W distinta de I_O y de I_N ⇒ `managed-skills-customized`;
- W existe en una ruta que no está en la imagen de `O` ⇒ `managed-skills-collision`.

Los archivos que no son gestionados nunca se tocan. El falso positivo tras `sync-skills.sh` se
acepta: bloquea.

#### 2.7.2 Endpoint, precondiciones y secuencia

- **`GET /api/admin/sessions/:id/recreate`**: preflight sin efectos. Devuelve
  `{ recreatable, blockers[], imageId, currentImageId, captureAfter }`:
  - evalúa todas las precondiciones posibles sin crear nada (las skills, contra I_O);
  - `blockers` lleva códigos y recuentos.
- **`POST /api/admin/sessions/:id/recreate {expectImageId}`**:
  - requiere `requireAuth` + `requireAdmin` + `adminActionIp`;
  - con un owner ajeno, la fila `operate` en `session_observe_log` va **antes** de cualquier
    efecto y es fail-closed, como en #429;
  - la primera precondición que falla responde 409 con su código.

**Precondiciones**, en este orden:

1. **Lock por sesión**, compartido con `start`, `stop`, `kill` y `delete` (soft y hard, incluida la
   purga).
   - `recreate` no espera: si está ocupado, `busy`.
   - Las demás esperan ≤ `T_rec` + `T_rb` = 6 min (§2.7.4) y después responden `busy` sin efectos.
   - Con la sesión sin resolver, todas responden `recreate-unresolved` (§2.7.4).
2. La sesión existe, no está `failed` ni `terminated`, y tiene `container_id` (`no-container`).
3. `O` existe y está detenido (`container-missing`, `running`).
4. `inspect(SESSION_IMAGE).Id` = `expectImageId` (`image-changed`), y ese ID lleva
   `io.shared-terminal.conversation-relay="2"` (`image-without-relay`). Desde aquí todo usa ese ID.
5. `CONVERSATION_ENABLED`, `conversation_requested=1` y sin revocación (`flag-off`,
   `not-requested`, `revoked`).
6. La capa sin pérdidas (`layer-*`).
7. El workspace (`workspace-cli-missing`, `workspace-legacy-layout`).
8. Las skills (`managed-skills-customized`, `managed-skills-collision`).

Si las marcas fueran incompatibles con el CLI (§2.7.5), responde `control-marker-incompatible`.

**Secuencia:**

1. **Preparar sin efectos visibles.**
   - Primero se escribe el registro durable del intento, con `state: open` (§2.7.4).
   - Se genera el token y `H`.
   - Se escribe `defer-skill-seed` y se borran `relay.enabled` y `conversation.json` residuales.
     - `O` no monta el directorio de control.
     - El gestionado solo lo monta un `O` creado por 3.0c. Ese `O` está detenido todo el tiempo, y
       §2.7.5 retira su archivo igualmente, así que el rollback no tiene que restaurarlo.
   - Se crea `N`:
     - con el nombre `st-<12>-new-<ts>` e `Image: <imageId>`;
     - con el env, binds (gestionado y control, ro), caps y red de siempre;
     - con las etiquetas `io.shared-terminal.session=<sid>`, `io.shared-terminal.recreate-of=<O>` e
       `io.shared-terminal.recreate-attempt=<attemptId>`.
   - Se repite la precondición 8 contra I_N.
   - `N` no se arranca.
2. **Renombrar.** `O` → `st-<12>-old-<ts>` y `N` → `st-<12>`.
3. **Recomprobar y arrancar.**
   - `inspect(O)` debe seguir detenido; si no, rollback sin arrancar `N`.
   - `start(N)`, readiness ≤ 60 s y `N` en marcha.
   - Con `defer-skill-seed`, el entrypoint no siembra skills.
   - Sin `relay.enabled`, el supervisor no lanza el relay.
4. **Confirmar (punto de no retorno), en una sola sentencia:**

   ```sql
   UPDATE sessions
   SET container_id = :N, ingest_token_hash = :H, ingest_token_hash_suspended = NULL
   WHERE session_id = :sid AND container_id = :O AND conversation_requested = 1
   ```

   - 0 filas o error ⇒ rollback.
   - **Timeout ambiguo** (la petición pudo aplicarse): no hay rollback que borre `N`. La sesión
     pasa a **sin resolver** (§2.7.4), y la decisión se toma releyendo la fila solo cuando la
     sentencia ya no puede aplicarse.
   - Con `T_rec` vencido no se ejecuta.
   - **`container_id` y el hash autorizado cambian juntos.**
5. **Autorizar:** el procedimiento de §2.7.5 sobre `N`. Si el relay no se identifica, se queda en
   `relay-unavailable`, sin archivo.
6. **Completar**, convergencia sobre `N`:
   1. borrar `defer-skill-seed`;
   2. `seed-skills.sh` por `execCapture`;
   3. mapeos de puertos;
   4. `status=running`;
   5. gitIdentity, si aplica;
   6. postStart;
   7. `cliVersion` (aviso `cli-below-minimum` si < 2.1.308);
   8. `remove(O)`.
   9. El registro pasa a `resolved`: el intento terminó sin llamadas en vuelo ni desconocidas.

   Un fallo se registra y no deshace nada. Si deja peticiones en vuelo, el registro queda `uncertain`
   y se aplica §2.7.4.

**D1 apunta siempre a un contenedor que existe:**

- antes del paso 4, a `O` (renombrado o no); después, a `N`;
- con un CAS ambiguo, `N` no se borra hasta que la relectura posterior a `T_d1` decide, así que
  D1 apunta a un contenedor existente aunque la sentencia se aplique tarde;
- `O` se borra solo después del paso 4;
- las lecturas concurrentes (attach, exec, git, files) resuelven por `container_id` y ven una
  sesión detenida hasta el paso 6;
- el dispatcher de puertos solo encamina sesiones `running`.

#### 2.7.3 Workspace compartido, rollback y estado incierto

- **Un solo escritor:** `O` está detenido desde la precondición 3 hasta su borrado, el lock
  excluye otras operaciones, y el paso 3 vuelve a comprobar `O`.
- **Antes del paso 4, `N` no escribe en el workspace nada que `O` no escribiría igual al
  arrancar**, en cualquier número de arranques de `N`. Concretamente:
  - solo los `mkdir -p` y `chmod` idempotentes del entrypoint;
  - la siembra de skills queda diferida mientras exista `/etc/st-control/defer-skill-seed`;
  - las siembras de `.npm-global` y la migración del layout las impide la precondición 7.
- **`defer-skill-seed`:**
  - el entrypoint no la borra nunca y el usuario no puede tocarla, porque el montaje es ro;
  - la retira solo el backend: en el paso 6.1, en el rollback (con la eliminación de `N`
    confirmada), o en la convergencia de §2.7.4, incluso con `N` detenido.
- **Rollback** (fallo definitivo en los pasos 1–4, sin trabajo en vuelo, §2.7.4):
  1. esperar a que se resuelva toda llamada en vuelo de esta recreación;
  2. `stop` y `remove(N)`, buscando `N` por id y por la etiqueta `recreate-of`, por si un `create`
     cuyo resultado no se conocía llegó a aplicarse;
  3. confirmar que no existe ningún `N` (404 y ningún contenedor con esa etiqueta);
  4. `O` a su nombre canónico;
  5. **solo con el paso 3 confirmado**, retirar `defer-skill-seed`.

  - **Rollback resuelto:** además de los pasos 1–5, todas las peticiones del intento a Docker
    tienen que haber respondido. Solo entonces el registro pasa a `resolved` con
    `outcome: rolled-back` (§2.7.4).
    - estado final igual al previo: D1 en `O`, `O` con su nombre, sin `N` y sin la marca, sin
      cambios en captura ni skills;
    - responde 500 `recreate-failed {step}`, **sin** `unresolved`;
    - D1 y el workspace no necesitan restauración.
  - Si alguno de los pasos 1–3 no se puede confirmar, no es un rollback resuelto: pasa al estado
    incierto.
- **Estado incierto (`unresolved`):**
  - **Cuándo:**
    - queda trabajo en vuelo sin resolver (§2.7.4);
    - `remove` falla o queda ambiguo;
    - `N` sigue presente;
    - el CAS es ambiguo.
  - **Efectos:**
    - la marca se conserva y la sesión queda **sin resolver** (§2.7.4);
    - responde 500 `recreate-failed {step, unresolved: true}`;
    - el preflight y `capture` informan `recreate-unresolved`.
  - **Rename de `O`:** si `N` todavía tiene el nombre canónico, el rename de `O` falla. Es el
    resultado esperado del estado incierto y no un error inesperado: lo completa §2.7.4.
  - **Resolución:** la marca se retira solo cuando §2.7.4 resuelve con D1 y Docker.
- **Después del paso 4 no hay reversión**, ni de `O` ni del workspace. Todo lo que quede a medias
  converge sobre `N` sin recrear:
  - marca, archivo o relay se reparan con `PATCH {enabled:true}` o `reconcile` (§2.7.5);
  - `defer-skill-seed` residual la retira `reconcile`: siembra por exec si `N` está en marcha, o
    en su siguiente arranque;
  - si la siembra falla, siembra el siguiente arranque.

#### 2.7.4 Topes de tiempo, trabajo en vuelo y recreación interrumpida

**Un timeout no significa que la operación haya terminado.** Docker y D1 pueden aplicar una
petición después de que el cliente dejó de esperarla. Reglas:

**Evidencia de terminación**

- **Docker: las peticiones del intento no se abortan nunca en el cliente.**
  - Los topes (`T_rec`, `T_rb`) solo dejan de *esperar*: cierran la época. La conexión con dockerd
    sigue abierta hasta que responde.
  - **La respuesta de dockerd, éxito o error, es la evidencia de cómo terminó** esa petición. Hasta
    entonces está *en vuelo* y su resultado se desconoce.
  - Ningún plazo sustituye a esa respuesta: un dockerd colgado deja la petición en vuelo
    indefinidamente.
- **D1: las peticiones sí se cortan** (tope de 10 s del cliente de D1). Una sentencia no puede
  aplicarse después de su duración máxima en la plataforma (30 s según Cloudflare). Por eso, pasados
  **`T_d1` = 60 s** desde el envío, la relectura de la fila es definitiva. `T_d1` vale **solo para
  D1**; la implementación verifica el límite y fija `T_d1` en consecuencia.
- **Si el backend muere**, se pierden las conexiones con dockerd y, con ellas, la única evidencia
  de cómo terminaron sus peticiones a Docker. Ninguna observación posterior lo prueba: ni un plazo,
  ni una ventana sin eventos, ni escaneos repetidos.

**Estados del intento**, en el registro durable
`<WORKSPACE_ROOT>/.st-control/<sid>/recreate-attempt.json`:

- Se escribe a temporal, con `fsync` y `rename`, **antes del primer efecto**.
- Contiene `attemptId`, el id y los nombres de `O`, el nombre `-new-<ts>` de `N`, `startedAt`, el
  estado y `outcome`.
- **Nunca** contiene el token ni su hash.
- `N` lleva la etiqueta `io.shared-terminal.recreate-attempt=<attemptId>`.

| Estado | Qué significa | Quién puede actuar |
| --- | --- | --- |
| `open` | Intento **activo**: un proceso vivo tiene el lock y una época válida | **El propio intento**, en todos sus pasos: la autorización del paso 5 y la convergencia del paso 6 también. Las demás operaciones las excluye el lock (§2.7.2, precondición 1), no este estado. No hay bloqueo circular |
| `uncertain` | La época se cerró con peticiones a Docker en vuelo; o, tras un reinicio del backend, se encontró un registro `open` o `uncertain` | Nadie, salvo la resolución, `PATCH {enabled:false}` y el comando de emergencia. Todo lo demás responde 409 `recreate-unresolved` sin efectos |
| `resolved` | Hay evidencia de terminación de todas las peticiones, y la acción final de la tabla se ejecutó y volvió a observarse | Ciclo normal |

- `outcome` es `committed` con el id de `N` (D1 = `N`) o `rolled-back` (D1 = `O`). Se fija al
  pasar a `resolved`.
- El registro se conserva hasta el hard delete de la sesión, como dato para reconocer sobrantes.
  No fija ningún límite de tiempo ni es una garantía.

**Paso a `resolved`**

- **Desde `open`, camino normal:** el intento termina el paso 6, o el rollback resuelto, y todas
  sus peticiones a Docker han respondido. Las de D1 que se cortaron ya son definitivas (`T_d1`).
- **Desde `uncertain`, con el proceso vivo:** en cuanto responde la última petición en vuelo
  (evidencia), y las de D1 son definitivas, la resolución aplica la tabla de abajo sobre el estado
  observado.
- **Desde `uncertain` tras un reinicio del backend:** **no hay evidencia, así que la sesión sigue
  en `recreate-unresolved`.**
  - El contrato no define ninguna resolución automática para este caso.
  - Consecuencia aceptada: la sesión no se puede arrancar ni recrear hasta que se decida. Siguen
    funcionando la lectura de archivos, deshabilitar y el comando de emergencia.
  - **D8 (decisión del responsable, 2026-10-26): fail-closed.**
    - Un intento `uncertain` sin evidencia suficiente sigue en `recreate-unresolved`.
    - **No hay resolución automática:** ni por tiempo, ni por quietud de Docker, ni por un reinicio
      de dockerd.
    - El bloqueo indefinido de la sesión es un riesgo aceptado **solo en el piloto aislado**, con
      una sesión **nueva y descartable, sin datos importantes**.
    - **Restricción operativa:** la recreación no se usa en sesiones de trabajo reales hasta que
      exista, se documente y se valide un procedimiento seguro de recuperación administrativa
      manual. Definirlo es trabajo posterior y no forma parte del contrato funcional de 3.0d.
    - Esta decisión no añade ninguna superficie ni comportamiento a v1.6.

**Sin continuaciones tardías.** Cada intento tiene una **época**, que se cierra al vencer `T_rec` o
`T_rb`, o al pasar al rollback.

- Toda continuación (el código que sigue a una petición que responde tarde) comprueba la época
  antes de cualquier efecto. Si está cerrada, solo registra la respuesta como evidencia para la
  resolución y no hace nada más: no escribe D1, no renombra, no crea, no arranca, no escribe
  marcas ni archivos, no siembra.
- Ejemplos:
  - un probe que responde positivo después del tope no escribe `conversation.json`;
  - un `create` que termina tarde no lleva a arrancar `N`;
  - un rename tardío no se da por hecho.

**Siempre permitidos**, en cualquier estado: `PATCH {enabled:false}` y el comando de emergencia.
Solo escriben la marca de revocación y D1, y borran archivos. El CAS no puede pisarlos, porque exige
`conversation_requested = 1`. La revocación nunca se bloquea.

**Sobrantes de intentos abortados.** Un contenedor es sobrante solo si se cumplen las tres
condiciones:

- lleva `io.shared-terminal.recreate-attempt=<A>`;
- el registro de `A` está en `resolved`;
- **su id no es el `container_id` vigente de D1** ni el `N` confirmado de un `outcome: committed`.

Reglas:

- Un sobrante se elimina sin arrancarlo, porque no pudo escribir en el workspace sin arrancar.
- **El contenedor vigente de D1 nunca se elimina por su etiqueta.** Un `N` confirmado sigue su
  ciclo normal de stop y start indefinidamente.
- Si aparece un contenedor con la etiqueta de un intento que **no** está `resolved`, no se toca:
  es parte del estado incierto.

- **`T_rec` = 5 min**, desde el lock hasta el final del paso 6, **incluidos todos los pasos
  posteriores al CAS**. Cada llamada a Docker o `execCapture` (probe, siembra, gitIdentity) corre
  contra el presupuesto que queda. postStart corre contra `min(lo que queda de T_rec, el tope
  propio de streamExec)`.
  - Vencido antes del paso 4: se cierra la época y se pasa al rollback.
  - Vencido después: se cierra la época, se abandona el resto del paso 6 y se registra qué faltó.
    - Con peticiones a Docker en vuelo (un probe, un exec), el registro pasa a `uncertain` hasta
      que respondan. Un probe tardío no escribe nada, y se retira la marca.
    - Sin peticiones en vuelo, pasa a `resolved` (`committed`), se libera el lock y lo pendiente
      converge (§2.7.3).
    - postStart sigue en `N` como proceso de la sesión (`N` ya es la sesión). El backend no espera
      su resultado ni actúa por él.

  Así ninguna operación **espera** más de `T_rec` + `T_rb`: después responde, aunque sea con
  `recreate-unresolved`.
- **`T_rb` = 60 s** para el rollback. Si vence:
  - se libera el lock y el registro pasa a `uncertain`;
  - las operaciones incompatibles responden `recreate-unresolved` hasta la resolución;
  - si al resolver Docker no responde, contesta 503 `docker-unavailable` sin tocar D1 ni el
    workspace;
  - un `DELETE ?hard=true` nunca purga un workspace sobre el que `N` pudiera estar corriendo.
- **`reconcile`, al arrancar el backend**, revisa:
  - los registros `recreate-attempt.json` en `open` o `uncertain`: pasan a `uncertain`, y la sesión
    queda en `recreate-unresolved` sea cual sea lo visible en Docker. No los resuelve (D8);
  - `docker ps -a --filter label=io.shared-terminal.recreate-of`;
  - los nombres que encajan **exactamente** con `^st-[0-9a-f]{12}-old-[0-9]+$` (o `-new-`) y cuyo
    prefijo es una sesión de D1.

  Los sufijos `-new-<ts>` y `-old-<ts>` están **reservados**, y un nombre que no encaja no se toca.
  Elimina los sobrantes. La tabla siguiente es la **resolución**: la aplica la resolución de un
  intento `uncertain` con evidencia (proceso vivo), o la vía que decida D8. Con D1 decide:

| D1 `container_id` | Encontrado | Acción |
| --- | --- | --- |
| `= O` | `N` existe | `stop` + `remove(N)` confirmado (404); `O` a su nombre; entonces se retira `defer-skill-seed`. Sin confirmación, la marca se conserva y se reintenta |
| `= O` | `N` no existe (404) y la marca presente | Se retira la marca; `O` a su nombre si hace falta |
| `= N` | `O` existe | `remove(O)`; estado según `N`; postStart no; marca y archivo según §2.7.5; `defer-skill-seed` residual según §2.7.3 |
| ni `O` ni `N` | — | Nada; log y `recreateOrphans` en stats |

Ninguna acción borra un contenedor al que apunte D1.

#### 2.7.5 Autorización del relay y marcas

Hay tres niveles de autorización, para escribir, conservar y preparar.

**Autorización completa**, para **escribir** `relay.enabled` y `conversation.json` sobre un
contenedor existente:

1. `CONVERSATION_ENABLED`;
2. `conversation_requested = 1`;
3. sin marca de revocación, por sesión ni global;
4. el contenedor de D1 existe, está **en marcha** y tiene **ambos montajes** (gestionado y de
   control);
5. su imagen lleva `conversation-relay="2"`;
6. correspondencia token ↔ hash (§2.7.6).

**Autorización de conservación**, para **mantener** marca y archivo ya escritos mientras el
contenedor está detenido: las mismas condiciones 1–3, 5 y 6, y en la 4 que el contenedor
**exista** (en marcha o detenido) con ambos montajes.

- `stop` no retira nada: así una sesión que captura sigue capturando tras stop + start sin
  `PATCH` (§2.4.1).
- `reconcile` conserva lo que cumple esta autorización, nunca escribe sobre un contenedor
  detenido, y retira lo que no la cumple.

**Preparación del spawn** (excepción aprobada): el contenedor todavía no existe.

- Con 1–3 y la imagen vigente con `="2"`, `prepareSpawn` genera el token, escribe hash → marca →
  archivo, y después crea el contenedor con ambos montajes. La correspondencia se cumple por
  construcción.
- Si la creación falla, el siguiente spawn sobrescribe, y `reconcile` retira lo que quede sin
  contenedor.

**Sin ambos montajes no hay reparación sin recrear.** Un contenedor creado por el backend de 3.0c
tiene el montaje gestionado pero no el de control:

- no se escribe nada;
- `conversation.json` y `relay.enabled` residuales se retiran;
- `requiresRecreate:true`.

**Orden:** autorización → `relay.enabled` → recomprobación de 1–3 → probe de identificación
(≤ 5 s) → `conversation.json` → recomprobación de 1–3.

- Si falla una recomprobación, se borran archivo y marca, en ese orden.
- Si falla el probe, se borra la marca (`relay-unavailable`).

**Lugares que aplican el orden de escritura:** el paso 5 de §2.7.2, `PATCH {enabled:true}` con el
contenedor en marcha y `reconcile` con el contenedor en marcha. Ninguno actúa mientras la sesión
está sin resolver (§2.7.4).

**Marcas residuales:** son la marca o el archivo que no encajan en ninguno de los tres casos
(escrito en sitio con la autorización completa, conservado con la de conservación, o preparado
por un spawn en curso). Se retiran y nunca cuentan para `effective`. Un contenedor detenido con la
autorización de conservación **no** tiene residuales. `effective` exige además la autorización
completa y el probe (§2.7.6).

| Camino | Retirada |
| --- | --- |
| Disable API y emergencia | Archivo y después marca (§2.5) |
| Receptor que observa una revocación | Archivo y después marca (§2.5) |
| Flag apagado | `reconcile` borra todos los archivos y todas las marcas |
| `token-mismatch`, contenedor sin captura, o contenedor sin montaje de control (3.0c) | `PATCH` y `reconcile` las borran y nunca las escriben |
| Sin contenedor (`kill`, borrado soft, id obsoleto) | `reconcile` las retira; el siguiente spawn las rehace |

Un contenedor que arranca con una marca residual lanza un relay inocuo: el backend rechaza todo
y, sin archivo, ningún hook le escribe.

**Compatibilidad con el CLI**, validación obligatoria en el smoke con el CLI 2.1.308 y con el del
workspace del piloto. Con `/etc/st-control` vacío, con marcas, ilegible, y con un `.json`
inválido dentro:

- la secuencia de hooks y los eventos son idénticos;
- no aparece ningún aviso de settings.

Si falla, la activación queda bloqueada (`control-marker-incompatible` en `PATCH {enabled:true}`
y en `POST …/recreate`) y 3.0d no se publica hasta revisar otra ubicación. No hay respaldo
silencioso.

#### 2.7.6 Semántica de `capture`

```
capture: {
  requested, effective, effectiveAfterRestart, requiresRecreate,
  pendingReasons: [],   // flag-off | not-requested | revoked | image-without-relay | stopped |
                        // container-without-capture | token-mismatch | hooks-file-missing |
                        // relay-unavailable | control-marker-incompatible | recreate-unresolved |
                        // cli-below-minimum (aviso)
  checkedAt             // hora del probe del relay hecho en esta petición
}
```

**Correspondencia token ↔ hash.** La huella del contenedor es `sha256(ST_INGEST_TOKEN)` del
`Config.Env` del `inspect` del contenedor de D1. Se calcula en memoria y se compara en tiempo
constante. El token nunca se registra, devuelve ni guarda.

| D1 | Estado |
| --- | --- |
| `ingest_token_hash` = huella | correspondencia |
| hash NULL y `…_suspended` = huella | suspendido; `PATCH {enabled:true}` lo restaura |
| distinto, o ambos NULL tras una emergencia sin marca | `token-mismatch` |
| contenedor sin token | `container-without-capture` |

Un `token-mismatch` **nunca** se repara copiando la huella a D1: solo lo resuelve un contenedor
nuevo.

**Disponibilidad (D7):** probe fresco, sin caché positiva.

- Cada respuesta `effective:true` exige un probe `GET /st-relay/status` por `execCapture` (≤ 2 s)
  **hecho durante esa petición**, que identifica al relay (`X-ST-Relay: 1`). No basta con que el
  puerto acepte.
- Single-flight: las peticiones concurrentes para el mismo contenedor comparten el probe en vuelo
  y nunca reutilizan uno terminado.
- Si cualquier otra condición es falsa, se responde `false` sin hacer el probe.
- `checkedAt` es la hora de ese probe.
- Garantía: el relay estaba identificado durante la petición. No promete nada sobre después.

**Reglas:**

- **`effective = true`** ⇔ autorización completa ∧ `relay.enabled` ∧ `conversation.json` ∧ probe
  positivo. Si no, `false` con su motivo: relay caído o puerto ocupado ⇒ `relay-unavailable`;
  falta configuración ⇒ `hooks-file-missing`; `token-mismatch`.
- **`effectiveAfterRestart`** es lo que deja un `start` **sin reparar nada**. Es `true` solo en
  una de estas ramas, cada una con todas sus condiciones:
  - **Sin contenedor:** `requested` ∧ `CONVERSATION_ENABLED` ∧ sin revocación ∧ imagen actual
    `="2"`.
  - **Contenedor detenido:** `requested` ∧ flag ∧ sin revocación ∧ los dos montajes ∧
    correspondencia ∧ su imagen `="2"` ∧ `relay.enabled` ∧ `conversation.json` presentes.

  En cualquier otro caso es `false`. En particular, un contenedor detenido con correspondencia
  pero sin marca o sin archivo da `false`.
- **`requiresRecreate = true`** solo con `container-without-capture`, `token-mismatch` o un
  contenedor sin el montaje de control: casos que solo resuelve un contenedor nuevo. No promete
  que el preflight vaya a pasar. Con correspondencia y solo configuración ausente es `false`, y se
  resuelve con start + `PATCH`, sin recrear.
- **`PATCH {enabled:true}`** aplica §2.7.5 solo con el contenedor en marcha y con ambos montajes.
  - Detenido, no escribe nada y responde el cálculo anterior.
  - Sin montaje de control, no escribe, retira los residuales y responde `requiresRecreate:true`.
  - Sin resolver, responde `recreate-unresolved`.
  - Nunca escribe sin autorización completa.

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

### 3.2.1 Headers del relay (informes de pérdida)

Los añade solo el relay (§2.6), al reenviar un evento. Valores decimales `^[0-9]{1,10}$`; cualquier
otro valor se ignora (nunca rechaza el evento). Se procesan después de autorizar y de asociar el
cuerpo a su conversación, **antes** de encolar el evento que los trae, y con independencia de que ese
evento resulte duplicado:

| Header | Efecto |
| --- | --- |
| `X-ST-Relay-Dropped: n` (+ `X-ST-Relay-Dropped-Bytes: b`) | n > 0 ⇒ un `gap{reason: relay_dropped, dropped: n, dropped_bytes: b}` en la conversación del evento |
| `X-ST-Relay-Restarted: 1` | si la conversación ya tenía eventos persistidos ⇒ un `gap{reason: relay_restart}`; si es nueva, nada |
| `X-ST-Relay-Unattributed: n` | n > 0 ⇒ `sessions_conversation_stats.unattributed_gaps` += 1 y el contador `relay_dropped_unattributed` += n (no hay conversación a la que atribuirlo) |

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
| `tool_failed` | `PostToolUseFailure` | `tool_use_id`, `tool_name`, `ok: false`, `is_interrupt?`, `duration_ms?`, `error_bytes`, y `error` **solo** según §4.3.3 (nota 1) | L4 |
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

Nota 1 (observado en 3.0c, CLI 2.1.308): con `--dangerously-skip-permissions`, un Bash que falla
dispara `PreToolUse → PostToolUseFailure → PostToolUse` con el mismo `tool_use_id`. **Decisión del
responsable (2026-10-23):** se persisten ambos eventos, `tool_failed` **y** `tool_end`, sin cambiar
el normalizador ni la deduplicación (son tipos distintos, §4.6). La representación es obligación de
3.1 (§10): un mismo `tool_use_id` se muestra como **una** herramienta, con el fallo con precedencia
sobre el éxito en cualquier orden de llegada, y los contadores de herramientas cuentan
`tool_use_id`s distintos, no eventos.

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
| `relay_dropped` | el relay del contenedor no pudo entregar n eventos (§2.6: cola llena, backend caído, colgado o con respuesta inesperada) | "N eventos no entregados por el contenedor" |
| `relay_restart` | el relay se reinició; lo recibido por el anterior y no reenviado se perdió sin cuenta | "Posible actividad perdida (relay reiniciado)" |
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
| `PATCH /api/admin/sessions/:id/conversation {enabled}` | admin (`adminActionIp`) | aplica la fila correspondiente de §2.4 y devuelve `{ enabled, capture }`, con `capture` según §2.7.6 |
| `GET /api/admin/sessions/:id/recreate` | admin | preflight sin efectos (§2.7.2): `{ recreatable, blockers[], imageId, currentImageId, captureAfter }`; códigos y recuentos, nunca rutas |
| `POST /api/admin/sessions/:id/recreate {expectImageId}` | admin (`adminActionIp`); fila `operate` fail-closed con owner ajeno | recreación de §2.7.2–§2.7.4; 409 con el código de la primera precondición que falla; 500 `recreate-failed {step, unresolved?}`; 503 `docker-unavailable` |
| `CONVERSATION_ALLOW_USERS=<id,id>` | env | sesiones nuevas de esos usuarios nacen con `conversation_requested=1` |
| `npm run conversation:disable -- <sid>\|--all` | shell host | fila "Emergencia" de §2.4 con el orden de §2.5: marca de revocación, D1, archivos; si D1 falla, deja la marca, no borra archivos y sale ≠ 0 |
| `npm run conversation:enable-all` | shell host | quita `REVOKED_ALL`; no toca filas ni marcas por sesión |
| `GET /api/admin/stats` → `conversation` | admin | `{ enabledSessions, effectiveSessions, eventsSinceBoot, rejectedSinceBoot{byReason}, gapsSinceBoot, unattributedGaps, bytesOnDisk, queueBytesNow, queueBytesMax, wsResyncsSinceBoot, recreateOrphans }`; **sin** títulos ni ids de conversación. `effectiveSessions` cuenta según §2.7.6 sin probe por sesión: es una cota superior ("configurada"), y el valor con probe solo se da por sesión |

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

- [ ] Directorio vacío + script + relay presentes; pin 2.1.308; el script termina en ≤ 6 s con
      el relay ausente, con un relay que acepta y nunca responde, y con `claude --version`
      colgado (simulado con un `claude` falso en PATH).
- [ ] Relay (§2.6), tests automáticos: solo `POST` a la ruta exacta; 204 vacío pase lo que pase el
      backend; orden FIFO; cotas de cola, bytes y concurrencia; timeouts; conservación (recibidos =
      reenviados + informados como perdidos); `X-ST-Relay-*`; ningún cuerpo ni token en sus logs.
- [ ] Smoke test con el CLI real: sin archivo ⇒ cero peticiones y ningún relay; con archivo ⇒
      `session_start`, `user_prompt`, `assistant_delta{final}`, `turn_end`, `session_end`, herramientas
      y subagente con los campos de §4.2; backend caído, colgado o sin DNS ⇒ duración de `claude -p`
      ≈ base y `gap relay_dropped` al volver; relay muerto y reiniciado ⇒ Claude sigue y
      `gap relay_restart`; cola saturada ⇒ pérdidas contadas; `HTTP_PROXY` con y sin el `NO_PROXY`
      del backend; RAM, CPU y latencia del relay medidas, incluido el streaming de MessageDisplay;
      borrar el archivo ⇒ la siguiente sesión no emite; medición (informativa, registrada en el PR y
      en §2.4) de si una sesión interactiva ya abierta deja de emitir al borrar el archivo.
- [ ] README de la imagen: sección "Conversation hooks (managed settings)".

### 3.0d activación

Criterios del diseño aprobado ([§5.7](./design/phase3-3.0d-activation.md), v5). Cada uno *MUST*
tener su test; si hay contradicción con el diseño, manda §2.7.

**Superficie y ciclo de vida**

- [ ] Endpoint admin, allowlist y stats según §7; deshabilitar refleja D1, el archivo y la marca
      en ≤ 1 s; stats sin títulos ni ids.
- [ ] Lock por sesión en `start`, `stop`, `kill`, `delete` (soft/hard) y `recreate`. Las
      operaciones concurrentes durante cada paso esperan y actúan sobre el estado final, y nunca
      se purga un workspace con `N` arrancando. `recreate` con otra operación en curso ⇒ `busy` sin
      efectos. Las esperas vencidas ⇒ `busy`.
- [ ] `start` de un contenedor existente sigue sin recrear ni escribir marcas ni archivos (test
      sobre `startContainer`).

**Recreación (§2.7.1–§2.7.4)**

- [ ] Cada precondición con su código. Cada clase de `docker diff`, incluidas las formas
      incorrectas de los symlinks. `~/.gitconfig` exacto, con una clave extra y con otro email.
- [ ] `expectImageId` distinto ⇒ 409 sin efectos. Tag movido entre el preflight y el POST ⇒
      `image-changed`. `docker inspect N` ⇒ `.Image` = `imageId`.
- [ ] **Rollback resuelto:** fallo definitivo en cada paso del 1 al 4, sin trabajo en vuelo ⇒
      estado idéntico al previo (D1, nombres, hash, archivo, marcas, mapeos y skills), sin `N`,
      sin `defer-skill-seed`, y 500 `recreate-failed {step}` **sin** `unresolved`. CAS con 0
      filas ⇒ rollback resuelto.
- [ ] **Rollback no resuelto (`unresolved:true`):** `remove(N)` falla o es ambiguo, `N` sigue
      presente, una llamada en vuelo o un CAS ambiguo ⇒ 500 `{step, unresolved: true}`, marca
      conservada, sesión sin resolver, `capture` y preflight con `recreate-unresolved`. Tras la
      resolución automática, el mismo estado final que un rollback resuelto, o la convergencia
      sobre `N` si el CAS se aplicó.
- [ ] **Resoluciones tardías (K1):** cada una con la época ya cerrada.
      - `createContainer` que termina después de su tope ⇒ `N` aparece por etiqueta, la
        resolución lo elimina, y la marca se retira solo entonces;
      - CAS que se aplica después del timeout del cliente ⇒ `N` no se borra; la relectura
        posterior a `T_d1` (que solo vale para D1) ve `container_id = N` y converge sobre `N`, y D1
        nunca apunta a un contenedor inexistente;
      - probe que responde positivo después de su tope ⇒ no se escribe `conversation.json` y se
        retira la marca;
      - rename que se aplica tarde ⇒ la resolución usa los nombres observados;
      - postStart que sobrevive a `T_rec` ⇒ el backend no hace nada al terminar.

      En ninguno hay escrituras de la recreación después del cierre de la época.
- [ ] **Concurrencia en `uncertain` (K1):** `start`, `stop`, `kill`, `delete` soft y hard,
      `recreate`, `PATCH {enabled:true}` y las escrituras de `reconcile` ⇒ `recreate-unresolved`
      sin efectos, y nunca se purga el workspace. `PATCH {enabled:false}` y `conversation:disable`
      sí funcionan, con un CAS tardío incluido (no pisa `requested = 0`).
- [ ] **Camino exitoso completo sin bloqueo circular (K1.3):** recreación con el registro en
      `open` ⇒ el propio intento ejecuta el paso 5 (autorización, marca, probe, archivo) y el
      paso 6 bajo su lock y época, sin `recreate-unresolved`. Mientras tanto, una operación ajena
      espera el lock o responde `busy`, nunca actúa. Al terminar, el registro pasa a `resolved`
      (`committed`) y `capture.effective:true`.
- [ ] **El `N` confirmado nunca es sobrante (K1.1):** recreación exitosa → `reconcile` (reinicio
      del backend) → `stop` → `start`, varias veces ⇒ `N` se conserva y arranca con su id, su
      captura sigue efectiva, y ninguna eliminación le afecta aunque lleve la etiqueta de un
      intento `resolved`. Un sobrante real (otro contenedor con esa etiqueta y otro id, nunca
      arrancado) sí se elimina sin arrancarse.
- [ ] **Evidencia y no tiempo (K1.2):**
      - con el proceso vivo y dockerd que responde tarde a un `create` o un `rename` ⇒ el
        registro sigue `uncertain` hasta esa respuesta, la continuación tardía no hace efectos,
        y la resolución usa la respuesta y el estado observado;
      - las peticiones a Docker del intento nunca se abortan en el cliente;
      - dockerd sin respuesta ⇒ `uncertain` indefinidamente.
- [ ] **Reinicio del backend con un intento `open` o `uncertain` (K1.2):** con el `create` de
      `N` aplicado antes del reinicio, después de `T_d1`, o todavía invisible al escaneo inicial
      ⇒ la sesión queda en `recreate-unresolved` y **no se resuelve automáticamente** por ningún
      plazo ni escaneo (D8: fail-closed). D1 apunta a un contenedor existente, ninguna operación
      incompatible se ejecuta, la skill sigue intacta, y deshabilitar y el comando de emergencia
      funcionan.
- [ ] **Registro del intento:** escrito antes del primer efecto, de forma atómica, sin token ni
      hash; estados `open` → `resolved` o `open` → `uncertain` → `resolved`; `outcome` fijado al
      resolver; conservado hasta el hard delete, sin que eso sea un límite ni una garantía.
- [ ] Paso 4 atómico: en ningún instante observable `container_id = N` con un hash distinto del de
      `N`.
- [ ] `docker start` manual de `O` entre los pasos 2 y 3 ⇒ rollback sin arrancar `N`.
- [ ] **Skills personalizadas (A2/P1):** una gestionada personalizada ⇒ el preflight y el POST
      bloquean `managed-skills-customized`, sin efectos, con todas las skills byte a byte. Sin
      ella ⇒ la gestionada sin tocar pasa a I_N, la del usuario sigue igual byte a byte, y la
      siembra ocurre solo en el paso 6.2. Una colisión que solo existe en la imagen de `N` ⇒
      bloqueo en el paso 1 y rollback. `O` sin skills ⇒ toda W gestionada colisiona.
- [ ] **Aplazamiento (A2/P2):** dos arranques de `N` antes del CAS (reinicio inyectado y
      `docker restart`) + fallo ⇒ la skill queda intacta y no se siembra. Éxito ⇒ la marca se
      retira en 6.1 y se siembra una sola vez. Caída entre el CAS y 6.1 ⇒ `reconcile` retira la
      marca y siembra (`N` en marcha) o lo deja para el siguiente arranque (`N` detenido).
- [ ] **Eliminación incierta (A2/P2):** `remove(N)` falla, o queda ambiguo, y `N` arranca antes de
      cualquier CAS ⇒ la marca sigue, `N` no siembra, la skill sigue intacta y D1 sigue en `O`.
      Con la eliminación confirmada en el siguiente `reconcile` ⇒ la marca se retira y `O` vuelve
      a su nombre.
- [ ] Precondición 7: `.npm-global` ausente o symlink, o layout heredado ⇒ bloqueo sin efectos.
- [ ] Topes (§2.7.4), con Docker simulado que no responde:
      - en el paso 3 ⇒ cierra la época; hay rollback cuando se resuelve lo que está en vuelo;
      - rollback colgado ⇒ el lock se libera a los `T_rec` + `T_rb` y la sesión queda sin
        resolver;
      - después del CAS (probe, siembra o postStart colgados) ⇒ se abandona el resto y ninguna
        operación espera más de `T_rec` + `T_rb`;
      - un `DELETE ?hard=true` posterior responde `recreate-unresolved` o 503 y nunca purga.
- [ ] Las cuatro filas de `reconcile` de §2.7.4. Los nombres que no encajan con el patrón
      reservado no se tocan. El rename de `O` con el nombre canónico ocupado por `N` se trata como
      estado incierto.

**Autorización y marcas (§2.7.5, A4)**

- [ ] Contenedor que arranca con token y sin archivo ni marca + `PATCH {enabled:true}` ⇒ marca →
      relay identificado en ≤ 5 s → archivo. Con el CLI real: un prompt en una pestaña ya abierta y
      otro en una nueva, entregados, `effective:true`, sin "hook error" y sin recreación. El paso 5
      de la recreación sigue el mismo camino.
- [ ] **Conservación durante el stop (K2):** sesión con captura efectiva → `stop` → `reconcile`
      (reinicio del backend) → `start` ⇒ marca y archivo siguen, el relay arranca en el boot y
      `effective:true` sin `PATCH` ni recreación. Antes del start: `effectiveAfterRestart:true`.
      Variantes con el contenedor detenido, cada una retira en `reconcile`: revocación, flag
      apagado, `token-mismatch`. Sin contenedor (`kill`) ⇒ se retiran y el spawn las rehace.
- [ ] **Preparación del spawn (K2):** sesión nueva y `start` sin contenedor ⇒ hash → marca →
      archivo antes de crear el contenedor con ambos montajes, y efectivo tras el boot. Con la
      creación fallida, `reconcile` retira lo que quedó sin contenedor.
- [ ] **Contenedor de 3.0c sin montaje de control (K3):** en marcha y detenido, con token y
      correspondencia, y con `conversation.json` residual ⇒ `PATCH {enabled:true}` no escribe
      nada; `reconcile` y `PATCH` retiran archivo y marca; `effective:false`,
      `effectiveAfterRestart:false`, `requiresRecreate:true`. Tras la recreación (§2.7) ⇒
      efectivo.
- [ ] Residuales, con marca y archivo presentes:
      - revocación por sesión y global ⇒ `effective:false` y retirada;
      - flag apagado ⇒ `reconcile` retira todas;
      - `token-mismatch` ⇒ nunca se reescriben;
      - `conversation:disable` concurrente con `PATCH {enabled:true}` (100 repeticiones) ⇒ nunca
        quedan marca ni archivo tras el comando, y nunca `effective:true`.
- [ ] Compatibilidad de `/etc/st-control` con el CLI real (vacío, con marcas, ilegible, con un
      `.json` inválido) ⇒ hooks y eventos idénticos y sin avisos. Si falla ⇒
      `control-marker-incompatible` y la activación bloqueada.

**Estado efectivo (§2.7.6, A3)**

- [ ] Correspondencia: hash viejo en D1 y token nuevo, en marcha y detenido ⇒ nunca
      `effective:true` ni `effectiveAfterRestart:true`; `token-mismatch` + `requiresRecreate`;
      `PATCH` no escribe y no copia la huella. Variantes: el suspendido igual a la huella se
      restaura; los dos NULL tras una emergencia nunca se vuelven a autorizar.
- [ ] `effectiveAfterRestart` sin contenedor: un test por cada condición falsa (`requested=0`, flag
      apagado, revocación por sesión, revocación global, imagen sin `="2"`) ⇒ `false`. Todas
      verdaderas ⇒ `true` y efectivo tras el start. Lo mismo para la rama del contenedor detenido.
      Detenido con correspondencia y sin marca o archivo ⇒ `false`, `requiresRecreate:false` y
      efectivo tras start + `PATCH`, sin recrear.
- [ ] Probe (D7):
      - positivo ⇒ `effective:true` con `checkedAt` de la petición;
      - relay caído o puerto ocupado ⇒ `false`;
      - consulta inmediata tras la caída ⇒ `false`;
      - dos consultas concurrentes ⇒ un probe;
      - una consulta posterior ⇒ probe nuevo;
      - otra condición falsa ⇒ sin probe.

**Smoke de Docker con el CLI real**

- [ ] Recreación correcta: workspace con hash idéntico, `claude --resume` encuentra la
      conversación, `git config user.email` intacto, secreto y puerto presentes, relay
      identificado, eventos en `.conversations/`, `capture.effective:true` y `O` borrado.
      Variantes: `~/.bash_history` o `apt-get install` ⇒ `recreatable:false` sin efectos; el
      backend muerto entre los pasos 2 y 4 ⇒ `O` intacto; muerto después del 4 ⇒ completa con `N`.
- [ ] **(a) Activar con el relay no disponible** (puerto ocupado antes del boot, relay impedido en
      el paso 5, marca o archivo borrados, hash cambiado) ⇒ `effective:false` con su motivo, sin
      archivo de hooks y **0 "hook error"**.
- [ ] **(b) Caída del relay tras activar** (`kill -9` con una pestaña abierta). No se promete
      cero errores. Se exige:
      - la primera consulta da `relay-unavailable`;
      - `effective:true` de nuevo en ≤ 3 s;
      - el turno de la ventana termina, con "hook error" ≤ el número de hooks bloqueantes de ese
        turno, y 0 en el turno siguiente;
      - `gap relay_restart` en la conversación.
- [ ] Prueba manual documentada en el PR: una sesión real activada produce eventos en
      `GET …/conversations` y en el archivo; deshabilitar corta la ingesta de inmediato.
- [ ] El PR de implementación actualiza DEPLOYMENT.md ("Recreating a session container" sobre el
      endpoint; el procedimiento manual como emergencia, con sus pérdidas) y session-image/README.md
      (directorio de control, `seed-skills.sh`, `GET /st-relay/status`, etiqueta `="2"`).

### 3.1 vista

- [ ] Overlay Chat con `viewSwitch`; owner-only en todas las rutas (403→404); `canSendInput=false`;
      `capture.effective=false` se muestra como aviso ("captura no activa").
- [ ] Replay + live determinista (test del broadcaster); paginación hacia atrás; `firstRetainedSeq`
      y `gap history_rotated`; G3 con **eventos grandes**: cliente que no lee + 60 eventos de 1 MiB
      (uno de ellos `\u0001` puro, frame ~6 MiB) ⇒ `bufferedAmount` máximo ≤ 2 MiB + frame
      serializado mayor, cierre 1013, y al reconectar desde el último
      `seq` recibido no hay pérdida ni duplicado; en live, `resync` sin pérdida ni duplicado;
      20k eventos < 500 ms.
- [ ] Herramientas por `tool_use_id` (§4.2 nota 1): `tool_start` + `tool_failed` + `tool_end` del
      mismo id se representan como una sola herramienta fallida, en cualquier orden de llegada;
      los contadores cuentan ids distintos (test con la secuencia real de 2.1.308).
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
