# G3-1 — plan operativo de despliegue y ventana `observe` (sólo planificación)

Estado: **plan, nada ejecutado.** G3-1 está mergeado en `main` como `a93232f` (PR #545). Este
documento no autoriza ejecutar nada: el deploy, la ventana `observe` y cualquier paso posterior hacia
`true` necesitan cada uno su propia autorización del responsable. G3-2 sigue en NO-GO, y el preflight
de F1 es una tarea independiente del operador.

Referencias: CONVERSATION.md §3.1.1 (v1.8.6), DEPLOYMENT.md («Ingest network origin», «Backend
(Docker Compose)», «Rollback (from 3.0d)»), [10-g3-sender-identity.md](./10-g3-sender-identity.md).

## 0. Alcance real del deploy (decisión previa)

Desplegar `a93232f` despliega **todo** lo mergeado en `main` desde la versión que corre hoy, no sólo
G3-1. En `main` hay PRs mergeados que todavía no se desplegaron (el release conjunto #502–#511 estaba
pendiente de GO). Por eso el primer paso es listar ese rango y que el responsable apruebe el alcance:
o un release conjunto con esa lista, o un deploy acotado (otra decisión, con otro plan).

## 1. Verificación previa (sólo lecturas, en el host)

| # | Qué | Cómo (lectura) | Se registra |
| --- | --- | --- | --- |
| P1 | Versión efectiva del backend | No hay endpoint de versión. Se usan `git -C <repo-de-deploy> rev-parse HEAD`, `git -C <repo> status --porcelain` (vacío) y `docker compose ps app`; además, `docker inspect $(docker compose ps -q app) --format '{{.Image}} {{.Created}}'` | SHA desplegado (`D`), checkout limpio, imagen y fecha del contenedor |
| P2 | El código de G3-1 **no** está todavía | `docker compose exec app grep -c INGEST_REQUIRE_SESSION_ORIGIN dist/index.js` | `0` |
| P3 | Alcance | `git log --oneline D..a93232f` | la lista que aprueba el responsable (§0) |
| P4 | Bandera ausente | `grep -c '^INGEST_REQUIRE_SESSION_ORIGIN=' .env` y `docker compose exec app printenv INGEST_REQUIRE_SESSION_ORIGIN` | `0` y vacío |
| P5 | Estado de captura | `GET /api/admin/stats` → `.conversation` (cookie de admin; no pegar el JWT en logs compartidos): `enabledSessions`, `effectiveSessions`, `eventsSinceBoot`, `rejectedSinceBoot`, `gapsSinceBoot` | valores y hora de lectura |
| P6 | Pérdidas del relay (línea de base) | Sólo conteos, nunca contenido: `grep -c '"reason":"relay_dropped"'` y `grep -c '"reason":"relay_restart"'` sobre `<WORKSPACE_ROOT>/.conversations/*/*.events.jsonl` | totales por archivo y la suma |
| P7 | Inventario de contenedores | `docker ps -a --filter name=st- --format '{{.ID}} {{.Names}} {{.Status}}'`, que incluye los PASS-B1 retenidos | la lista completa, para compararla después |
| P8 | Nada en curso | Ninguna recreación sin resolver (`<WORKSPACE_ROOT>/.st-control/*/recreate-attempt.json` con estado distinto de `resolved` ⇒ **no desplegar**) y ningún envío del Composer en curso (`<WORKSPACE_ROOT>/.st-control/*/composer/*.json` inexistentes) | resultado |
| P9 | Punto de recuperación | `docker compose exec app npm run backup` (DEPLOYMENT.md «Backup & restore») | ruta del backup y su `manifest.json` |

Si cualquier fila sale distinta de lo esperado, se detiene todo y se informa. No se corrige en el
momento.

## 2. Deploy (con la bandera apagada)

1. En el checkout de deploy: `git fetch origin && git checkout --detach a93232f`, y verificar con
   `git rev-parse HEAD`.
2. `docker compose up -d --build app`. **Sólo** el servicio `app`. Nunca
   `docker build -t shared-terminal-session` (el mecanismo del incidente del 2026-11-03): la imagen de
   sesión no cambia.
3. Los contenedores de sesión no dependen del proceso del backend y siguen corriendo. El arranque
   corre `reconcile` y los clientes WS se reconectan solos.

**Verificación posterior** (lecturas):

| # | Esperado |
| --- | --- |
| V1 | `docker compose ps app` en ejecución; el log de arranque sin errores y **sin** la advertencia `INGEST_REQUIRE_SESSION_ORIGIN=… is not true\|observe\|false` |
| V2 | `grep -c INGEST_REQUIRE_SESSION_ORIGIN dist/index.js` > 0 (el código nuevo está) |
| V3 | **Bandera apagada:** `printenv INGEST_REQUIRE_SESSION_ORIGIN` vacío, y en `.conversation` de las stats **no** aparecen ni `originRejectedSinceBoot` ni `originObservedSinceBoot`. Con la bandera apagada esos bloques no existen, así que su ausencia es la prueba |
| V4 | Inventario P7 idéntico (mismos IDs y nombres de contenedor; los PASS-B1 retenidos intactos) |
| V5 | La captura sigue: con actividad real, `eventsSinceBoot` crece y cada sesión con captura muestra eventos nuevos en Chat; `rejectedSinceBoot` no trae `wrong_origin` |
| V6 | Pérdidas: los conteos de P6 no crecen más que en la línea de base |

## 3. Rollback

- **Disparadores:** V1–V6 fallan, o aparece una regresión de captura o de sesiones.
- **Pasos:** comprobar P8 de nuevo (**nunca** volver atrás con una recreación sin resolver, según
  DEPLOYMENT.md), después `git checkout --detach D` y `docker compose up -d --build app`.
- **Qué preserva:**
  - G3-1 no agrega migraciones. Si el release conjunto trae alguna, el esquema es aditivo y un backend
    anterior lo tolera; esto se confirma en P3, por cada migración del rango.
  - Los contenedores de sesión no se tocan. Los datos capturados (`.conversations/`) nunca se borran.
- **Rollback de la ventana `observe`** (sin tocar el código): quitar la variable de `.env` (o ponerla
  en `false`) y ejecutar `docker compose up -d app`, que recrea sólo el contenedor del backend con el
  entorno nuevo y no reconstruye nada.

## 4. Ventana `observe` (otra autorización)

**Activación:**
1. `INGEST_REQUIRE_SESSION_ORIGIN=observe` en `.env`, y luego `docker compose up -d app`. Esto
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

**Ante un FAIL:** se vuelve a `false` (§3, sin reconstruir), se conserva toda la evidencia y se
informa. No se reintenta ni se ajusta nada sobre la marcha.

## 5. Evidencia mínima antes de considerar `true`

El operador devuelve, sin tokens, cookies ni contenido de conversaciones:

1. P1–P9 y V1–V6, con valores y horas.
2. La lista aprobada del alcance (P3), el SHA desplegado (`a93232f`) y el anterior (`D`).
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

## 6. Límites conocidos de este plan

- **Latencia:** el backend no expone ninguna métrica de latencia de la ingesta. Los criterios de §4 son
  indicadores indirectos: inspecciones dentro del plazo, la muestra en el host y pérdidas del relay
  frente a la línea de base, que es donde se manifestaría una ingesta lenta porque el relay abandona a
  los 2 s. Una métrica directa (p95 del `authorize` y `relayDropped` en las stats de admin) sería un PR
  aparte y pequeño, **no** incluido aquí.
- **Pérdidas del relay:** `relayDropped` y `relayRestarts` se cuentan en el proceso, pero `adminStats`
  no los expone. Por eso P6 cuenta los eventos `gap` en los archivos (sólo conteos).
- **Versión:** no hay identidad de build en la API. P1, P2 y V2 la establecen desde el host.
- **Atribución por sesión:** `observe` informa cantidades de sesiones, no cuáles. Si
  `sessionsNotMatched > 0`, el diagnóstico de cuál sesión falló necesita otra autorización.
