# Project Chat — especificación de la POC de Channels

Estado: **diseño; no ejecutada**. Los criterios GO / NO-GO de §5 se fijan **antes** de correrla y no
se cambian después de ver resultados (si un criterio resulta mal planteado, se documenta y el
responsable decide).

Pregunta que responde: *¿puede un monitor fuera del CLI entregar un mensaje a una sesión interactiva
existente de Claude Code mediante Channels, sin tmux, con evidencia de aceptación, sin pérdidas ni
duplicados, y con fallos explicables?*

---

## 1. Aislamiento y límites

Principio: la POC corre en una máquina que **no puede** alcanzar nada de producción, no por
disciplina sino por construcción. Si alguna condición de esta sección no se puede cumplir, la POC no
empieza.

### 1.1 Host

- Una **VM Linux x86_64 desechable**, en una **máquina físicamente independiente del Proxmox de
  producción** (preferencia del responsable, 2026-11-02), creada para la POC y destruida al terminar.
  *MUST NOT* ser el host de producción (el que corre `st-backend` y las sesiones), ni ningún host
  donde corran sesiones reales, incluidas las de Claude A, Home Automation y B, ni este workspace.
- Sin credenciales de producción en la VM: ni `.env` del backend, ni tokens de Cloudflare, ni
  `JWT_SECRET`, ni `SECRETS_ENCRYPTION_KEY`, ni acceso al túnel. Sin rutas de red hacia la red de
  producción (ni VPN ni túnel).
- Guarda del harness: antes de cada corrida comprueba que no existe ningún contenedor ni red con
  nombres de Shared Terminal (`st-backend`, `st-*`, `sessions-net`) y que no hay variables de
  producción en el entorno; si encuentra alguno, aborta sin hacer nada.
- El harness sólo actúa sobre recursos con la etiqueta `io.shared-terminal.poc=1` (contenedores,
  red, volúmenes); toda llamada a `docker` filtra por esa etiqueta.

### 1.2 Contenedor del agente

- Imagen construida desde `session-image/` del commit de la POC, con `CLAUDE_CODE_VERSION` fijo y
  `DISABLE_AUTOUPDATER=1` (la versión no cambia durante la corrida, R9).
- `docker run` directo, **sin fila en D1** y sin backend.
- **Sin socket de Docker**: *MUST NOT* montar `/var/run/docker.sock` ni ningún socket del host.
- Montajes permitidos, y sólo estos: volúmenes nuevos y vacíos para el workspace y para HOME; `managed-settings.d`
  de la POC en sólo lectura; los archivos del prototipo (`st_channel.py`, wrapper `tmux`) en sólo
  lectura. Ningún bind de rutas del host con datos.
- Endurecimiento: `--cap-drop ALL`, `--security-opt no-new-privileges`, `--pids-limit 512`,
  `--memory 2g`, `--cpus 2`, usuario `developer` (no root), `--read-only` para todo salvo el
  workspace, `/tmp` (tmpfs) y HOME (un volumen propio de la POC, porque guarda las credenciales del
  login de §1.4 y debe sobrevivir al `docker stop` de E8; se destruye en §1.5). Si el entrypoint de la imagen no tolera alguna de estas
  restricciones, se añade sólo la capacidad o el directorio mínimo y se documenta en el informe.
- **tmux**: `claude` se lanza como comando de `tmux new-session -d` (nada se teclea). Un wrapper
  `tmux` en el `PATH` registra cada invocación con su origen; el criterio G6 exige cero `send-keys`,
  `paste-buffer` y `load-buffer` del monitor o de `st-channel`. Las únicas escrituras permitidas son
  las del harness en E4c/E4d, que **simulan a la persona**, van etiquetadas `actor=human-sim` y quedan
  fuera de G6.

### 1.3 Red

- Una red Docker `internal` (sin salida) une el contenedor con el monitor de la POC.
- La única salida a Internet es un proxy HTTP(S) con **allowlist por dominio** (deny por defecto),
  configurado con `HTTPS_PROXY` en el contenedor y `NO_PROXY` para el monitor. La allowlist empieza
  con `api.anthropic.com` y los dominios del flujo oficial de login de Claude Code; en la fase 0 el
  proxy registra los dominios denegados y sólo se añaden los de Anthropic que el CLI necesite (p. ej.
  el de flags que evalúa el gate). Para instalar `fakechat` se abren temporalmente los dominios de
  GitHub del marketplace oficial y se cierran antes del login. Todo dominio añadido queda en el
  informe.
- El monitor de la POC no tiene salida a Internet.

### 1.4 Autenticación y consumo (decisión del responsable, 2026-11-02)

- **Única autenticación permitida: la suscripción de Claude del responsable, con el login oficial de
  Claude Code** (`/login` dentro del CLI del contenedor de la POC, flujo OAuth en el navegador del
  responsable).
- *MUST NOT*: usar Anthropic Console, API keys de pago, `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL` ni
  cualquier otro proveedor.
- *MUST NOT*: extraer, copiar, montar o reutilizar tokens OAuth o credenciales de sesiones existentes
  (`~/.claude/.credentials.json`, `.st/claude-state`, `~/.claude.json` de ningún workspace). El login
  se hace **de cero** en el contenedor de la POC, lo hace **el responsable** (adjuntándose al tmux
  del contenedor en la VM), y el agente no ve ni manipula el token. El harness *MUST NOT* leer
  `~/.claude/.credentials.json`.
- **Sin gastos adicionales**: antes de la prueba, el responsable confirma que el uso extra / de pago
  por exceso está **desactivado** en su cuenta. La POC consume sólo los límites incluidos en el plan.
  Si el CLI informa un límite de uso (`StopFailure` `rate_limit`, aviso de límite del plan) o propone
  pasar a uso pagado, el harness se **detiene** y se informa; nunca se acepta.
- **Si Channels está bloqueado para la suscripción** (no registra, "not currently available",
  política), el resultado es **NO-GO** y se registra. *MUST NOT* cambiar a API ni a otro método de
  autenticación, ni automáticamente ni a propuesta del agente.
- Consumo mínimo: mensajes de prueba triviales ("respondé `OK-<n>`"), sin herramientas salvo las del
  experimento, modelo por defecto del plan.
- Las credenciales del login viven sólo en el HOME del contenedor de la POC (volumen de la POC) y
  se destruyen con él (§1.5).

### 1.5 Eliminación al terminar (en este orden)

1. `/logout` en el CLI de **cada** contenedor de la POC, mientras el contenedor todavía existe; el
   responsable revisa en su cuenta que no quede ninguna sesión autorizada de la POC.
2. Copia de evidencias, sólo de esta lista: hooks crudos, log del monitor, log del wrapper `tmux`,
   log del proxy, log de depuración del CLI. Antes de copiar, el harness las escanea y **redacta**:
   cualquier valor con forma de token (`sk-ant-`, cabeceras `Authorization`, `access_token`,
   `refresh_token`), direcciones de correo y el id de cuenta/organización. Nunca se copia
   `~/.claude/.credentials.json` ni `~/.claude.json`. Si el escaneo encuentra un token después de
   redactar, no se copia nada y se informa.
3. `docker rm -f` de todo lo etiquetado `io.shared-terminal.poc=1`; `docker volume rm` (workspace y
   HOME, que guarda las credenciales) y `docker network rm` de lo mismo; borrado de la imagen.
4. Destrucción de la VM (o, si es local, borrado del disco virtual).
5. Lista de verificación firmada en el informe de resultados.

### 1.6 Prototipo

- El "monitor" es un script de la POC (`poc/channels/monitor.mjs`, Node 22 sin dependencias) que
  implementa sólo §6.2 del protocolo y escribe un log JSONL. La "captura" es un receptor HTTP del
  mismo script que imita `/ingest/claude/hook` y guarda los hooks crudos (el relay de la imagen lo
  alcanza con un alias de red).
- `st-channel` es el prototipo del adaptador (`poc/channels/st_channel.py`, Python stdlib), cargado
  como servidor MCP stdio.
- La rama de la POC **no se mergea**; sus resultados se adjuntan a este documento en un PR de docs.
- La POC **no** usa el mock del smoke (Channels exige autenticación first-party, C16) ni ninguna
  otra autenticación que la de §1.4.

### 1.7 Fase 0: disponibilidad y despertar con `fakechat` (variante local)

**Decisión del responsable (2026-11-02):** la fase 0 **no** usa VM. Corre como un **usuario
temporal del sistema, estándar y nuevo**, en el Mac o PC del responsable. Las secciones §1.1–§1.6
(VM, contenedor endurecido, proxy, eliminación de la VM) quedan para la **POC completa**, donde sí se
prueban fallos, concurrencia y reinicios. Kit: rama `poc/channels-phase0` (sin merge), carpeta
`poc/channels-local/`, con el procedimiento paso a paso en su README.

| Requisito | Cómo lo cumple la variante local |
| --- | --- |
| Perfil aislado | Usuario del sistema nuevo y no administrador (`pocchannels`): HOME, `~/.claude`, llavero y navegador propios; se borra al final. **No** se usa `CLAUDE_CONFIG_DIR` dentro del usuario habitual: en macOS el token va al llavero y podría mezclarse con la instalación habitual |
| Suscripción, sin API key ni uso extra | `/login` oficial; `forceLoginMethod: "claudeai"` en los settings del usuario temporal; `DISABLE_EXTRA_USAGE_COMMAND=1`; el responsable confirma en su cuenta que el uso extra está desactivado; el preflight falla con variables de API key |
| Sin credenciales existentes | HOME nuevo; el preflight comprueba antes del login que no hay credenciales de Claude (archivo, `~/.claude.json`, llavero) ni claves SSH |
| `fakechat` fijado y dependencias revisadas | Desde el marketplace oficial (para seguir en la allowlist de Anthropic); se exige el **conjunto exacto de archivos** y el SHA-256 de cada uno de `claude-plugins-official@7994c27`; `bun install --frozen-lockfile` con los 95 paquetes del `bun.lock` (integridad sha512); falla si el lockfile cambia. Las dependencias son el SDK de MCP 1.27.1 y lo que arrastra para su modo HTTP (express, hono, cors, jose…), que `fakechat` no usa: habla por stdio |
| Sin Docker, Shared Terminal, Proxmox ni producción | El kit no ejecuta `docker` ni `ssh` ni contacta otros hosts que Anthropic, GitHub, `bun.sh` y npm; el preflight exige que el usuario no sea administrador ni del grupo `docker` y que `docker ps` falle |
| Sin tocar proyectos, configuración ni sesiones | Todo en el HOME del usuario temporal; CLI 2.1.314 y Bun 1.3.10 instalados **en ese HOME** (el preflight falla si resuelven a la instalación habitual); managed settings de la máquina **no** se tocan (si existen, el preflight falla y se consulta) |
| Sin `--dangerously-skip-permissions` | Modo normal; **todas** las herramientas denegadas, incluida la respuesta de `fakechat` (su `reply` copia cualquier archivo legible a una carpeta que sirve sin autenticación). La medición sólo necesita `UserPromptSubmit` y `Stop`; si aparece un diálogo de permiso, la persona contesta **No** |
| Registro | Hooks `command` a un archivo (`SessionStart`, `UserPromptSubmit`, `Stop`, `StopFailure`, `Notification`, `SessionEnd`) y log de depuración del CLI |
| Limpieza | `/logout`, copia redactada (exige que ya no haya credenciales), borrado del usuario (HOME y llavero), borrado de sus temporales por uid (`/private/var/folders` en macOS, `/tmp/claude-<uid>` en Linux) y revisión de autorizaciones en claude.ai |

**Limitaciones de seguridad que introduce la variante local** (aceptadas por el responsable al
elegirla; ninguna afecta la validez de lo que la fase 0 mide):

1. **Sin sandbox.** El usuario temporal comparte equipo y kernel y puede leer archivos legibles por
   todos de otros usuarios. Mitigación: herramientas de lectura, escritura y shell denegadas;
   mensajes triviales; en macOS las carpetas personales son privadas por defecto.
2. **Red sin restringir.** La LAN, Proxmox incluido, es alcanzable a nivel de red. Mitigación: ninguna
   credencial de producción en ese usuario y ninguna herramienta de red o shell para Claude. A
   diferencia de la VM, se demuestra que **no se toca** producción, no que **no se pueda**.
3. **`fakechat` sin autenticación ni control de origen en `127.0.0.1`.** Durante las ~2,5 h de la
   prueba, cualquier proceso local y **cualquier página web abierta en el equipo** (formulario
   multipart a `/upload`, WebSocket a `/ws`) puede enviar un prompt a esa sesión. Mitigación:
   **ninguna** herramienta permitida, incluida `reply`, así que un prompt inyectado sólo produce
   texto y consume cuota; el informe lo detecta y esa muestra no cuenta como correlación limpia.
4. **Código de terceros** (`fakechat` y 95 paquetes) corre como el usuario temporal; fijado por
   lockfile con integridad, no auditado línea por línea.
5. **Mismo plan.** Los ~12 turnos consumen el límite incluido de la suscripción, compartido con las
   sesiones reales; sin gasto adicional.
6. **Login en el navegador del usuario temporal** (macOS) o en una ventana privada (Linux): el token
   nuevo vive sólo en ese usuario y se elimina con él.

**Dos etapas separadas** (decisión del responsable, 2026-11-02):

- **S0, preparación**: crear el usuario, instalar CLI y Bun fijados en su HOME, bajar el kit,
  `setup` (`fakechat` + pin + dependencias) y `preflight`, **sin** la suscripción. Termina con
  `preflight.md` sin ningún FAIL.
- **S1, fase 0**: sólo después de revisar S0 y de que el responsable haga el `/login` oficial.
  Registro del canal y hasta 12 despertares. El informe separa **registro del canal**, **despertar
  efectivo**, **latencia**, **`source` del hook** y **correlación del mensaje**, y termina en una
  nueva decisión del responsable. Un fallo del harness (subida rechazada, hooks sin funcionar, puerto
  de otro proceso, motivo de `skip` que no es de disponibilidad o política) **nunca** se registra como
  NO-GO.
- **NO-GO de disponibilidad sólo confirmado dos veces**: el gate del CLI decide con flags remotos
  que, en un HOME nuevo, pueden no estar todavía en caché, y falla cerrado. Un primer `skip` de
  política o disponibilidad queda **sin confirmar**; es NO-GO sólo si un segundo arranque, ≥ 60 s
  después, da el mismo motivo con los flags ya en caché.
- **NO-GO de despertar sólo con evidencia**: sin `UserPromptSubmit`, la muestra es "no despertó"
  únicamente si el CLI registró la recepción del mensaje, la sesión sigue en su prompt y no hubo
  turno. Cualquier otro caso (descarte silencioso del CLI, borrador en el input, duda) es
  **indeterminado**.

Es lo **único** que se ejecutará primero, y sólo con una autorización explícita del responsable para
esta prueba. No se escribe `monitor.mjs` ni `st_channel.py` antes de su resultado.

Objetivo: comprobar (1) que Channels está disponible con la suscripción del responsable y (2) que
una notificación de canal despierta una sesión interactiva **inactiva** en su prompt.

| Paso | Qué | Evidencia |
| --- | --- | --- |
| F0.1 | Usuario temporal, CLI y Bun fijados en su HOME, kit en el commit autorizado, `setup` y `preflight` (S0). Sin uso de la suscripción | `preflight.md` sin FAIL |
| F0.2 | El responsable hace `/login` con su suscripción y confirma que el uso extra está desactivado | `/status` con el plan; el token no sale del usuario temporal |
| F0.3 | `claude --channels plugin:fakechat@claude-plugins-official --debug-file …`, **sin** `--dangerously-skip-permissions`; `phase0.mjs registration` | registro o motivo del `skip`; el puerto de `fakechat` pertenece a ese `claude` |
| F0.4 | 10 mensajes con la sesión en su prompt (`claude agents --json`: `idle` o `waiting`+`input needed`) e inactiva ≥ 30 s, y 2 más tras ≥ 1 h | por mensaje: despertó, latencia, `source`, forma exacta del `prompt`, `Stop` del mismo `prompt_id` |
| F0.5 | `/logout`, `archive` (copia redactada) y borrado del usuario | informe archivado; usuario eliminado |

Viabilidad (se resuelve en S0, **antes** del login): del commit fijado de `fakechat` se anotan su
runtime (la versión de memoria del revisor es que corre con Bun, que la imagen no trae), sus
dependencias y cómo recibe mensajes (interfaz web local; si no hay un endpoint HTTP documentado, el
harness usa el mismo que usa la página). Todo se instala antes de cerrar GitHub en el proxy. Si el
plugin no arranca o no se puede alimentar, es un **fallo del harness**: se corrige y se repite, y
**nunca** se registra como NO-GO de Channels. Sólo cuentan como bloqueo los motivos que el CLI
registra para no admitir el canal.

Resultado de la fase 0:

| Observación | Registro | Siguiente paso |
| --- | --- | --- |
| No registra por bloqueo de la suscripción, política o "not currently available" | **NO-GO** | Ninguno: no se cambia a API. Se reevalúa sólo si Anthropic cambia la disponibilidad y el responsable lo pide |
| Registra pero no despierta en alguno de los 12 | **NO-GO de Channels para despertar** | El responsable decide si autoriza evaluar el brazo B (`asyncRewake`, también con su suscripción) — R2 |
| 12/12 despiertan y el hook trae `source: system` con la etiqueta | **Fase 0 superada** (no es un GO de arquitectura: 12 muestras sólo acotan la tasa de fallo en ≈ 25 %) | Presentar resultados y pedir un **GO separado** para la POC completa (§7) |
| 12/12 despiertan pero `source` ausente o la etiqueta no está en el `prompt` | Fase 0 superada en disponibilidad; **G3 en riesgo** | Presentar; la POC completa sólo con GO explícito sabiendo que G3 probablemente falle |

### 1.8 Evidencia exploratoria (2026-11-02) — **no** cuenta entre las 12 muestras

Pruebas manuales del responsable en su Mac, en su sesión habitual de Claude Code, con su
suscripción y `claude --channels plugin:fakechat@claude-plugins-official`, sin hooks ni medición.
Versión del CLI: a completar.

| Hora | Enviado desde Fakechat | Respuesta en Fakechat | Observación |
| --- | --- | --- | --- |
| 19:33:49 | `hola` | 19:33:56 | — |
| 19:34:25 | `Prueba de Shared Terminal. Respondé exactamente CHANNELS_OK y enviá tu respuesta a Fakechat.` | 19:34:28, `CHANNELS_OK` | — |
| 19:37:22 | `IDLE_01: Respondé exactamente IDLE_OK_01.` | 19:37:25, `IDLE_OK_01` | ≈ 2 min 54 s después de la respuesta anterior |

En la terminal aparecieron las tres entradas con el prefijo `← fakechat · web:` y cada una provocó
actividad sin que nadie escribiera ni pulsara Enter. Claude respondió las tres veces con la
herramienta de `plugin:fakechat:fakechat`.

| Qué muestra | Qué **no** muestra |
| --- | --- |
| Channels está disponible con la suscripción del responsable (2026-11-02) | Que `UserPromptSubmit` traiga `source=system` |
| El plugin oficial se carga con `--channels`, sin flag de desarrollo | Que el `prompt` del hook lleve una etiqueta `<channel>` utilizable para correlación |
| Una notificación llega a una sesión interactiva **existente** | Atribución inequívoca de cada `turn_end` |
| La sesión procesa el mensaje sin intervención en la terminal | Despertar tras ≥ 1 h de inactividad |
| Claude puede responder por la herramienta MCP del plugin cuando se le pide | `--resume`, concurrencia, fallos, kill switch |
| Al menos un despertar tras ≈ 3 min sin mensajes | Fiabilidad (3 muestras no acotan ninguna tasa) |

### 1.9 Fase 0 instrumentada: sesión local del responsable con hooks de carpeta

**Decisión del responsable (2026-11-02):** las 12 muestras de §1.7 se toman en la misma sesión local
de §1.8, no en un usuario temporal. La instrumentación se instala **sólo** en la carpeta de prueba
(`<carpeta>/.claude/settings.local.json`): sin tocar `~/.claude/settings.json`, sin reinstalar
Claude ni el plugin, sin leer credenciales y sin `/logout`. Kit: rama `poc/channels-phase0`,
carpeta `poc/channels-mac/`; el kit de usuario temporal (`poc/channels-local/`) queda como
alternativa no usada.

- **Hooks**: `UserPromptSubmit`, `Stop`, `StopFailure`, `SessionStart`, `Notification` y
  `PostToolUse(Failure)` sólo para las herramientas de Fakechat. Los nombres de eventos y campos se
  comprobaron en el binario 2.1.314. El logger registra además los **nombres** de los campos que
  llegan, porque la versión del responsable puede ser otra.
- **Observacional**: no imprime nada (en `UserPromptSubmit` y `SessionStart` lo impreso entra al
  contexto de Claude), siempre sale con 0 (el 2 bloquea) y no guarda texto de prompts o respuestas:
  sólo bytes, SHA-256, ids de prueba y los atributos permitidos de `<channel>`.
- **Orden**: primero **una** prueba instrumentada tras ≥ 30 s de inactividad **observada** (estado
  consultado cada 3 s, sin huecos > 10 s ni hooks nuevos; una sola observación nunca cuenta). Es lo
  único autorizado (2026-11-02): el kit rechaza las series sin una marca explícita. Las 10 cortas y
  las 2 de ≥ 1 h necesitan una autorización aparte tras revisar ese informe.
- **Despertar ≠ flujo bidireccional**: el informe da el veredicto de despertar de §1.7 y, aparte, si
  cada mensaje completó mensaje → turno → `Stop` → respuesta vista en Fakechat. Sin la respuesta
  observada en Fakechat, nunca se declara el flujo completo.
- **Por mensaje**: recibido por el CLI (línea de recepción del log de depuración), hook, despertar
  sin intervención, `Stop` del mismo `prompt_id`, respuesta vuelta a Fakechat (escucha pasiva de su
  WebSocket), latencias, `source` (presente o ausente), forma del prompt y correlación (A1–A5 de
  protocolo §3.1, `message_id` igual al id enviado).
- **Fakechat no es el monitor**: su `message_id` demuestra que una clave de `meta` aparece como
  atributo de `<channel>`. **No** demuestra `st_msg`, el nombre de nuestro servidor, su carga como
  plugin autorizado ni las condiciones A3–A7 con interferencia o relay. Eso sigue siendo hipótesis
  hasta la POC completa.
- **Seguridad de esta variante**: es la sesión habitual del responsable, no un perfil aislado. El
  riesgo nuevo es la inyección por Fakechat (sin autenticación ni control de origen): con `reply`
  permitido, un mensaje inyectado podría pedir adjuntar un archivo legible, que Fakechat sirve sin
  autenticación en `localhost`. Mitigaciones en el README del kit: carpeta dedicada sin datos
  sensibles, sin modo bypass, contestar No a diálogos inesperados, no navegar por sitios
  desconocidos durante las series.
- **Criterios**: el veredicto aplica la tabla de §1.7 sin cambios; G1–G12 de §5 no se tocan.

### 1.10 Resultado de la prueba instrumentada T (2026-11-03)

Prueba única autorizada en §1.9, id `P0T01-f9dfb6`, en la sesión del responsable con **Claude Code
2.1.317** (no 2.1.314: la sesión habitual se auto-actualiza; R9 rige para las sesiones de agente, no
para esta fase). No cuenta entre las 12 muestras. Cronología reconstruida de los registros
existentes con la extracción redactada X0 (sin texto):

| Tiempo desde el envío | Evento | `prompt_id` |
| --- | --- | --- |
| −32 s … 0 | inactividad **observada** (32 s) | — |
| +0,05 s | único `UserPromptSubmit`: una etiqueta `<channel>`, sin texto fuera; atributos `source`, `chat_id`, `message_id`, `user`, `ts`; `message_id` = id enviado; campo `source` del hook **ausente** | P1 |
| +70,18 s | `PostToolUse` de `reply` de Fakechat, respuesta exacta (vista en el WebSocket a +70,14 s) | P1 |
| +72,75 s | único `Stop` | P1 |
| +132,81 s | `Notification` `idle_prompt`, posterior al cierre del turno | — |

No hay otros `UserPromptSubmit` ni `Stop` en la ventana analizada.

**A4/A5 fallaron por un defecto del harness, no por eventos ajenos** (lo encontró el responsable):
`send.mjs` volvía a parsear `hooks.jsonl` en cada lectura y comparaba con `!==` objetos de lecturas
distintas, así que el propio `UserPromptSubmit` y el propio `Stop` se contaban como ajenos.
Corrección en `poc/channels-phase0@5686b65`: la identidad de un evento es su **línea absoluta** en el
JSONL (append-only); dos eventos distintos con el mismo `prompt_id` siguen siendo dos, y un `Stop`
duplicado del mismo `prompt_id` **sigue fallando A5** (R8 exige un único `turn_end`). Tests de
regresión: lecturas independientes, un solo prompt/`Stop`, `Stop` duplicado, prompt realmente
ajeno, línea a medio escribir. `rediagnose.mjs` recalcula un envío desde los registros existentes
sin modificarlos.

**Diagnóstico recalculado de T:**

| Dimensión | Resultado |
| --- | --- |
| Recepción por el CLI | sí |
| Despertar sin intervención (§1.7) | **observado** (sin otros prompts ni diálogo de permiso; `idle_prompt` no es un diálogo) |
| Flujo bidireccional (mensaje → turno → `Stop` → respuesta en Fakechat) | **observado** |
| Correlación A1–A5 + `Stop` del mismo `prompt_id` + `message_id` | OK |
| Campo `source` del hook | **ausente** |
| Prueba individual | **no limpia**: falta `source=system` |
| G3 en 2.1.317 | **no se cumple**: por G3 (§5), esa versión no entra en `CHANNEL_CLI_VERSIONS` |

**`source` en el binario (análisis estático, sin ejecutar):** en 2.1.314 (instalado en el host de
desarrollo) y en 2.1.317 (`@anthropic-ai/claude-code-darwin-arm64@2.1.317`, Mach-O arm64,
`shasum` igual al del registro npm, `VERSION:"2.1.317"`), los **dos** únicos constructores del
payload de `UserPromptSubmit` dejan vacío el lugar del campo:

    hook_event_name:"UserPromptSubmit",prompt:r,...!1,session_title:…
    hook_event_name:"UserPromptSubmit",prompt:e,...!1,session_title:…

`...!1` expande un `false` literal: el esquema declara `source` ("Payloads may omit it while the
field rolls out"), pero el hook de comando **nunca** lo recibe, sea cual sea el origen. Coincide con
[anthropics/claude-code#94675](https://github.com/anthropics/claude-code/issues/94675) (abierto;
ausente de 2.1.273 a 2.1.316 según sus comentarios). Internamente el CLI sí conoce el origen
(`origin:{kind:"channel",server}` al encolar, C2) y lo escribe en el transcript, no en el hook.
El atributo `source` de `<channel>` es texto del prompt: **no** es evidencia de origen.

**Los 50 ms frente a los 70 s:** el hook se dispara al enviarse el prompt encolado, antes de
cualquier llamada al modelo; mide la entrega. Los 70 s son la duración del turno hasta la llamada a
`reply`, dentro de un único turno sin otros eventos de hook en medio; los registros redactados no
determinan la causa (en §1.8 la respuesta tardó 3–7 s). No afecta al despertar ni a la correlación;
la latencia sigue siendo una dimensión que la POC completa mide.

**Hallazgo para R8 (sin cambiar R8):** en 2.1.314 y 2.1.317 el `Stop` de comando sale por dos
caminos (fin bloqueable del turno y fin de turno por resultado de herramienta, fin MCP o *loop
tick*), con el mismo payload y sin motivo. En T hubo uno solo; un duplicado haría fallar A5.

**Alternativas técnicas para el origen verificable (no elegidas; G3 no cambia):**

| | Alternativa | Qué aporta | Riesgo o costo | Verificación mínima |
| --- | --- | --- | --- | --- |
| A | Metadatos del transcript (`origin.kind = "channel"`, `promptSource`, `promptId`) | Escritos por el CLI; teclear texto no los produce | Formato interno sin documentar; momento de escritura respecto del hook; leer el transcript sólo por metadatos | Extraer esos campos del transcript de T (registros existentes) y comparar `promptId` con el `prompt_id` del hook |
| B | Hook de función de mods `prompt.submit` | Puede recibir `isMeta`/origen | Acceso anticipado; habilitación por managed settings (posible choque con R6); presencia del origen sin verificar | Inspección estática del binario |
| C | Esperar la corrección de #94675 | El `source` que pide G3 | Fecha desconocida; versión nueva validada por R9 | Inspección estática (desaparece `...!1`) y luego una prueba T |
| D | Sesiones headless stream-json (`origin` en `result`) | Origen tipado | Cambia la arquitectura (agentes interactivos en tmux) | Diseño aparte |

Descartadas por no cumplir G3 tal como está escrito: un nonce de nuestro servidor (prueba posesión
del token, no origen) y `asyncRewake` (R2), que también llega como prompt sin `source`.

**Estado:** las 12 muestras **no** están autorizadas; G1–G12 y R8 sin cambios. La alternativa A
dio positivo sobre los registros existentes (§1.11); XA-1 dio `late` y el orden del binario lo
explica: en 2.1.317 el hook corre antes de la escritura del transcript (§1.12).

### 1.11 Alternativa A: origen según el transcript del CLI (XA-1 `late`; ver §1.12)

**No cambia G3, R8 ni G1–G12.** Esta sección diseña cómo investigarla; la propuesta G3-A del final
es para una revisión de diseño aparte y **no** está aprobada ni sustituye a G3.

**X1 sobre los registros existentes de T (2.1.317, 2026-11-03):** un archivo de transcript, sin
líneas ilegibles; exactamente un registro de canal para la prueba (`type=user`, `isMeta=true`,
`promptSource=system`, `origin.kind=channel`, `origin.server=plugin:fakechat:fakechat`, misma
sesión); su `promptId` es **igual** al `prompt_id` del único `UserPromptSubmit` de la prueba, sin
otro registro de canal con ese `promptId`; un `Stop` con ese `prompt_id`. Las dos menciones del id
son ese registro y la respuesta del asistente. El `timestamp` del registro (+25 ms) es la creación
del mensaje, **no** la hora de escritura: con estos registros no se sabe si el registro ya estaba en
el archivo cuando corrió el hook (+53 ms). Debug en 0–75 s: sin retry, 429 ni 529; cinco líneas con
"permission", que no prueban diálogos.

#### 1.11.1 Experimento XA-1 (factibilidad local; **no autorizado**)

Una sola prueba T como §1.9, con el kit `poc/channels-phase0@508a57d`, que agrega
`transcript-probe.mjs` al mismo `UserPromptSubmit` del logger.

| Pregunta | Cómo se mide |
| --- | --- |
| ¿El registro ya está **en el archivo** cuando corre el hook? | La sonda hace **una** lectura de los últimos ≤ 1 MiB del transcript al ejecutarse, sin esperar ni reintentar. "Presente" = legible por otro proceso en ese instante (no prueba durabilidad: no hay `fsync` observable) |
| ¿Se relaciona sin ambigüedad con `prompt_id` y el id del mensaje? | Verificado sólo con **exactamente un** registro de prompt (no `tool_result`) con ese `promptId`, de canal, del servidor esperado, de la sesión, con `isMeta`, cuyo contenido es **byte a byte igual** al prompt que recibió el hook y es **un único** elemento `<channel>` con la forma exacta de 2.1.317 (apertura, salto, contenido, salto, cierre; nada fuera; sin etiqueta anidada; sin atributos repetidos — una clave `meta` llamada `source` lo sería — y `source` igual al servidor), con ese `message_id`, que no aparece en otro registro leído |
| ¿Cuántas veces falta o llega tarde? | `send.mjs` relee el archivo completo tras el turno (igualdad por el SHA-256 del prompt que guarda el logger): `present-at-hook` (verificado al hook **y** en la relectura completa), `late` (sin registro al hook, verificado después), `missing`, `invalid` (todo lo demás). **Una** muestra no mide una tasa: eso exigiría una serie (XA-2), con autorización aparte |
| ¿Es estrictamente observacional? | No imprime (lo impreso entraría al contexto), siempre sale con 0, no bloquea ni modifica el prompt; registra su propia duración (`read_ms`). Única interferencia: el tiempo de una lectura acotada |
| ¿Archivo ausente, incompleto, duplicado o ilegible? | Siempre `unverified` con motivo: ruta ausente, otro nombre, fuera de `projects`, symlink, no es archivo, ausente, ilegible, vacío, línea ilegible, línea final a medio escribir (**aunque el registro buscado esté**), sin registro, contenido distinto del prompt o comparación imposible, etiqueta mal formada, duplicado, otro origen/servidor/sesión, sin `isMeta`, otra etiqueta o `message_id`, id repetido en otro registro, registro fuera de la cola leída, mensaje que llegó como `queued_command` |

**Alcance de la unicidad:** la sonda lee como mucho el último MiB. Si la lectura no empezó en el byte 0,
el resultado es `verified-in-observed-bytes`, con unicidad **sólo en los bytes leídos** y
`unique_global` nulo; únicamente una lectura completa puede dar `verified` con unicidad global. En
XA-1 la unicidad global la aporta la relectura completa posterior, que es de otro momento: no es
una garantía al instante del hook.

Tests sintéticos del kit: 69 (42 de la alternativa A, entre ellos las regresiones de línea final
incompleta tras un registro válido, duplicado fuera de la cola leída, igualdad exacta y etiqueta
mal formada, y el retiro del kit anterior conservando los logs de T). La sonda nunca guarda texto,
rutas ni el prompt; `check` la autoprueba sobre un transcript sintético en un directorio temporal.

**Factibilidad positiva** sólo si en XA-1: una línea de sonda para el `prompt_id`, con `verified` o
`verified-in-observed-bytes` (se informa cuál), categoría `present-at-hook`, relectura completa
`verified` con unicidad global, logger y flujo como en T.
Cualquier otro resultado se informa tal cual y la alternativa A no avanza sin rediseño.

#### 1.11.2 Garantías que la prueba local **no** demuestra (requisitos para producción)

| Riesgo | Por qué importa | Protección necesaria (a verificar por versión) |
| --- | --- | --- |
| El agente escribe el transcript | El archivo es del mismo usuario que el agente; Bash/Write o un trabajo en segundo plano pueden agregar o reescribir líneas | Prohibir escritura en el directorio de transcripts a las herramientas del agente (managed `permissions.deny` para Edit/Write y `sandbox` de sistema de archivos para Bash y trabajos en segundo plano); verificado con un smoke por versión |
| Inserción de un registro falso | Un registro de canal falso junto a un prompt tecleado | La regla "exactamente un registro de prompt por `promptId`" lo vuelve `unverified` (denegación, no falso positivo) |
| Reescritura antes de la captura | Reemplazar el registro real en la ventana entre su escritura y el hook (~ decenas de ms) | La prohibición de escritura anterior; además, evidencia de manipulación: inode y tamaño por captura; un archivo que encoge o cambia de inode marca la sesión como evidencia comprometida |
| Manipulación después de la captura | Releer más tarde no prueba nada | La sonda captura **en el hook** y la copia viaja por el relay al backend (fuera del alcance del agente); nunca se relee el transcript para decidir |
| Formato interno sin documentar | `origin`, `promptSource`, `promptId` pueden cambiar; el CLI repara filas al cargar | Pin del CLI (R9) y lista de versiones validadas **propia** de este contrato; campos desconocidos ⇒ `unverified` |
| Escritura tardía o perdida | La cola de escritura es asincrónica; un error sólo se registra | Ausente al hook ⇒ `unverified`, nunca un éxito diferido |
| Reinicio, `--resume`, fork, compactación, rewind | El registro puede quedar en otro archivo o podarse | `unverified` hasta revalidar; la evidencia se captura en el momento |
| Privacidad | La sonda lee el contenido para comparar el id | Lee dentro del contenedor y no emite texto (mismo nivel 0 que la captura) |

Riesgo residual declarado: otro proceso del mismo usuario fuera del sandbox (un servidor MCP, otro
hook) podría escribir el archivo.

#### 1.11.3 Propuesta G3-A (para revisión separada; no aprobada, no sustituye a G3)

Una entrada de canal estaría **verificada por transcript** sólo si:
1. El `UserPromptSubmit` tiene `prompt_id` P y el prompt cumple la forma del protocolo §5
   (etiqueta con `st_msg`).
2. Al ejecutarse ese hook, la cola leída del transcript de la sesión contiene exactamente un registro
   de prompt con `promptId` P, `type=user`, `isMeta`, `origin.kind=channel`, `origin.server` igual a
   nuestro servidor, la misma sesión y el `st_msg` en su única etiqueta, y ese `st_msg` no aparece en
   otro registro.
3. La captura se hace en el hook y se conserva fuera del alcance del agente; nunca se relee después.
4. Las protecciones de §1.11.2 están activas y verificadas para la versión, que figura en una lista
   propia de este contrato.
5. Cualquier ausencia, demora, ambigüedad, reinicio, `--resume` o duda ⇒ `unverified`, sin pasar a
   verificada después.

Aceptarla sería una decisión explícita del responsable tras esa revisión; mientras tanto, G3 rige
tal como está.

### 1.12 Resultado de XA-1 y orden real hook → transcript (2.1.317)

**XA-1 (2026-11-03, Mac del responsable, CLI 2.1.317, kit `508a57d`): categoría `late`.** No es
factibilidad positiva según el criterio de §1.11.1 y no se reinterpreta como éxito.

| Medida | Valor |
| --- | --- |
| Flujo | `result=hook`; `UserPromptSubmit` +71 ms; `reply` +5,544 s; `Stop` +6,746 s; sin prompts ni `Stop` ajenos |
| `source` en el hook | ausente (G3 sigue sin cumplirse) |
| Sonda al hook | una línea; `unverified`, motivo `no-prompt-record`; lectura desde el byte 0, sin línea final incompleta, 1 ms; 0 registros con ese `promptId` |
| Relectura completa (+7,534 s) | `verified`, unicidad global; `origin.kind=channel`, servidor esperado, `isMeta`, `promptSource=system`, misma sesión, contenido igual al prompt, etiqueta válida |

#### 1.12.1 Orden de ejecución en el binario (inspección estática)

Artefacto: `@anthropic-ai/claude-code-darwin-arm64@2.1.317` (npm `shasum` `bea435eb…`), código
minificado leído de las cadenas del binario. Los nombres de función son los minificados de esa
versión y cambian entre versiones.

**Hechos comprobados en el código:**

1. **Recepción.** El handler de `notifications/claude/channel` (registrado sólo si la puerta de
   canales devuelve `register`) arma el texto con `_Bt(server, content, meta)` (el elemento
   `<channel source="…">`) y hace `enqueue({mode:"prompt", value, priority:"next", isMeta:true,
   origin:{kind:"channel", server}, skipSlashCommands:true, skipAttachments:true})`. No escribe nada
   en el transcript.
2. **Desencolado.** El turno recorre los comandos desencolados y, para cada uno, hace
   `await GNt(...)` → `Hn(...)` (`processUserInput`), con `promptSource="system"` por `isMeta`. Los
   mensajes que devuelve se acumulan en un lote local `$o`.
3. **Creación del mensaje.** Dentro de `Hn`, `yr(...)` crea el mensaje de usuario en memoria
   (`De({content, uuid, isMeta, promptSource, promptId, origin})`). De ahí sale el `timestamp` que X1
   vio en +25 ms.
4. **Hook.** Todavía dentro de `Hn` (marcas `query_hooks_start` / `input_hooks`), la cadena
   `prompt.submit` ejecuta como núcleo los hooks clásicos (`P1r` → `Bkt`), que arman el payload
   `{…base, hook_event_name:"UserPromptSubmit", prompt, ...!1, session_title}` y esperan a los hooks.
   `Hn` devuelve sólo después.
5. **Agregado a la conversación.** Recién al terminar el bucle (`query_process_user_input_end`) el
   turno llama `run($o, …)`. Durante el lote, `applyMessageOp` está envuelto para **acumular** los
   `append` en vez de publicarlos (`aQo`, hasta `isBatchHandedOff`).
6. **Escritura del transcript.** En el modo interactivo, la escribe `kDe.write`, invocado por un
   efecto de React sobre la lista de mensajes (`CDe`: `useEffect(() => recorder.record(messages, …))`)
   → `VT` → `insertMessageChain` → `trackWrite` → `appendEntry`. `promptId` se toma de `eN()` al
   escribir.
7. **Modelo.** La consulta al modelo sale de `run(...)` (paso 5), después de los hooks.

**Conclusión (hecho, no hipótesis):** el hook corre **estructuralmente antes** de que el mensaje
llegue siquiera a la lista que el grabador del transcript observa. No hay carrera: en 2.1.317, en este
camino, el registro **no puede** estar en el archivo cuando corre `UserPromptSubmit`. XA-1 `late`
es el resultado esperado por construcción, no una muestra desafortunada; repetirla no cambiaría la
categoría. La variante "al hook" de la alternativa A (§1.11, G3-A punto 2) no es viable en 2.1.317.

**Hecho adicional sobre `source`:** el llamador calcula el origen y lo pasa al constructor del
payload. `ue(promptSource, wakeupSource)` devuelve `"system"` para el canal y llega a
`Bkt(text, mode, ctx, source, tiers)` como cuarto argumento, pero el payload no lo usa: en su lugar
hay `...!1`, que es la forma que deja una función desactivada en la compilación. Es compatible con
anthropics/claude-code#94675.

**Hipótesis (no comprobadas):** que la corrección de #94675 consista en activar esa rama; que el orden
sea el mismo en `-p`/SDK (no se leyó ese camino); que otras versiones mantengan el orden (validar por
versión).

#### 1.12.2 Alternativas evaluadas (sin implementar)

En todas, la evidencia que sale del contenedor viaja por los hooks y el relay de loopback (§2.6 de
CONVERSATION.md). Cualquier proceso del contenedor puede enviar a ese relay, así que la captura
actual ya confía en el contenido del contenedor frente a un agente con Bash. Ninguna alternativa que
pase por ahí es más fuerte que ese límite.

| | Alternativa | Quién garantiza el origen | ¿Un prompt tecleado o pegado lo falsifica? | ¿Un agente con Bash/Write altera la evidencia? | Correlación | Concurrencia, `--resume`, fallos | ¿Cambia tmux? | Dependencias |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A′ | Transcript leído **al hook** | El CLI, al escribir | No | Sí, si escribe el archivo | `promptId` = `prompt_id` | — | No | **Inviable en 2.1.317**: el registro todavía no existe (§1.12.1) |
| A″ | Transcript leído **después** | El CLI, pero leído tarde | No | Sí: hay ventana entre la escritura y la lectura | Igual | Escritura asincrónica; reparación al cargar | No | **Rechazada por el responsable**: retraso, polling o relectura que da por verificado |
| B | Módulo de hooks de plugin, evento `prompt.submit` | El CLI: `origin` sale del comando encolado (`RQs` → `wue`: canal ⇒ `{kind:"channel", server}`; tecleado ⇒ `{kind:"composer"}`), no del texto | No: el texto no cambia `origin` | El módulo se carga desde disco; si el agente puede escribirlo, puede reemplazarlo. Necesita una ubicación sólo lectura o administrada (por verificar). La salida pasa por el relay | El input lleva `text`, `origin`, `isMeta` y `turnId?`, **sin** `prompt_id`. Se correlaciona porque corre en el mismo instante que el hook clásico (lo envuelve: `next()`) y con igualdad de texto | Mismo proceso y momento que el hook; `--resume` no cambia el origen de un comando nuevo | No | **API de acceso anticipado.** Se activa por un flag remoto (`tengu_plugin_hooks_modules`, GrowthBook). Se apaga con `disableAllHooks`, `allowManagedHooksOnly` o política. Formato no documentado como estable |
| C | Esperar #94675 (`source` en el hook) | El CLI, en el payload del hook | No | Igual que cualquier hook (límite del relay) | `prompt_id` nativo | Igual que hoy | No | Fecha desconocida. Detectable por inspección estática: desaparece `...!1` en `Bkt` |
| D | Protocolo de confirmación: nuestro servidor de canal o el backend registra `(nonce secreto, sha256(contenido))` **antes** de enviar; el hook informa `prompt_id` y el SHA-256 del prompt; el backend acepta una sola aparición | Nuestro backend, sobre **lo que envió** (autor y contenido), no sobre el camino de entrega | Uno tecleado con otro texto no coincide. Copiar el texto exacto exige conocer el nonce antes de la entrega; si llega después, es una segunda aparición: ambas quedan `unverified`, sin falso positivo | Si el servidor de canal corre en el contenedor, un proceso del mismo usuario podría leer el nonce al vuelo (riesgo residual). Un servidor remoto lo reduce, pero exige transporte HTTP de canales (no evaluado) | `nonce` ↔ `prompt_id` ↔ `Stop`/respuesta | El nonce es de un solo uso y tiene vencimiento; la regla se mantiene ante reinicios | No | Ninguna interna del CLI. **No da procedencia del camino**: atribuye contenido, que es lo que §1.10 ya descartó como sustituto de G3 |
| E | Relay propio del servidor Channels (evidencia independiente) | Nuestro servidor: qué envió y cuándo | — | Igual que D si es local | La notificación MCP es unidireccional, sin acuse | — | No | Sólo prueba envío; es una pieza de D |
| F | Arquitectura distinta: el composer actual (3.2, pegado en tmux con acuse por `textHash` en el panel) o headless stream-json | El backend envía; acuse por `user_prompt` humano en el mismo panel (3.2) | La regla de 3.2 ya es fail-closed | El mismo límite del relay | `clientMessageId` ↔ `user_prompt` | Ya resuelto en el contrato v1.7.x | 3.2 no; headless sí (rompe R1) | Sin Channels |

#### 1.12.3 Recomendación

1. **Cerrar la variante "al hook" de la alternativa A en 2.1.317.** Es inviable por construcción y la
   relectura posterior está descartada. G3-A queda como estaba: no aprobada y, en su punto 2,
   inaplicable a esta versión.
2. **En 2.1.317, Channels no da atribución del *camino* verificable con interfaces estables.**
   - Con interfaz estable sólo daría C, que todavía no existe.
   - Con interfaz de acceso anticipado daría B, que depende de un flag remoto.
   - D atribuye contenido, no camino.
3. **Para decidir:**
   - Si el Monitor necesita procedencia del camino **ya**: buscar otro mecanismo. El composer 3.2
     preserva la arquitectura, usa la suscripción y ya tiene su contrato. Channels queda en espera
     de C.
   - Si basta atribuir el contenido a un emisor autenticado por el backend: D (con E) es diseñable
     sin depender del CLI. Sería una garantía **distinta** de G3, que requeriría su propia revisión.
4. **Seguimiento barato de C:** comprobar en el binario de cada versión nueva si `Bkt` deja de tener
   `...!1` y emite `source`, antes de cualquier prueba T.

#### 1.12.4 Experimento mínimo siguiente (propuesto, **no ejecutado ni autorizado**)

**XB-0: ¿está disponible B para esta cuenta?** Sólo lectura, sin ejecutar Claude.
- Leer **un único valor** booleano de la caché de flags del CLI, sin imprimir nada más del archivo:
  `jq '.cachedGrowthBookFeatures.tengu_plugin_hooks_modules // "absent"' ~/.claude.json`.
- Si da `false` o `absent`, B no está disponible y la decisión se reduce a C, D o F.
- Si da `true`, se diseña **XB-1**: un módulo `prompt.submit` sólo observacional, que registra
  `origin.kind`, `origin.server`, `isMeta` y el SHA-256 del texto, en el mismo kit, con una sola
  prueba T y con autorización aparte.

### 1.13 Alternativa B: mods con `prompt.submit` (XB-1 ejecutado una vez: **PASS-A**, §1.13.5)

**No cambia G3, R8 ni G1–G12; G3-A sigue sin aprobarse.** XB-0 (2026-11-03, Mac del responsable,
2.1.317) leyó `tengu_plugin_hooks_modules = true` en la caché de flags. Eso **no** prueba que un mod
cargue ni que funcione: sólo que el interruptor remoto estaba encendido cuando se guardó la caché.

Fuentes:
- (B) el binario `darwin-arm64@2.1.317`;
- (D) la documentación oficial de *mods*: `code.claude.com/docs/en/plugins/mods/{reference,events}`;
- (T) las declaraciones públicas `mods/types/claude-code.d.ts`, escritas por 2.1.277.

#### 1.13.1 Viabilidad: carga y requisitos

| Pregunta | Respuesta | Fuente |
| --- | --- | --- |
| Cómo se registra | Un plugin con `hooks/hooks.json` `{"modules": ["./register.mjs"]}` que exporta `register(on)`; `on(evento, [filtro], async ($, e, next) => next(e))`. Es *middleware*: `next(e)` corre los mods siguientes y al final el comportamiento del CLI. `claude plugin validate` lee del código fuente los eventos y las llamadas (el nuestro: 5 eventos y `$.fs.write`) | D, B, validado aquí con 2.1.314 |
| Dónde corre | En un `Worker` del mismo proceso del CLI ("plugin sandbox"). Las llamadas `$.*` las ejecuta el proceso del CLI | B |
| Cómo se carga sin instalar nada | `claude --plugin-dir <carpeta>`: plugin sólo para esa sesión, sin tocar configuración. **Recarga el módulo al guardar** un archivo de la carpeta | D |
| Interruptor | `tengu_plugin_hooks_modules` (GrowthBook). Si está apagado, los mods instalados no cargan y los integrados sí | B |
| Suscripción | No exige API key. Los únicos bloqueos que nombra el código son: el interruptor, un *tenant* de `claude-code-server`, un *daemon* de servidor de herramientas, `--bare` (sólo carga lo administrado) y el modo seguro | B (no hay una prueba de carga en el Mac) |
| Restricciones | `disableAllHooks` (en managed settings apaga todo); `allowManagedHooksOnly` y `allowManagedModsOnly` (sólo mods de la organización); `disableSideloadFlags` (rechaza `--plugin-dir`); confianza del workspace pendiente ⇒ no carga | D, B |
| **Guard integrado** `sec-default@builtin` | Se carga si la máquina tiene managed settings o si la sesión entró con un `/login` Team o Enterprise. Con el guard cargado, **los `classic.*` de un mod que instaló el usuario no corren** | D |
| Docker/tmux | Nada en el código depende de la terminal: el mod corre dentro del proceso del CLI que está en el panel. Pero nuestras sesiones **sí** tienen managed settings (`/etc/claude-code/managed-settings.d/`), así que el guard carga: el mod tendría que ser **de la organización**, no del usuario (§1.13.3) | B, D |
| Estado del producto | Documentado oficialmente, pero activado por un interruptor remoto. Desde 2.1.277 la API cambia de versión en versión (las tablas indican el mínimo de cada campo) | D, T |

#### 1.13.2 Qué entrega `prompt.submit` y cómo se correlaciona

| Campo | `prompt.submit` | Fuente |
| --- | --- | --- |
| `origin.kind` | **Sí.** Es un conjunto cerrado: `composer` (Enter del usuario, tecleado o en cola), `channel` + `server`, `sdk`, `bridge`, `peer`, `task-notification`, … En el código: lo arma `RQs`/`wue` desde el `origin` del comando encolado; el handler de `notifications/claude/channel` encola `{kind:"channel", server}` y el Enter encola `{kind:"human"}`, que se mapea a `composer` | T, B |
| `origin.server` | **Sí**, sólo cuando `kind = channel` | T, B |
| `isMeta` | En 2.1.317 el CLI lo pasa cuando la entrega es `isMeta` (`...e.isMeta===!0&&{isMeta}`), pero **no** está en el tipo público. No se usa como criterio | B (T no lo declara) |
| Texto | `text`: el prompt tal como llegará al modelo | T |
| Turno | `turnId` sólo cuando el prompt entra en un turno que está corriendo; **ausente** si la sesión estaba ociosa (el caso del canal en T) | T, B |
| Sesión | No viene en el evento. Existe `$.session.id()`, y `classic.UserPromptSubmit` trae `session_id` | T |
| `prompt_id` | **No viene** | T, B |

**Integridad del origen dentro del CLI (hecho).** El CLI rechaza la respuesta de un mod que pone
otro origen; el mensaje del binario es "an origin the engine did not set (a hook may leave the
origin out of its answer, or answer it as received; it may not set one)". El tipo público lo
documenta como "a closed set, never a text prefix… no hook may set one".

**Correlación sin tiempos ni texto.** Los hooks de settings corren como **núcleo** de la cadena de
`prompt.submit`. El camino en el código es `core: {"prompt.submit": …}` → `P1r` → `Bkt` → `gI`, y
`gI`, si un mod escucha `classic.UserPromptSubmit`, despacha el payload clásico (con `prompt_id` y
`session_id`) a la cadena de mods (`RFr` → `x8n`). Por lo tanto, ese `classic.UserPromptSubmit`
ocurre **dentro** del `await next(e)` de nuestro `prompt.submit`. El mod liga los dos así:

1. Al entrar a `prompt.submit` registra el envío como "en vuelo". Si ya había otro, ambos quedan
   marcados con solape.
2. Un `classic.UserPromptSubmit` se adjunta **sólo** si hay exactamente un envío en vuelo.
3. Al volver `next`, el envío queda ligado a `prompt_id` P si se cumplen todas estas condiciones:
   - no hubo solape;
   - hubo **exactamente una** llamada clásica. Dos o más (por ejemplo, una pasada gestionada más
     el resto, o un mod que llama `next` dos veces) dejan el envío sin atribuir, aunque traigan el
     mismo P;
   - trae P y la sesión;
   - el `prompt` clásico es **igual** al `text`. Esta igualdad es una comprobación de
     consistencia, no la clave.

Cualquier otro caso deja el envío sin ligar (fail-closed). A partir de P, todo se une por el id
nativo:
- `classic.Stop` (P) y el `Stop` del logger (P);
- el `PostToolUse` de `reply` (P);
- en el canal, el `message_id` que trae la etiqueta del prompt de P.

`session.append` (puerta `prompt`) aporta además el `uuid` del registro del transcript y su
`origin`, ambos fijados por el CLI. Sirve para auditar, no es criterio.

**Hipótesis que XB-1 verifica:**
- que el anidamiento se observa así en ejecución;
- que hay una sola instancia del módulo por proceso;
- que la entrega del canal corre `prompt.submit` con `origin = channel` y la etiqueta pegada con
  `origin = composer`.

#### 1.13.3 Seguridad del Monitor

**A. Procedencia dentro del CLI.**
- **Hechos.** El `origin` sale del comando interno y no del texto:
  - el canal lo encola el handler MCP, sólo para servidores que pasaron la puerta de canales;
  - el Enter encola `human` ⇒ `composer`;
  - ningún mod puede cambiarlo.
- **Consecuencia.** Pegar `<channel source=…>` produce `composer`.
- **A verificar en XB-1:** que en la práctica el texto pegado no cambia nada.

**B. Integridad hasta el backend.** Hoy cualquier proceso del contenedor puede enviar eventos al
relay por TCP de loopback, así que **nada** que pase por ahí es evidencia frente a un agente con
Bash. Diseño propuesto (no implementado; requiere su propio experimento en un contenedor):

| Riesgo | Protección | Estado |
| --- | --- | --- |
| El agente cambia el módulo | Mod **de la organización**, configurado en nuestros managed settings de solo lectura:<br>• `extraKnownMarketplaces` apuntando a un directorio local de solo lectura;<br>• `enabledPlugins` + `prependPlugins`;<br>• `pluginDigests`, el SHA-256 de cada archivo de la carpeta: "any other copy does not load".<br>A eso se suma la carpeta montada de solo lectura | D/B; sin probar |
| El agente agrega su propio mod, o usa `--plugin-dir` / `CLAUDE_CODE_PLUGIN_DIRS` | `allowManagedModsOnly` (opción del guard integrado) + `disableSideloadFlags` | D; falta verificar que también cubra `CLAUDE_CODE_PLUGIN_DIRS` |
| Otro proceso falsifica la evidencia | Canal propio: `$.http.fetch` con `socketPath`, un socket Unix del relay. Si el `fetch` lo hace el proceso del CLI, el relay puede exigir `SO_PEERCRED` igual al pid del Claude del panel (misma regla de identidad que el composer: ejecutable, `starttime`, primer plano). Bash, MCP y hooks son otros pids ⇒ rechazados. La veredicción usaría **sólo** este canal; los hooks por TCP quedarían como informativos | **Hipótesis.** Indicios: en 2.1.317 el código acepta `socketPath`: `gFn` exige ruta absoluta y sin NUL, y rechaza la llamada si la build no tiene transporte Unix; luego lo pasa al `fetch` de Bun como `unix:`. El tipo público (2.1.277) documenta `socketPath` como "a Unix socket to go over instead of TCP". **No se ejecutó nunca.** Tampoco se observó el pid real de la conexión ni el comportamiento con el guard o con la política de red de plugins. No es un componente viable hasta una prueba propia. Auditoría y diseño en §1.14: `SO_PEERCRED` solo **no** basta |
| Inyección en el proceso del CLI (ptrace, `/proc/<pid>/mem`) | Yama `ptrace_scope` ≥ 1, con el que un hijo no puede adjuntarse al padre. Comprobarlo como precondición del contenedor | Hipótesis |
| Binario del CLI reemplazado en HOME | Verificar el hash de `/proc/<pid>/exe` contra el CLI fijado en la imagen (R9) | Hipótesis |
| Pérdida o duplicado | `inst` aleatorio por carga + `seq` contiguo. Un hueco o una repetición deja `unverified` lo que esté afectado. Una recarga del módulo (nueva `inst`) deja `unverified` lo que estaba en vuelo | Diseño; probado en tests |
| Concurrencia | Solape ⇒ sin ligar ⇒ `unverified` | Diseño; probado en tests |
| `--resume` y reinicios | La evidencia se toma al enviar; `session.start` no se repite en `/resume` y el `prompt_id` es nuevo por prompt. Lo histórico sin evidencia previa queda `unverified` | Doc + diseño |
| El interruptor se apaga | No hay mod ⇒ no hay evidencia ⇒ todo `unverified`. El composer 3.2 sigue operativo | B |
| Cambio de API | Lista propia de versiones validadas (como `COMPOSER_CLI_VERSIONS`). Un campo desconocido ⇒ `unverified` | Diseño |
| Costo arquitectónico | Las sesiones tmux no cambian. Cambian los managed settings y un montaje de solo lectura, así que se necesita **recrear** el contenedor (§2.4.1 de CONVERSATION.md) | — |

#### 1.13.4 Diseño de XB-1 (kit `poc/channels-phase0@a04f0c0`; ejecutado el 2026-11-03, resultado en §1.13.5)

**Objetivo.** Una sola ejecución en el Mac compara un mensaje real de Channels contra un prompt
tecleado y contra una etiqueta `<channel>` pegada. Comprueba que los orígenes difieren y que la
evidencia se correlaciona por `prompt_id`.

**Dos criterios separados:**

| Criterio | Qué prueba | Cómo se evalúa |
| --- | --- | --- |
| **PASS-A** | Procedencia y correlación **dentro del CLI** | XB-1, el único que XB-1 puede dar. El informe lo declara en `scope` |
| **PASS-B** | Integridad de la evidencia **hasta el backend**: mod de la organización con digests, canal autenticado (hipótesis `socketPath` + `SO_PEERCRED`), pérdida y duplicados | Experimento futuro, aparte, en un contenedor. **No** existe todavía y XB-1 no lo aproxima |

Un PASS-A **no** autoriza a usar la evidencia en el Monitor.

**Contrato de eventos esperado** (un archivo JSON por registro en `.poc0/out/mod/`, sin texto):

| Registro | Campos |
| --- | --- |
| `session.start` | `inst`, `seq`, `t`: prueba que el mod cargó |
| `classic.UserPromptSubmit` | `prompt_id`, `session_id`, `prompt_len`, `inflight`, `attached` |
| `prompt.submit` | `origin_kind`, `origin_server`, `is_meta`, `turn_id_present`, `text_len`, `outcome` (`entered`/`drop`/`threw`), `overlap`, `classic_count`, `classic_prompt_ids`, `classic_session_ids`, `classic_text_equal_all`, `bound_prompt_id`, `bound_session_id` |
| `classic.Stop` | `prompt_id`, `session_id` |
| `session.append` (puerta `prompt`) | `uuid`, `origin_kind`, `origin_server`, `is_meta` |

**Instrumentación.**
- Mod `st-provenance-probe`: cinco handlers. Cada uno llama `next(e)` una vez con el mismo evento
  y devuelve o relanza lo que dio `next`.
- Nada antes de `next` puede lanzar. Una escritura que falla sólo deja un hueco de `seq`.
- Las escrituras van **fuera** de la carpeta del plugin para no provocar una recarga.
- El logger de XA-1 sigue igual. La sonda del transcript **no** se instala; `--with-probe` la
  repone.

**Tests sintéticos.** Son 85 y todos pasan en Node 22. De ellos, 14 son de XB-1; el de casos
negativos del analizador cubre 31 variantes, 12 de ellas agregadas tras la revisión del
responsable (`1ed7e73`):
- un segundo `Stop` del logger o del mod;
- dos `classic` en un envío;
- los controles con el mismo `prompt_id`;
- siete variantes de respuesta: no exacta, otro destinatario en Fakechat, sin `PostToolUse`, con
  otro P, dos `reply`, `reply` fallido y otro destinatario en el logger.
- Binder: canal nominal; tecleado; etiqueta pegada ⇒ `composer`; dos envíos en vuelo ⇒ ninguno
  ligado; `classic` sin envío; dos pasadas clásicas con el mismo id (liga) y con ids distintos (no
  liga); texto reescrito más abajo de la cadena; sin `classic` (guard); `next` que lanza (mismo
  error) y `drop`; escritura fallida sin efecto en el flujo; evento malformado;
  `session.append`/`Stop`.
- Analizador: PASS y los 19 casos negativos de `68a939c` (mod no cargado, guard, control con origen `channel`,
  servidor distinto, solape, sin ligar, ligado dos veces, hueco de `seq`, dos instancias, `Stop`
  ausente, UPS duplicado, sesión distinta, sin respuesta, control no ejecutado, sin controles, hook
  saltado en el debug log, registro ilegible, etiqueta pegada que no llegó como etiqueta).
- `manage`: retira XA-1 byte por byte conservando `out/`; `check` detecta una copia alterada del
  mod.

**Procedimiento** (comandos completos al autorizar):
1. Respaldo verificado de `.poc0` (como en XA-1).
2. Kit por SHA con hashes.
3. `uninstall` de XA-1 y `install` de XB-1.
4. `claude plugin validate .poc0/mod`.
5. Lanzar `claude --channels plugin:fakechat@claude-plugins-official --plugin-dir .poc0/mod
   --debug-file .poc0/out/claude-debug.log`.
6. Confirmar la carga con `/plugin` ("1 mod active · st-provenance-probe") y el registro
   `session.start`. Si el debug log menciona `cc-plugin-sec-default`, detenerse: el guard
   invalidaría la prueba.
7. `send.mjs --label B --count 1`.
8. Tras el `Stop`, `xb.mjs controls` y el responsable ingresa el control 1 (tecleado) y luego el
   control 2 (etiqueta pegada).
9. `xb.mjs report`.
10. `/exit`, `uninstall` y relanzar normal.

**PASS-A** sólo si se cumple todo esto:
- el mod cargó: hay `session.start`, una sola `inst`, `seq` contiguo, ningún archivo ilegible y
  ningún hook del mod saltado en el debug log;
- canal: un UPS del logger con su id ⇒ P, y un solo UPS con P; exactamente un envío ligado a P y
  ningún otro que lo mencione; ese envío tiene `origin = channel`, servidor
  `plugin:fakechat:fakechat`, sin solape, **una** llamada clásica, texto igual, misma sesión y
  `entered`;
- **exactamente un** `Stop` del logger y **exactamente uno** del mod con P (R8 sin cambios). Lo
  mismo se exige para cada control;
- respuesta: el `fakechat_reply` con texto **exacto** `OK_<id>` y dirigido a ese mensaje, y
  **exactamente un** intento de `reply` con P en el logger, contando `PostToolUse` y
  `PostToolUseFailure`, y ese intento exitoso y con ese destinatario. Un fallo seguido de un
  reintento exitoso es FAIL. La igualdad con `OK_<id>` es byte a byte, sin `trim()`: Fakechat
  retransmite el argumento `text` sin cambios (`a04f0c0`);
- control tecleado y control pegado: cada uno ligado a su propio P′, con `origin = composer` y sin
  servidor; la etiqueta pegada llegó como etiqueta según el logger;
- en toda la corrida, exactamente un envío con `origin = channel`;
- los tres P son distintos **entre sí**: canal y controles, y también los dos controles.

**FAIL:** cualquier otro valor de los anteriores, entre ellos un segundo `Stop`, un segundo
`classic.UserPromptSubmit` en un envío, `prompt_id` repetidos o una respuesta no exacta o mal
correlacionada.

**INCONCLUSIVE** (se informa tal cual; no se repite sin decisión):
- el mod no cargó;
- los `classic.*` no llegaron (guard);
- falta un control;
- la etiqueta pegada no llegó como etiqueta.

**Riesgos de instalación y restauración:**
- `--plugin-dir` vale sólo para esa sesión y no deja configuración. El logger se retira como en
  XA-1, restaurando byte por byte.
- La recarga al guardar exige no tocar `.poc0/mod` durante la prueba.
- Un mod que falla lo salta el CLI y el prompt sigue (lo dice D); queda registrado como fallo.
- Si el guard o un managed setting existiera en el Mac, la prueba daría INCONCLUSIVE sin efectos.
- Los controles hacen que el modelo responda dos textos breves sin usar herramientas.

**Cambios respecto del kit XA-1 (`508a57d`):**
- Nuevos: `mod/` (4 archivos), `xb.mjs`, `test/xb.test.mjs`.
- `manage.mjs`: copia y verifica el mod, y la sonda pasa a ser opcional.
- `send.mjs`: acepta `--label B` como prueba individual y sólo agrega `transcript_a` si hay sonda.
- El logger, `events`, `classify`, `report` y el matcher de A no cambian.

#### 1.13.5 Resultado de XB-1 (2026-11-03, Mac del responsable, 2.1.317, kit `a04f0c0`)

**PASS-A** (`xb.mjs report`: `salida=0`, `reasons=[]`). Fue una sola ejecución: un mensaje de
Channels y dos controles humanos, con restauración posterior. Evaluó **sólo** la procedencia y la
correlación dentro del CLI.

| Aspecto | Observado |
| --- | --- |
| Mod | 13 registros, una `inst`, `seq` contiguo, ningún duplicado, ningún error |
| Envíos | 3 `prompt.submit`, sin solape |
| Canal | `origin.kind = channel`, servidor `plugin:fakechat:fakechat`, ligado a P1; un `UserPromptSubmit`; un `Stop` del logger y uno del mod; un único `reply`, exitoso, con texto y destinatario exactos |
| Control tecleado | `origin.kind = composer`, ligado a P2 |
| Control con `<channel>` falsificado y pegado | `origin.kind = composer`, ligado a P3 |
| Identificadores | P1, P2 y P3 distintos; correlación única en los tres |
| Guard `cc-plugin-sec-default` | Aparece en el debug log como `not seated`: no estaba activo |
| `source` del hook clásico | Sigue **ausente** |

**Desvío del procedimiento.** La comprobación previa del paso 5 pedía **cero** menciones de
`cc-plugin-sec-default` en el debug log, y hubo una (`not seated`). El responsable la evaluó como
"guard no cargado". Los `classic.*` llegaron al mod, que es la prueba directa de que el guard no los
bloqueó. No cambia el criterio, pero queda anotado. En un PASS-B0/B1 la comprobación debe buscar el
estado (`seated` / `not seated`) y no sólo el nombre.

**Qué no significa:**
- **No** es PASS-B ni habilita el Monitor.
- **No** cambia G3, R8 ni G1–G12. G3 sigue sin cumplirse porque `source` está ausente. G3-A sigue
  sin aprobarse.
- Es una muestra, no una serie. Las series de fiabilidad no están autorizadas.

### 1.14 PASS-B: integridad de la evidencia hasta el backend (PASS-B0: **PASS**, §1.14.13; B1–B3 no autorizados)

**No cambia G3, R8 ni G1–G12; G3-A sigue sin aprobarse; PASS-A no reemplaza a G3.** Si PASS-B
llegara a pasar, daría una garantía **distinta** de la letra de G3 (`source=system` en el hook).
Usarla en su lugar exigiría una decisión explícita del responsable, como la que G3-A todavía no tiene.

Fuentes de esta sección:
- (B) cadenas del binario `darwin-arm64@2.1.317` y de `2.1.314`, el CLI de nuestra imagen. Las rutas
  citadas están en los dos;
- (K) semántica documentada del kernel Linux;
- (R) código de este repositorio;
- (O) observado en este contenedor de desarrollo (kernel `6.8.0-147`).

Todo lo que no tiene una prueba propia está marcado **hipótesis**.

#### 1.14.1 Qué tiene que afirmar PASS-B, y qué nunca va a afirmar

**Afirmación verificada** para un mensaje M de Project Chat:

> El proceso del CLI del contenedor C, con binario permitido y sin inyección observable, informó
> por un canal autenticado que su prompt P de la sesión S entró con `origin = channel` desde el
> servidor administrado X. Además, el cuerpo de P es exactamente M, que el backend emitió por ese
> canal y que apareció una sola vez.

Hacen falta **dos mitades**, y ninguna alcanza sola:
- **Camino.** La evidencia del CLI dice por dónde entró el prompt. PASS-A lo demostró dentro del CLI.
- **Contenido.** La atribución del backend dice quién lo escribió: es la alternativa D de §1.12.2.

La razón está en el hallazgo A4 de §1.14.3: un proceso del agente podría hacer que el CLI asigne
`origin = channel` **legítimo** a un texto que escribió el agente.

**Nunca afirma:**
- que un prompt `composer` lo tecleó una persona. El agente puede escribir en la terminal con
  `tmux send-keys` o en el pty, que son del mismo usuario; `composer` significa "entrada de
  terminal";
- que el modelo procesó bien el mensaje (eso es R8 y E9);
- disponibilidad. El agente siempre puede matar el CLI, el servidor de canal o el gateway; lo único
  que se garantiza es que eso **no** produce `verified`;
- nada sobre versiones del CLI que no estén en la lista validada.

#### 1.14.2 Modelo de amenazas

| | Alcance |
| --- | --- |
| **Adversario A1: el agente** | Código arbitrario como `developer` (uid 1000) dentro del contenedor de la sesión, por cualquier vía: Bash, procesos en segundo plano, servidores MCP o hooks que configure, archivos que escriba (workspace, HOME, `/tmp`, settings de usuario y de proyecto, `~/.claude.json` con la caché de flags). Además puede: controlar tmux, porque el servidor es del mismo uid (`send-keys`, `respawn-pane`, `new-window`); mandar señales y aplicar `prlimit` a procesos de su uid; leer en `/proc` de su uid lo que pide modo READ (`environ`, `cmdline`, `maps`, enlaces de `fd`); abrir conexiones de red |
| **Lo que A1 no puede** (supuestos verificables) | Ser root ni tener capacidades: `CapDrop: ALL` y `no-new-privileges` (R: `dockerManager.ts`), `USER developer` (R: `session-image/Dockerfile`). Adjuntarse con ptrace a procesos que no desciendan de él: Yama `ptrace_scope = 1` (O: vale 1 en este contenedor; es del kernel del host, así que en VM100 es **precondición** a comprobar). Escribir en montajes de solo lectura |
| **Adversario A2: el agente de otra sesión** | Lo mismo, en otro contenedor. Sólo comparte la red `sessions-net` (#291) y el kernel |
| **Confiables** | Kernel y Docker del host, root del host, backend, el gateway de §1.14.4, el binario publicado del CLI (por hash, R9), el código de nuestro mod y de nuestro servidor de canal (de solo lectura) y el responsable |
| **Fuera de alcance** | Escape del contenedor o exploits del kernel, host comprometido, el backend de Anthropic, el comportamiento del modelo y la denegación de servicio |

#### 1.14.3 Auditoría de las garantías

| # | Pregunta | Hallazgo | Fuente | Estado |
| --- | --- | --- | --- | --- |
| A1 | ¿Qué pid ve el servidor cuando el mod llama `$.http.fetch`? | `$.http.fetch` es una operación del anfitrión del CLI: el `Worker` del mod la pide y el proceso del CLI la ejecuta (`iWr`). Esa función llama al `fetch` global de Bun con `{unix: socketPath}` (`zit`) y le quita el proxy. No aparece ningún proceso intermediario. Un `Worker` es un hilo del mismo proceso, y `SO_PEERCRED` da el tgid, así que **se espera el pid del proceso principal del CLI** | B, K | Estático. **B0 lo observa** |
| A1′ | ¿Basta ese pid? | **No.** El mismo pid es también el de todos los demás clientes del CLI: cualquier otro mod, el cliente MCP por HTTP, los hooks HTTP, el proxy MITM del sandbox (`network.mitmProxy.socketPath`, que va por socket Unix) y WebFetch. El propio CLI lo dice de su `verifiedPeerPid`: "identifies the CONNECTING process, which for relayed traffic … is the relay". `SO_PEERCRED` sólo dice que **conectó el CLI**, no que conectó **nuestro mod** | B | Hecho estático ⇒ hace falta la clave por instancia de §1.14.4 |
| A2 | ¿Cómo se traducen los pid entre namespaces? | El kernel traduce el pid de `SO_PEERCRED` al namespace de **quien lo lee**; si el lector no ve al proceso, obtiene 0. Un lector en el namespace del host recibe el pid del host y lo lleva al del contenedor con `NSpid` de `/proc/<pid>/status`. El contenedor se identifica por `/proc/<pid>/cgroup`. El backend corre en un contenedor de compose **sin** `pid: host` (R: `docker-compose.yml`), así que no puede ser el lector tal como está. `SO_PEERPIDFD` (Linux ≥ 6.5; el host tiene 6.8) fija el proceso y evita la reutilización de pid | K, R, O | Hipótesis. **B0 lo observa** |
| A3 | ¿Otro proceso del mismo usuario puede conectarse o reutilizar la conexión? | **Conectarse, sí.** Para conectar a un socket hace falta permiso de escritura sobre el archivo, y un montaje de solo lectura no lo impide (la comprobación EROFS no se aplica a sockets); obtiene su **propio** pid. **Reutilizar la conexión del CLI:** un socket no se puede reabrir por `/proc/<pid>/fd` (ENXIO); `pidfd_getfd` exige permiso de adjuntarse (Yama). Queda la herencia a hijos si el fd no es `O_CLOEXEC` | K | Hipótesis. B0 mira las banderas en `/proc/<cli>/fdinfo` |
| A4 | ¿Bash, MCP, hooks o procesos en segundo plano pueden inyectar evidencia? | **Directamente, no**: son otros pid y se rechazan. **Indirectamente, sí, por dos vías:** | K, B | |
| | | (a) **Diputado confundido.** Los settings de usuario son escribibles por el agente; con ellos puede apuntar al socket un servidor MCP HTTP, un hook HTTP o el proxy MITM del sandbox, y conecta el pid del CLI. Mitigación: settings administrados que sólo admitan hooks y MCP de la organización, más la clave por instancia | B | Hipótesis. **B2** |
| | | (b) **Reinyección por el pipe.** Un proceso del mismo uid puede abrir `/proc/<pid>/fd/<n>` de un **pipe**. Ese acceso es de modo READ y **Yama no lo cubre**. Así podría escribir un `notifications/claude/channel` en el pipe por donde el CLI lee al servidor de canal, y el CLI le daría `origin = channel` **auténtico** a un contenido del agente | K | Hipótesis fuerte. **B2**. ⇒ el **contenido** se atribuye en el backend (§1.14.1) |
| A5 | ptrace, `/proc`, entorno, filesystem, binario | **Un descendiente del CLI no puede adjuntarse** (Yama 1), y `mem`, `process_vm_readv` y `pidfd_getfd` piden permiso de adjuntarse. **Pero el agente puede reiniciar el CLI** por tmux debajo de un padre que controla, que entonces es su ancestro y puede adjuntarse. Por ejemplo `bash` con un builtin cargado por `enable -f`, o un `python3` que hace `fork` + `ptrace`. También puede arrancarlo con `LD_PRELOAD`, `NODE_OPTIONS` o `BUN_*`, y con `prlimit` + una señal forzar un volcado de memoria (sólo al morir el proceso). **Binario:** en nuestra imagen el CLI está bajo `~/.npm-global`, que apunta al **workspace** (O: `.../workspace/.npm-global/.../claude.exe`), escribible y persistente. El inodo en ejecución no se puede escribir (ETXTBSY), pero un arranque nuevo toma el archivo reemplazado. **El CLI sólo se vuelve no volcable (`PR_SET_DUMPABLE`) en modo code review**: "so the review's commands could read its tokens from memory". Anthropic trata la lectura de memoria por el mismo uid como amenaza real, y en modo interactivo no la cierra | K, B, O | Comprobaciones posibles: ver I1–I7. **Residuo**: adjuntarse, leer y soltar entre dos comprobaciones (ver H-ND) |
| A6 | ¿La instalación administrada impide reemplazar el mod o cargar otro? | El tier de organización exige que los managed settings declaren el marketplace en `extraKnownMarketplaces` como **directorio local leído en su lugar** y que lo listen por ruta relativa; una copia (caché, archivo, semilla) es tier de usuario. `pluginDigests` sólo aplica a fuentes remotas. Con un montaje de solo lectura el agente no cambia los archivos. `allowManagedModsOnly`: "mods are limited to your organization's by policy … was not loaded". `disableSideloadFlags` rechaza `--plugin-dir`. **Falta probar** que cubran `CLAUDE_CODE_PLUGIN_DIRS`, `enabledPlugins` de usuario y de proyecto, `claude plugin install` y una copia con el mismo nombre, y que con el guard `sec-default` cargado (con managed settings carga) los `classic.*` de un mod de la organización corran. Importa porque cualquier otro mod corre en el **mismo pid** | B | Hipótesis. **B1** |
| A7 | ¿Y si se apaga el interruptor remoto de mods? | Lectura estática anterior: no cargan los mods instalados y sí los integrados. **No está establecido** si uno de la organización cuenta como instalado. En cualquier caso: sin mod no hay inscripción ⇒ todo `unverified` (fail-closed) y el composer 3.2 sigue igual. El agente puede cambiar la caché del flag en `~/.claude.json`, pero sólo gana denegación de servicio | B | B1, si existe una forma de forzarlo sin tocar la cuenta; si no, queda documentado |
| A8 | Replay, registros fabricados, desorden, confusión entre sesiones | Con el diseño de §1.14.4: clave por instancia, MAC con `inst` y `seq`, `seq` contiguo, **una** inscripción por proceso (pidfd), socket por contenedor, contenedor por cgroup y nonce de un solo uso para el contenido. Si el gateway se reinicia se pierden las claves y todo queda `unverified` hasta que reinicie el CLI | Diseño | B2 / B3 |

**Conclusión de la auditoría.** `SO_PEERCRED` sirve para un solo paso: decidir a **qué proceso** se
le entrega la clave. Nunca prueba por sí solo que un mensaje sea evidencia. Quedan dos límites que la
arquitectura del socket **no** resuelve:
- **A4b:** obliga a atribuir el contenido en el backend.
- **A5, el residuo de reiniciar el CLI debajo de un ancestro preparado:** se cierra sólo con una
  barrera del kernel, que es la hipótesis H-ND, o aislando las herramientas del agente (§1.14.7).

#### 1.14.4 Arquitectura de confianza propuesta

```
contenedor de la sesión (uid 1000, CapDrop ALL)          host
┌──────────────────────────────────────────────┐        ┌─────────────────────────────┐
│ CLI publicado (hash permitido)               │        │ gateway st-attest           │
│  └ Worker: mod de la organización (RO)       │ socket │  pid ns del host, lee /proc │
│      clave K sólo en memoria ────────────────┼─Unix──►│  SO_PEERCRED + SO_PEERPIDFD │
│  └ hijo MCP: servidor de canal (RO) ◄────────┼────────┤  un socket por contenedor   │
│ /run/st-attest/s.sock  (montaje RO del host) │        │  └──► backend (sólo de aquí)│
└──────────────────────────────────────────────┘        └─────────────────────────────┘
```

**Componentes:**
- **E, el emisor.** El CLI publicado más el mod `st-provenance`, de la organización, desde un
  marketplace local de solo lectura. Con `allowManagedModsOnly`, `disableSideloadFlags`, sólo hooks y
  MCP administrados, y ningún otro mod administrado: comparten el pid.
- **C, el servidor de canal.** Plugin MCP administrado. **No escucha ningún puerto**: recibe los
  mensajes sólo desde el gateway. Al arrancar se declara no volcable (`prctl`, código propio). La
  atribución del contenido **no** depende de que C sea íntegro.
- **G, el gateway.** Proceso del host en el namespace de pid del host. Es lo **único** que lee
  credenciales del par. Puede ser un sidecar de compose con `pid: host` y sólo `CAP_SYS_PTRACE` para
  leer `/proc` de otro uid, o una unidad del host; la decisión de despliegue es para después de B1.
  Usa un socket por contenedor, en un directorio del host montado de solo lectura en
  `/run/st-attest`.
- **B, el backend.** Acepta evidencia **sólo** desde G. Lleva el libro de mensajes enviados:
  `(nonce, sha256(cuerpo), conversación, t)`, registrado **antes** de enviar. El relay TCP de hooks
  queda como información, nunca como evidencia.

**Identidad del par**, comprobada por G con el pidfd en la inscripción y en **cada** petición:

| # | Comprobación |
| --- | --- |
| I1 | El cgroup es el del contenedor del socket, y ese contenedor es el `container_id` de D1 de esa sesión |
| I2 | El SHA-256 del inodo de `/proc/<pid>/exe` está en la lista de binarios publicados (R9). Se puede cachear por `(dev, ino)` mientras viva el proceso, gracias a ETXTBSY |
| I3 | `maps` sin bibliotecas fuera de una lista (bloquea `LD_PRELOAD` y similares) |
| I4 | `environ` sin `LD_*`, `NODE_OPTIONS` ni `BUN_*`; `cmdline` dentro de una lista |
| I5 | `TracerPid = 0` |
| I6 | El padre es el proceso raíz del panel y su `exe` es el `bash` de la imagen |
| I7 | El `starttime` es el mismo que en la inscripción |

**Protocolo:**
1. **Inscripción**, en `session.start`. El mod envía `POST /enroll {inst, session_id, versión}`. Si
   pasan I1–I7 y es la **primera** inscripción de ese proceso, G devuelve una clave K aleatoria de 32
   bytes, que vive sólo en la memoria del mod. Una segunda inscripción del mismo proceso **quema** la
   instancia: todo lo de ese proceso queda `unverified` hasta que termine. Así un diputado (A4a) que
   se inscriba antes o después del mod deja dos inscripciones y la instancia queda quemada.
2. **Eventos.** El mod envía `POST /ev {inst, seq, registro, mac = HMAC(K, inst‖seq‖registro)}`. G
   comprueba que el par sea el proceso inscripto, que el MAC sea válido, que `seq` sea el anterior
   más uno y que valgan I5 e I7. Recién entonces lo reenvía a B con la identidad comprobada:
   contenedor, pid, `starttime` y hash del binario.
   - El registro es el de XB-1 **más** `sha256` del cuerpo del prompt. El cuerpo se extrae del sobre
     `<channel …>` con un parser estricto; un sobre no canónico ⇒ `unverified`.
   - Nunca viaja texto.
3. **Veredicto de M:**
   - `verified` sólo si se cumple todo esto:
     - instancia inscripta y no quemada;
     - `seq` sin huecos hasta el `Stop`;
     - `origin = channel` con el servidor administrado X;
     - envío ligado según las reglas de PASS-A;
     - el hash del cuerpo es el de M;
     - el nonce de M aparece **una sola vez**;
     - exactamente un `Stop` (R8).
   - Cualquier otra cosa ⇒ `unverified`, con su motivo. Una segunda aparición deja **ambas**
     `unverified`.

**Hipótesis H-ND (barrera del kernel).** Si el binario del CLI pertenece a root y tiene modo `0711`
(ejecutable pero **no legible** para uid 1000), el kernel lo marca no volcable al ejecutarlo. A partir
de ahí ni el mismo uid ni un ancestro pueden adjuntarse ni leer `mem`, `environ` o `fd`. Eso cerraría
A5 y también la reapertura del pipe **del lado del CLI** (A4b). Riesgo: un ejecutable de Bun de un
solo archivo puede necesitar leerse a sí mismo para cargar su código, y entonces no arrancaría. Se
prueba en B1. Si falla, A5 queda como residuo **documentado**, y la recomendación pasa a §1.14.7.

#### 1.14.5 Qué es demostrable y qué no

| Demostrable si pasa la prueba indicada | Prueba |
| --- | --- |
| El par del socket es el proceso principal del CLI, no un intermediario; el pid se puede llevar al contenedor; el pidfd coincide | B0: **demostrado** (§1.14.13; 2.1.314, VM100, una muestra) |
| La conexión no se hereda (`O_CLOEXEC`); conectar por un montaje de solo lectura funciona y el agente no puede quitar ni reemplazar el socket | B0: **demostrado** (§1.14.13) |
| El mod carga en el tier de organización; ningún otro camino carga un mod; los `classic.*` corren con el guard cargado | B1 |
| H-ND: el CLI arranca no volcable y uid 1000 no puede leer su `environ` ni su `mem` | B1 |
| Los eventos de Bash, MCP o hooks, los replays, el desorden y el cambio de ids o de sesión se rechazan o quedan `unverified` | B2 |
| La reinyección por el pipe produce `origin = channel` pero el veredicto es `unverified`, porque el contenido no coincide | B2 |
| Pérdida, reinicios, `--resume`, `/clear` y varias sesiones nunca mezclan identidades ni producen `verified` | B3 |

**No demostrable con esta arquitectura:**
- que una persona tecleó un prompt;
- que un CLI que el agente reinició debajo de un ancestro preparado no fue leído en memoria **entre**
  dos comprobaciones, salvo que H-ND se cumpla;
- disponibilidad;
- la corrección del binario publicado (es confianza por hash, no prueba);
- el comportamiento de versiones o de API de mods que no estén validadas;
- la configuración del kernel del host (Yama). Es una precondición: el diseño la comprueba, no la
  impone.

**Nota sobre G3** (no lo cambia): aunque el CLI emitiera `source=system`, hoy esa evidencia viajaría
por un hook de comando y el relay TCP de loopback, que cualquier proceso del contenedor puede
falsificar (§1.13.3 B). El problema de integridad de PASS-B existe también para la letra de G3.

#### 1.14.6 Plan de experimentos (incremental; cada etapa necesita su propia autorización)

Reglas comunes:
- Contenedores **descartables**, nunca sesiones ni contenedores de producción, y nada en D1.
- El nombre fuera de los patrones `st-<sid>` y `-old-`/`-new-`, para que ni reconcile ni la limpieza
  de recreación los vean.
- Sin `sessions-net`.
- No se actualiza ningún Claude Code: se usa el CLI que ya trae la imagen.
- Se registran sólo hechos (pid con alias, booleanos, conteos), nunca texto ni credenciales.
- Los logs se copian a una carpeta de resultados **antes** de borrar el contenedor.

**Decisiones del responsable antes de B0:**
1. **Host.**
   - VM100 tiene el kernel y la configuración de Docker reales, pero es el host de producción.
     Contenedores descartables sin efectos en sesiones.
   - Otra máquina Linux con kernel ≥ 6.5 evita VM100, pero su kernel y su Yama pueden ser distintos.
     Recomiendo VM100 con las reglas de arriba.
2. **Versión.** El CLI de la imagen (2.1.314, el validado para contenedores). El resultado vale sólo
   para esa versión. 2.1.317 en Linux sería otra corrida.
3. **Autenticación.** No se sabe si el CLI dispara `session.start` y carga mods antes del login. B0
   intenta primero **sin** login. Si da INCONCLUSIVE por eso, la alternativa sería un `/login` nuevo
   con tu suscripción dentro del contenedor descartable, que se borra con él. No reutiliza
   credenciales, pero es un login y lo decidís vos.

**PASS-B0: viabilidad del socket (diseño detallado).**
- **Objetivo.** Medir cuatro hechos:
  1. si `$.http.fetch` con `socketPath` llega a un servidor Unix;
  2. qué credenciales del par ve el servidor dentro del namespace del contenedor y en el del host;
  3. si el fd de la conexión es `O_CLOEXEC`;
  4. si se puede conectar a un socket en un montaje de solo lectura sin poder reemplazarlo.
- **Fuera de B0:** la clave, el MAC, la instalación administrada y los ataques.
- **Precondiciones:**
  - imagen de sesión actual (mismo `USER`, `CapDrop`, `no-new-privileges` y `PidsLimit` que
    `spawn()`);
  - `ptrace_scope` y `uname -r` registrados;
  - un directorio nuevo del host `…/st-passb0-<ts>/` con el socket del host, montado de solo
    lectura en `/run/st-attest`;
  - kit por SHA con hashes, como en XB-1.
- **Instrumentación:**
  - Mod `st-passb0-probe`, cargado con `--plugin-dir`: en B0 no se prueba la instalación
    administrada y el contenedor no tiene managed settings. En `session.start` hace tres llamadas
    con cuerpo `{inst, n}` y sin texto:
    - una al socket interno `/tmp/passb0/s.sock`;
    - una al del host `/run/st-attest/s.sock`;
    - una segunda al del host, para ver si reutiliza la conexión.

    Escribe el resultado de cada una (estado HTTP o clase de error) con `$.fs.write`.
  - Servidor S_c en el contenedor: `python3 -I`, script de solo lectura lanzado por `docker exec`.
    Registra por conexión:
    - `SO_PEERCRED` y `SO_PEERPIDFD` (el pid del pidfd sale de `fdinfo`);
    - `comm`, `exe`, `Tgid`, `NSpid`, `TracerPid`, `starttime`;
    - las banderas del fd del lado del CLI, leídas en `/proc/<cli>/fdinfo`.
  - Servidor S_h en el host, como root en el namespace del host: registra el pid del host, `NSpid` y
    si el cgroup corresponde al contenedor descartable.
  - Línea base: un cliente `python3` lanzado como `developer` con `docker exec` conecta a los dos
    sockets. Tiene que verse **su** pid, distinto del CLI.
  - Negativo de solo lectura: desde el contenedor, `rm` y `mv` del socket del host tienen que fallar
    con EROFS.
- **Pasos previstos** (los comandos completos se dan al autorizar):
  1. `docker run --rm -d` del contenedor descartable con el montaje de solo lectura.
  2. Arrancar S_h y S_c.
  3. Lanzar el CLI en tmux dentro del contenedor:
     `claude --plugin-dir <kit>/mod --debug-file <out>/claude-debug.log`. Se acepta la confianza de
     la carpeta, que es estado del contenedor descartable.
  4. Esperar el registro `session.start` (un reintento a los 10 s).
  5. Cliente base y negativo EROFS.
  6. Analizador: emite PASS, FAIL o INCONCLUSIVE con alias.
  7. Copiar los resultados, salir del CLI y `docker rm -f`. El directorio del host se conserva junto
     con los resultados.
- **PASS-B0** sólo si se cumple todo esto:
  - las tres llamadas del mod reciben 200;
  - S_c ve como par el **pid principal del CLI**: `Tgid` igual a pid, `exe` igual al binario del
    CLI, y ningún otro proceso;
  - el pidfd resuelve al mismo pid;
  - S_h ve un pid del host cuyo `NSpid` es el mismo CLI y cuyo cgroup es el del contenedor
    descartable;
  - el cliente base se ve con su propio pid;
  - los fd de la conexión son `O_CLOEXEC`;
  - la conexión por el montaje de solo lectura funciona y `rm`/`mv` dan EROFS.
- **FAIL:**
  - el build dice que soporta `socketPath`, pero la llamada no llega;
  - el par **no** es el proceso principal del CLI (un intermediario o un ayudante): invalida el diseño
    basado en el pid;
  - el fd se puede heredar;
  - el pid del host no se puede llevar al contenedor;
  - el socket del host se puede quitar o reemplazar desde el contenedor.
- **INCONCLUSIVE:**
  - el mod no cargó, o `session.start` no se disparó (login o confianza);
  - la política de red de plugins rechazó la llamada ("Network access from plugins" o tráfico no
    esencial deshabilitado). Se registra la causa exacta y no se repite sin decisión.
- **Recuperación.** `docker rm -f` del descartable. No hay nada en D1, ninguna sesión tocada ni
  cambios en el composer.

**PASS-B1: integridad de la instalación** (después de B0 PASS; contenedor descartable con sus
propios managed settings de solo lectura).

> **Actualizado (2026-11-03) en §1.14.14.** La inspección de 2.1.314 corrige este esbozo:
> `allowManagedModsOnly` es una opción del guard (`pluginConfigs["cc-plugin-sec-default@builtin"].options`);
> el tier de organización exige un marketplace de directorio declarado en managed settings; hay controles
> del arranque (`CLAUDE_CODE_MANAGED_SETTINGS_PATH`, entre otros) que ninguna política cierra. B1 se divide
> en B1a (instalación) y B1b (H-ND), con veredictos independientes.
- **Configuración:**
  - marketplace local de solo lectura con `st-provenance`;
  - `enabledPlugins`;
  - `allowManagedModsOnly`, `disableSideloadFlags` y `allowManagedHooksOnly`;
  - MCP sólo administrado. El nombre exacto de la clave se verifica en el binario.
- **Observado:**
  - el mod carga en el tier de organización;
  - el estado del guard;
  - los `classic.*` llegan.
- **Intentos, uno por uno, como `developer`:**
  - escribir en la carpeta del mod;
  - un mod de usuario por `~/.claude/settings.json`;
  - `.claude/settings.json` de proyecto;
  - `--plugin-dir`;
  - `CLAUDE_CODE_PLUGIN_DIRS`;
  - `claude plugin install`;
  - una copia con el mismo nombre en la caché.
- **H-ND:** un segundo descartable con el binario de root en modo `0711`. Se mira:
  - si arranca;
  - si `cat /proc/<pid>/environ` y la lectura de `mem` como `developer` dan EACCES.
- **Interruptor:** sólo si existe un override local del flag que no toque la cuenta.
- **Resultado:**
  - **PASS:** carga en el tier de organización y **todos** los caminos no autorizados se rechazan,
    cada uno con su línea en el debug log;
  - **FAIL:** carga cualquier mod no autorizado;
  - **INCONCLUSIVE:** el guard impide observar.

  H-ND se informa aparte, como resultado propio.

**PASS-B2: pruebas adversariales.** Necesita escribir el prototipo del gateway (inscripción, MAC,
I1–I7), con su propia revisión y autorización. Ataques desde el contenedor descartable:

| # | Ataque | Esperado |
| --- | --- | --- |
| 1 | POST con un evento inventado desde Bash, desde un servidor MCP y desde un hook | Rechazado (par ≠ inscripto) |
| 2 | Replay de bytes de un evento anterior | Rechazado (`seq`/MAC) |
| 3 | Hueco o desorden de `seq` | Lo afectado queda `unverified` |
| 4 | Cambiar `prompt_id` o `session_id` en un evento | Rechazado (MAC) |
| 5 | Un segundo CLI (`claude -p` hijo, o uno nuevo en otra ventana de tmux) se inscribe | Instancia propia, separada, o rechazada por I6. Nunca se mezcla |
| 6 | Reinyectar un `notifications/claude/channel` por `/proc/<pid>/fd` | Puede dar `origin = channel`, pero el veredicto es `unverified` (hash/nonce) |
| 7 | Duplicar un mensaje real por el pipe | Las dos apariciones quedan `unverified` |
| 8 | Diputado: MCP HTTP, hook HTTP o MITM del sandbox apuntando al socket | Sin MAC ⇒ rechazado; si se inscribe, instancia quemada |
| 9 | Reiniciar el CLI con `LD_PRELOAD`, `NODE_OPTIONS`, debajo de `python3` o de `bash` con builtin | Rechazado por I3, I4 o I6. El caso del builtin queda como residuo, salvo H-ND |
| 10 | Etiqueta `<channel>` tecleada por tmux | `composer` ⇒ nunca canal |

- **PASS:** ningún ataque produce `verified` y cada uno queda rechazado o `unverified` con su motivo.
- **FAIL:** un solo `verified` producido por un ataque.

**PASS-B3: recuperación.**
- Pérdida de un evento (G descarta uno): hueco ⇒ `unverified`.
- Reinicio de G: claves perdidas ⇒ `unverified` hasta que reinicie el CLI.
- Reinicio del CLI: inscripción nueva; lo que estaba en vuelo queda `unverified`.
- Reconexión del socket.
- `--resume` y `/clear`: cambio de `session_id` dentro del mismo proceso, o en un proceso nuevo.
- Dos CLI en el mismo contenedor, dos contenedores a la vez, y stop/start del contenedor (los paneles
  se renumeran, v1.7.2).

- **PASS:** ninguna confusión de identidad y nada `verified` sin evidencia continua.
- **FAIL:** cualquier atribución cruzada.

#### 1.14.7 Alternativas si el socket y las credenciales no resisten

| Alternativa | Aislamiento real | Costo y riesgo | Estado |
| --- | --- | --- | --- |
| **H-ND** (binario no legible ⇒ proceso no volcable) | Del kernel, contra el mismo uid **y** contra ancestros | Puede romper el arranque de Bun; cambia el layout de la imagen (el binario sale del workspace) | B1 |
| **Sandbox del CLI para Bash** (bubblewrap), impuesto por managed settings y sin comandos fuera del sandbox | Namespaces separados para las herramientas del agente: no verían ni podrían abrir el CLI, su `/proc` ni su pipe, y quizás tampoco tmux | El seccomp por defecto de Docker no deja crear namespaces sin privilegios (habría que relajarlo); red por lista permitida; MCP y hooks siguen fuera del sandbox (exige MCP y hooks sólo administrados). Impacto de producto alto | Hipótesis. Sería un experimento propio |
| **Otro uid para las herramientas del agente** | Real | El CLI ejecuta las herramientas con su propio uid; necesitaría un cambio upstream | Descartada hoy |
| **Sólo contenido (D)** | No es aislamiento: es atribución | Ya descartada como sustituto de G3 (§1.10, §1.12.2) | — |
| **Esperar `source` (#94675)** | No cambia nada en el transporte | Tiene el mismo problema de integridad hasta el backend (nota de §1.14.5) | Sin fecha |
| **Evidencia sólo informativa** | Ninguno | El Monitor mostraría el origen como no verificado, sin afirmar seguridad. Es una decisión de producto | Disponible |

Si **B1 falla en A6** (carga otro mod) o **H-ND falla y no se acepta el residuo de A5**, la
recomendación es **NO-GO** para esta arquitectura en producción. Las opciones serían evaluar el
sandbox o quedarse con la evidencia informativa. No se fuerza una solución insegura para mantener
Channels.

#### 1.14.8 Recomendación (histórica: B0 se ejecutó y dio PASS, §1.14.13)

**GO para construir el prototipo de PASS-B0, y sólo eso** (cumplido: kits y corridas en §1.14.9–§1.14.13):
- el mod de prueba;
- los dos servidores de medición;
- el analizador y sus tests sintéticos.

Ejecutarlo requirió una autorización aparte, con las tres decisiones de §1.14.6, que el responsable
dio por fases (§1.14.9–§1.14.12). B0 era barato y descartable, y respondía la pregunta que
bloqueaba todo lo demás: si el par del socket es de verdad el proceso del CLI. La respuesta fue sí
(§1.14.13).

**Un PASS-B0 no valida la arquitectura.** Hay dos límites que no dependen de B0 y que deciden el
GO/NO-GO final:
- A4b obliga a atribuir el contenido;
- A5 necesita H-ND (B1) o un aislamiento como el sandbox.

Con un FAIL en B0, el diseño basado en el pid queda descartado y se pasa directamente a §1.14.7.

**Resultado (2026-11-03):** PASS en la corrida 4. Estado, conclusiones y siguiente gate en §1.14.13.

#### 1.14.9 Prototipo PASS-B0 y procedimiento (kit original `d224ebe`; ejecutado con `9996286` y `447f639`, §1.14.10–§1.14.13)

**Estado:** procedimiento histórico. Las corridas 1 a 4 lo usaron con los kits de §1.14.10–§1.14.12
y la corrida 4 dio PASS (§1.14.13). Las autorizaciones, los "no ejecutado" y el "GO limitado" que
aparecen abajo describen la situación en su fecha; no son el estado actual.

**Decisiones del responsable (2026-11-03):**
- **GO** para el prototipo y su implementación.
- **NO-GO** para ejecutarlo mientras no se apruebe esta revisión.
- **Host:** VM100, sólo con **un** contenedor descartable.
- **CLI:** 2.1.314, sin actualizar nada.
- **Login:** ninguno. Sin login y sin mod ⇒ INCONCLUSIVE.

**Ajustes técnicos (primera revisión):**
- **A4b sigue siendo hipótesis.** Reabrir un pipe por `/proc/<pid>/fd` pasa por las comprobaciones
  de ptrace en modo READ y por los permisos del objeto. Compartir uid no garantiza el acceso.
- **A3: la bandera y la consecuencia se miden por separado.** La bandera es `O_CLOEXEC` en
  `fdinfo`. La consecuencia es si un hijo creado con `fork` + `exec` **mientras la conexión está
  abierta** tiene el inodo del par. Un test muestra que pueden divergir.
- **A1: todo se mide por conexión concreta**, con nonce, token, `SO_PEERCRED`, `SO_PEERPIDFD`
  (`Pid`/`NSpid`), `starttime` releído e inodo del par por sock_diag. Que `h2` reutilice la
  conexión de `h1` es sólo informativo.
- **A6:** el HMAC autentica la posesión de K, no que la llamada haya salido de nuestro mod.
- **H-ND** es un experimento de B1.

**Estado de la autorización (2026-11-03, tercera revisión):** diseño general aprobado. **GO
limitado** al paso 0 y a `preflight` en VM100. `setup`, `servers`, `measure`, `capture`,
`validate` y `cleanup` de una corrida real siguen **sin autorizar**. Si `preflight` sale con 3
porque la imagen trae 2.1.308, se detiene ahí: la preferida es la alternativa A, pero su build
tampoco está autorizado.

**Correcciones de la tercera revisión (`d224ebe`):**

| # | Pedido | Cómo quedó |
| --- | --- | --- |
| 7 | `cleanup` no puede destruir evidencia sin copia | `capture.attempted` ya no alcanza. `cleanup` borra el contenedor sólo con **uno** de tres fundamentos, y lo registra en `results/removal.json`: **`captured`**, si `state/capture.ok` existe, el manifiesto está completo y `results/` **todavía** verifica contra `SHA256SUMS`; **`no-evidence`**, si un `exec` en el contenedor prueba que ni `/tmp/passb0` ni `~/passb0-ws/.passb0/out` tienen archivos (un `exec` que falla, por ejemplo con el contenedor detenido, **no** prueba ausencia); o **`discard-authorized`**, si exportaste `B0_DISCARD_EVIDENCE=<id completo de ese contenedor>`. Un valor que no coincide se ignora. En cualquier otro caso, incluida una captura parcial, sale con 66 y no toca el contenedor. Una nueva corrida de `capture` que falla retira el `capture.ok` anterior |
| 8 | Versión exacta en `capture` | El ítem `cli-version-after` exige exactamente `2.1.314` y persiste `results/cli-version-after.json` (`version`, `expected`, `match`). `setup` persiste también `cli-version-before.json`. Ambos están en el manifiesto, así que una discrepancia deja la captura incompleta (salida 4). El analizador exige `2.1.314` en `preflight.json`, antes y después: si falta o difiere, da INCONCLUSIVE (`cli-version-unverified:*` / `cli-version-mismatch:*`) y nunca PASS |
| 9 | Cotejo del ID | `setup` exige que `docker run` devuelva un id de 64 hex y que el nombre resuelva a ese id. `cleanup` borra sólo un contenedor cuya etiqueta, nombre **e** id coincidan con `state/container_id`. Sin ese archivo o con otro id, no lo toca y sale con 67 |

**Correcciones de la segunda revisión (`5d293cf`):**

| # | Pedido | Cómo quedó |
| --- | --- | --- |
| 1 | Shell fail-closed | Los bloques `( set -euo pipefail; … ) && echo OK \|\| echo FALLÓ` desaparecieron. Dentro de una lista `&&`/`\|\|`, bash **ignora** `errexit` en la subshell, así que un paso intermedio que fallaba podía terminar en "OK". Ahora cada fase es `bash run-b0.sh BASE <fase>`: el script tiene `set -euo pipefail` y se ejecuta como comando, nunca dentro de una lista. `OK: <fase>` es su última línea y lo imprime el script. Además, cada fase escribe `state/<fase>.ok` sólo si termina bien, y la siguiente se niega a correr sin esa marca. Test: un comando **sin** comprobación explícita que falla corta la fase; con la mutación `"$PHASE" && true` ese test falla. **Nota:** el mismo patrón estaba en el procedimiento de XB-1. Su veredicto no depende de él (lo dio el código de salida de `xb.mjs report`, y cada bloque terminaba en una comprobación), pero un paso intermedio fallido pudo pasar inadvertido |
| 2 | PID del servidor del host | Al arrancar, el servidor escribe su identidad: pid, `starttime`, `boot_id`, uid y SHA-256 de su `cmdline`. `b0.py stop` abre primero un **pidfd**, después compara la identidad y recién entonces envía SIGTERM **por el pidfd** (`pidfd_send_signal`): si el pid se hubiera reutilizado antes, la identidad no coincide y no se envía nada; si se reutiliza después, el pidfd sigue apuntando al proceso original. Distinto boot o proceso inexistente ⇒ `already-exited` sin señal; identidad distinta ⇒ `refused` sin señal. Espera la salida sobre el pidfd. Con SIGTERM el servidor borra su socket. Tests con procesos reales |
| 3 | Versión de la imagen | La fase `preflight` es de **solo lectura**: lee `docker image history --no-trunc` y extrae el `CLAUDE_CODE_VERSION` de la **única** capa que instala `@anthropic-ai/claude-code` con npm. Una versión distinta de 2.1.314, desconocida, o dos capas de instalación ⇒ **STOP (salida 3)**, sin crear nada. `setup` lo vuelve a comprobar dentro del contenedor con `claude --version`, que es la versión efectiva. Alternativas: abajo |
| 4 | Captura antes del rollback | Hay tres fases separadas: `capture`, `validate` y `cleanup`. `capture` copia ítem por ítem y registra cada resultado en `capture-manifest.json`, sin `2>/dev/null` ni `\|\| true`; si falta algo termina con salida 4, conserva todo y genera `SHA256SUMS`. Con una captura incompleta, el analizador da INCONCLUSIVE (`capture-incomplete`). `cleanup` se **niega** a borrar el contenedor si no se intentó la captura. `capture` corre también después de un `setup` fallido |
| 5 | Hashes | El paso 0 verifica los **13** archivos publicados (`sha256sum -c --strict`) **y** que la lista de `poc/passb0/` sea exactamente esa, sin archivos extra ni faltantes |
| 6 | Límites y limpieza | `setup` no confía en los flags: compara con `docker inspect` lo que Docker **aplicó** (`checklimits`): etiqueta, usuario, 2 GiB sin swap extra, 1 CPU, 256 PIDs, `CapDrop ALL` sin `CapAdd`, `no-new-privileges`, no privilegiado, red `bridge`, sin namespaces del host, exactamente dos montajes de solo lectura, ningún `docker.sock`. Cualquier diferencia ⇒ falla. `cleanup` es idempotente y funciona tras fallos parciales: detiene el servidor por identidad, borra sólo el contenedor con **la etiqueta y el nombre** de esta corrida (`-v`), verifica que no quede ninguno, que la imagen no cambió y que `run/` quedó vacío. No borra `held-h.json` sin una copia idéntica en `results/`, ni el socket sin el servidor probadamente detenido. Registra `cleanup.json` |

**Tests sintéticos** (en desarrollo; también pasan sobre la copia descargada por SHA de `d224ebe`):
- `test_b0.py`, 22 tests: los 17 anteriores, más:
  - `stop`: proceso verificado detenido y socket borrado; idempotencia; rechazo por
    `starttime`, `cmdline` o uid distintos sin señalar; proceso muerto u otro boot;
  - `imageversion`;
  - `checklimits`, con 11 desvíos.
- `test_analyze.py`: 46 mutaciones. Las de la segunda revisión son captura incompleta y manifiesto
  ausente; las de la tercera, versión distinta o ausente en `preflight`, antes y después.
- `test_runner.py`, 30 tests con un `docker` falso y un servidor del host real:
  - `preflight` sin escrituras; STOP con 2.1.308, con versión desconocida, con userns y con
    restos de otra corrida;
  - cada fase exige la marca anterior;
  - el contenedor se crea con exactamente esos límites;
  - STOP con otra versión adentro, con límites aplicados distintos, con un montaje extra
    (`docker.sock`) y con un fallo sin comprobación explícita;
  - `servers` seguido de `cleanup` detiene el servidor real por identidad y es idempotente;
  - no señala con una identidad distinta;
  - captura incompleta ⇒ evidencia conservada e INCONCLUSIVE;
  - captura después de un `setup` fallido;
  - no toca un contenedor ajeno;
  - conserva `held-h.json` sin copia;
  - tercera revisión: `cleanup` se niega (66) con evidencia y sin captura, tras una captura
    parcial, con el contenedor detenido (no puede mirar adentro), con `capture.ok` pero
    `results/` modificado y con `B0_DISCARD_EVIDENCE` de otro id; borra con el id exacto
    (`discard-authorized`) y un contenedor vacío (`no-evidence`); no borra (67) sin
    `state/container_id` o con otro id; `setup` falla si el nombre apunta a otro id; `capture`
    falla con 2.1.315 después de la corrida y lo persiste; una nueva captura fallida retira
    `capture.ok`.
- `probe.test.mjs`: los 10 tests del mod.
- Verificación por mutación: quitar la marca previa, la comparación de `starttime` o `errexit`
  hace fallar los tests correspondientes. En la tercera revisión, también: quitar el cotejo de id,
  el `sha256sum -c` de `cleanup`, la igualdad exacta de versión, el retiro de `capture.ok`, el id
  en `B0_DISCARD_EVIDENCE`, tratar un `exec` fallido como "sin evidencia" o el cotejo nombre→id de
  `setup`.
- `claude plugin validate` (2.1.314): ✔.

**Hashes publicados** (verificados sobre la descarga de GitHub por SHA; los 13 dan `OK` y la lista
es idéntica):
```
7cad57fdd43e4b8a71ab0e7db31fa0c8bfda4b5b398bca1a6dac8f6fc1c1bbac  analyze.py
4539a7fc25b7d4e7f09c92f951c578a743d2890b5b84c6e3728368205c6fd92d  b0.py
c77dcffd3df92dead59e05482a3c2b0c935e9b279830a71ba199f49096bc1767  mod/.claude-plugin/plugin.json
d87f4cbc7a53b0d733c13dd4c7f81e49d7ede3b21163e0d64e2234176d43100d  mod/hooks/hooks.json
7dc6f559e44df194adcaa7d1e13dfb7857fd7e16195680069f0caf6d9bccfe2e  mod/hooks/probe.mjs
47aa77c452e02165e542f5067ead5aebb89aae3a46f6f7e28fca971eca43735c  mod/hooks/register.mjs
d25be34dbe1928b9cdb1639c8488785b5f2d5c106d0faab90b8a37ef8d65109d  README.md
9006cc347a90e81faf971bc5b5df9ad496112f99d3e30f69d96db115af0ae781  run-b0.sh
ac1e593a088b32a4d4245c385dc3693207ebb8275289bf6b76b5c6b7ee367209  test/fakebin/docker
0cbcde02beb60b70fc6f4e06783edacafa2ad7931100932ab2a664e14d23fa7e  test/probe.test.mjs
fdf4e0bbe5b37a57f59fcf68d45083dec774599e54710f4212d419bd378ee40d  test/test_analyze.py
afa103846fee5445d4bbb1dec3338491354943cdd253203f87320e45b0904bce  test/test_b0.py
119028ca34b0bdf6a87b26296c45ceae4b7ce23bbe84b31f939aed831ca0b7f2  test/test_runner.py
```

**Operaciones privilegiadas en VM100** (ninguna usa `sudo`; si tu usuario necesita `sudo` para
Docker, se exporta `B0_DOCKER_SUDO=1` y el runner usa `sudo -n docker` sólo en esas llamadas):

| # | Operación | Fase | Límite |
| --- | --- | --- | --- |
| P1 | `docker info`, `image inspect`, `image history`, `ps` | `preflight`, `cleanup` | Sólo lectura |
| P2 | `docker run -d` de `passb0-exp-<STAMP>` | `setup` | Una vez. Límites verificados después con `docker inspect` (#6). `sleep 3600`: se detiene solo a la hora |
| P3 | `docker exec -u developer` (también `-d` para el servidor interno y `-it` para el CLI) | `setup` … `capture` | Nunca `-u root` |
| P4 | `docker cp` del contenedor al host | `capture` | Hechos, archivos del mod y sólo las líneas del debug log que nombran el plugin o el guard |
| P5 | `docker rm -f -v` | `cleanup` | Sólo si la etiqueta `passb0.experiment`, el nombre **y** el id de `state/container_id` coinciden con esta corrida, y con un fundamento registrado: `captured`, `no-evidence` o `discard-authorized` (#7) |
| P6 | El servidor del host (`nohup python3 -I`) como **tu usuario**, y su `stop` por pidfd | `servers`, `cleanup` | Socket en `~/passb0-<STAMP>/run/`. Se apaga solo a los 3000 s. Sólo recibe la señal si la identidad coincide |

**No hace:**
- `pull`, `build`, `tag`, `network create` ni `volume create`;
- `compose` ni reiniciar Docker;
- cambios globales;
- tocar sesiones, D1, el composer o la imagen real.

**Si la imagen no trae 2.1.314** (por ejemplo, el 2.1.308 por defecto del `Dockerfile`), B0 se
detiene en `preflight` y decidís entre estas alternativas. **Ninguna se aplica sola:**

| | Alternativa | Qué cambia en VM100 | Costo y riesgo |
| --- | --- | --- | --- |
| A | Imagen experimental **independiente**, construida en VM100 con el mismo `Dockerfile` (commit fijado) y `--build-arg CLAUDE_CODE_VERSION=2.1.314`, con un tag propio `passb0-session:2.1.314-<STAMP>`; `shared-terminal-session` no se toca. Se borra al final | Una imagen nueva (`docker build`, que descarga el paquete de npm) y su `docker image rm` | Dos operaciones privilegiadas más. La versión queda verificada por `preflight` y `setup` igual que antes |
| B | La misma imagen, construida **fuera** de VM100 (por ejemplo, por el job `cli-variants` del Session Image workflow, que ya construye 2.1.314) y cargada con `docker load` con un tag propio | Una imagen nueva y su borrado; nada se descarga en VM100 | Exige exportar el artefacto desde CI (un cambio de workflow o una ejecución manual) |
| C | Correr B0 con 2.1.308 | Nada | **Cambia tu decisión 2**. Antes habría que hacer la inspección estática de 2.1.308 (`socketPath`, tier de plugins), que no está hecha |
| D | Esperar a que la imagen real pase a 2.1.314 por su proceso normal | Nada | Sin fecha |

Recomiendo **A**: es el cambio más chico y no toca la imagen real. Con A o B, el `env` del paso 0 usa
`IMAGE=passb0-session:2.1.314-<STAMP>`, y `cleanup` sumaría una operación P7 (`docker image rm`
de ese tag, comprobando su ID). Esto se agrega sólo si lo autorizás.

**Procedimiento exacto.** Terminal A en VM100:

```bash
# Paso 0: carpeta nueva, kit por SHA, los 13 hashes y la lista exacta, env. Se ejecuta como un script.
bash -euo pipefail -s <<'STEP0'
COMMIT=d224ebea037ed8e728a7a257b0e94def9492e723
STAMP=$(date +%Y%m%d-%H%M%S)
BASE=$HOME/passb0-$STAMP
test ! -e "$BASE"
mkdir -m 0700 "$BASE"; mkdir -m 0700 "$BASE/kit" "$BASE/results"; mkdir -m 0755 "$BASE/run"
gh api "repos/gatof81/shared-terminal/tarball/$COMMIT" > "$BASE/kit.tgz"   # sin gh: copiá el .tgz del mismo SHA
tar xzpf "$BASE/kit.tgz" -C "$BASE/kit" --strip-components=1                  # -p: modos 0644/0755 legibles por uid 1000
cat > "$BASE/kit.sha256" <<'SUMS'
7cad57fdd43e4b8a71ab0e7db31fa0c8bfda4b5b398bca1a6dac8f6fc1c1bbac  analyze.py
4539a7fc25b7d4e7f09c92f951c578a743d2890b5b84c6e3728368205c6fd92d  b0.py
c77dcffd3df92dead59e05482a3c2b0c935e9b279830a71ba199f49096bc1767  mod/.claude-plugin/plugin.json
d87f4cbc7a53b0d733c13dd4c7f81e49d7ede3b21163e0d64e2234176d43100d  mod/hooks/hooks.json
7dc6f559e44df194adcaa7d1e13dfb7857fd7e16195680069f0caf6d9bccfe2e  mod/hooks/probe.mjs
47aa77c452e02165e542f5067ead5aebb89aae3a46f6f7e28fca971eca43735c  mod/hooks/register.mjs
d25be34dbe1928b9cdb1639c8488785b5f2d5c106d0faab90b8a37ef8d65109d  README.md
9006cc347a90e81faf971bc5b5df9ad496112f99d3e30f69d96db115af0ae781  run-b0.sh
ac1e593a088b32a4d4245c385dc3693207ebb8275289bf6b76b5c6b7ee367209  test/fakebin/docker
0cbcde02beb60b70fc6f4e06783edacafa2ad7931100932ab2a664e14d23fa7e  test/probe.test.mjs
fdf4e0bbe5b37a57f59fcf68d45083dec774599e54710f4212d419bd378ee40d  test/test_analyze.py
afa103846fee5445d4bbb1dec3338491354943cdd253203f87320e45b0904bce  test/test_b0.py
119028ca34b0bdf6a87b26296c45ceae4b7ce23bbe84b31f939aed831ca0b7f2  test/test_runner.py
SUMS
cd "$BASE/kit/poc/passb0"
sha256sum -c --strict --quiet "$BASE/kit.sha256"
diff <(find . -type f | sed 's|^\./||' | sort) <(awk '{print $2}' "$BASE/kit.sha256" | sort)
printf '%s\n' "STAMP=$STAMP" "KIT=$BASE/kit/poc/passb0" "RUN=$BASE/run" "RES=$BASE/results" \
  "EXP=passb0-exp-$STAMP" "IMAGE=shared-terminal-session" "COMMIT=$COMMIT" > "$BASE/env"
echo "BASE=$BASE"
echo "OK: paso 0"
STEP0
```

```bash
# Con el BASE que imprimió el paso 0:
BASE=~/passb0-AAAAMMDD-HHMMSS
R() { bash "$BASE/kit/poc/passb0/run-b0.sh" "$BASE" "$1"; echo "fase $1: salida=$?"; }
R preflight     # solo lectura; salida 3 = STOP por versión (ver alternativas)
```
**Hasta acá llega el GO limitado.** Después de `preflight`, mandame su salida completa (la
última línea es `fase preflight: salida=N`) y `cat "$BASE/results/preflight.json"`: kernel,
`ptrace_scope`, los 12 primeros hex del id de imagen y la versión. `preflight` no crea
contenedores ni redes y no cambia nada; deja sólo `state/preflight.ok`, `state/image_id` y
`results/preflight.json` (si sale con otro código, ni eso). No hay nada que limpiar: si no
seguimos, `rm -rf "$BASE"` lo borra todo.

Lo que sigue necesita la autorización final:
```bash
R setup         # P2: crea el contenedor y verifica lo que Docker aplicó y la versión adentro
R servers       # P3 y P6: servidor interno y del host, con identidad
```
Cada fase exige la marca de la anterior. Si una fase falla, no sigas con la siguiente: pasá a
`capture` y `cleanup`.

**Terminal B en VM100** (el CLI, mientras el paso `measure` espera):
```bash
EXP=passb0-exp-AAAAMMDD-HHMMSS
docker exec -it -u developer -e DISABLE_AUTOUPDATER=1 -w /home/developer/passb0-ws "$EXP" \
  claude --plugin-dir /opt/passb0-kit/mod --debug-file /home/developer/passb0-ws/.passb0/out/claude-debug.log
```
- **Permitido:** elegir el tema y aceptar la confianza de la carpeta.
- **Prohibido:** cualquier login, `/login`, tokens o prompts.
- Si aparece la pantalla de login, no elijas nada.

```bash
R measure       # terminal A, con el CLI todavía abierto: espera "done" ≤ 120 s, base, control, rocheck
```
Después, en la terminal B: `/exit`, o Ctrl-C dos veces si quedó en la pantalla de login.
```bash
R capture       # salida 4 = captura incompleta: la evidencia queda; sigue validate (dará INCONCLUSIVE)
R validate      # imprime report.json; salida 0 sólo con PASS
R cleanup       # idempotente; repetila hasta "OK: cleanup" o mandame su salida
```
Si `cleanup` sale con **66**, el contenedor puede tener evidencia sin copia verificada y no se
borró. Primero repetí `R capture`. Si la captura sigue incompleta y decidís descartar lo que
quede adentro, autorizalo para **ese** contenedor:
`B0_DISCARD_EVIDENCE=$(cat "$BASE/state/container_id") R cleanup`. Queda registrado en
`results/removal.json` como `discard-authorized`. Una salida **67** dice qué quedó sin limpiar
(un contenedor que no coincide con `state/container_id`, un servidor sin identidad, un
`held-h.json` sin copia) y no se resuelve sola: mandame la salida.
Si algo falló antes de `measure`, corré `R capture` y `R cleanup`. Si falló `preflight`, no
se creó nada.

Quedan **siempre**:
- `$BASE/kit` y `$BASE/kit.tgz`;
- `$BASE/results`, con `report.json`, `capture-manifest.json`, `cli-version-before.json`,
  `cli-version-after.json`, `removal.json`, `cleanup.json` y `SHA256SUMS`;
- `$BASE/state`.

Mandame `report.json`: tiene alias y booleanos.

**Criterios** (`analyze.py`):
- **PASS** sólo si se cumple todo esto:
  - la captura está completa;
  - la versión del CLI es exactamente 2.1.314 en `preflight`, en `setup` y después de la
    corrida;
  - el mod cargó una vez, con `seq` contiguo y `done`;
  - hay exactamente un proceso del CLI;
  - las cinco llamadas dieron 200, cada una ligada a **una** conexión por token y nonce;
  - en el contenedor, el par es el CLI: pid y tgid, uid 1000, `starttime` y SHA-256 del
    ejecutable, pidfd del mismo pid y lectura estable;
  - en el host, el `NSpid` lleva al CLI, el cgroup es el del contenedor y el pidfd coincide;
  - los dos clientes base se ven como ellos mismos;
  - el control positivo detecta la herencia;
  - en las dos retenciones, el único poseedor es el CLI, con `O_CLOEXEC`, y el hijo creado
    mientras la conexión estaba abierta no la tiene;
  - `create`, `mkdir`, `rename` y `unlink` dan EROFS.
- **FAIL:**
  - `socketPath` rechazado, o una llamada que no llega;
  - una conexión sin correspondencia;
  - el par no es el CLI;
  - `NSpid` o cgroup ajenos;
  - el cliente base atribuido al CLI;
  - el fd sin `O_CLOEXEC`, en varios fds o en otro proceso;
  - herencia al hijo;
  - el directorio del socket escribible.
- **INCONCLUSIVE:**
  - captura incompleta, o sin manifiesto;
  - el mod no cargó (login, confianza o interruptor);
  - registros incompletos o líneas problemáticas del mod;
  - varios CLI;
  - la política de red de plugins;
  - sin `SO_PEERPIDFD`;
  - el control falló;
  - el checker no sincronizó, o el inodo del par es desconocido;
  - la búsqueda de poseedores fue denegada;
  - otro errno;
  - faltan logs.

**Nada se repite sin una decisión tuya.** Un PASS-B0 sólo responde la viabilidad del socket (§1.14.8).

#### 1.14.10 Corrida 1 en VM100 (2026-11-03): INCONCLUSIVE; diagnóstico (cerrado en §1.14.11)

**Lo que informó el responsable** (kit `d224ebe`, carpeta `~/passb0-20261103-151611`):
- **Entorno:** kernel `6.8.0-147-generic`, `ptrace_scope=1`, los 13 hashes OK. La etiqueta
  `shared-terminal-session` se reconstruyó con 2.1.314 (imagen `sha256:cf6b1ff94ead…`). Esto
  difiere de la alternativa A, que usaba una etiqueta propia; lo decidió el responsable.
- **Fases:** `preflight`, `setup` (`differs: []`), `servers`, `measure` y `capture` terminaron con
  salida 0. `validate` terminó con 2: **INCONCLUSIVE** por `debug-log-mod-problem` y
  `checker-not-synchronized:hold-h`.
- **A favor:**
  - las cinco llamadas atribuyeron el par al CLI (`SO_PEERPIDFD`, `starttime`, ejecutable, uid,
    cgroup y `NSpid`);
  - las dos bases se vieron a sí mismas y el control detectó la herencia;
  - `hold-c`: un único poseedor (el CLI), `O_CLOEXEC` puesto, sin herencia, `scan_denied=0`;
  - `rocheck`: `EROFS` ×4;
  - la versión es 2.1.314 en los tres puntos.
- **Sin dato:** `hold-h_fd` está vacío. No hay medición de `O_CLOEXEC` ni de herencia sobre la
  conexión del host.

Esta corrida **no** se declara PASS. Hasta cerrar el diagnóstico no se repite nada, y
`cleanup` de la corrida 1 tampoco se corre: el contenedor detenido conserva el debug log
completo (`capture` trajo sólo las líneas filtradas), que puede hacer falta.

**B. `checker-not-synchronized:hold-h`**

*Hechos, desde el código de `d224ebe`:*
1. `run-b0.sh` hace `umask 077` y desde ahí lanza el servidor del host con `nohup`, que hereda esa
   máscara.
2. El servidor escribe `held-h.json` con `write_json_atomic`, que usa `open(…, "w")` sin modo
   explícito. Con umask 077 el archivo queda **0600**, a nombre del usuario que corrió el runner.
3. El checker (`waitheld` y después `fdcheck`) corre **en el contenedor**, como uid 1000, y lee
   ese archivo por el montaje de solo lectura `/run/st-attest`.
4. El socket del mismo directorio sí recibe un `chmod 0666` explícito, justamente porque el
   lector puede tener otro uid. Por eso `h1` y `h2` conectaron.
5. `wait_held` trata **cualquier** `OSError` igual que un archivo ausente: reintenta hasta 6 s y
   devuelve `waited: false` sin el motivo.
6. El mod de `d224ebe` guarda de `waitheld` sólo `waited` y `conn`; el error de
   `$.process.run` se descarta. Si `waitheld` no sincroniza, `fdcheck` no corre.
7. En el contenedor, `held-c.json` lo escribe el servidor interno, como uid 1000 y con la umask
   0022 de `docker exec`. Por eso `hold-c` no puede fallar por esta causa, y nada de lo anterior
   lo distingue de `hold-h`.

*Hipótesis* (ninguna está demostrada todavía; `diag.py` las separa con la evidencia existente):

| | Hipótesis | La confirma | La descarta |
| --- | --- | --- | --- |
| H1 | **Permisos:** `held-h.json` 0600 y el servidor del host con un uid ≠ 1000 ⇒ `EACCES` en el contenedor | `held_h_file.results_copy.mode = 0o600` (`cp -p` conserva el modo), `host_server.uid_is_1000 = false`, `held_file_written` ≪ 6000 ms y `held_file_conn_matches_call = true` | `uid_is_1000 = true`: el dueño 1000 puede leer un 0600 |
| H2 | **`$.process.run` falló** en `waitheld` (rechazo o error del host) | una línea marcada del debug log con `during_call = hold-h` y `ms_into_call` cerca de 0. Explicaría **los dos** motivos con una sola causa | ninguna línea marcada dentro de `hold-h` |
| H3 | **Tiempos:** el archivo se escribió después de la ventana de 6 s de `waitheld` (por ejemplo, el hash del ejecutable del CLI tardó) | `held_file_written` > ~6000 ms | `held_file_written` ≪ 6000 ms |
| H4 | **Visibilidad:** el `rename` en el host no se vio a través del bind mount | sólo queda si H1–H3 se descartan. La corrida 1 no tiene datos para probarla; con `f8679d6`, `held_last_error = ENOENT` la mostraría | H1, H2 o H3 confirmada |

H1 y H2 pueden darse a la vez. **No supongo una carrera:** las tres primeras se deciden con
`results/` y `state/` tal como están.

**A. `debug-log-mod-problem`**

*Hechos:*
- `analyze.py` cuenta las líneas del debug log que nombran `st-passb0-probe` (41) y marca las que
  contienen `skipped|failed|refused|not loaded|error`, sin distinguir mayúsculas. Una sola
  (`debug_mod_bad_lines=1`) basta para INCONCLUSIVE.
- `capture` trajo sólo las líneas que nombran el plugin o el guard.
- Desde aquí no puedo ver cuál es la línea.

*Hipótesis:* la cadena 2.1.314 tiene varios mensajes candidatos que nombran un plugin y una de
esas palabras:
- de carga (`hooks module … not loaded`, `… failed to load`);
- de operaciones (`$.<op> refused: …`);
- de hooks (`session.start: failed for …`, `skipped: re-entry`).

Algunos son inocuos y otros, errores reales. Si la línea cae dentro de `hold-h` (H2), los dos
motivos tienen una sola causa.

*Regla de decisión:*
- **Error real:** se corrige la causa y el filtro **no** se toca.
- **Inocuo**, por ejemplo una palabra del filtro dentro de un mensaje informativo: se justifica
  con la línea y con el código del CLI que la emite, y se agrega un test de regresión con esa
  plantilla exacta. Nunca se amplía el filtro en general.
- **Sin evidencia suficiente:** sigue siendo INCONCLUSIVE.

**Cambios en el kit de desarrollo `f8679d6`** (no aprobados para una corrida):
- **Archivo `held` legible por el checker.** El servidor escribe el archivo con modo `0644`
  explícito (no contiene secretos), como ya hacía con el socket. `h.jsonl` y `results/` siguen
  privados. Corrige H1 si se confirma, y si no, saca la dependencia del uid del operador. Test:
  servidor real con umask 077 ⇒ `held` 0644 y `h.jsonl` sin permisos para otros. Si se quita el
  modo, el test falla.
- **El checker dice por qué no sincronizó.**
  - `waitheld` y `fdcheck` informan el motivo de la última lectura fallida (`ENOENT`, `EACCES`,
    `stale`, `not-json`).
  - El mod guarda, además, la clase de error de `$.process.run`, el código de salida y la
    duración.
  - El analizador agrega los hechos `<label>_sync`.
  - Los criterios no cambian: sigue siendo INCONCLUSIVE.
  - Tests: los motivos `ENOENT`, `stale` y `EACCES`, una ejecución rechazada, un motivo con forma
    inválida que se descarta, y el hecho `hold-h_sync` del analizador.
- **`diag.py`**, diagnóstico de solo lectura de una corrida terminada:
  - tiempos de cada llamada en ms desde su inicio;
  - lo que informaron `waitheld` y `fdcheck`;
  - modo y dueño del archivo `held` como booleanos;
  - las líneas marcadas del debug log, redactadas y ubicadas en la llamada en curso.
  No escribe ni ejecuta nada. Tests: no deja salir pid, inodo, token, nonce ni uid, y no
  modifica nada.
- **El filtro del debug log no cambia** hasta ver la línea.
- **Tests:** runner 30, servidores 25, analizador 7 tests con 46 mutaciones, `diag` 4, mod 12;
  `claude plugin validate` ✔.

**Diagnóstico sobre la corrida 1** (VM100, solo lectura; no crea ni toca contenedores):

```bash
BASE=~/passb0-20261103-151611
mkdir -m 0700 "$BASE/diag"
gh api -H "Accept: application/vnd.github.raw" \
  "repos/gatof81/shared-terminal/contents/poc/passb0/diag.py?ref=f8679d6ab4c4d0ffad533a8fd812dd43ca48c79b" > "$BASE/diag/diag.py"
echo "34be61e91b12b6c3c65ff3a7ef23b390bb0b1fce2af6db119aa4ef80631374ae  $BASE/diag/diag.py" | sha256sum -c --strict
python3 -I "$BASE/diag/diag.py" "$BASE" > "$BASE/diag/diag-1.json"; echo "salida=$?"
```

Revisá `diag-1.json` antes de mandarlo. Tiene alias, booleanos, milisegundos y líneas del debug
log redactadas (hex largos, UUID y `/home/<user>`).

**Sólo si la línea marcada necesita contexto**, y con tu autorización explícita: una copia del
debug log **completo** desde el contenedor detenido. `docker cp` no lo arranca ni lo modifica:

```bash
EXP=passb0-exp-20261103-151611
docker cp "$EXP:/home/developer/passb0-ws/.passb0/out/claude-debug.log" "$BASE/diag/claude-debug.full.log"
python3 -I "$BASE/diag/diag.py" "$BASE" --full-log "$BASE/diag/claude-debug.full.log" > "$BASE/diag/diag-2.json"
```

**Segunda medición aislada** (borrador; **no autorizada**). Tiene tres requisitos previos:
1. el diagnóstico cerró H1–H4 y el motivo A;
2. el kit tiene la corrección correspondiente, con su SHA y sus hashes;
3. el `cleanup` de la corrida 1 está autorizado. Hace falta porque `preflight` rechaza cualquier
   contenedor `passb0` existente; borraría el contenedor por la causa `captured`, después de la
   copia del debug log completo si se hizo.

Después se sigue el mismo procedimiento de §1.14.9 en una carpeta nueva (`STAMP` nuevo), con el
paso 0 apuntando al SHA nuevo y su lista de hashes. Debe dar **PASS** sin tocar ningún criterio,
y los hechos `hold-h_sync` y `hold-h_fd` deben estar completos.

#### 1.14.11 Diagnóstico cerrado de la corrida 1; kit `9996286` (**segunda corrida no autorizada**)

**Evidencia:** `diag.py` (`f8679d6`) sobre `~/passb0-20261103-151611`, ejecutado por el
responsable en VM100. Valores como booleanos y milisegundos desde el inicio de cada llamada.

**B. `checker-not-synchronized:hold-h` — causa: permisos (H1).**

| Hecho (`diag-1.json`) | Valor |
| --- | --- |
| `host_server.uid_is_1000` | `false` |
| `held-h.json` | modo `0600`, dueño = el servidor del host (≠ 1000) |
| `held_file_written` | 4 ms |
| `held_file_conn_matches_call` | `true` |
| `waitheld.waited` / `fdcheck_ran` | `false` / `false` |
| fin de la llamada | 8013 ms (la retención de 8 s completa) |

- El archivo correcto existió desde los 4 ms. Un checker con uid 1000 no puede abrir un archivo
  `0600` de otro uid, así que `waitheld` agotó su espera y `fdcheck` no corrió.
- **H3 descartada:** el archivo estaba a 4 ms, no tarde. **H4 sin sustento:** H1 explica todo.
  **H2** no aplica: la única línea marcada es otra (abajo).
- **Límite:** la corrida 1 no registró el errno de la lectura. `EACCES` se deduce del modo,
  del dueño y del uid del lector; no está observado. La corrida 2 lo registra
  (`waitheld.held_last_error`).
- `hold-c` sincronizó porque el servidor interno escribe su archivo como uid 1000.
- **Corrección** (desde `f8679d6`): el servidor escribe sólo ese archivo de control de B0 con
  `0644` explícito (`write_json_atomic(..., mode=0o644)`). `h.jsonl` y `results/` siguen
  privados.
- Test: `test_b0.py`, `HeldFile`. El servidor real corre bajo `umask 077`; el archivo queda
  `0644` y `h.jsonl` privado. Quitar el modo hace fallar el test.

**A. `debug-log-mod-problem` — falso positivo de una plantilla concreta, no un fallo de carga.**
- **La línea marcada:**
  `hooks modules not loaded until workspace trust is accepted: st-passb0-probe, …`.
- **Qué hace el código de 2.1.314:**
  - `loadPluginHooks` la registra mientras la confianza de la carpeta está pendiente, con
    los módulos que retiene.
  - Al aceptar la confianza corre `loadHooksModulesHeldForTrust`, que vuelve a cargar.
  - Un módulo que carga registra `hooks module <nombre>@<origen> loaded (…)`.
- En la corrida 1, después aparece la carga de `st-passb0-probe@inline` y las cinco llamadas
  corrieron.
- **Corrección** (`analyze.py`, `debug_scan`). La línea retenida se exime sólo con estas tres
  condiciones:
  - el mensaje es **exactamente** esa plantilla;
  - la lista nombra a `st-passb0-probe` como elemento propio, no `st-passb0-probe-x`;
  - **después**, en el mismo log, hay una línea `hooks module st-passb0-probe@… loaded (` que no
    reporta un problema.
  - `not loaded` sigue en el filtro.
  - Cualquier otra línea marcada sigue contando.
  - Los hechos nuevos `debug_mod_trust_held_then_loaded` y
    `debug_mod_trust_held_never_loaded` dicen cuál fue el caso.
  - `diag.py` marca la misma exención en cada línea (`exempt_trust_held_then_loaded`).
- **Tests** (`test_analyze.py`, `DebugLog`, con las plantillas del CLI):
  - retenida y después cargada ⇒ PASS;
  - retenida y nunca cargada ⇒ INCONCLUSIVE;
  - retenida con `failed to load` antes o después de la carga ⇒ INCONCLUSIVE;
  - la carga **antes** de la retención no la resuelve;
  - `hooks module … not loaded: …`, `skipped: re-entry`, `plugin hooks after workspace trust: … failed`
    y la retención de otro módulo ⇒ INCONCLUSIVE;
  - la carga de otro módulo (`st-passb0-probe2`) no la resuelve;
  - una línea de carga que reporta `error` no la resuelve.
- **Mutaciones** (6, todas detectadas):
  - quitar el orden;
  - no revisar la línea de carga;
  - quitar la pertenencia a la lista;
  - borrar `not loaded` del filtro;
  - eximir sin carga;
  - aceptar la carga de cualquier módulo.

**Otros datos de la corrida 1.**
- **`server_exe_error=EACCES` en h1, h2 y hold-h.**
  - **Es esperado.** El servidor del host corre con tu uid y el CLI con 1000. Leer
    `/proc/<pid>/exe` exige acceso de ptrace, y con `ptrace_scope=1` y otro uid se niega.
  - No tiene relación con `held-h.json`: es otro archivo, el que el **host** no puede leer del
    contenedor.
  - El analizador nunca comparó `exe` del lado host. Lo dice un comentario nuevo en
    `analyze.py`.
  - **Siguen valiendo en el host:**
    - `SO_PEERCRED` (pid y uid 1000);
    - `NSpid` hasta el pid del CLI en el contenedor;
    - cgroup del contenedor;
    - `tgid`;
    - relectura estable;
    - `NSpid` del pidfd.
  - **El SHA-256 del ejecutable** y el `starttime` frente al CLI se comprueban **dentro** del
    contenedor (c1 y hold-c, mismo uid). Ahí coincidieron.
- **Dos líneas `type root … EROFS`.**
  - **Son efecto esperado del montaje de solo lectura.** El CLI intenta escribir en la carpeta
    del mod (`/opt/passb0-kit/mod`, montada ro) una raíz de tipos para editor: `types/` y un
    `tsconfig`.
  - Al fallar registra `type root of <mod> not laid: EROFS: …` y sigue (telemetría
    `lay_failed`). No afecta la carga.
  - No son las cuatro `EROFS` de `rocheck`: esas prueban el directorio del **socket**.
  - El filtro no las marca, y hay un test con esa forma
    (`test_read_only_type_root_is_not_flagged`).
  - **Límite:** no vi el texto exacto. Si alguna no tiene la forma `type root of … not laid:` o
    `type root under …`, mandámela.
- Las cinco conexiones conservaron la atribución al CLI.

**Kit `999628642ccbe31de9a3c2abc6791c875ad0341c`** (rama `poc/channels-phase0`; no aprobado para
correr). Diferencia con `d224ebe`:
- todo `f8679d6`:
  - `held` en `0644`;
  - motivos de `waitheld`/`fdcheck`;
  - `hold-h_sync`;
  - `diag.py`;
- la exención anterior;
- un test nuevo de `pickChild`: el motivo de `fdcheck` sólo se conserva si tiene forma de
  motivo. Su mutación ahora se detecta.

Ningún otro criterio cambió.

**Tests:**
- runner: 30;
- servidores: 25;
- analizador: 16, con 46 mutaciones de criterio más las 6 de arriba;
- `diag`: 5;
- mod: 13;
- `claude plugin validate`: pasa.

El tarball de GitHub de ese SHA coincide byte a byte con estos 15 hashes:

```
2ae3a335437a8743e2ed0d4f269de93be70b7b27338751305d56a44118bcb5c6  analyze.py
73bc795d3eddb294a30d529b3994b9900113663d2c5eddffb239b5a9fc750b4d  b0.py
6676f48339f5021686a3a9f33d3826521d82ffcfff7f528f813b2b24d5e41333  diag.py
c77dcffd3df92dead59e05482a3c2b0c935e9b279830a71ba199f49096bc1767  mod/.claude-plugin/plugin.json
d87f4cbc7a53b0d733c13dd4c7f81e49d7ede3b21163e0d64e2234176d43100d  mod/hooks/hooks.json
d168fc6fc643a0b19085b55a76263149770394bc825fe10a8421cc9127be035c  mod/hooks/probe.mjs
47aa77c452e02165e542f5067ead5aebb89aae3a46f6f7e28fca971eca43735c  mod/hooks/register.mjs
42950a275aed0da211b71fc763c7cab5e705481d9acb8f0bd0da432ab740d699  README.md
9006cc347a90e81faf971bc5b5df9ad496112f99d3e30f69d96db115af0ae781  run-b0.sh
ac1e593a088b32a4d4245c385dc3693207ebb8275289bf6b76b5c6b7ee367209  test/fakebin/docker
35e833175694ad484c90633932a6ac6a88199d584e4837680415d3c50018a1df  test/probe.test.mjs
af280094dcd13c8b51a7f5c75aa5a78fb13e577cf824ecc05a7ff24c5c017fd5  test/test_analyze.py
5f82dd2ff5099558eac74bddea58215664775cf3488640ffd53372162ebc46a7  test/test_b0.py
5ddb66ee9ba63206b3f4a66fa24886db472b1e3f43a01e14d2f2a6f8542e82b2  test/test_diag.py
119028ca34b0bdf6a87b26296c45ceae4b7ce23bbe84b31f939aed831ca0b7f2  test/test_runner.py
```

`run-b0.sh` no cambió desde `d224ebe`.

**Cierre de la corrida 1** (VM100; necesita tu autorización de `cleanup`). Usa el kit **de la
corrida 1** (`d224ebe`, en `$BASE/kit`), no el nuevo:

```bash
BASE=~/passb0-20261103-151611
R1() { bash "$BASE/kit/poc/passb0/run-b0.sh" "$BASE" "$1"; echo "fase $1: salida=$?"; }
# 1. La evidencia está intacta antes de tocar nada:
(cd "$BASE/results" && sha256sum -c --strict --quiet SHA256SUMS) && echo "OK: results"
# 2. Una copia fuera de la carpeta, con su hash (results, state, env y diag; ningún secreto):
( umask 077; tar -C "$HOME" -czf "$HOME/passb0-20261103-151611.evidence.tgz" \
    passb0-20261103-151611/results passb0-20261103-151611/state passb0-20261103-151611/env passb0-20261103-151611/diag
  sha256sum "$HOME/passb0-20261103-151611.evidence.tgz" > "$HOME/passb0-20261103-151611.evidence.tgz.sha256" )
# 3. cleanup: borra el contenedor sólo con fundamento `captured` y para el servidor del host por identidad:
R1 cleanup
# 4. Verificación:
cat "$BASE/results/removal.json"; cat "$BASE/results/cleanup.json"
(cd "$BASE/results" && sha256sum -c --strict --quiet SHA256SUMS) && echo "OK: results tras cleanup"
sha256sum -c "$HOME/passb0-20261103-151611.evidence.tgz.sha256"
docker ps -a -q --filter label=passb0.experiment | wc -l      # debe dar 0
```

**Qué se espera:**
- `fase cleanup: salida=0`;
- `removal.json` con `"basis": "captured"`;
- `cleanup.json` con `{"clean": true}`;
- las dos comprobaciones `OK`;
- `0` contenedores.

**Si sale distinto:**
- con **66** o **67**, no sigas y mandame la salida;
- con 66 no autorices el descarte: la captura de la corrida 1 se verificó, así que un 66 sería
  un hecho nuevo.
- con 67 y `la imagen cambió`: `cleanup` compara el id actual de `shared-terminal-session` con
  el de `preflight`. Si reconstruiste el tag después de la corrida, el mensaje es esperado.
  Mandámelo igual: el contenedor ya estará borrado y el resto del cierre se puede verificar.

El debug log completo sigue sólo dentro del contenedor y se va con él. El diagnóstico está
cerrado sin él, así que la copia de §1.14.10 ya no hace falta.

**Segunda medición aislada (borrador; no autorizada).**

**Requisitos:**
- cierre de la corrida 1 verificado;
- tu aprobación de este kit y de los comandos.

**Procedimiento:**
- Es el de §1.14.9, en una carpeta nueva (`STAMP` nuevo), con dos cambios en el paso 0:
  - `COMMIT=999628642ccbe31de9a3c2abc6791c875ad0341c`;
  - el bloque `SUMS` con los 15 hashes de arriba.
- La comprobación `diff` de la lista exacta de archivos se mantiene: ahora son 15, con
  `diag.py` y `test/test_diag.py`.
- `IMAGE=shared-terminal-session`, que ya trae 2.1.314.
- El resto es igual:
  - `preflight`, `setup`, `servers`;
  - terminal B: el CLI, aceptando sólo tema y confianza;
  - `measure`, `capture`, `validate`, `cleanup`.
- Los límites, montajes, operaciones P1–P6 y criterios son los de §1.14.9. Sólo cambia la
  exención exacta de A.

**Para aceptar un PASS** hay que ver, además del veredicto:
- `hold-h_fd` con un único poseedor, el CLI, con `O_CLOEXEC`, sin herencia y `scan_denied=0`;
- **ningún** `hold-h_sync`: sólo aparece cuando no sincroniza;
- `debug_mod_bad_lines=0`;
- `debug_mod_trust_held_then_loaded` en 0 o 1, y `debug_mod_trust_held_never_loaded=0`.

Si vuelve a dar INCONCLUSIVE por `hold-h`, `hold-h_sync` trae el motivo (`EACCES`, `ENOENT`,
`stale`…) y se corre `diag.py` antes de cualquier otra cosa.

**Evaluación de seguridad de repetir.**
- **Aislamiento:**
  - la corrida 1 aplicó los límites pedidos;
  - montajes de solo lectura (`EROFS` ×4 en el socket, más las dos de la raíz de tipos del mod);
  - sin `docker.sock`;
  - un contenedor;
  - el servidor del host se apaga solo a los 3000 s, y `cleanup` sólo lo señala si su identidad
    coincide.
  - La corrida 2 usa el mismo `run-b0.sh` y no agrega operaciones privilegiadas.
- **El único cambio con efecto fuera del contenedor** es el modo `0644` del archivo `held-h.json`
  en `~/passb0-<STAMP>/run/`.
  - Contiene un token de conexión, el inodo del par y una hora; no es una credencial.
  - Otros usuarios locales de VM100 podrían leerlo durante la corrida (≤ 3000 s).
  - El directorio `run/` ya era `0755` para que el contenedor alcance el socket.
  - `cleanup` lo borra después de copiarlo.
  - **No se traslada a B1:** con HMAC ningún archivo legible por otro uid puede tener material
    de clave.
- **Validez:**
  - las dos causas de la corrida 1 están identificadas con evidencia;
  - la corrección de cada una tiene un test que falla sin ella;
  - ningún criterio de PASS se debilitó: la exención es una sola plantilla y exige la carga
    posterior.
  - Por eso una segunda corrida puede dar evidencia confiable.
- **La imagen real** pasó a 2.1.314 por decisión tuya. Está dentro de las versiones
  validadas: Composer y `/etc/st-control`.

**Mi conclusión:** repetir es seguro una vez cerrada y verificada la corrida 1. No ejecuto ni
apruebo la corrida 2.


#### 1.14.12 Corrida 2: INCONCLUSIVE por `peer-inode-unknown:hold-h`; kit `447f639` (**tercera corrida no autorizada**)

**Lo que informó el responsable:**
- `h1`, `h2` y `hold-h` dieron 200, con `local_ino` conocido y `peer_ino_error=ENOENT`.
- En `hold-h`:
  - `waitheld` y `fdcheck` sincronizaron;
  - `peer_known=false`.
- El debug está limpio y `hold-c` pasa.
- La corrida 2 sigue capturada. **No se limpia.**

**Causa raíz: verificada en el código del kernel, no reproducida.**
- **Qué fuentes leí:**
  - upstream `v6.8`;
  - el tag `Ubuntu-6.8.0-147.147` del árbol noble, que es el kernel de VM100.
  - Las funciones que importan son idénticas en los dos: `unix_stream_connect`,
    `unix_find_bsd`, `unix_lookup_by_ino`, `unix_diag_get_exact` y `sk_diag_dump_peer`.
    `unix_create1` difiere sólo en cambios del recolector y de lockdep.
- **Cómo se crea el extremo aceptado:**
  - `unix_stream_connect` toma `net = sock_net(sk)` **del cliente**;
  - crea el socket que después devuelve `accept()` con `unix_create1(net, NULL, 0, …)`;
  - `unix_create1` lo inserta en la tabla de **esa** red con `unix_insert_unbound_socket(net, sk)`.
- **El servidor puede aceptar igual:** `unix_find_bsd` busca el destino por ruta (inodo del
  sistema de archivos), sin mirar el namespace. Por eso el cliente del contenedor llega al
  socket del host.
- **Por qué el host recibe ENOENT:** `unix_diag_get_exact` usa `net = sock_net(in_skb->sk)`,
  el namespace **de quien consulta**, y `unix_lookup_by_ino(net, ino)` recorre sólo
  `net->unx.table`. El servidor del host consulta desde el namespace del host y recibe
  `-ENOENT` para **su propio** extremo aceptado.
- **El resto de la corrida 2 encaja:**
  - en el lado c todo está en el namespace del contenedor y funciona;
  - el número de inodo (`fstat`, sockfs) es global, así que el contenedor ve el mismo número
    que el host.
- **Lo que no pude hacer:** reproducirlo con dos namespaces. Este entorno no permite
  `unshare -n`. La prueba directa es una tercera corrida en VM100.

**Corrección mínima** (`447f639`, sobre `9996286`):
- **Servidor:** `held-h.json` lleva además `local_ino`, que es el `fstat` del fd aceptado.
- **Checker** (`fdcheck`, `peer_from_accepted`):
  - consulta `sock_diag` desde **su** namespace, el del contenedor y el del CLI;
  - el inodo del JSON no se acepta así nomás. Se rechaza si no es un entero en
    `1…2³²−1`, si no existe, si no es un socket de stream `ESTABLISHED`, si no tiene par, si
    el par no lo nombra de vuelta (no es mutuo) o si el par no está `ESTABLISHED`;
  - si el servidor obtuvo el par (lado c), los dos valores tienen que coincidir;
  - informa qué pids de su namespace tienen el extremo aceptado (`local_holder_pids`).
- **Analizador:**
  - el `local_ino` que usó el checker tiene que ser **el mismo** que el servidor registró
    para la conexión ligada por `conn` y `nonce`; si no, `held-socket-mismatch`;
  - en `hold-h` nadie dentro del contenedor puede tener el extremo aceptado, porque el
    servidor del host no está en ese namespace de pids; si no, `held-socket-mismatch`;
  - en `hold-c` el par del servidor tiene que coincidir;
  - sin par mutuo, `peer-inode-unknown`;
  - después siguen los mismos criterios de siempre: único poseedor el CLI, `O_CLOEXEC`, sin
    herencia y `scan_denied=0`.
  - Nada se relajó: las razones nuevas son INCONCLUSIVE y sólo agregan condiciones.
- **El dato informativo `h2_reused_h1_connection`** ya no aparece: el host nunca resuelve el
  extremo del cliente, y el analizador no lo inventa.

**Tests:**
- runner 30;
- servidores 38, con sockets reales:
  - vista del host simulada: la consulta del servidor falla como en el host y la del
    checker es real;
  - inodos inválidos, de una conexión cerrada, de un cliente que se fue, de un listener, de
    datagramas y de otra conexión viva;
  - desacuerdo con el servidor;
  - respuestas del kernel no mutuas o no `ESTABLISHED` (con `unix_diag` falso);
- analizador 16, con 60 mutaciones de criterio y 14 negativas nuevas;
- `diag` 5;
- mod 14;
- `claude plugin validate`: pasa.

**15 mutaciones de código, todas detectadas:**
- en el checker:
  - no exigir par mutuo;
  - no exigir `ESTABLISHED` en el extremo aceptado;
  - no exigirlo en el par;
  - no comparar con el servidor;
  - no validar el inodo;
  - el servidor sin `local_ino`;
  - no buscar quién tiene el extremo aceptado;
  - confiar en el par del servidor;
- en el analizador:
  - no comparar con el registro del servidor;
  - no aplicar la regla de poseedores en `hold-h`;
  - no exigir acuerdo en `hold-c`;
  - no exigir par mutuo;
  - ignorar un desacuerdo en el host;
- en el mod:
  - pasar `diag` sin filtrar;
  - pasar `local_holder_pids` sin filtrar.

**Hashes del kit.** Comprobé que el tarball de GitHub de
`447f6394b62031e7617390255a8500a398f18cd2` coincide con estos 15:

```
89d07fea590466096bc7f8bd3d6e56a06f6cb88060ead812bcb4dfe6f6a30d98  analyze.py
370e1d3f15810809a6cfffd65353194506e7aa5622a00f120398b708261addee  b0.py
6676f48339f5021686a3a9f33d3826521d82ffcfff7f528f813b2b24d5e41333  diag.py
c77dcffd3df92dead59e05482a3c2b0c935e9b279830a71ba199f49096bc1767  mod/.claude-plugin/plugin.json
d87f4cbc7a53b0d733c13dd4c7f81e49d7ede3b21163e0d64e2234176d43100d  mod/hooks/hooks.json
dfa0451674cf535ca1775a01c3469e208bfcee04b9b58ec5899dcc11e97af6c8  mod/hooks/probe.mjs
47aa77c452e02165e542f5067ead5aebb89aae3a46f6f7e28fca971eca43735c  mod/hooks/register.mjs
683d825b530200f5afde17c842d0f5841e8f1519ed903118470e3b411fe3a5b0  README.md
9006cc347a90e81faf971bc5b5df9ad496112f99d3e30f69d96db115af0ae781  run-b0.sh
ac1e593a088b32a4d4245c385dc3693207ebb8275289bf6b76b5c6b7ee367209  test/fakebin/docker
79ef6d8aaa92e72ec5f222686893afd8557a74f3a5ff072abd4cd0219327500a  test/probe.test.mjs
a26b7301cbb47f831ed42ad4a4e3ef2f54645fc8c04adbae58c6d4d070811a00  test/test_analyze.py
543a92136516dbdec040118b7adce98ae3692b3a51be0097c869aa47ae661342  test/test_b0.py
5ddb66ee9ba63206b3f4a66fa24886db472b1e3f43a01e14d2f2a6f8542e82b2  test/test_diag.py
119028ca34b0bdf6a87b26296c45ceae4b7ce23bbe84b31f939aed831ca0b7f2  test/test_runner.py
```

`run-b0.sh` no cambió.

**Revisión de seguridad y de falso PASS.**
- **Inodo equivocado pero válido**, por ejemplo de otra conexión viva del contenedor.
  `sock_diag` lo resolvería, pero lo frenan otras tres comprobaciones:
  - no coincide con el registro del servidor para esa `conn` y ese `nonce`;
  - en `hold-h` su extremo aceptado tiene poseedor dentro del contenedor;
  - el poseedor del par no sería el CLI identificado por el servidor.
  Cubierto por tests de `b0.py` y del analizador.
- **Archivo viejo o de otra llamada:** sigue la comprobación de `t_ms` posterior al inicio
  y de `conn` igual a la de la llamada.
- **Conexión ya cerrada:**
  - si se cerraron los dos extremos, `ENOENT`;
  - si se fue sólo el cliente, el par no es mutuo (el kernel devuelve 0 o un socket que ya
    no resuelve).
  Las dos dan INCONCLUSIVE, nunca PASS.
- **Reutilización de inodos:** sockfs los numera de forma creciente. Para que diera un falso
  PASS haría falta coincidir a la vez con el registro del servidor, con un par mutuo y con el
  CLI como poseedor.
- **El checker** es hijo del CLI y corre como uid 1000. No gana privilegios:
  - `sock_diag` de AF_UNIX no exige capacidades;
  - el servidor interno ya lo usaba en la corrida 2.
- **Lo que no cubre:** un CLI malicioso que falsee la salida del checker. Pasaba igual con
  `hold-c`, y B0 mide al kernel, no al CLI como adversario (§1.14.8).
- **Exposición en el host:** `held-h.json` (`0644`, ≤ 3000 s) suma un número de inodo. No es
  un secreto.
- **Sin cambios:**
  - el aislamiento;
  - las operaciones P1–P6;
  - los gates G1–G12, G3, G3-A y R8;
  - Composer.

**Tercera corrida (borrador; no autorizada).**
- **Requisito:** cerrar la corrida 2 con su propio kit (`9996286`). `preflight` rechaza
  contenedores `passb0` existentes. Es el mismo procedimiento de cierre de §1.14.11, con su
  `BASE`; no se hace sin tu OK.
- **Procedimiento:** el de §1.14.9, con un `STAMP` nuevo,
  `COMMIT=447f6394b62031e7617390255a8500a398f18cd2` y los 15 hashes de arriba.
- **Para aceptar un PASS:**
  - `hold-h_fd.accepted_end` con `matches_server_record`, `stream_established` y `mutual` en
    `true`, y `server_agrees` en `null`;
  - `hold-c_fd.accepted_end.server_agrees` en `true`;
  - en las dos, un único poseedor (el CLI), `O_CLOEXEC`, sin herencia y `scan_denied=0`.

#### 1.14.13 Corrida 4 en VM100 (2026-11-03): **PASS** (kit `447f639`). Estado y siguiente gate

**Resultado:** `verdict=PASS`, `reasons=[]`. Es una sola muestra, con el alcance de §1.14.6:
viabilidad del socket.

El PASS corresponde **exclusivamente** a la corrida 4, sobre la carpeta
`~/passb0-20261103-203739`.

**La corrida 3 no produjo ninguna medición válida.**
- **Qué pasó:** el contenedor terminó por el vencimiento normal de su `sleep 3600`, con salida 0 y
  sin OOM, antes de llegar a `measure`. El mod no escribió ningún registro.
- **Cierre, por el responsable:**
  1. recuperó el debug log;
  2. inventarió los 31 cambios del sistema de archivos del contenedor;
  3. verificó los respaldos;
  4. cerró con `basis=discard-authorized` y `cleanup.clean=true`.
- La evidencia queda sólo en VM100, como la de las otras corridas.
- No cuenta como muestra, ni a favor ni en contra.

**Versiones y entorno:**

| | Valor |
| --- | --- |
| Host | VM100 |
| Kernel | `6.8.0-147-generic` (el de §1.14.12) |
| Claude Code | 2.1.314 en `preflight`, en `setup` y después de la corrida (`cli_version_ok`) |
| Imagen | `shared-terminal-session`, reconstruida con 2.1.314 por decisión del responsable (§1.14.11) |
| Kit | `poc/channels-phase0@447f6394b62031e7617390255a8500a398f18cd2`; el paso 0 exige los 15 hashes de §1.14.12 |
| Procedimiento | §1.14.9 con `STAMP` nuevo; sin login; en la terminal sólo tema y confianza de la carpeta |

**Fases:** `measure=0`, `capture=0`, `validate=0`.

**Hechos que informó el responsable:**
- **Atribución:** las cinco conexiones (`c1`, `h1`, `h2`, `hold-c`, `hold-h`) quedaron
  atribuidas al proceso principal del CLI.
  - **En el contenedor:** pid y tgid, uid 1000, `starttime`, SHA-256 del ejecutable y pidfd.
  - **En el host:** `NSpid` hasta el CLI, cgroup del contenedor, tgid, relectura estable y
    `NSpid` del pidfd.
- **Retenciones** (`hold-c` y `hold-h`):
  - extremo aceptado igual al registro del servidor, stream establecido y par mutuo;
  - un único poseedor (el CLI), con `O_CLOEXEC`;
  - el hijo creado durante la retención no hereda la conexión;
  - `scan_denied=0`.
- **Control positivo:** detecta la herencia. Los dos clientes base se ven como ellos mismos.
- **Directorio del socket del host:** `create`, `mkdir`, `rename` y `unlink` dan `EROFS`.
- **Debug del mod:** sin líneas problemáticas sin resolver.

**Cierre ejecutado por el responsable:**
1. respaldo previo verificado;
2. servidor del host detenido por identidad;
3. contenedor borrado con `basis=captured`;
4. `cleanup.clean=true`;
5. respaldo final verificado.

**Evidencia:** queda **sólo en VM100**. No se sube al repositorio ni a la PR:
- `/home/diego/passb0-20261103-203739.evidence.tgz`;
- `/home/diego/passb0-20261103-203739.final.tgz`.

Este documento recoge únicamente alias, booleanos y versiones. Ningún pid, inodo, token, nonce,
texto ni log sin depurar sale de VM100.

**Qué demuestra PASS-B0** (para 2.1.314, en el kernel de VM100, con el mod cargado por
`--plugin-dir`):

| # | Hecho | Hipótesis de §1.14.3 |
| --- | --- | --- |
| 1 | `$.http.fetch` con `socketPath` llega a un servidor Unix, dentro del contenedor y en el host a través de un montaje de solo lectura | Transporte de §1.14.4 viable |
| 2 | El par de la conexión es el **proceso principal** del CLI, no un intermediario, y el pidfd fija ese mismo proceso | A1 confirmada |
| 3 | Un lector del host lleva el pid al contenedor con `NSpid` y reconoce el contenedor por el cgroup | A2 confirmada para un lector en el namespace de pids del host |
| 4 | La conexión es `O_CLOEXEC`, la tiene sólo el CLI, y un hijo creado con `$.process.run` mientras está abierta no la hereda | A3, la parte de herencia |
| 5 | El agente puede conectarse al socket del host pero no quitarlo ni reemplazarlo (EROFS) | A3, la parte del montaje |

**Conclusiones arquitectónicas** (de las corridas 1 a 4; afectan al gateway de §1.14.4):
1. **El diseño basado en las credenciales del par sigue en pie.** Con un FAIL en B0 se habría
   pasado directamente a §1.14.7; eso no hace falta.
2. **La identidad del par, en el host, sale de lo que da el kernel:**
   - `SO_PEERCRED`;
   - `SO_PEERPIDFD`;
   - `NSpid`;
   - el cgroup;
   - `starttime`.

   **No sale de `sock_diag`.** El socket aceptado vive en el namespace de red del cliente y
   `unix_diag` sólo responde dentro del de quien consulta (§1.14.12). Un gateway en el host no
   puede comparar inodos de pares. Las comprobaciones de fd e inodo de B0 son instrumentos de
   medición dentro del contenedor, no una garantía del gateway: el checker es hijo del CLI.
3. **El hash del ejecutable en el host no está demostrado.** Un lector con otro uid recibe `EACCES`
   en `/proc/<pid>/exe` (`ptrace_scope=1`; §1.14.11). B0 lo midió dentro del contenedor. Para que
   el gateway ate la identidad al binario (I3), tiene que correr como root o con
   `CAP_SYS_PTRACE` en el host, y eso no se probó.
4. **Dónde vive el gateway** sigue abierto. El backend corre en compose **sin** `pid: host`, así
   que tal como está no puede leer `NSpid` del CLI (A2). Las opciones son:
   - un proceso del host;
   - el backend con `pid: host`, que amplía su superficie.

   Es una decisión del responsable antes de B2.
5. **Ningún archivo que el contenedor lea del host puede contener material de clave.** El archivo
   de control `0644` de B0 era aceptable porque no tiene secretos. En B1 y B2 ese esquema no se
   traslada.
6. **El mod se carga recién al aceptar la confianza de la carpeta.** Con `--plugin-dir` el CLI lo
   retiene hasta entonces y lo carga después (§1.14.11). Cómo se comporta un mod **administrado**
   (tier de organización) frente a la confianza es una pregunta de B1, no de B0.

**Lo que PASS-B0 no demuestra:**
- la clave, el MAC, la inscripción ni el gateway;
- la instalación administrada, el tier de organización ni el rechazo de caminos no autorizados (B1);
- H-ND (B1);
- resistencia a ataques (B2) ni recuperación (B3);
- la atribución del contenido (A4b), que sigue siendo obligatoria;
- el residuo A5;
- otras versiones del CLI (2.1.316, 2.1.317), otros kernels ni repetibilidad: es una muestra.

**Estado:**
- **PASS-B0: PASS.**
- **PASS-B: no alcanzado.** Faltan B1, B2 y B3, y cada uno necesita su autorización.
- G3 sigue sin cumplirse.
- G3-A sigue sin aprobarse.
- R8 y G1–G12 no cambian.
- PASS-A y PASS-B0 juntos no habilitan el Monitor.

**Siguiente gate: PASS-B1, integridad de la instalación.** El diseño se actualizó en §1.14.14
(B1a y B1b). El GO del 2026-11-03 es sólo de diseño e inspección estática.

| Dependencia | Estado | Quién |
| --- | --- | --- |
| PASS-B0 | **Cumplida** | — |
| Infraestructura del kit (runner por fases, captura verificada, cleanup por fundamento, analizador con mutaciones) | Reutilizable | — |
| Nombres exactos de las claves de managed settings en 2.1.314 (`allowManagedModsOnly`, `disableSideloadFlags`, `allowManagedHooksOnly`, MCP sólo administrado) y del tier de organización | Pendiente. Es inspección estática del binario, sin VM100 | Claude, con un GO para diseñar B1 |
| Mod administrado (`st-provenance` de prueba) en un marketplace local de solo lectura y managed settings montados ro en el descartable | Diseño pendiente | Claude |
| H-ND: imagen variante con el binario de root en modo `0711` | Exige construir una imagen (operación privilegiada, como la alternativa A de §1.14.9) | Decisión del responsable: B1 junto o H-ND aparte como B1b |
| Ejecución en VM100 | Mismas reglas que B0 | Autorización del responsable |

**Después de B1:**
- **B2** necesita:
  - el prototipo del gateway: inscripción, HMAC e I1–I7. Hoy está explícitamente **no
    autorizado**;
  - la decisión de dónde vive el gateway (conclusión 4);
  - la atribución del contenido (A4b).
- **B3** depende de B2.

**Paralelo a esta rama, sin cambios:**
- G3: `source=system` sigue ausente (#94675);
- la decisión sobre G3-A;
- la alternativa de evidencia sólo informativa (§1.14.7), que es una decisión de producto.

#### 1.14.14 PASS-B1: diseño de B1a y B1b, evidencia estática de 2.1.314, riesgos y plan (**no ejecutado**)

> Implementado en §1.14.15 (kit `e00ef29`), con las correcciones que trajo la validación local.

**GO del responsable (2026-11-03):** diseñar B1 e inspeccionar estáticamente Claude Code 2.1.314.
- **No autoriza:**
  - construir imágenes;
  - ejecutar en VM100;
  - cambios de producción;
  - merge ni deploy.
- G3, G3-A, R8, G1–G12 y Composer no cambian.

B1 se divide en dos pruebas **independientes**. Cada una tiene su propio veredicto, y un FAIL de
una no se compensa con la otra:
- **B1a:** integridad de la instalación.
- **B1b:** H-ND.

##### 1.14.14.1 Fuentes de la evidencia estática

- **(B) Binario.** `@anthropic-ai/claude-code@2.1.314`, `bin/claude.exe`:
  - SHA-256 `4487042b4c4f5d88d4568f68ae98aae0b1ffae58864cf57fb868641bc5f84594`;
  - 298 229 464 bytes;
  - ELF x86-64.

  Es la copia de este contenedor de desarrollo, la misma versión que validó B0. Se leyó con
  búsquedas en sus cadenas, en el código JS embebido y en el parseo de sus cabeceras ELF. Nada se
  ejecutó con configuraciones nuevas.
- **(K) Kernel.** Fuentes del tag `Ubuntu-6.8.0-147.147` del árbol noble, el kernel de VM100:
  - `fs/exec.c`;
  - `kernel/ptrace.c`;
  - `fs/proc/base.c`.
- **Grados de certeza** que se usan abajo:
  - **E** (estático): leído en el código o en la descripción del propio binario.
  - **H** (hipótesis): inferido; lo decide la prueba.

  Una descripción `.describe()` del esquema de settings dice qué **promete** el CLI. Que lo cumpla
  se prueba en B1a.

##### 1.14.14.2 Claves de managed settings en 2.1.314 (verificadas en el binario)

| Clave (ruta exacta) | Qué dice el binario | Grado | Rol en B1a |
| --- | --- | --- | --- |
| `pluginConfigs["cc-plugin-sec-default@builtin"].options.allowManagedModsOnly` | **No es una clave de primer nivel.** Es una opción del plugin incorporado `cc-plugin-sec-default` (el guard), y se lee sólo de `policySettings`. Cuenta como activa cualquier valor que no sea `false` ni ausente. Al rechazar un mod registra: "mods are limited to your organization's by policy (allowManagedModsOnly); X was not loaded" | E | `true` |
| `disableSideloadFlags` | "rejects the --plugin-dir, --plugin-url, --agents, and non-sdk --mcp-config CLI flags at startup … Only honored from managed settings". El código también rechaza `--plugin-dir-no-mcp` y la variable `CLAUDE_CODE_PLUGIN_DIRS`, y termina el proceso con "… disabled by your organization's managed settings (disableSideloadFlags)". **No** cubre otras entradas de MCP (SDK, `claude mcp add`, `.mcp.json`) | E | `true` |
| `allowManagedHooksOnly` | "only hooks from managed settings and from plugins that managed settings enable run. User, project, and local hooks and the hooks of plugins the user installed are ignored" | E | `true` |
| `strictPluginOnlyCustomization` | `true` bloquea `~/.claude/{surface}/`, `.claude/{surface}/`, los hooks de `settings.json` y `.mcp.json` para las superficies skills, agents, hooks y MCP. Si el valor es inválido, se trata como `true` | E | `true` |
| `strictKnownMarketplaces` / `blockedMarketplaces` | Lista permitida y lista bloqueada de marketplaces. Admiten fuentes `directory`, `file`, `hostPattern` y `pathPattern`. **Cualquier** lista permitida bloquea la autocarga de `~/.claude/skills` (plugins `@skills-dir`) salvo que incluya `{"source":"skills-dir"}` | E | sólo el directorio RO de la prueba |
| `extraKnownMarketplaces` (en managed) | Declara la fuente del marketplace. Es condición del tier de organización (abajo) | E | el directorio RO |
| `enabledPlugins` (en managed) | Habilita el plugin | E | `st-b1-probe@st-b1` |
| `allowManagedMcpServersOnly` + `allowedMcpServers` | `allowedMcpServers` se lee sólo de managed. `[]` significa que el usuario no puede usar servidores propios. `deniedMcpServers` se suma desde todas las fuentes | E | `true` y `[]` |
| `disableAllHooks` | Apaga **todos** los hooks y mods, también los nuestros | E | **no** se define: B1a tiene un negativo para el caso de que el agente lo active desde settings de usuario |
| Valores restrictivos inválidos | "was present but invalid; treating it as … (its restrictive value)": falla cerrado | E | negativo de configuración |

**Tier de organización** (E). El binario dice cuándo un mod habilitado por managed settings **no**
es de la organización: "it is not read in place from a local folder its marketplace is registered
from: it loads from a copy (the plugin cache, an archive or a seed directory) … not treated as the
organization's: its hooks module runs in the user tier, and does not load where only managed hooks
may".
- **Queda en el tier de organización sólo si:**
  - managed settings lo habilitan;
  - su marketplace está declarado en `extraKnownMarketplaces` (managed) como **directorio local**;
  - ese marketplace lo lista por **ruta relativa**;
  - se lee **en el lugar**, no desde una copia.
- **Para fuentes remotas** hacen falta `pluginDigests` y `prependPlugins` o `appendPlugins`. B1a
  no las usa.
- **Etiqueta del tier.** La línea de carga es
  `hooks module <label> loaded (<kind>, environment <id>, tier <tier>)`. El binario usa los
  valores `user`, `builtin` y `core` y las posiciones `prepend` y `append`. **La etiqueta exacta del
  tier de organización no está confirmada (H).** El prototipo la fija antes de la corrida;
  mientras no esté fijada, P1 es INCONCLUSIVE.

**Cuándo los mods no corren** (E). Son las razones que el propio CLI enumera:
- "hooks modules are switched off in this process";
- la organización deshabilita todos los hooks;
- prohíbe sideload;
- bloquea plugins de carpetas locales;
- sólo admite hooks administrados;
- `disableAllHooks` en settings;
- modo seguro;
- modo `bare`;
- carpeta no confiable ("the workspace is not trusted").

Interruptor de despliegue: con él apagado los mods instalados no cargan, pero "an organization's and
built-in plugins load regardless" (E).

##### 1.14.14.3 Hallazgos estáticos que cambian el diseño

1. **`allowManagedModsOnly` está bajo el guard.** Es una opción de `cc-plugin-sec-default`; escrita
   en el primer nivel no haría nada. Esto corrige §1.14.6.
2. **El tier de organización exige leer el mod en el lugar.** Hace falta un marketplace de
   directorio declarado en managed settings. Un plugin en la caché, un archivo comprimido o
   `CLAUDE_CODE_PLUGIN_SEED_DIR` cae al tier de usuario.
3. **Hay controles en el arranque que ninguna política puede cerrar.** El agente controla tmux
   (A1), así que puede relanzar el CLI con cualquier entorno, argumentos o binario:
   - `CLAUDE_CODE_MANAGED_SETTINGS_PATH` reemplaza la carpeta de políticas ("this machine's policy
     folder (or the one CLAUDE_CODE_MANAGED_SETTINGS_PATH names)"). Con eso no hay política;
   - lo mismo vale para `CLAUDE_CODE_REMOTE_SETTINGS_PATH`, `CLAUDE_CODE_MOCK_REMOTE_SETTINGS` y
     `CLAUDE_CONFIG_DIR`;
   - `LD_PRELOAD`, `NODE_OPTIONS` y `BUN_OPTIONS` existen en el binario, y el inspector de Bun
     (`BUN_INSPECT`) está compilado. Si un ejecutable autónomo los respeta, dan código o
     depuración **dentro** del proceso (H; lo decide B1b).

   > **Corregido (2026-11-04).** El responsable rechazó I-env tal como está escrito: `environ` y
   > `cmdline` son memoria del proceso y se pueden reescribir. La integridad del arranque pasa a
   > una raíz de confianza del lanzamiento ([09-launch-trust.md](./09-launch-trust.md)). Además,
   > K1 casi seguro no aplica a 2.1.314 (§1.14.15.1, fila 1).

   Una política que el propio proceso lee no puede defenderse de quien elige con qué política
   arranca ese proceso. **Consecuencia:** la inscripción del gateway (B2) tiene que leer como root
   el `environ` y la `cmdline` **iniciales** del CLI y rechazar esas variables y banderas. Es el
   invariante **I-env**, nuevo. B1a mide estos caminos como hechos de clase K y no los cuenta como
   bloqueados.
4. **En producción el binario está en el workspace.** `~/.npm-global` se migra al bind mount del
   workspace, pertenece a uid 1000 y se autoactualiza (`session-image/Dockerfile`). H-ND exige una
   copia de root **fuera** del workspace, y que el gateway ate la identidad a **ese** inodo
   (`/proc/<pid>/exe` → uid 0, modo sin lectura para otros, dispositivo e inodo), no sólo al hash.
   El hash del binario es público y el agente puede bajar la misma versión.
5. **2.1.314 ya se vuelve no volcable a sí mismo en un caso.** El ejecutor de revisiones de código
   llama a `Bun.ant.setDumpable(false)` (`prctl(PR_SET_DUMPABLE,0)`) y explica: "so the review's
   commands could read its tokens from memory". **No hay** ninguna llamada que lo vuelva a 1 (E).
   Es un precedente directo de H-ND en el mismo binario.
6. **El código de Bun se mapea al ejecutar** (E):
   - la sección `.bun`, de 171,5 MiB, está en un `PT_LOAD`, así que el kernel la mapea al
     ejecutar y Bun no necesita leer su propio archivo para cargar el código;
   - en el JS embebido, `/proc/self/exe` sólo se **abre** para el ayudante seccomp del sandbox
     de Bash ("sandbox: failed to open /proc/self/exe …"). Con `0711`, **el sandbox de Bash del
     CLI no funcionaría** (H). Las sesiones hoy no lo usan, pero queda como restricción de
     producto;
   - **el código nativo de Bun no se inspeccionó.** Si el runtime abre su propio archivo por otro
     motivo, se ve en H1 de B1b.
7. **Plugins `@synced` desde claude.ai.** Es otro camino de carga y exige login. Sin login **no se
   prueba** y, por la regla del responsable, no cuenta como bloqueado.
8. **Mods que escribe Claude** ("Turn on the mods Claude writes in this session?",
   `CLAUDE_DEV_MODS_DIR`). Es otro camino de carga con una aprobación de la persona en la terminal.
   **A1 puede contestarla con `send-keys`**, así que B1a la contesta por el agente.

##### 1.14.14.4 B1a: integridad de la instalación (diseño)

**Entorno.** Las mismas reglas que B0 (§1.14.6, §1.14.9): un contenedor descartable con el mismo
`USER`, `CapDrop`, `no-new-privileges` y `PidsLimit`, sin `sessions-net`, nada en D1 y 2.1.314 de la
imagen real.
- **No hace falta construir una imagen:** la imagen ya trae `/etc/claude-code/managed-settings.d/`
  (root, 0755).
- **Dos montajes de solo lectura**, de archivos de root en una carpeta nueva del host:
  - `…/b1a-<STAMP>/managed/` → `/etc/claude-code/managed-settings.d/`;
  - `…/b1a-<STAMP>/marketplace/` → `/opt/st-b1/marketplace/`.
- **Mod administrado `st-b1-probe`:**
  - registra `session.start` y `classic.SessionStart` (más `classic.SessionEnd` al salir);
  - escribe sólo hechos;
  - el marketplace lo lista por ruta relativa (`./plugins/st-b1-probe`).
- **Managed settings propuestas.** Las formas exactas se validan antes de pedir la ejecución, con
  `claude plugin validate` y una carga fuera de línea:

```json
{
  "extraKnownMarketplaces": { "st-b1": { "source": { "source": "directory", "path": "/opt/st-b1/marketplace" } } },
  "strictKnownMarketplaces": [ { "source": "directory", "path": "/opt/st-b1/marketplace" } ],
  "enabledPlugins": { "st-b1-probe@st-b1": true },
  "disableSideloadFlags": true,
  "allowManagedHooksOnly": true,
  "strictPluginOnlyCustomization": true,
  "allowManagedMcpServersOnly": true,
  "allowedMcpServers": [],
  "pluginConfigs": { "cc-plugin-sec-default@builtin": { "options": { "allowManagedModsOnly": true } } }
}
```

**Validación de la configuración aplicada** (como `checklimits` en B0). Se registra:
- los montajes, de solo lectura y de root;
- que uid 1000 no puede crear, renombrar ni borrar en ninguno (`EROFS` o `EACCES`);
- el SHA-256 del archivo de settings visto **dentro** del contenedor, igual al del kit;
- las líneas del debug log donde el CLI lee la política: carpeta, archivos y errores de
  validación. Si hay **cualquier** error de validación de settings, el resultado es
  INCONCLUSIVE.

**Positivas**, todas en el mismo arranque:

| # | Qué se observa | Evidencia exigida |
| --- | --- | --- |
| P1 | `st-b1-probe` carga en el tier de organización | La línea `hooks module st-b1-probe@st-b1 loaded (…, tier <org>)` con la etiqueta fijada en el prototipo, y ninguna advertencia "not treated as the organization's" |
| P2 | El guard está cargado y `allowManagedModsOnly` está en vigor | Línea de carga de `cc-plugin-sec-default@builtin` y la opción leída de `policySettings` |
| P3 | Llegan los eventos `classic.*` | Registros del mod para `classic.SessionStart` (y `classic.SessionEnd` al salir), con `seq` contiguo. **Sin login**, `classic.UserPromptSubmit` y `classic.PreToolUse` **no se prueban**: quedan como hecho no medido, salvo que el responsable decida el login de §1.14.6 |
| P4 | Momento de carga frente a la confianza | Si el mod de organización carga antes o después de aceptar la confianza de la carpeta (en B0, el de `--plugin-dir` esperó). Es un hecho: no decide el veredicto |

**Negativas.** Cada una se ejecuta en un **arranque nuevo** del CLI, como `developer`, con las
mismas managed settings.
- **El intento:** un mod intruso `st-b1-rogue-<n>` que, si corre, escribe una marca en una
  carpeta que el analizador recoge. Si el camino no es de mods sino de hooks o MCP, el intruso es un
  hook de comando o un servidor que escribe la marca.
- **Cada intento cuenta como bloqueado sólo con las tres cosas a la vez:**
  1. **no hay marca;**
  2. **el control del mismo arranque está presente:** `st-b1-probe` registró `session.start` en
     ese proceso, o el CLI terminó con el mensaje de rechazo documentado;
  3. **aparece la línea de rechazo** que el binario usa para ese camino.
- **Si falta 2 o 3, el intento es INCONCLUSIVE**, nunca "bloqueado".

| # | Camino | Rechazo esperado (texto del binario) |
| --- | --- | --- |
| N1 | `--plugin-dir <intruso>` | Sale: "--plugin-dir is disabled by your organization's managed settings (disableSideloadFlags)" |
| N2 | `--plugin-dir-no-mcp` | Igual que N1 |
| N3 | `CLAUDE_CODE_PLUGIN_DIRS=<intruso>` | Igual que N1, con la indicación de la variable |
| N4 | `--plugin-url` (servidor HTTP local del harness) | Igual que N1 |
| N5 | `--agents` y `--mcp-config` (no SDK) | Igual que N1 |
| N6 | `~/.claude/settings.json` con `extraKnownMarketplaces` y `enabledPlugins` hacia un marketplace intruso | `strictKnownMarketplaces` lo rechaza, o el mod queda en el tier de usuario y no carga por `allowManagedModsOnly` |
| N7 | Lo mismo en `.claude/settings.json` (proyecto) y `.claude/settings.local.json` | Igual que N6 |
| N8 | `--settings <archivo>` con lo mismo | Igual que N6 |
| N9 | `claude plugin marketplace add <dir>` y `claude plugin install` | "blocked by your organization's policy" o "marketplace-blocked-by-policy" |
| N10 | Copia **con el mismo nombre** `st-b1-probe` en `~/.claude/plugins/cache/…` (impostor) | Carga sólo la del lugar, en el tier de organización; la copia no corre |
| N11 | `CLAUDE_CODE_PLUGIN_CACHE_DIR` hacia una caché del agente con el impostor | Igual que N10 |
| N12 | `CLAUDE_CODE_PLUGIN_SEED_DIR` con el impostor | Tier de usuario ⇒ no carga ("from a copy … not treated as the organization's") |
| N13 | `CLAUDE_CODE_PLUGIN_USE_ZIP_CACHE=1` con la caché del agente | Igual que N12 |
| N14 | Plugin con módulo de hooks en `~/.claude/skills` (`@skills-dir`) | "Plugins from … are blocked by your organization's managed settings (strictKnownMarketplaces …)" |
| N15 | Mods que escribe Claude (`CLAUDE_DEV_MODS_DIR`), con la pregunta de aprobación **contestada por el harness** vía tmux, como haría A1 | "mods are limited to your organization's by policy (allowManagedModsOnly)" |
| N16 | Hooks de comando en settings de usuario, proyecto y local | Ignorados por `allowManagedHooksOnly` |
| N17 | `.mcp.json` y `claude mcp add` (stdio) | Rechazados por `allowedMcpServers: []` |
| N18 | `disableAllHooks: true` en settings de usuario | No se exige rechazo: es un hecho de disponibilidad. Se registra si apaga nuestro mod. Apagarlo nunca produce evidencia válida |
| N19 | `CLAUDE_CONFIG_DIR` hacia una carpeta del agente con settings intrusas | Tier de usuario ⇒ no carga |

**Clase K: controles del arranque que la política no puede cerrar.** Se miden como hechos. **Nunca
se cuentan como bloqueados**, y cada uno pasa a B2 como requisito de I-env.

| # | Camino | Qué se registra |
| --- | --- | --- |
| K1 | `CLAUDE_CODE_MANAGED_SETTINGS_PATH=<carpeta del agente>` | Si carga el intruso. Esperado: sí, porque no hay política |
| K2 | `CLAUDE_CODE_REMOTE_SETTINGS_PATH` y `CLAUDE_CODE_MOCK_REMOTE_SETTINGS` | Igual que K1 |
| K3 | `--bare`, modo seguro | Si nuestro mod deja de cargar (disponibilidad) |
| K4 | Otro binario del CLI (la copia del workspace o una bajada por el agente) | Va a B1b y B2: identidad del inodo |
| K5 | `LD_PRELOAD`, `NODE_OPTIONS`, `BUN_OPTIONS`, `BUN_INSPECT` | Van a B1b (H8) y a B2 (#9) |

**Veredicto de B1a** (estricto; el analizador sigue el modelo de B0):
- **PASS** sólo si se cumple todo esto:
  - captura completa;
  - CLI 2.1.314 antes y después;
  - configuración aplicada verificada y sin errores de validación;
  - P1, P2 y P3 (sin las partes que exigen login);
  - **cada** N1–N17 y N19 intentado, con la marca ausente, el control presente y la línea de
    rechazo.

  Los hechos K se informan aparte. El texto del veredicto dice que la integridad de la instalación
  **depende de I-env**.
- **FAIL:**
  - cualquier marca de un intruso en N1–N17 o N19;
  - el mod administrado cargó en el tier de usuario;
  - el guard no cargó con `allowManagedModsOnly` definido;
  - un impostor (N10–N13) corrió en lugar del mod administrado o junto con él.
- **INCONCLUSIVE:**
  - un N no ejecutado, o sin control ni línea de rechazo;
  - la etiqueta del tier no fijada;
  - errores de validación de settings;
  - el mod administrado no cargó;
  - versión distinta;
  - captura incompleta.

  **Un camino no probado nunca cuenta como bloqueado.** `@synced` (sin login) queda listado como
  **no probado**.

##### 1.14.14.5 B1b: H-ND, por separado (diseño)

**Qué afirma:** un CLI 2.1.314 ejecutado desde un archivo de **root con modo `0711`**:
1. arranca y funciona;
2. queda no volcable;
3. no puede ser leído ni adjuntado por el mismo uid, ni siquiera por un ancestro.

**Base en el kernel** (K, tag de VM100):
- `would_dump()` marca `BINPRM_FLAGS_ENFORCE_NONDUMP` cuando quien ejecuta no puede leer el
  archivo, y lleva `mm->user_ns` hasta un namespace con privilegios sobre el inodo: el inicial,
  para un archivo de root.
- `begin_new_exec()` entonces llama a `set_dumpable(mm, suid_dumpable)`, nunca a
  `SUID_DUMP_USER`.
- `__ptrace_may_access()` niega cuando dumpable ≠ `SUID_DUMP_USER` y no hay capacidad en
  `mm->user_ns`. Eso aplica también a los ancestros: Yama no lo cambia.
- `environ`, `auxv`, `fd`, `maps` y `mem` (este último en modo ATTACH) pasan por esa
  comprobación.
- `cmdline` y `status` siguen legibles: **nada secreto puede ir en los argumentos.**

**Variante aislada sin construir imagen** (recomendada). Usa un contenedor descartable de la imagen
real; la imagen no se toca.
1. Con `docker exec -u 0` (root sin capacidades, `CapDrop: ALL`):
   `install -d -o root -g root -m 0755 /opt/st-hnd` y
   `install -o root -g root -m 0711 <claude.exe de la imagen> /opt/st-hnd/claude-2.1.314`.
2. Comprobar el SHA-256 contra `4487042b…`.
3. Lanzar el CLI como `developer` desde esa ruta.
- **Si el responsable prefiere una imagen variante** (`FROM` la imagen por su ID, con la copia
  `0711`), eso es construir una imagen y necesita su autorización. Queda como alternativa.
- **En los dos casos** hay que registrar en el preflight:
  - `fs.suid_dumpable` y `kernel.core_pattern`;
  - `ptrace_scope`;
  - si Docker usa `userns-remap`.

**Comprobaciones:**

| # | Qué | Evidencia | FAIL si |
| --- | --- | --- | --- |
| H1 | Arranque y funcionamiento | `--version` = 2.1.314; arranque interactivo hasta la pantalla de confianza; el mod de B0 (`--plugin-dir`, sin managed settings en B1b) registra `session.start` y una llamada `$.process.run` | No arranca, o falla al leerse a sí mismo (`EACCES` sobre su archivo) |
| H2 | Estado efectivo | Las entradas de `/proc/<pid>/` del CLI pertenecen a root (`task_dump_owner` con dumpable ≠ 1), medido al inicio, después de cargar el mod y a los 5 min | Alguna medición con dueño uid 1000 (dumpable volvió a 1) |
| H3 | Lectura desde el mismo uid, **no** ancestro | `environ`, `auxv`, `maps`, `mem`, `readlink fd/*` y `fdinfo`; `process_vm_readv`; `ptrace(PTRACE_SEIZE)`; `pidfd_getfd`. Cada intento con su errno | Cualquier lectura o adjunción tiene éxito |
| H4 | Lo mismo desde un **ancestro controlado** | Un padre `python3` del harness hace `fork` + `exec` del CLI y prueba H3. Yama `ptrace_scope=1` le permitiría adjuntarse; H-ND no | Ídem |
| H5 | Volcados de memoria | Como el agente: `prlimit --core=unlimited` y `kill -SEGV` al CLI. Se busca cualquier core legible por uid 1000 (cwd, `/tmp`, la ruta de `core_pattern` vista desde el contenedor) | Aparece un core legible |
| H6 | Copias y reemplazo | (a) `/opt/st-hnd` y el binario no se pueden escribir, renombrar ni borrar como uid 1000; (b) el inventario de copias **legibles** del CLI en el contenedor (por SHA-256 y nombre) se registra; la copia de la imagen en `~/.npm-global` existe y es esperada; (c) `/proc/<pid>/exe` del CLI lanzado es el inodo de `/opt/st-hnd` | (a) se puede reemplazar; (c) no es ese inodo |
| H7 | Actualización | Con el autoactualizador **habilitado**, durante 10 min; además `claude update` y `npm i -g` como uid 1000. Se mira que el proceso siga en el inodo de `/opt` y que `/opt` no cambie | El proceso se relanza desde otro binario por sí solo, o `/opt` cambia |
| H8 | Inyección dentro del proceso (clase K) | Relanzar el binario `0711` con `BUN_INSPECT`, `BUN_OPTIONS=--preload …` o `NODE_OPTIONS=--require …`. `LD_PRELOAD` necesita una biblioteca compilada que la imagen no trae: no se prueba en B1b y queda para B2 | No decide el veredicto. Se informa si alguna da código dentro del proceso: entonces H-ND sólo vale con I-env |
| H9 | Sandbox de Bash | Si el sandbox del CLI está activo, `/proc/self/exe` no se puede abrir | No decide el veredicto. Restricción de producto |

**Límite de H6(c).** Con dumpable ≠ 1, uid 1000 no puede hacer `readlink /proc/<pid>/exe`, y un
root sin capacidades dentro del contenedor tampoco. Medirlo exige un lector con `CAP_SYS_PTRACE` en
el host, que es lo que tendría el gateway. **Decisión del responsable:** autorizar un `stat` de
solo lectura como root en el host para H6(c), o dejar H6(c) INCONCLUSIVE en B1b y probarlo en B2.

**Veredicto de B1b**, que se informa **siempre aparte** de B1a:
- **PASS:** H1–H7 cumplidas.
- **FAIL:** cualquier fila de H1–H7 en estado FAIL. Un FAIL de H1 (no arranca) significa que H-ND
  no es viable para 2.1.314: A5 queda como residuo y se vuelve a §1.14.7.
- **INCONCLUSIVE:** precondiciones distintas (`ptrace_scope`, `suid_dumpable`, `userns-remap`),
  una fila no ejecutada, H6(c) sin lector autorizado o captura incompleta.

**Limitaciones de H-ND**, aunque pase:
- protege sólo al proceso ejecutado desde ese inodo. Un CLI relanzado desde una copia legible es
  volcable, así que el gateway tiene que atar la identidad al inodo (hallazgo 4);
- no protege de código que corre **dentro** del proceso: `LD_PRELOAD`, opciones de Bun o Node, el
  inspector. Eso es I-env;
- `cmdline` y `status` siguen legibles;
- los hijos (Bash) son volcables después de su `exec`. Nada secreto puede llegarles por el entorno;
- depende de `suid_dumpable` para los volcados y de no tener `userns-remap`, y vale para el kernel
  medido;
- es incompatible con el sandbox de Bash del CLI (hallazgo 6).

##### 1.14.14.6 Kit, fases y limpieza (reutiliza B0)

**Kit nuevo** en `poc/channels-phase0`, `poc/passb1/`, por SHA con hashes y lista exacta:
- `run-b1a.sh` y `run-b1b.sh`, con las mismas fases (`preflight`, `setup`, `servers` si hace falta,
  `measure`, `capture`, `validate`, `cleanup`);
- marcas `state/<fase>.ok`;
- **fundamento obligatorio para borrar** (`captured`, `no-evidence`, `discard-authorized`);
- comprobación del id del contenedor y de la versión del CLI antes y después.

**El `measure` de B1a** ejecuta N1–N19 de forma **secuencial**, un arranque del CLI por intento. El
harness:
- lanza cada arranque en tmux;
- acepta sólo la confianza, el tema y la pregunta de N15;
- no hace login;
- espera la marca del control o la salida del CLI.

**Analizadores:**
- `analyze-b1a.py` y `analyze-b1b.py`, de biblioteca estándar;
- una prueba sintética por criterio, con mutaciones, como en B0;
- los informes llevan alias, booleanos y textos de rechazo **por plantilla**, nunca el log crudo.

**La evidencia queda en VM100.** A la PR sólo llegan veredictos y hechos depurados.

##### 1.14.14.7 Riesgos

| Riesgo | Efecto | Mitigación |
| --- | --- | --- |
| La forma exacta de las claves (`extraKnownMarketplaces` anidado, etiqueta del tier) difiere de lo leído | P1 INCONCLUSIVE o mod no cargado | Validar las settings fuera de línea con el CLI local antes de pedir la corrida, sin VM100 |
| Muchos caminos de carga (más de 20) y versiones futuras con caminos nuevos | Un camino nuevo sin probar | La lista vale **sólo** para 2.1.314; cada versión nueva repite la inspección (R9) |
| K1/K2: la política se reubica por entorno | Sin I-env, B1a no protege nada frente a un relanzamiento | I-env en el gateway (B2) y prueba adversarial |
| `@synced` y eventos que exigen login | Caminos o eventos no probados | Listados como no probados; login sólo con la decisión de §1.14.6 |
| H-ND rompe el arranque de Bun | A5 queda como residuo | B1b separado; §1.14.7 |
| Lectura de `/proc/<pid>/exe` como root en el host para H6(c) | Operación privilegiada nueva | Decisión explícita, o diferirla a B2 |
| `0644` y archivos de control | Exposición en el host | Ningún material de clave en B1. Los archivos de settings y marketplace son de root y sin secretos |
| El harness contesta preguntas de la terminal (confianza, N15) | Simula a A1; si se equivoca de pantalla, el arranque queda trabado | Respuestas por plantilla de pantalla y tiempo límite ⇒ INCONCLUSIVE |

##### 1.14.14.8 Decisiones que se piden al responsable

1. Revisar este diseño. Con su aprobación, **GO para escribir el kit** `poc/passb1`: código, tests
   sintéticos y validación local de las settings con el CLI de este contenedor. No toca VM100.
2. **B1b:** la variante sin imagen (`docker exec -u 0` en el descartable) o una imagen variante.
3. **H6(c):** un `stat` como root en el host, o diferirlo a B2.
4. **Login** para las partes de P3 que lo exigen y para `@synced`: mantener "sin login"
   (recomendado) o autorizarlo en el descartable.
5. **I-env:** aceptar que la integridad de la instalación (B1a) se declare dependiente de la
   inscripción del gateway, y agregar K1–K5 a los ataques de B2.

#### 1.14.15 Kit PASS-B1 (`e00ef29`): implementación, validación local, procedimiento y criterios (**no ejecutado en VM100**)

**GO del responsable (2026-11-04):**
- **Autoriza:** implementar el kit `poc/passb1`, con tests sintéticos y validaciones locales.
- **No autoriza:**
  - ejecutar en VM100;
  - construir imágenes;
  - cambios de producción;
  - merge ni deploy.
- G3, G3-A, R8 y Composer no cambian.

**Decisiones aplicadas:**
1. **B1a.** Positivas y N1–N19 con controles que fallan cerrados. Un camino no ejecutado nunca
   cuenta como bloqueado.
2. **B1b.** Copia de root `0711` dentro del descartable, sin construir imagen. No se relaja ni
   `CapDrop ALL` ni `no-new-privileges`. Si la preparación falla, el resultado es INCONCLUSIVE.
3. **H6c.** Diseñada (`b1.py hostexe`, solo lectura, con identidad estricta por pidfd y
   `starttime`) y **bloqueada**: se niega a correr (salida 77) salvo que
   `B1B_HOSTEXE_AUTHORIZED` sea el id del contenedor, y ningún procedimiento la define. B1b la
   informa como pendiente.
4. **Sin login.** N15, `@synced` y los eventos de prompt y herramientas quedan como cobertura
   pendiente, nunca como bloqueados.
5. **K1–K5** pasan a B2, con resultados separados de B1a. La raíz de confianza del lanzamiento
   está en [09-launch-trust.md](./09-launch-trust.md).

##### 1.14.15.1 Correcciones a §1.14.14 por la implementación y la validación local

**Validación local.** Se hizo en este contenedor de desarrollo con el mismo CLI 2.1.314 (SHA-256
`4487042b…`) y el mismo kernel 6.8.0-147, con estas condiciones:
- HOME aislado por intento y entorno vacío (`env -i`);
- sin login ni credenciales;
- **sin política administrada**: `/etc/claude-code` es de root, así que el tier de organización no
  se puede probar acá.

| # | Hallazgo | Consecuencia |
| --- | --- | --- |
| 1 | **K1 casi seguro no es un bypass en 2.1.314.** La función que leería `CLAUDE_CODE_MANAGED_SETTINGS_PATH` está vaciada en el build publicado (`function Kus(){return}`), y el CLI local, con la variable definida, leyó `/etc/claude-code/managed-settings.json` igual | Se corrige el hallazgo 3 de §1.14.14.3. K1 sigue en B2 como medición |
| 2 | Las managed settings de `managed/b1a.json`, cargadas como settings de usuario, **no dan errores de validación**. El marketplace de directorio se lee en el lugar y el probe carga y registra `session.start`, `classic.SessionStart` y `classic.SessionEnd` **sin login**. Las plantillas reales del log son `hooks module <x>@<mk> loaded (worker, environment N, tier T)` y `plugin.register: <x> (T, …), judged by …` | Formas y plantillas confirmadas. La etiqueta del tier de organización sigue sin fijar: el analizador acepta sólo `prepend`/`append` y cualquier otra da INCONCLUSIVE |
| 3 | **Controles positivos.** Cada fixture intruso **corre** cuando no hay política (tabla de abajo). Sin eso, que falte una marca no probaría nada | Cada intento puede producir un FAIL real |
| 4 | **Errores del harness encontrados y corregidos:** las teclas mandadas juntas se pierden en el selector de confianza (ahora con pausa y reintento); el diálogo de servidores MCP del proyecto no está numerado y su opción por defecto es "Continue without…" | Sin estas correcciones, un intento podía quedar "sin marca" porque nunca llegó al punto de cargar el intruso |
| 5 | **N12:** el directorio de semillas se sincroniza **después** de la carga de plugins del arranque, así que lo que trae carga en el **segundo** arranque del mismo HOME. Además `known_marketplaces.json` exige `lastUpdated` | N12 se hace con dos arranques |
| 6 | **N16:** 2.1.314 no registra que una política salteó un hook. Como evidencia de que el ataque se encontró se usan dos líneas: la del vigilante de settings, que nombra los tres archivos con hooks, y la de `post-trust`. Un hook que corre deja `Hooks: SessionStart:…`, y eso es FAIL | Evidencia decisiva definida y probada |
| 7 | **N17:** el CLI nombra cada servidor (`MCP server "<nombre>"`). La salida de `claude mcp add` sólo dice que se escribió la entrada, así que no cuenta como evidencia | Evidencia tomada sólo del debug del CLI |
| 8 | **N15:** los dev mods los entrega una skill y se preguntan al terminar un turno. Eso necesita el modelo, o sea login | Pendiente |
| 9 | **H5:** en este host, `fs.suid_dumpable=2` y `core_pattern` es una tubería (apport). Un core de un proceso no volcable iría, como root, al manejador **del host** (`fs/coredump.c`). Con `0` no hay core | H5 es **analítica**: no se provoca ningún crash |
| 10 | **`/proc/<pid>/fdinfo/`** conserva el euid de la tarea aunque no sea volcable: es un directorio r-x para todos (`task_dump_owner`) | H2 no lo cuenta como señal |
| 11 | **H7 sin red.** B1b usa `--network none`, así que ninguna versión nueva del CLI entra al contenedor. Se prueba que `update` no toca la copia de root (hash, dueño y modo antes y después) y que el mismo proceso sigue igual | Cumple "sin versiones nuevas del CLI" |
| 12 | **H8 (nuevo, sólo informativo).** El probe registra si el código de un mod alcanza `Bun.ant.setDumpable`, con `typeof` y sin llamarlo. El kernel deja que un proceso vuelva a ser volcable (`prctl(PR_SET_DUMPABLE,1)`), así que H-ND vale sólo mientras no corra código ajeno en el CLI | Se informa aparte, sin entrar en el PASS |

**Controles positivos locales** (driver final, sin política; una fila por intento):

| Intento | Camino | Marca sin política |
| --- | --- | --- |
| N1 | `--plugin-dir` | `st-b1-rogue-n1` |
| N2 | `--plugin-dir-no-mcp` | `st-b1-rogue-n2` |
| N3 | `CLAUDE_CODE_PLUGIN_DIRS` | `st-b1-rogue-n3` |
| N4 | `--plugin-url` (zip en loopback) | `st-b1-rogue-n4` |
| N5a | `--agents` | ninguna: una definición de agente no ejecuta código; en B1a sólo cuenta el rechazo al arrancar |
| N5b | `--mcp-config` | `mcp-n5b` |
| N6 | settings de usuario + marketplace intruso | `st-b1-rogue-n6` |
| N7a | `.claude/settings.json` | `st-b1-rogue-n7a` |
| N7b | `.claude/settings.local.json` | `st-b1-rogue-n7b` |
| N8 | `--settings` | `st-b1-rogue-n8` |
| N9 | `plugin marketplace add` + `plugin install` | `st-b1-rogue-n9` |
| N12 | `CLAUDE_CODE_PLUGIN_SEED_DIR` (dos arranques) | `st-b1-rogue-n12` |
| N14 | `~/.claude/skills` (`@skills-dir`) | `st-b1-rogue-n14` |
| N16 | hooks de usuario, proyecto y local | `hook-user`, `hook-project`, `hook-local` |
| N17 | `.mcp.json` + `claude mcp add` | `mcp-project`, `mcp-user` |
| N19 | `CLAUDE_CONFIG_DIR` | `st-b1-rogue-n19`, `hook-n19` |

N10, N11 y N13 (impostores del probe administrado) sólo tienen sentido frente al marketplace administrado, que acá no existe: su evidencia en VM100 es que el probe se leyó en el lugar, en el tier de organización, y que el impostor no corrió. P0 y N18 necesitan la política administrada.

##### 1.14.15.2 Contenido del kit

`poc/channels-phase0@e00ef29e13a774859435909bc7a842c65a515ee5`, carpeta `poc/passb1/` (la lista exacta está en los hashes):
- **`run-b1.sh`:** runner por fases. Mismo modelo fail-closed que B0:
  - marcas de estado;
  - lector estricto de `env`;
  - borrado sólo con fundamento y por id exacto;
  - versión del CLI antes y después.

  `KIND=b1a` o `KIND=b1b` en `BASE/env`. Cada experimento usa su propia carpeta, `STAMP`,
  contenedor y veredicto.
- **`b1.py`:** el driver de intentos y las mediciones de H-ND. Además, `checklimits` compara los
  montajes exactos, y `applied` calcula los hashes y prueba la escritura de la política y del
  marketplace montados.
- **`managed/b1a.json`, `marketplace/` y el probe `st-b1-probe`.**
- **Analizadores:** `analyze_b1a.py` y `analyze_b1b.py`.
- **`README.md`.**
- **Tests:**

| Suite | Tests | Qué cubre |
| --- | --- | --- |
| `test_analyze_b1a.py` | 6 (37 mutaciones de criterio) | Fixture PASS con las plantillas reales; un marcador es FAIL; cada falta de control o de evidencia es INCONCLUSIVE |
| `test_analyze_b1b.py` | 4 (32 mutaciones de criterio) | Fixture PASS; control positivo obligatorio; H4b y H8 sólo informativos |
| `test_b1.py` | 15 | Procesos reales: objetivo no volcable (`prctl(0)`) frente a control volcable, desde otro proceso y como ancestro con ptrace real; `immut` sin destruir; inventario; fixtures; `checklimits`; `hostexe` bloqueada |
| `test_runner.py` | 22 | Runner con `docker` falso: orden de fases, STOP por versión, política o marketplace distintos del kit, montajes exactos, la copia de root sin relajar el contenedor, preparación fallida ⇒ cerrado, una copia que no arranca es evidencia, control que no arranca ⇒ cerrado, todos los fundamentos de `cleanup` |

**Mutaciones de código:** 28, todas detectadas. Cubren los analizadores, `b1.py` y el
runner:
- ignorar marcadores;
- no exigir el texto de rechazo;
- aceptar cualquier tier;
- no exigir evidencia;
- dar por bloqueado un impostor sin evidencia;
- ignorar un hook que corrió;
- contar la salida de `mcp add`;
- ignorar el guard sin asiento;
- política escribible;
- hash del kit;
- intento faltante;
- sin control positivo;
- H2, H3, H4, H5, H6a y H7 ignorados;
- preparación sin verificar;
- contar `fdinfo`;
- `immut` sin restaurar;
- lectura de `environ` falsificada;
- `hostexe` sin bloqueo;
- capacidades sin verificar;
- hash de la copia sin verificar;
- descarte con cualquier id;
- política sin comparar;
- contenedor detenido tomado como "sin evidencia".

##### 1.14.15.3 Procedimiento (borrador; **no autorizado**)

Cada experimento usa su propia carpeta y su propio paso 0. En los dos, `IMAGE=shared-terminal-session`
(2.1.314).

```bash
# Paso 0 (como en §1.14.9), con KIND=b1a o KIND=b1b. Se ejecuta como un script.
bash -euo pipefail -s <<'STEP0'
KIND=b1a                    # o b1b
COMMIT=e00ef29e13a774859435909bc7a842c65a515ee5
STAMP=$(date +%Y%m%d-%H%M%S)
BASE=$HOME/pass$KIND-$STAMP
test ! -e "$BASE"
mkdir -m 0700 "$BASE"; mkdir -m 0700 "$BASE/kit" "$BASE/results"
gh api "repos/gatof81/shared-terminal/tarball/$COMMIT" > "$BASE/kit.tgz"
tar xzpf "$BASE/kit.tgz" -C "$BASE/kit" --strip-components=1
cat > "$BASE/kit.sha256" <<'SUMS'
6334bcbf90e51ddf82e2c470947b072171d3b033efb06db65f505499f2683dcc  analyze_b1a.py
e33dc88811b9472ccbea4819e8af0cf9443ec575e76d8c1385d804fc9b87011f  analyze_b1b.py
f20ea9f36029a15bb7a57b7b9828c1e89a9af2822589cd632e256fb075379165  b1.py
23a02a6dd40271761c57dcfe6ed265e550aacab8afda376fd0fa3e670c488932  managed/b1a.json
3a090f524c93fa3be45fa35ebd347b86ffe47801cacf6ede819095ecd71e2a55  marketplace/.claude-plugin/marketplace.json
c38e42b9a8ba4360b72465813088fe98b5e69a7ff5bf16ec4a43bc56ccb75514  marketplace/plugins/st-b1-probe/.claude-plugin/plugin.json
d87f4cbc7a53b0d733c13dd4c7f81e49d7ede3b21163e0d64e2234176d43100d  marketplace/plugins/st-b1-probe/hooks/hooks.json
707c35831bd4fa99d4e21f550c64a52de1ae2172c7fe5e4bdab16fb4245e0cf7  marketplace/plugins/st-b1-probe/hooks/register.mjs
bb37c017652ba5b6c93423a66cfa39434ceb852878b7bd1bc517343ed2a323e7  README.md
f6bdc2f32a9a873c00543fdded1c987706f6e0ccb509e9229a64f7791a3efdac  run-b1.sh
1845ebe18b0f73588cadb23ae345dd61f0ae68df52cc30f723366fa64ae958ec  test/fakebin/docker
8a55c015c59ef4cc85f81c743fd33fc36f30151941ad5eae9b5eea04000ef41f  test/test_analyze_b1a.py
a45744f700d780ee041179a919fe4f87d153049bb01b9287735e11ce2e92bf14  test/test_analyze_b1b.py
e2b086bf3896b95046921be7c652cfccfbf457b23cc591ebd7b3c7c4eec048cb  test/test_b1.py
11d866b6c116017c85ae2521b451859b9bf97a03f11248fe4cca85fd259f35ae  test/test_runner.py
SUMS
cd "$BASE/kit/poc/passb1"
sha256sum -c --strict --quiet "$BASE/kit.sha256"
diff <(find . -type f | sed 's|^\./||' | sort) <(awk '{print $2}' "$BASE/kit.sha256" | sort)
KIT=$BASE/kit/poc/passb1
extra=""
if [ "$KIND" = b1a ]; then
  # Copias del kit, legibles por uid 1000 y montadas en solo lectura.
  mkdir -m 0755 "$BASE/managed"; cp "$KIT/managed/b1a.json" "$BASE/managed/"; chmod 0644 "$BASE/managed/b1a.json"
  cp -r "$KIT/marketplace" "$BASE/marketplace"; chmod -R a+rX "$BASE/marketplace"
  extra="MAN=$BASE/managed MKT=$BASE/marketplace"
fi
printf '%s\n' "KIND=$KIND" "STAMP=$STAMP" "KIT=$KIT" "RES=$BASE/results" "EXP=pass$KIND-exp-$STAMP" \
  "IMAGE=shared-terminal-session" "COMMIT=$COMMIT" $extra > "$BASE/env"
echo "BASE=$BASE"; echo "OK: paso 0"
STEP0
```

```bash
BASE=~/passb1a-AAAAMMDD-HHMMSS      # el que imprimió el paso 0
R() { bash "$BASE/kit/poc/passb1/run-b1.sh" "$BASE" "$1"; echo "fase $1: salida=$?"; }
R preflight    # solo lectura; 3 = STOP por versión
R setup        # crea el contenedor y verifica lo aplicado (B1b: además prepara la copia de root)
R measure      # B1a: 21 arranques secuenciales (unos 20 min); B1b: unos 8 min (incluye 5 min de observación)
R capture      # 4 = captura incompleta: la evidencia queda y validate dará INCONCLUSIVE
R validate     # imprime report.json; salida 0 sólo con PASS
R cleanup      # 66: evidencia sin copia verificada; 67: algo que no es nuestro o no quedó limpio
```

**Notas:**
- **Nada se hace en una terminal B.** El harness lanza cada CLI en tmux dentro del contenedor y
  contesta sólo lo que el agente podría contestar: confianza, tema y servidor MCP del proyecto.
  No hay login.
- **`preflight` falla** si queda **cualquier** contenedor `passb0` o `passb1`.
- **B1a y B1b no corren a la vez.** Los dos usan la etiqueta `passb1.experiment`.
- **Qué mandar:** `report.json` y `removal.json`. Los logs filtrados y los registros quedan en
  `$BASE/results`, en VM100.

##### 1.14.15.4 Criterios

**B1a** (`analyze_b1a.py`):
- **PASS** sólo si se cumple todo esto:
  - captura completa;
  - 2.1.314 en `preflight`, antes y después;
  - política y marketplace iguales a los del kit, sólo `b1a.json` y sin escritura posible;
  - sin errores de validación;
  - P0 con:
    - el probe en tier `prepend`/`append`;
    - sin advertencia "not treated as the organization's";
    - `session.start` y `classic.SessionStart`;
    - el guard asentado y cargado;
  - **cada** N1–N14, N16, N17 y N19 bloqueado: sin marcador, con el control del mismo arranque
    y con evidencia decisiva.
- **FAIL:**
  - cualquier marcador;
  - un hook que corrió (N16);
  - el probe en tier `user`;
  - el guard sin asiento;
  - la política o el marketplace escribibles.
- **INCONCLUSIVE:**
  - el resto: intento faltante, sin control, sin evidencia, etiqueta de tier desconocida,
    settings inválidas, versión, captura.
- **Siempre se informan:**
  - lo pendiente (N15, `@synced`, eventos con login);
  - que la integridad final depende de la raíz de confianza del lanzamiento;
  - N18 como hecho.

**B1b** (`analyze_b1b.py`):
- **PASS** sólo si se cumple todo esto:
  - la copia de root es la esperada (hash, uid 0, `711`);
  - el control positivo es legible en modo READ;
  - H1: la copia de root arranca y el mod corre;
  - H2/H3: dos muestras, al inicio y a los 5 min, con dueño root y todas las lecturas negadas;
  - H4: como ancestro, todo negado, y el control legible como ancestro;
  - H5: `suid_dumpable` 0 o 2;
  - H6a: la copia y su carpeta no se pueden cambiar;
  - H6b: la copia de root existe y no es legible;
  - H7: `update` no la cambia y el proceso es el mismo.
- **FAIL:** cualquier fila que falle, incluido "no arranca" (H1).
- **INCONCLUSIVE:** preparación fallida, control ciego, `ptrace_scope` ≠ 1, faltantes o captura.
- **Siempre aparte:** H4b (un trazador previo al `exec` conserva los registros), H8 y H6c
  (pendiente).
- **Alcance:** B1b **no** prueba la integridad del proceso, sólo el acceso de otros procesos.

##### 1.14.15.5 Revisión de seguridad del kit

- **Sin privilegios nuevos fuera del contenedor descartable.** B1a no usa root. B1b usa
  `docker exec -u 0` dentro del descartable, con `CapDrop: ALL` y `no-new-privileges`: es root sin
  capacidades, que sólo puede crear archivos en carpetas de root.
- **Sin red en B1b** (`--network none`). B1a usa `bridge` para que el CLI arranque como en B0;
  N4 sirve su zip en el loopback del propio contenedor.
- **H5 sin crash.** Con este host (`suid_dumpable=2` y apport), un crash enviaría un core al host.
- **H6c bloqueada** en el código y fuera del procedimiento.
- **Lo que sale de VM100:** sólo veredictos y hechos (alias, booleanos, errno, clases de ruta).
  Los logs del CLI se filtran dentro del contenedor y los crudos se borran con él.
- **Los fixtures intrusos son inofensivos:** sólo crean un archivo de marca en carpetas del
  intento.

##### 1.14.15.6 Primera revisión independiente (2026-11-04)

GO del responsable para corregir el kit y los documentos; NO-GO para ejecutar en VM100, construir
imágenes, mergear, desplegar o tocar sesiones reales.

**B1a — evitar falsos PASS:**
- **Impostores (N10/N11/N13).** "Blocked" ya no sale de que el probe administrado cargue bien. El
  intento se da por bloqueado sólo si el CLI **consideró** la copia plantada: una línea del debug
  que **nombra la ruta exacta** donde se plantó (la registra `b1.py` en `impostor_paths`) y el
  probe se leyó en el lugar. Si el CLI nunca miró esa ruta, es INCONCLUSIVE
  (`impostor-location-not-considered`), a resolver con el log de VM100. Tests nuevos para los dos
  casos.
- **Un mod intruso que CARGÓ es FAIL aunque no deje marca.** El analizador marca FAIL si el debug
  tiene `hooks module st-b1-rogue-… loaded (` o `plugin.register: st-b1-rogue-…`, sin depender del
  archivo de marca. Cubre "un plugin cargado que no emitió la marca".
- **`classic.SessionEnd`.** El diseño nombraba `SessionStart` y `SessionEnd`, pero el intento
  termina con C-c y `SessionEnd` puede no dispararse. Se **reduce el alcance**: el PASS exige
  `classic.SessionStart`; `SessionEnd` se informa como hecho (`classic_session_end_seen`).
- **Validación de settings en todos los intentos**, no sólo P0: cualquier error de validación en
  cualquier log da INCONCLUSIVE (`settings-invalid`, con la lista en `settings_invalid_in`).
- **Correlación reforzada.** Un intento es bloqueado sólo con el control del mismo arranque (el
  probe en tier de organización, o el rechazo al arrancar) **y** evidencia decisiva de que el CLI
  encontró el ataque. La sola ausencia de marca nunca basta.
- **`--network none`.** Confirmado que N4 sirve su zip en el loopback del propio contenedor, que
  existe con `none`, y que `disableSideloadFlags` rechaza `--plugin-url` antes de cualquier fetch.
  B1a ya no usa `bridge`: ninguna red externa en ninguno de los dos experimentos.
- N15, `@synced` y los eventos con login siguen como cobertura pendiente, nunca bloqueados.

**B1b — controles positivos por operación:**
- **Una negación se acredita a H-ND sólo si la misma operación tiene éxito contra el control**
  (la misma CLI desde la copia legible), bajo las mismas condiciones. Eso descarta una causa
  independiente (seccomp, `/proc` ausente).
- **READ y ATTACH separados.** Yama 1 restringe sólo ATTACH. Para un lector **no ancestro**:
  - READ (`environ`, `auxv`, `maps`) se juzga en el caso no-ancestro; el control debe poder leer;
  - ATTACH (`mem`, `process_vm_readv`, `ptrace`, `pidfd_getfd`) a un no-ancestro lo niega Yama
    aunque el proceso sea volcable, así que **no se atribuye a H-ND**: es un hecho. ATTACH se
    demuestra en H4 (ancestro), donde Yama deja que un ancestro se adjunte a un hijo volcable.
- **H4** exige éxito del control por operación (READ y ATTACH) o queda INCONCLUSIVE.
- **H4b** sigue como riesgo residual explícito: un trazador anterior al `exec` conserva los
  registros.
- **H5 analítico.** `suid_dumpable=2` y apport son precondiciones **observadas**, no una
  demostración práctica de que nunca se exponga un core (`demonstrated:false`). No se provoca
  ningún crash.
- **Identidad del ejecutable ≠ estabilidad de PID/starttime.** Un `exec` conserva pid y
  `starttime`; el ejecutable correcto es H6b/H6c, no esto. `pid_starttime_stable` se informa aparte
  y H6c sigue pendiente de autorización.

**Arquitectura de lanzamiento (09-launch-trust.md):**
- Corregida la afirmación de que Yama 1 protege **todas** las lecturas de `/proc`. Yama restringe
  sólo ATTACH; `environ`/`auxv`/`maps` (modo READ) las puede leer un proceso del mismo uid, no
  ancestro, si el objetivo es volcable. Por eso **L1 por sí solo no protege la clave HMAC** de una
  lectura READ: hace falta H-ND o no poner la clave en el entorno/argv (entregarla por un fd). La
  identidad del lanzamiento (L1–L6) **no** depende de leer la memoria.
- Agregado el diseño de una **POC mínima de L1 y L2** (§5bis de ese documento), con los ejes:
  raíz de confianza del lanzamiento y del `exec`, protección READ y ATTACH, inyección por
  loader/Bun/config/HOME/cwd, continuidad del PTY y reconexión, recreación y reinicio del
  supervisor, impacto en Composer 3.2 y tmux, privilegios del daemon root y superficie de Docker,
  recuperación sin afirmar identidades no demostrables. **Nada se implementa ni se corre.**
- L1 **no** está aprobado como arquitectura y **no** se autoriza sacar a Claude de tmux. La
  preferencia provisional del responsable es un supervisor/gateway separado del backend, con
  privilegios mínimos; tampoco es un GO.

**Estado de los tests (tras la tercera revisión, §1.14.15.8):**
- analizador B1a: 13 tests, 47 mutaciones de criterio;
- analizador B1b: 4 tests, 42 mutaciones de criterio;
- `test_b1.py`: 15; `test_runner.py`: 23;
- mutaciones de código: 41, todas detectadas;
- `claude plugin validate`: pasa.

Hashes del kit `e00ef29` (tarball de GitHub verificado; lista de archivos exacta):

```
6334bcbf90e51ddf82e2c470947b072171d3b033efb06db65f505499f2683dcc  analyze_b1a.py
e33dc88811b9472ccbea4819e8af0cf9443ec575e76d8c1385d804fc9b87011f  analyze_b1b.py
f20ea9f36029a15bb7a57b7b9828c1e89a9af2822589cd632e256fb075379165  b1.py
23a02a6dd40271761c57dcfe6ed265e550aacab8afda376fd0fa3e670c488932  managed/b1a.json
3a090f524c93fa3be45fa35ebd347b86ffe47801cacf6ede819095ecd71e2a55  marketplace/.claude-plugin/marketplace.json
c38e42b9a8ba4360b72465813088fe98b5e69a7ff5bf16ec4a43bc56ccb75514  marketplace/plugins/st-b1-probe/.claude-plugin/plugin.json
d87f4cbc7a53b0d733c13dd4c7f81e49d7ede3b21163e0d64e2234176d43100d  marketplace/plugins/st-b1-probe/hooks/hooks.json
707c35831bd4fa99d4e21f550c64a52de1ae2172c7fe5e4bdab16fb4245e0cf7  marketplace/plugins/st-b1-probe/hooks/register.mjs
e6aee6a2e84b80b8d39111e349f8c05edad05bdc8e62efa7ebd9b3c9aaae5dff  README.md
f6bdc2f32a9a873c00543fdded1c987706f6e0ccb509e9229a64f7791a3efdac  run-b1.sh
1845ebe18b0f73588cadb23ae345dd61f0ae68df52cc30f723366fa64ae958ec  test/fakebin/docker
8a55c015c59ef4cc85f81c743fd33fc36f30151941ad5eae9b5eea04000ef41f  test/test_analyze_b1a.py
a45744f700d780ee041179a919fe4f87d153049bb01b9287735e11ce2e92bf14  test/test_analyze_b1b.py
e2b086bf3896b95046921be7c652cfccfbf457b23cc591ebd7b3c7c4eec048cb  test/test_b1.py
11d866b6c116017c85ae2521b451859b9bf97a03f11248fe4cca85fd259f35ae  test/test_runner.py
```

##### 1.14.15.7 Segunda revisión independiente (2026-11-04; kit `8705c05`)

GO para corregir el kit y los documentos; sigue NO-GO para VM100, builds, merge y deploy. Cuatro
falsos PASS más, cada uno con un test que primero los reproducía.

1. **B1a / N9 — separar instalación, habilitación y ejecución.** El analizador ignoraba los
   códigos de salida de `plugin marketplace add` y `plugin install`. Ahora N9 se juzga por el
   **resultado de la instalación**, no por si el plugin corrió:
   - `plugin install` con éxito (rc 0, sin el texto de rechazo de política) ⇒ **FAIL**
     (`installed:N9`): se instaló un plugin de un marketplace no aprobado, aunque no se haya
     ejecutado;
   - rechazo de política (texto `blocked by your organization's policy` /
     `marketplace-blocked-by-policy`, o rc ≠ 0) ⇒ bloqueado;
   - cualquier otra cosa ⇒ INCONCLUSIVE.
   Test nuevo: instalación con éxito sin marcador ⇒ no PASS.

2. **B1a / N12 — correlación por arranque.** `b1.py` concatenaba los debug de los dos arranques y
   acumulaba los registros del probe, así que el analizador podía tomar el control del **primer**
   arranque y la evidencia de la semilla del **segundo**. Ahora `b1.py` guarda, por arranque, su
   propio debug (`debug-<n>.log`) y las clases de evento del probe que aparecieron en **ese**
   arranque; el analizador evalúa el control y la evidencia en el **último** arranque (donde la
   semilla tiene efecto). Test nuevo: primer arranque con probe válido, segundo sin él pero con la
   evidencia de la semilla ⇒ no PASS.

3. **B1b / clases de error.** `denied()` daba por denegado cualquier valor distinto de `ok`/`None`.
   Ahora sólo **`EACCES`/`EPERM`** acreditan una restricción de permisos a H-ND; `ENOENT`, `ESRCH`,
   `EINVAL`, `ENOSYS` (o una lectura no intentada) ⇒ INCONCLUSIVE, no crédito. Se aplica en H2/H3,
   H4 y H6a. Mutaciones por cada clase de error.

4. **Impostores N10/N11/N13 — origen del módulo cargado.** Una línea `Read hooks.json` desde el
   caché ya **no** es prueba de rechazo. Ahora se juzga el **origen** del módulo que cargó, no sólo
   su nombre y tier:
   - bloqueado sólo si la copia plantada fue considerada **y saltada** como duplicado ya cargado
     (`Skipping duplicate hooks file … already-loaded`) **y** el módulo cargó desde el marketplace
     en el lugar (una `Read hooks.json` bajo `/opt/st-b1/marketplace/`);
   - una `Read hooks.json` de la copia del caché que no sea un salto ⇒ el impostor pudo cargar ⇒
     INCONCLUSIVE (`impostor-origin-unverified`);
   - sin lectura en el lugar que ate el módulo cargado a la copia de la organización ⇒ INCONCLUSIVE.


##### 1.14.15.8 Tercera revisión independiente (2026-11-04; kit `e00ef29`)

GO para tres ajustes de precisión; sigue NO-GO para VM100, builds, merge y deploy.

1. **N9 — evidencia del propio comando de instalación.** Un `plugin install` con rc ≠ 0 **no**
   prueba por sí solo un rechazo de política. Ahora N9 se juzga por la salida y el rc del comando
   `plugin install` **en sí**, nunca por una concatenación con `marketplace add`:
   - instalación con éxito (rc 0 y sin texto de rechazo en su propia salida) ⇒ **FAIL**
     (`installed:N9`), aunque no haya marcador;
   - texto de rechazo de política en la salida **del install** ⇒ bloqueado;
   - rc ≠ 0 sin texto de rechazo ⇒ error operativo ⇒ **INCONCLUSIVE** (`install-error`).
   `load()` guarda la salida por comando (`pre_text`), así que el texto de un comando no se lee
   como el de otro. Tests: rc ≠ 0 con error genérico; rc 0 con texto de rechazo proveniente de
   `marketplace add` (sigue siendo FAIL, no bloqueado).

2. **N12 — segundo arranque, sin fallback.** Se eliminó el fallback de `load()` que podía
   sustituir el debug del segundo arranque por el del primero o por el concatenado. Para cada
   intento, el debug, el stderr y los eventos del probe se leen **estrictamente** del último
   arranque (donde la semilla tiene efecto), de sus propios archivos (`debug-<n>`, `stderr-<n>`,
   `probe_kinds` de ese arranque). El stderr también se separa por arranque. Si falta la evidencia
   del último arranque, INCONCLUSIVE. Test a nivel de archivos: arranque 1 con el control
   completo, arranque 2 vacío ⇒ INCONCLUSIVE.

3. **Aislamiento — `NetworkMode`.** `check_limits()` exige además que
   `HostConfig.NetworkMode` sea `none`. Mutación nueva: Docker devuelve `bridge` ⇒ `setup` se
   detiene (y lo mismo cualquier otro valor).

**Estado:** B1a 13 tests / 47 mutaciones de criterio; B1b 4 / 42; `test_b1.py` 15; `test_runner.py`
23; 41 mutaciones de código, todas detectadas; `claude plugin validate` pasa. Hashes en
§1.14.15.6 (actualizados a `e00ef29`). L1/L2, Composer y backend sin cambios.


##### 1.14.15.9 CI de la PR #512: diagnóstico del test D8 (no es una regresión de esta rama)

El commit documental falló una vez en el job de backend:
`src/recreate/engine.test.ts`, caso D8 "backend restart with an attempt open or uncertain",
que esperaba `uncertain` y obtuvo `resolved`.

**Diagnóstico: flaky por tiempo bajo carga de CI, no una regresión de esta PR.**
- La rama no toca `backend/`: `git diff d5c7e12 HEAD -- backend` está **vacío**. El código de
  recreación es idéntico a `main` (`d5c7e12`), cuyo CI pasó.
- El test usa temporizadores de reloj real (`tRecMs:80`, `tRbMs:80`, `tick(50)`/`tick(100)`) y
  "reinicia" el motor creando uno nuevo sobre el mismo disco mientras el `create` viejo se resuelve
  tarde. Es sensible a la carga.
- Localmente, con el mismo código: 5/5 aislado, 12/12 en paralelo y 3/3 la suite completa
  (132 archivos, 2746 tests) pasan.

**No modifiqué el código de recreación.** El `resolve()` tras `stop()` ya está guardado por
`!lease.held || this.stopped`; la hipótesis es una carrera de tiempo entre la resolución tardía
del `create` viejo y el `stop()`/`recoverOnBoot`, agravada por la carga del runner. La corrección,
si se confirma, es del test (temporizadores deterministas), bajo un diagnóstico y una autorización
aparte; no es de esta PR. Recomiendo re-ejecutar el job. **La PR no se presenta como totalmente
verde.**

## 2. Versiones

| Variante | CLI | Motivo |
| --- | --- | --- |
| V1 | 2.1.314 | versión validada del Composer (§8.1.9); versión del binario inspeccionado |
| V2 | la última publicada el día de la POC | lo que el auto-update instala en los workspaces |

El pin de la imagen (2.1.308) **no** se prueba: los workspaces se auto-actualizan
(phase3 §1.2) y 2.1.308 no tiene la evidencia de binario de C2/C8.

## 3. Prototipo

```mermaid
sequenceDiagram
  participant T as Harness
  participant M as monitor.mjs
  participant S as st_channel.py
  participant C as claude (tmux, --channels)
  T->>C: tmux new-session -d "claude --dangerously-skip-permissions --dangerously-load-development-channels server:st"
  C->>S: spawn (stdio)
  S->>M: POST hello {pane, claudePid}
  T->>M: encolar mensaje (msg_id)
  S->>M: GET next
  M-->>S: {lease, content, meta}
  S->>C: notifications/claude/channel
  S->>M: POST transported
  C-->>M: hooks (UserPromptSubmit, Stop…) vía relay
  M->>T: estado (accepted, completed)
```

El monitor aplica la elegibilidad de §4 del protocolo usando los hooks recibidos y `claude agents
--json` (por `docker exec`, el mismo probe de producción).

## 4. Experimentos

| # | Experimento | Procedimiento | Qué se registra |
| --- | --- | --- | --- |
| E0 | Disponibilidad | Arrancar con la suscripción del responsable (§1.4) y `channelsEnabled: true` en `managed-settings.d`; leer `--debug` del CLI | `Channel notifications registered` o el motivo de `skip` (C13–C18) |
| E1 | Carga de producción | Repetir E0 con `st` empaquetado como plugin en un marketplace local y `allowedChannelPlugins`, sin flag de desarrollo | registra / no registra; diálogo de confirmación sí/no |
| E2 | Despertar en el prompt | 60 mensajes con la sesión en `waiting_input` verificado: 48 tras ≥ 30 s inactiva y 12 tras ≥ 1 h inactiva; repartidos en al menos dos días | `UserPromptSubmit` sí/no; latencia `transported → UserPromptSubmit` |
| E3 | Forma de la evidencia | Para todos los mensajes de E2 | `source`, `prompt` exacto, presencia de `st_msg`, `prompt_id` |
| E4 | Busy | (a) política del monitor: mensaje en cola mientras Claude trabaja; (b) **comportamiento crudo**: 3 notificaciones durante un turno largo, sin política (10 repeticiones); (c) texto tecleado por el harness (`actor=human-sim`) en cuatro momentos: 0,5 s antes de la notificación, 0,5 s después, a mitad del turno del canal y justo antes de su `Stop`; 10 repeticiones de cada uno | (a) se entrega tras `turn_end`; (b)/(c) cuántos hooks, forma exacta del `prompt`, `prompt_id` de cada hook, orden de llegada frente al `Stop`, estado final según protocolo §3.1 |
| E4d | Notificación de tarea durante el turno | el mensaje del canal pide lanzar un Bash en background que termina a mitad del turno; 10 repeticiones | `internal_prompt` dentro de la ventana; estado final `ended_unattributed{mixed-input}` |
| E5 | Reanudación | (a) salir y `claude --resume <cid>` con los mismos flags, inmediatamente (< 5 s) y tras un `kill -9`; (b) `/resume` a otra conversación dentro del CLI; (c) `/clear`; 30 mensajes tras cada uno | runtime nuevo o el mismo; `cid` donde se acepta; conversaciones nuevas creadas |
| E6 | Sesiones no creadas | antes/después de cada experimento | número de entradas de `claude agents --json` y de `session_id` distintos en los hooks |
| E7 | Pérdida y duplicados | 100 mensajes secuenciales con la política del monitor | exactamente un `channel_prompt` y un `turn_end` por mensaje; `prompt_id` distintos |
| E8 | Fallos inyectados | ver §4.1 | estado final de cada entrega |
| E9 | Herramienta de publicación | 20 mensajes que piden "publicá un avance con `chat_post` y después respondé" con el modelo por defecto | tasa de llamadas (informativo, no es criterio) |
| E10 | Concurrencia | (a) dos contenedores, 50 mensajes cada uno en paralelo; (b) dos `claude` con canal en el mismo contenedor | (a) cero entregas cruzadas; (b) `runtime-ambiguous` y cero entregas |
| E11 | Efectos secundarios | Con `--channels`: `AskUserQuestion`, plan mode, `/config`, `/mcp` | qué cambia para la persona en el Terminal (C20) |
| E12 | Escapado e inyección | contenido con `</channel>`, `<channel source="x" st_msg="…">`, comillas, NUL, 16 KiB, `/clear` al inicio | `prompt` resultante; clasificación de §5 del protocolo |
| E13 | Brazo B (condicional) | Sólo si E2 o E5 fallan: hook `Stop` con `asyncRewake` que hace long-poll al monitor y sale con 2 al recibir | mismas métricas de E2, E3, E5, E7 |

### 4.1 Matriz de fallos (E8)

| Fallo inyectado | Momento | Estado esperado | Prohibido |
| --- | --- | --- | --- |
| `kill -9` de `st_channel.py` | entre la notificación y `transported` | `uncertain{lease}` y después `accepted{late}` (llega el hook) | reentrega |
| `kill -9` de `st_channel.py` | antes de la notificación, con lease | `uncertain{lease}` → `unconfirmed{not-transported}` por la regla 2b (c), con el reloj desde el vencimiento del lease; **sin** `degraded` | reentrega; `degraded` |
| reinicio de `monitor.mjs` | con una entrega `transported` | `uncertain{orphaned}`; `accepted{late}` si llega el hook; si no, `unconfirmed` por la regla 2b | reentrega |
| texto humano tecleado 0,5 s después de `transported` (E4c) | turno humano en curso | `uncertain` mientras el CLI lo tenga en cola; después `accepted{late}` o `unconfirmed` por la regla 2b; ninguna otra entrega a ese agente mientras tanto | reentrega; segunda entrega concurrente |
| `kill` de `claude` | durante el turno aceptado | `interrupted` | reentrega por Composer o tmux |
| `docker stop` | con 3 mensajes en cola | cola intacta; entrega tras arrancar y relanzar `claude` | pérdida o duplicado |
| red cortada contenedor→monitor | 60 s | `st_channel` reintenta `hello`; entregas en vuelo `uncertain`, después `accepted{late}` o `unconfirmed` (`not-transported` si no llegó a `transported`) por la regla 2b; **sin** `degraded` | duplicado; `degraded` |
| respuesta 200 de `next` retrasada más allá de `T_lease` (proxy de la POC que la retiene) | préstamo | `st-channel` descarta el lease sin escribir; la entrega `uncertain{lease}` → `unconfirmed{not-transported}`; **ninguna** escritura en el CLI | escritura de la notificación; `late_after_terminal` |
| `channelsEnabled` ausente | arranque | sin runtime; la cola espera y el motivo es visible | cualquier entrega |
| **kill switch simulado al registrar**: `st` configurado como servidor MCP pero **no** nombrado en `--channels` (el CLI lo arranca y no registra el handler: mismo efecto observable que el gate remoto) | 3 mensajes en cola | el primero `uncertain` → `unconfirmed{no-evidence}` por la regla 2b (c); runtime `degraded{no-evidence}`; los otros dos siguen `queued` con "retenido: canal degradado" | pérdida, `completed`, reentrega, cualquier `composer_send`, escritura en tmux |
| kill switch simulado + "Probar el canal otra vez" | tras la fila anterior | sólo el **siguiente** mensaje en cola se intenta; el `unconfirmed` no se reenvía | reentrega del `unconfirmed` |
| `source` ausente (hook de captura reescrito por el monitor de la POC quitando `source`) | 3 mensajes | `user_prompt{origin: unverified, channel_source_absent}`, entrega `unconfirmed{no-evidence}`, runtime `degraded{source-absent}` | `accepted` |
| diálogo abierto (`/help`) o borrador en el input | con una entrega `uncertain` | ni la elegibilidad ni la regla 2b (b)/(c) cuentan esos probes como "en su prompt"; la entrega sigue `uncertain`; sin `degraded` | `unconfirmed` o `degraded` mientras el diálogo o el borrador sigan |
| pérdida de hooks en el relay (cola llena forzada o relay reiniciado) durante el turno aceptado | turno en curso | `ended_unattributed{gap}` o `{relay-unverified}` | `completed` |
| pérdida del hook `UserPromptSubmit` del canal en el relay (relay reiniciado justo tras `transported`) | antes de la aceptación | `unconfirmed{relay-loss}` con el aviso "puede haberse ejecutado"; **sin** `degraded` | `unconfirmed{no-evidence}`; `degraded` |
| reinicio del monitor durante `T_settle` de un turno con entrada tecleada 0,5 s antes | tras el cierre | la recuperación aplica A1–A7: `ended_unattributed{queued}` | `completed` |
| `Stop` del turno aceptado perdido (hook `Stop` bloqueado en el relay) | cierre | `ended_unattributed{no-close}` tras dos probes "en su prompt"; la cola del agente sigue | `accepted` indefinido |
| reinicio del monitor con el runtime `degraded` | tras la fila "kill switch simulado" | sigue `degraded` (mismo `claude_pid` y `start_time`) | salida automática de `degraded` |
| relay detenido (hooks perdidos) | durante un mensaje | `unconfirmed{relay-loss}` con el aviso "puede haberse ejecutado" aunque Claude trabaje; **sin** `degraded` | `completed` sin evidencia; `unconfirmed{no-evidence}`; `degraded` |

## 5. Criterios GO / NO-GO (fijados antes de ejecutar)

Se evalúan en **V1 y V2**. "Sin explicación" significa que el log del CLI y los hooks no permiten
atribuir el caso a un fallo inyectado. Con muestras pequeñas no se informa "p99" sino el máximo y la
cota superior al 95 % de la tasa de fallo (regla del tres: 0 fallos en n ⇒ ≤ 3/n). Con 60 muestras,
0 fallos acota la tasa real en ≈ 5 %; con 30, en ≈ 10 %. La POC decide si el mecanismo funciona; el
objetivo del piloto (≥ 95 %, visión §6) se confirma en el piloto, no aquí.

| Id | Criterio | Umbral GO |
| --- | --- | --- |
| G1 | Registro | E0 registra con la suscripción del responsable (§1.4). E1 registra sin flag de desarrollo (si sólo E0 registra: **GO condicional** a la decisión R6) |
| G2 | Despertar | E2: 60/60 turnos iniciados (incluidas las 12 muestras de ≥ 1 h); latencia máxima ≤ 5 s |
| G3 | Evidencia | E3 y todas las entregas de E2, E5, E7: 100 % de las entradas producen `UserPromptSubmit` con `source=system` **presente** y la etiqueta con `st_msg` intacto (hipótesis H8). Un solo hook con `source` ausente en la versión probada ⇒ esa versión no entra en `CHANNEL_CLI_VERSIONS` (protocolo §5) |
| G4 | Sin pérdida ni duplicado | E7: 100/100 exactamente una vez; 0 duplicados |
| G5 | Reanudación | E5a: 30/30 aceptados en el `cid` reanudado, sin `runtime-ambiguous` tras la salida inmediata ni tras el `kill -9`; E5b/E5c: 30/30 aceptados en el `cid` nuevo; 0 conversaciones creadas por una entrega (E6) |
| G6 | Fallos | E8: cada fila termina en el estado esperado; 0 reentregas automáticas; **0 evidencias `late_after_terminal` tras un `unconfirmed`** (un `unconfirmed` que el CLI ejecuta después es el riesgo de duplicado); 0 escrituras de entrada en tmux del monitor o de `st-channel` (las de `actor=human-sim` se excluyen y se cuentan aparte) |
| G7 | Inyección | E12: ninguna entrada produce un `channel_prompt` verificado con un `st_msg` distinto del real ni atributos inyectados |
| G8 | Concurrencia | E10a: 0 entregas cruzadas; E10b: 0 entregas |
| G9 | Busy | E4a: 0 entregas mientras `busy`; todas entregadas tras `turn_end` |
| G10 | Agrupación | E4b/E4c: la forma del hook es estable en todas las repeticiones y está cubierta por una fila de la tabla del clasificador (protocolo §5); ningún `st_msg` agrupado queda sin evidencia |
| G11 | Atribución | E4c (los cuatro momentos, incluido **0,5 s antes** de la notificación), E4d, E7, las filas de pérdida de hooks de E8 y la fila "reinicio del monitor durante `T_settle`": **0** entregas `completed` cuyo turno tuvo una entrada ajena o una pérdida (verificado contra el log crudo de hooks, el log del wrapper `tmux` y el log del relay); cada caso ajeno termina en el `ended_unattributed{…}` previsto por §3.1; en E7, 100/100 `completed` con su propio `turn_end` |
| G12 | Kill switch y no-fallback | filas "kill switch simulado", "`source` ausente" y "reinicio del monitor con el runtime `degraded`" de E8, más 0 `degraded` en las filas de `kill -9`, red cortada y pérdida de hooks: 0 mensajes sin estado visible, 0 `completed`, 0 reentregas, 0 `late_after_terminal`, 0 salidas automáticas de `degraded`, 0 eventos `composer_send`, 0 escrituras de entrada en tmux |

Decisión:

| Resultado | Consecuencia |
| --- | --- |
| **G1–G12 cumplen, todos** (ninguno es opcional; G10 incluido) | **GO** técnico: se presenta al responsable para redactar el contrato vinculante (roadmap P2) |
| Falla G1 por política, bloqueo de la suscripción o kill switch (C15, C17) | **NO-GO**. No se cambia de autenticación. El brazo B sólo se evalúa si el responsable lo autoriza |
| Falla G2 o G5 | Correr E13 (brazo B). Si B cumple G2–G12: se **presenta** B al responsable como alternativa (R2: no se aprueba automáticamente para producción); si no: **NO-GO** |
| Falla G3 | **NO-GO**: sin evidencia de aceptación del CLI, "entregado" no es demostrable (la herramienta `reply` depende del modelo, E9) |
| Falla G4, G6 o G8 por diseño | **NO-GO** y rediseño. Si es un error del prototipo, se corrige y se repite **toda** la tanda |
| Falla G7, G10 o G11 | **NO-GO** en esta tanda: rediseño del clasificador o de la atribución y repetición completa de la POC antes de cualquier GO |
| Falla G12 | **NO-GO**: es un requisito de seguridad del producto (R1), no de rendimiento |
| E11 muestra un efecto inaceptable en el Terminal | No bloquea la POC; el responsable decide si el canal se limita a sesiones de agente (R7) |

## 6. Entregables de la POC

1. Tabla de resultados por experimento y versión, con los conteos.
2. Los hooks crudos y el log del monitor (sin texto de usuario sensible: los mensajes de prueba son
   sintéticos).
3. Actualización de la tabla de capacidades del RFC §3.1: cada fila **H** pasa a comprobada o
   refutada, con la versión.
4. Valores medidos para `T_accept` y `T_lease`.
5. Recomendación GO / NO-GO / GO condicional según §5.

## 7. Propuesta de ejecución (dos autorizaciones separadas)

Este documento **no** autoriza ejecutar nada. Hay dos autorizaciones, en orden:

1. **Autorización de la fase 0** (§1.7): sólo `fakechat`, disponibilidad y despertar.
2. **GO de la POC completa** (E0–E12), que se pide **después** de presentar los resultados de la
   fase 0 y sólo si la superó.

### 7.1 Precondiciones de la fase 0

| # | Precondición | Quién |
| --- | --- | --- |
| P1 | Autorización explícita para la fase 0 | responsable |
| P2 | Mac o PC del responsable con un usuario temporal nuevo y no administrador (§1.7); la VM queda para la POC completa | responsable |
| P3 | Uso extra desactivado en la cuenta de la suscripción | responsable |
| P4 | Kit local (`poc/channels-local`) revisado de forma independiente en el commit que se autoriza | agente; revisión independiente |
| P5 | Criterios de §1.7 y §5 sin cambios desde este PR | — |

### 7.2 Etapas

| Etapa | Contenido | Consumo | Se detiene si |
| --- | --- | --- | --- |
| S0 | Kit `poc/channels-local` como usuario temporal: instalación fijada, `setup`, `preflight`; se presenta `preflight.md` | ninguno | algún FAIL del preflight; `fakechat` no coincide con el commit |
| S1 | Fase 0 (§1.7): `/login` del responsable, `registration`, 12 despertares, `report`, limpieza | ~12 turnos triviales del plan | bloqueo de Channels (NO-GO), límite del plan, propuesta de uso pagado o fallo del harness (se corrige y se repite, nunca NO-GO) |
| S2 | Informe de la fase 0 y **pedido de GO separado** | — | — |
| S3 | *(sólo con el GO de S2)* E0–E12 en V1, día 1, con el prototipo propio; login nuevo del responsable en cada contenedor | ~200 turnos, repartidos para no superar los límites del plan | violación de G6 o G12; límite del plan (se pausa y se retoma otro día, nunca uso pagado) |
| S4 | *(ídem)* repetición en V2 y segundo día de E2 | ~100 turnos | ídem |
| S5 | E13 (brazo B) sólo si fallan G2 o G5 y con aprobación del responsable | ~40 turnos | — |
| S6 | `/logout` y eliminación en el orden de §1.5, informe | — | — |

No hay presupuesto en dinero: el único consumo permitido es el incluido en la suscripción. Duración
de la POC completa: al menos tres días de calendario (segundo día de E2 y pausas por límites del plan).

### 7.3 Informe

Un PR de docs (draft) que añade a este archivo: tabla de resultados por criterio y versión, con
conteos y cotas; decisión GO / NO-GO / GO condicional según §5; dominios añadidos al proxy;
consumo observado y cualquier límite del plan alcanzado; lista de verificación de §1.5 firmada; actualización de la tabla de capacidades del RFC §3.1.

