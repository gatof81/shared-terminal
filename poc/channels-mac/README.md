# Fase 0 instrumentada — hooks de diagnóstico en tu carpeta de prueba (Mac)

Para PR #512 (`docs/design/project-chat/04-poc.md` §1.7–§1.9). Corre en **tu** sesión local de
Claude Code, la que ya funciona con `--channels plugin:fakechat@claude-plugins-official` y tu
suscripción. **No** reinstala Claude ni el plugin, **no** toca `~/.claude/settings.json` ni
credenciales y **no** usa `/logout`.

## Qué hay

| Archivo | Para qué |
| --- | --- |
| `hook-logger.mjs` | Hook **observacional**: una línea JSONL por evento en `.poc0/out/hooks.jsonl`. No imprime nada (en `UserPromptSubmit`/`SessionStart` lo impreso se agregaría al contexto de Claude), siempre sale con 0 (el 2 bloquearía el turno) y se traga sus errores |
| `manage.mjs` | `install` / `check` / `uninstall` en **una** carpeta: fusiona entradas en `<carpeta>/.claude/settings.local.json` sin tocar lo que ya hay; al retirar restaura byte por byte, o quita sólo lo suyo si hubo cambios ajenos |
| `idle.mjs` / `classify.mjs` | Lógica pura de inactividad observada y de clasificación (despertar ≠ bidireccional), cubierta por `test/` |
| `events.mjs` | Identidad de evento = **línea absoluta** de `hooks.jsonl` (nunca identidad de objeto entre lecturas) y hechos de la ventana de cada envío; cubierta por `test/events.test.mjs` |
| `transcript-probe.mjs` / `transcript-match.mjs` | Alternativa A (#512 04-poc.md §1.11): en `UserPromptSubmit`, **una** lectura acotada (≤ 1 MiB final) del transcript de la sesión para ver si el registro `origin.kind=channel` con ese `prompt_id` y `message_id` ya está escrito. Observacional: no imprime, sale con 0, no espera ni reintenta; guarda sólo veredicto, motivos, conteos y tiempos en `out/transcript-probe.jsonl`. Todo caso dudoso es `unverified` |
| `mod/` (`st-provenance-probe`) | Alternativa B (#512 04-poc.md §1.13), XB-1: mod **observacional** que se carga sólo con `claude --plugin-dir .poc0/mod` (ninguna configuración lo nombra). En `prompt.submit` lee `origin` (lo pone el CLI, ningún hook puede cambiarlo); lo liga al `prompt_id` del `classic.UserPromptSubmit` que corre **dentro** de su `next()`; con dos envíos en vuelo no liga ninguno. Cada handler llama `next(e)` una vez y devuelve lo que devuelve. Escribe un JSON por evento en `out/mod/` sin texto: origen, conteos, ids de prompt y sesión |
| `xb.mjs` | `controls` genera los dos prompts de control (tecleado y con etiqueta `<channel>` pegada); `report` junta `out/mod/`, `hooks.jsonl` y `sends-B.jsonl` por `prompt_id` y da PASS / FAIL / INCONCLUSIVE con alias y booleanos |
| `rediagnose.mjs` | Recalcula la ventana de un envío **desde los registros existentes**, sin modificarlos; escribe `rediagnosis-<id>.json/.md` aparte |
| `send.mjs` | Envía el mensaje de prueba por Fakechat (`POST /upload`, como la página) y mide: hook, `Stop`, respuesta en Fakechat. Nunca teclea en la terminal ni reintenta; sin `--series-authorized` sólo acepta la prueba individual |
| `report.mjs` | Arma la sección de resultados para la PR #512 |

### Qué registra el logger (y qué no)

| Evento | Campos |
| --- | --- |
| todos | `ts`, `t_ms`, `event`, `session_id` (id de conversación), `prompt_id`, `agent_id`, `keys` (**nombres** de los campos recibidos, para verificar la forma real en tu versión) |
| `UserPromptSubmit` | `source_present` (distingue ausente de presente) y `source`; `prompt_bytes`, `prompt_sha256`; ids de prueba; etiquetas `<channel>`: cuántas, aperturas/cierres, bytes fuera de las etiquetas, **nombres** de atributos y **valores** sólo de `source`, `chat_id`, `message_id`, `user`, `ts`, `st_msg` (saneados) |
| `Stop` / `StopFailure` | bytes del último mensaje, ids `OK_<id>` presentes, `stop_hook_active`, nº de tareas en background / `error` |
| `SessionStart` | `source` (startup, resume…), modelo |
| `PostToolUse(Failure)` de las herramientas de Fakechat | nombre, `tool_use_id`, ok, `reply_to`, bytes del texto, ids presentes, nº de archivos (sin rutas) |
| `Notification` | `notification_type` (para detectar un diálogo de permiso) |

**Nunca**: texto de prompts o respuestas, entradas o salidas de herramientas, `transcript_path`,
`cwd`, tokens ni credenciales.

## Instrucciones exactas (sólo la prueba individual)

> `COMMIT` y la lista SHA-256 son los indicados en la autorización. `TEST` es tu carpeta de prueba
> dedicada, la misma donde corrés Claude con Fakechat. Que no sea un proyecto real ni tu HOME.

### 1. Bajar el kit por SHA exacto (con `gh`, funciona con el repo público o privado)

```bash
COMMIT=<sha completo indicado>
rm -rf ~/poc0-kit && mkdir -p ~/poc0-kit && cd ~/poc0-kit
gh api "repos/gatof81/shared-terminal/tarball/$COMMIT" > kit.tgz
tar xzf kit.tgz --strip-components=1 && rm kit.tgz
KIT=~/poc0-kit/poc/channels-mac
TEST=~/poc-channels-test            # ajustar
(cd "$KIT" && shasum -a 256 -c <<'SUMS'
<pegar la lista SHA-256 indicada>
SUMS
)                                   # todas deben decir OK
command -v bun                      # Fakechat ya lo usa; debe existir
```

Opcional, para correr los tests sintéticos del kit (no tocan Claude ni tu carpeta):
`cd "$KIT" && bun test test/` o, con Node 22, `node --test test/*.test.mjs`.

### 2. Instalar en la carpeta de prueba

En la terminal donde corre Claude con Fakechat, salí con `/exit`. **No** uses `/logout`: el login
queda en el llavero y sobrevive al reinicio. Tus otras sesiones no se ven afectadas: los settings
locales sólo aplican a sesiones abiertas en `TEST`.

```bash
bun "$KIT/manage.mjs" install "$TEST"
bun "$KIT/manage.mjs" check "$TEST"
# debe decir: eventos con el logger: (7 eventos) · autotest: exit=0 stdout="" escribió=true
# y: sonda del transcript: no instalada (XB-1)   ← con --with-probe (XA-1): exit=0 stdout="" veredicto=verified
# y: mod XB-1 en .poc0/mod: copia exacta=true, nombrado en settings=false
```

`install` guarda una copia exacta de tu `settings.local.json` (si existía) en `TEST/.poc0/`.

### 3. Relanzar Claude con Channels

```bash
cd "$TEST" && claude --channels plugin:fakechat@claude-plugins-official --debug-file .poc0/out/claude-debug.log
```

- Si Claude pide revisar los hooks nuevos, el comando debe ser `"<ruta de bun>" "<TEST>/.poc0/hook-logger.mjs"`.
- `/hooks` dentro de Claude los muestra (sólo mirar; Esc para salir).
- El log de depuración queda sólo en `TEST/.poc0/out` y no se comparte; el informe usa sólo la hora
  de recepción del mensaje de prueba.
- No abras otras sesiones nuevas de Claude durante la prueba: el plugin está habilitado para tu
  usuario y otra sesión podría intentar tomar el puerto 8787. `send.mjs` comprueba que el puerto
  pertenece a la sesión de `TEST` y, si no, se detiene sin enviar.

### 4. La prueba instrumentada: un solo mensaje

En **otra** terminal. No escribas nada en la de Claude.

```bash
cd "$TEST"
bun .poc0/send.mjs --label T --count 1 --min-idle 30
bun .poc0/report.mjs && open .poc0/out/phase0-instrumented-report.md
```

`--min-idle 30` son 30 s **observados**: `send.mjs` consulta el estado cada 3 s y sólo envía tras 30 s
seguidos con la sesión en su prompt, sin hooks nuevos y sin huecos de más de 10 s; cualquier
actividad reinicia la cuenta. Por eso tarda al menos ~30 s antes de enviar.

Salidas: **0** terminó · **4** fallo del harness (nunca NO-GO) · **5** sin `UserPromptSubmit` en
120 s (no se reintenta) · **6** no se observó la inactividad · **7** `StopFailure`.

El informe separa **despertar del agente** (criterio de §1.7) y **comunicación bidireccional**
(mensaje → turno → `Stop` → respuesta vista en Fakechat). La prueba es "limpia" sólo con las dos y
con `source=system` y correlación OK. Las series de 12 muestras **no** están autorizadas: `send.mjs`
las rechaza sin `--series-authorized`.

**Mandame el informe** (y, si querés, `hooks.jsonl`, que no tiene texto) antes de cualquier otra cosa.

### 4b. Rediagnóstico de un envío ya registrado (sólo lectura, sin instalar nada)

Los envíos registrados antes de la corrección de identidad de eventos (prueba T `P0T01-f9dfb6`)
contaban su propio `UserPromptSubmit` y su propio `Stop` como ajenos. Para recalcularlos no hace
falta reinstalar: se corre desde el kit apuntando a la carpeta de logs; `sends-*.jsonl` y
`hooks.jsonl` no se modifican.

```bash
bun "$KIT/rediagnose.mjs" P0T01-f9dfb6 --out "$TEST/.poc0/out"
open "$TEST/.poc0/out/rediagnosis-P0T01-f9dfb6.md"
```

### 5. Retirar la instrumentación

```bash
bun "$KIT/manage.mjs" uninstall "$TEST"                  # conserva los logs en TEST/.poc0/out
# bun "$KIT/manage.mjs" uninstall "$TEST" --purge-logs   # además borra los logs
rm -rf ~/poc0-kit
```

- Si nadie tocó `settings.local.json` durante la prueba, queda **byte por byte** como estaba (o se
  elimina si no existía, junto con `.claude/` si el kit la creó y quedó vacía). Mensaje:
  `restaurado-exacto`.
- Si Claude u otra cosa lo modificó (por ejemplo, un "no volver a preguntar"), se quitan **sólo** los
  hooks del kit y se conservan esos cambios. Mensaje: `sólo-hooks-del-kit-quitados`.
- Para que la sesión deje de usar los hooks: `/exit` y relanzar como en el paso 3, sin `--debug-file`.

## Seguridad: lo que conviene saber

- **Observacional**: el logger no bloquea, no modifica ni inyecta nada. Un fallo del logger no
  afecta a Claude.
- **Fakechat no tiene autenticación ni control de origen.** Mientras corre, cualquier proceso local o
  **cualquier página web abierta en el Mac** puede enviarle un mensaje a esta sesión. Si en esta
  carpeta tenés permitida la herramienta `reply` de Fakechat, un mensaje inyectado podría pedirle a
  Claude que adjunte un archivo legible, que Fakechat sirve en `localhost` sin autenticación.
  Durante las series: no navegues por sitios desconocidos, mantené la carpeta de prueba sin datos
  sensibles, no uses `--dangerously-skip-permissions` y contestá **No** a cualquier diálogo de
  herramienta inesperado.
- La prueba individual consume un turno del límite incluido de tu suscripción; no hay gasto adicional.
