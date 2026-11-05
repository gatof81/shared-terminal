# Handoff operativo — preflight de infraestructura (sin Claude)

**Código:** `gatof81/shared-terminal`, rama `poc/channels-phase0`, commit **`7e21340`**, directorio
`poc/obs-unified/`. **Qué valida:** sólo infraestructura (namespaces, PTY y cleanup) a través de las
mismas rutas de `RealSys` que usará el smoke, con un payload Python descartable. **No invoca Claude,
no usa Docker, no necesita red.**

## 0. Reglas de seguridad (no negociables)

- Ejecutar **sólo** en una VM Linux **descartable y nueva** (una VM completa, no un contenedor),
  aislada de **VM100**. **Se admite una VM temporal sobre el mismo hipervisor Proxmox** si está aislada
  de VM100 en los cuatro planos:
  - **Discos:** volúmenes propios, sin discos, volúmenes, bind mounts ni NFS de VM100, y sin el
    `WORKSPACE_ROOT` ni los directorios de evidencia.
  - **Redes:** bridge o VLAN propios, sin ruta hacia VM100, `sessions-net`, el backend ni el Cloudflare
    Tunnel. La VM puede quedar sin red: el preflight no la necesita (ver §2 para traer el código).
  - **Credenciales:** ni claves SSH, ni tokens (GitHub, Cloudflare, D1), ni `.env` o secretos de VM100
    o de producción.
  - **Accesos:** ni la VM llega a VM100, ni VM100 o las sesiones retenidas (PASS-B1 run-1/run-2) llegan
    a la VM.
- **Nunca** dentro de Shared Terminal (por ejemplo `Shared-Terminal-B`), ni en VM100, ni en un
  contenedor.
- **No** habilitar namespaces ni instalar paquetes en VM100.
- `refusal()` del script es una protección **parcial**: rechaza si ve marcadores de sesión de Shared
  Terminal (`SESSION_ID`, `ST_INGEST_TOKEN`, `ST_BACKEND_PORT`) o `/.dockerenv`, pero **no demuestra
  que el host no sea VM100**. La identidad y el aislamiento de la VM los verifica el operador por fuera (§7).
- Al terminar, la VM se **destruye**.

## 1. Prerrequisitos en la VM descartable

| Requisito | Comprobación |
| --- | --- |
| Linux ≥ 5.4 (Ubuntu 24.04 / Debian 12) | `uname -r` |
| Python ≥ 3.10 | `python3 --version` |
| util-linux con `unshare --kill-child` y `nsenter` | `unshare --help \| grep -- --kill-child`, `nsenter --version` |
| iproute2 (`ip`) | `ip -V` — sin `ip`, `check_isolation` da False |
| git | `git --version` |
| Ejecutar como **root** | `id -u` → `0` |
| User namespaces habilitados | `sysctl kernel.unprivileged_userns_clone` (si existe) = 1 · `sysctl user.max_user_namespaces` > 0 |

Ejecutarlo como **root** es intencional: `check_isolation` entra al netns con `nsenter -n` sin `-U`, y
según `setns(2)` un usuario no privilegiado no puede hacerlo. Además, la restricción de AppArmor de
Ubuntu (`kernel.apparmor_restrict_unprivileged_userns=1`) sólo afecta a usuarios no privilegiados.
Esto es un **límite conocido, no verificado empíricamente**: si el smoke real debe correr sin
privilegios, hay que revisarlo antes. **No** se instala Claude ni Docker en la VM.

## 2. Preparación

El código que se valida es el commit **`7e21340`**. Los commits posteriores sólo cambian
documentación.

**Opción A — sin credenciales ni conectividad con producción (recomendada; obligatoria si el
repositorio es privado).** En una estación de confianza que ya tenga acceso al repo:

```bash
git -C shared-terminal fetch origin poc/channels-phase0
git -C shared-terminal branch -f preflight-7e21340 7e21340
git -C shared-terminal bundle create preflight-7e21340.bundle preflight-7e21340
sha256sum shared-terminal/preflight-7e21340.bundle      # anotar el hash
```

Se copia el `.bundle` a la VM por un canal que no la conecte a producción: `scp` desde esa estación por
la red aislada de la VM, un disco o ISO adjunto temporalmente en Proxmox, o un USB. En la VM:

```bash
sha256sum preflight-7e21340.bundle                       # debe coincidir con el hash anotado
git bundle verify preflight-7e21340.bundle
git clone -b preflight-7e21340 preflight-7e21340.bundle shared-terminal && cd shared-terminal
git rev-parse HEAD                                       # debe imprimir 7e21340…
```

No se cargan tokens ni claves de GitHub en la VM.

**Opción B — repositorio público, VM con salida a Internet** (nunca con ruta hacia VM100 ni hacia la
red de producción):

```bash
git clone https://github.com/gatof81/shared-terminal.git && cd shared-terminal
git checkout 7e21340 && git rev-parse HEAD               # debe imprimir 7e21340…
```

**Tests unitarios.** Se guarda el log completo y el exit code real, sin tuberías que lo oculten:

```bash
mkdir -p /root/preflight-out && O=/root/preflight-out
cd poc/obs-unified
python3 -W error::ResourceWarning -m unittest test_obs_unified > $O/tests.log 2>&1
echo $? > $O/tests.exit
tail -3 $O/tests.log                                     # sólo para mirar: Ran 158 tests … OK
```

## 3. Línea base (antes)

```bash
O=/root/preflight-out
ps -eo pid,ppid,pgid,sid,stat,etimes,args --sort=pid > $O/ps.before
for t in pid net user; do lsns -n -t $t -o NS | sort -u > $O/lsns.$t.before; done
ls /dev/pts | wc -l > $O/pts.before
```

## 4. Comando exacto (3 corridas consecutivas)

Se usa un entorno limpio (`env -i`) para no heredar variables de ninguna sesión:

```bash
O=/root/preflight-out
for i in 1 2 3; do
  env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin python3 -I preflight_infra.py \
      > $O/run$i.json 2> $O/run$i.stderr
  echo $? > $O/run$i.exit
done
```

Cada corrida tarda unos segundos (la readiness tiene un timeout de 10 s y el payload espera hasta 60 s,
pero el reap lo termina antes).

## 5. Verificación de procesos residuales (después)

```bash
O=/root/preflight-out
ps -eo pid,ppid,pgid,sid,stat,etimes,args --sort=pid > $O/ps.after
for t in pid net user; do lsns -n -t $t -o NS | sort -u > $O/lsns.$t.after; done
ls /dev/pts | wc -l > $O/pts.after
ps -eo pid,args | grep -E '[P]REFLIGHT-READY|[u]nshare --map-root-user' > $O/residual.txt; echo "residual_rc=$?" >> $O/residual.txt
for t in pid net user; do diff $O/lsns.$t.before $O/lsns.$t.after > $O/lsns.$t.diff; done
```

(`grep` devuelve `residual_rc=1` cuando **no** encuentra nada, que es lo esperado. Los corchetes evitan
que el propio `grep` aparezca en el resultado.)

Si quedan residuos, **no** limpiarlos a mano para "dejarlo verde": registrarlos y destruir la VM.

## 6. Criterios PASS / FAIL

**PASS sólo si se cumple TODO en las 3 corridas:**

1. `runN.exit` = `0`.
2. `runN.json` es JSON válido con `"refused": null`.
3. `result` es exactamente: `spawned: true`, `stage: null`, `ns_identity: true`, `isolation: true`,
   `pty_frame_ok: true`, `cleanup_accredited: true`.
4. `environment`: `have_unshare`, `have_nsenter` y `have_ip` en `true`, y `uid: 0`.
5. Después de las 3 corridas: `residual.txt` sin coincidencias (`residual_rc=1`); `lsns.{pid,net,user}.diff`
   vacíos (ningún namespace nuevo que persista); `pts.after` = `pts.before`.
6. `tests.exit` = `0` y `tests.log` termina en `Ran 158 tests` … `OK`.
7. Confirmación externa de que la VM no es VM100 y de que cumple los cuatro planos de aislamiento de §0 (§7).

**FAIL ante cualquier otra cosa.** En particular:

- **Sin JSON, o con traceback en `runN.stderr`:** FAIL. El cleanup **no** se considera acreditado,
  porque el script puede terminar por una excepción inesperada antes de imprimir el JSON. Se conserva
  `runN.stderr` completo y se hace igual la verificación de §5.
- `stage: "before-launch"`: no se creó ningún proceso. Suele indicar `unshare` ausente o namespaces
  bloqueados.
- `stage: "after-launch"`: el proceso existió pero la readiness o la identidad del namespace falló.
  `cleanup_accredited` refleja lo que se pudo verificar (sin identidad del namespace queda en `false`).
- `isolation: false`: falta `ip`, `nsenter` sin permisos, hay una interfaz distinta de `lo`, o la
  conexión saliente prosperó.
- `pty_frame_ok: false`: el marcador del payload no apareció en el frame del PTY.
- `cleanup_accredited: false` o `null`: no hay evidencia de que el propietario y su namespace hayan
  terminado.

## 7. Datos a devolver (sin secretos)

1. **Identidad y aislamiento de la VM:** hipervisor (si es el mismo Proxmox, decirlo), nombre o ID de la
   VM, confirmación explícita de que no es VM100, `hostnamectl` (sin IPs públicas), `cat
   /etc/os-release`, `uname -a`, y evidencia breve de cada plano de §0:
   - discos: storage o volúmenes de la VM, sin volúmenes de VM100;
   - red: bridge o VLAN, y una prueba de que VM100 no es alcanzable desde la VM (por ejemplo `ping`
     o `nc -z` fallido, o "VM sin red");
   - credenciales: ninguna cargada;
   - accesos: ninguna regla ni túnel entre la VM y VM100.
2. **Herramientas:** `id`, `python3 --version`, `unshare --version`, `nsenter --version`, `ip -V`, y los
   valores de `sysctl kernel.unprivileged_userns_clone user.max_user_namespaces
   kernel.apparmor_restrict_unprivileged_userns` (los que existan).
3. `git rev-parse HEAD`, y con qué opción de §2 se trajo el código (con el SHA-256 del bundle si se usó
   la opción A).
4. Todo `/root/preflight-out/`: `tests.{log,exit}`, `run{1,2,3}.{json,stderr,exit}`, `ps.*`, `lsns.*`,
   `pts.*`, `residual.txt`.
5. Declaración de que no se instaló ni invocó Claude, no se usó Docker y no se tocó VM100.
6. Cualquier acción manual realizada, y la confirmación de que la VM se destruyó al final.

Con un PASS externo se evalúa el GO del smoke real con Claude y los tres controles. Ese GO no se deriva
de este documento.
