# Handoff operativo — preflight de infraestructura (sin Claude)

**Código:** `gatof81/shared-terminal`, rama `poc/channels-phase0`, commit **`7e21340`**, directorio
`poc/obs-unified/`. **Qué valida:** sólo infraestructura (namespaces, PTY y cleanup) a través de las
mismas rutas de `RealSys` que usará el smoke, con un payload Python descartable. **No invoca Claude,
no usa Docker, no necesita red.**

## 0. Reglas de seguridad (no negociables)

- Ejecutar **sólo** en una VM Linux **descartable y nueva**, completamente separada de **VM100**: otro
  host o hipervisor si es posible, sin discos compartidos, sin `sessions-net` y sin acceso a las
  sesiones o contenedores retenidos (PASS-B1 run-1/run-2).
- **Nunca** dentro de Shared Terminal (por ejemplo `Shared-Terminal-B`), ni en VM100, ni en un
  contenedor.
- **No** habilitar namespaces ni instalar paquetes en VM100.
- `refusal()` del script es una protección **parcial**: rechaza si ve marcadores de sesión de Shared
  Terminal (`SESSION_ID`, `ST_INGEST_TOKEN`, `ST_BACKEND_PORT`) o `/.dockerenv`, pero **no demuestra
  que el host no sea VM100**. La identidad de la VM la verifica el operador por fuera (§5).
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

```bash
git clone https://github.com/gatof81/shared-terminal.git && cd shared-terminal
git checkout 7e21340 && git rev-parse HEAD          # debe imprimir 7e21340…
cd poc/obs-unified
python3 -W error::ResourceWarning -m unittest test_obs_unified 2>&1 | tail -3   # esperado: Ran 158 tests … OK
mkdir -p /root/preflight-out
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
6. Los 158 tests unitarios pasan en la VM.
7. Confirmación externa de que la VM no es VM100 (§7).

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

1. **Identidad de la VM:** proveedor o hipervisor, nombre de la VM, confirmación explícita de que no es
   VM100 ni comparte host o disco con ella, `hostnamectl` (sin IPs públicas), `cat /etc/os-release`,
   `uname -a`.
2. **Herramientas:** `id`, `python3 --version`, `unshare --version`, `nsenter --version`, `ip -V`, y los
   valores de `sysctl kernel.unprivileged_userns_clone user.max_user_namespaces
   kernel.apparmor_restrict_unprivileged_userns` (los que existan).
3. `git rev-parse HEAD` y la última línea de los tests unitarios.
4. Todo `/root/preflight-out/`: `run{1,2,3}.{json,stderr,exit}`, `ps.*`, `lsns.*`, `pts.*`, `residual.txt`.
5. Declaración de que no se instaló ni invocó Claude, no se usó Docker y no se tocó VM100.
6. Cualquier acción manual realizada, y la confirmación de que la VM se destruyó al final.

Con un PASS externo se evalúa el GO del smoke real con Claude y los tres controles. Ese GO no se deriva
de este documento.
