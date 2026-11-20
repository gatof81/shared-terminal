# Investigación #2 — N14 (`@skills-dir`): por qué no hay evidencia de rechazo (análisis estático)

**Alcance:** investigación estática e independiente del binario `claude.exe` 2.1.314 y del kit
auditado `8eafe1a` (solo lectura), más análisis de los hechos reportados de las corridas 1 y 2. **No**
se ejecutó el CLI, **no** se corrió PASS-B1, **no** se tocó Docker/VM100 ni los contenedores
retenidos. El kit `8eafe1a` **no se modifica** y las corridas cerradas **no se reinterpretan**.
Hecha durante la ventana del canario #521 → sólo inspección estática + tests unitarios puros.

## 1. Mecanismo real de `@skills-dir` (del binario 2.1.314)

- `@skills-dir` es un **tipo de fuente de plugin** (`source: "skills-dir"`), auto-cargado desde
  `.claude/skills/*`. El binario lo trata como categoría propia: *"Skills-directory plugins
  (.claude/skills/*)"*, *"plugins auto-loaded from .claude/skills/*"*. El N14 del kit planta un
  `rogue_plugin` (con `hooks/register.mjs`) bajo `~/.claude/skills/st-b1-rogue-n14` — exactamente esa
  categoría.
- **Interacción con `strictKnownMarketplaces`:** el skills-dir se gobierna como una fuente de
  marketplace. El gate (función `Wie`) devuelve "no permitido" cuando `source:"skills-dir"` no está
  en la lista conocida. El mensaje de rechazo (builder `yvn`) es, textual:
  > `Plugins from <path>/ are blocked by your organization's managed settings (strictKnownMarketplaces or blockedMarketplaces). Ask your administrator to add {"source":"skills-dir"} to strictKnownMarketplaces, or remove it from blockedMarketplaces`
  Es decir: **el mecanismo existe, la política SÍ cubre skills-dir y la frase exacta de rechazo
  existe en el binario.** (`Plugins from organization-provisioned marketplaces and the organization
  plugins directory are unaffected` confirma que sólo las fuentes no-organizacionales se bloquean.)

## 2. El hallazgo central: **canal de reporte** del rechazo

Los dos sitios de llamada de `yvn` enrutan el rechazo a canales que **el kit no captura**:
1. `if(!Wie()){ await Yt("cli_plugin_init","policy_blocked"), p.push(`${cross} ${yvn(...)}`) }` — un
   evento de **telemetría** (`cli_plugin_init=policy_blocked`) y una línea de **UI** con `✗` empujada
   a la lista de render (pantalla/pane).
2. `return { success:false, message: yvn(...) }` — el resultado de un subcomando `claude plugin`
   (mensaje al usuario).

**Verificado estáticamente:** **ninguna** línea `[DEBUG]` nombra el bloqueo de skills-dir (grep
vacío), y **no** hay línea de descubrimiento de skills-dir en el debug. El rechazo se reporta sólo a
**UI (`✗`)** y a **telemetría** — nunca al `--debug-file`.

El harness del kit (`run-b1.sh::filter_b1a`) persiste **sólo `--debug-file` + `stderr`**; el **pane
es transitorio** (`pane_text()` no se guarda, confirmado en investigación #1) y la telemetría no se
captura. Por lo tanto, **un skills-dir bloqueado no deja evidencia capturada**, mientras que uno
**cargado** sí (`hooks module … loaded`, línea `[DEBUG]`). Esto explica "N14 sin evidencia específica
de rechazo" **sin** que ello signifique que no se bloqueó.

## 3. Observabilidad: qué distingue cada señal (y qué no)

| Caso del responsable | Señal real en 2.1.314 | ¿Capturada por el kit (`debug`+`stderr`)? |
| --- | --- | --- |
| 1. Rechazado por política | UI `✗ yvn(...)` + telemetría `cli_plugin_init=policy_blocked` | **No** (UI/pane y telemetría, no debug) |
| 2. No descubierto / no intentado | (sin señal) | No |
| 3. Cargado por camino alternativo | `hooks module st-b1-rogue-n14@… loaded (…)` `[DEBUG]` | **Sí** (ROGUE_LOADED) |
| 4. Evidencia insuficiente | (sin señal) | No |

**Consecuencia:** con los canales capturados hoy, el kit **sólo distingue el caso 3** (cargado =
FAIL). Los casos 1, 2 y 4 colapsan en el mismo `skills-dir-block-not-logged` INCONCLUSIVE del
analizador — porque no hay señal de descubrimiento ni el rechazo llega al debug. La **ausencia** de
la línea de rechazo **no** prueba "no bloqueado"; prueba sólo que su canal no se captura.

## 4. Veredicto explícito

- **"N14 blocked" NO es DEMOSTRABLE con el kit actual.** No por una falla de seguridad, sino por
  **observabilidad**: el bloqueo se enforce (gate `Wie`, evidenciado en el binario) pero se reporta a
  UI/telemetría, fuera de los canales que el kit persiste. Resultado por corrida: **INCONCLUSIVE por
  observabilidad**, con esta condición explícita — *sólo pasaría a demostrable si se captura el canal
  UI (o la telemetría)*.
- **"N14 loaded" (FAIL) SÍ es demostrable** (línea `[DEBUG]` de carga). La protección contra el
  caso peor (ejecución del impostor) es observable; lo que no es observable es la *confirmación del
  bloqueo*.
- Los hechos de las corridas 1 y 2 (N14 sin línea de rechazo, sin marcador de carga) son
  **consistentes** con "bloqueado pero no capturado" y con "no intentado/insuficiente" —
  **indistinguibles** entre sí con la evidencia retenida. No se reinterpreta como blocked.

## 4-bis. Límite del análisis estático y la única subpregunta abierta (2026-11-05)

El gate `Wie` lee `be("policySettings").strictKnownMarketplaces` (y `.blockedMarketplaces`): bloquea
skills-dir cuando `strictKnownMarketplaces` existe y **no** incluye `{"source":"skills-dir"}`, o
cuando está en `blockedMarketplaces`. **Lo que NO se puede determinar con confianza desde el binario
minificado** es qué **fuente** de settings administrados puebla `policySettings`: solo el **drop-in
root** (`/etc/claude-code/managed-settings.d/`) o también el knob `CLAUDE_CODE_MANAGED_SETTINGS_PATH`.
El accesor (`be`) es un nombre reutilizado en varios ámbitos y el ensamblado no es una cadena
greppable; **no se sigue analizando para no inventar certeza.**

Esto importa porque en D3 la allowlist de MCP (`allowManagedMcpServersOnly`) **no** se enforzaba por
el env-knob aunque el guard sí quedaba "seated". Si `strictKnownMarketplaces` se comporta igual, una
prueba local con env-knob **no** reproduciría el bloqueo de N14 (haría falta el drop-in root, fuera
del alcance local); si en cambio se enforce por el env-knob, una prueba local **sí** podría
demostrar el bloqueo y validar el clasificador del observador contra el pane real. **Es la única
subpregunta abierta de #2 y solo se resuelve con una corrida local descartable** (env-knob +
plugin en `~/.claude/skills/` + `strictKnownMarketplaces` sin `source:skills-dir`), que es una
**ejecución real** y requiere **aprobación específica** (no autorizada aún; el observador unificado
también está pendiente de revisión). **No cambia el veredicto de #2:** sigue INCONCLUSIVE por
observabilidad.

## 5. Propuesta mínima de instrumentación (prueba local descartable; NO es cambio al kit)

Dado que el rechazo existe pero sólo en el pane, capturar la **decisión** como enum saneado (sin
texto crudo, igual que el trust-gate de la investigación #1):

- Un detector `classify_skills_dir(text) → 'loaded' | 'blocked' | 'none'` que reconoce la carga del
  impostor (`[DEBUG]`) y la frase `yvn` del bloqueo (pane); prototipo descartable en
  `poc/inv2-skillsdir/` (NO el kit auditado).
- Para hacer el caso 1 observable, el driver tendría que **escanear el pane** durante el arranque y
  registrar `skills_dir: blocked|loaded|none` (enum), sin persistir el texto. Opcionalmente, un
  **control diferencial**: el mismo plugin carga sin política y no con política (con el probe
  probando que la sesión arrancó) — inferencia más débil que la captura directa del `✗`.
- **Resultados locales (tests unitarios puros, sin CLI):** `test_skills_block_detect.py` → **5/5**:
  carga ⇒ `loaded` (gana sobre el texto de bloqueo); la frase `yvn` ⇒ `blocked`; un bloqueo genérico
  de marketplace (sin el consejo `source:skills-dir`) ⇒ `none`; nada ⇒ `none`. El detector **no** se
  ejecutó contra el CLI real (ventana del canario); queda validado a nivel lógico.

## 6. Recomendación: ¿investigación #3 (N17-project) o replantear?

**Patrón transversal (inv #1, #2 y D3):** el obstáculo recurrente no es la seguridad del CLI sino la
**observabilidad del harness**. 2.1.314 reporta las **decisiones de política** (trust, bloqueo de
skills-dir, aprobación/bloqueo de MCP) a la **UI/pane y a telemetría**, mientras el kit captura sólo
`--debug-file` + `stderr`. El debug-file muestra de forma fiable las **CARGAS** (los casos FAIL),
pero **no** los **RECHAZOS** (los casos *blocked*). Por eso los veredictos "blocked" son
sistemáticamente incapturables, y por eso N14 y N17-project quedan INCONCLUSIVE.

**Recomendación:** **tenemos suficiente evidencia para replantear la observabilidad del POC antes de
seguir caso por caso.** Investigar #3 (N17-project) sobre los canales actuales rendiría, con alta
probabilidad, el **mismo INCONCLUSIVE-por-observabilidad** que #2 (y ya lo vimos en D3). El paso de
mayor valor es una **única instrumentación de captura saneada pane→enum** para las tres decisiones
(trust, skills-dir, aprobación MCP), validada primero en un harness **local descartable**; recién
con eso N14 y las rutas de N17 se vuelven demostrables de forma coherente, y una eventual corrida 2
tendría sentido. **No** conviene abrir #3 con el harness actual. (Esto **no** replantea la
arquitectura de Channels; replantea cómo el POC **captura evidencia**.)

**Qué NO cambia:** nada de esto habilita un PASS; el kit `8eafe1a` y las corridas cerradas quedan
intactos; la instrumentación es un prototipo descartable, no una integración.
