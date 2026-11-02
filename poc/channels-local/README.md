# Fase 0 local — Channels con `fakechat` en tu Mac o PC

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
| Sin tocar tus proyectos, tu Claude Code ni tus sesiones | Todo vive en el HOME de `pocchannels`; el CLI y Bun se instalan **en ese HOME** (`preflight` falla si `claude`/`bun` resuelven a tu instalación); no se tocan managed settings de la máquina (si existen, `preflight` falla y se consulta) |
| Sin `--dangerously-skip-permissions` | Modo de permisos normal; herramientas denegadas salvo la respuesta de `fakechat` (`settings.template.json`). Si aun así aparece un diálogo de permiso, contestás **No**; el despertar ya quedó medido |
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
3. **`fakechat` escucha en `127.0.0.1` sin autenticación.** Mientras dura la prueba, cualquier
   proceso local de cualquier usuario podría enviar un mensaje a esa sesión. Mitigación: puerto alto
   (`18787`), ventana corta y herramientas denegadas: lo peor es una respuesta de texto.
4. **Código de terceros.** `fakechat` y sus 95 dependencias corren como el usuario temporal;
   versiones fijadas por lockfile con integridad, no auditadas línea por línea.
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
   KIT_COMMIT=<sha indicado>
   mkdir -p ~/poc && cd ~/poc
   curl -fsSL "https://codeload.github.com/gatof81/shared-terminal/tar.gz/$KIT_COMMIT" | tar xz
   mv "shared-terminal-$KIT_COMMIT/poc/channels-local" kit && rm -rf "shared-terminal-$KIT_COMMIT"
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

7. **Terminal 1** — relanzar con el canal, y **no escribir nada** en esta ventana desde ahora:

   ```bash
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

   `registration` con salida 3 = **NO-GO**: no seguir y no cambiar de autenticación. `wake` se
   detiene solo en el primer mensaje que no despierta, ante un límite del plan (`StopFailure`) o
   con Ctrl-C. Nunca reintenta.

### Limpieza

9. **Terminal 1**: `/logout`, `/exit`. **Terminal 2**: `bun ~/poc/kit/phase0.mjs archive` (copia
   redactada en `/Users/Shared/poc-channels-out-*`). Cerrar la sesión de `pocchannels`.
10. **Con tu usuario**: copiar el informe y borrar todo:

    ```bash
    cp -R /Users/Shared/poc-channels-out-* ~/Desktop/
    sudo sysadminctl -deleteUser pocchannels     # borra HOME, llavero, CLI, Bun, plugin
    sudo rm -rf /Users/Shared/poc-channels-out-*
    ```

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
- Paso 10: `sudo loginctl terminate-user pocchannels; sudo userdel -r pocchannels; sudo rm -rf /tmp/poc-channels-out-*`.
