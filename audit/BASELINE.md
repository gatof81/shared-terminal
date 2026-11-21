# Línea de base de pruebas y CI — programa de simplificación

Medida el 2026-11-21 por @qa, una sola vez, a partir de ejecuciones reales de GitHub Actions (`gh run list/view`, `gh api …/jobs`, logs de los jobs). Al final del programa se repite la misma medición con el mismo método.

- Base de código: `main` @ `d28dad7`.
- [V] = verificado: medido en logs y API, o contado con `playwright --list`. [E] = estimado.
- Los tiempos son **medianas**. Cada job se mide desde que empieza hasta que termina, sin contar la espera en cola.

## Muestras

| Conjunto | Runs (`databaseId`) |
|---|---|
| CI, push a main (10) | 44838300812 (d28dad7), 44830241768, 44825791121, 44822569748, 44820602376, 44815699196, 44812466734, 44770403730, 44767735732, 44767709918 |
| CI, pull_request exitosos (10) | 44837265113, 44837261797, 44837252387, 44833772012, 44833773662, 44833751107, 44829438680, 44824882336, 44824830227, 44820458760 |
| Session Image | 44391773268 (push main, 52de8e6, posterior a #678: el workflow actual de un job) y 44369337648 |
| Logs de tests | jobs del run 44838300812 (push d28dad7) |

## 1. CI (`ci.yml`): tiempos [V]

| | PR | push a main |
|---|---|---|
| Reloj total (primer job → último) | **5,8 min** (máx 7,0) | **8,1 min** (máx 10,0) |
| Suma de minutos de los jobs | 9,5 min | 12,0 min |

El camino crítico es siempre el job de e2e.

| Job (nombre del check) | PR | main | Pasos que pesan |
|---|---|---|---|
| Frontend e2e (Playwright, desktop + mobile) | 5,8 min | 8,1 min | ver detalle abajo |
| Backend (tsc + vitest) | 1,6 min | 1,6 min | Install 19 s / 14 s, tsc+build 4 s, **vitest 60 s / 64 s** |
| Backend image (clean dist, no host residue) | 1,1 min | 1,0 min | build de referencia 22 s / 19 s, imagen 30 s / 28 s |
| Frontend (tsc + vite build) | 0,6 min | 0,7 min | Install 7–8 s, **vitest 16 s / 20 s**, tsc+vite build 3–4 s |
| Ops checks (shellcheck + tests) | 0,4 min | 0,4 min | tests 16 s |

Detalle del job de e2e, PR / main:

| Paso | PR | main |
|---|---|---|
| Inicializar el contenedor Playwright | 21 s | 24 s |
| Setup Node | 4 s | 8 s |
| `npm ci` | 8 s | 8 s |
| **Tests (incluye `vite build` + `vite preview`)** | **302 s** | **434 s** |

**Instalación y preparación del entorno** [V]:
- Por run hay 4 `npm ci` y 4 `setup-node` con caché npm.
- El frontend se instala dos veces: en el job unit y en el de e2e.
- El backend se instala dos veces: en el job unit y en el de imagen.
- Sumando checkout, setup, install y contenedor de todos los jobs: unos **75 s por run**.

**Builds repetidos** [V]:
- El backend se compila tres veces: `tsc` en el job unit, "Reference build" y dentro de la imagen.
- El frontend se compila dos veces: en el job unit y dentro de `test:e2e`.

**Otros checks:**
- Cloudflare Pages es un check externo; no consume minutos de Actions.
- Claude PR Review: mediana **2,0 min** por PR (máx 5,7), en paralelo, no está en el camino crítico.

## 2. Workflow Session Image (`session-image.yml`) [V]

- Tiene filtro de rutas: `session-image/**`, `dockerManager.ts`, `conversation/**`, `recreate/**`, `recreateAttempt.ts`, `sessionLifecycleLock.ts`, `docker-compose.yml` y el propio workflow.
- No es un check requerido.
- Run 44391773268: **14,5 min**, un job.

| Paso | s |
|---|---|
| Install backend deps + Setup | 15 |
| Build session image | 76 |
| Smoke test (imagen) | 24 |
| tmux client release smoke (#444) | 14 |
| **Conversation hooks smoke test** | **492** |
| **CLI /tmp layer evidence** (carry-over de la recreación) | **97** |
| **Recreation smoke test** | **76** |
| **Recreation audit smoke test** | **74** |

Antes de #678 había una matriz de 3 variantes de CLI con smokes de Composer: ≈ 61 min de job por run. Ya no existe en `d28dad7`.

## 3. Inventario [V]

| | Cantidad |
|---|---|
| Workflows en el repo | 3: `ci.yml` (260 líneas), `claude-review.yml` (175), `session-image.yml` (141) |
| Workflows registrados en GitHub | 5. Además de los 3: Dependabot y **"tmp 519 captures"**, cuyo archivo ya no está en el árbol: obsoleto, se puede deshabilitar |
| Jobs | CI 5 · Session Image 1 · Claude Review 1 |
| Tests unit backend | **3087** en 143 archivos. Vitest suma 132,8 s; el paso dura 64 s |
| Tests unit frontend | **557** en 42 archivos |
| Ops (shell) | checks 48 + st-ops 194, además de retention y backup-nas |
| e2e listados, perfil completo (push a main) | **957** = 233 × 4 proyectos + 25 `mobile-v2-stacked`. En main: 855 passed, 102 skipped (7,1 min) |
| e2e listados, perfil PR | **585** = 233 + 233 + 52 + 52 + 15 |
| Specs e2e | 38 |
| Proyectos Playwright | 5: desktop, mobile, desktop-v2, mobile-v2, mobile-v2-stacked |
| Capturas de referencia | **50** PNG, 1,9 MB, en 5 carpetas de proyecto |
| Fixtures | e2e `fixtures.ts` (303 líneas) + `mockBackend.ts` (1449); `frontend/src/__fixtures__` (2 archivos); `backend/src/conversation/fixtures` (1) |
| Smokes con Docker real (`*.smoke.ts`) | 3 archivos, 3456 líneas; 2 de ellos son de la recreación (2993 líneas) |

## 4. Lo atribuible a captura (`conversation/`), recreación (`recreate/`) y al chat de captura

**Backend unit** [V]:

| Grupo | Archivos | Tests | Tiempo vitest sumado |
|---|---|---|---|
| `src/conversation/**` | 35 | 703 | 54,9 s |
| `src/recreate/**` + `recreateAttempt` + `sessionLifecycleLock` | 17 | 345 | 43,5 s |
| Otros en `src/` de estos temas: `routes.conversationAdmin` (46 tests, 7,4 s), `dockerManager.capturePort` (38), `routes.conversations` (24), `dockerManager.conversation` (10), `dockerManager.recreateGate` (4) | 5 | 122 | 9,1 s |
| **Total atribuible** | **57 / 143** | **1170 / 3087 (38 %)** | **107,5 s / 132,8 s (81 %)** |
| Resto | 86 | 1917 | 25,3 s |

- Los cinco archivos más lentos de toda la suite son de estos temas: `relay` 18 s, `sessionStartScript` 14 s, `engine` 13,5 s, `engine.review` 11,7 s y `engine.round2` 11,1 s.
- Retirarlos bajaría el paso de vitest, hoy de 60–64 s, a unos **15–25 s** [E]: la suite corre en paralelo, así que el ahorro no es lineal.
- Código: 17 759 líneas de fuente y 19 399 de tests en `conversation/` + `recreate/`. Todos los `*.test.ts` del backend suman 59 461 líneas: esos dos directorios son el **33 %** de las líneas de test del backend.

**Session Image** [V]:
- **739 s de 870 s (85 %)** del job son smokes de captura o de recreación: conversation 492 + layer evidence 97 + recreation 76 + audit 74.
- 6 de las 8 rutas del filtro pertenecen a esos módulos. Sin ellos, el workflow quedaría en ≈ 2,2 min (build + smoke de imagen + tmux) [E], y dispararía mucho menos.

**Chat de captura, frontend:**
- Unit [V]: `chatView` 35, `chatView.list-race` 1, `conversationModel` 33, `internalPrompt` 11 y `chatMeta` 8. En total **88 / 557 tests (16 %)**, unos 3,3 s.
- e2e de captura pura [V]: `chat`, `chat-meta`, `chat-active` y `last-conversation`. Son **68 / 957** listados en el perfil completo y **34 / 585** en el de PR.
- `chat-first.spec.ts` (36 en los dos perfiles) prueba la política de aterrizaje v2, que depende en parte de que haya historial capturado. Cuenta como **parcial** [E].
- `diff.test.ts` es de Git y no cuenta.

## 5. Observaciones para Q4 (no son cambios; se ejecutan como PRs aparte)

1. El perfil completo de e2e en main (957 listados, 102 skipped) es la mayor diferencia entre PR y main: +2,2 min. Tras P1 queda un solo perfil.
2. Se pueden reutilizar los builds: tsc del backend ×3 y vite ×2.
3. Ningún workflow tiene `paths-ignore` para documentación: un PR que solo toca docs paga los 5,8 min de CI completos.
4. El workflow "tmp 519 captures" sigue registrado en GitHub: hay que deshabilitarlo.
5. No pude leer la lista de checks requeridos: el token responde 403 en `branches/main/protection`. Los checks visibles en cada PR son los 5 jobs de CI más Cloudflare Pages. Cualquier cambio de nombre lo tiene que hacer @owner en la protección de rama.
6. `ci.yml` corre en `pull_request` y en push **solo a main**. Un push directo a `integration/simplify` no dispara CI; un PR hacia esa rama, sí.
