# G3-1 + higiene de la imagen — procedimiento de release y ventana `observe` (nada ejecutado)

Estado: **procedimiento final, nada ejecutado (2026-11-06).** Decisiones del responsable: D1-a
(identidad `1befd89+R1`) y D2-C (candidato = `main` con la corrección de higiene, PR #555). El deploy
necesita la autorización explícita del responsable (#555 ya está mergeado: `R = e198b07`, §0); cada etapa de escritura (§2
backup, §3 deploy, §5 `observe`) necesita además su propia autorización. La lista única para el
operador está en §8. G3-2 sigue en NO-GO y el preflight de F1 es una tarea
independiente del operador.

Alcance y tabla de digests: [12-g3-1-release-scope.md](./12-g3-1-release-scope.md) (§7 = qué reportó
A y qué falta). Referencias: CONVERSATION.md §3.1.1 (v1.8.6), DEPLOYMENT.md («Ingest network origin»,
«Backend (Docker Compose)», «Backup & restore», «Rollback (from 3.0d)»),
[10-g3-sender-identity.md](./10-g3-sender-identity.md).

## 0. Alcance: G3-1 + higiene de la imagen, sobre un SHA fijo `R`

`R` = el commit de `main` que resulte del merge (squash) de **#555**. Se fija en este documento en el
momento del merge; hasta entonces el procedimiento no se puede ejecutar.

**Fijado (2026-11-07): `R = e198b07`** (#555 mergeado por el responsable). Entre `a93232f` y `R` entran
también #550 y #542 (docs) y #552 y #553 (frontend, que Pages publica por su cuenta). El delta de
backend, imagen y Compose es sólo el de #555 (`.dockerignore`, `Dockerfile`, `prebuild`). Build limpio
de `backend/` en `e198b07` (B, local): `dist/**/*.js` = `d1f310d8…` (104) y `dist` completo =
`0e50e8fd…` (416), idénticos a `a93232f`. `main` ya avanzó (`166ff78`, #547 con su bandera apagada):
**el checkout del deploy es `e198b07`, no la punta de `main`**. Sigue en NO-GO hasta la autorización
del responsable y el resto del preflight (12 §7.2).

| | Valor | Fuente |
| --- | --- | --- |
| Backend en producción (`D`) | **`1befd89+R1`** (D1-a): `dist/**/*.js` = `1b116d5a…` (104) = los 103 de `1befd89` + `dist/ringBuffer.js` `236c9aa6…` (compilado de `e61910d`, inerte). Imagen `221e6851`, contenedor `da75082e` | A (medición) + B (reproducción exacta, 12 §7.4) |
| Destino `R` | **`e198b07`** (squash de #555; no la punta de `main`). `dist/**/*.js` = **`d1f310d8…` (104)**; `dist` completo = **`0e50e8fd…` (416)**, idénticos a `a93232f` | repo (build reproducible) y CI de #555 |
| Cambios de runtime del backend `D → R` | **sólo #545** (G3-1, apagado por defecto) | repo |
| Cambios de build | **#555**: `.dockerignore` raíz (allowlist), `COPY` por nombre en el `Dockerfile`, `prebuild` que limpia `dist`, job de CI `backend-image` | repo |
| Resto de `1befd89..R` | #548, #551, #552, #553 (frontend); #544 (tests); #550, #542 (docs) | repo |
| Migraciones | ninguna | repo |
| Compose / `.env.example` | sólo la línea que reenvía `INGEST_REQUIRE_SESSION_ORIGIN`, vacía por defecto | repo |
| `session-image/` | **sin cambios** en `1befd89..R` | repo |
| Frontend | Pages, camino aparte; no forma parte de este procedimiento. Sin acople: el backend de `R` no cambia ninguna ruta que use el frontend | repo |

Fuera de este release, sin excepción: construir o etiquetar la imagen de sesión, recrear sesiones,
tocar contenedores retenidos (PASS-B1 incluidos), cambiar `.env`, activar `observe` o `true`.

## 1. Gate previo (sólo lecturas)

Columna «Estado»: **A** = reportado por A en el preflight del 2026-11-06; **pendiente** = falta la
lectura (12 §7.2 tiene la lista exacta para pedírsela a A). Todas se **repiten** en la misma ventana
del deploy, inmediatamente antes de §3: el preflight anterior es contexto, no el gate.

| # | Qué | Cómo (lectura) | Esperado | Estado |
| --- | --- | --- | --- | --- |
| P1 | Identidad del backend | digest de `dist/**/*.js` del contenedor en ejecución (12 §1) + `docker inspect` del contenedor y de su imagen | `1b116d5a…` (fila `1befd89+R1`, D1-a); imagen `221e6851…`; contenedor `da75082e…` | A: medido; en la ventana se repite para comprobar que nada cambió |
| P2 | G3-1 no está | `docker compose exec app grep -c INGEST_REQUIRE_SESSION_ORIGIN dist/index.js` | `0` | A (reportado «G3-1 no está en el `dist`») |
| P3 | Alcance | `git log --oneline 1befd89..R` | los PRs de §0 | B (al fijar `R`) |
| P4 | Bandera ausente | `grep -c '^INGEST_REQUIRE_SESSION_ORIGIN=' .env` y `printenv INGEST_REQUIRE_SESSION_ORIGIN` **en el shell del operador** (Compose da prioridad al entorno del shell sobre `.env`). El `printenv` dentro del contenedor actual no prueba nada: `1befd89` no reenvía la variable. La comprobación decisiva es la de §3 paso 5 | `0` y vacío | A (`.env`); pendiente: el shell |
| P5 | Captura | `GET /api/admin/stats` → `.conversation` | `enabledSessions = effectiveSessions = 3` | A (3/3); pendiente: `eventsSinceBoot`, `rejectedSinceBoot`, `gapsSinceBoot` con hora |
| P6 | Pérdidas del relay (línea de base) | conteos de `relay_dropped` / `relay_restart` en `.conversations/*/*.events.jsonl` | registrados | pendiente |
| P7 | Inventario de contenedores | `docker ps -a --no-trunc --filter name=st- --format '{{.ID}} {{.Names}} {{.State}}'` (`State`, no `Status`: `Status` cambia con el tiempo) | lista completa registrada | A |
| P8 | Nada en vuelo | recreaciones: `jq -r .state` de cada `recreate-attempt.json` = `resolved` (y si alguna tiene `retained`); Composer: `GET …/composer/panes` por sesión = `panes: []`, `unreadable: []` (404 = apagado) | todo `resolved`; sin panes | A: 3 recreaciones `resolved`, «0 operaciones»; **pendiente:** confirmar que el Composer se midió por panes y por sesión, y si hay `retained` |
| P9 | Sesiones | `GET /api/admin/sessions` proyectado con el `jq` de la nota de abajo (cada fila trae también `envVars`: no se registra) → lista `sessionId → status` | registrada; se repite en §3 paso 5 para V10 | pendiente |
| P10 | Espacio | `df -h` del filesystem de `WORKSPACE_ROOT` y del data-root de Docker; `docker system df`; tamaño estimado del backup | §1.1 | A: 36 GB libres, 82 %; **pendiente:** el resto |
| P11 | Imagen de rollback y nombre de la imagen de compose | `docker image inspect 221e6851 --format '{{.Id}} {{json .RepoTags}} {{.Size}}'`; `docker inspect da75082e --format '{{.Config.Image}}'`; `docker compose config --images` (los dos nombres tienen que coincidir: es la `<imagen de compose>` de §3 y §4); `docker run --rm --network none --entrypoint node 221e6851 -v` | ID completo, etiqueta, tamaño, nombre de la imagen y versión de Node | pendiente |
| P12 | Excepción local del Dockerfile y árbol de deploy | `git rev-parse HEAD`, `git symbolic-ref -q HEAD` (rama o detached), `git status --porcelain`, `git diff --stat`, `sha256sum session-image/Dockerfile`, `test -e .dockerignore && echo present` | sólo `M session-image/Dockerfile`; hash registrado; **sin** `.dockerignore` en la raíz (si existe uno sin versionar, el checkout de `R` no puede crearlo ⇒ se detiene) | A (existe y está aprobada); **pendiente:** las lecturas exactas |
| P13 | Línea de base del log | todo el log retenido del contenedor actual, **incluido su arranque si la rotación lo conserva** (`docker logs da75082e`): el **conjunto de mensajes distintos** con `"level":50` o `"level":60` (pino JSON: error y fatal; no contar la palabra «error») | conjunto registrado (para V1), con la indicación de si cubre el arranque | pendiente |

Nota P9 (fuera de la tabla, para copiar sin escapes): `jq '.[] | {sessionId, status, createdAt}'`. Los
comandos con `|` dentro de las tablas se copian desde la vista renderizada.

**Si cualquier fila sale distinta de lo esperado, se detiene todo y se informa. No se corrige en el
momento.** Un digest distinto de `1b116d5a…` invalida este procedimiento entero (12 §7.4).

### 1.1 Espacio necesario

Con 36 GB libres y 82 % usado, el disco ronda los 200 GB. El presupuesto, sobre el filesystem que
corresponda a cada cosa (P10):

- **imagen nueva del backend:** como mucho el tamaño de `221e6851` (comparte la base `node:22-slim`)
  más la caché de build;
- **backup:** el estimado de P10 (los tarballs de workspaces, uploads y `.conversations` más los
  `.jsonl` de D1) con un 20 % de margen. Por defecto va a `<WORKSPACE_ROOT>/.backups/<ts>`, el mismo
  disco;
- **rollback:** **0 adicional**: es la imagen `221e6851` que ya existe, protegida con una etiqueta
  (§3 paso 1). No se reconstruye nada para volver.

**Gate:** después del backup y del build tiene que quedar **≥ 20 GB libres y uso < 90 %**. Si el
estimado no entra, NO-GO de este procedimiento y decide el responsable (por ejemplo, backup directo al
NAS). Durante toda la ventana están prohibidos `docker image prune`, `docker system prune` y
`docker builder prune`.

## 2. Etapa de backup (escritura, autorización propia, inmediatamente antes de §3)

1. Repetir P8 y P10.
2. `docker compose exec app npm run backup` (lo ejecuta el backend `1befd89`, que ya incluye
   `conversation_user_meta`). Registrar la ruta que imprime.
3. **Verificación del backup**, antes de seguir:
   - existe `manifest.json` (se escribe último: sin él, el backup está incompleto ⇒ NO-GO);
   - el manifiesto nombra con su tarball cada sesión que **tiene directorio en disco** (el backup salta
     las sesiones de D1 sin directorio, y relee cada tarball con `tar -tzf` antes de escribirlo);
   - se registran las sesiones con `concurrentChanges` (las sesiones vivas dan un punto de
     recuperación, no una foto consistente; es lo esperado);
   - `du -sh` del directorio y el espacio libre resultante (gate de §1.1). La ruta que imprime es la
     del contenedor (`/var/shared-terminal/workspaces/.backups/<ts>`): en el host es
     `<WORKSPACE_ROOT del host>/.backups/<ts>`.
4. Copia al NAS con `sha256sum` de origen y destino: **recomendada**, decisión del responsable (A ya
   informó un backup anterior en el NAS).

Nunca se ejecuta `restore` en este procedimiento.

## 3. Deploy (sólo el servicio `app`, con la bandera apagada)

Ventana coordinada por el responsable: el reinicio corta unos segundos los WebSocket y la ingesta
de hooks de **todas** las sesiones, incluida la de A. **Congelamiento durante toda la ventana:** nadie
envía por el Composer, crea, recrea, inicia ni detiene sesiones, y no hay clientes de la API de exec
(Agent Hub en pausa). Un reinicio aborta los bootstraps en curso (la sesión queda `failed`) y corta
los streams de exec, cuyo registro está en memoria.

1. **Proteger la imagen de rollback** (escritura que sólo agrega una referencia):
   `docker tag <ID completo de 221e6851> st-backend-rollback:1befd89`.
2. **Checkout preservando la excepción del Dockerfile.**
   - Antes: guardar `git status --porcelain`, `sha256sum session-image/Dockerfile` y
     `git diff -- session-image/Dockerfile > <fuera-del-repo>/Dockerfile.local.patch`.
   - `git fetch origin` y `git checkout --detach R` (**sin** `-f`). Como `1befd89..R` no cambia
     `session-image/Dockerfile`, git conserva la modificación local. **Si git se niega, se detiene:**
     nunca `git stash`, `git checkout -f`, `git checkout -- …`, `git reset --hard`, `git clean`,
     `git pull` ni `git switch --discard-changes`.
   - Después: `git rev-parse HEAD` = `R`; `git status --porcelain` idéntico al de antes;
     `sha256sum session-image/Dockerfile` idéntico; `.dockerignore` presente y versionado. (Que `HEAD`
     y `.dockerignore` difieran de P12 es lo esperado.)
   - El `backend/dist` local del checkout **no se toca**: con #555 no entra en el contexto del build.
3. **Construir sin reiniciar:** `docker compose build app`. Sólo `app`: el servicio `session-image`
   está en el perfil `build` y **no** se nombra; nunca `--profile build`,
   `docker build -t shared-terminal-session` ni `scripts/build-session-image.sh`.
4. **Verificar la imagen nueva antes de usarla** (contenedor descartable, sin red):
   - `docker run --rm --network none --entrypoint sh <imagen de compose> -c 'cd /app && find dist -type f -name "*.js" | LC_ALL=C sort | xargs sha256sum' | sha256sum`
     ⇒ **`d1f310d83394c672133be555402ca1ea5067b79d3a8d1a9b181bb8fae7d3b124`**;
   - lo mismo sin `-name "*.js"` (todo el `dist`) ⇒ **`0e50e8fdca9174b6c8590468b992efce852307f1d36ddf7601e770fcbbe46193`**, y
     `find dist -type f | wc -l` ⇒ **416**;
   - `docker run --rm --network none --entrypoint node <imagen de compose> -v`: se registra junto a la
     de P11. La base `node:22-slim` es una etiqueta móvil: si la versión difiere, se informa y **decide
     el responsable** antes de seguir (el `dist` es idéntico, el runtime de Node no);
   - registrar el ID de la imagen nueva.

   Cualquier otro valor ⇒ NO-GO: el backend sigue siendo el actual, sin reinicio, y se informa. No se
   acepta ningún archivo extra: la excepción R1 vale **sólo** para la imagen `221e6851`.
5. **Gate final**, inmediatamente antes del paso 6:
   - P8 (recreaciones y panes del Composer); cualquier cosa en vuelo ⇒ se espera o se aborta, nunca
     se reinicia encima;
   - **ningún bootstrap posible en curso:** en `GET /api/admin/sessions`, ninguna sesión con
     `createdAt` en los últimos **15 minutos** (el tope del bootstrap es de 10 min y empieza después del
     insert y del spawn); si hay una, se espera;
   - la lista `sessionId → status` de P9 se vuelve a tomar **ahora** (es la base de V10);
   - **la bandera, como la va a ver el backend nuevo:** desde el checkout de `R`,
     `docker compose config --format json | jq -r '.services.app.environment.INGEST_REQUIRE_SESSION_ORIGIN'`
     ⇒ vacío, y `printenv INGEST_REQUIRE_SESSION_ORIGIN` en el shell ⇒ vacío. Cualquier valor ⇒
     NO-GO.
6. `docker compose up -d --no-deps --no-build --force-recreate -t 30 app`.
   - `--force-recreate` recrea `app` aunque Compose no detectara un cambio.
   - `-t 30` deja que el backend termine su apagado ordenado (su watchdog es de 10 s, igual al timeout
     por defecto de Docker, así que sin `-t` podría recibir SIGKILL a mitad del drenaje).
   - `--no-deps` hoy no cambia nada (`app` no declara `depends_on`): impide que uno futuro levante otro
     servicio.

   Nunca `docker compose down`, `--remove-orphans`, `restart` de otros servicios, ni operaciones
   sobre contenedores `st-*`.

### 3.1 Verificación posterior (lecturas)

| # | Esperado |
| --- | --- |
| V1 | `app` en ejecución y `healthy`; en el log del contenedor nuevo, ningún mensaje `"level":50`/`60` cuyo texto no esté en el conjunto de P13 (se compara por texto del mensaje, no por cantidad; si P13 no cubría el arranque, un error que sólo aparece en el arranque se informa y lo juzga el responsable antes de cualquier rollback) y **sin** la advertencia `INGEST_REQUIRE_SESSION_ORIGIN=… is not true\|observe\|false` |
| V2 | Digests del `dist` del contenedor en ejecución = los del paso 4 (`d1f310d8…` y `0e50e8fd…`/416) y su imagen = la registrada en el paso 4; `grep -c INGEST_REQUIRE_SESSION_ORIGIN dist/index.js` > 0; ID de la imagen nueva registrado |
| V3 | **Bandera apagada:** `printenv INGEST_REQUIRE_SESSION_ORIGIN` vacío; en `.conversation` **no** aparecen `originRejectedSinceBoot` ni `originObservedSinceBoot` |
| V4 | Inventario P7 idéntico (ID, nombre y `State`) de los `st-*`, retenidos y PASS-B1 incluidos |
| V5 | Captura: `enabledSessions = effectiveSessions = 3`; con actividad real `eventsSinceBoot` crece y Chat muestra eventos nuevos de las tres |
| V6 | Pérdidas: a lo sumo **un** `gap` `relay_dropped`/`relay_restart` por conversación, y tiene que ser el **primer evento de esa conversación después del reinicio**. Inmediatamente antes de ese mismo primer evento se aceptan además `gap` `missing_delta`/`missing_prompt`, que son la consecuencia de lo perdido durante el corte. También se aceptan sin un `relay_*` propio cuando el `relay_*` quedó en otra conversación de la misma sesión, o la pérdida sólo aparece en los contadores no atribuidos. El relay informa la pérdida en el siguiente envío que sí llega, así que en una sesión quieta ese `gap` puede aparecer mucho después del reinicio. Cualquier otro motivo de `gap`, o cualquier `gap` más adelante en la conversación, es FAIL. Límite: las pérdidas que el relay no puede atribuir a una conversación quedan sólo en contadores del proceso |
| V7 | Composer: `…/composer/panes` de cada sesión sigue vacío; recreaciones: todas `resolved` |
| V8 | Excepción del Dockerfile intacta: `git status --porcelain` y `sha256sum session-image/Dockerfile` idénticos a P12 (`HEAD` = `R` y `.dockerignore` presente, como se espera); `st-backend-rollback:1befd89` presente |
| V9 | Variables no secretas del contenedor iguales a las de antes, salvo la diferencia esperada: aparece `INGEST_REQUIRE_SESSION_ORIGIN=` **vacía**. Si P11 y el paso 4 dieron versiones distintas de Node, `NODE_VERSION` también difiere (aceptado por el responsable en el paso 4) |
| V10 | La lista `sessionId → status` es igual a la del paso 5. Ninguna sesión pasa a `stopped` sin una de estas dos explicaciones en el log: el sweeper de inactividad, o la reconciliación de una sesión cuyo contenedor ya no corría |

## 4. Rollback

- **Disparadores:** V1–V10 fallan, o aparece una regresión de captura o de sesiones.
- **No hay migración que cruzar** y la imagen anterior existe localmente; volver no reconstruye nada.
- **Pasos:**
  1. Comprobar P8 de nuevo: **nunca** volver atrás con una recreación sin resolver ni un envío del
     Composer pendiente (DEPLOYMENT.md).
  2. `git checkout --detach 1befd89` con las mismas reglas que §3 paso 2 (la excepción del
     Dockerfile se conserva y se verifica igual; después del checkout, `.dockerignore` **ya no
     existe**, como se espera). **Nunca se reconstruye desde ese checkout:** sin
     #555, un build volvería a meter el `backend/dist` del host. El rollback es sólo por imagen.
  3. `docker tag st-backend-rollback:1befd89 <imagen de compose>` (el nombre de P11) y
     `docker compose up -d --no-deps --no-build --force-recreate -t 30 app`. El checkout va **antes**
     del `up`: así Compose usa la configuración de `1befd89`.
  4. Verificar: imagen del contenedor = `221e6851…` (ID completo de P11) y `dist/**/*.js` =
     `1b116d5a…` (identidad `1befd89+R1`, D1-a; ningún otro valor se acepta), más V1, V3–V10. En V9 la
     referencia es la lista de **antes** del deploy, sin `INGEST_REQUIRE_SESSION_ORIGIN`.
- **Qué preserva:** contenedores de sesión intactos; `.conversations/` nunca se borra; `.env` no se
  tocó. El `.env` no necesita cambio: `1befd89` no reenvía la variable.
- **Rollback de la ventana `observe`** (sin tocar el código): quitar la variable de `.env` (o ponerla
  en `false`) y ejecutar `docker compose up -d --no-deps --no-build --force-recreate -t 30 app`, que recrea sólo el contenedor del
  backend con el entorno nuevo.

## 5. Ventana `observe` (otra autorización)

**Activación:**
1. `INGEST_REQUIRE_SESSION_ORIGIN=observe` en `.env`, y luego `docker compose up -d --no-deps --no-build --force-recreate -t 30 app`. Esto
   reinicia el backend: hay que planificar la hora.
2. Verificar: `printenv` muestra `observe`, y aparece `originObservedSinceBoot` mientras no aparece
   `originRejectedSinceBoot`.

**Línea de base:** antes de activar, una ventana con la bandera apagada de **la misma duración** que la
de `observe`, con las lecturas P5 y P6 al principio y al final.

**Duración:** al menos 24 h de uso real. En ese tiempo cada sesión con captura activa tiene que
producir hooks (por lo menos un prompt).

**Importante:** los contadores son del proceso y se reinician con cada reinicio del backend. Se leen
**antes** de cualquier reinicio, y un reinicio dentro de la ventana la reinicia.

| Eje | PASS (todo) | FAIL (cualquiera) |
| --- | --- | --- |
| **Coincidencia de origen** | `byCause` = sólo `match`; `sessionsNotMatched = 0`; `sessionsMatched` = cantidad de sesiones que produjeron hooks en la ventana | cualquier `mismatch`, `loopback`, `no_remote`, `no_container`, `container_*`, `not_running`, `no_address` o `identity_changed` en una sesión legítima |
| **Latencia** (no existe una métrica directa; ver §7) | `inspect_timeout = inspect_pending = inspect_failed = 0` (cada inspección respondió en < 500 ms). Además, una muestra en el host de 20 × `time docker inspect -f '{{.Id}}' <st-…>` con p95 < 100 ms (lectura) | cualquier `inspect_timeout`, `inspect_pending` o `inspect_failed`, o una p95 de la muestra ≥ 100 ms |
| **Pérdidas de eventos** | Los conteos de `relay_dropped` / `relay_restart` (P6) y el delta de `gapsSinceBoot` durante la ventana ≤ a los de la línea de base de igual duración; `eventsSinceBoot` crece al ritmo habitual; `rejectedSinceBoot` sin motivos nuevos | más pérdidas o *gaps* que la línea de base, o un motivo de rechazo nuevo |
| **Regresiones** | Chat muestra la actividad de todas las sesiones con captura; el log del backend sin errores nuevos | lo contrario |

**Ante un FAIL:** se vuelve a `false` (§4, sin reconstruir), se conserva toda la evidencia y se
informa. No se reintenta ni se ajusta nada sobre la marcha.

### 5.1 Ventana O1: B como única sesión con captura (criterio consolidado, 2026-11-07)

A preparó una ventana `observe` de 24 h (O1) con B como única sesión efectiva, con una línea de base
comparable y un rollback automático. La versión anterior de esta sección exigía 3/3 sesiones para un
PASS de B: suponía las tres sesiones con captura del preflight. Esta versión la reemplaza. **HA y HZ no
se tocan para cumplir el gate.**

**Lo que dice el código de `R`** (`index.ts`, `conversation/service.ts` `authorize` y `adminStats`,
`conversation/registry.ts`):

1. La bandera es del proceso. Con `observe`, cada request **autenticada** de cada sesión pasa por la
   comprobación de origen (plazo de 500 ms, nunca rechaza). Lo que falla antes va a
   `rejectedSinceBoot`, y lo que descarta el relay, a P6.
2. Sólo una sesión con `conversation_requested = 1`, `running` y un hash de token autorizado puede
   autenticarse. Las demás se rechazan **antes** de la comprobación (`disabled`, `bad_token`,
   `not_running`). `enabledSessions` cuenta exactamente las sesiones con `conversation_requested = 1`.
3. `sessionsMatched` y `sessionsNotMatched` cuentan sesiones distintas, sin ids.

**Consecuencia, bajo precondiciones:** si durante **toda** la ventana B es la única sesión con
`conversation_requested = 1`, todo lo que cuentan `originObservedSinceBoot` y sus dos conteos es de B.
Dos lecturas puntuales no ven una sesión que se pidió y se dejó de pedir entre ellas. Por eso la
exactitud depende de congelar lo que cambia ese indicador:

**Precondiciones de O1** (todas; si una falla al principio, O1 no da PASS-B):
- `CONVERSATION_ALLOW_USERS` vacía en el backend en ejecución: `docker compose exec app printenv
  CONVERSATION_ALLOW_USERS` ⇒ vacío, leído después del `up` que activa `observe`. Si no está vacía, una
  sesión nueva de esos owners (también las creadas en su nombre, #420) nace con la captura pedida;
- congelamiento de la captura durante toda la ventana: ningún `PATCH /api/admin/sessions/:id/conversation`,
  ningún `conversation:enable-all`, ninguna recreación y ningún `restore`. Ponen
  `conversation_requested` en 1 el `PATCH` admin (enable), el create con `CONVERSATION_ALLOW_USERS` y
  `restore`; `enable-all` y la recreación se congelan además porque cambian la revocación global o el
  token y el contenedor. El `conversation:disable` de emergencia **nunca** se prohíbe: si
  se usa, el resultado pasa a PASS-observado o INCONCLUSIVE;
- `enabledSessions = effectiveSessions = 1` y B es esa sesión.

**`<inicio>`** es el origen de los contadores: `docker inspect -f '{{.Id}} {{.State.StartedAt}} {{.RestartCount}}' <contenedor app>`
del contenedor que arrancó con `observe` (`<inicio>` = su `StartedAt`), registrado con las lecturas del
principio. **Al final se repite la misma lectura y tiene que ser idéntica.** `app` tiene
`restart: unless-stopped`: tras un crash Docker reinicia el **mismo** contenedor, los contadores vuelven
a cero y el log se conserva, así que sólo esta lectura muestra el reinicio. Si cambió, hubo un reinicio
dentro de la ventana (INCONCLUSIVE, o FAIL si se vio un FAIL antes). Los contadores son
de ese proceso, así que la ventana empieza ahí, no en la hora de las lecturas.

**Lecturas** (al principio y al final, con la hora; todas existentes y de sólo lectura):
- P5: `GET /api/admin/stats → .conversation` completo;
- P9: la lista `sessionId → status`;
- el contenedor de B: `docker inspect -f '{{.Id}} {{.State.StartedAt}}' <contenedor st- de B>` (como en P7).
  Si el `Id` o el `StartedAt` cambian, hubo al menos un evento de ciclo de vida;
- **sólo al final**, que el congelamiento se cumplió (lecturas existentes, sin contenido):
  - `docker logs --since <inicio> <contenedor app> 2>&1 | grep -cE '\[admin\] (conversation (enabled|disabled)|recreate)'` ⇒ 0,
    **sólo si el log cubre toda la ventana**: la primera línea retenida tiene que ser del arranque de
    este contenedor, con su hora a ≤ 60 s de `<inicio>` (`docker logs -t <contenedor app> 2>&1 | head -1`
    da la hora de Docker en RFC 3339). El log del `app` rota a 3 × 10 MB; si ya no conserva el arranque,
    la lectura falta (INCONCLUSIVE). Es la única
    evidencia de un enable seguido de un hard delete, que no deja `REVOKED` ni fila;
  - `find <WORKSPACE_ROOT>/.conversations -maxdepth 2 -name REVOKED -newermt '<inicio>'` ⇒ vacío;

  si alguna da otra cosa, la precondición se incumplió;
- el bloque `capture` de B. Lo da `GET /api/sessions/<B>/conversations`, que es **owner-only** (con la
  identidad del dueño de B) y devuelve también títulos, así que se proyecta en el cliente:
  `jq '.capture | {requested, effective, pendingReasons, checkedAt}'`. No se guarda nada más. Cuesta un
  probe del relay de B y, como todo pedido autenticado bajo `/api/sessions/:id`, renueva el reloj de
  inactividad de B.

**Veredictos.** Se aplica **el primero de esta lista que corresponda**: FAIL > INCONCLUSIVE >
PASS-observado > PASS-B. Un FAIL visto antes de un reinicio sigue siendo FAIL.

| Veredicto | Condiciones |
| --- | --- |
| **FAIL** | cualquier `byCause` distinto de `match`, `sessionsNotMatched > 0`, cualquier `inspect_*`, o un FAIL de latencia, pérdidas o regresiones de §5. Con las precondiciones cumplidas es de B; si no, no se sabe de qué sesión (§7) |
| **INCONCLUSIVE** | `sessionsMatched = 0` (no hubo tráfico autenticado); un reinicio del backend dentro de la ventana sin un FAIL previo; una lectura que falta; B sin `requested` o sin `effective` en alguna lectura; con `enabledSessions = 1`, `effectiveSessions` ≠ 1 en alguna lectura |
| **PASS-observado** | ninguna de las anteriores, pero `enabledSessions` ≠ 1 en alguna lectura, o una precondición incumplida. Dice que ninguna sesión autenticada falló la comprobación, no que B estuvo en la muestra |
| **PASS-B** | todas las precondiciones; en las dos lecturas `enabledSessions = effectiveSessions = 1` y B con `requested` y `effective`; `byCause` sólo `match`; `sessionsMatched = 1`, `sessionsNotMatched = 0`; latencia, pérdidas frente a la línea de base y regresiones de §5 en PASS |

**Qué demuestra un PASS-B:**
- en 24 h de uso real, cada request autenticada de B salió de la dirección de **su** contenedor actual
  en `sessions-net`. Con `true` no se habría descartado ningún hook legítimo de B;
- las inspecciones de Docker respondieron dentro del plazo con el tráfico real de B, y no hubo más
  pérdidas que en la línea de base;
- lo anterior, a través de los eventos de ciclo de vida de B que muestre la lectura de su contenedor
  (`Id` / `StartedAt`). Si no cambiaron, no se afirma nada sobre un reinicio o una recreación.

**Qué no demuestra:**
- nada sobre HA ni HZ: sus contenedores, su antigüedad o su configuración de red no se ejercitaron;
- el comportamiento con varias sesiones a la vez (caché e inspecciones concurrentes);
- el camino de rechazo (token usado desde otro contenedor, loopback, Internet): el uso normal no lo
  ejercita y sólo lo prueban los tests de CI;
- una recreación o un reinicio del contenedor de B, si no ocurrió en la ventana;
- la latencia directa de la ingesta (no hay métrica; §7);
- nada de G3-2.

**Qué permite decidir:** un PASS-B **no** autoriza `true`. Es evidencia para que el responsable
considere `true` **mientras B sea la única sesión con captura pedida**. Bajo `true`, habilitar la
captura en otra sesión (HA, HZ o una nueva) necesita antes su propia ventana `observe`, o volver a
`observe`. Si no, un desajuste suyo descartaría sus hooks: es fail-closed y no un riesgo de seguridad,
pero pierde captura. G3-2 sigue en NO-GO.

**Recomendación:** O1 tiene valor diagnóstico formal sólo con las precondiciones de arriba
(`CONVERSATION_ALLOW_USERS` vacía, captura congelada, `enabledSessions = 1` y B como esa sesión). En ese
caso, seguir adelante. Si A encuentra `enabledSessions` > 1 al principio, O1 sólo puede
dar PASS-observado, INCONCLUSIVE o FAIL: sigue sirviendo para detectar un problema, pero no para un PASS de B, y no
se cambia HA ni HZ para corregirlo. Si el responsable quiere O1 sólo por el PASS-B, en ese caso se
**suspende**.

**Rollback ante un FAIL.** `observe` nunca rechaza, así que esperar no cuesta captura. Lo automático
es sólo **registrar y avisar**: leer y guardar con la hora las lecturas de arriba (volver a `false` pone
los contadores en cero) y notificar. El reinicio a `false` es una escritura en VM100 dentro de la
autorización de la ventana, y se hace sólo cuando se cumplen las mismas guardas que cualquier reinicio
de este procedimiento:
- **P8**: recreaciones `resolved` y Composer sin panes. Un reinicio sobre una recreación sin resolver la
  deja sin resolución posible (D8);
- §3 paso 5: ninguna sesión con `createdAt` en los últimos 15 minutos (un reinicio aborta el bootstrap
  y la sesión queda `failed`);
- ningún cliente de la API de exec activo (Agent Hub en pausa). **No hay lectura que lo compruebe** (el
  registro de execs es del proceso y no se lista), así que es una **confirmación humana** del
  responsable o de A antes del reinicio;
- si alguna guarda no se cumple, no reinicia: registra y espera.

Si A automatiza el reinicio, la automatización comprueba P8 y los 15 minutos en cada intento, y
reinicia sólo con la confirmación humana del exec ya dada. Después del reinicio se verifica la vuelta:
`printenv INGEST_REQUIRE_SESSION_ORIGIN` vacío o `false`, y V3 (no aparecen `originObservedSinceBoot` ni
`originRejectedSinceBoot`). Los disparadores
son sólo las condiciones de FAIL que se pueden decidir en cualquier momento (`byCause`,
`sessionsNotMatched`, `inspect_*`); las comparaciones con la línea de base y las regresiones se juzgan
al final.

**Precondiciones que no constan aquí:** el deploy de `R` con V1–V10 en PASS (§3.1) y la línea de base
con la bandera apagada de igual duración. Este documento no supone que ya ocurrieron.

## 6. Evidencia mínima antes de considerar `true`

El operador devuelve, sin tokens, cookies ni contenido de conversaciones:

1. P1–P13, la verificación del backup (§2) y V1–V10, con valores y horas.
2. La lista aprobada del alcance (P3), el SHA desplegado (`R`, con sus digests) y el anterior (`1befd89+R1`, imagen `221e6851`).
3. Las lecturas de la línea de base y de la ventana `observe`, al inicio y al final:
   `.conversation.originObservedSinceBoot`, `eventsSinceBoot`, `rejectedSinceBoot`, `gapsSinceBoot`,
   y los conteos de P6.
4. La muestra de latencia de `docker inspect` (los 20 tiempos y la p95).
5. La confirmación, con la lectura `docker inspect -f '{{.Id}} {{.State.StartedAt}} {{.RestartCount}}'` del
   contenedor `app` idéntica al principio y al final (§5.1), de que no hubo reinicios del backend dentro de la ventana (o, si los hubo, su hora
   y que la ventana se reinició).
6. La confirmación de que el inventario de contenedores se mantuvo (P7 contra el final) y de que no se
   tocaron VM100 más allá del deploy aprobado, las sesiones ni los contenedores retenidos.

Con esa evidencia y todos los ejes en PASS, el responsable decide sobre `true`. Esa decisión, a su vez,
tiene su propia verificación (`originRejectedSinceBoot` vacío con captura funcionando) y su propio
rollback (volver a `observe` o `false`).

## 7. Límites conocidos de este plan

- **Latencia:** el backend no expone ninguna métrica de latencia de la ingesta. Los criterios de §5 son
  indicadores indirectos: inspecciones dentro del plazo, la muestra en el host y pérdidas del relay
  frente a la línea de base, que es donde se manifestaría una ingesta lenta porque el relay abandona a
  los 2 s. Una métrica directa (p95 del `authorize` y `relayDropped` en las stats de admin) sería un PR
  aparte y pequeño, **no** incluido aquí.
- **Pérdidas del relay:** `relayDropped` y `relayRestarts` se cuentan en el proceso, pero `adminStats`
  no los expone. Por eso P6 cuenta los eventos `gap` en los archivos (sólo conteos).
- **Versión:** no hay identidad de build en la API. P1, P2, §3 paso 4 y V2 la establecen desde el host, por contenido.
- **Atribución por sesión:** `observe` informa cantidades de sesiones, no cuáles. Si
  `sessionsNotMatched > 0`, el diagnóstico de cuál sesión falló necesita otra autorización.

## 8. Lista única para el operador (Claude A)

Todo en VM100, en el checkout de deploy, en este orden. Cada bloque necesita la autorización que
indica; ante cualquier diferencia: **detenerse e informar, sin corregir**.

**A. Preflight (sólo lecturas; se puede hacer antes del día del deploy).** Son las lecturas 2–8 de
12 §7.2, más P12 con la comprobación de `.dockerignore`. Con esto se decide READY FOR DEPLOY.

**B. Ventana del deploy** (autorización del responsable; coordinada con quien use sesiones;
congelamiento de §3: Composer, sesiones y API de exec):
1. Gate previo P1–P13 (§1), repetido en la ventana. P1 = `1b116d5a…`, imagen `221e6851…`.
2. Gate de espacio (§1.1): con el estimado del backup, ≥ 20 GB libres y uso < 90 % después del backup
   y del build.
3. **Backup** (§2; autorización propia): `npm run backup`, verificación del manifiesto y, si el
   responsable lo decide, copia al NAS con `sha256sum`.
4. `docker tag <ID completo de 221e6851> st-backend-rollback:1befd89`.
5. Checkout de `R` preservando la excepción del Dockerfile (§3 paso 2).
6. `docker compose build app` (§3 paso 3), sin el perfil `build` ni la imagen de sesión.
7. Verificar la imagen nueva: `d1f310d8…`, `0e50e8fd…`/416 y versión de Node frente a P11 (§3 paso 4).
   Si no coincide, NO-GO, sin reinicio.
8. Gate final (§3 paso 5): P8, ningún bootstrap reciente, lista de sesiones y valor efectivo de la
   bandera (vacío).
9. `docker compose up -d --no-deps --no-build --force-recreate -t 30 app` (§3 paso 6).
10. V1–V10 (§3.1).
11. Si algo falla: rollback (§4), sólo por imagen, y verificación contra `221e6851…` / `1b116d5a…`.

**Nunca, en todo el procedimiento:**
- `docker compose down`, `--remove-orphans`, `--profile build`;
- `docker build -t shared-terminal-session`, `scripts/build-session-image.sh`;
- `prune` de imágenes, del sistema o del builder;
- `git stash`, `reset --hard`, `checkout -f`, `clean`;
- tocar contenedores `st-*` (retenidos y PASS-B1 incluidos), recrear sesiones o cambiar `.env`;
- `restore`;
- activar `observe` o `true` (§5, otra autorización).

