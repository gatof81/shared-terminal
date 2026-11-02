# Fase 0 instrumentada — hooks de diagnóstico en tu carpeta de prueba (Mac)

Para PR #512 (`docs/design/project-chat/04-poc.md` §1.7–§1.9). Corre en **tu** sesión local de
Claude Code, la que ya funciona con `--channels plugin:fakechat@claude-plugins-official` y tu
suscripción. **No** reinstala Claude ni el plugin, **no** toca `~/.claude/settings.json` ni
credenciales y **no** usa `/logout`.

## Qué hay

| Archivo | Para qué |
| --- | --- |
| `hook-logger.mjs` | Hook **observacional**: una línea JSONL por evento en `.poc0/out/hooks.jsonl`. No imprime nada (en `UserPromptSubmit`/`SessionStart` lo impreso se agregaría al contexto de Claude), siempre sale con 0 (el 2 bloquearía el turno) y se traga sus errores |
| `manage.mjs` | `install` / `check` / `uninstall` en **una** carpeta: fusiona entradas en `<carpeta>/.claude/settings.local.json` sin tocar lo que ya hay, y las quita igual |
| `send.mjs` | Envía mensajes de prueba por Fakechat (`POST /upload`, como la página) y mide: hook, `Stop`, respuesta en Fakechat. Nunca teclea en la terminal ni reintenta |
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

## Instrucciones exactas

> `COMMIT` es el commit de la rama `poc/channels-phase0` indicado en la autorización.
> `TEST` es tu carpeta de prueba dedicada, la misma donde corrés Claude con Fakechat (por ejemplo
> `~/poc-channels-test`). Que no sea un proyecto real ni tu HOME.

### 1. Bajar el kit (fuera de la carpeta de prueba)

```bash
COMMIT=<sha completo indicado>
mkdir -p ~/poc0-kit && cd ~/poc0-kit
curl -fsSL "https://codeload.github.com/gatof81/shared-terminal/tar.gz/$COMMIT" | tar xz --strip-components=1
KIT=~/poc0-kit/poc/channels-mac
TEST=~/poc-channels-test            # ajustar
command -v bun                      # Fakechat ya lo usa; debe existir
```

### 2. Instalar en la carpeta de prueba

En la terminal donde corre Claude con Fakechat, salí con `/exit`. **No** uses `/logout`: el login
queda en el llavero y sobrevive al reinicio. Tus otras sesiones de Claude no se ven afectadas: los
settings locales sólo aplican a sesiones abiertas en `TEST`.

```bash
bun "$KIT/manage.mjs" install "$TEST"
bun "$KIT/manage.mjs" check "$TEST"     # debe decir: autotest exit=0 stdout=""
```

### 3. Relanzar Claude con Channels

```bash
cd "$TEST" && claude --channels plugin:fakechat@claude-plugins-official --debug-file .poc0/out/claude-debug.log
```

- Si Claude pide revisar los hooks nuevos, el comando debe ser `"<ruta de bun>" "<TEST>/.poc0/hook-logger.mjs"`.
- En Claude, `/hooks` muestra los hooks registrados (sólo mirar; Esc para salir).
- El log de depuración queda sólo en `TEST/.poc0/out`; no se comparte. El informe usa sólo la hora
  de recepción de los mensajes de prueba.
- Opcional: abrir `http://localhost:8787` para ver las respuestas.
- Durante las pruebas, no abrir otras sesiones nuevas de Claude: el plugin está habilitado para tu
  usuario y otra sesión podría intentar tomar el puerto 8787. `send.mjs` comprueba que el puerto
  pertenece a la sesión de `TEST` y, si no, se detiene sin enviar nada.

### 4. Primera prueba instrumentada: un solo mensaje

En **otra** terminal (no la de Claude). No escribas nada en la de Claude.

```bash
cd "$TEST"
bun .poc0/send.mjs --label T --count 1 --min-idle 30
bun .poc0/report.mjs
open .poc0/out/phase0-instrumented-report.md
```

**Pará acá** y revisá (o mandame) el informe antes de las series. Lo decisivo: si el hook trae
`source=system`, la forma de la etiqueta `<channel>` y si la correlación sale OK.

### 5. Las 12 muestras de la fase 0 (después de revisar la prueba individual)

```bash
cd "$TEST"
caffeinate -dimsu &
bun .poc0/send.mjs --label S --count 10 --min-idle 30     # ~10–15 min
bun .poc0/send.mjs --label L --count 2  --min-idle 3600   # ≥ 2 h
bun .poc0/report.mjs
kill %1
```

Salidas de `send.mjs`:
- **0**: terminó.
- **4**: fallo del harness (puerto de otra sesión, Fakechat no aceptó la subida, `claude agents`
  ilegible). **Nunca** es NO-GO.
- **5**: un mensaje sin `UserPromptSubmit` en 120 s. La serie se detiene y no se reintenta. El
  informe dice qué evidencia hay.
- **6**: no se alcanzó la inactividad.
- **7**: `StopFailure` (límite del plan o error).

Para repetir una serie, volver a correr el mismo comando: la tanda anterior se guarda aparte y el
informe usa sólo la última. Si aparece un diálogo de permiso, anotalo: el informe lo marca como
intervención.

### 6. Retirar la instrumentación

```bash
bun "$KIT/manage.mjs" uninstall "$TEST"                  # conserva los logs en TEST/.poc0/out
# bun "$KIT/manage.mjs" uninstall "$TEST" --purge-logs   # además borra los logs
rm -rf ~/poc0-kit
```

`uninstall` quita sólo las entradas del kit de `settings.local.json` y deja el archivo como estaba
(o lo elimina si no existía). Para que la sesión deje de usar los hooks, `/exit` y relanzar igual que
en el paso 3, sin `--debug-file`.

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
- Los ~13 turnos consumen el límite incluido de tu suscripción; no hay gasto adicional.
