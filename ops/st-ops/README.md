# ops/st-ops — operar el kit de deploy de VM100 sin root general

Estado: **propuesta, nada instalado ni concedido.** Reemplaza el pipeline propio de #517 (`ops/vm100/`, que
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
| `/etc/st-ops/allowed_signers` | solo la clave personal del owner, principal `owner`, namespace `st-ops-deploy@shared-terminal` |
| `/etc/st-ops/st-ops.conf` | repo, workflow y checks de CI requeridos, vencimiento, `SIGNED_VERBS=off\|on` |
| Programas | root 0755 en `/usr/local/lib/st-ops/`; `st-ops-root` fija todas las rutas (el kit incluido) y revalida cada palabra |
| Estado | `/var/lib/st-ops/` root 0700: espejo git propio, pedidos (`requests/<id>/`) |
| Auditoría | `journalctl -t st-ops`: identidad, verbo, argumentos, código de salida y de error, por cada verbo |

## Verbos

| Verbo | Efecto | Firma |
| --- | --- | --- |
| `help`, `status` | commit del kit, `app` desplegado, último pedido y su estado | no |
| `propose` (stdin: datos de la release, ≤ 16 KiB, sin bytes de control salvo `\n`) | UN pedido: guarda los datos en `requests/<id>/r<RELEASE>.conf` (archivo 0600, directorio 0700, de root; nunca en el kit), lee por regex y sin evaluar `RELEASE` (1-4 dígitos), `FROM`/`TARGET` (sha40) y `P_DIST_FILE` (solo `<LOG del kit>/new-image-dist-all.txt`), una línea cada una; TARGET en la cadena first-parent de `main` y descendiente de FROM, CI verde; imprime el texto a firmar | no |
| `request-text <id>` | los bytes exactos del pedido | no |
| `preflight <id> [<mensaje>]` | `01 --release-file <ruta absoluta de esos datos>`, una vez; registra su `LOG` | no |
| `approve <id>` (stdin: la firma) | firma del owner sobre los bytes exactos, sin vencer, una sola vez | **sí** |
| `step <id> <paso> [<mensaje>]` | el siguiente paso, en orden y una vez: `backup` (02), `offhost` (02b `--detach`), `rollback-proof` (03), `deploy` (04 `--detach`), `acceptance` (06) | tras `approve` |
| `verify <id>` | 05 (solo lectura), después de `deploy` OK; repetible (vale el último), obligatorio antes de `acceptance` | no |
| `result <id> [<paso>]` | estado del pedido y de cada paso; el `.result` de un paso desacoplado | no |
| `cancel <id>` | retira un pedido antes de cualquier paso que escribe | no |

Un pedido activo a la vez. Termina con su primer paso fallido (`closed failed <paso>`), con `acceptance` OK
(`closed done`) o cuando vence su aprobación (`expired (approval)`, salvo que un paso siga en `RUNNING`); un paso
desacoplado se juzga por su `<LOG>/<nombre>.result` (`RESULT=OK` y `RC=0`). **BUSY** (exit 3, `RESULT … BUSY`, o
`RESULT=BUSY` en el `.result`) significa "el gate del kit no cambió nada": el paso no se consume y se puede volver a
pedir (su salida queda en `steps/<paso>.busy-<epoch>.out`). Un resultado desconocido nunca se reintenta. La salida de
cada paso llega tal cual (más la línea `RESULT`) y el código de salida del verbo es el del kit; un paso sin línea
`RESULT` es FAIL. `07-mint-ui-token.sh`, rollback, `.env`, flags, imagen de sesión, recreaciones y cambios del kit
no tienen verbo.

### Lo que se verifica antes de cada paso (preflight, step y verify)

1. `git -C /root/st-deploy-kit rev-parse HEAD` == `kit-head` firmado (la ruta es una constante de `st-ops-root`).
2. sha256 de los datos guardados == `release-conf-sha256` firmado; y, una vez que preflight los congeló, también
   `<LOG>/release.conf` y que `<LOG>/run.conf` diga `KIT_HEAD=<kit-head>` y `RELEASE_CONF_SHA256=<el firmado>`.
3. Orden, un solo uso y aprobación: `approve` se consume una vez; cada paso corre a lo sumo una vez (`mkdir`
   atómico antes de llamar al kit); un rechazo no consume el paso.
4. `--exclude-message <id>` solo en `preflight` y `deploy` (01 y 04, los únicos pasos con gate), y solo si la identidad
   tiene agente en `identities` y `bin/message-info.sh <id>` del kit (solo lectura, ya con el kit en el commit firmado)
   responde con rc 0, última línea `RESULT message-info OK rc=0` y exactamente una línea de cada una de:
   `MESSAGE_ID=<id>`, `TO=<ese agente>`, `STATE=running`, `AGENT_EXISTS=yes`, `OWNER_IS_TOKEN_OWNER=yes`. Cualquier
   otra respuesta ⇒ rechazo, sin consumir el paso.

El `LOG` de preflight se acepta solo si es `/root/st-deploy-r<RELEASE>-<sha7 del TARGET>-<UTC>`, un directorio (no un
enlace) de root, y contiene los datos y el kit firmados; si no, el pedido se cierra.

## Texto que se firma

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
approval-valid-for: 21600s
created: … / expires: … / expires-epoch: …
```

Todo texto del operador (asuntos de commits, datos) va indentado: nunca puede ser una línea `clave: `. Los datos
de una release son **ASCII** (sin bytes de control ni caracteres bidi o parecidos en un texto que se firma):
`propose` rechaza otro byte indicando la línea. El CI se
lee como en #517: solo la corrida `push` de `ci.yml` en `main` para ese SHA y los check-runs de **su** suite (el
nombre de un check-run no es identidad: cualquier workflow con `checks: write` puede publicar uno).

```
operador: ssh st-ops propose < rNN.conf ; ssh st-ops preflight <id> <msg> ; ssh st-ops request-text <id> > request.txt
owner:    st-sign request.txt <sha256 que reportó el operador>      # ops/st-ops/owner/st-sign
operador: ssh st-ops approve <id> < request.txt.sig ; ssh st-ops step <id> backup ; … ; ssh st-ops result <id>
```

## Un deploy, paso a paso

Acordado por el owner y @architect tras R14 (2026-11-20, el primer deploy por st-ops). El operador es un agente
ACP (hoy @qa); `<msg>` es siempre el id del mensaje en el que el operador está trabajando **en ese momento** — el
de un mensaje anterior ya no está `running` y el despachador lo rechaza. Solo `preflight` y `deploy` aceptan
`<msg>` (`STEP_EXCLUDABLE`: son los únicos pasos con gate de operaciones); con cualquier otro paso es `ERROR usage`
sin consumir nada. Mientras el operador trabaja nadie le escribe: un mensaje nuevo para él es una operación
abierta y el gate da BUSY.

1. **Preparar** (mensaje al operador): `propose < rNN.conf`, `preflight <id> <msg>` y `request-text <id> >
   request.txt` en su workspace. Devuelve el id, el sha256 de `request.txt`, la última línea del preflight y su
   LOG. Sin `approve` ni ningún `step`.
2. **Firma del owner**, en su máquina: baja `request.txt` desde la vista Files de la sesión del operador (nunca
   copiado del chat: la firma es sobre los bytes exactos) y corre `st-sign request.txt <sha256>`. El script
   compara el sha, muestra el pedido **completo** (commits, CI, compare, `kit-head`, datos de la release), pide
   escribir `firmar`, firma con `~/.ssh/st-ops-sign` y verifica la firma como lo hará `approve`. Comprobar el sha
   solo prueba que la bajada no alteró el texto que armó el operador; lo que el owner aprueba es el contenido.
   Sube `request.txt.sig` a la sesión del operador (los uploads llevan un prefijo al azar en el nombre). Plazo:
   `REQUEST_TTL` (2 h) desde el `propose`.
3. **Aprobar y desplegar** (un mensaje): `approve <id> < …request.txt.sig`; `step <id> backup`; `step <id>
   offhost` y `result <id> offhost` hasta `RESULT=OK`; `step <id> rollback-proof`; y solo si los tres dieron OK,
   `step <id> deploy <msg>` — y el operador termina el turno enseguida: el deploy reinicia el backend. El OK de
   `step deploy` solo dice que la unidad arrancó. Plazo: `APPROVAL_TTL` (6 h) desde el `approve`.
4. **Verificar** (mensaje nuevo, unos minutos después): `result <id> deploy`, `verify <id>` y `step <id>
   acceptance`.

**BUSY** no cambió nada: se repite el mismo paso, con a lo sumo **3 intentos por paso** (contando todos los
mensajes) y 5 minutos entre intentos; después el operador se detiene e informa (por ejemplo durante la ventana
del backup nocturno, 08:00–09:00 UTC). El gate del deploy corre dentro de la unidad desacoplada, así que su BUSY
aparece recién en `result` (paso 4): el operador relanza `step <id> deploy <msg del mensaje actual>`, termina el
turno, y la verificación pasa a un mensaje más. **FAIL** cierra el camino: el operador no sigue e informa con la
salida. **Si el operador se interrumpe** a mitad de un mensaje, no se reenvía ese mensaje: se le pide `result <id>`
en uno nuevo y se sigue desde el paso que falte (el despachador no deja repetir uno ya corrido).

**Excepción:** el primer deploy que traiga una migración de base de datos corta el paso 3 en dos (approve hasta
rollback-proof; deploy en otro mensaje) para que se revise el backup antes del deploy: volver atrás ya no es solo
cambiar de imagen. Después, flujo corto siempre.

## Instalación (owner, como root, en dos etapas)

1. **Solo lectura.** Desde un checkout revisado de `main`: `sudo bash ops/st-ops/install.sh`. No concede nada:
   `authorized_keys`, `identities` y `allowed_signers` quedan vacíos (y nunca se sobrescriben), y `st-ops.conf`
   nace con `SIGNED_VERBS=off`: solo `help`, `status`, `propose`, `request-text`, `preflight`, `result` y `cancel`.
   El owner añade la clave pública del operador (generada dentro de su sesión; la privada no sale):
   - `/etc/st-ops/authorized_keys`: `restrict,from="172.20.0.0/16" ssh-ed25519 AAAA… st-ops@qa`
   - `/etc/st-ops/identities`: `qa SHA256:… qa`
2. **Escritura**, tras probar la etapa 1: la clave personal del owner (que no esté en ninguna sesión) en
   `/etc/st-ops/allowed_signers` (`owner namespaces="st-ops-deploy@shared-terminal" ssh-ed25519 AAAA…`) y
   `SIGNED_VERBS=on` en `/etc/st-ops/st-ops.conf`. La clave se crea una vez en la máquina del owner
   (`ssh-keygen -t ed25519 -f ~/.ssh/st-ops-sign`, con passphrase) y la línea se agrega con
   `echo '…' | sudo tee -a /etc/st-ops/allowed_signers` (un `sudo echo … >>` redirige como el usuario, no como
   root); se comprueba con `sudo cut -d' ' -f3,4 /etc/st-ops/allowed_signers | ssh-keygen -lf -` contra la huella
   de la clave. `ops/st-ops/owner/st-sign` va en el `PATH` del owner (`~/bin`); lee la clave de `ST_SIGN_KEY` si
   no es `~/.ssh/st-ops-sign`.

**Revocación**: borrar la línea de `authorized_keys` (efecto en el siguiente login); `SIGNED_VERBS=off` (corta
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

- **La firma es el único control que el operador no puede producir.** El operador escribe el código, puede
  mergearlo (actúa en GitHub como el owner) y redacta los datos; el kit corre como root. Antes de firmar: leer el
  `compare` y los datos del texto.
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

`bash ops/st-ops/test/run.sh` — sin root, sin Docker, sin red: firmas reales con claves generadas en el test, un
kit falso (repo git con scripts que imprimen `RESULT … rc=`), API de GitHub simulada. Cubre: dispatcher
(metacaracteres, palabras, login sin clave), identidad desconocida, verbo y palabras inválidas, `propose`
(fuera de main, no descendiente, CI rojo, check falsificado de otra suite, datos sin/duplicado TARGET, bytes de
control, tamaño), etapa 1, firmas (otra clave, otro namespace, otros bytes, basura, de otro pedido, vencida,
reusada), orden y un solo uso, datos y kit cambiados después de firmar (copia propia y la congelada en el LOG),
`--exclude-message` (ajeno, de otro agente, identidad sin agente, paso que no lo admite), 07 inalcanzable, código
de salida del kit, cierre por fallo (también desacoplado y sin línea `RESULT`), y `install.sh` que no concede nada.

`bash ops/st-ops/test/st-sign.test.sh` — el script del owner con una clave descartable y `ssh-keygen` real: sha
distinto o mal formado, sin confirmación, pedido vencido, primera línea ajena, `.sig` ya existente (todos sin
firmar), el pedido completo a la vista con los bytes de control visibles, y una firma que verifica como `approve`.
