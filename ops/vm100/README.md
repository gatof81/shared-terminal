# ops/vm100 — `st-ops`: operación de Shared Terminal sin root

Estado: **propuesta, revisión 3 (2026-11-03, tras la revisión independiente), NO-GO de instalación: nada instalado ni concedido.** Decisión del responsable: la sesión B
debe poder operar y desplegar Shared Terminal sin depender de A, **sin** root general, sin `sudo`, sin
el grupo `docker` y sin la identidad SSH de A; cada deploy requiere el GO explícito del responsable, y
el servidor verifica SHA, procedencia de `main`, CI, backup, preflight y resultado.

## Lo que hay hoy (medido 2026-11-03)

- A entra a VM100 como `diego` (`172.20.0.1:22`, clave `shared-terminal-session@vm100` en el workspace
  de A). `diego` tiene `sudo NOPASSWD: ALL` y está en `docker`: **root efectivo**. Seis claves en
  `~diego/.ssh/authorized_keys` tienen ese mismo poder.
- B no tiene ninguna clave para VM100.
- Los scripts operativos (deploy, backup, migraciones de sesiones) viven en `~diego` en el host, no en
  el repo ni en A.
- Las dos sesiones actúan en GitHub **como la cuenta del responsable** (`gh`, scopes `repo` +
  `workflow`) y `main` exige 0 revisiones. Consecuencia para este diseño: **ninguna aprobación hecha en
  GitHub puede ser el GO** — B podría producirla. El GO es una firma con la clave personal del
  responsable que B no tiene.

## Modelo

```
B ──ssh st-ops──▶ sshd (Match User st-ops: ForceCommand, sin TTY ni forwarding, ExposeAuthInfo)
                   └─▶ st-ops-dispatch   (como st-ops: parte el comando en ≤ 4 palabras [A-Za-z0-9._:-],
                        │                  identifica la clave por huella)
                        └─▶ sudo -n st-ops-root <huella> <palabras>   (única línea de sudoers)
                             └─▶ verbos; el deploy corre en una unidad systemd-run (st-ops-deploy-<id>)
```

| Pieza | Propiedad |
| --- | --- |
| Cuenta `st-ops` | sistema, sin contraseña (`passwd -l`), sin home, **fuera de `docker`/`sudo`/`adm`** (install.sh se detiene si no) |
| `authorized_keys` | `/etc/st-ops/authorized_keys`, root:root 0644: la cuenta no puede añadir ni cambiar claves |
| `identities` | `<nombre> <SHA256:huella>`: una clave no listada no ejecuta nada aunque sshd la acepte |
| `allowed_signers` | solo la clave personal del responsable, principal `owner`, namespace `st-ops-deploy@shared-terminal` |
| sudoers | `st-ops ALL=(root) NOPASSWD: /usr/local/lib/st-ops/st-ops-root` y nada más; `env_reset` |
| Programas | root:root, 0755, en `/usr/local/lib/st-ops/`; `st-ops-root` fija todas las rutas y revalida cada argumento (no confía en el dispatcher) |
| Estado | `/var/lib/st-ops/` root 0700: espejo git propio, solicitudes, resultados |
| Auditoría | `journalctl -t st-ops`: identidad, verbo, argumentos, resultado |

## Verbos

| Verbo | Efecto | Requiere firma |
| --- | --- | --- |
| `help`, `status`, `logs [n≤500]` | solo lectura (SHA desplegado, health, disco, compose, sesiones por nombre/estado, último backup, última línea off-host) | no |
| `request-deploy <sha>` | verifica y crea **una** solicitud pendiente (caduca a las 2 h); imprime el texto exacto a firmar | no |
| `request-text <id>` | los bytes exactos de la solicitud (`> request.txt`) | no |
| `deploy <id>` (firma por stdin) | consume la solicitud y lanza el pipeline | **sí** |
| `deploy-status <id>` | progreso (líneas propias del pipeline, nunca salida de comandos) y `result.json` | no |
| `cancel <id>` | retira una solicitud no iniciada | no |

Fuera de v1, cada uno con su GO aparte si se quiere: backup a demanda, recreación de sesiones,
resolución del composer, cambios de `.env` o de flags, imagen de sesión, rollback manual.

## Lo que el servidor verifica

En `request-deploy` y **otra vez** al comenzar el pipeline (el mundo puede haber cambiado entre medio):

1. SHA de 40 hex; existe en el **espejo propio** de `https://github.com/gatof81/shared-terminal.git`,
   traído por el servidor sin credenciales (el checkout de `diego` no es fuente de verdad).
2. Procedencia: el SHA está en la cadena **first-parent** de `main` (un commit integrado en `main`, no
   uno que solo existe en una rama mergeada) y desciende del SHA desplegado (st-ops no hace rollbacks
   a pedido).
3. CI: solo cuenta la **corrida propia de `.github/workflows/ci.yml`** disparada por `push` a `main`
   para ese SHA exacto (la última, si hubo re-ejecuciones), y de ella solo los check-runs de **su**
   check suite: el nombre de un check-run —ni siquiera con la app `github-actions`— no es identidad,
   porque cualquier workflow con `checks: write` puede publicar un "success" con cualquier nombre sobre
   cualquier SHA, y B puede empujar workflows. Requeridos (backend): `Backend`, `Frontend`, `Frontend e2e`.
   Un cambio de `ci.yml` que llegue a `main` sigue siendo posible (B mergea); por eso `.github/` aparece
   en `sensitive-paths` y la firma —con el diff revisado— es el control real.
4. Alcance **v1 = código de backend**, como *allowlist* (`ALLOWED_PATHS_RE`): `backend/src/`,
   `backend/{tsconfig,biome}.json`, `backend/vitest.config.ts`, `frontend/` (lo despliega Pages, no
   st-ops), `docs/`, `.github/`, `ops/`, `*.md` de la raíz, `LICENSE`, `.gitignore`, `.env.example`.
   **Cualquier otra ruta se rechaza** —`Dockerfile`, `docker-compose.yml`, `backend/package*.json`,
   `session-image/`, `.dockerignore`, un archivo nuevo en la raíz— y queda como deploy manual. Así lo
   desplegado es exactamente lo firmado: la imagen = `Dockerfile` + `backend/` del árbol firmado, con
   la definición de compose que ya está desplegada (byte a byte la del árbol firmado). Las rutas
   sensibles permitidas (`.github/`, `db.ts`, `ops/`) y el salto de migraciones van **en el texto
   firmado**, junto con `auto-rollback: previous-image | withheld`, `from-source`, la lista de commits
   (first-parent), el diffstat (`--no-renames`: un archivo movido cuenta por sus dos lados), un enlace
   `compare` y la línea fija `runs-as: root-equivalent (…docker.sock)`.
5. Firma: `ssh-keygen -Y verify` sobre los bytes exactos de `request.txt`, principal `owner`, namespace
   propio; caducidad; un solo uso (`used` se escribe **antes** de lanzar el pipeline: una aprobación
   se consume con el intento, nunca se puede reproducir); árbol del SHA = el firmado; el SHA desplegado
   sigue siendo el `from` firmado.

## Pipeline (`st-ops-deploy-run`, unidad systemd: una SSH caída no lo interrumpe)

1. Re-verificación (arriba), incluido que el salto de migraciones sea el firmado.
2. Preflight: no es un contenedor; el `app` del proyecto `COMPOSE_PROJECT` corre la imagen que
   `<proyecto>-app:latest` nombra (si no, hubo deriva manual y se rechaza); el `docker-compose.yml` del
   checkout es byte a byte el del árbol firmado y `compose config` valida; espacio ≥ `MIN_FREE_KIB`; todo
   registro de recreación `resolved`; **composer probadamente ocioso** (abajo); backend sano;
   instantáneas de sesiones, flags de `app`, hash de `.env` e ID de la imagen anterior.
3. **Build** desde el árbol firmado (abajo) con etiquetas `io.shared-terminal.st-ops.{sha,tree,request}`.
   El backend viejo sigue corriendo: un build fallido no cambia nada (`refused build`).
4. Backup con esa misma imagen (su `backup.ts` conoce el esquema destino; solo lectura,
   `DAC_READ_SEARCH`), verificado contra su manifest. Nombre `deploy-<sha12>-<ts>` en `.backups/`.
5. Nada cambió durante build + backup (SHA desplegado, imagen corriendo, sesiones, composer).
6. Arranque: `docker tag <nueva> <proyecto>-app:latest` + `compose -p … -f <compose firmado>
   up -d --no-build app`; health; la imagen corriendo *es* la construida.
7. Si el arranque falla:
   - la imagen anterior sigue corriendo y sana ⇒ `failed-not-started` (el código nuevo nunca corrió);
   - **hay migraciones en el salto** ⇒ `failed-rollback-withheld`: sin rollback automático (abajo);
   - sin migraciones ⇒ rollback a la **imagen anterior exacta, por ID** (sin reconstruir) ⇒
     `rolled-back` o `rollback-failed`.
8. Verificación: health, `/api/auth/status` 200, flags de `app` idénticos, `.env` intacto, sesiones
   intactas, la etiqueta de la imagen nombra el SHA, las líneas de arranque de captura/composer siguen.
   Si algo difiere ⇒ `deployed-unverified`, sin revertir: decide el responsable.
9. Registro **como el dueño del checkout**: `git fetch` + `checkout --detach <sha>` del checkout, para que un
   `compose up --build` manual posterior no reconstruya código viejo. Si falla, el resultado lo avisa.

Toda salida escribe un resultado: `stop` lo escribe; cualquier otra (un `die`, un abort de `set -e`,
SIGTERM por `RuntimeMaxSec=3600` o `systemctl stop`) pasa por el `trap` de salida, que escribe `aborted` y,
si la imagen nueva quedó etiquetada `:latest` sin estar corriendo, devuelve la etiqueta a la anterior (así un
`compose up` manual posterior no arranca código no verificado). SIGKILL o un corte de energía saltan el
`trap`: `deploy-status` responde `aborted-unknown` y `status` avisa si `:latest` no es la imagen que corre.

Nunca: edita `.env`, toca un contenedor de sesión, reconstruye la imagen de sesión, hace `prune`,
imprime un valor de configuración (la salida de comandos va a `private/`, root 0700).

### Confianza en el filesystem

Root **nunca** ejecuta git ni un build dentro del checkout de `diego`: su `.git/config` y sus hooks
(`core.fsmonitor`, filtros smudge/clean, `post-checkout`…) son de `diego`, y ejecutarlos como root le
daría root a esa cuenta *a través de st-ops*. El contexto de build es `git archive <sha>` del espejo de
root, extraído en un directorio nuevo de root (`private/src`): sin `.git`, sin hooks, sin configuración
de git, sin archivos no rastreados ni cambios locales. De ese checkout solo se leen `.env` (configuración
que st-ops no controla; su hash se compara antes/después) y `docker-compose.yml` (que debe coincidir byte
a byte con el firmado; compose usa la copia de root con `-p`/`-f` explícitos, sin descubrir overrides).
Lo poco que se hace en el checkout —leer `HEAD` antes del primer deploy con etiqueta, y el registro del
paso 9— corre como `diego` (`runuser`), que no gana nada que no tenga.

El SHA desplegado es la etiqueta de la imagen que corre (`from-source: image-label`). Sin etiqueta —el
primer deploy por st-ops, o tras un deploy manual— solo queda el `HEAD` del checkout leído como `diego`
(`from-source: checkout-head`), que **no** prueba qué corre ("mergeado y con pull, deploy pendiente" es un
estado normal acá): en ese caso el rollback automático queda `withheld` aunque no haya migración, porque
el salto calculado desde ese `from` puede estar mal. Un checkout cuyo dueño es root se rechaza.

El workspace root y el puerto de la API salen de `docker inspect` del `app` (la fuente del bind montado en
`/var/shared-terminal/workspaces` y el puerto publicado de `3001/tcp`), nunca de parsear `.env`: un
`export`, un comentario o una línea duplicada harían que el parseo no coincida con lo que resolvió compose,
y con una raíz equivocada las comprobaciones del composer, de las recreaciones y del backup pasarían en
vacío. El backup además se compara con los directorios de sesión que hay de verdad en esa raíz.

### Composer: falla cerrado

Un envío del composer en vuelo cuando `app` reinicia deja un registro de pane para `reconcile`; el deploy
solo sigue con **evidencia positiva** de que no hay ninguno, en dos capas que deben coincidir:

1. Disco: el registro de pane existe desde `prepared` (antes del primer efecto) hasta `released`
   (CONVERSATION.md §8.1.4), sea cual sea el proceso dueño y esté o no el flag encendido. Cualquier
   entrada en cualquier `.st-control/*/composer/` —registro, temporal de una escritura atómica, algo
   inesperado— o un directorio que no se puede listar ⇒ no ocioso.
2. Backend (solo con `CONVERSATION_COMPOSER_ENABLED` = `true`/`1`, la regla de `composerFlagEnabled`):
   token admin; `GET /api/admin/sessions` debe ser 200 con una lista de `sessionId` válidos; para cada
   uno, `GET …/composer/panes` debe ser 200 con `panes: []` **y** `unreadable: []`. 401, 403, 404, 5xx,
   error de transporte, JSON no válido o con otra forma ⇒ no ocioso.

### Migraciones y rollback

`migrateDb` aplica las migraciones al arrancar, antes de servir `/health`, y el ledger se escribe
**después** de `apply()`; el código viejo arranca contra cualquier esquema más nuevo sin comprobar nada
(salta las versiones que no conoce). Si el código nuevo cae después de migrar (total o parcialmente),
volver al viejo "levanta" pero sin ninguna garantía de compatibilidad. Por eso: **un salto de migraciones
desactiva el rollback automático** (`withheld`, visible en el texto firmado), y el responsable decide con
el backup del paso 4 a mano. Sin migraciones el esquema no se movió y el rollback a la imagen anterior por
ID es seguro. Los tests cubren los tres casos.

## Flujo de un deploy

```
B:      ssh st-ops request-deploy <sha> backend        → id + texto
B:      ssh st-ops request-text <id> > request.txt     → se lo pasa al responsable
Dueño:  (lee sha / from / migrations / sensitive-paths)
        ssh-keygen -Y sign -f ~/.ssh/<su clave personal> -n st-ops-deploy@shared-terminal request.txt
        → request.txt.sig (≈ 7 líneas) de vuelta a B
B:      ssh st-ops deploy <id> < request.txt.sig
B:      ssh st-ops deploy-status <id>
```

Si B mostrara un texto distinto del guardado, la firma no verifica contra la solicitud del servidor
(falla cerrado). El responsable aprueba exactamente lo que lee.

## Procedimiento de transferencia (cada paso con GO del responsable)

1. **Revisión** de este PR (revisión independiente) y merge.
2. **Instalación** por el responsable, como root, desde el checkout revisado:
   `sudo bash ops/vm100/install.sh`. No concede nada: `authorized_keys` e `identities` quedan vacíos.
3. **Clave del responsable**: una línea en `/etc/st-ops/allowed_signers`
   (`owner namespaces="st-ops-deploy@shared-terminal" ssh-ed25519 AAAA…`), de una clave que **no** esté
   en ninguna sesión.
4. **Clave de B**, generada dentro de B (la privada nunca sale de B):
   `ssh-keygen -t ed25519 -C st-ops@b-0665fa5a -f ~/.ssh/st_ops` (en `.st/ssh/`, persiste a recreaciones).
   Solo la pública viaja. El responsable la añade:
   - `/etc/st-ops/authorized_keys`: `restrict,from="172.20.0.0/16" ssh-ed25519 AAAA… st-ops@b-0665fa5a`
   - `/etc/st-ops/identities`: `b-0665fa5a SHA256:…`
   y en B: `Host st-ops` → `HostName 172.20.0.1`, `User st-ops`, `IdentityFile ~/.ssh/st_ops`,
   `IdentitiesOnly yes`.
5. **Prueba de independencia**: B hace `status`, luego un deploy real firmado de punta a punta, sin A.
6. Solo después, y como operación aparte: retiro de A y de su clave de `~diego/.ssh/authorized_keys`.

**Revocación inmediata**: borrar la línea de `authorized_keys` (efecto en el siguiente login), o
`sudo bash ops/vm100/uninstall.sh` (quita el acceso de todas las claves, conserva `/var/lib/st-ops`).

## Revisión independiente (2026-11-03, sobre `15cdec5`)

Sin BLOCKER; seis SHOULD-FIX y tres NIT, todos resueltos en la revisión 3:

| Hallazgo | Resolución |
| --- | --- |
| CI falsificable por B (check-runs con el nombre correcto desde otro workflow) | CI atado a la suite de la corrida `push` de `ci.yml` en `main` para el SHA |
| El texto firmado presentaba `backend/src/` como inocuo, pero `app` monta `docker.sock` | `runs-as: root-equivalent`, lista de commits, diffstat y `compare` en el texto firmado; el README pide revisar el diff |
| Sin etiqueta, `from` = HEAD del checkout podía declarar seguro un rollback con migración | `from-source`; `checkout-head` ⇒ `auto-rollback: withheld` |
| Workspace root adivinado desde `.env`: con una raíz errónea composer/recreación/backup pasaban en vacío | raíz y puerto desde `docker inspect`; backup comparado con los directorios reales; `find` que falla ⇒ falla cerrado |
| Un deploy abortado/matado no escribía resultado y podía dejar `:latest` en código no verificado | `trap` de salida, `RuntimeMaxSec`, `aborted-unknown`, aviso en `status` |
| La detección de renombres ocultaba el lado borrado | `--no-renames` en el alcance y en el diffstat |
| NIT: leer el flag del composer fallando = flag apagado | `docker inspect` fallido ⇒ no ocioso |
| NIT: comparación de migraciones sin comillas; comentario de expiración inexacto | comillas; comentario corregido (la expiración se verifica al consumir la aprobación) |
| NIT: `runuser` con un checkout de root | checkout de uid 0 ⇒ rechazo |

Sigue sin test: el pipeline `deploy_run` completo con Docker de verdad y `take_backup` (primera ejecución
supervisada en VM100).

## Límites conocidos (no los resuelve st-ops)

- La cuenta `diego` sigue siendo root efectivo con seis claves; st-ops protege **de B**, no de quien
  tenga una clave de `diego`. La auditoría de esas claves es un paso aparte.
- **La firma es el único control que B no puede producir.** CI y alcance acotan lo que llega a la firma,
  pero B escribe el código, lo mergea y redacta la solicitud; como `app` monta `docker.sock`, cualquier
  línea de `backend/src/` es root en VM100 tras el deploy. Antes de firmar: abrir el `compare` del texto y
  leer el diff completo.
- B sigue actuando en GitHub como el responsable: puede mergear a `main` (0 revisiones requeridas).
  st-ops no confía en eso para el GO, pero el merge sigue siendo disciplina. Recomendado: identidad
  propia de B en GitHub (cuenta de máquina o token fine-grained sin merge) y una revisión obligatoria
  del responsable vía CODEOWNERS.
- `from="172.20.0.0/16"` admite cualquier contenedor de `sessions-net`: la clave privada de B es lo
  que identifica, no la IP (la de B cambia con cada recreación).
- `status`/`logs` muestran nombres de sesiones y logs del backend: son datos de operador.
- La imagen base (`node:22-slim`) es una etiqueta mutable: el build no la fija por digest. Mismo
  comportamiento que el deploy manual de hoy; fijarla es un cambio del `Dockerfile` (y por eso un deploy
  manual).
- Entre el último chequeo del composer y el reinicio de `app` queda una ventana de segundos en la que un
  envío podría empezar; lo mismo que en los scripts manuales, y `reconcile` lo recupera por evidencia.
- `--project-directory` + `-f` de una copia: la resolución de rutas relativas de compose debe confirmarse en
  la primera ejecución supervisada (el compose actual no usa rutas relativas salvo el `build.context`, que
  `--no-build` no usa).

## Tests

`bash ops/vm100/test/run.sh` (173 casos) — sin root, sin Docker, sin red: dispatcher (metacaracteres,
longitud, login sin clave), configuración, identidades, CI (re-ejecución gana, app ajena no cuenta, check
ausente), firmas reales (otros bytes, otro namespace, clave del operador), procedencia (rama lateral;
`on_main` con 3000 commits bajo `pipefail` y SIGPIPE por defecto), alcance (allowlist en ambos sentidos),
política de rollback y `recover_after_failed_start` (migración + health caído ⇒ sin rollback; sin
migración ⇒ imagen anterior exacta; imagen nueva nunca arrancó), composer (registros en disco, directorio
ilegible, 401/403/404/500/transporte/JSON inválido en ambas llamadas), una solicitud pendiente a la vez,
consumo y no reproducción de la aprobación, caducidad. **No** cubren: el pipeline completo contra Docker
real ni `compose` (primera ejecución supervisada en VM100).
