# Release v19 (P3a): propuesta para revisar con Claude A

Estado: **propuesta, 2026-11-09. NO-GO para ejecutar.**
- #557 está **mergeado** en `main` como `2a676db` (2026-11-09, lo mergeó A después de su QA). El owner
  autorizó el merge, no el deploy.
- Esta versión incorpora las correcciones C1–C5 de A, leídas en VM100 el 2026-11-09 (#512, comentario
  6747021013).
- Nada de lo que sigue se ejecuta sin un GO específico del owner, y nunca antes de que cierre la ventana
  `observe` en curso (§4, gate final).

**Base:** el procedimiento de doc 11 (§1–§4), que este documento **no reescribe**. Indica qué cambia al
pasar de `P` a `M` y qué se agrega por v19. A lo ejecuta con su juego de scripts
(`st-deploy-scripts-2a676db`, derivado del de `f113359`/`166ff78`).

**Notación:**
- `M` = `2a676db`, el merge de #557 en `main`;
- `P` = `166ff78` (#547), lo que corre hoy en VM100 (C1). G3-1 (`R` = `e198b07`) se desplegó el
  2026-11-06 y #547 después.

## 1. Qué cambia en producción entre `P` y `M`

`P..M` son dos PRs:
- **#557** (`M`) es el único cambio de backend;
- **#559** (`40da4df`, la primera UI de Projects & Agents) es sólo frontend. Pages ya la publicó, y
  queda oculta mientras `/api/auth/status` no traiga `features.projectChat` (V11).

Ninguno toca `session-image/`, `Dockerfile`, `.dockerignore` ni `package*.json`.

| Cambio (#557) | Con `PROJECT_CHAT_ENABLED` apagada (lo que se propone) |
| --- | --- |
| **Migración v19**: cuatro tablas (`projects`, `project_agents`, `agent_bindings`, `project_agent_creations`), dos triggers y tres índices. No modifica ni lee ninguna tabla existente; `agent_bindings` no tiene FK a `sessions`. **Corre al arrancar, sea cual sea la bandera** | Se crean vacías y nada las escribe |
| Rutas `/api/projects/*` | No se montan: dan 404 |
| `GET /api/auth/status` y `GET /api/sessions` | Iguales byte a byte: sin `features` y sin `binding` |
| Guard de hard delete (`assertNoLiveBinding`, dos veces por hard delete, owner y admin) | **Activo**. Hace dos lecturas D1 más por hard delete. Sin vínculos, nunca rechaza |
| `failSession` usa `SessionManager.markFailed` (`AND status != 'terminated'`) | **Activo**. Una sesión `terminated` ya no vuelve a `failed` por un bootstrap que falla tarde |
| Backup y restore | El backup exporta además las cuatro tablas (`sinceSchema: 19`). El restore avisa con un `WARN` por cada tabla que el `schemaVersion` del backup tiene pero sus archivos no traen (PROJECTS.md §8) |

**#547 ya está en `P`.** Los registros `job-*.json` no son un riesgo para el rollback, porque `P` los
conoce. Igual se mantiene P8′ como gate; hoy no hay ninguno en disco (C1).

## 2. Secuencia

Ya no aplica: G3-1 y #547 están desplegados (C1). Este release es sólo `P → M`, con v19 como única
novedad de backend.

## 3. Evidencia disponible antes del GO

1. **D1 real** (2026-11-09, cuenta de pruebas dedicada):
   - `d1Live.smoke.ts` 30/30 PASS en `771c519` y otra vez en `d172116`;
   - `v19Compat.smoke.ts` 39/39 PASS (main `40da4df`, PR `d172116`): los dos escenarios de QA de A,
     que son v18 con datos → v19, y el backend v18 sobre la base v19. Incluye además el roll forward y
     backup/restore después de un rollback.
   - Cubre migración, triggers e índices guardados por D1, creación atómica, idempotencia, rechazos
     reconocidos, concurrencia, guard, `markFailed` y re-migración con reinicio. Evidencia en #557.
2. **El rollback se probó con el artefacto exacto de `P`.** El backend `main` del escenario 2 tiene
   `dist/**/*.js` = `7d947cff2430dfd6…`/106, byte a byte el `dist` que corre hoy en VM100 (C1).
   «El backend anterior sobre una D1 v19» quedó probado con la misma build a la que se volvería.
3. **Compatibilidad hacia atrás, en el código:** `migrateDb()` aplica sólo las versiones que conoce y no
   están registradas (`applied.has`), así que ignora una v19 registrada.
4. **Una v19 interrumpida converge:** cada statement es `IF NOT EXISTS` y el ledger se escribe después de
   `apply()`.
5. **Digests esperados de `M` = `2a676db`.** Los calcularon por separado B (`git archive` + `tsc` 5.9.3) y
   A (`git archive` + `npm ci` + `tsc` 5.9.3), y coinciden (C2).
   - El método de B reproduce exactamente los valores de `R` (`d1f310d8…`/104 y `0e50e8fd…`/416).
   - El backend de `M` es idéntico al de `d172116` (`git diff d172116 2a676db -- backend` vacío).
   - Los valores calculados antes sobre `771c519` (`b45ce209…`, `f91c4486…`) **ya no valen**.

   | Qué | Valor | Archivos |
   | --- | --- | --- |
   | `dist/**/*.js` | **`dc2c2ba780d2721a9dc373ca6111cb15e08eb5a8a2f4fb9649cabf7fc3fdb32e`** | 109 |
   | todo `dist` | **`47a2c0cf668072d846a3d10f67838943517d500af3076b320b4b495f06991d82`** | 436 |

   **Gate vinculante (como en los deploys anteriores):** el manifiesto de **todo** el `dist` de la
   imagen nueva tiene que ser igual al de esta build limpia de `M`. Sin `ringBuffer.js`, y con
   `version: 19`.
6. **CI 9/9** sobre `d172116`: imagen del backend limpia, smokes de la imagen de sesión y e2e.

## 4. Procedimiento: doc 11 §1–§4, con estos cambios

Lo ejecuta A con el GO del owner. Todo lo que doc 11 no cambia aquí vale igual: el congelamiento de la
ventana, las reglas del checkout (sin `-f`, `stash` ni `reset`) y la prohibición de `down`,
`--remove-orphans` y operaciones sobre `st-*`.

### 4.1 Gate previo (sólo lecturas)

Se toman P1 y P3–P13 de doc 11. Doc 11 lleva valores literales de `1befd89` que hay que sustituir así
(valores de `P` según C1):

| Lectura | Valor en doc 11 | Con `P = 166ff78` |
| --- | --- | --- |
| P1 | `1b116d5a…`, contenedor `da75082e`, imagen `221e6851` | `dist/**/*.js` = **`7d947cff2430dfd6…`/106**, todo `dist` = **`15cd6434f2e29650…`/424**. Se toman el **contenedor `app` actual** (hoy `328656f507a0…`) y su imagen (hoy `sha256:fe3648b5b674…` = `shared-terminal-app:latest`), leídos en la ventana |
| P11 | `docker image inspect 221e6851`, `docker inspect da75082e` | `docker inspect <contenedor app actual> --format '{{.Image}}'`. **Ese ID completo** es la imagen que etiqueta el paso 1 y la que verifica §6. La imagen de compose es `shared-terminal-app` (`Config.Image`). Nunca `221e6851` (= `shared-terminal-app:rollback-1befd89`) |
| P12 | **sin** `.dockerignore` | `HEAD` = `166ff78…`; sólo `session-image/Dockerfile` modificado (la excepción 2.1.314); `.dockerignore` **presente y versionado** |
| P13 | `docker logs da75082e` | `docker logs <contenedor app actual>` |
| P5 / V5 | `enabledSessions = effectiveSessions = 3` | **el valor leído en la ventana**, sea cual sea, y V5 igual a ese |
| V9 (base) | — | registrar el valor actual de `INGEST_REQUIRE_SESSION_ORIGIN` (hoy `observe`, C5). **El deploy no lo cambia**; volverlo a `false` es otra decisión del owner, con otro reinicio y nunca en esta ventana |

Lecturas que se agregan:

| # | Lectura | Esperado |
| --- | --- | --- |
| P2′ | `docker compose exec app grep -c 'version: 19' dist/db.js` | `0`: v19 no está (C1) |
| P4′ | `PROJECT_CHAT_ENABLED`: `grep -c '^PROJECT_CHAT_ENABLED=' .env` y `printenv PROJECT_CHAT_ENABLED` en el shell del operador | `0` y vacío |
| P8′ | además de P8: `ls <WORKSPACE_ROOT>/.st-control/*/composer/job-*.json 2>/dev/null` | ninguno |
| P14 | ledger de D1: el log de arranque del contenedor actual | `[db] migrations complete (schema up to date)` (A lo leyó del arranque de las 15:54:28Z: el ledger está en 18) ⇒ N = 1 en V1 |
| P15 | backup nocturno: el cron de diego a las **05:17 locales (08:17Z)**, `shared-terminal-backup.sh` = `compose exec app npm run backup` | la ventana **no se superpone** con él (C4) |

### 4.2 Backup

Igual que doc 11 §2, con el juego de A: `02-backup` genera `pre-<sha>-<ts>` y `02b-offhost` lo copia al
NAS bajo `./manual/`. Las dos copias quedan fuera de la rotación `20*` y del `--delete` del mirror.
- La herramienta se construye desde el árbol **destino** (`M`), como en todos los releases anteriores.
- Sobre la D1 en v18, `M` saltea las tablas con `sinceSchema: 19` y escribe un manifiesto v18. Ese backup
  lo pueden restaurar tanto `P` como `M` (C4).

### 4.3 Deploy (doc 11 §3, con `M`)

1. **Proteger la imagen de rollback.** Es una escritura que sólo agrega una referencia:
   `docker tag sha256:fe3648b5… shared-terminal-app:rollback-166ff78`, con el ID completo de P11 (C3).
   Antes de la ventana, el paso 03 de A prueba la imagen etiquetada en aislamiento (`st-rbprobe`).
2. `git checkout --detach 2a676db`, con las reglas de doc 11 §3 paso 2. `P..M` no toca
   `session-image/Dockerfile`, así que la excepción local se conserva y se verifica igual.
3. `docker compose build app`, y sólo `app`.
4. Verificación de la imagen con los comandos de doc 11 §3 paso 4, contra **los digests de §3.5**
   (`dc2c2ba7…`/109 y `47a2c0cf…`/436), más la versión de Node, que se registra como allí. Cualquier
   otro valor ⇒ NO-GO, sin reinicio.
5. **Gate final**, inmediatamente antes del paso 6:
   - P8 y P8′;
   - **ninguna ventana `observe` abierta.** La actual termina el **2026-11-10 a las 15:54Z**, y su
     lectura de cierre `st-observe-end2` corre a las 15:55Z (C5). El script 04 de A exige
     `observe2-end.txt` presente y ningún timer de observe pendiente. El reinicio pondría a cero sus
     contadores;
   - **ningún backup corriendo y fuera de 08:00–09:00Z** (P15). Un `--force-recreate` durante
     `exec … npm run backup` lo mata;
   - **B inactiva y con su tarea terminada** (`b_idle`, regla permanente del owner);
   - ninguna sesión con `createdAt` en los últimos 15 minutos;
   - la lista `sessionId → status` (base de V10);
   - las banderas como las va a ver el backend nuevo: desde el checkout de `M`,
     `docker compose config --format json | jq -r '.services.app.environment.PROJECT_CHAT_ENABLED, .services.app.environment.CONVERSATION_COMPOSER_BG_ENABLED'`
     ⇒ vacío las dos veces, y `printenv` de las dos en el shell ⇒ vacío;
   - `origin/main` puede haber avanzado más allá de `M`: alcanza con que `M` sea ancestro, porque el
     checkout es de `M` y no de la punta.
   - Cualquier otro resultado ⇒ NO-GO.
6. `docker compose up -d --no-deps --no-build --force-recreate -t 30 app`.

**Opcional, antes del paso 6:** anotar el bookmark de D1 Time Travel. Es sólo evidencia y **nunca** se
usa como rollback de v19:
- requiere credenciales de Cloudflare en VM100;
- un restore volvería atrás **toda** la base: sesiones, conversaciones y ledger.

## 5. Verificación posterior: doc 11 §3.1 V1–V10, adaptadas

| # | Cambio respecto de doc 11 |
| --- | --- |
| V1 | Además:<ul><li>en el log, exactamente un `[db] applying migration 19: projects, project_agents, agent_bindings (P3a directory)` y luego `[db] migrations complete (1 applied)` (N = 1 por P14), sin errores D1 en esas líneas;</li><li>en D1, el ledger 19/19;</li><li>los 9 objetos de v19, con los triggers sólo sobre las tablas nuevas;</li><li>las cuatro tablas vacías.</li></ul> |
| V2 | Manifiesto de todo el `dist` del contenedor en ejecución = build limpia de `M` (§3.5); su imagen = la del paso 4; `grep -c 'version: 19' dist/db.js` > 0 |
| V3 | **Bandera apagada:** `printenv PROJECT_CHAT_ENABLED` dentro del contenedor, vacía |
| V3a | `GET /api/projects` ⇒ 404. A lo prueba por loopback con el token admin del proceso: sin rutas montadas, cualquier identidad recibe 404 |
| V3b | `GET /api/auth/status` sin `features`; `GET /api/sessions` sin ninguna fila con la clave `binding` |
| V4–V6 | Igual que doc 11: inventario P7, captura P5 y pérdidas del relay |
| V7 | Igual (panes y recreaciones), más P8′: ningún `job-*.json` |
| V8 | Igual, con `HEAD = 2a676db` y la etiqueta `shared-terminal-app:rollback-166ff78` |
| V9 | Igual a la base, **incluida** `INGEST_REQUIRE_SESSION_ORIGIN` (sigue en `observe`, con su bloque de stats igual que antes). La única diferencia esperada es `PROJECT_CHAT_ENABLED` **vacía** |
| V10 | Igual |
| V11 | El bundle de producción en Pages no muestra la sección Projects: sin la clave `features`, la UI de #559 queda oculta |

En producción **no** se prueba un hard delete. El guard y `markFailed` quedan cubiertos por la D1 real y
por los tests.

## 6. Rollback: doc 11 §4, por imagen

- **Disparadores:** fallan V1–V11, o hay una regresión de sesiones o captura.
- **Pasos:**
  1. P8 y P8′. Nunca se vuelve atrás con una recreación sin resolver o un envío pendiente del Composer.
  2. `git checkout --detach 166ff78`, con las reglas de doc 11 §3 paso 2. **Va antes del `up`**, para
     que Compose use la configuración de `P`. **Nunca se reconstruye** desde ese checkout.
  3. `docker tag shared-terminal-app:rollback-166ff78 shared-terminal-app:latest` (C3). **Sin este
     paso, `up --no-build` volvería a levantar `M`:** el servicio `app` no tiene `image:` y
     `:latest` ya apunta a `M`.
  4. `docker compose up -d --no-deps --no-build --force-recreate -t 30 app`.
  5. Verificar: la imagen del contenedor = el ID completo de P11 (`fe3648b5…`), el digest de
     `dist/**/*.js` = `7d947cff…` (P1), y V1, V3–V10 contra las lecturas de **antes** del deploy.
- **La base no se toca.** Con la bandera nunca encendida es el caso A de PROJECTS.md §8: seguro y sin
  precondiciones. **Nunca** se borran las tablas de v19 ni se edita el ledger.
- **Si v19 falló a mitad:** queda sin registrar, la imagen `P` no la conoce y arranca igual, y un
  re-deploy de `M` la completa.
- **Backups después de un rollback (C4, PROJECTS.md §8).** Mientras corra `P`, el cron nocturno escribe
  manifiestos v19 **sin** las cuatro tablas, y el restore de `P` los **rechaza** (S2.7 en la D1 real).
  - Esos backups se restauran con la herramienta de `M` o posterior, que los acepta, deja las cuatro
    tablas vacías y avisa con un `WARN` por tabla.
  - En el caso A no se pierde nada.
  - El backup `pre-<sha>` del §4.2 (manifiesto v18) sigue restaurable por `P`.

## 7. Fuera de este release

- Encender `PROJECT_CHAT_ENABLED`: requiere su propio GO. Con vínculos existentes, el rollback pasa al
  caso B (PROJECTS.md §8).
- Cambiar `INGEST_REQUIRE_SESSION_ORIGIN`: decisión aparte del owner, con su propio reinicio.
- Encender `CONVERSATION_COMPOSER_BG_ENABLED`: experimental, no aprobado.
- G3-2, Channels, tareas y despacho: sin autorización.

## 8. Scripts de A y respuestas (2026-11-09)

`/root/st-deploy-scripts-2a676db/` en VM100 implementa este documento: pasos 01–05 más `ROLLBACK.md`
(#512, comentario 6747863704). En el ensayo de las 18:16Z, sólo lecturas salvo la etiqueta:
- **01 OK:** `P` coincide por manifiesto completo, las banderas están apagadas y observe quedó
  registrado;
- **03 OK:** la etiqueta coincide con la imagen en ejecución, y el deploy y el rollback simulados
  devuelven el ID exacto, sin tocar producción.

Los pasos 02, 02b, 04 y 05 corren sólo en la ventana.

Respuestas de A:

1. `P = 166ff78`, con los digests de C1. G3-1 está terminado: `R` se desplegó el 2026-11-06.
2. La secuencia de la versión anterior ya no aplica (§2).
3. Fuera del repo, sólo el cron del backup nocturno depende del esquema (P15, §6).
4. P14 y V3a/V3b se pueden hacer tal como están escritas; los resultados están en §4.1 y §5.
