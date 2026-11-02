# Fase 0 local — Channels con `fakechat` en tu Mac o PC

> **Estado (2026-11-02): reemplazado.** El responsable ejecuta la fase 0 instrumentada en su sesión
> local habitual con hooks sólo en la carpeta de prueba: ver `poc/channels-mac/`. Este kit de usuario
> temporal queda como alternativa, con hallazgos pendientes de su última verificación: la
> confirmación de un NO-GO compara líneas del log con su timestamp y nunca coincide; la lista de
> herramientas denegadas no cubre `Skill`, `RemoteTrigger`, `CronCreate`, `ScheduleWakeup`,
> `SendMessage`, `Artifact` y otras; un borrador en el input puede clasificarse como "no despertó";
> en Linux falta `POC_UID`; volver a bajar el kit lo anida.


Variante **local** de la fase 0 (`docs/design/project-chat/04-poc.md` §1.7, PR #512). Sólo
responde dos preguntas: ¿Channels está disponible con tu suscripción? ¿despierta una sesión
interactiva inactiva? No prueba fallos, concurrencia ni reinicios: eso es la POC completa, que sigue
en VM/contenedores (`poc/channels/`).

Plataformas: **macOS** (principal) y **Linux de escritorio**. Windows no está cubierto.

## Qué se garantiza y qué no

| Requisito | Cómo |
| --- | --- |
| Perfil aislado | Un **usuario del sistema nuevo, estándar (no administrador)**, `pocchannels`: su propio HOME, `~/.claude`, llavero (macOS) y navegador. Se borra al final. No se usa `CLAUDE_CONFIG_DIR` en tu usuario: en macOS el CLI guarda el token en el llavero y podría pisar o mezclarse con el de tu instalación habitual |
| Suscripción, sin API key ni uso extra | `/login` oficial dentro del CLI del usuario temporal; `DISABLE_EXTRA_USAGE_COMMAND=1`; vos confirmás en tu cuenta que el uso extra está desactivado; `preflight` falla si hay variables de API key |
| Sin credenciales existentes | HOME nuevo; `preflight` comprueba que no hay credenciales de Claude (archivo, `~/.claude.json`, llavero) ni claves SSH antes del login |
| `fakechat` fijado y dependencias revisadas | Instalado desde el marketplace oficial y comparado por SHA-256 con `claude-plugins-official@7994c27` (`manifest.sha256`); `bun install --frozen-lockfile` (95 paquetes del `bun.lock` con integridad sha512; lista en `out/deps.txt`); falla si el lockfile cambia |
| Sin Docker, Shared Terminal, Proxmox ni producción | El kit no ejecuta `docker`, `ssh` ni contacta otros hosts que Anthropic, GitHub, `bun.sh` y npm; `preflight` comprueba que el usuario no es admin ni del grupo `docker` y que `docker ps` falla |
| Sin tocar tus proyectos, tu Claude Code ni tus sesiones | Todo vive en el HOME de `pocchannels`; el CLI y Bun se instalan **en ese HOME** (`preflight` falla si `claude`/`bun` resuelven a tu instalación); no se tocan managed settings de la máquina, `managed-mcp.json` ni perfiles MDM (si existen, `preflight` falla y se consulta) |
| Sin `--dangerously-skip-permissions` | Modo de permisos normal; **todas** las herramientas denegadas, incluida la respuesta de `fakechat` (su `reply` puede copiar cualquier archivo legible y servirlo sin autenticación). La medición sólo necesita `UserPromptSubmit` y `Stop`, y un turno con una herramienta rechazada igual termina en `Stop`. Si aparece un diálogo de permiso, contestás **No** |
| Registro | Hooks a archivo (`SessionStart`, `UserPromptSubmit`, `Stop`, `StopFailure`, `Notification`, `SessionEnd`) y log de depuración del CLI. El informe separa registro, despertar, latencia, `source` y correlación |
| Limpieza | `/logout`, copia redactada, borrado del usuario (HOME y llavero incluidos) |

### Limitaciones de seguridad de la variante local (aceptadas por diseño)

1. **Mismo equipo, mismo kernel.** El usuario temporal no está en un sandbox: puede leer archivos
   legibles por todos de otros usuarios. Mitigación: las herramientas de lectura y escritura están
   denegadas y los mensajes de prueba son triviales; en macOS tus carpetas personales son privadas
   por defecto.
2. **Red sin restringir.** Tu LAN, Proxmox incluido, es alcanzable a nivel de red desde el usuario
   temporal. Mitigación: no hay credenciales de producción en ese usuario y Claude no tiene
   herramientas de red ni de shell. A diferencia de la VM, aquí se demuestra que **no se toca**
   producción, no que **no se pueda**.
3. **`fakechat` escucha en `127.0.0.1` sin autenticación ni control de origen.** Durante las ~2,5 h
   de la prueba, cualquier proceso local de cualquier usuario **y cualquier página web abierta en
   cualquier navegador del equipo** (un formulario multipart a `/upload` o un WebSocket a `/ws` no
   necesitan permiso del navegador) puede enviar un prompt a esa sesión. Mitigación: **todas** las
   herramientas están denegadas, incluida `reply`, así que un prompt inyectado sólo produce texto en
   la Terminal 1 y consume cuota; el informe lo detecta (prompts ajenos durante la espera) y esa
   muestra no cuenta como correlación limpia. Conviene no navegar por sitios desconocidos durante la
   prueba.
4. **Código de terceros.** `fakechat` y sus 95 dependencias corren como el usuario temporal;
   versiones fijadas por lockfile con integridad, no auditadas línea por línea. El script de arranque
   del plugin ejecuta un `bun install` no congelado en cada inicio: `registration` vuelve a comprobar
   el pin después del arranque medido.
5. **Mismo plan.** Los ~12 turnos consumen el límite incluido de tu suscripción, compartido con tus
   sesiones reales; no hay gasto adicional.
6. **`claude.ai` en el navegador del usuario temporal.** El login se hace en el navegador de ese
   usuario (macOS) o en una ventana privada (Linux); el token nuevo vive sólo en ese usuario y se
   revoca/borra al final.

## Pasos exactos (macOS)

> `KIT_COMMIT` es el commit de la rama `poc/channels-phase0` indicado en la autorización.

### S0 — Preparación (sin suscripción)

1. **Con tu usuario administrador**, crear el usuario estándar temporal (pide contraseña):

   ```bash
   sudo sysadminctl -addUser pocchannels -fullName "POC Channels" -password -
   ```

2. **Entrar como `pocchannels`** con cambio rápido de usuario (menú de usuarios ▸ POC Channels).
   Completar el asistente sin Apple ID ni iCloud. Abrir **Terminal**.

3. Instalar Bun y Claude Code **fijados, en ese HOME** (instaladores oficiales):

   ```bash
   cd ~ && curl -fsSL https://bun.sh/install -o bun-install.sh && bash bun-install.sh bun-v1.3.10
   curl -fsSL https://claude.ai/install.sh -o claude-install.sh && bash claude-install.sh 2.1.314
   cat >> ~/.zshrc <<'RC'
   export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"
   export DISABLE_AUTOUPDATER=1 DISABLE_EXTRA_USAGE_COMMAND=1 FAKECHAT_PORT=18787
   RC
   exec zsh
   ```

4. Bajar el kit en el commit indicado:

   ```bash
   KIT_COMMIT=<sha completo indicado>
   mkdir -p ~/poc/kitsrc && cd ~/poc
   curl -fsSL "https://codeload.github.com/gatof81/shared-terminal/tar.gz/$KIT_COMMIT" | tar xz -C kitsrc --strip-components=1
   mv kitsrc/poc/channels-local kit && rm -rf kitsrc
   ```

5. Preparar e inspeccionar:

   ```bash
   bun ~/poc/kit/phase0.mjs setup       # settings del usuario temporal + fakechat + hashes + deps
   bun ~/poc/kit/phase0.mjs preflight   # evidencia S0 → ~/poc/out/preflight.md
   ```

   Si `setup` falla porque `claude plugin` exige login, **no es NO-GO**: correr
   `bun ~/poc/kit/phase0.mjs preflight --before-plugin`, seguir con el paso 6 y repetir `setup`
   justo después del `/login` (antes del paso 8).

   **Fin de S0**: `preflight.md` sin ningún FAIL. Revisarlo antes de seguir.

### S1 — Fase 0 (después de revisar S0)

6. **Terminal 1** — login oficial:

   ```bash
   mkdir -p ~/poc/workspace && cd ~/poc/workspace && claude
   ```

   Aceptar la confianza de la carpeta, `/login` ▸ **cuenta de Claude (suscripción)** ▸ autorizar en
   el navegador de este usuario. Nunca elegir API key ni Console. `/status` debe mostrar tu plan.
   Confirmar en claude.ai que el **uso extra está desactivado**. Después, `/exit`.

7. **Terminal 1** — relanzar con el canal, y **no escribir nada** en esta ventana desde ahora (un
   borrador en el input retiene los mensajes encolados):

   ```bash
   [ -f ~/poc/out/claude-debug.log ] && mv ~/poc/out/claude-debug.log ~/poc/out/claude-debug.$(date +%s).log
   cd ~/poc/workspace && claude --channels plugin:fakechat@claude-plugins-official --debug-file ~/poc/out/claude-debug.log
   ```

8. **Terminal 2** — medir, sin que el Mac se duerma:

   ```bash
   caffeinate -dimsu &
   bun ~/poc/kit/phase0.mjs registration                      # registrado, o NO-GO (salida 3)
   bun ~/poc/kit/phase0.mjs wake --count 10 --min-idle 30     # ~10–15 min
   bun ~/poc/kit/phase0.mjs wake --count 2 --min-idle 3600    # ≥ 2 h
   bun ~/poc/kit/phase0.mjs report                            # ~/poc/out/phase0-report.md
   kill %1
   ```

   Salidas de `registration`:
   - **0**: canal registrado; seguir.
   - **4 con "skip … todavía NO confirmado"**: puede deberse a flags remotos que aún no estaban en la
     caché de un HOME nuevo. Salir del CLI (`/exit`), esperar ≥ 60 s, repetir el paso 7 y
     `registration`. Sólo un segundo skip con el mismo motivo y los flags ya en caché es NO-GO.
   - **3**: **NO-GO confirmado**. No seguir y no cambiar de autenticación.
   - **4 con otro mensaje**: fallo del harness (puerto, pin, hooks); se corrige y se repite, nunca es
     NO-GO.

   `wake` se detiene sola en el primer mensaje sin `UserPromptSubmit`, ante un límite del plan
   (`StopFailure`) o con Ctrl-C, y nunca reintenta. Sin despertar sólo es **NO-GO** (salida 5) si el
   CLI registró la recepción del mensaje, la sesión sigue en su prompt y no hubo turno; cualquier
   otro caso es **indeterminado** (salida 8). Para repetir una tanda: `wake … --fresh` (la anterior
   se guarda aparte y el informe sólo cuenta la última).

### Limpieza

9. Anotar el uid del usuario temporal (`id -u`) para el paso 10. **Terminal 1**: `/logout`, `/exit`. **Terminal 2**: `bun ~/poc/kit/phase0.mjs archive` (copia
   redactada en `/Users/Shared/poc-channels-out-*`). Cerrar la sesión de `pocchannels`.
10. **Con tu usuario**: copiar el informe y borrar todo:

    ```bash
    cp -R /Users/Shared/poc-channels-out-* ~/Desktop/
    sudo sysadminctl -deleteUser pocchannels     # borra HOME, llavero, CLI, Bun, plugin
    sudo rm -rf /Users/Shared/poc-channels-out-*
    POC_UID=<uid anotado>
    sudo find /private/var/folders -maxdepth 4 -user "$POC_UID" -print    # revisar la lista
    sudo find /private/var/folders -maxdepth 4 -user "$POC_UID" -prune -exec rm -rf {} +
    ```

    Los temporales por usuario de macOS (`/private/var/folders/…`) sobreviven al borrado del usuario;
    por eso se eliminan por uid, sólo los de ese uid.

    En claude.ai, revisar que no quede ninguna sesión o autorización de la prueba.

## Linux

Igual, con estas diferencias:

- Paso 1: `sudo useradd -m -s /bin/bash pocchannels && sudo passwd pocchannels`. No añadirlo a
  `sudo` ni a `docker`.
- Paso 2: entrar con **cambio de usuario** en el escritorio (sesión gráfica propia). Si no hay
  escritorio: `sudo machinectl shell pocchannels@` y, en el `/login`, abrir la URL que imprime el
  CLI en una **ventana privada** de tu navegador.
- Paso 3: usar `~/.bashrc` en lugar de `~/.zshrc` (`exec bash`).
- Paso 8: `systemd-inhibit --what=sleep:idle sleep infinity &` en lugar de `caffeinate`.
- Paso 9: la copia redactada queda en `/tmp/poc-channels-out-*`.
- Paso 10: `cp -R /tmp/poc-channels-out-* ~/` (copiar primero), y después
  `sudo loginctl terminate-user pocchannels; sudo userdel -r pocchannels; sudo rm -rf /tmp/poc-channels-out-* "/tmp/claude-$POC_UID"`.
