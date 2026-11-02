# POC de Channels — kit en VM (reservado para la POC completa)

> **Estado (2026-11-02):** la fase 0 ya **no** usa este kit. Por decisión del responsable corre en un
> usuario temporal de su Mac o PC (`poc/channels-local/`). Este kit de VM queda como base para la
> **POC completa** (fallos, concurrencia, reinicios), que necesita su propio GO. Antes de reutilizarlo
> hay que resolver los hallazgos de su revisión independiente:
>
> - `docker cp` a un `/tmp` tmpfs de un contenedor `--read-only` falla: usar `docker exec -i … cat >`.
> - El pin compara 7 hashes pero no el conjunto exacto de archivos: un `hooks/` o `skills/` añadido
>   pasaría.
> - Falta `forceLoginMethod: "claudeai"` en managed settings.
> - Un `evidence.md` truncado pasa la puerta de S1: exigir una línea final `RESULT: ALL-PASS`.
> - Las comprobaciones negativas de red dan PASS si la sonda misma falla: añadir controles positivos.
> - Varios fallos del harness se registran como NO-GO: estado de `upload`, detección por la etiqueta
>   exacta, hooks sin `SessionStart`, `fakechat` sobrante de la sesión de login, `skip` del canal no
>   clasificado por motivo.
> - `teardown.sh` puede borrar el volumen de credenciales sin `/logout` y sin comprobarlo.
> - El log de depuración se copia al host sin redactar; la redacción no cubre variantes de ids.
> - Menores: regla `OUTPUT` añadida al final (ufw), sin IPv6, sondas más laxas que el backend,
>   recuento de re-ejecuciones, `pkill` que se mata a sí mismo, `docker rm` por nombre.
>
> El kit local ya incorpora las correcciones equivalentes.


**Rama sin merge.** Diseño y criterios: `docs/design/project-chat/04-poc.md` (§1, §1.7, §7) en la PR
#512. Este kit sólo cubre la **fase 0**: disponibilidad de Channels con la suscripción del
responsable y despertar de una sesión inactiva con el plugin oficial `fakechat`. No es la POC
completa.

## Reglas que el kit hace cumplir o que el operador cumple

- Sólo en una **VM Linux x86_64 desechable**, en una máquina **físicamente independiente** del
  Proxmox de producción. Nunca en producción ni donde corran sesiones reales (Claude A, Home
  Automation, B). `guard.sh` aborta si ve señales de producción.
- **Sin** API keys, Console ni uso extra. El único login es el oficial de Claude Code, lo hace el
  responsable y el kit nunca lee ni copia las credenciales (sólo comprueba que el archivo existe).
- **Sin** credenciales existentes: volúmenes nuevos, ningún bind del host, sin socket de Docker.
- Si Channels está bloqueado para la suscripción: **NO-GO** y fin. No se cambia de autenticación.
- Todos los comandos se corren **como root en la VM** (las comprobaciones de firewall lo necesitan).

## Versiones fijadas

| Pieza | Valor |
| --- | --- |
| CLI | `2.1.314` (`DISABLE_AUTOUPDATER=1`) |
| Bun | `1.3.10` |
| `fakechat` | `anthropics/claude-plugins-official@7994c27` (`external_plugins/fakechat`); `fakechat/manifest.sha256` tiene el SHA-256 de sus 7 archivos |
| Imagen base | `node:22-bookworm-slim` (el digest queda en la evidencia) |

`fakechat` se instala desde el marketplace oficial, no desde una copia local, para seguir en la
allowlist de Anthropic. El pin se impone comparando hashes: si lo instalado no coincide con el
commit, `s0-plugin.sh` aborta.

## S0 — Preparación (sin suscripción)

```bash
cp config.env.example config.env    # completar PROD_CIDRS / PROD_PROBE_IPS (direcciones de producción)
sudo ./vm/provision.sh              # Docker + reglas que descartan tráfico hacia producción
sudo ./guard.sh                     # debe terminar en "guarda OK"
sudo ./s0-up.sh                     # imágenes, redes, proxy (fase setup), contenedor endurecido
sudo ./s0-plugin.sh                 # fakechat: instalación, hashes, deps, proxy a fase test, arranque offline
sudo ./s0-evidence.sh               # out/s0-evidence-*/evidence.md; sale 0 sólo si todo es PASS
```

`evidence.md` es lo que se presenta al responsable antes de S1. Prueba, entre otras cosas: sin
socket de Docker ni binds; `CapDrop ALL`, raíz de sólo lectura, usuario no root; sólo la red
`internal`; un dominio cualquiera y GitHub denegados; producción inalcanzable desde el agente, el
proxy y la VM; ninguna credencial en el contenedor; CLI fijado; `fakechat` idéntico al commit y
capaz de arrancar sin red de instalación.

Si `s0-plugin.sh` no puede instalar el plugin **sin login**, no es un NO-GO: se anota y la
instalación pasa a S1, después del `/login`, con el proxy en fase `setup` sólo durante la
instalación (requiere la autorización de S1).

## S1 — Fase 0 (sólo con la autorización del responsable, después de S0)

```bash
sudo ./s1-login.sh      # abre `claude` en tmux; el responsable hace /login y confirma que el uso extra está desactivado
sudo ./s1-start.sh      # relanza con --channels plugin:fakechat@claude-plugins-official; registra o NO-GO (salida 3)
sudo python3 -I s1-wake.py --count 10 --min-idle 30      # 10 despertares tras ≥ 30 s inactiva
sudo python3 -I s1-wake.py --count 2  --min-idle 3600    # 2 despertares tras ≥ 1 h inactiva
sudo python3 -I s1-report.py                             # out/phase0-report.md
sudo ./teardown.sh      # /logout primero, copia redactada, borrado; después destruir la VM
```

`s1-wake.py` envía **un** mensaje por muestra por la interfaz local de `fakechat` (`POST /upload`
en `127.0.0.1:8787` dentro del contenedor), sólo con el CLI verificado en su prompt
(`claude agents --json`) y sin turno abierto. Nunca reintenta. Se detiene en el primer no-despertar,
ante cualquier `StopFailure` (límite del plan, error) o con Ctrl-C.

### El informe separa cuatro cosas

| Dimensión | Fuente | Qué cuenta |
| --- | --- | --- |
| Registro del canal | log de depuración del CLI | `Channel notifications registered` o el motivo del `skip` |
| Despertar efectivo | hook `UserPromptSubmit` con el `message_id` enviado | llegó o no, latencia, inactividad previa |
| `source` del hook | campo `source` de ese hook | valor exacto o `<absent>` |
| Correlación | etiqueta `<channel>` del `prompt` + `Stop` | una sola etiqueta, `message_id` igual al enviado, `prompt_id` no visto antes, `Stop` del mismo `prompt_id`, ningún otro prompt durante la espera |

El veredicto aplica la tabla de `04-poc.md` §1.7 tal cual. **La fase 0 termina con el informe y
una nueva decisión del responsable**; ningún script avanza a la POC completa.

## Qué NO hace este kit

No construye el monitor ni `st-channel`, no usa la imagen de sesión, no toca Shared Terminal ni
ninguna sesión real, no usa la API con clave, no se mergea.
