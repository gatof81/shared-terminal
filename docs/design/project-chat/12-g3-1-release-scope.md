# Release de G3-1 — informe de alcance (diagnóstico, nada ejecutado)

Estado: **diagnóstico preparado desde el repositorio; `D` NO VERIFICADO.** Claude no tiene ni debe
tener acceso a VM100. Lo que exige el host lo hace un operador autorizado, **sólo con lecturas**: sin
backup, deploy, build, recreación, cambio de variables ni operación que altere contenedores o
sesiones. `observe` no se inicia. G3-2 sigue en NO-GO. Destino propuesto: `a93232f` (#545). Hoy
`main` está en `04f602b` (#550, sólo docs), con el **mismo backend compilado** que `a93232f`.

## 1. SHA efectivo `D` del backend e identidad de su imagen

**Hoy no se puede probar desde fuera del host.** GitHub no registra despliegues del backend (la API
de deployments está vacía) y ningún PR anota un SHA desplegado. Lo único disponible son reportes:
el responsable informó el 2026-11-05 que #521 estaba desplegado y que «Claude A desplegó #537». Eso
apunta a la clase de `cf18fe0`, pero **es un reporte, no evidencia**. El HEAD del checkout de deploy
tampoco prueba qué imagen corre.

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

**Si `D` = clase `cf18fe0`** (lo reportado, sin verificar), el delta de backend es sólo **#541 + #545**:
sin migración ni configuración nueva.

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
  sin resolver. Con `D` = clase `cf18fe0` no hay migración que cruzar.

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

**Recomendación:** release conjunto a un **SHA fijo, `a93232f`** (o `04f602b`, con el mismo backend),
condicionado a `D`:
- **`D` verificado = clase `cf18fe0` o `1befd89`** ⇒ release conjunto. El delta es pequeño (#541 y
  #545 apagado), sin migración ni configuración nueva.
- **`D` verificado más antiguo** ⇒ **acotado**: otro plan revisado, porque el delta suma la migración
  v18, pins `on` por defecto y la política del Composer.
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
