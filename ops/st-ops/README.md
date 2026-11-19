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
4. `--exclude-message <id>` solo en `preflight` y `deploy`, y solo si la identidad tiene agente en `identities`. Además,
   `bin/message-info.sh <id>` del kit (solo lectura, ya con el kit en el commit firmado) tiene que responder con rc 0, última
   línea `RESULT message-info OK rc=0` y exactamente una línea de cada una de estas:
   `MESSAGE_ID=<id>`, `TO=<ese agente>`, `STATE=running`, `AGENT_EXISTS=yes` y `OWNER_IS_TOKEN_OWNER=yes`. Cualquier
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
operador: ssh st-ops propose < r13.conf ; ssh st-ops request-text <id> > request.txt ; ssh st-ops preflight <id>
owner:    ssh-keygen -Y sign -f <clave personal> -n st-ops-deploy@shared-terminal request.txt
operador: ssh st-ops approve <id> < request.txt.sig ; ssh st-ops step <id> backup ; … ; ssh st-ops result <id>
```

## Instalación (owner, como root, en dos etapas)

1. **Solo lectura.** Desde un checkout revisado de `main`: `sudo bash ops/st-ops/install.sh`. No concede nada:
   `authorized_keys`, `identities` y `allowed_signers` quedan vacíos (y nunca se sobrescriben), y `st-ops.conf`
   nace con `SIGNED_VERBS=off`: solo `help`, `status`, `propose`, `request-text`, `preflight`, `result` y `cancel`.
   El owner añade la clave pública del operador (generada dentro de su sesión; la privada no sale):
   - `/etc/st-ops/authorized_keys`: `restrict,from="172.20.0.0/16" ssh-ed25519 AAAA… st-ops@qa`
   - `/etc/st-ops/identities`: `qa SHA256:… qa`
2. **Escritura**, tras probar la etapa 1: la clave personal del owner (que no esté en ninguna sesión) en
   `/etc/st-ops/allowed_signers` (`owner namespaces="st-ops-deploy@shared-terminal" ssh-ed25519 AAAA…`) y
   `SIGNED_VERBS=on` en `/etc/st-ops/st-ops.conf`.

**Revocación**: borrar la línea de `authorized_keys` (efecto en el siguiente login); `SIGNED_VERBS=off` (corta
`approve`/`step` al instante); o `sudo bash ops/st-ops/uninstall.sh` (quita todo acceso, conserva `/var/lib/st-ops`).

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
