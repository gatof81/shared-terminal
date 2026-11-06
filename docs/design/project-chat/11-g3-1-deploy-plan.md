# G3-1 — procedimiento de release acotado y ventana `observe` (sólo planificación)

Estado: **propuesta final del procedimiento, nada ejecutado. Revisado el 2026-11-06 con el preflight
de sólo lectura de Claude A** (operador de VM100). El deploy sigue en **NO-GO** hasta que el
responsable apruebe este procedimiento; cada etapa de escritura (§2 backup, §3 deploy, §5 `observe`)
necesita además su propia autorización. G3-2 sigue en NO-GO y el preflight de F1 es una tarea
independiente del operador.

Alcance y tabla de digests: [12-g3-1-release-scope.md](./12-g3-1-release-scope.md) (§7 = qué reportó
A y qué falta). Referencias: CONVERSATION.md §3.1.1 (v1.8.6), DEPLOYMENT.md («Ingest network origin»,
«Backend (Docker Compose)», «Backup & restore», «Rollback (from 3.0d)»),
[10-g3-sender-identity.md](./10-g3-sender-identity.md).

## 0. Alcance: release acotado a G3-1 sobre el SHA fijo `a93232f`

| | Valor | Fuente |
| --- | --- | --- |
| Backend en producción (`D`) | `1befd89+R1` | digest medido por A = `1b116d5a…` (104): los 103 de `1befd89` más `dist/ringBuffer.js` huérfano, identificado (12 §7.4). **No coincide con la tabla: aceptarlo es la decisión D1** |
| Destino | `a93232f` (#545), digest esperado `d1f310d8…`, **o** el commit de la corrección de higiene según D2 (12 §7.4), con el mismo digest | repo |
| PRs en `1befd89..a93232f` | #548 (frontend), #544 (tests), #551 (frontend), #545 (backend + compose + docs) | A, y verificado por B en el repo |
| Runtime del backend que cambia | **sólo #545**, apagado por defecto (`INGEST_REQUIRE_SESSION_ORIGIN` vacía) | repo |
| Migraciones | ninguna (`db.ts` sin cambios en el rango) | repo |
| Compose / `.env.example` | sólo una línea nueva que reenvía `INGEST_REQUIRE_SESSION_ORIGIN` con valor vacío por defecto | repo |
| `session-image/` | **sin cambios** en el rango (`git diff 1befd89 a93232f -- session-image` vacío) | repo |
| `main` después de `a93232f` | #550 (docs) y #552 (frontend): **no** entran; el destino sigue fijo en `a93232f` | A y repo |
| Frontend | Pages, camino aparte; no forma parte de este procedimiento. Sin acople: el frontend actual sólo usa rutas que ya existen en `1befd89` (el único cambio de backend del rango es la ingesta) | repo |

Fuera de este release, sin excepción: construir o etiquetar la imagen de sesión, recrear sesiones,
tocar contenedores retenidos (PASS-B1 incluidos), cambiar `.env`, activar `observe` o `true`.

## 1. Gate previo (sólo lecturas)

Columna «Estado»: **A** = reportado por A en el preflight del 2026-11-06; **pendiente** = falta la
lectura (12 §7.2 tiene la lista exacta para pedírsela a A). Todas se **repiten** en la misma ventana
del deploy, inmediatamente antes de §3: el preflight anterior es contexto, no el gate.

| # | Qué | Cómo (lectura) | Esperado | Estado |
| --- | --- | --- | --- | --- |
| P1 | Identidad del backend | digest de `dist/**/*.js` del contenedor en ejecución (12 §1) + `docker inspect` del contenedor y de su imagen | `1b116d5a…` (fila `1befd89+R1`, si se aprueba D1-a); imagen `221e6851…` | A: medido, **no coincide con la tabla**; en la ventana se repite sólo para comprobar que nada cambió |
| P2 | G3-1 no está | `docker compose exec app grep -c INGEST_REQUIRE_SESSION_ORIGIN dist/index.js` | `0` | A (reportado «G3-1 no está en el `dist`») |
| P3 | Alcance | `git log --oneline 1befd89..a93232f` | los 4 PRs de §0 | A + B |
| P4 | Bandera ausente | `grep -c '^INGEST_REQUIRE_SESSION_ORIGIN=' .env`; `printenv` en el contenedor | `0` y vacío | A |
| P5 | Captura | `GET /api/admin/stats` → `.conversation` | `enabledSessions = effectiveSessions = 3` | A (3/3); pendiente: `eventsSinceBoot`, `rejectedSinceBoot`, `gapsSinceBoot` con hora |
| P6 | Pérdidas del relay (línea de base) | conteos de `relay_dropped` / `relay_restart` en `.conversations/*/*.events.jsonl` | registrados | pendiente |
| P7 | Inventario de contenedores | `docker ps -a --filter name=st- --format '{{.ID}} {{.Names}} {{.Status}}'` | lista completa registrada | A |
| P8 | Nada en vuelo | recreaciones: `jq -r .state` de cada `recreate-attempt.json` = `resolved` (y si alguna tiene `retained`); Composer: `GET …/composer/panes` por sesión = `panes: []`, `unreadable: []` (404 = apagado) | todo `resolved`; sin panes | A: 3 recreaciones `resolved`, «0 operaciones»; **pendiente:** confirmar que el Composer se midió por panes y por sesión, y si hay `retained` |
| P9 | Sesiones por estado | `GET /api/admin/stats` → sesiones por estado | registrado (para V10) | pendiente |
| P10 | Espacio | `df -h` del filesystem de `WORKSPACE_ROOT` y del data-root de Docker; `docker system df`; tamaño estimado del backup | §1.1 | A: 36 GB libres, 82 %; **pendiente:** el resto |
| P11 | Imagen de rollback | `docker image inspect 221e6851 --format '{{.Id}} {{json .RepoTags}} {{.Size}}'`; nombre de imagen de compose (`docker compose config --images`) | ID completo, etiqueta y tamaño | pendiente |
| P12 | Excepción local del Dockerfile | `git rev-parse HEAD`, `git symbolic-ref -q HEAD` (rama o detached), `git status --porcelain`, `git diff --stat`, `sha256sum session-image/Dockerfile` | sólo `M session-image/Dockerfile`; hash registrado | A (existe y está aprobada); **pendiente:** las lecturas exactas |
| P13 | Línea de base del log | `docker compose logs --since 1h app` → cantidad de líneas `error` | registrada (para V1) | pendiente |

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
   - el manifiesto nombra cada sesión de D1 con su tarball (el backup ya relee cada tarball con
     `tar -tzf` antes de escribirlo);
   - se registran las sesiones con `concurrentChanges` (las sesiones vivas dan un punto de
     recuperación, no una foto consistente; es lo esperado);
   - `du -sh` del directorio y el espacio libre resultante (gate de §1.1).
4. Copia al NAS con `sha256sum` de origen y destino: **recomendada**, decisión del responsable (A ya
   informó un backup anterior en el NAS).

Nunca se ejecuta `restore` en este procedimiento.

## 3. Deploy (sólo el servicio `app`, con la bandera apagada)

Ventana coordinada por el responsable: el reinicio corta unos segundos los WebSocket y la ingesta
de hooks de **todas** las sesiones, incluida la de A. Durante la ventana nadie envía por el Composer,
nadie recrea, inicia ni detiene sesiones.

1. **Proteger la imagen de rollback** (escritura que sólo agrega una referencia):
   `docker tag <ID completo de 221e6851> st-backend-rollback:1befd89`.
2. **Checkout preservando la excepción del Dockerfile.**
   - Antes: guardar `git status --porcelain`, `sha256sum session-image/Dockerfile` y
     `git diff -- session-image/Dockerfile > <fuera-del-repo>/Dockerfile.local.patch`.
   - `git fetch origin` y `git checkout --detach a93232f` (**sin** `-f`). Como el rango no cambia
     `session-image/Dockerfile`, git conserva la modificación local. **Si git se niega, se detiene:**
     nunca `git stash`, `git checkout -f`, `git checkout -- …`, `git reset --hard`, `git clean`,
     `git pull` ni `git switch --discard-changes`.
   - Después: `git rev-parse HEAD` = `a93232f…`; `git status --porcelain` idéntico al de antes;
     `sha256sum session-image/Dockerfile` idéntico.
3. **Construir sin reiniciar.** Sólo con D2-B: antes, `mv backend/dist <fuera-del-repo>/backend-dist.<ts>`
   (se conserva, no se borra). Después `docker compose build app`. Sólo `app`: el servicio `session-image`
   está en el perfil `build` y **no** se nombra; nunca `--profile build`,
   `docker build -t shared-terminal-session` ni `scripts/build-session-image.sh`.
4. **Verificar la imagen nueva antes de usarla:**
   `docker run --rm --network none --entrypoint sh <imagen de compose> -c 'cd /app && find dist -type f -name "*.js" | LC_ALL=C sort | xargs sha256sum' | sha256sum`
   tiene que dar `d1f310d8…` (D2-B o D2-C; con D2-A sería `886281d9…`, no recomendado). Si no, NO-GO:
   el backend sigue siendo el actual, sin reinicio.
5. **Gate final:** repetir P8 (recreaciones y panes del Composer) en este momento. Cualquier cosa en
   vuelo ⇒ se espera o se aborta, nunca se reinicia encima.
6. `docker compose up -d --no-deps --no-build app`. `app` no declara `depends_on`, así que
   `--no-deps` no cambia nada hoy; se agrega para que un `depends_on` futuro no levante ni recree
   otro servicio en este paso. Nunca `docker compose down`, `--remove-orphans`,
   `restart` de otros servicios, ni operaciones sobre contenedores `st-*`.

### 3.1 Verificación posterior (lecturas)

| # | Esperado |
| --- | --- |
| V1 | `app` en ejecución y `healthy`; log de arranque sin errores nuevos frente a P13 y **sin** la advertencia `INGEST_REQUIRE_SESSION_ORIGIN=… is not true\|observe\|false` |
| V2 | Digest del `dist` del contenedor en ejecución = el verificado en el paso 4; `grep -c INGEST_REQUIRE_SESSION_ORIGIN dist/index.js` > 0; ID de la imagen nueva registrado |
| V3 | **Bandera apagada:** `printenv INGEST_REQUIRE_SESSION_ORIGIN` vacío; en `.conversation` **no** aparecen `originRejectedSinceBoot` ni `originObservedSinceBoot` |
| V4 | Inventario P7 idéntico: mismos IDs, nombres y estados de los `st-*`, retenidos y PASS-B1 incluidos |
| V5 | Captura: `enabledSessions = effectiveSessions = 3`; con actividad real `eventsSinceBoot` crece y Chat muestra eventos nuevos de las tres |
| V6 | Pérdidas: los conteos de P6 crecen **sólo** con `gap` fechados dentro de la ventana del reinicio (el relay abandona a los 2 s con el backend caído); ninguno después |
| V7 | Composer: `…/composer/panes` de cada sesión sigue vacío; recreaciones: todas `resolved` |
| V8 | Excepción del Dockerfile intacta (P12 idéntico) y `st-backend-rollback:1befd89` presente |
| V9 | Variables no secretas del contenedor iguales a las de antes (sólo nombres y valores no secretos) |
| V10 | Sesiones por estado iguales a P9: la reconciliación de arranque no pasó ninguna sesión viva a `stopped` |

## 4. Rollback

- **Disparadores:** V1–V10 fallan, o aparece una regresión de captura o de sesiones.
- **No hay migración que cruzar** y la imagen anterior existe localmente; volver no reconstruye nada.
- **Pasos:**
  1. Comprobar P8 de nuevo: **nunca** volver atrás con una recreación sin resolver ni un envío del
     Composer pendiente (DEPLOYMENT.md).
  2. `git checkout --detach 1befd89` con las mismas reglas que §3 paso 2 (la excepción del
     Dockerfile se conserva y se verifica igual).
  3. `docker tag st-backend-rollback:1befd89 <imagen de compose>` y
     `docker compose up -d --no-deps --no-build app`.
  4. Verificar: digest = `1b116d5a…` (la misma imagen de antes, con su residuo R1), imagen =
     `221e6851…`, y V1, V3–V10.
- **Qué preserva:** contenedores de sesión intactos; `.conversations/` nunca se borra; `.env` no se
  tocó. El `.env` no necesita cambio: `1befd89` no reenvía la variable.
- **Rollback de la ventana `observe`** (sin tocar el código): quitar la variable de `.env` (o ponerla
  en `false`) y ejecutar `docker compose up -d --no-deps --no-build app`, que recrea sólo el contenedor del
  backend con el entorno nuevo.

## 5. Ventana `observe` (otra autorización)

**Activación:**
1. `INGEST_REQUIRE_SESSION_ORIGIN=observe` en `.env`, y luego `docker compose up -d --no-deps --no-build app`. Esto
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
| **Latencia** (no existe una métrica directa; ver §6) | `inspect_timeout = inspect_pending = inspect_failed = 0` (cada inspección respondió en < 500 ms). Además, una muestra en el host de 20 × `time docker inspect -f '{{.Id}}' <st-…>` con p95 < 100 ms (lectura) | cualquier `inspect_timeout`, `inspect_pending` o `inspect_failed`, o una p95 de la muestra ≥ 100 ms |
| **Pérdidas de eventos** | Los conteos de `relay_dropped` / `relay_restart` (P6) y el delta de `gapsSinceBoot` durante la ventana ≤ a los de la línea de base de igual duración; `eventsSinceBoot` crece al ritmo habitual; `rejectedSinceBoot` sin motivos nuevos | más pérdidas o *gaps* que la línea de base, o un motivo de rechazo nuevo |
| **Regresiones** | Chat muestra la actividad de todas las sesiones con captura; el log del backend sin errores nuevos | lo contrario |

**Ante un FAIL:** se vuelve a `false` (§4, sin reconstruir), se conserva toda la evidencia y se
informa. No se reintenta ni se ajusta nada sobre la marcha.

## 6. Evidencia mínima antes de considerar `true`

El operador devuelve, sin tokens, cookies ni contenido de conversaciones:

1. P1–P13, la verificación del backup (§2) y V1–V10, con valores y horas.
2. La lista aprobada del alcance (P3), el SHA desplegado (`a93232f`) y el anterior (`1befd89`, con su digest).
3. Las lecturas de la línea de base y de la ventana `observe`, al inicio y al final:
   `.conversation.originObservedSinceBoot`, `eventsSinceBoot`, `rejectedSinceBoot`, `gapsSinceBoot`,
   y los conteos de P6.
4. La muestra de latencia de `docker inspect` (los 20 tiempos y la p95).
5. La confirmación de que no hubo reinicios del backend dentro de la ventana (o, si los hubo, su hora
   y que la ventana se reinició).
6. La confirmación de que el inventario de contenedores se mantuvo (P7 contra el final) y de que no se
   tocaron VM100 más allá del deploy aprobado, las sesiones ni los contenedores retenidos.

Con esa evidencia y todos los ejes en PASS, el responsable decide sobre `true`. Esa decisión, a su vez,
tiene su propia verificación (`originRejectedSinceBoot` vacío con captura funcionando) y su propio
rollback (volver a `observe` o `false`).

## 7. Límites conocidos de este plan

- **Latencia:** el backend no expone ninguna métrica de latencia de la ingesta. Los criterios de §4 son
  indicadores indirectos: inspecciones dentro del plazo, la muestra en el host y pérdidas del relay
  frente a la línea de base, que es donde se manifestaría una ingesta lenta porque el relay abandona a
  los 2 s. Una métrica directa (p95 del `authorize` y `relayDropped` en las stats de admin) sería un PR
  aparte y pequeño, **no** incluido aquí.
- **Pérdidas del relay:** `relayDropped` y `relayRestarts` se cuentan en el proceso, pero `adminStats`
  no los expone. Por eso P6 cuenta los eventos `gap` en los archivos (sólo conteos).
- **Versión:** no hay identidad de build en la API. P1, P2, §3 paso 4 y V2 la establecen desde el host, por contenido.
- **Atribución por sesión:** `observe` informa cantidades de sesiones, no cuáles. Si
  `sessionsNotMatched > 0`, el diagnóstico de cuál sesión falló necesita otra autorización.
