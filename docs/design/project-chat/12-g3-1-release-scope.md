# Release de G3-1 — informe de alcance (diagnóstico, nada ejecutado)

Estado: **diagnóstico preparado desde el repositorio. Actualizado el 2026-11-06 con el preflight de
sólo lectura de Claude A (§7). Digest efectivo `1b116d5a…` = `1befd89+R1`, aceptado por el
responsable (D1-a) **sólo** para ese artefacto; candidato = `main` con la corrección de higiene #555
(D2-C).** Claude no tiene ni debe
tener acceso a VM100. Lo que exige el host lo hace un operador autorizado, **sólo con lecturas**: sin
backup, deploy, build, recreación, cambio de variables ni operación que altere contenedores o
sesiones. `observe` no se inicia. G3-2 sigue en NO-GO. Destino propuesto: `a93232f` (#545). Hoy
`main` está en `04f602b` (#550, sólo docs), con el **mismo backend compilado** que `a93232f`.

## 1. SHA efectivo `D` del backend e identidad de su imagen

**Hoy no se puede probar desde fuera del host.** GitHub no registra despliegues del backend (la API
de deployments está vacía) y ningún PR anota un SHA desplegado. Hay menciones de despliegues
anteriores, pero no son evidencia y **este informe no infiere `D` de ellas**: lo establece Claude A
(operador de VM100) con la prueba de abajo. El HEAD del checkout de deploy tampoco prueba qué imagen
corre.

**Prueba por contenido (lecturas, la hace el operador).** El JS compilado de `dist/` es reproducible:
`tsc` sale fijado por el lockfile, idéntico en todo el rango; los source maps usan rutas relativas;
y se comprobó que recompilar da el mismo digest y que un commit sólo de frontend da el mismo digest
que su base. Se compara el digest del `dist` **que corre dentro del contenedor** con la tabla:

```bash
# 1. el contenedor del backend y la imagen con la que corre (lecturas)
docker compose ps app
CID=$(docker compose ps -q app)
docker inspect "$CID" --format 'container={{.Id}} image={{.Image}} started={{.State.StartedAt}}'
docker image inspect "$(docker inspect "$CID" --format '{{.Image}}')" --format 'image={{.Id}} created={{.Created}}'
# 2. digest del dist que ejecuta ESE contenedor
docker exec "$CID" sh -c 'cd /app && find dist -type f -name "*.js" | LC_ALL=C sort | xargs sha256sum' | sha256sum
# 3. contexto, sin valor probatorio: el checkout de deploy
git -C <repo-de-deploy> rev-parse HEAD; git -C <repo-de-deploy> status --porcelain
```

Interpretación:
- **Coincide con una fila** ⇒ `D` = esa clase de backend. Es el SHA de la fila o cualquier commit
  posterior que no cambie el compilado (frontend, docs, tests).
- **No coincide con ninguna** ⇒ `D` no verificado (por ejemplo, un build de otra rama). Se detiene y
  se informa.

La identidad de la imagen (`image=` / `created=`) se registra junto al digest.

| Clase (commit) | PR | Digest de `dist/**/*.js` (sha256 del manifiesto) | Archivos |
| --- | --- | --- | --- |
| `2ea5700` | base #501 | `8d9ff6071144a5f4307d2c28c5d44c45f0f360f2d6cce8129cd471278209823e` | 96 |
| `7506531` | #502 | `55325f798781a662d56040c27bfef315ca99ac9fb3704bccbcff112b498c1d93` | 96 |
| `19bdb0b` | #503 | `519359a29cbc21f8c4549c3409de90a1b9476e9d0477606491b764dc75f6ffad` | 96 |
| `96ac31b` | #505 | `fb59899c1fa8b0063c8d172df866d1c1f007147f5199ea44b817bb8265515411` | 96 |
| `001c0b7` | #508 | `c73411083f7713b889c93b1dc0120259b61b000cad1688b6059d99c0b72c1f95` | 96 |
| `dd30374` | #511 | `0c80453193f2314207b4f93714896f33f8b7a29eca3a4ee4c92e3e35c85254bc` | 96 |
| `407870e` | #513 | `4d32b71a309aa523c58b9a9cd24f06ff08d7b215a92f0f0dbdd448a0a4835c60` | 96 |
| `1585512` | #518 | `b0962515e07904f0a7c548f1b115cc0812809c216a6b9e69dec0380dd11d14b6` | 97 |
| `d5c7e12` | #520 | `e3ee3acc4c77e81a3a16140529575316532f43092b6ae98f50afdb0ad29954e4` | 99 |
| `27bda46` | #523 | `ea3d3250037fb19015bd3329244e89c6becf4b07abd2c93ab36d8208a8f7d779` | 100 |
| `1bd575b` | #522 | `0e2dc66066b17a3216e81725d9339000ba4c3d8ad5b3b34d062a330c396822d3` | 101 |
| `f113359` | #521 | `be86bb39d9f7cab04b3e8230a90fd6c340e357ec6dec6c51c7408814fb6828fd` | 103 |
| `cf18fe0` | #537 | `0ad8772f560c0827070354f4bbebbfa626d4ece17d9fa5d8c96232a1288878f5` | 103 |
| `1befd89` | #541 | `3f1816a2feea8a6ed7e0aadb915388f840091fdd000234a41429a969367db252` | 103 |
| `a93232f` | #545 | `d1f310d83394c672133be555402ca1ea5067b79d3a8d1a9b181bb8fae7d3b124` | 104 |
| `1befd89+R1` | #541 + residuo R1 (D1-a, §7.4) | `1b116d5aa878d1ca34a2d8c614efa0a4598be744f729ffbb7dfe8ff7db7c2836` | 104 |

**Fila `1befd89+R1`: excepción enumerada, válida sólo para la imagen `221e6851`.** Es el
manifiesto de `1befd89` más exactamente la línea `236c9aa6efbf944a8c21eed7318cf4580ff138d050784dd8e6c4a34c892f992c  dist/ringBuffer.js`,
compilado de `e61910d:backend/src/ringBuffer.ts`. No autoriza ningún otro archivo ni relaja ninguna
otra comprobación. Cualquier imagen nueva tiene que dar una fila sin residuo.

Para regenerar una fila (sin Docker): `git archive <sha> backend/src backend/tsconfig.json`, enlazar
un `node_modules` instalado con ese mismo lockfile, correr `tsc -p tsconfig.json` y aplicar el mismo
`find … | sha256sum`.

## 2. Inventario del rango (`2ea5700..a93232f`; el rango real empieza en `D`)

**Backend, ops, imagen de sesión y migraciones**, por PR. Son los únicos que cambian VM100.

| PR | Área | Impacto operativo | Configuración | Riesgo / dependencia |
| --- | --- | --- | --- | --- |
| #502 | backend | Teardown fail-closed: `kill`/`stop`/purge que fallan responden 500 `teardown-failed` y conservan la fila | — | Cambia respuestas de delete/stop ante errores de Docker |
| #503 | backend | Los CLIs del host validan `JWT_SECRET`; el plan de carry tolera logs de npm rotados | `JWT_SECRET` válido | Un CLI del host con secreto inválido deja de correr |
| #505 | backend | Reconciliación por evidencia (v1.7.2): bindings por arranque, probes al reanudar y por silencio | — | Al reiniciar, se recalculan estados y bindings |
| #508, #511 | backend | Composer: foreground por identidad de proceso; envío sólo con el prompt confirmado | — | Más rechazos `needs-terminal` donde antes se enviaba |
| #513 | backend | Una imagen borrada cuenta como «sin etiqueta de relay» | — | Sin #520, la captura se retira en contenedores con la imagen borrada (incidente 2026-11-03) |
| #518 | backend + **migración v18** | Renombrar y archivar (metadatos del dueño) | — | Ver §4 |
| #520 | backend + ops | Acreditación de capacidad firmada (no depende de que exista la imagen) | `SECRETS_ENCRYPTION_KEY` (subclave) | Neutraliza #513 sólo en contenedores con acreditación o registro de recreación |
| #523, #522 | backend + ops | Política de versión del Composer sobre la versión del **proceso**: `COMPOSER_CLI_VERSIONS` exacta, mínimo opcional y lista de bloqueo | `COMPOSER_CLI_MIN_VERSION`, `COMPOSER_CLI_DENY` (vacías por defecto) | Puede bloquear envíos a sesiones con un CLI fuera de la lista |
| #521 | backend + ops | Pins estrictos de imagen: se crea protegido o nada; build sólo con `scripts/build-session-image.sh` | `SESSION_IMAGE_PINS` (**`on` por defecto en compose**), `SESSION_IMAGE_PIN_REPO`, `SESSION_IMAGE_PIN_EXCEPTIONS` | Si los pins no están preparados, falla crear sesiones nuevas |
| #524 | **imagen de sesión** | `SessionStart` registra la versión del CLI del proceso | — | **Fuera de este deploy**: necesita reconstruir la imagen con el script protegido y recrear |
| #537 | backend | Sólo una conversación `interactive` toma un pane (v1.8.5) | — | — |
| #541 | backend | Escrituras del índice frente a la expulsión G4 y la purga | — | — |
| #545 | backend + ops | Origen de red de la ingesta (G3-1) | `INGEST_REQUIRE_SESSION_ORIGIN` (vacía = apagada) | Neutro apagada |

El delta concreto depende de `D`. El Apéndice A lo precalcula para cada clase posible.

**Frontend** (Cloudflare Pages, no VM100): #504, #506, #507, #511 (una parte), #519, #525, #526, #528–#536,
#538–#540, #543, #548, #551. **Docs y tests:** #515, #516, #527 (config de Playwright), #544, #550 y el resto
de los tests.

## 3. Uso actual, configuración y efecto de reiniciar el backend

- **Uso, reportado y no verificado:** captura activa en sesiones reales, Composer, pins de imagen
  (#521) y bindings por pane (#537). Lo confirma el operador con lecturas:
  - `GET /api/admin/stats` → `.conversation` (`enabledSessions`, `effectiveSessions`) y `.composer`
    (que existe sólo con el Composer activo);
  - `docker compose exec app printenv SESSION_IMAGE_PINS COMPOSER_CLI_MIN_VERSION COMPOSER_CLI_DENY CONVERSATION_ENABLED INGEST_REQUIRE_SESSION_ORIGIN`
    (sólo nombres de variables sin secretos).
- **Un reinicio del backend, cualquiera sea `D`:**
  - corre la reconciliación de arranque (sesiones sin contenedor ⇒ `stopped`; bindings de sesiones
    detenidas liberados; probes);
  - se reinician cachés y contadores en memoria (las stats de admin vuelven a cero);
  - se reconectan los WebSocket;
  - un apagado ordenado cancela lo que esté en vuelo: un envío del Composer queda
    `uncertain{orphaned}` y bloquea su pane hasta reconciliar; un bootstrap queda `failed`; una
    recreación en curso queda sin resolver (D8).

  Por eso la condición de §6 exige que no haya nada en vuelo.

## 4. Migraciones y rollback

- **En el rango hay una sola migración: v18** (`conversation_user_meta`, #518; antes el máximo era 17,
  después 18). Se aplica **sólo si `D` < `1585512`**. Se comprueba con una lectura del ledger en D1:
  `SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 3`.
- **Compatibilidad con el backend anterior, verificada en el código y no asumida:**
  - `migrateDb()` de un backend anterior (por ejemplo `2ea5700`) recorre **sus** migraciones y no
    falla ante versiones del ledger que no conoce, así que arranca;
  - su hard delete hace `DELETE FROM sessions`, y la FK de v18 es `ON DELETE CASCADE`, así que no se
    bloquea.
- **Riesgos de rollback según adónde se vuelva:**
  - por debajo de `1585512`: los renombres y archivados desaparecen de la UI (los datos quedan), y los
    backups de ese backend **no incluyen** `conversation_user_meta`;
  - por debajo de `d5c7e12` (#520): vuelve el comportamiento del incidente del 2026-11-03 si falta
    alguna imagen;
  - por debajo de `f113359` (#521): se pierde la protección de imágenes;
  - por debajo de `7506531` (#502): vuelve el teardown que no es fail-closed.
- **Rollback viable:** volver a `D` con `docker compose up -d --build app`, nunca con una recreación
  sin resolver. Si `D` ≥ `1585512`, no hay migración que cruzar (Apéndice A).

## 5. Frontend (Pages) separado del backend (VM100)

- **Pages:** GitHub tiene un check «Cloudflare Pages — Deployed successfully» en **cada** commit de
  `main` (por ejemplo `dd30374` 2026-11-02, `1585512` 2026-11-03, `cf18fe0` 2026-11-05 y `04f602b`
  2026-11-06), con una URL de build. Si el alias de **producción** sigue a `main`, el frontend
  publicado ya es el de `04f602b`. Eso no se ve desde GitHub y hay que confirmarlo en el panel de Pages
  (*Production deployment*).
- **Backend:** sin registro; es `D` (§1).
- **Acople:** el frontend #519 llama `PATCH /sessions/:id/conversations/:cid`, que sólo existe desde
  el backend #518. Con el frontend al día y `D` < `1585512`, renombrar y archivar falla **hoy**. Los
  demás PRs de frontend del rango usan rutas que ya existían (por ejemplo, `…/agents` de #539 existe
  desde antes de #502).

## 6. Recomendación y condiciones

**Actualización:** con el preflight de A, la propuesta vigente está en §7.3.

**Recomendación:** release conjunto a un **SHA fijo, `a93232f`** (o `04f602b`, con el mismo backend),
condicionado a la clase de `D` que verifique el operador, según el Apéndice A:
- **`D` en `f113359`, `cf18fe0` o `1befd89`** ⇒ release conjunto: delta chico, sin migración ni
  configuración nueva con efecto por defecto.
- **`D` en `1bd575b` o anterior** ⇒ **acotado**: otro plan revisado, porque el delta suma pins `on` por
  defecto y, según la clase, la política del Composer y la migración v18.
- **`D` no verificado** ⇒ NO-GO.

**GO para preparar la ejecución** sólo si se cumple todo:
1. `D` verificado por digest (§1), con la identidad de imagen registrada.
2. El responsable aprueba la lista de PRs de `D..a93232f` (§2).
3. Lecturas de §3: variables de entorno registradas; el estado de pins es coherente con `SESSION_IMAGE_PINS`.
4. Migraciones: el ledger de D1 leído; se conoce si v18 se aplicaría.
5. Nada en vuelo:
   - **ninguna recreación sin resolver**: `jq -r .state <WORKSPACE_ROOT>/.st-control/*/recreate-attempt.json`
     es `resolved` en todas; uno ilegible ⇒ NO-GO;
   - **ningún envío del Composer pendiente o ambiguo**: `GET /api/admin/sessions/:id/composer/panes`
     de cada sesión devuelve `panes: []` y `unreadable: []`. Cualquier entrada (`phase` activa,
     `result` `pending`, `effects` `pending`, `pending` no vacío) o cualquier `unreadable` ⇒ NO-GO.
     Un 404 de la ruta significa Composer apagado, sin nada en vuelo.
6. Se sabe si el alias de producción de Pages sigue a `main` (§5).

**NO-GO** ante cualquier condición sin cumplir, ante `D` sin verificar, o si alguna lectura exigiera
una operación de escritura. **El backup** (antes P9) es escritura y pasa a una etapa posterior,
autorizada por separado, inmediatamente antes de ejecutar el deploy.

## 7. Preflight de Claude A (2026-11-06): reportado, comprobado y pendiente

### 7.1 Lo reportado por A (lecturas en VM100, sin interrumpir #547)

| Tema | Reportado por A | Comprobado por B en el repo | Valor probatorio |
| --- | --- | --- | --- |
| Checkout de deploy | `1befd89` (#541), con una modificación local **aprobada** en `session-image/Dockerfile` | — | contexto: **no** prueba qué backend corre (§1) |
| Backend | contenedor `da75082e`, imagen `221e6851`, `healthy` | — | identidad registrada; falta ligarla al código por digest |
| G3-1 | no está en el `dist` ejecutado | coherente con cualquier clase anterior a `a93232f` | no distingue entre clases |
| `INGEST_REQUIRE_SESSION_ORIGIN` | ausente | — | P4 cumplida |
| Captura | 3 sesiones habilitadas, 3 efectivas | — | línea de base de V5 |
| Composer | 0 operaciones registradas | — | ver 7.2 (método) |
| Recreaciones | 3 resueltas, ninguna sin resolver | — | P8 (parte de recreaciones) |
| Contenedores | activos y retenidos inventariados, PASS-B1 incluidos | — | línea de base de V4 |
| Disco | 36 GB libres, 82 % usado | — | no alcanza por sí solo para decidir el gate de espacio (11 §1.1) |
| Backup anterior | disponible, también en el NAS | — | no reemplaza el backup nuevo (11 §2) |
| Alcance `1befd89..a93232f` | #548, #544, #551, #545; sólo #545 es runtime de backend; sin migraciones | **sí**: `git log` da esos 4; `backend/` cambia sólo en #545 (más tests de #544); `db.ts` y `session-image/` sin cambios; compose agrega sólo la línea de la bandera (vacía) | alcance confirmado |
| `main` después de `a93232f` | #550 (docs), #552 (frontend), sin backend | **sí** | el destino sigue fijo en `a93232f` |

Con eso el release cae en la fila **`1befd89`** del Apéndice A (delta = sólo #545, sin migración,
sin configuración con efecto por defecto), **a condición** de que el digest lo confirme. El checkout
en `1befd89` no se toma como prueba.

### 7.2 Evidencia que falta (para pedírsela a A; todo lecturas)

Ninguna requiere escribir, reiniciar ni tocar sesiones. Se pide cuando el responsable lo coordine,
sin interrumpir #547.

1. ~~Digest efectivo~~ **hecho** (`1b116d5a…`, §7.4). No se repite.
2. **Imagen de rollback.** `docker image inspect 221e6851 --format '{{.Id}} {{json .RepoTags}} {{.Size}}'`
   y `docker compose config --images` (nombre de la imagen del servicio `app`; no imprime secretos).
3. **Excepción del Dockerfile.** `git rev-parse HEAD`, `git symbolic-ref -q HEAD || echo detached`,
   `git status --porcelain`, `git diff --stat` y `sha256sum session-image/Dockerfile`. Sirve para
   comprobar después del checkout que quedó idéntica (11 §3 paso 2).
4. **Espacio.** `df -h` del filesystem de `WORKSPACE_ROOT` y de `docker info --format '{{.DockerRootDir}}'`;
   `docker system df`; `du -sh` de `WORKSPACE_ROOT` excluyendo `.backups`; `du -sh` y fecha del
   último backup local, y fecha de la copia en el NAS.
5. **Composer, por el método de P8.** Confirmar que «0 operaciones» sale de
   `GET /api/admin/sessions/:id/composer/panes` por sesión (`panes: []`, `unreadable: []`) o de un
   404 (Composer apagado), y no de contar archivos. Si el Composer está encendido, el valor de
   `CONVERSATION_COMPOSER_ENABLED`.
6. **Recreaciones.** Si algún `recreate-attempt.json` tiene un contenedor `retained` (se registra para
   no tocarlo; no bloquea el deploy).
7. **Líneas de base con hora:** `.conversation` completo (`eventsSinceBoot`, `rejectedSinceBoot`,
   `gapsSinceBoot`), sesiones por estado, conteos de `relay_dropped`/`relay_restart` (P6) y cantidad
   de líneas `error` del log del backend en la última hora (P13).

Las lecturas 1–6 deciden si el procedimiento puede aprobarse. La 7 se repite de todos modos en la
ventana del deploy.

### 7.4 Discrepancia del digest (2026-11-06): diagnóstico y dos decisiones separadas

**Lo que dio VM100** (A, contenedor `da75082e`): `1b116d5aa878d1ca34a2d8c614efa0a4598be744f729ffbb7dfe8ff7db7c2836`,
104 archivos `.js`. Los 103 de `1befd89` coinciden byte a byte; sobra `dist/ringBuffer.js`. **El gate
de §1 falla**: ese valor no está en la tabla. Esta prueba no se vuelve a pedir.

**Causa** (repo): el `Dockerfile` raíz hace `COPY backend/ .` en la etapa de build, no hay
`.dockerignore` en la raíz (ni en ningún lado), y `tsc` no borra salidas cuyo fuente ya no existe. Un
`backend/dist` local del checkout de deploy entra en la imagen y sus huérfanos sobreviven al build.

**Comprobación de B, sin pedir nada nuevo a VM100:**

1. `backend/src/ringBuffer.ts` existió en `e61910d` (commit inicial) y `f96f4c2`, y se borró en
   `9b86c46` (#84).
2. Compilado con el `tsconfig.json` de esa época y el mismo `tsc` 5.9.3: la versión de `e61910d` da
   `dist/ringBuffer.js` = `236c9aa6…`; la de `f96f4c2`, `ff8e49d0…`.
3. **El manifiesto de referencia de `1befd89` (103 líneas) más la línea `236c9aa6…  dist/ringBuffer.js`,
   ordenado igual, da exactamente `1b116d5a…`.** Como el valor de A es el sha256 del manifiesto
   completo, eso fija **cada** ruta y **cada** hash: son los 103 de `1befd89` más ese único archivo,
   con procedencia identificada (el `ringBuffer.ts` del commit inicial), y nada más entre los `.js`.
4. Es inerte: ningún archivo de `backend/` en `1befd89` menciona `ringBuffer` (`git grep -i` vacío,
   tests incluidos), no hay `require`/`import()` dinámicos en `backend/src`, y el archivo sólo define y
   exporta una clase, sin `require` ni efectos al cargarse. Node no lo carga nunca.
5. Límite declarado: el manifiesto cubre sólo `*.js`. Los `.map`, `.d.ts` y `.json` del `dist` no
   están cubiertos; ninguno es código que Node ejecute aquí (el backend no importa `.json`, `git grep`
   vacío), pero no se afirma nada sobre ellos.

#### D1 — Cómo aceptar la identidad del backend anterior — **decidida: D1-a**

| Opción | Qué significa | Ventaja | Costo |
| --- | --- | --- | --- |
| **D1-a (recomendada)** | Agregar a la tabla de §1 una fila **enumerada** `1befd89+R1` = `1b116d5a…`, donde R1 = {`dist/ringBuffer.js` `236c9aa6efbf944a8c21eed7318cf4580ff138d050784dd8e6c4a34c892f992c` ← `e61910d:backend/src/ringBuffer.ts`}. La regla sigue siendo **igualdad exacta** con un manifiesto completo: cualquier otro archivo extra, faltante o distinto ⇒ no verificado | no ignora nada desconocido: el único extra aceptado está nombrado, hasheado y con procedencia; es reproducible por cualquiera | la tabla gana una fila con residuo; queda registrado como deuda de build |
| D1-b | Aceptar «103 coinciden, extras inertes» como regla general | simple | **rechazada**: es justo ignorar archivos desconocidos |
| D1-c | No aceptar hasta tener una imagen limpia | máximo rigor | exige reconstruir o tocar VM100 (prohibido) y no cambia lo que corre hoy |

Con D1-a, la identidad de la imagen de rollback (`221e6851`) es la misma fila, así que el rollback
se verifica contra `1b116d5a…` (11 §4), no contra `3f1816a2…`.

#### D2 — ¿La corrección del build obliga a cambiar el SHA candidato? — **decidida: D2-C**

**Hecho que obliga a decidir:** si se construye `a93232f` en el mismo checkout, el `backend/dist`
del host vuelve a entrar. La imagen nueva daría `a93232f+R1` (`886281d971e5798a3d1336a03d633118defe0d3afabed8911b0e5bfdc16182fa`
si el residuo es sólo R1) y **la verificación de 11 §3 paso 4 (`d1f310d8…`) fallaría**. Seguir con
`a93232f` sin nada más no pasa el gate.

| Opción | Candidato | Qué hace falta | Ventaja | Costo |
| --- | --- | --- | --- | --- |
| D2-A | `a93232f`; aceptar `a93232f+R1` = `886281d9…` | nada en el repo | sin cambiar el SHA | perpetúa el residuo en la imagen nueva; cualquier otro huérfano del host lo hace fallar igual (fail-closed) |
| D2-B | `a93232f`; en la etapa de deploy, **mover** `backend/dist` del checkout fuera del repo (no borrarlo) antes del build | una escritura más en VM100 dentro del deploy autorizado | imagen limpia, `d1f310d8…` exacto; el SHA no cambia | paso manual; el próximo build manual en el host vuelve a crear el riesgo |
| **D2-C (recomendada)** | un commit nuevo de `main` con la corrección de higiene (PR propio) | PR revisado, checks verdes (incluido el job nuevo, que tiene que fallar antes del arreglo), alcance aprobado de nuevo | la imagen no depende del host nunca más, y CI lo prueba en cada PR; el `dist` compilado sigue siendo `d1f310d8…` | nuevo ciclo de revisión; el alcance suma #550 (docs), #552 (frontend) y el PR de higiene, ninguno con runtime del backend |

**Recomendación:** D1-a ahora (sólo documentación), y D2-C. Si el responsable prefiere no esperar
el PR, D2-B es aceptable; D2-A no se recomienda. Hasta que se decida, el procedimiento de 11 queda en
NO-GO.

**Corrección: PR #555** (`fix/backend-image-hygiene`; draft, sin merge). El estado de sus checks y de su
revisión está en el informe de release. Contenido:

- `.dockerignore` raíz como **allowlist**: `*` y luego sólo `backend/package.json`,
  `backend/package-lock.json`, `backend/tsconfig.json` y `backend/src/`. No afecta la imagen de sesión
  (su contexto es `./session-image`). De paso deja fuera `.env`, `.git` y `node_modules` del contexto.
- `Dockerfile`: la etapa de build copia `backend/tsconfig.json` y `backend/src` por nombre, en vez
  de `COPY backend/ .` (defensa doble si el `.dockerignore` se aflojara).
- `backend/package.json`: `prebuild` borra `dist` antes de `tsc`. Sirve también al host: un
  `npm run build` local ya no acumula huérfanos.
- Job de CI `backend-image`, **en un commit anterior al arreglo** para que se vea fallar: compila
  limpio como referencia (todos los archivos de `dist`, no sólo `.js`), contamina el árbol como estaba
  el host (`backend/dist/planted-orphan.js`, `backend/node_modules/.planted`, `backend/.env`),
  construye el `Dockerfile` real y exige que el `dist` de la imagen sea idéntico a la referencia y
  que la etapa de build no tenga nada del host.
- Verificado en local sin Docker: con un `dist/ringBuffer.js` plantado, `npm run build` lo elimina y
  el digest sigue siendo `d1f310d8…` (104 `.js`; `0e50e8fd…` con los 416 archivos del `dist`).
- En CI, el commit de la prueba solo **falló** como se esperaba: la única diferencia fue
  `+… dist/planted-orphan.js` sobre 416 archivos de referencia.

### 7.5 Condiciones de §6 con la evidencia actual

| # | Condición | Estado |
| --- | --- | --- |
| 1 | `D` verificado por digest, imagen registrada | **cumplida** como `1befd89+R1` (D1-a), imagen `221e6851` |
| 2 | Lista de PRs aprobada | `1befd89..R` = 7.1 + #553, #542 (frontend/docs) + #555 (build); se aprueba con el merge de #555 |
| 3 | Variables registradas | `INGEST_REQUIRE_SESSION_ORIGIN` ausente; el delta no cambia ninguna otra variable |
| 4 | Migraciones | no aplica: ninguna en el rango |
| 5 | Nada en vuelo | recreaciones cumplida; Composer pendiente de método (7.2 punto 5). Se repite en la ventana |
| 6 | Alias de Pages | no condiciona este release: el backend del rango no cambia ninguna ruta que use el frontend |

**Propuesta:** release **G3-1 + higiene de la imagen**, al SHA `R` de `main` tras el merge de #555, con el procedimiento de
[11-g3-1-deploy-plan.md](./11-g3-1-deploy-plan.md) §1–§4. Pendiente para el deploy: (a) el merge de #555, que fija `R`; (b) las lecturas 2–7 de §7.2 (la 1 ya
está hecha y no se repite); (c) la autorización del deploy y de cada etapa de escritura.

## Apéndice A — matriz de decisión por clase de `D` (precalculada; `D` lo aporta el operador)

El delta es siempre `D..a93232f` (sólo backend). Columnas: PRs de backend que entran, si se aplicaría
v18, configuración nueva cuyo **valor por defecto** cambia el comportamiento, riesgo dominante del
paso y tipo de release recomendado.

| Clase de `D` | PRs de backend que entran | v18 | Config. nueva con efecto por defecto | Riesgo dominante | Release |
| --- | --- | --- | --- | --- | --- |
| `a93232f` | — (ya desplegado) | no | — | — | nada que desplegar |
| `1befd89` | #545 | no | — (`INGEST_REQUIRE_SESSION_ORIGIN` vacía = apagada) | mínimo | conjunto |
| `cf18fe0` | #541, #545 | no | — | bajo (escrituras del índice de captura) | conjunto |
| `f113359` | #537, #541, #545 | no | — | bajo: al reiniciar, los panes se ligan sólo a conversaciones `interactive` | conjunto |
| `1bd575b` | #521 + las anteriores | no | **`SESSION_IMAGE_PINS=on`** (compose) | crear sesiones falla si los pins no están preparados; el build exige el script protegido | **acotado** |
| `27bda46` | #522 + las anteriores | no | + política del Composer (`COMPOSER_CLI_MIN_VERSION`/`COMPOSER_CLI_DENY`, vacías ⇒ lista exacta) | envíos del Composer bloqueados en CLIs fuera de la lista | **acotado** |
| `d5c7e12` | #523 + las anteriores | no | ídem | ídem; la versión decisiva pasa a ser la del proceso | **acotado** |
| `1585512` | #520 + las anteriores | no | — (subclave de `SECRETS_ENCRYPTION_KEY`) | #513 sin #520 corre hoy: la captura se retira si falta una imagen; el deploy lo corrige sólo para contenedores acreditados | **acotado** |
| `407870e` | #518 + las anteriores | **sí** | — | migración v18; el `PATCH` que usa el frontend #519 falla hoy | **acotado** |
| `dd30374` | #513 + las anteriores | **sí** | — | ídem + el cambio de #513 | **acotado** |
| `001c0b7` … `2ea5700` | #511, #508, #505, #503, #502 + las anteriores | **sí** | `JWT_SECRET` válido para los CLIs del host (#503) | delta grande: teardown, reconciliación, Composer, captura, migración | **acotado** (plan propio) |

Lectura rápida: el corte está en **#521**. Si la clase de `D` es `f113359` o posterior, el release
conjunto no trae migración ni configuración con efecto por defecto. Si es anterior, sí.

