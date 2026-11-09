# Release v19 (P3a): propuesta para revisar con Claude A

Estado: **propuesta, 2026-11-09. NO-GO para ejecutar.**
- El owner autorizó el **merge** de #557 (`771c519`), no el deploy.
- Este documento prepara el release para que A lo revise y para que el owner dé, o no, un GO específico.
- Nada de lo que sigue se ejecuta sin ese GO.

**Base:** el procedimiento de doc 11 (§1–§4), que este documento **no reescribe**. Indica qué cambia al
pasar de `R` a `M` y qué se agrega por v19.

**Notación:**
- `M` = SHA del merge de #557 en `main` (se completa al mergear);
- `P` = SHA que corre en VM100 al abrir la ventana (lo confirma A por digest, 12 §7);
- con la secuencia recomendada de §2, `P = R = e198b07`.

## 1. Qué cambia en producción entre `R` y `M`

`R..M` son dos PRs de runtime: **#547** (`166ff78`) y **#557** (`M`). Ninguno toca `session-image/`,
`Dockerfile`, `.dockerignore` ni `package*.json`, ni archivos del frontend.

| Cambio | PR | Con todas las banderas apagadas (lo que se propone) |
| --- | --- | --- |
| **Migración v19**: cuatro tablas (`projects`, `project_agents`, `agent_bindings`, `project_agent_creations`), dos triggers y tres índices. No modifica ni lee ninguna tabla existente; `agent_bindings` no tiene FK a `sessions`. **Corre al arrancar, sea cual sea `PROJECT_CHAT_ENABLED`** | #557 | Se crean vacías y nada las escribe |
| Rutas `/api/projects/*` | #557 | No se montan: dan 404 |
| `GET /api/auth/status` y `GET /api/sessions` | #557 | Iguales byte a byte: sin `features` y sin `binding` |
| Guard de hard delete (`assertNoLiveBinding`, dos veces por hard delete, owner y admin) | #557 | **Activo**. Hace dos lecturas D1 más por hard delete. Sin vínculos, nunca rechaza |
| `failSession` usa `SessionManager.markFailed` (`AND status != 'terminated'`) | #557 | **Activo**. Una sesión `terminated` ya no vuelve a `failed` por un bootstrap que falla tarde |
| Backup | #557 | Exporta además las cuatro tablas (`sinceSchema: 19`) |
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

1. **D1 real** (2026-11-09, `771c519`, cuenta de pruebas dedicada): 30/30 comprobaciones obligatorias PASS. Cubre migración, triggers e índices guardados por D1, creación atómica, idempotencia, rechazos reconocidos, concurrencia, guard, `markFailed` y re-migración con reinicio. Evidencia en #557.
2. **Compatibilidad hacia atrás:** verificada en el código de `e198b07` y de `1befd89`. `migrateDb()` aplica sólo las versiones que conoce y no están registradas (`applied.has`), e ignora una v19 registrada. C12 registra en D1 real que las versiones 1–18 quedan en el ledger; no prueba código viejo.
3. **Una v19 interrumpida converge:** cada statement es `IF NOT EXISTS` y el ledger se escribe después de `apply()`.
4. **Digests esperados de `M`**, calculados por B con el método de doc 11 §3 paso 4 (`git archive` de `backend/src` + `tsconfig.json`, `tsc` 5.9.3, el mismo lockfile).
   - El mismo método reproduce exactamente los valores de `R` (`d1f310d8…`/104 y `0e50e8fd…`/416).
   - El árbol del squash de #557 es el de `771c519`, porque `main` ya está contenido en él; se confirma al mergear con `git diff 771c519 M` vacío.

   | Qué | Valor | Archivos |
   | --- | --- | --- |
   | `dist/**/*.js` | **`b45ce2099cc9b574a2fb7934a4d328839905149441f053caf351ae7cfbef5db1`** | 109 |
   | todo `dist` | **`f91c44864b5ffd0b93c10a7c3d94e3e7591989299c5a50a974e261a93c619fb0`** | 436 |
5. **CI 9/9** sobre `771c519`, que incluye imagen del backend limpia, smokes de la imagen de sesión y e2e.

**Prueba opcional antes del GO** (recomendada si se despliega `M` directamente): arrancar la imagen de `M`
contra una D1 de pruebas restaurada desde un export de producción. **No se propone por defecto**,
porque exige llevar datos de producción a otra cuenta y eso lo decide el owner.

## 4. Procedimiento: doc 11 §1–§4, con estos cambios

Lo ejecuta A con el GO del owner. Todo lo que doc 11 no cambia aquí vale igual: el congelamiento de la
ventana, la etapa de backup, las reglas del checkout y la prohibición de `down`, `--remove-orphans` y
operaciones sobre `st-*`.

**§1, gate previo (sólo lecturas).** Se toman P1 y P3–P13 con `P` en lugar de `1befd89`, y se agregan:

| # | Lectura | Esperado |
| --- | --- | --- |
| P1 | digest de `dist/**/*.js` del contenedor | el de `P`; si `P = R`, `d1f310d8…` |
| P2′ | `docker compose exec app grep -c 'version: 19' dist/db.js` | `0`: v19 no está |
| P4′ | `PROJECT_CHAT_ENABLED` y `CONVERSATION_COMPOSER_BG_ENABLED`: `grep -c '^<VAR>=' .env` y `printenv <VAR>` en el shell del operador | `0` y vacío, para las dos |
| P8′ | además de P8: `ls <WORKSPACE_ROOT>/.st-control/*/composer/job-*.json 2>/dev/null` | ninguno |
| P14 | ledger de D1: el log de arranque de `P` (`migrations complete …`) o `SELECT MAX(version) FROM schema_migrations` si A lo puede leer | 18. Si es otro valor, se registra y V1 lo ajusta |

**§2, backup:** igual que doc 11 §2, con el backend `P`. Todavía no existen tablas de v19, así que nada
queda afuera.

**§3, deploy**, con `R` reemplazado por `M` en todos los pasos:

1. **Proteger la imagen de rollback.** Es una escritura que sólo agrega una referencia y **no es una
   lectura**: `docker tag <ID completo de la imagen de P> st-backend-rollback:<P corto>`.
2. Checkout `git checkout --detach M`, con las reglas de doc 11 §3 paso 2. `P..M` no toca
   `session-image/Dockerfile`, así que la excepción local se conserva y se verifica igual.
3. `docker compose build app`, y sólo `app`.
4. Verificación de la imagen con los comandos de doc 11 §3 paso 4. Lo esperado son **los digests de
   §3.4** (`b45ce209…`/109 y `f91c4486…`/436) y la versión de Node, que se registra como allí. Cualquier
   otro valor ⇒ NO-GO, sin reinicio.
5. **Gate final** de doc 11 §3 paso 5:
   - P8 y P8′;
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
| V9 | Igual; las diferencias esperadas son las variables nuevas, **vacías**: `PROJECT_CHAT_ENABLED`, `CONVERSATION_COMPOSER_BG_ENABLED`, `COMPOSER_BG_CLI_VERSIONS` y `COMPOSER_BG_SESSIONS` |
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
