# Release v19 (P3a): propuesta para revisar con Claude A

Estado: **propuesta, 2026-11-09. NO-GO para ejecutar.**
- #557 está **mergeado** en `main` como `2a676db` (2026-11-09, lo mergeó A después de su QA). El owner autorizó el merge, no el deploy.
- Este documento prepara el release para que A lo revise y para que el owner dé, o no, un GO específico.
- Nada de lo que sigue se ejecuta sin ese GO.

**Base:** el procedimiento de doc 11 (§1–§4), que este documento **no reescribe**. Indica qué cambia al
pasar de `R` a `M` y qué se agrega por v19.

**Notación:**
- `M` = `2a676db`, el merge de #557 en `main`;
- `P` = SHA que corre en VM100 al abrir la ventana (lo confirma A por digest, 12 §7);
- con la secuencia recomendada de §2, `P = R = e198b07`.

## 1. Qué cambia en producción entre `R` y `M`

`R..M` son tres PRs: **#547** (`166ff78`) y **#557** (`M`) cambian el backend; **#559** (`40da4df`, la primera UI de Projects & Agents, oculta mientras no exista `features.projectChat`) es sólo frontend y Pages ya la publicó. Ninguno toca `session-image/`,
`Dockerfile`, `.dockerignore` ni `package*.json`.
- #557 no toca el frontend.
- El frontend de #547 ya está en producción, porque Pages lo publicó al mergear. Sólo agrega campos
  opcionales, así que no depende de `P`.

| Cambio | PR | Con todas las banderas apagadas (lo que se propone) |
| --- | --- | --- |
| **Migración v19**: cuatro tablas (`projects`, `project_agents`, `agent_bindings`, `project_agent_creations`), dos triggers y tres índices. No modifica ni lee ninguna tabla existente; `agent_bindings` no tiene FK a `sessions`. **Corre al arrancar, sea cual sea `PROJECT_CHAT_ENABLED`** | #557 | Se crean vacías y nada las escribe |
| Rutas `/api/projects/*` | #557 | No se montan: dan 404 |
| `GET /api/auth/status` y `GET /api/sessions` | #557 | Iguales byte a byte: sin `features` y sin `binding` |
| Guard de hard delete (`assertNoLiveBinding`, dos veces por hard delete, owner y admin) | #557 | **Activo**. Hace dos lecturas D1 más por hard delete. Sin vínculos, nunca rechaza |
| `failSession` usa `SessionManager.markFailed` (`AND status != 'terminated'`) | #557 | **Activo**. Una sesión `terminated` ya no vuelve a `failed` por un bootstrap que falla tarde |
| Backup y restore | #557 | El backup exporta además las cuatro tablas (`sinceSchema: 19`). El restore avisa con un `WARN` por cada tabla que el `schemaVersion` del backup tiene pero sus archivos no traen (el backup de un backend anterior después de un rollback, PROJECTS.md §8) |
| Composer para sesiones CLI en segundo plano (`bgTransport.ts`, `composerBg.ts`); el registro de panel admite `accepted`, `reply` y `job-<short>.json`; tres variables nuevas en compose | #547 | `CONVERSATION_COMPOSER_BG_ENABLED` vacía ⇒ un envío a una conversación `background` sigue dando `409 not-interactive`. `COMPOSER_BG_CLI_VERSIONS` y `COMPOSER_BG_SESSIONS` vacías. No se escribe ningún `job-*.json` |

**Riesgo cruzado (#547):** `R` no reconoce los registros `job-*.json`. Si existe alguno, `R` marca
la sesión `unverifiable` para todo el Composer (DEPLOYMENT.md, «drain job records first»). Con la
bandera apagada no se escribe ninguno, pero el gate y el rollback lo verifican (§4).

## 2. Secuencia: la decide el owner con A

**Recomendada: primero el release G3-1 (`R`), con doc 11 completo, y después este, `R → M`.**
- G3-1 no tiene migración. Este release tiene una, v19, más #547 detrás de su bandera apagada.
- Desplegar `M` directamente junta en una sola ventana G3-1, #547 y v19, y deja `P = 1befd89`. En ese
  caso valen las lecturas de G3-1 de doc 11 (P2 y V3 de `INGEST_REQUIRE_SESSION_ORIGIN`) además de las
  de §4–§5. Además, el rollback vuelve a la imagen `221e6851` (doc 11 §4), y no a `R`.

## 3. Evidencia disponible antes del GO

1. **D1 real** (2026-11-09, cuenta de pruebas dedicada): `d1Live.smoke.ts` 30/30 PASS en `771c519` y otra vez en `d172116`; `v19Compat.smoke.ts` 39/39 PASS (main `40da4df` y PR `d172116`), los dos escenarios de QA de A: v18 con datos → v19, el backend v18 sobre la base v19, el roll forward y backup/restore después de un rollback. Cubre migración, triggers e índices guardados por D1, creación atómica, idempotencia, rechazos reconocidos, concurrencia, guard, `markFailed` y re-migración con reinicio. Evidencia en #557.
2. **Compatibilidad hacia atrás:** verificada en el código de `e198b07` y de `1befd89`. `migrateDb()` aplica sólo las versiones que conoce y no están registradas (`applied.has`), e ignora una v19 registrada. C12 registra en D1 real que las versiones 1–18 quedan en el ledger; no prueba código viejo.
3. **Una v19 interrumpida converge:** cada statement es `IF NOT EXISTS` y el ledger se escribe después de `apply()`.
4. **Digests esperados de `M` = `2a676db`**, calculados por B con el método de doc 11 §3 paso 4 (`git archive` de `backend/src` + `tsconfig.json`, `tsc` 5.9.3, el mismo lockfile).
   - El mismo método reproduce exactamente los valores de `R` (`d1f310d8…`/104 y `0e50e8fd…`/416).
   - El backend de `M` es idéntico al de `d172116`, el head que corrió en la D1 real (`git diff d172116 2a676db -- backend` vacío). `main` agregó antes #559, que es sólo frontend.
   - Los valores calculados antes sobre `771c519` (`b45ce209…`, `f91c4486…`) **ya no valen**: `d172116` cambió `backup.ts`.

   | Qué | Valor | Archivos |
   | --- | --- | --- |
   | `dist/**/*.js` | **`dc2c2ba780d2721a9dc373ca6111cb15e08eb5a8a2f4fb9649cabf7fc3fdb32e`** | 109 |
   | todo `dist` | **`47a2c0cf668072d846a3d10f67838943517d500af3076b320b4b495f06991d82`** | 436 |
5. **CI 9/9** sobre `d172116`, que incluye imagen del backend limpia, smokes de la imagen de sesión y e2e.

**Prueba opcional antes del GO** (recomendada si se despliega `M` directamente): arrancar la imagen de `M`
contra una D1 de pruebas restaurada desde un export de producción. **No se propone por defecto**,
porque exige llevar datos de producción a otra cuenta y eso lo decide el owner.

## 4. Procedimiento: doc 11 §1–§4, con estos cambios

Lo ejecuta A con el GO del owner. Todo lo que doc 11 no cambia aquí vale igual: el congelamiento de la
ventana, la etapa de backup, las reglas del checkout y la prohibición de `down`, `--remove-orphans` y
operaciones sobre `st-*`.

**§1, gate previo (sólo lecturas).** Se toman P1 y P3–P13 de doc 11. Cambiar el SHA **no alcanza**:
doc 11 lleva valores literales de `1befd89` que hay que sustituir así.

| Lectura de doc 11 | Valor literal allí | Con `P` |
| --- | --- | --- |
| P1 | `1b116d5a…`, contenedor `da75082e`, imagen `221e6851` | digest de `P` (si `P = R`, `d1f310d8…`); el **contenedor `app` actual** y su imagen, leídos en la ventana |
| P11 | `docker image inspect 221e6851`, `docker inspect da75082e` | `docker inspect <contenedor app actual> --format '{{.Image}}'`. **Ese ID completo** es la imagen que etiqueta el paso 1 y la que verifica §6. Nunca `221e6851`, que sigue existiendo como `st-backend-rollback:1befd89` |
| P12 | **sin** `.dockerignore` | con `P ≥ e198b07`, `.dockerignore` **presente y versionado** |
| P13 | `docker logs da75082e` | `docker logs <contenedor app actual>` |
| P5 / V5 | `enabledSessions = effectiveSessions = 3` | **el valor leído en la ventana**, sea cual sea (O1 puede haberlo cambiado), y V5 igual a ese |
| V9 (base) | — | registrar además el valor actual de `INGEST_REQUIRE_SESSION_ORIGIN` (`printenv` en el contenedor), que tiene que quedar igual |

Además se agregan:

| # | Lectura | Esperado |
| --- | --- | --- |
| P1 | digest de `dist/**/*.js` del contenedor | el de `P`; si `P = R`, `d1f310d8…` |
| P2′ | `docker compose exec app grep -c 'version: 19' dist/db.js` | `0`: v19 no está |
| P4′ | `PROJECT_CHAT_ENABLED` y `CONVERSATION_COMPOSER_BG_ENABLED`: `grep -c '^<VAR>=' .env` y `printenv <VAR>` en el shell del operador | `0` y vacío, para las dos |
| P8′ | además de P8: `ls <WORKSPACE_ROOT>/.st-control/*/composer/job-*.json 2>/dev/null` | ninguno |
| P14 | ledger de D1: en el arranque de `P`, `[db] migrations complete (schema up to date)`, que implica todas las versiones de `P` registradas (1–18 para `R`); o `SELECT MAX(version) FROM schema_migrations` si A lo puede leer | `schema up to date` o `MAX = 18` ⇒ N = 1 en V1. Si el log rotó y no hay lectura de D1, se registra «N desconocido» y V1 acepta cualquier N siempre que la última línea sea `applying migration 19` y no haya errores |

**§2, backup:** igual que doc 11 §2, con el backend `P`. Todavía no existen tablas de v19, así que nada
queda afuera.

**§3, deploy**, con `R` reemplazado por `M` en todos los pasos:

1. **Proteger la imagen de rollback.** Es una escritura que sólo agrega una referencia y **no es una
   lectura**: `docker tag <ID completo de la imagen de P> st-backend-rollback:<P corto>`.
2. Checkout `git checkout --detach M`, con las reglas de doc 11 §3 paso 2. `P..M` no toca
   `session-image/Dockerfile`, así que la excepción local se conserva y se verifica igual.
3. `docker compose build app`, y sólo `app`.
4. Verificación de la imagen con los comandos de doc 11 §3 paso 4. Lo esperado son **los digests de
   §3.4** (`dc2c2ba7…`/109 y `47a2c0cf…`/436) y la versión de Node, que se registra como allí. Cualquier
   otro valor ⇒ NO-GO, sin reinicio.
5. **Gate final** de doc 11 §3 paso 5:
   - P8 y P8′;
   - **ninguna ventana `observe` abierta** (O1 o doc 11 §5). El reinicio pone a cero sus contadores y
     la deja INCONCLUSIVE. Si hay una, el owner la cierra antes, con sus lecturas de fin de ventana
     tomadas, o se espera a que termine;
   - ninguna sesión con `createdAt` en los últimos 15 minutos;
   - la lista `sessionId → status` (base de V10);
   - las dos banderas como las va a ver el backend nuevo: desde el checkout de `M`,
     `docker compose config --format json | jq -r '.services.app.environment.PROJECT_CHAT_ENABLED, .services.app.environment.CONVERSATION_COMPOSER_BG_ENABLED'`
     da vacío las dos veces, y `printenv` en el shell también.
   - Cualquier valor ⇒ NO-GO.
6. `docker compose up -d --no-deps --no-build --force-recreate -t 30 app`.

**Opcional, antes del paso 6:** anotar el bookmark de D1 Time Travel. Es sólo evidencia y **nunca** se
usa como rollback de v19:
- requiere credenciales de Cloudflare en VM100;
- un restore volvería atrás **toda** la base: sesiones, conversaciones y ledger.

## 5. Verificación posterior: doc 11 §3.1 V1–V10, adaptadas

| # | Cambio respecto de doc 11 |
| --- | --- |
| V1 | Además: en el log, `[db] applying migration 19: projects, project_agents, agent_bindings (P3a directory)` y luego `[db] migrations complete (N applied)`, con N = versiones pendientes según P14 (1 si el ledger estaba en 18). Ningún error D1 en esas líneas |
| V2 | Digests del contenedor en ejecución = §3.4; su imagen = la del paso 4; `grep -c 'version: 19' dist/db.js` > 0 |
| V3 | **Banderas apagadas:** `printenv PROJECT_CHAT_ENABLED` y `printenv CONVERSATION_COMPOSER_BG_ENABLED` dentro del contenedor, vacías |
| V3a | `GET /api/projects` con la cookie del owner ⇒ 404 |
| V3b | `GET /api/auth/status` sin `features`; `GET /api/sessions` sin ninguna fila con la clave `binding` |
| V4–V6 | Igual que doc 11: inventario P7, captura P5 y pérdidas del relay |
| V7 | Igual (panes y recreaciones), más P8′: ningún `job-*.json` |
| V8 | Igual, con `HEAD = M` y la etiqueta `st-backend-rollback:<P corto>` |
| V9 | Igual, e `INGEST_REQUIRE_SESSION_ORIGIN` igual a la base; las diferencias esperadas son las variables nuevas, **vacías**: `PROJECT_CHAT_ENABLED`, `CONVERSATION_COMPOSER_BG_ENABLED`, `COMPOSER_BG_CLI_VERSIONS` y `COMPOSER_BG_SESSIONS` |
| V10 | Igual |

En producción **no** se prueba un hard delete. El guard y `markFailed` quedan cubiertos por la D1 real y
por los tests.

## 6. Rollback: doc 11 §4, por imagen

- **Disparadores:** fallan V1–V10, o hay una regresión de sesiones o captura.
- **Pasos:** los de doc 11 §4, con `P` en lugar de `1befd89`.
  1. P8 y P8′. Nunca se vuelve atrás con una recreación sin resolver, un envío pendiente del Composer
     o un `job-*.json`.
  2. `git checkout --detach P` con las reglas de doc 11 §3 paso 2. **Va antes del `up`**, para que
     Compose use la configuración de `P`. **Nunca se reconstruye** desde ese checkout.
  3. `docker tag st-backend-rollback:<P corto> <imagen de compose>`, con el nombre de P11. **Sin este
     paso, `up --no-build` volvería a levantar `M`:** el servicio `app` no tiene `image:` y su etiqueta
     de compose ya apunta a `M`.
  4. `docker compose up -d --no-deps --no-build --force-recreate -t 30 app`.
  5. Verificar: la imagen del contenedor = el ID completo de `P` (P11), el digest de `dist/**/*.js` = P1,
     y V1, V3–V10 contra las lecturas de **antes** del deploy.
- **La base no se toca.** Con la bandera nunca encendida es el caso A de PROJECTS.md §8: seguro y sin
  precondiciones. **Nunca** se borran las tablas de v19 ni se edita el ledger.
- **Si v19 falló a mitad:** queda sin registrar, la imagen `P` no la conoce y arranca igual, y un
  re-deploy de `M` la completa.

## 7. Fuera de este release

- Encender `PROJECT_CHAT_ENABLED`: requiere su propio GO. Con vínculos existentes, el rollback pasa al
  caso B (§8).
- Encender `CONVERSATION_COMPOSER_BG_ENABLED`: experimental, no aprobado.
- G3-2, Channels, tareas y despacho: sin autorización.

## 8. Preguntas para A

1. ¿Qué SHA y digest corren hoy en VM100 (`P`)? ¿Sigue pendiente el release G3-1 (`R`)?
2. ¿Aceptás la secuencia de §2 (`R` primero, después `R → M`)?
3. ¿Hay en VM100 algo fuera del repo que dependa del esquema de D1 y deba conocer las cuatro tablas?
4. ¿Podés hacer P14 (el ledger) y V3a/V3b tal como están escritas?
