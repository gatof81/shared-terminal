# Investigación #1 — fallo de workspace-trust de P0 en la corrida 2 (análisis estático, solo lectura)

**Alcance:** análisis estático y de solo lectura del código auditado `b1.py@8eafe1a` y de los hechos
reportados de la corrida 2. **No** se repitió P0, **no** se accedió a los contenedores retenidos,
**no** se ejecutó Docker/VM100/`measure`/`capture`. El kit `8eafe1a` **no se modifica**.

**Nota de disponibilidad de evidencia.** Esta sesión del asistente **no** tiene los archivos reales
de la corrida 2 (están retenidos en VM100). El análisis se apoya en (a) el **código** de `8eafe1a` y
(b) los **hechos reportados** por el responsable (P0 rc=1 sin confirmar trust, sin cargar hooks;
N14/N17-project con `session.start` + probe org + guard). Importante (confirmado en el código): como
observó el responsable, **`pane_text()` es transitorio** — `one_start()` lo lee en vivo pero **no
persiste snapshots del panel**. No afirmamos tener capturas del pane: no existen.

---

## 1. Hechos demostrados (del código `8eafe1a`)

1. **P0, N14 y N17-project usan EXACTAMENTE el mismo driver** (`b1.py::one_start`): misma lógica de
   trust/theme/mcp, mismas teclas, misma temporización. Por lo tanto **la divergencia no está en el
   código**: es de **runtime** (temporización, orden, teclas perdidas, salida del proceso).
2. **P0 corre PRIMERO** en la corrida 2 (`run-b1.sh::measure_b1a`, `ids="P0 N14 N17-project"`); entre
   intentos hay una espera `pgrep` (≤10 s) que aborta si quedó un `claude` anterior. P0 es, por tanto,
   el **arranque en frío** de la secuencia.
3. **La pantalla de trust tiene como opción por defecto `❯ No, exit`** (verificado también en el
   smoke local de 2.1.314); `Yes, I trust this folder` está una línea abajo. El driver maneja trust
   con las teclas **`("Down", "Enter")`**: `Down` mueve No→Yes y `Enter` confirma. **Si el `Down` se
   pierde o llega antes de que la pantalla sea interactiva, el `Enter` confirma `No, exit` y el CLI
   sale** — con un `rc` escrito y **sin cargar hooks** (coincide con "rc=1 sin confirmar trust, hooks
   no cargados").
4. **El bucle corta apenas aparece `rcf`** (`if os.path.exists(rcf): break` al tope del `while`). Por
   eso, aunque el driver permite **hasta 3 intentos** de trust (`tries[k] >= 3`) con throttle de 2 s,
   **una salida inmediata del CLI (trust declinado) NO deja lugar a reintento**: P0 puede fallar con
   `tries["trust"] == 1`.
5. **El `seed_home` fija `theme=dark`**, así que la pantalla de theme no debería aparecer; una
   interferencia del theme con el `Enter` de trust es **poco probable** (no imposible si el estado
   sembrado difiriera).
6. **Asimetría de observabilidad en el código:** el camino de **MCP** registra `mcp_approval_selection`
   (opción resaltada) y `mcp_approval_dismissed` (running/exit/persistent) — añadidos en C3/D4. El
   camino de **trust NO registra nada equivalente**: sólo `screens["trust"]` (bool), `tries["trust"]`,
   `trust_still_shown` (regex de trust en el panel final), `timed_out` y `rc`. **No hay "qué opción
   estaba resaltada", ni snapshot pre/post del keypress de trust, ni timestamps por evento.** Un fallo
   de trust es, por diseño, **menos diagnosticable** que uno de MCP.
7. **`result.json` no guarda timestamps.** La única fuente temporal para reconstruir la secuencia es
   el `debug-N.log.filtered` (timestamps del propio CLI), que está en la **evidencia retenida en
   VM100**, no en esta sesión.

## 2. Qué distinguen los campos ya registrados (sin repetir P0)

Cada arranque guarda en `starts[0]`: `screens` (por pantalla), `tries`, `trust_still_shown`,
`timed_out`, `rc`, `probe_kinds`, y a nivel intento `startup` (`ok` / `trust-unconfirmed` /
`unknown`). Con sólo **leer** el `result.json` de P0 retenido (read-only, sin nueva corrida) se
separan las hipótesis:

| Firma en `result.json` de P0 | Interpretación |
| --- | --- |
| `screens.trust=True`, `trust_still_shown=False`, `timed_out=False`, `tries.trust` bajo (≈1), `probe_kinds=[]`, `rc=1`, `startup="trust-unconfirmed"` | **H1** — vio trust, la selección no quedó en `Yes` y el proceso salió (p. ej. `Down` perdido ⇒ `Enter` sobre `No, exit`). |
| `screens.trust=False`, `rc=1`, `startup="unknown"` | **H2** — el CLI salió **antes** de renderizar trust (salida/crash temprano). |
| `trust_still_shown=True`, `timed_out=True` (o `rcf` sólo tras C-c) | **H3** — teclas perdidas / pantalla trabada; salió por el C-c del driver. |

El comparativo con **N14/N17-project** (que sí tuvieron `session.start`) confirma que **su** driver de
trust funcionó: `startup="ok"`, `probe_kinds` con `session.start`. La diferencia a explicar es
**por qué el mismo driver falló sólo en el arranque en frío de P0**.

## 3. Hipótesis ordenadas por evidencia

1. **H1 — carrera del keypress en el trust en frío (mejor ajuste).** El `Down` se pierde o llega
   antes de que la pantalla sea interactiva en el **primer** arranque; el `Enter` confirma `No, exit`;
   el CLI sale `rc=1` sin hooks. Es la única hipótesis **totalmente consistente** con "rc=1 sin
   confirmar trust + sin hooks" y con que P0 (primer arranque) falle y los siguientes no.
   **Confirmable** leyendo el `result.json` de P0 (firma H1 arriba). *Lo que NO es verificable ni con
   `result.json`: qué opción estaba resaltada al apretar `Enter`* — no se capturó (ver §1.6/§1.1).
2. **H2 — salida temprana antes del trust.** Refutable/confirmable con `screens.trust`. Menos probable
   dado que el responsable describe el fallo "sin confirmar trust" (implica que la pantalla se alcanzó),
   pero no se puede descartar sin leer el campo.
3. **H3 — teclas trabadas y salida por C-c.** Distinguible por `trust_still_shown`/`timed_out`.
4. **Causa raíz del "por qué sólo P0" (transversal a H1–H3):** temporización de **arranque en frío**
   — el primer `claude` del contenedor tarda más en volverse interactivo que los siguientes, y el
   driver no espera a que la pantalla de trust esté **estable** antes de teclear. Es **plausible** y
   explicaría la asimetría P0 vs N14/N17, pero **sólo demostrable con timestamps** del `debug` retenido
   (CLI) correlacionados con los keypress — y los keypress del driver **no** están timestampeados.

## 4. ¿Los datos permiten causa o sólo hipótesis?

- **Con lo que hay en esta sesión (código + hechos reportados): sólo hipótesis.** El código prueba el
  *mecanismo* (cómo un `Down` perdido causa salida sin trust) pero no *qué pasó* en esa corrida.
- **Con la evidencia retenida en VM100 (solo lectura, sin repetir P0):** el `result.json` de P0
  **probablemente distingue H1/H2/H3** por la tabla de §2. Lo que **ningún** dato retenido puede
  establecer es la **selección exacta** al momento del `Enter` (no hay snapshot ni `trust_selection`),
  así que entre "`Down` perdido" y "CLI que se autocerró con trust en pantalla" podría quedar un
  residuo **INCONCLUSIVE**. No inventamos certeza: si `result.json` no alcanza, la causa queda
  **INCONCLUSIVE**.

## 5. Límites de observabilidad (verificados en el código)

- **Sin snapshots del pane** (confirmado: `pane_text()` transitorio). No se puede ver qué opción
  estaba resaltada ni el estado exacto al teclear.
- **Sin timestamps por evento** en `result.json`; la temporalidad sólo surge del `debug` retenido.
- **El camino de trust no registra selección ni "dismissed"** (a diferencia del de MCP): un fallo de
  trust es intrínsecamente menos diagnosticable.
- **`rc` no desambigua** por sí solo "No, exit" vs. C-c vs. crash.

## 6. Propuesta mínima de instrumentación (para una EVENTUAL prueba local descartable; NO es un cambio al kit)

Reflejar en el camino de trust lo que el de MCP ya hace, y cerrar la carrera de arranque en frío.
Todo esto se **validaría primero en un harness local descartable**, **sin** tocar `8eafe1a`:

1. **`trust_selection` (enum)** leído del puntero (`❯`) justo antes del `Enter` (como
   `classify_selection` para MCP): distingue "resaltado = Yes/No/otro".
2. **`trust_dismissed`** (`running` / `exit` / `persistent`) tras el `Enter`: separa "salió" de
   "sigue en pantalla".
3. **Snapshot acotado pre/post** del keypress de trust (p. ej. ≤ N líneas), persistido, para auditar
   la selección sin repetir la corrida.
4. **Gate de readiness**: esperar a que la pantalla de trust sea **estable en 2 sondeos** antes del
   primer keypress — ataca directamente la hipótesis de arranque en frío (H1/causa raíz).
5. **Timestamps monotónicos por keypress** en `result.json`, para reconstruir la secuencia sin
   depender del `debug`.

## 7. Recomendación (¿vale la pena instrumentar y repetir un control P0?)

- **Paso 0 (barato, sin nueva corrida):** **leer el `result.json` de P0 retenido** (read-only) y
  clasificarlo con la tabla de §2. Si da la firma **H1** (trust visto, no confirmado, salida, sin
  probe), la causa queda acotada a una **carrera del driver de trust**, y entonces **sí** vale la pena
  la instrumentación mínima (sobre todo el **gate de readiness** del punto 4) validada en una prueba
  **local descartable** antes de cualquier repetición en VM100.
- Si `result.json` resulta ambiguo (p. ej. `screens.trust` no concluyente), **declarar INCONCLUSIVE**:
  la instrumentación (§6) pasa a ser **prerequisito** para poder cerrar esto alguna vez, y recién
  después tendría sentido repetir un control P0 acotado.
- **No** repetir P0 ni instrumentar el kit auditado antes de ese Paso 0: evita gastar una corrida en
  reproducir el mismo INCONCLUSIVE.

**Cierre:** el mecanismo del fallo está **demostrado** (un `Down` perdido en el trust en frío ⇒ `Enter`
sobre `No, exit` ⇒ salida sin hooks); **cuál** de H1/H2/H3 ocurrió es **determinable leyendo el
`result.json` retenido** salvo el residuo de "selección exacta", que **no** se capturó y haría falta
instrumentar. Sin ese dato, la causa precisa es **INCONCLUSIVE** y no se afirma certeza.
