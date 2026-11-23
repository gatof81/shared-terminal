# ops/st-ops — operar el kit de deploy de VM100 sin root general

Estado: **instalado en VM100 (desde R14, 2026-11-20); aprobación por Chat desde 2026-11-23.** Reemplaza el pipeline propio de #517 (`ops/vm100/`, que
queda abierto como referencia de seguridad): `st-ops` ya no construye, no hace backup ni reinicia; **solo valida,
registra y llama a los scripts fijos del kit** instalado en `/root/st-deploy-kit` (privado del host, no está en
este repo).

## Modelo

```
operador ──ssh st-ops──▶ sshd (Match User st-ops: ForceCommand, sin TTY ni forwarding, ExposeAuthInfo)
                          └─▶ st-ops-dispatch   (como st-ops: ≤ 4 palabras [A-Za-z0-9._:-], huella de la clave)
                               └─▶ sudo -n st-ops-root <huella> <palabras>   (única línea de sudoers)
                                    └─▶ verbo ─▶ /root/st-deploy-kit/bin/0N-*.sh (argv por elementos, nunca un shell)
```

| Pieza | Propiedad |
| --- | --- |
| Cuenta `st-ops` | sistema, sin contraseña, sin home, **fuera de `docker`/`sudo`/`adm`** (install.sh se detiene si no) |
| `/etc/st-ops/authorized_keys` | root 0644: la cuenta no puede añadir claves |
| `/etc/st-ops/identities` | `<nombre> <SHA256:huella> [<agente ACP>]`: una clave no listada no ejecuta nada |
| `/etc/st-ops/st-ops.conf` | repo, workflow y checks de CI requeridos, vencimiento, `WRITE_VERBS=off\|on` (antes `SIGNED_VERBS`, que se sigue leyendo) |
| Programas | root 0755 en `/usr/local/lib/st-ops/`; `st-ops-root` fija todas las rutas (el kit incluido) y revalida cada palabra |
| Estado | `/var/lib/st-ops/` root 0700: espejo git propio, pedidos (`requests/<id>/`) |
| Auditoría | `journalctl -t st-ops`: identidad, verbo, argumentos, código de salida y de error, por cada verbo |

## Verbos

| Verbo | Efecto | Aprobación |
| --- | --- | --- |
| `help`, `status` | commit del kit, `app` desplegado, último pedido y su estado | no |
| `propose` (stdin: datos de la release, ≤ 16 KiB, sin bytes de control salvo `\n`) | UN pedido: guarda los datos en `requests/<id>/r<RELEASE>.conf` (archivo 0600, directorio 0700, de root; nunca en el kit), lee por regex y sin evaluar `RELEASE` (1-4 dígitos), `FROM`/`TARGET` (sha40) y `P_DIST_FILE` (solo `<LOG del kit>/new-image-dist-all.txt`), una línea cada una; TARGET en la cadena first-parent de `main` y descendiente de FROM, CI verde; imprime el pedido y su código de aprobación `r<RELEASE>-<sha7 del TARGET>` | no |
| `request-text <id>` | los bytes exactos del pedido | no |
| `preflight <id> [<mensaje>]` | `01 --release-file <ruta absoluta de esos datos>`, una vez; registra su `LOG` | no |
| `approve <id> <mensaje>` | el mensaje de Chat del owner al agente operador que dice `OK <código>`, escrito después del `propose`, sin vencer, una sola vez | **es la aprobación** |
| `step <id> <paso> [<mensaje>]` | el siguiente paso, en orden y una vez: `backup` (02), `offhost` (02b `--detach`), `rollback-proof` (03), `deploy` (04 `--detach`), `acceptance` (06) | tras `approve` |
| `verify <id>` | 05 (solo lectura), después de `deploy` OK; repetible (vale el último), obligatorio antes de `acceptance` | no |
| `result <id> [<paso>]` | estado del pedido y de cada paso; el `.result` de un paso desacoplado | no |
| `cancel <id>` | cierra un pedido activo, también después de pasos que escriben (no deshace nada; solo deja de aceptar pasos); se niega mientras un paso esté `RUNNING` | no |

Un pedido activo a la vez. Termina con su primer paso fallido (`closed failed <paso>`), con `acceptance` OK
(`closed done`), con `cancel` o cuando vence su aprobación (`expired (approval)`, salvo que un paso siga en `RUNNING`); un paso
desacoplado se juzga por su `<LOG>/<nombre>.result` (`RESULT=OK` y `RC=0`). **BUSY** (exit 3, `RESULT … BUSY`, o
`RESULT=BUSY` en el `.result`) significa "el gate del kit no cambió nada": el paso no se consume y se puede volver a
pedir (su salida queda en `steps/<paso>.busy-<epoch>.out`). Un resultado desconocido nunca se reintenta. La salida de
cada paso llega tal cual (más la línea `RESULT`) y el código de salida del verbo es el del kit; un paso sin línea
`RESULT` es FAIL. `07-mint-ui-token.sh`, rollback, `.env`, flags, imagen de sesión, recreaciones y cambios del kit
no tienen verbo.

### Lo que se verifica antes de cada paso (preflight, approve, step y verify)

1. `git -C /root/st-deploy-kit rev-parse HEAD` == `kit-head` del pedido (la ruta es una constante de `st-ops-root`).
2. sha256 de los datos guardados == `release-conf-sha256` del pedido; y, una vez que preflight los congeló, también
   `<LOG>/release.conf` y que `<LOG>/run.conf` diga `KIT_HEAD=<kit-head>` y `RELEASE_CONF_SHA256=<el del pedido>`.
3. Orden, un solo uso y aprobación: `approve` se consume una vez; cada paso corre a lo sumo una vez (`mkdir`
   atómico antes de llamar al kit); un rechazo no consume el paso.
4. `--exclude-message <id>` solo en `preflight` y `deploy` (01 y 04, los únicos pasos con gate), y solo si la identidad
   tiene agente en `identities` y `bin/message-info.sh <id>` del kit (solo lectura, ya con el kit en el commit del pedido)
   responde con rc 0, última línea `RESULT message-info OK rc=0` y exactamente una línea de cada una de:
   `MESSAGE_ID=<id>`, `TO=<ese agente>`, `STATE=running`, `AGENT_EXISTS=yes`, `OWNER_IS_TOKEN_OWNER=yes`. Cualquier
   otra respuesta ⇒ rechazo, sin consumir el paso.

### La aprobación del owner (decisión del owner, 2026-11-23)

VM100 y la app tienen un solo usuario: la aprobación es un mensaje de Chat del owner, no una firma. `approve <id>
<mensaje>` pide al kit `bin/owner-approval.sh <mensaje> <agente> <código>` (solo lectura, una SELECT; el texto se
compara dentro de D1 y nunca se lee ni se imprime) y acepta solo rc 0, última línea `RESULT owner-approval OK rc=0` y
exactamente una línea de cada una de: `MESSAGE_ID=<mensaje>`, `FROM=owner`, `TO=<agente de la identidad>`,
`KIND=request`, `AGENT_EXISTS=yes`, `OWNER_IS_TOKEN_OWNER=yes`, `APPROVES_CODE=yes` (el texto contiene `ok <código>`,
sin importar mayúsculas) y `CREATED_EPOCH` no anterior al `created-epoch` del pedido (con 120 s de margen entre el
reloj de D1 y el del host). Además, un mensaje aprueba un solo pedido (`approved/message`).

Por qué prueba que fue el owner: el backend escribe `from_id = owner` solo para un mensaje enviado con el login del
owner (`routes/acp.ts`); el `st send` de un agente queda con el nombre del agente, y `owner` es un nombre de agente
reservado. El código nombra la release y el commit exacto: un "OK" para R16 no aprueba otra cosa, y uno escrito antes
del `propose` no aprueba nada.

El `LOG` de preflight se acepta solo si es `/root/st-deploy-r<RELEASE>-<sha7 del TARGET>-<UTC>`, un directorio (no un
enlace) de root, y contiene los datos y el kit del pedido; si no, el pedido se cierra.

## El pedido

```
st-ops kit request v1
id: 20261119T120000Z-0123456789ab
host: vm100
requested-by: qa
release: r13
release-conf-sha256: <sha256 de los datos>
from: <sha40>
target: <sha40>
kit-head: <commit de /root/st-deploy-kit>
compare: https://github.com/gatof81/shared-terminal/compare/<from>...<target>
commits (first-parent, N):
  <sha7> <asunto, solo imprimibles>
ci:
  ci: run <id> of .github/workflows/ci.yml: completed/success
  ci: ok <cada check requerido> (completed/success)
runs-as: root (kit /root/st-deploy-kit at kit-head: preflight backup offhost rollback-proof deploy verify acceptance)
release-conf:
  <los datos, línea por línea>
approval-valid-for: 86400s
approval-code: r13-<sha7 del target>
created: … / created-epoch: … / expires: … / expires-epoch: …
```

Todo texto del operador (asuntos de commits, datos) va indentado: nunca puede ser una línea `clave: `. Los datos
de una release son **ASCII** (sin bytes de control ni caracteres bidi o parecidos): `propose` rechaza otro byte
indicando la línea. El CI se lee como en #517: solo la corrida `push` de `ci.yml` en `main` para ese SHA y los
check-runs de **su** suite (el nombre de un check-run no es identidad: cualquier workflow con `checks: write` puede
publicar uno).

```
operador: ssh st-ops propose < rNN.conf ; ssh st-ops preflight <id> <msg>
owner:    en Chat, al operador: OK rNN-<sha7>
operador: ssh st-ops approve <id> <msg del owner> ; ssh st-ops step <id> backup ; … ; ssh st-ops result <id>
```

## Un deploy, paso a paso

Flujo del owner desde 2026-11-23 (reemplaza al de R14 con firma). El operador es un agente ACP (hoy @qa); `<msg>`
es el id del mensaje en el que el operador está trabajando **en ese momento**. Solo `preflight` y `deploy` aceptan
`<msg>` (`STEP_EXCLUDABLE`: son los únicos pasos con gate de operaciones); con cualquier otro paso es `ERROR usage`
sin consumir nada. Mientras el operador trabaja nadie le escribe: un mensaje nuevo para él es una operación abierta
y el gate da BUSY.

1. **Preparar** (el owner le pide el deploy al operador): el operador arma `rNN.conf`, corre `propose` y
   `preflight <id> <msg>`, y responde con un resumen corto — release, `compare`, commits, si trae migración, la
   última línea del preflight — y el código: "para aprobar, escribime `OK rNN-<sha7>`". Sin `approve` ni ningún
   `step`.
2. **Aprobar** (el owner, en Chat, al operador): `OK rNN-<sha7>`. Ese mensaje ES la aprobación; el owner no
   descarga ni firma nada. Plazo: `REQUEST_TTL` (24 h) desde el `propose`.
3. **Desplegar** (el operador, trabajando en ESE mensaje, `<msg>` = su id): `approve <id> <msg>`; `step <id>
   backup`; `step <id> offhost` y `result <id> offhost` hasta `RESULT=OK`; `step <id> rollback-proof`; y solo si
   los tres dieron OK, `step <id> deploy <msg>` — y termina el turno: el deploy reinicia el backend. Si la release
   trae una migración, en la respuesta incluye la línea `PASS migration step` de `<LOG>/migrate-check.txt` y las
   tablas del backup. Plazo: `APPROVAL_TTL` (24 h) desde el `approve`.
4. **Verificar** (el owner, unos minutos después: "verificá"): `result <id> deploy`, `verify <id>` y `step <id>
   acceptance`; el operador informa el resultado.

**BUSY** no cambió nada: se repite el mismo paso, con a lo sumo **3 intentos por paso** (contando todos los
mensajes) y 5 minutos entre intentos; después el operador se detiene e informa (por ejemplo durante la ventana
del backup nocturno, 08:00–09:00 UTC). El gate del deploy corre dentro de la unidad desacoplada, así que su BUSY
aparece recién en `result` (paso 4): el operador relanza `step <id> deploy <msg del mensaje actual>`, termina el
turno, y la verificación pasa a un mensaje más. **FAIL** cierra el camino: el operador no sigue e informa con la
salida. **Si el operador se interrumpe** a mitad de un mensaje, no se reenvía ese mensaje: se le pide `result <id>`
en uno nuevo y se sigue desde el paso que falte (el despachador no deja repetir uno ya corrido). **Un pedido que
quedó a medias** (por ejemplo deployado y con un verify que falló por un error del kit, ya juzgado por el owner) se
cierra con `cancel <id>`: no deshace nada y deja proponer el siguiente.

## Instalación (owner, como root, en dos etapas)

1. **Solo lectura.** Desde un checkout revisado de `main`: `sudo bash ops/st-ops/install.sh`. No concede nada:
   `authorized_keys` e `identities` quedan vacíos (y nunca se sobrescriben), y `st-ops.conf` nace con
   `WRITE_VERBS=off`: solo `help`, `status`, `propose`, `request-text`, `preflight`, `verify`, `result` y `cancel`.
   El owner añade la clave pública del operador (generada dentro de su sesión; la privada no sale):
   - `/etc/st-ops/authorized_keys`: `restrict,from="172.20.0.0/16" ssh-ed25519 AAAA… st-ops@qa`
   - `/etc/st-ops/identities`: `qa SHA256:… qa`
2. **Escritura**, tras probar la etapa 1: `WRITE_VERBS=on` en `/etc/st-ops/st-ops.conf`. La identidad del operador
   tiene que nombrar su agente (`qa SHA256:… qa`): la aprobación es un mensaje del owner a ESE agente. El kit
   instalado tiene que traer `bin/owner-approval.sh`.

**Desde la firma (antes del 2026-11-23):** reinstalar con `install.sh` (no toca `st-ops.conf` ni las claves; avisa
que `allowed_signers` ya no se usa, y se puede borrar). `SIGNED_VERBS=on` se lee como `WRITE_VERBS=on`; conviene
subir `REQUEST_TTL` y `APPROVAL_TTL` a `86400`. Un pedido propuesto antes no tiene `created-epoch` ni código: se
cierra con `cancel` y se propone de nuevo.

**Revocación**: borrar la línea de `authorized_keys` (efecto en el siguiente login); `WRITE_VERBS=off` (corta
`approve`/`step` al instante); o `sudo bash ops/st-ops/uninstall.sh` (quita todo acceso, conserva `/var/lib/st-ops`).

## Interfaz del kit

Todo está en `lib/st-ops-lib.sh`, sección "The kit's interface". Los pasos corren como root desde `/root/st-deploy-kit`
(`bash bin/0N-….sh`), con stdin `/dev/null`, `PATH` fijo y `LC_ALL=C`.

| Paso | argv | Resultado |
| --- | --- | --- |
| preflight | `01-preflight.sh --release-file <requests/<id>/r<RELEASE>.conf> [--exclude-message <id>]` | `LOG=/root/st-deploy-r<RELEASE>-<sha7 TARGET>-<UTC>`; `release.conf` y `run.conf` (`KIT_HEAD=<sha40>`, `RELEASE_CONF_SHA256=<64 hex>`) |
| backup | `02-backup.sh <LOG>` | línea `RESULT` |
| offhost | `02b-offhost.sh --detach <LOG>` | `<LOG>/02b-offhost.result` |
| rollback-proof | `03-rollback-proof.sh <LOG>` | línea `RESULT` |
| deploy | `04-deploy.sh --detach <LOG> [--exclude-message <id>]` | `<LOG>/04-deploy.result` |
| verify | `05-verify.sh <LOG>` | línea `RESULT` |
| acceptance | `06-acp-acceptance.sh <LOG>` | línea `RESULT` |

Contrastado con la sesión A (kits 9fd4f01, 17dd041 y aa87577):
- Los argv de la tabla.
- `--exclude-message` lo aceptan solo 01 y 04.
- Formatos de `run.conf` y del nombre del LOG.
- Un `.result` en OK tiene exactamente `RESULT=OK` y `RC=0`.
- `--detach` se puede relanzar sobre el mismo LOG solo si el `.result` anterior fue `RESULT=BUSY` (el viejo pasa a `.result.busy-<fecha>`).
- No hay modo "solo validar datos": la validación completa ocurre en 01.

`message-info.sh <id>` sigue el contrato revisado en 17dd041. A declaró en aa87577 una forma alternativa,
`message-info.sh <id> <agente>`, con exit 0 solo para un mensaje `running` a ese agente existente; todavía no está revisada.

## Límites conocidos

- **El mensaje del owner es el único control que el operador no puede producir.** El operador escribe el código,
  puede mergearlo (actúa en GitHub como el owner) y redacta los datos y el resumen que el owner lee; el kit corre como
  root. Lo que el owner aprueba es el código `rNN-<sha7>`: release y commit exactos de `main` con CI verde. Quien
  tenga el login del owner (o root en VM100) puede aprobar: con un solo usuario, es el mismo límite que antes tenía
  la clave de firma en su máquina.
- Un pedido se aprueba antes de `expires` y sus pasos que escriben corren dentro de `approval-valid-for` desde la
  aprobación (`APPROVAL_TTL`). Un paso que murió sin registrar su resultado (`RUNNING`) bloquea nuevos pedidos
  aunque la aprobación venza, hasta que root lo revise y lo cierre a mano
  (`echo "<motivo>" > /var/lib/st-ops/requests/<id>/closed`): st-ops nunca reintenta un resultado incierto.
- Un corte de SSH no mata un paso: `st-ops-root` ignora SIGHUP y el kit lo hereda **ignorado** (una señal ignorada
  al entrar a bash no se puede re-atrapar, así que el `trap … HUP` del kit no actúa); la salida sigue en
  `requests/<id>/steps/<paso>.out`. Un reinicio del host sí lo mata: queda `RUNNING`.
- El kit hereda `LC_ALL=C` y el `PATH` fijo de `st-ops-root`.
- La integridad del kit (repo limpio + `SHA256SUMS`) la verifica cada script del kit; st-ops solo ata el commit.
- El kit no tiene un modo "solo validar datos": `propose` lee solo `RELEASE`, `FROM`, `TARGET` y `P_DIST_FILE`, y la
  validación completa de los datos ocurre en `preflight` (01). Un dato inválido cierra el pedido allí.
- `from="172.20.0.0/16"` admite cualquier contenedor de `sessions-net`: identifica la clave, no la IP.

## Tests

`bash ops/st-ops/test/run.sh` — sin root, sin Docker, sin red: repos git reales, un kit falso (repo git con scripts
que imprimen `RESULT … rc=`; su `message-info.sh` y su `owner-approval.sh` responden desde archivos del test), API de
GitHub simulada. Cubre: dispatcher (metacaracteres, palabras, login sin clave), identidad desconocida, verbo y
palabras inválidas, `propose` (fuera de main, no descendiente, CI rojo, check falsificado de otra suite, datos
sin/duplicado TARGET, bytes de control, tamaño, código de aprobación), etapa 1, la aprobación (mensaje de un agente,
a otro agente, una respuesta, sin `OK <código>`, anterior al pedido, de otro dueño, agente borrado, rc ≠ 0, salida
alterada, identidad sin agente o de otro agente, mensaje ya usado por otro pedido, pedido vencido o anterior a la
aprobación por chat), orden y un solo uso, datos y kit cambiados después de aprobar (copia propia y la congelada en
el LOG), `--exclude-message` (ajeno, de otro agente, identidad sin agente, paso que no lo admite), 07 inalcanzable,
código de salida del kit, cierre por fallo (también desacoplado y sin línea `RESULT`), `cancel` después de pasos
que escriben y su rechazo con un paso `RUNNING`, el nombre viejo `SIGNED_VERBS`, e `install.sh` que no concede nada.
