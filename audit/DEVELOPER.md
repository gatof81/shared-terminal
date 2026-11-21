# Auditoría 2026-11 — @developer (evidencia de código)

Encargo: #628 de @architect, sobre #624/#626 de @owner. Solo investigación: no se cambió código de producto.
Base: `origin/main` @ `d28dad7`. Todas las referencias `archivo:línea` son sobre ese SHA.
«Verificado» = con el comando o la referencia indicada; «estimado» = lectura o conteo manual.
Scripts de los experimentos: `audit/scripts/`. Por ahora hay uno: `ancestors-on-focus.spec.ts`, que mide qué ancestros del campo se desplazan al enfocarlo. Para correrlo hay que copiarlo a `frontend/e2e/`.

Secciones: D1 teclado iPhone (P0) · D2 Shell v1/v2 (P1) · D3 Chat y Project Chat (P2) · D4 código muerto y flags (P3).
Cada sección termina con la tabla «Elemento · Problema · Evidencia · Acción propuesta · Riesgo».

## D1 (P0) — Teclado y scroll de los inputs de Chat y Project Chat en iPhone

Base: `origin/main` @ `d28dad7`. Todas las referencias `archivo:línea` son sobre ese SHA. «Verificado» lleva el comando o la referencia; «hipótesis» es lo que falta medir en el iPhone.

### Resumen

- **Ningún arreglo del teclado se midió en un iPhone.** No hay ni un registro de `?vvdebug=1` en #616, #636 ni #659. Lo verifiqué con `gh api …/issues/{616,636,659}/comments | grep '"vv"'`, que da 0 en los tres. #616 se cerró por un GO (2026-11-17) sin datos del dispositivo. Cada intento (#506, #623, #659, #700) corrigió un **modelo** de iOS que Chromium simula, no una medición.
- **`vvDebug.ts` no mide los chats que se usan hoy.** Toma muestras de `#project-view .tw-timeline` (`frontend/src/vvDebug.ts:83`), un selector del espacio de equipo D1–D3 retirado el 2026-11-18: `grep -rn tw-timeline frontend/src` solo lo encuentra ahí. También muestrea `#chat-thread .chat-scroll` (`:84`), que es el Chat de captura. **No muestrea `.acp-chat-thread`**, ni el chat individual ni Project Chat. Tampoco registra el scroll de los contenedores `overflow:hidden` que hay entre `body` y el campo. Con un registro tomado hoy no se podrían confirmar ni descartar dos de las tres hipótesis principales.
- **La causa raíz no está demostrada.** Hay tres hipótesis concretas (H1–H3, más abajo). Cada una se confirma o se descarta con un solo registro del dispositivo, si antes se agregan los campos que faltan.

### 1. Mapa del layout en el teléfono (v1 y v2)

Cadena desde `html` hasta el `textarea`. Los dos chats ACP usan el mismo `AcpThread` (`frontend/src/acpThread.ts`): el composer y el hilo son idénticos y solo cambia el contenedor.

| Nivel | Elemento | Posición / overflow / alto | Referencia |
|---|---|---|---|
| 0 | meta viewport | `width=device-width, initial-scale=1.0, viewport-fit=cover, interactive-widget=resizes-content`. iOS ignora `interactive-widget`; Android achica el viewport de layout. | `frontend/index.html:12-15` |
| 1 | `html` | `data-kb="open"` cuando `innerHeight − vv.height > 120`. `--app-vh` = `vv.height`; `--app-top` = `clamp(vv.offsetTop, 0, innerHeight − vv.height)`, solo con escala 1. | `frontend/src/main.ts:174-201` |
| 2 | `body` | flex en columna; `height: var(--app-vh, 100dvh)`; padding con `env(safe-area-inset-*)`; `transform: translateY(var(--app-top))`. **Con `data-kb`**: `position: fixed; top/left/right: 0`, sin `padding-bottom`. | `frontend/src/styles/base.css:8-56` |
| 3 | `#app-view` | `flex: 1; overflow: hidden` (columna). | `frontend/src/styles/shell.css:2-7` |
| 4 | `header` | `flex-shrink: 0`. En v1 teléfono es el header de la app con el cajón; en v2 es la barra de sesión. Ver D2. | `shell.css:9-17`, `mobile.css`, `shell-v2.css` |
| 5 | `main` | grid `0 1fr`; `overflow: hidden; position: relative`. | `frontend/src/styles/modal.css:217-223` |
| 6 | `#terminal-area` | flex en columna; `overflow: hidden; position: relative`. | `frontend/src/styles/terminal.css:2-7` |
| 7a | `#chat-view` (chat de un agente) | `position: absolute; inset: 0` (top/left/right/bottom 0); flex en columna. En **v1 teléfono** `bottom: 3.4rem` deja lugar a `#view-nav`, salvo con `.kb-typing` (`bottom: 0`). En v2, `bottom: 0` siempre. | `frontend/src/styles/chat.css:7-19`; `viewnav.css:59-63, 80-87`; `shell-v2.css:136-139` |
| 7b | `#project-view` (Project Chat) | `position: absolute; inset: 0; overflow-y: auto`, que pasa a **`overflow: hidden`** con `:has(> .acp-project)`. Sus hermanos quedan en `visibility: hidden`. **No participa de `kb-typing`**: no lleva `#view-nav`. | `frontend/src/styles/projects.css:261-275`; `acp-chat.css:178-180` |
| 8a | `.acp-chat` | flex en columna, `height: 100%; min-height: 0`. | `acp-chat.css:7-12` |
| 8b | `.pv-page.acp-project` | `height: 100%`, flex en columna. | `acp-chat.css:181-187` |
| 9 | `.acp-thread` | `flex: 1; min-height: auto`, flex en columna. | `acp-chat.css:20-25` |
| 10 | `.acp-thread-wrap` → **`.acp-chat-thread`** | **El único scroller del hilo**: `flex: 1; min-height: 0; overflow-y: auto`. | `acp-chat.css:461-470`; DOM en `acpThread.ts:287-288` |
| 11 | `.acp-chat-composer` → `.acp-chat-field` → **`textarea.acp-chat-input`** | En el flujo, al final de la columna; no es `fixed`/`sticky`. Campo de 15 px, o 16 px con `pointer: coarse` para que iOS no haga zoom. El alto lo pone `fitInput()`, con tope del 30 % de `visualViewport.height` en el teléfono. | `acp-chat.css:653-660, 702-721, 990-994`; `acpThread.ts:877-901` |

**Lo que define este layout (verificado leyendo el CSS):**
- Ningún elemento de la cadena es `sticky`.
- `fixed` aparece solo en `body` (con `data-kb`) y en los toasts y diálogos.
- Hay **cuatro contenedores `overflow: hidden` entre `body` y el campo**: `#app-view`, `main`, `#terminal-area` y `#project-view` (en Project Chat).
- **El único contenedor que el lector puede desplazar es `.acp-chat-thread`.**

**Chat de captura (`chatView.ts`):** la cadena es la misma hasta `#chat-view`. Después siguen `#chat-body` → `#chat-thread` → `.chat-scroll` (`chat.css:191-201, 567-583`). Es de solo lectura y no tiene campo de texto. El buscador de la lista sí es un input de texto y activa `kb-typing`.

**`scrollIntoView` / `focus()` / `scrollTo` alrededor del foco o del envío** (verificado con `grep -n "scrollIntoView\|\.focus(\|scrollTo(\|scrollTop =" frontend/src/acpThread.ts …`):
- No hay ningún `scrollIntoView` en los chats.
- **Foco programático del campo sin `preventScroll`:**
  - `acpThread.ts:254`: «Recuperar el texto no enviado».
  - `acpThread.ts:1171`: tras elegir una mención.
  - `acpThread.ts:1413`: cierre del menú de destinatarios.

  Las tres dejan que el navegador haga el *reveal*.
- **Re-render con el foco:** `acpThread.ts:767` llama a `keepFocus.focus({ preventScroll: true })`.
- **Escrituras de `scrollTop` en el hilo:** `acpThread.ts:303, 341, 770, 772, 842, 862`. Solo tocan `.acp-chat-thread`.
- **Enviar y las menciones no le sacan el foco al campo:** `pointerdown`/`mousedown` con `preventDefault` en `acpThread.ts:274-278`.

### 2. Inventario de mecanismos de teclado, viewport y scroll

| # | Mecanismo (archivo:línea) | Qué compensa | Origen | ¿Sigue haciendo falta? (evidencia) | ¿Duplica o contradice? |
|---|---|---|---|---|---|
| M1 | `--app-vh` = `vv.height` en `body` (`main.ts:176-191`, `base.css:17`) | iOS no achica el layout con el teclado, así que la app se dibujaba detrás del teclado. | #59/#100 (2026-04); comentario actual de #506 | **Sí**, si se mantiene un alto de app controlado por JS. Es la base del modelo actual. | `interactive-widget` (M3) resuelve lo mismo en Android y `100dvh` lo resuelve en iOS sin teclado; en Android, M1 y M3 hacen el mismo trabajo. |
| M2 | `--app-top` = `vv.offsetTop` con clamp a `innerHeight − h`; `translateY` en `body` (`main.ts:183-192`, `base.css:35`) | Safari revela el campo **paneando** el viewport visual: la app quedaba dibujada por encima de la banda visible. | #506 (`5351dd3`) | **No demostrado.** Depende de que iOS panee (`offsetTop > 0`) y de que `innerHeight` **no** se achique. Si `innerHeight` sigue al viewport visual, el clamp lo deja en 0 (H2). | El transform convierte a `body` en bloque contenedor de los `fixed` (diálogos, toasts): efecto lateral buscado (PR #506, «Residual risks»). |
| M3 | `interactive-widget=resizes-content` (`index.html:14`) | Hace que Android achique el layout con el teclado. | #341 (`ce118e5`) | Sí en Android Chrome. **No tiene efecto en iOS** (comentario en `index.html:8-11`). | Duplica M1 en Android: ahí `vv.height == innerHeight`, así que M1 no aporta nada y M2 queda en 0. |
| M4 | `data-kb="open"` si `innerHeight − h > 120` (`main.ts:174, 193-194`) | Saca el `padding-bottom` del indicador de inicio con el teclado abierto. | #506 | Sí, mientras exista el padding de safe area. | Es la condición que también activa M5. Umbral fijo de 120 px. |
| M5 | `html[data-kb] body { position: fixed }` (`base.css:39-55`) | iOS desplazaba **la página** (`scrollY`) para revelar el campo, porque el translate de M2 le daba overflow al documento. | #659 (`2534f27`). Primero se hizo «siempre fijo» y se revirtió a «solo con teclado» por las capturas de Chromium (`0552b43`). | **No demostrado, y con un problema de orden:** `data-kb` se pone recién con el `resize` del viewport visual, **después** del foco. El *reveal* que se quería evitar ocurre al enfocar, cuando `body` todavía está en el flujo (H1). | Existe para compensar M2: el translate crea el overflow que permite el scroll de página. Es un parche sobre otro parche. |
| M6 | `#auth-view` con scroll propio; `max-height: min(80dvh, --app-vh − 1rem)` en diálogos (`modal.css:31-34`); paneles ACP `calc(--app-vh*0.4 / *0.45)` (`acp-chat.css:34, 843`) | Consecuencias de M1 y M5: con `body` fijo no queda scroll de página, y `dvh` no se achica con el teclado de iOS. | #659 (revisión) y #700 | Sí, mientras existan M1 y M5. | Derivados de M1 y M5: desaparecen si desaparecen ellos. |
| M7 | `kb-typing` (`viewSwitch.ts:200-245`; `viewnav.css:80-87`) | En v1 teléfono, `#view-nav` (55 px) ocupaba lugar con el teclado; al soltar el foco antes del clic, el layout se movía. | #700 (`aba41e4`) | **Solo en v1.** En v2, `#view-nav` está oculto siempre (`shell-v2.css:133-139`). Si se elimina v1, desaparece entero: unas 45 líneas de TS y 9 de CSS (estimado). | Usa `focusin`/`focusout` en vez de `data-kb`, a propósito (comentario en `viewnav.css:71-79`). Es un segundo detector de «teclado abierto». |
| M8 | `fitInput()` con `visualViewport.resize` y `window.resize` (`acpThread.ts:347-348, 877-901`) | Tope del campo en el 30 % del alto visible en el teléfono. | #700 | Sí: el alto del campo tiene que depender del alto visible. | Es un **tercer** listener de viewport, además de `main.ts:199-201` y `vvDebug.ts:152-153`. Se podría expresar en CSS (`max-height: calc(var(--app-vh)*.3)`, o `30dvh` sin M1). |
| M9 | `pointerdown`/`mousedown` con `preventDefault` en Enviar, menciones y «↓» (`acpThread.ts:274-278`) | El toque blureaba el campo, el teclado se cerraba y el botón se corría bajo el dedo. | #700 | **Sí.** Es el patrón estándar de las apps de mensajería: el campo conserva el foco y no hay salto. | No duplica nada. |
| M10 | ResizeObserver del hilo y re-anclado (`acpThread.ts:319-345`); `box`/`pinnedTop` en el listener de scroll (`:289-316`) | Con el teclado o el campo creciendo, el lector que estaba al final sigue al final y el que estaba más arriba conserva su fila. | #700, #710, #717 | **Sí.** Es independiente del mecanismo de viewport: también hace falta con un layout nativo. | `scrollToEnd` guarda `box` para que el primer scroll no se confunda con el del lector (#710/#717). |
| M11 | Campo de 16 px con `pointer: coarse` (`acp-chat.css:990-994`) | iOS hace zoom al enfocar un campo de menos de 16 px. | #674 (`503adb2`), igual que #341 | **Sí.** Es una regla estándar y sin costo. | — |
| M12 | `terminalGeometry` congelada bajo los overlays (`terminalGeometry.ts`; `viewSwitch`) | Abrir o cerrar el teclado en Chat redimensionaba tmux para todos, porque toda la app sigue a `--app-vh`. | #506 | Sí, mientras la app entera siga a `--app-vh`. | Existe por M1: si solo el panel del chat siguiera al teclado, la terminal no se enteraría. |
| M13 | Portapapeles: `focus({preventScroll})`, textarea fijada y `scrollTop` restaurado (`clipboard.ts:12-19, 73-89`) | El *fallback* de copiar movía al lector (#612). | #612 (`f144bb7`) | Sí; no es de teclado. | Su comentario (`clipboard.ts:12`) depende de M2. |
| M14 | Muestreo de `?vvdebug=1` (`vvDebug.ts`) | Diagnóstico. | #636 | **Mal apuntado**: muestrea `.tw-timeline` (retirado) y no el hilo ACP ni los contenedores `overflow:hidden`. | — |
| M15 | `.acp-chat-composer` y menciones compactos en el teléfono; placeholder corto (`acp-chat.css:975-989`; `acpThread.setPlaceholder`) | Con el teclado arriba quedaba muy poco hilo visible (#623, #700). | #623 (reglas retiradas con D1–D3), #700, #711 | Sí: es diseño, no un parche de viewport. | — |

### 3. Historial de intentos

Verificado con `git log -S"--app-top"`, `-S"data-kb"`, `-S"kb-typing"`, `gh pr view` e `gh issue view 616`. @qa tiene la lista de issues; esto es el lado del código.

| Fecha | PR / commit | Qué se probó | Por qué | Qué quedó vivo |
|---|---|---|---|---|
| 2026-04 | #59/#100 | `--app-vh` desde `visualViewport.height` | La terminal quedaba detrás del teclado en iOS. | M1 |
| 2026-07-03 | #341 `ce118e5` | `viewport-fit=cover`, safe areas, 16 px, `dvh` en diálogos, `interactive-widget` | Base móvil y PWA. | M3, M11, safe areas |
| 2026-11-02 | #506 `5351dd3` | `--app-top` (pan) + `translateY`; `data-kb` saca el padding inferior; terminal congelada bajo los overlays | «El composer quedaba muy arriba del teclado.» Modelo: Safari **panea**, `scrollY` queda en 0. El riesgo quedó anotado en el PR: «si `scrollY` deja de ser 0 en el dispositivo hace falta `scrollTo(0,0)`». | M2, M4, M12; `e2e/keyboard.spec.ts` (modela el pan con un `visualViewport` falso y `innerHeight` fijo) |
| 2026-11-12 | #611, #612, #623 | Project Chat (espacio de equipo) conserva el lugar; copiar no mueve; `#project-view` como contenedor de tamaño y compacto por debajo de 560 px | Informe del owner: «se va arriba». **Causa modelada como falta de alto** (el composer ocupaba todo). | #612 (M13). Las reglas de #623 desaparecieron con el retiro de D1–D3 (2026-11-18). |
| 2026-11-13 | #636 `b4e3ff8` | `?vvdebug=1` | Chromium no reproduce iOS: hacían falta datos. | M14. **Nunca se tomó un registro** (ver Resumen). |
| 2026-11-13 | rama `fix/ios-keyboard-pagetop` (`f3b7f3e`, sin PR) | `--app-top` desde `vv.pageTop` (scroll + pan) y escuchar el scroll de página | Hipótesis: iOS revela con `scrollY`. | Estacionada; nunca validada. |
| 2026-11-17 | #659 `2534f27` | `body` fijo con el teclado; scroll propio de auth; diálogos con `--app-vh` | Mismo informe. Hipótesis: el translate de M2 crea overflow e iOS desplaza la página. | M5, M6. #616 se cerró con el GO **sin el registro del dispositivo**. |
| 2026-11-20 | #700 `aba41e4`, #706, #711 | Composer de una fila, `fitInput` con `vv`, `kb-typing`, Enviar no blurea, anclaje del lector | Iteración UX: con poco alto quedaba poco hilo. | M7, M8, M9, M10, M15 |
| 2026-11-20 | #710 `f0d34c3`, #717 `fc0e146` | Un solo comportamiento de scroll (`ChatEndButton`, `firstRowInView`, `pinnedTop`) | Reglas R1–R4 del scroll del lector. | M10 |

**Patrón:** el síntoma «se va arriba» se reportó tres veces (#616 el 2026-11-12, #659 el 2026-11-17 y ahora #624). Las tres veces se atacó con un modelo distinto: falta de alto (#623), scroll de página (#659) y pan (#506). Ninguno se midió.

### 4. Hipótesis de causa raíz, por probabilidad

Los nombres de campo son los de `vvDebug.sample()` (`vvDebug.ts:56-87`). Los marcados con ★ **no existen todavía** (ver punto 6).

**H1 — El *reveal* del foco desplaza la página antes de que `body` quede fijo (orden de eventos).** *Alta.*
- El `position: fixed` de M5 solo se aplica cuando `syncViewportHeight` ve `innerHeight − vv.height > 120`, o sea, con el `resize` del viewport visual que iOS dispara durante o al final de la animación del teclado.
- iOS decide el *reveal* en el `focus`: ahí `body` todavía está en el flujo, y cualquier overflow del documento le permite desplazar la página (`scrollY`).
- Después `body` pasa a `fixed`, el documento deja de tener alto para desplazar y el `scrollY` queda en un estado indefinido, en el que algunas versiones de iOS dejan el viewport visual paneado.
- **Se confirma** si, en orden, aparece `focusin` → `win-scroll` con `sy > 0` **antes** de la primera muestra con `kb: "open"`, o si `sy` o `doc` siguen en un valor > 0 cuando `kb: "open"`.
- **Se descarta** si `sy` y `doc` son 0 en todas las muestras.
- ★ También hace falta registrar `document.scrollingElement.scrollHeight` contra `innerHeight` en el `focusin` (¿había overflow que desplazar?).

**H2 — `innerHeight` sigue al viewport visual, así que el clamp anula `--app-top` y `data-kb` nunca se activa.** *Media-alta.*
- `maxTop = innerHeight − vv.height` (`main.ts:187`). Si en la versión de iOS del owner `innerHeight` se achica con el teclado (pasa en varias versiones y en Chrome iOS), entonces `maxTop ≈ 0`, `--app-top = 0` aunque `vv.offsetTop > 0`, y `data-kb` no se pone porque la diferencia es menor de 120.
- Resultado: la app queda dibujada en y=0 mientras el viewport visual está paneado hacia abajo. **Se ve la interfaz corrida hacia arriba, hasta su borde superior**, que es exactamente el síntoma.
- **Se confirma** con una muestra que tenga `kb: ""`, `ih ≈ vv.h` y `vv.top > 0` mientras el campo tiene el foco.
- **Se descarta** si `ih` se mantiene en el alto completo con el teclado abierto.
- `e2e/keyboard.spec.ts` fija `innerHeight` y solo simula este caso de un modo, así que no lo cubre.

**H3 — El *reveal* desplaza un ancestro `overflow: hidden`.** *Media.*
- Un contenedor `overflow: hidden` sigue siendo un contenedor de scroll: el *reveal* del foco lo puede desplazar, y el lector no puede deshacerlo porque no tiene barra.
- Entre `body` y el campo hay cuatro: `#app-view`, `main`, `#terminal-area` y `#project-view`.
- Si durante la animación alguno tiene un poco de overflow (el alto de `body` ya cambió pero el contenido todavía no se ajustó; `min-height: auto` de `.acp-thread` en `acp-chat.css:22`), iOS lo desplaza y la interfaz queda subida aunque la página no se mueva.
- **Verificado en Chromium que no ocurre** con el teclado simulado achicando la ventana: en 390×844, 500, 400 y 330, para el chat de agente y Project Chat, mobile y mobile-v2, ningún ancestro del campo tiene overflow ni se desplaza al enfocar. Script: `audit/scripts/ancestors-on-focus.spec.ts`, 16/16, `scrollY=0`. **Esto no descarta iOS**, porque ahí el alto cambia después del foco.
- ★ Se confirma registrando `scrollTop` de `#app-view`, `main`, `#terminal-area`, `#project-view`, `#chat-view` y `.acp-chat` en cada muestra: cualquier valor > 0 lo prueba.

**H4 — Doble compensación: pan de iOS más `translateY`.** *Baja.*
- Si iOS hace las dos cosas (pan y scroll de página), M2 compensa solo el pan.
- **Se confirma** si `vv.pageTop ≠ vv.top + sy`, o si `bodyBox[0]` no coincide con `vv.top`. Es la hipótesis de la rama `fix/ios-keyboard-pagetop`.

**Lo que no causa esto** (verificado en el código):
- Ningún `scrollIntoView` del app.
- Los `focus()` programáticos citados en el punto 1 son posteriores a una acción del usuario y no se ejecutan en el primer toque al campo.

### 5. Alternativas limpias: un solo layout de composer + hilo para los dos chats

Las dos vistas comparten `AcpThread`, así que el composer y el hilo ya son un solo componente. Lo que cambia es el mecanismo de viewport de toda la app.

**A — Columna flex con alto del viewport dinámico y un solo scroller, sin seguir al pan.**
- `body`: `position: fixed; inset: 0; height: 100dvh`, siempre fijo y sin transform. El hilo es el único scroller. El composer queda al pie de la columna. Cuando el teclado se abre, iOS panea el viewport visual sobre un documento que no se desplaza.
- **Se elimina:** M2 (translate y `--app-top`), M4/M5 (`data-kb` y el fijo condicional), M6 (los `--app-vh` de diálogos y paneles pasan a `dvh`), parte de M12 (si la app no cambia de alto con el teclado, la terminal no se redimensiona) y M14.
  - Aproximadamente −40 líneas de TS en `main.ts`, −30 de CSS en `base.css`/`modal.css`, y el spec `keyboard.spec.ts` (300 líneas, estimado) reemplazado por uno más chico.
- **Código nuevo:** ~5 líneas de CSS, ningún listener.
- **Riesgo en iOS:** en Safari `100dvh` **no** descuenta el teclado, así que el composer queda debajo del teclado y depende del pan de iOS para verse. Es el comportamiento nativo de Safari con un formulario al pie: iOS panea hasta el campo, pero la parte de arriba del hilo y la barra quedan fuera de la vista mientras se escribe.
- **El fijo siempre activo cambia el render de texto de Chromium** (`0552b43`): todas las capturas de referencia se mueven una vez. Es un costo puntual de baselines, no una regresión.

**B — Alto controlado por el viewport visual, con un solo listener y sin pan.**
- `body` siempre `position: fixed; top: 0; height: var(--vvh)`, con `--vvh = visualViewport.height`.
- En `visualViewport.resize`/`scroll` se fija `--vvh` y, si iOS paneó, **`window.scrollTo(0, 0)`**: el contenido se mantiene en la banda visible sin trasladar `body`.
- **Se elimina:** M2 (`--app-top` y translate), M4/M5 (`data-kb` y el fijo condicional, que pasa a ser siempre fijo), el umbral de 120 px y el clamp por escala/`innerHeight`, M6 (diálogos con `--vvh` o `dvh`) y M14.
- **Código nuevo:** un listener de ~10 líneas, que reemplaza las ~25 de `syncViewportHeight`.
- **Riesgo:** depende de que `scrollTo(0,0)` neutralice el pan en la versión del owner. Es el patrón que documentan varias apps de chat web, pero no está medido acá. Necesita H2 y H4 medidas antes.

**C — Lo que el navegador dé nativo.**
- En Android: `interactive-widget=resizes-content` (ya está), con `100dvh` y **ningún** JS.
- En iOS no existe nada equivalente (Safari no implementa `interactive-widget` ni la VirtualKeyboard API), así que C solo es A con aceptación explícita del pan.

**Recomendación técnica:**
1. Medir primero con el `vvdebug` corregido (punto 6).
2. Si confirma H1 o H3 → **A**: es la que más código elimina y no agrega listeners.
3. Si confirma H2 → **A** también: elimina el clamp que la causa.
4. Si el owner no acepta que el pan oculte la barra mientras escribe → **B**.

En las tres se conservan M9, M10 y M11, que son de UX y no compensan el viewport. M7 cae con v1.

### 6. Lo que falta en `vvDebug.ts`

La rama `preview/kbd-diagnostic` es opcional y queda para cuando @architect la pida. Ningún cambio de lo que sigue se hizo en código de producto.

1. **Muestrear el hilo ACP** en lugar del selector retirado: reemplazar `#project-view .tw-timeline` (`vvDebug.ts:83`) por `#project-view .acp-chat-thread` y agregar `#acp-chat .acp-chat-thread`.
2. **`scrollTop` de los ancestros `overflow: hidden`**: `#app-view`, `main`, `#terminal-area`, `#project-view`, `#chat-view` y `.acp-chat` (H3).
3. **`document.scrollingElement.scrollHeight` e `innerHeight` en `focusin`**, para saber si había overflow que desplazar (H1).
4. **La caja del composer** (`.acp-chat-composer`) y la de la barra superior (`#terminal-toolbar` / `header`), para ver «hasta el extremo superior» en números.
5. **Una muestra en `touchstart`/`pointerdown` sobre el campo**, antes del `focusin`, para tener el estado «antes» del *reveal*.
6. `navigator.userAgent`, una vez al inicio del registro, para saber la versión de iOS y si es Safari o Chrome.

Con esos seis campos, **un** registro del owner (abrir Project Chat, tocar el campo, esperar 2 s, escribir, cerrar el teclado, copiar el registro) decide entre H1–H4 y entre las alternativas A y B.

### Tabla D1

| Elemento | Problema | Evidencia | Acción propuesta | Riesgo |
|---|---|---|---|---|
| `main.ts:155-201` `syncViewportHeight` (`--app-vh`, `--app-top`, `data-kb`) | Modelo de iOS sin medir; el clamp anula el pan si `innerHeight` se achica (H2); tres detectores de teclado | #506, #659; 0 registros de dispositivo | **Reemplazar** (A: eliminar; B: un listener mínimo) después de medir | Alto (todo móvil) |
| `base.css:30-56` `translateY` + fijo condicional | El fijo llega después del *reveal* (H1); parche sobre M2 | #659, `0552b43` | **Eliminar** (A o B: `body` fijo siempre, sin transform) | Medio (baselines de Chromium cambian una vez) |
| `vvDebug.ts:83` `.tw-timeline` | Mide un selector retirado; no mide el hilo ACP ni los ancestros | `grep -rn tw-timeline frontend/src` | **Reemplazar** el muestreo (punto 6) antes de cualquier arreglo; eliminar `vvDebug` cuando D1 quede validado | Bajo |
| `viewSwitch.ts:200-245` + `viewnav.css:80-87` `kb-typing` | Solo existe por `#view-nav` de v1 | `shell-v2.css:133-139` | **Eliminar** con v1 | Bajo |
| `acpThread.ts:347-348` `fitInput` con listeners de viewport | Tercer listener de viewport | #700 | **Reemplazar** por `max-height` en CSS (`30dvh` o `var(--vvh)`) | Bajo |
| `modal.css:31-34`, `acp-chat.css:34, 843` (`--app-vh` en caps) | Derivados de M1 | #659, #700 | **Consolidar** a `dvh` / la variable única | Bajo |
| `terminalGeometry.ts` (congelado bajo overlays) | Existe porque toda la app sigue al teclado | #506 | **Conservar** hasta que A/B demuestre que la terminal no cambia de caja; reevaluar después | Medio (resize de tmux para todos) |
| `acpThread.ts:274-278` Enviar no blurea | — | #700 | **Conservar** | — |
| `acpThread.ts:289-345` anclaje del lector | — | #700/#710/#717; specs `chat-scroll` | **Conservar** | — |
| `acp-chat.css:990-994` 16 px | — | #341/#674 | **Conservar** | — |
| `index.html:14` `interactive-widget` | Sin efecto en iOS; en Android hace lo mismo que M1 | comentario `index.html:8-11` | **Conservar** (es el camino nativo de Android) | Bajo |
| `e2e/keyboard.spec.ts` | Modela un iOS con `innerHeight` fijo; prueba el modelo, no el dispositivo | `keyboard.spec.ts:14-54` | **Reemplazar** con el arreglo (spec más chico para A/B) | Bajo |
| rama `origin/fix/ios-keyboard-pagetop` | Candidato nunca validado | `f3b7f3e` | **Descartar** salvo que el registro confirme H4 | — |


## D2 (P1) — Shell v1 y v2

Base: `/home/developer/wt-audit` @ `d28dad7` (origin/main). Todas las citas son `path:line` sobre ese checkout.
Etiquetas: **[V]** = verificado con el comando indicado; **[E]** = estimado leyendo el código.

Conclusión corta: v2 no es un rediseño, es una **capa de overrides** sobre el markup de v1 (`frontend/src/styles/shell-v2.css:1-7`, `frontend/src/shellV2.ts:2-17`). El propio diseño ya prevé retirar v1 y el flag en el "PR 10" (`docs/design/ui-unificada.md:626`, `:691`, `:713`). Borrar v1 es principalmente borrar el cajón *chrome* móvil, la barra inferior `#view-nav`, el clúster del header como UI visible, el aterrizaje v1 de sesiones tradicionales y toda la maquinaria de selección (`UI_SHELL`, `uiShell`, `?ui=`, `?bar=`), y luego **fusionar** `shell-v2.css` en las hojas dueñas.

---

### 1. Diferencias funcionales v1 vs v2

| Aspecto | v1 desktop | v1 teléfono (≤768 px) | v2 desktop | v2 teléfono | Evidencia |
|---|---|---|---|---|---|
| Header derecho | Clúster de botones (Templates, Invites, My groups, Admin, Notifications, Logout) | Clúster oculto (`.header-right{display:none}`) | Un botón de usuario `#user-menu-btn` que abre un `actionMenu` construido **a partir de los botones ocultos del clúster** | Igual; < 400 px el menú de usuario se oculta y vuelve el `#sidebar-footer` | `frontend/index.html:136-158`; `frontend/src/styles/mobile.css:87-89`; `frontend/src/styles/shell-v2.css:10-32`, `:253-274`; `frontend/src/shellV2.ts:74-106` |
| Píldora *chrome* `#chrome-toggle` ("sesión › tab", abre/cierra barra + tabs) | Oculta (CSS base `display:none`) | **Única indicación de contexto**; la barra de sesión y la tira de tabs están fuera del layout hasta abrirla | Oculta `!important` | Oculta | `frontend/index.html:112-135`; `frontend/src/styles/shell.css:43-83`; `frontend/src/styles/mobile.css:90-96`, `:112-115`; `frontend/src/main.ts:990-1071`; `frontend/src/styles/shell-v2.css:33-35` |
| Barra de sesión `#terminal-toolbar` | Visible, con label "Session:", nombre, badge, view switch, font, observers, ports, búsqueda | Solo dentro del cajón chrome; scroll horizontal (`overflow-x:auto`) | Visible en todas las vistas, sin label, observers/ports al menú ⋯ | **Barra fusionada** con el header (☰ · nombre · tabs de vista · ⋯ · usuario); el elemento se MUEVE al header | `frontend/index.html:221-330`; `frontend/src/styles/mobile.css:119-128`; `frontend/src/styles/shell-v2.css:38-54`, `:198-291`; `frontend/src/shellV2.ts:28-50` |
| Tabs de vista `#view-switch` | Solo texto (`.view-icon{display:none}` fuera de v2) | En el cajón chrome | Icono + label | Solo icono; label solo en la activa (merged < 400 px: ninguna + subrayado) | `frontend/src/styles/shell-v2.css:76-94`, `:160-171`, `:283-291` |
| Barra inferior `#view-nav` (Chat·Terminal·Files·Git) | No (CSS) | **Sí**, visible solo con un overlay; los overlays terminan 3.4 rem antes; lógica `kb-typing` para el teclado blando | No (`display:none !important`) | No | `frontend/index.html:459-482`; `frontend/src/styles/viewnav.css:1-87`; `frontend/src/viewSwitch.ts:192-245`, `:403-411`, `:466-475`; `frontend/src/styles/shell-v2.css:133-140` |
| Botones "‹ Terminal" de cada overlay | No (son `.files-mobile-only`) | Ocultos mientras está `#view-nav` | Ocultos `!important` | Ocultos | `frontend/index.html:374,399,424`; `frontend/src/styles/viewnav.css:64-68`; `frontend/src/styles/shell-v2.css:126-130`; `frontend/src/viewSwitch.ts:186-191`, `:465` |
| Menú ⋯ de sesión `#session-menu-btn` | Solo en sesiones de agente ACP | Ídem | En todas las sesiones (incluye ports/observers del registro `sessionActions`) | Ídem | `frontend/src/sessionCore.ts:1605-1607`; `frontend/src/shellV2.ts:68-72`; `frontend/src/styles/terminal.css:102-117`; `frontend/src/sessionActions.ts:31-32,146-147` |
| Controles de terminal (font, búsqueda, Insert +) | En la barra de sesión; Insert (+) en el header | Insert en el borde derecho del header | Movidos por JS a `#tab-tools` (tira de tabs) | Ídem | `frontend/src/shellV2.ts:52-66`; `frontend/index.html:161,271,311,321,334`; `frontend/src/styles/mobile.css:164-174`; `frontend/src/styles/shell-v2.css:97-123` |
| Fila propia de cabecera del chat ACP `.acp-chat-header` | Oculta (≥769 px) | **Visible** (único lugar del estado del agente sin abrir el cajón) | Oculta | Oculta | `frontend/src/styles/acp-chat.css:1101-1113` |
| `#sidebar-footer` (acciones de cuenta en el cajón lateral) | No | Sí | No | Solo < 400 px | `frontend/src/styles/mobile.css:98-101`; `frontend/src/styles/shell-v2.css:193-196`, `:266-273` |
| Aterrizaje al elegir una sesión tradicional | `running ? terminal : files` | Ídem | Política: última vista elegida → Chat si hay historial → Terminal/Files | Ídem | `frontend/src/viewPolicy.ts:46-72`; `frontend/src/sessionCore.ts:1231-1251`; `frontend/src/viewSwitch.ts:381`; `docs/design/ui-unificada.md:722-726` |
| Coste en `resize` al cambiar de vista (móvil) | 0 | >0 (el cajón cambia la caja del terminal; registrado como "deferredSync") | 0 | 0 | `frontend/e2e/terminal-invariant.spec.ts:25,49,66`; `frontend/e2e/router.spec.ts:87`; CLAUDE.md (UI_SHELL) |
| Página de proyecto con barra fusionada | n/a | n/a | n/a | tabs de vista y ⋯ `visibility:hidden` (quedan en el header) | `frontend/src/styles/shell-v2.css:187-191` |
| Key bar `#key-bar` | Igual en ambos (no hay rama por shell) | | | | `grep -n 'shell' frontend/src/keyBar.ts` → sin ramas [V] |

Variante **`?bar=stacked`** (solo v2 móvil): barra de sesión en una segunda línea bajo el header. No tiene CSS propio ("nothing to add", `frontend/src/styles/shell-v2.css:293-295`); es simplemente **no aplicar** los 14 selectores `data-bar="merged"` y no mover el toolbar (`frontend/src/shellV2.ts:32`). Se conservó como alternativa tras elegir la fusionada en un iPhone (`docs/design/ui-unificada.md:726-728`). Dependen de ella: `frontend/src/uiShell.ts:19-56,90-104`, el proyecto Playwright `mobile-v2-stacked` (`frontend/playwright.config.ts:25-27,118-134`), la opción `bar` del fixture (`frontend/e2e/fixtures.ts:24-25,260,269-276`), dos ramas en `frontend/e2e/shell-v2.spec.ts:34,50` y 10 baselines.

### 2. Inventario exclusivo

#### 2.1 Exclusivo de v1 (se borra)

Markup (`frontend/index.html`):
- `#chrome-toggle` + label + icono: `:112-135` (24 líneas) [V `sed -n`].
- `#view-nav`: `:459-482` (24 líneas) [V].
- Botones `#files-to-terminal-btn`, `#git-to-terminal-btn`, `#chat-to-terminal-btn`: `:374`, `:399`, `:424` (≈3×3 líneas) [E]; en v2 están siempre ocultos.
- `<span>Session:</span>` `:222` (v2 lo oculta, `shell-v2.css:42-44`).
- Clúster `.header-right` `:136-144`: **no se puede borrar tal cual** — el menú de usuario v2 lo usa como fuente de items y hace `.click()` sobre esos botones (`frontend/src/shellV2.ts:80-104`). Consolidar (ver §5).

CSS:
- `frontend/src/styles/viewnav.css` entero: 87 líneas [V `wc -l`].
- `frontend/src/styles/shell.css:43-83` (chrome-toggle, ≈41 líneas) [V `sed -n`].
- `frontend/src/styles/mobile.css`: `:87-96` (`.header-right` oculto, chrome-toggle), `:103-115` (cajón v1, selectores `html:not([data-shell="v2"])`), `:119-128` (barra con scroll lateral; v2 la pisa), `:164-174` (Insert en el header) — ≈45 líneas [E].
- `frontend/src/styles/terminal.css:102-112` (⋯ v1) y `:132-141` (nombre v1 en teléfono) — ≈20 líneas [E]; 3 selectores `html:not([data-shell="v2"])` [V `grep -c`].
- `frontend/src/styles/acp-chat.css:1101-1113` → queda `.acp-chat-header{display:none}` sin media query.
- `frontend/src/styles/projects.css:262` (`body.project-page-on #chrome-toggle`).
- `html:not([data-shell="v2"]) .view-icon{display:none}` `shell-v2.css:92-94`.

TS:
- `frontend/src/main.ts:990-1071`: `chromeDefaultOpen`, `setChromeOpen`, label de `updateChromeToggle`, listeners de la píldora y del click en chip (≈65 de 82 líneas; **conservar** la parte de `actionsBtn.hidden` + `updateKeyBarVisibility()` `:1018-1029`, hoy colgada de `updateChromeToggle`) [E]. Refs `#chrome-toggle` `:130-131`.
- `frontend/src/viewSwitch.ts:186-245` (toTerminalBtns, `#view-nav`, `kb-typing` — ≈60 líneas), `:404-411` (nav en `renderSwitch`), `:462`, `:466-475`, `:482` (clicks del nav y `setChromeOpen`) [E].
- `frontend/src/sessionCore.ts:1395`, `:1405`, `:2144`, `:2229` (`setChromeOpen`), `:1605-1607` (⋯ solo en agentes), `:1231-1251` y `frontend/src/viewPolicy.ts:44,53,63-72` (aterrizaje v1 / `landsByPolicy`).
- Llamadas `setChromeOpen`/`updateChromeToggle`: 26 apariciones en 10 archivos incluidos mocks de tests [V `grep -n 'updateChromeToggle\|setChromeOpen' frontend/src/*.ts | wc -l` sin `-v test` → 26 con tests; los tests afectados: `chatView.test.ts`, `chatView.list-race.test.ts`, `gitView.test.ts`, `filesView.test.ts`, `sessionCore.*-race.test.ts`].

#### 2.2 Exclusivo de v2 (se conserva y pasa a ser la base)

- `#user-menu-btn` (`frontend/index.html:145-158`), `#tab-tools` (`:334`), `.view-icon` SVG (`:238-253`), `#session-menu-btn` en todas las sesiones.
- `frontend/src/shellV2.ts` (107 líneas [V]): sus movimientos de DOM (`#tab-tools`, ⋯ visible) pueden pasar a **markup estático** en `index.html`; solo la colocación responsive de la barra fusionada (`:32-50`) y el handler del menú de usuario necesitan JS.
- `frontend/src/styles/shell-v2.css` (295 líneas, 53 bloques `{`, 5 `@media`) [V `wc -l`, `grep -c '{$'`, `grep -c '@media'`].

#### 2.3 Selectores que colapsan

`grep -c 'data-shell'` por hoja [V]: `shell-v2.css` 55, `terminal.css` 4, `mobile.css` 2, `acp-chat.css` 1, `index.css` 1 (comentario); resto 0. Total 63 líneas con `data-shell`.
- `html[data-shell="v2"]` en `shell-v2.css`: 54 líneas de selector [V `grep -c 'html\[data-shell="v2"\]'`], de ellas 14 también con `[data-bar="merged"]` [V].
- `html:not([data-shell="v2"])`: 6 (mobile.css 2, terminal.css 3, shell-v2.css 1) [V] → se borran con su regla.
- ≈53 reglas pasan de override a regla base; de ellas ≈8 son puros `display:none` de cosas v1 (chrome-toggle, observers/ports, view-nav, to-terminal, sidebar-footer, `.header-right > …`, label "Session:") que **desaparecen** junto con el elemento/regla v1 en vez de migrar [E].
- **Riesgo de cascada**: `html[data-shell="v2"]` aporta especificidad (0,1,1) y `shell-v2.css` se importa casi al final a propósito (`frontend/src/styles/index.css:30-31`). Quitar el prefijo sin fusionar en la regla dueña invierte overrides (p. ej. `#terminal-toolbar` de `mobile.css:119` vs `shell-v2.css:147`). Hay que fusionar regla por regla, no hacer un `sed`.

### 3. Selección del shell (todo se elimina)

| Pieza | Evidencia |
|---|---|
| Backend `UI_SHELL` → `parseUiShell` (24 líneas) + test (19) | `backend/src/uiShell.ts:1-24`; `backend/src/uiShell.test.ts` [V `wc -l`] |
| Campo `uiShell` en `GET /api/auth/status` | `backend/src/routes/auth.ts:26`, `:100-108` |
| Compose | `docker-compose.yml:91` (`UI_SHELL=${UI_SHELL:-}`) |
| `.env.example` | `.env.example:271-277` |
| Frontend: espejo del servidor | `frontend/src/api.ts:51-52`, `:102-105`, `:139`, `:170` |
| Frontend: resolución `?ui=` / localStorage `st.uiShell` / `?bar=` / `st.uiShellBar` / `data-shell` / `data-bar` (117 líneas) + test (56) | `frontend/src/uiShell.ts:1-117`; `frontend/src/uiShell.test.ts` [V] |
| Aplicación en el arranque | `frontend/src/main.ts:69`, `:82`, `:139-151`, `:313-314` |
| Consumidores de `currentShell()` | `frontend/src/viewSwitch.ts:39`, `:381`; `frontend/src/sessionCore.ts:80`, `:1232`, `:1247`, `:1607` |
| Docs | `CLAUDE.md:45` (párrafo UI_SHELL entero); `docs/design/ui-unificada.md:683-691`, `:712-713`, `:726-728`; `docs/MOBILE_KEYBOARD.md:35`, `:45` ("both shells", `?ui=v2`); `docs/design/ui-ux/README.md:4` (mención "base en shell v2") |
| Comentario de CI | `.github/workflows/ci.yml:195-197` (`E2E_PROFILE`) |
| Mock e2e | `frontend/e2e/mockBackend.ts:438-439`, `:965`; fixture `frontend/src/api.projects.test.ts:26` |

Nota de compatibilidad: el contrato de `/auth/status` pierde un campo. El único consumidor conocido es el frontend propio (`frontend/src/api.ts:170` ya lo trata como opcional). Clientes externos (agenthub) no se verificaron.

Nota de despliegue: producción usa v1 (verificado por @architect el 2026-11-21: `GET /api/auth/status` responde `uiShell: "v1"`; coincide con `frontend/playwright.config.ts:13-16`). Borrar v1 cambia la UI de todos los usuarios de golpe y elimina el rollback por variable de entorno (`docs/design/ui-unificada.md:685-689`).

### 4. Tests y baselines que existen por v1 o por haber dos shells

Playwright (`frontend/playwright.config.ts`):
- 5 proyectos `:82-135`: `desktop`, `mobile` (v1), `desktop-v2`, `mobile-v2`, `mobile-v2-stacked`. Con un solo shell quedan 2 (desktop, mobile).
- `E2E_PROFILE`/`PR_PROFILE`, `V2_SPECIFIC`, `STACKED_BAR`, `v2Match`: `:12-28` — existen solo para repartir la matriz de dos shells.
- Fixtures: opción `shell` y `bar` `frontend/e2e/fixtures.ts:21-25`, `:259-260`, `:262-277`; ramas por shell en helpers `:73`, `:78-86` (abrir cajón chrome), `:90-103` (menú de usuario vs footer), `:211-230` (`switchView` vía chrome/`#view-nav`), `:296-297`. La opción `landing: "legacy"` (`:26-33`) existe "so the suite's expectations hold under both shells".
- Ramas/skip por shell en specs [V `grep -n -E '(app\.)?shell (===|!==) "v[12]"|bar (===|!==) "stacked"' frontend/e2e/*.spec.ts frontend/e2e/fixtures.ts`]: 20 apariciones (15 en specs + 5 en fixtures), más un `test.skip` multilínea en `context-bar.spec.ts:75-78`. Por archivo: `acp-chat.spec.ts:69,415`, `agent-landing.spec.ts:36,163`, `chat-first.spec.ts:16`, `keyboard.spec.ts:279`, `terminal-invariant.spec.ts:25,49,66`, `shell-v2.spec.ts:11,34,50`, `router.spec.ts:87`, `context-bar.spec.ts:76,136`, `v1-landing.spec.ts:15`.
- Specs enteros por shell: `v1-landing.spec.ts` (87 líneas, 3 tests, solo v1) → eliminar; `shell-v2.spec.ts` (175, 6 tests) y `chat-first.spec.ts` (226, 9 tests) → conservar sin `skip` [V `wc -l`, `grep -c 'test('`]. `agent-landing.spec.ts:158-163` (bloque "witness" v1) → eliminar.
- Tests que miran elementos v1: `keyboard.spec.ts:155-158` y `:275-…` (`#view-nav`), `acp-chat.spec.ts:822`, `:863` (`#view-nav` oculto), `shell-v2.spec.ts:23-24` (chrome/view-nav ocultos — sobran cuando no existen) — 8 refs a `chrome-toggle|chrome-open|#view-nav|sidebar-footer` en specs [V].
- Screenshots [V `find … -type f | wc -l`]: 10 por proyecto × 5 = 50 archivos. Desaparecen `desktop/` y `mobile/` actuales (20, v1) y `mobile-v2-stacked/` (10); `desktop-v2/`, `mobile-v2/` (20) pasan a ser los de los proyectos únicos (renombrar dir o regenerar).
- Unit (vitest): `frontend/src/uiShell.test.ts` (56), `backend/src/uiShell.test.ts` (19), casos `shell` de `frontend/src/viewPolicy.test.ts` (13 refs, `landsByPolicy` `:91-94`), `sessionCore.auth-race.test.ts:172` (fija v1), `sessionCore.landing-race.test.ts:171` (fija v2), mocks de `setChromeOpen/updateChromeToggle` en 6 tests [V `grep -c`].

### 5. Qué migrar a v2 antes de borrar v1 / bloqueos

1. **Aterrizaje de sesiones tradicionales** (cambio de comportamiento, no solo UI): v1 → Terminal/Files; v2 → última vista / Chat si hay historial (`frontend/src/viewPolicy.ts:53-62`). Requiere decisión explícita del responsable; `v1-landing.spec.ts` documenta el comportamiento que se pierde.
2. **Menú de usuario depende del clúster v1**: `shellV2.ts:80-104` lee y hace `click()` en `#templates-btn…#logout-btn` ocultos. Consolidar: items declarativos con handlers directos, y borrar el clúster y su duplicado del footer (los pares header/sidebar en `frontend/src/main.ts:115-129`, `:365-372`, `:393-425`) — o conservar `#sidebar-footer` para < 400 px (`shell-v2.css:262-274`), que hoy sí usa v2.
3. **`updateChromeToggle` hace trabajo compartido**: oculta Insert (+) y actualiza la key bar (`frontend/src/main.ts:1018-1029`; `frontend/src/keyBar.ts:56`). Extraer antes de borrar.
4. **Contexto "sesión › tab" en teléfono**: en v1 la píldora lo muestra; en v2 el nombre va en la barra fusionada (mín. 7ch) y el tab en la tira visible. No hay feature perdida, pero el nombre largo se trunca (`shell-v2.css:224-231`).
5. **Fila `.acp-chat-header` en teléfono**: v2 la oculta porque la barra lleva la identidad del agente; nada que migrar.
6. **`kb-typing`**: solo sirve a `#view-nav` (`viewnav.css:80-87`); se va con él.
7. **Fusión CSS por especificidad** (§2.3): no es un bloqueo funcional pero es el mayor riesgo de regresión visual; los baselines v2 existentes son la red.
8. **Invariante de terminal**: v2 ya cumple 0 `resize` en móvil (`terminal-invariant.spec.ts:49`); al borrar v1 se simplifica el test.
9. **Bloqueos reales**: ninguno técnico encontrado. Bloqueos de proceso: producción en v1 (rollback por env desaparece), decisión sobre el aterrizaje, y `?bar=stacked` (decidir que se elimina también; el diseño la mantiene "como alternativa").

### 6. Estimación de lo que desaparece

| Elemento | Cantidad | Tipo |
|---|---|---|
| Archivos borrados enteros | `frontend/src/uiShell.ts`, `frontend/src/uiShell.test.ts`, `backend/src/uiShell.ts`, `backend/src/uiShell.test.ts`, `frontend/src/styles/viewnav.css`, `frontend/e2e/v1-landing.spec.ts` = 6 (+ `shellV2.ts` y `shell-v2.css` absorbidos = 8) | [V existencia `ls`] |
| TS frontend (src, sin tests) | ≈117 (uiShell) + ≈65 (main chrome) + ≈80 (viewSwitch nav/kb-typing/chrome) + ≈25 (sessionCore/viewPolicy/api) + ≈60 de `shellV2.ts` que pasa a markup ≈ **330–350 líneas** | [E] |
| TS backend | 24 + 19 + ≈3 en `routes/auth.ts` ≈ **46** | [V wc; auth E] |
| CSS | 87 (viewnav) + ≈41 (shell.css) + ≈45 (mobile.css) + ≈20 (terminal.css) + ≈5 (acp/projects) ≈ **200 líneas v1**; más ≈60–90 líneas de `shell-v2.css` que solo ocultan v1 o se funden en reglas existentes | [V viewnav; resto E] |
| Selectores `data-shell` | 63 líneas → 0 (54 `html[data-shell="v2"]`, 6 `:not(…)`, 14 de ellos con `data-bar`) | [V `grep -c`] |
| Markup `index.html` | ≈60 líneas (chrome-toggle 24, view-nav 24, to-terminal ≈9, label, clúster si se consolida ≈9) | [V rangos; E total] |
| Proyectos Playwright | 5 → 2 | [V config] |
| Ramas por shell en e2e | 20 (+1 skip multilínea) → 0; spec v1 entero (3 tests) + bloque witness en agent-landing | [V grep] |
| Baselines | 50 → 20 (se eliminan 30) | [V find] |
| Unit tests | 2 archivos enteros (75 líneas) + casos de `viewPolicy.test.ts` | [V wc] |
| Docs | `CLAUDE.md:45`, `.env.example:271-277`, `docker-compose.yml:91`, `docs/design/ui-unificada.md` §8.4, `docs/MOBILE_KEYBOARD.md:35,45` | [V grep] |

---

### Tabla final

| Elemento | Problema | Evidencia | Acción propuesta | Riesgo |
|---|---|---|---|---|
| `UI_SHELL` / `backend/src/uiShell.ts` / `uiShell` en `/auth/status` | Flag de transición; el diseño lo retira en PR 10 | `backend/src/uiShell.ts:24`; `backend/src/routes/auth.ts:108`; `docs/design/ui-unificada.md:691` | eliminar | Bajo (campo opcional; consumidores externos no verificados) |
| `frontend/src/uiShell.ts` (`?ui=`, `?bar=`, localStorage, `data-shell`, `data-bar`) | Maquinaria de selección de dos shells y dos barras | `frontend/src/uiShell.ts:1-117`; `frontend/src/main.ts:139-151` | eliminar | Bajo (claves `st.uiShell*` huérfanas en localStorage, inocuas) |
| `#chrome-toggle` + `setChromeOpen`/`updateChromeToggle` | Cajón móvil v1; cuesta `resize` al cambiar de vista | `frontend/index.html:112-135`; `frontend/src/main.ts:990-1071`; `frontend/src/styles/mobile.css:112-115` | eliminar (extraer antes Insert/key bar) | Medio (lógica compartida en `updateChromeToggle`) |
| `#view-nav` + `kb-typing` + `viewnav.css` | Navegación inferior solo v1 | `frontend/index.html:459-482`; `frontend/src/viewSwitch.ts:192-245`; `frontend/src/styles/viewnav.css` | eliminar | Bajo |
| Botones "‹ Terminal" de overlays | Siempre ocultos en v2 | `frontend/index.html:374,399,424`; `frontend/src/styles/shell-v2.css:126-130` | eliminar | Bajo |
| Clúster `.header-right` + `#sidebar-footer` | v2 los usa como fuente oculta del menú de usuario / < 400 px | `frontend/src/shellV2.ts:80-104`; `frontend/src/styles/shell-v2.css:262-274` | consolidar (menú declarativo; footer solo si se mantiene < 400 px) | Medio (roles admin/lead, push) |
| `shellV2.ts` | Mueve DOM en runtime lo que podría ser markup | `frontend/src/shellV2.ts:52-72` | consolidar (markup estático; JS solo barra fusionada y menú) | Medio (refs de módulos a elementos movidos) |
| `shell-v2.css` (53 reglas, 54 selectores prefijados) | Overrides que dependen de especificidad y orden de import | `frontend/src/styles/index.css:30-31`; `frontend/src/styles/shell-v2.css` | consolidar (fundir en hojas dueñas, borrar lo que oculta v1) | **Alto** (regresión visual por cascada) |
| Reglas `html:not([data-shell="v2"])` | CSS solo v1 | `frontend/src/styles/mobile.css:112-113`; `frontend/src/styles/terminal.css:105,109,137` | eliminar | Bajo |
| Aterrizaje v1 (`landsByPolicy`, rama `shell==="v1"`) | Comportamiento distinto para sesiones tradicionales | `frontend/src/viewPolicy.ts:53,70-72`; `frontend/src/sessionCore.ts:1231-1251` | reemplazar por la política v2 (decisión del responsable) | Medio (cambio de UX para usuarios de producción) |
| ⋯ de sesión solo en agentes (v1) | Rama por shell | `frontend/src/sessionCore.ts:1605-1607`; `frontend/src/styles/terminal.css:102-117` | eliminar rama; ⋯ siempre | Bajo |
| `?bar=stacked` / proyecto `mobile-v2-stacked` | Alternativa sin CSS propio que cuesta un proyecto e2e y 10 baselines | `frontend/src/styles/shell-v2.css:293-295`; `frontend/playwright.config.ts:118-134` | eliminar | Bajo |
| Proyectos Playwright v1 + `E2E_PROFILE`/`V2_SPECIFIC` | Matriz doble por dos shells | `frontend/playwright.config.ts:12-28,82-135`; `.github/workflows/ci.yml:195-197` | consolidar (2 proyectos, sin perfil) | Bajo (CI más rápido) |
| Opciones `shell`/`bar`/`landing:"legacy"` del fixture y helpers con ramas | Existen por dos shells | `frontend/e2e/fixtures.ts:21-33,73-103,211-230,259-277` | eliminar / simplificar | Medio (`landing:"legacy"` afecta expectativas de toda la suite) |
| 20 ramas/skip por shell en e2e + `v1-landing.spec.ts` | Cobertura de un shell que desaparece | ver §4 | eliminar ramas v1; borrar spec v1 | Bajo |
| 30 baselines (`desktop/`, `mobile/`, `mobile-v2-stacked/`) | Capturas del shell/barra eliminados | `frontend/e2e/__screenshots__/` (10 c/u) | eliminar; renombrar/regenerar los v2 | Bajo |
| Docs (`CLAUDE.md:45`, `.env.example`, compose, §8.4, MOBILE_KEYBOARD) | Describen dos shells y el flag | ver §3 | reemplazar | Bajo |


## D3 (P2) — Chat y Project Chat

Baseline: `/home/developer/wt-audit` @ `d28dad7` (origin/main). Solo lectura. Las citas son `path:line` sobre ese checkout.
"verificado (cmd)" = comprobado con el comando indicado; "estimado" = conteo o lectura manual.

---

### A. Las X de la página de proyecto

#### A.1 Inventario (verificado: `grep -rn "pv-close\|Cerrar" frontend/src`)

| X | Dónde | Qué hace |
|---|---|---|
| **X de la página** ("Cerrar el proyecto") | `frontend/src/projectsView.ts:311` → `leavePage` (`projectsView.ts:264-268`) | `pushSessionAddress()` (`router.ts:269-274`): hace **pushState** con la ruta de la sesión que hay debajo (`current`), o con `""` si no hay ninguna, y avisa a los `writeListeners` → `sync()` → `readProjectRoute()` da null → `hidePage()` (`projectsView.ts:250-261`): `suspendAcpProject()` (cierra el socket/poll del hilo, conserva estado), quita `body.project-page-on`, vacía `#project-view`, `setTitlePage(null)`. Back vuelve a la página (es una entrada nueva, `depth()+1`). No escribe ruta de proyecto, no toca la sesión de abajo (que nunca se desmontó: el terminal no se redimensiona). |
| X de la lista de agentes | `frontend/src/acpProjectChat.ts:175-178`, handler `closeList` `acpProjectChat.ts:198-202` | Estado local (`listOpen=false`), foco vuelve al botón del grupo. Sin historial ni ruta. Escape hace lo mismo (`acpProjectChat.ts:192-197`). |
| X de "Administrar agentes" | `frontend/src/acpProjectChat.ts:218-221`, `closeAgentsPanel` `acpProjectChat.ts:237-241` | Estado local (`panelOpen=false`), foco al ⋯ que lo abrió o al título. Escape igual (`acpProjectChat.ts:230-235`). Cubierto por e2e (`frontend/e2e/acp-chat.spec.ts:528-546`). |

Las tres comparten la clase `pv-close` (estilo en `frontend/src/styles/projects.css:316,381-397,609`); las dos de los paneles además `acp-agents-panel-close` (cabecera sticky `frontend/src/styles/acp-chat.css:381-392`).

#### A.2 Desktop vs teléfono, shell v1 vs v2

- La cabecera `.pv-header` (título · grupo de agentes · ⋯ · ×) es **la misma en los cuatro casos**: la construye `header()` (`projectsView.ts:270-319`) y `acpProjectPage` le antepone el grupo (`acpProjectChat.ts:113`). Ningún CSS la oculta en v2 (verificado: `grep -rn "pv-header\|pv-close" frontend/src/styles` → solo `projects.css` y `acp-chat.css:188,292,295,1085`, ninguno por `data-shell`).
- **v2**: sobre la página se ocultan `#view-switch` y `#session-menu-btn` (`frontend/src/styles/shell-v2.css:180-191`, `visibility:hidden`). La barra de sesión (`#terminal-toolbar`) sigue visible con el nombre de la sesión de abajo; en teléfono v2 está fusionada en el header.
- **v1**: `#chrome-toggle` y `#actions-btn` se ocultan (`projects.css:261-265`); en teléfono v1 la barra de sesión vive en el chrome drawer, que queda inalcanzable sobre la página.
- La premisa "en un teléfono v2 el ⋯ tiene una entrada 'Cerrar'" **no se cumple en este baseline**. Esa entrada la agrega #715 (`feat/project-chat-bar`: en un teléfono v2 la barra de sesión hace de cabecera de Project Chat y su ⋯ trae «Cerrar»), que está congelado y no forma parte de `d28dad7`. Si #715 entrara, quitar la X de la página dejaría esa entrada del ⋯ como única salida explícita en el teléfono v2. En este baseline: el ⋯ de sesión está oculto sobre la página (`shell-v2.css:187-188`) y no existe ninguna entrada "Cerrar" fuera de las tres X (verificado: `grep -rn "Cerrar" frontend/src --include=*.ts` → solo `projectsView.ts:311`, `acpProjectChat.ts:177-178,220-221`). `shellV2.ts` no referencia proyectos (verificado: `grep -n project frontend/src/shellV2.ts` → vacío).

#### A.3 Qué otra cosa da la misma navegación (si se quita la X de la página)

1. **Clic en una fila de sesión del sidebar** o **en la barra de sesión**: listener en captura sobre `#session-list` y `#terminal-toolbar` que llama al mismo `leavePage()` (`projectsView.ts:458-471`; excluye `.session-actions`). Mismo push, misma semántica de Back. En la barra v2 visible = nombre/estado de la sesión de abajo.
2. **Back** (o gesto atrás del teléfono): la página se abrió con `navigateProject` → `pushState` (`router.ts:252-262`), así que Back vuelve a la entrada anterior (sesión/vista) y `popstate` → `sync()` oculta la página (`projectsView.ts:452`).
3. **Links dentro de la página**: "Abrir su chat (@agente)" en la lista (`acpProjectChat.ts:286-293`) y links a rutas de la app en mensajes (`router.ts:145-162`) cambian el hash → `hashchange` → `sync()`.
4. **Otro proyecto** desde el sidebar (`sessionCore.ts:901-916`) o el subtítulo de la barra (`sessionCore.ts:1646-1656`): reemplaza la página por otra, no la cierra.
5. Archivar sigue necesitando `leavePage()` (`projectsView.ts:361`).

Huecos sin la X (verificado por lectura; no ejecutado en navegador):
- **Deep link directo** (`#/projects/<pid>` en pestaña nueva / recarga): no hay sesión abajo (`applyRoute(null)` no hace nada, `sessionCore.ts:1473-1474`; `startProjects` después, `main.ts:384-388`) y Back sale de la app. La única salida in-app es el sidebar (en teléfono: ☰ `#sidebar-toggle`, `index.html:72`, que no se oculta sobre la página). Con la X se llega a un workbench vacío; sin ella hay que elegir una sesión. Aceptable, pero es el único cambio de comportamiento real.
- **Teléfono v1**: la barra de sesión está en el drawer y `#chrome-toggle` oculto → solo sidebar o Back.
- Escritorio: sin atajo de teclado para salir (no hay Escape para la página; ni antes ni después).

#### A.4 Qué se simplifica / qué preservar

Se puede quitar: `projectsView.ts:311-312` (crear/append de la X) y el comentario "y ×" (`projectsView.ts:280-282`). `leavePage`, `pushSessionAddress` y su test (`frontend/src/router.test.ts:233-241`) **se quedan** (los usan el listener de captura y el archivado). El CSS `.pv-close` **no** se puede borrar: lo usan las X de los paneles; como mucho renombrarlo a `acp-agents-panel-close` y mover las reglas a `acp-chat.css`. El presupuesto de ancho a 320 px ("title, group, ⋯ and × share 288 px", `acp-chat.css:290`) gana ~44 px.

Preservar: (a) salir sobre la página = **push** (Back vuelve a la página); (b) nunca `display:none` ni resize del terminal (invariante); (c) el foco que estaba en el terminal no vuelve a él (`projectsView.ts:229-235`); (d) `suspendAcpProject` conserva borrador/scroll para volver rápido.

e2e: ninguna spec hace clic en la X de la página (verificado: `grep -rn "pv-close\|Cerrar" frontend/e2e` → 0). Mencionan "×" solo en nombres/comentarios de tests que miden la altura de la cabecera (`frontend/e2e/acp-chat.spec.ts:454,616`): seguirían pasando (hay más sitio), pero conviene renombrarlos. No hay baselines de screenshot de la página de proyecto (verificado: `ls frontend/e2e/__screenshots__/*/visual.spec.ts/`). No hay `projectsView.test.ts`.

Hallazgo lateral (CSS muerto): 26 clases `pv-*` de las vistas de proyecto retiradas no aparecen en ningún `.ts`/`index.html`/e2e (verificado: bucle `grep -o "\.pv-[a-z-]*"` sobre `projects.css`+`acp-chat.css` y `grep -rln` en `src index.html e2e`), p. ej. `pv-section`, `pv-summary`, `pv-dialog`, `pv-session-row`, `pv-back`, `pv-primary`, `pv-icon` (este último comparte regla con `.pv-close`, `projects.css:380-385,608-613`).

---

### B. Duplicación entre chats

Responsabilidades (no se mezclan): **capture Chat** (`chatView.ts`, 2029 líneas) = historial de solo lectura de eventos de hooks, ventana L8 por `seq`, socket `/ws/conversation` con replay/resync, inglés. **ACP** (`acpThread.ts` 1733, usado por `acpChat.ts` 455 = chat individual y `acpProjectChat.ts` 444 = Project Chat) = mensajería persona↔agente con composer, preguntas, socket `/ws/acp` sin replay, español. (líneas verificado: `wc -l`.)

#### B.1 Ya compartido

- `AcpThread` sirve a los dos chats ACP: hilo, composer, borradores por chat, estados vacío/carga/error, "Cargar anteriores", socket (`acpProjectChat.ts:27`, `acpChat.ts:90`).
- `chatScroll.ts`: `END_SLACK`, `ChatEndButton` (botón "ir al final" + hysteresis + salto suave) y `firstRowInView` (búsqueda binaria), usados por `acpThread.ts:48,111-121,832` y `chatView.ts:61,531-535,1617-1631`.
- Markdown: `chatMarkdown.markdownBlock` en ambos (`acpThread.ts:47,1724-1728`; `chatView.ts:45`).
- CSS del botón final: `.chat-float.chat-end` solo en `chat.css:592-678`, `acp-chat.css:943` lo reutiliza.
- Estado de agente: `acpModel.agentStatus` en `acpChat.ts:235` y `acpProjectChat.ts:261`; `sidebarAgentStatus` en sessionCore.

#### B.2 Todavía duplicado

1. **Bookkeeping de scroll "¿está al final?"** — dos implementaciones del mismo patrón (scroll handler que ignora cajas de alto 0, que trata `endBtn.jumping` como "al final", que limpia la cuenta al llegar, + ResizeObserver que re-fija el final):
   - ACP: `acpThread.ts:289-325` (scroll) y `acpThread.ts:328-347` (ResizeObserver), más la heurística `pinnedTop` (`acpThread.ts:714-724`).
   - Capture: `chatView.ts:1590-1615` (`onScroll`) y `chatView.ts:1488-1494` (ResizeObserver).
   ~60 vs ~35 líneas (estimado). La ACP es más robusta (detecta cambio de `clientHeight` sin scroll, `pinnedTop`); la capture no. Candidato a un helper en `chatScroll.ts` (`ScrollFollower`: `atBottom`, `box`, `onResize`, `onScroll`) parametrizado por callbacks.
2. **Ancla de lectura** — misma idea (primera fila visible + offset, nunca distancia al final), dos claves distintas:
   - ACP: `noteAnchor/rowInView/putRow/restorePlace` (`acpThread.ts:816-857`), clave string `data-anchor`, mapa global `readingPlaces` (`acpThread.ts:1707-1712`).
   - Capture: `captureAnchor/restoreAnchor` (`chatView.ts:531-573`), clave numérica `data-seq` con semántica L8 (si el ancla cayó de la ventana → final, y "el bloque con el mayor seq ≤ ancla").
   Solo el `putRow` "mover scrollTop para que la fila quede a su offset" es genérico; la búsqueda por seq de la capture **no** debe unificarse con la ACP.
3. **DOM con clave + firma** — `items: Map<key,{sig,el}>` en `acpThread.ts:212,750-764` vs `t.nodes: Map<key,{sig,node}>` en `chatView.ts:1527-1547`. La ACP inserta con `ui.syncChildren` (`acpThread.ts:766`, comentario de por qué: no perder selección de texto, `acpThread.ts:205-211`); la capture hace `scroller.replaceChildren(...nodes)` en cada render (`chatView.ts:1553`). *needs verification:* el replace en cada evento vivo podría borrar la selección del lector en la capture, el mismo bug que la ACP ya corrigió. Cambio mínimo: usar `syncChildren` en `chatView.ts:1553`.
4. **Estados vacío/error**: capture usa `ui.stateBox` (`chatView.ts:1435-1451,1551`, clases `files-state*`); ACP usa sus propios `acp-chat-empty`/`acp-chat-error` (`acpThread.ts:213-214,737-743`; CSS `acp-chat.css:470-477`). Idiomas distintos; consolidación posible pero de bajo valor.
5. **Lectura de la lista de agentes + `setAcpAgents`** en tres sitios: `acpChat.ts:113-123` (`loadAgents`), `acpProjectChat.ts:80-90` (`refreshAcpAgents`), `acpThread.ts:660-687` (`refreshAgentsSoon`). Mismo `acpReadTicket()` → `acpListAgents()` → `setAcpAgents`. Consolidable en `acpRegistry` (una función `readAcpAgents()`).
6. **Nombres de proyecto**: `acpChat.ts:125-129` hace su propio `fetchProjects()` y guarda `projectNames`, mientras `projectDirectory.projects()` ya tiene la lista que mantiene `projectsView` (poll 60 s). Lectura D1 extra por apertura de chat de agente; reemplazable por `projectDirectory`.
7. **Link a Project Chat**: `acpChat.ts:443-455` (hash a mano `#/projects/${encodeURIComponent(pid)}`, chequeo de modificadores sin `shiftKey/altKey`) vs `sessionCore.ts:1646-1656` (usa `projectRouteHash`, chequea los cuatro modificadores). Mismo elemento, dos versiones divergentes; además en v2 y desktop la cabecera de acpChat está oculta (`acp-chat.css:1105-1113`), así que solo se ve en teléfono v1.
8. **Patrón "panel con × + Escape + devolver foco"** repetido 3 veces: lista y panel de `acpProjectChat.ts:174-202` y `:217-241`, ajustes de `acpChat.ts:71-87`. Un helper `closablePanel(title, onClose)` quitaría ~30 líneas (estimado).
9. **Cabeceras**: tres cabeceras para "quién es este chat": `.chat-thread-head` (`chatView.ts:1364-1430`, `chat.css:511-551`), `.acp-chat-header` (`acpChat.ts:226-349`, oculta salvo teléfono v1) y `.pv-header` (`projectsView.ts:270-319`). Desde #714 la barra de sesión ya es la cabecera del agente (`sessionCore.ts` `paintBarIdentity`), así que `acp-chat-header` es mayormente redundante (solo vive para teléfono v1).

#### B.3 CSS

- Estructura análoga, valores distintos (no son copias literales): hilo `.chat-scroll` (`chat.css:567-578`, `scroll-behavior: smooth`, gap 0.65rem) vs `.acp-chat-thread` (`acp-chat.css:461-469`, gap 18px); envoltorio `.chat-scroll-wrap` (`chat.css:614-620`) vs `.acp-thread-wrap` (`acp-chat.css:944-954`, + `min-height:6rem; contain:size`); burbujas `.chat-user/.chat-assistant` (`chat.css:713-737`) vs `.acp-bubble/.acp-out/.acp-in` (`acp-chat.css:488-511`); cabecera `.chat-thread-head` vs `.acp-chat-header` (`acp-chat.css:447-452`).
- Columna de lectura `--chat-col` (`tokens.css:81`) solo la aplican los chats ACP (`acp-chat.css:1076-1100`); la capture usa `max-width` propios (`chat.css:723,733`).
- Breakpoints distintos: capture 768px (`chat.css:435,1150`), ACP 640px (`acp-chat.css:290`, etc.).
- **Mal ubicado**: `.chat-readonly-note` (del capture Chat, `chatView.ts:1992-2000`) está definido en `acp-chat.css:1054-1059`, no en `chat.css`. Además su texto es español en una vista inglesa.
- Indentación: `acp-chat.css` con tabs, `chat.css`/`projects.css` con espacios.

#### B.4 Qué NO fusionar

- Modelos: `conversationModel.ts` (eventos por `seq`, tools por `tool_use_id`, subagentes, L8 `EventWindow`) y `acpModel.ts` (mensajes, menciones, scope, estado de agente) son dominios distintos.
- Sockets: `/ws/conversation` (subscribe{after}, replay en orden, resync) vs `acpLive` `/ws/acp` (empuje sin replay, recarga en reconexión). Protocolos y garantías distintos.
- Composer: solo existe en ACP (la capture es historial, no envía nada — invariante de producto).
- Ancla por `seq` con ventana L8 (capture) vs ancla por clave (ACP).
- `chatView` delega en `acpChat` vía `acpOwns` (`chatView.ts:33`): es la frontera correcta; no unificar las vistas.

---

### Tabla

| Elemento | Problema | Evidencia | Acción propuesta | Riesgo |
|---|---|---|---|---|
| X de la página de proyecto | Redundante con fila de sesión / barra / Back; ocupa ~44 px en la fila a 320 px | `projectsView.ts:311`, `projectsView.ts:458-471`, `acp-chat.css:290` | **eliminar** (solo el botón; conservar `leavePage`/`pushSessionAddress`) | Bajo; deep link directo y teléfono v1 quedan con sidebar/Back como única salida |
| `leavePage` / `pushSessionAddress` | Necesarios aun sin X (captura en sidebar/barra, archivar) | `projectsView.ts:264,361,460`; `router.ts:269`; `router.test.ts:233-241` | **conservar** | — |
| X de lista de agentes / Administrar agentes | Estado local, sin historial; cubierta por e2e | `acpProjectChat.ts:175,218`; `acp-chat.spec.ts:528-546` | **conservar** | — |
| Clase `.pv-close` | Compartida con las X de paneles | `acpProjectChat.ts:175,218`; `projects.css:381-397` | **reemplazar** por `acp-agents-panel-close` y mover a `acp-chat.css` | Bajo (visual) |
| Entrada "Cerrar" en ⋯ v2 | No existe en el baseline; el ⋯ está oculto sobre la página | `shell-v2.css:187-188`; grep "Cerrar" | **conservar** (no hay nada que quitar) | — |
| Nombres de tests con "×" | Describen una X que ya no estaría | `acp-chat.spec.ts:454,616` | **reemplazar** (renombrar) | Nulo |
| CSS `pv-*` muerto (26 clases) | Restos de vistas retiradas | bucle grep (A.4) | **eliminar** | Bajo; `.pv-icon` comparte regla con `.pv-close` |
| Seguimiento de scroll (atBottom/resize) | Dos implementaciones; la capture sin la robustez de la ACP | `acpThread.ts:289-347,714-724`; `chatView.ts:1488-1494,1590-1615` | **consolidar** en `chatScroll.ts` | Medio: e2e de scroll (`chat-scroll.spec.ts`) y teclado móvil |
| Ancla de lectura | Mismo concepto, claves distintas | `acpThread.ts:816-857`; `chatView.ts:531-573` | **consolidar** solo `putRow`; **conservar** búsqueda por seq/L8 | Medio |
| Render con clave+firma | Capture usa `replaceChildren` en cada render | `chatView.ts:1553` vs `acpThread.ts:766` | **reemplazar** por `syncChildren` (needs verification: selección de texto) | Bajo |
| Lectura agentes + `setAcpAgents` | 3 copias | `acpChat.ts:113-123`; `acpProjectChat.ts:80-90`; `acpThread.ts:660-687` | **consolidar** en `acpRegistry` | Bajo |
| `projectNames` en acpChat | `fetchProjects` propio, duplica `projectDirectory` | `acpChat.ts:125-129` | **reemplazar** por `projectDirectory.projects()` | Bajo (orden de carga) |
| Link a Project Chat | Dos versiones divergentes (hash a mano, modificadores) | `acpChat.ts:443-455`; `sessionCore.ts:1646-1656` | **consolidar** (helper con `projectRouteHash`) | Bajo |
| Panel con × + Escape + foco | 3 copias del patrón | `acpProjectChat.ts:174-202,217-241`; `acpChat.ts:71-87` | **consolidar** (helper pequeño) | Bajo |
| `.acp-chat-header` | Solo visible en teléfono v1 desde #714 | `acp-chat.css:1105-1113`; `acpChat.ts:226-349` | **conservar** mientras exista v1 móvil; eliminar con v1 | Medio (v1 móvil pierde estado del agente) |
| Estados vacío/error | `stateBox` vs clases ACP propias | `chatView.ts:1435-1451,1551`; `acpThread.ts:213-214,737-743` | **conservar** (bajo valor, idiomas distintos) | — |
| `.chat-readonly-note` | Regla de la capture en `acp-chat.css`; texto ES en vista EN | `acp-chat.css:1054-1059`; `chatView.ts:1992-2000` | **reemplazar** (mover a `chat.css`) | Nulo |
| Modelos / sockets / composer | Dominios distintos | B.4 | **conservar** separados | Alto si se fusionan |


## D4 (P3) — Código muerto, flags y restos históricos

Base: `/home/developer/wt-audit` @ `d28dad7` (= origin/main). Solo lectura: no se tocó ningún archivo salvo este.

**Herramientas** (corridas en copias descartables `/tmp/audit-fe`, `/tmp/audit-be`, tras `npm ci --ignore-scripts`):
- `npx -y knip --reporter compact`: exports sin uso en ningún lado, tests incluidos.
- `npx -y knip --production`: exports sin consumidor fuera de tests.
- `npx -y depcheck --json`.
- Script propio de CSS (`/tmp/audit-scripts/css.py`): junta cada `.clase`/`#id` de los selectores de `frontend/src/styles/*.css` y lo busca como palabra completa en `frontend/src/**/*.ts` sin tests y en `index.html`. Si aparece un prefijo con `${`/`+`, lo marca como "dinámico".
- Script propio de ids (`/tmp/audit-scripts/ids.py`).
- `grep -rnw` y `git log -S` para cada afirmación.

Cada "sin uso" de abajo lo confirmé con grep. Los falsos positivos de las herramientas los descarté a mano (ver §1.4).

---

### 1. Exports, archivos, CSS y rutas sin consumidores (frontend)

#### 1.1 Funciones exportadas con 0 consumidores (verificado: `grep -rnw <símbolo> src e2e index.html | grep -v "export "` = 0)

| Símbolo | Dónde | Origen (`git log -S`) |
|---|---|---|
| `acpAgentOfSession` | `frontend/src/acpChat.ts:109` | #674 (503adb2) |
| `projectHasAcpAgents` | `frontend/src/acpProjectChat.ts:93` | #674 (503adb2) |
| `readConversationEvent` | `frontend/src/api.ts:2081` | #589 (212a4ce), del "v3 workspace" retirado; su docblock (`api.ts:2077-2080`) todavía nombra al v3 workspace |
| `updateEnvVars` | `frontend/src/api.ts:886` | b50ec3a (primer commit). El backend `PATCH /sessions/:id/env` (`backend/src/routes/sessions.ts:1095`) sigue vivo para el Hub. Lo que está muerto es el wrapper del frontend. |
| `isApplyingRoute` | `frontend/src/viewSwitch.ts:69` | (solo la definición) |

#### 1.2 Solo los usan tests (knip `--production`, confirmado con grep)
- `sendConversationMessage` (`api.ts:1904`) + `ComposerSendResult` (`api.ts:1877`): el envío del Composer. Las únicas referencias son mocks `vi.fn()` en `chatView.test.ts:50` y `chatView.list-race.test.ts:41`. Ver §2.
- `fetchConversationEvent` (`api.ts:2064`): en código de producción solo aparece en un comentario (`api.ts:2077`).
- **Verificado (knip --production): 36 exports y 12 tipos** sin consumidor de producción. La mayoría son exports de testeo legítimos (`router.parseRoute`, `markdown.renderInline`, `vvDebug.sample`…), así que no hay que tocarlos.

#### 1.3 Exports innecesarios (los usa solo su propio módulo)
**Verificado (knip): 17 exports + 7 tipos.** Entre ellos hay unos 16 `close*Modal` (`admin.ts`, `newSession.ts`, `ports.ts`, `paste.ts`, `invites.ts`, `myGroups.ts`, `actions.ts`), `composerSendText`, `BG_TEXT`, `WINDOW_MAX_BYTES`, `isUiBar`, `isUiShell` e `isPolicyView`. Es un NIT: se puede quitar el `export` y nada más.

#### 1.4 Archivos y dependencias
- **`frontend/src/__fixtures__/project-artifacts-600.json` y `project-conversation-590.json`** (30.5 KB, verificado con `wc -c`): `grep -rn "artifacts-600\|conversation-590\|__fixtures__"` fuera de la carpeta = 0. Vienen de #589/#603 (D1/D2) y #678 no se los llevó. **Muertos.**
- Falsos positivos de knip/depcheck que descarté:
  - `public/sw.js`: se registra por string en `push.ts:107`.
  - `axe-core`: `e2e/a11y.spec.ts:15` lo carga con `require.resolve`.
  - `pino-pretty`: es el `target` del transport en `backend/src/logger.ts:38`.
  - El import `?raw` de `chatMeta.test.ts:4`.
- **Dependencias: ninguna sin usar** (verificado: depcheck fe = `[]`, be = `[]` salvo los falsos positivos de arriba).

#### 1.5 CSS
**Verificado (css.py):** 708 nombres de selector, 87 sin match literal. Al revisarlos a mano:
- **54 son dinámicos.** Ejemplos: `acp-badge-${…}`, `tone-${…}`, `kind-${…}`, `hl-${…}`, `s-${…}` en git, `files-state-${…}`. Se conservan.
- **4 son internos de xterm** (`xterm-screen`, `xterm-viewport`, `xterm-scrollable-element`, `scrollbar`). Se conservan.
- **Muertos de verdad:**
  - **26 clases `.pv-*`** en `projects.css` (`pv-allowed`, `pv-caps`, `pv-session-row`, `pv-dialog`, `pv-evidence`, `pv-why`…). Las introdujo #559 (40da4df, UI P3a) y su último consumidor TS lo borró #678 (a19dca8), según `git log -S"pv-caps"`. **Estimado: ~36 reglas / ~216 líneas** de las 823 de `projects.css` (pvlines.py; no cuenta reglas dentro de `@media`).
  - `.session-kill` (`sidebar-sessions.css:158-180`): el consumidor TS lo quitó #498 (a0730c2).
  - `.session-agent-link` (`sidebar-sessions.css:357`, `projects.css:193`): el consumidor lo quitó #678.
  - `.btn.danger.solid` (`base.css:138`, y el comentario de `base.css:70`): la clase `solid` nunca se asigna desde TS ni desde HTML.
- `index.html` (verificado con ids.py): 240 ids, 23 que no se referencian desde TS/CSS. 19 son destino de `aria-labelledby`/`for`. Los otros 4 (`app-title`, `observers-modal-hint`, `ports-modal-table`, `ports-modal-cancel`) son inocuos y se conservan.

#### 1.6 Rutas
- `router.ts:117-127` (`parseProjectRoute`) sigue aceptando `/chat`, `/team`, `/new`, `/agents[/<aid>]` y `/threads/<id>` y los lleva a la página del proyecto. Es compatibilidad intencional con bookmarks. Lo testea `router.test.ts:173`. **Conservar**, o quitarlo dentro de unas semanas.
- `CLAUDE.md:180` dice que el workspace v3 viejo "is `/team`". Ese workspace ya no existe: la doc quedó obsoleta.

---

### 2. Restos de lo retirado el 2026-11-18 (#678 a19dca8, y #674 para el input del Composer)

Grep sin resultados (verificado): `st-outbox`, `outbox`, `/ws/project` (`backend/src/wsUpgrade.ts:30-34` solo admite `/ws/sessions/`, `/ws/bootstrap/`, `/ws/conversation/`), "delivery queue", `teamView`, `CONVERSATION_COMPOSER_ENABLED` y `?pilot` (solo sobrevive en un comentario, `vvDebug.ts:8`).

Restos encontrados:
1. **El contrato del Composer en el resumen de conversación.**
   - Frontend: `api.ts:1851-1873` declara `canSendInput`, `composer?{blocked,reason,…}` y `transport?: "background"`, más `ComposerSendResult` y `sendConversationMessage` (`api.ts:1876-1930`). Lo introdujo b3cbdbd.
   - Backend: `conversation/service.ts:162-178` declara los mismos campos. `canSendInput` siempre vale `false` (`service.ts:2224,2250`). `composer` nunca se asigna: `grep "composer:"` en `service.ts` y `routes/conversations.ts` = 0. El frontend nunca lee ninguno de los tres: `grep "\.composer\b\|canSendInput"` fuera de `api.ts` solo devuelve un comentario en `chatView.ts:1385`.
2. **La idempotencia del Composer en el store (backend).**
   - `conversation/store.ts:133-156` (`composerSends` en el índice, `COMPOSER_IDEMPOTENCY_WINDOW`, `trackComposerSend`, que se llama desde `store.ts:1017,1168`).
   - `releasedComposerSend` (`store.ts:632-650`).
   - El snapshot lo persiste igual (`store.ts:721`).
   - El único consumidor de `releasedComposerSend` es `store.test.ts` (verificado con `grep -rn releasedComposerSend`, 14 hits, todos tests). Se mantiene un mapa por conversación que nadie lee.
3. **El render de `composer_send`/background en el historial** (`conversationModel.ts:216-300, 373-386, 587-597, 823`; `chatView.ts:1382-1390`): **conservar.** Los `.events.jsonl` ya persistidos pueden tener esos eventos (`normalize.ts:53`). Es historia y no es código muerto.
4. **Comentarios que nombran archivos o features borrados:**
   - `composerText.ts`, que ya no existe: `conversationTitle.ts:5` (front y back), `attentionRule.ts:6`, `store.ts:142`.
   - `composerCli.ts`: `recreate/adminCli.ts:22`.
   - `auth.ts:487`: `signCliToken` dice "composer CLI", pero hoy lo usa `recreate/adminCli.ts:186`.
   - `chatView.ts:25`: "Sending messages is 3.2: the composer is shown disabled".
   - `switcherModel.ts:379`: "a P3a project".
   - `backup.ts:265,951`: "composer pane records".
5. **CSS `.pv-*` y `.session-agent-link`** (§1.5) y **fixtures D1/D2** (§1.4).
6. **Tablas P3a (backend):**
   - `backup.ts:116-123` sigue volcando `project_agents`, `agent_bindings` y `project_agent_creations`.
   - `db.ts:835, 1030-1095` (migración v19) las crea con sus triggers.
   - **Conservar** hasta la migración de drop que ya está planificada (`CLAUDE.md:176`). No es una omisión.
7. **Fuera del alcance directo:**
   - `session-image/test/mock-anthropic.mjs:18,69`: el escenario `ST_SCENARIO=sha256:<.st-inbox path>` (D2) solo lo ejercita su propio unit test. `grep "ST_SCENARIO=sha256"` en `conversation-smoke.sh`, `cli-tmp-evidence.sh` y `*.smoke.ts` = 0.
   - `docs/design/project-chat/` tiene 8 documentos de diseño retirado.
8. `recreate/engine.ts:124` `CLI_MIN_VERSION`: **no** es la regla retirada (`cliCompat.ts`). Es solo el aviso `cli-below-minimum` (`engine.ts:1533`), documentado en `CONVERSATION.md:733`. Conservar.

---

### 3. Flags y parámetros

| Flag | Dónde se lee | Qué cambia | ¿Los dos valores son reales? | Qué podría irse |
|---|---|---|---|---|
| `UI_SHELL` / `?ui=` / `st.uiShell` | back `uiShell.ts:24`, `routes/auth.ts:107`; front `uiShell.ts:62-108`, `main.ts:143-151` | Shell v1 o v2. Ver nota 1. | Sí: en producción corre v1 y v2 está en desarrollo activo (#714, proyectos e2e `desktop-v2`/`mobile-v2`) | Nada todavía. Cuando v2 pase a ser el default, borrar v1 (gran parte de la cadena landing v1/v2 de §5) |
| `?bar=` / `st.uiShellBar` | `uiShell.ts:19-55, 89-100`; `main.ts:148` | v2 en móvil: `merged` (default) o `stacked` | `stacked` solo se activa con override manual. El owner eligió `merged` (#501) | **Eliminar `stacked`**. Ver nota 2. |
| `?vvdebug` / `st-vvdebug` | `vvDebug.ts` (179 líneas, verificado con wc), `main.ts:202-205` | Muestreo del visual viewport en el teléfono (#616, 2026-11-13) | Opt-in y sin costo cuando está apagado | Conservar mientras siga el trabajo de teclado móvil (D1), después eliminar. Corregir el comentario `?pilot=1` (`vvDebug.ts:8`) |
| `?pilot` | — | Ya no existe. Lo agregó #576 y lo quitó #674 (`git log -S"pilot=1"`) | — | Solo el comentario |
| `PROJECT_CHAT_ENABLED` → `features.projectChat` | back `index.ts:237-239`, `projects/directory.ts:30`; front `api.ts:82`, 19 refs en 7 archivos (verificado con grep) | Rutas `/projects`, sidebar agrupado (`sessionCore.ts:516-518, 990`), wording. Ver nota 3. | En producción está ON (se infiere del uso de Project Chat y de los agentes ACP por @owner; no verificado contra el entorno). La rama OFF solo la ejercitan las e2e por defecto. Ver nota 4. | Si producción no va a volver a OFF: retirar el flag y la rama OFF. Mientras tanto, agregar baselines con los flags ON |
| `ACP_AGENTS_ENABLED` → `features.acpAgents` | back `index.ts:143`, `acp/agents.ts:32`; front `api.ts:77`, 17 refs en 5 archivos (verificado) | `/acp`, `/ws/acp`, campos del form, landing de agente | En producción está ON (inferido, igual que el anterior). El CLAUDE.md todavía dice "experimental" | Igual que el anterior. Ver nota 5. |
| `CONVERSATION_ENABLED` | `index.ts:118, 178, 228` | Captura de hooks | El valor por defecto no cambia nada. Es el kill-switch operativo junto con el CLI de emergencia | Conservar |
| Otras claves de `localStorage` | `main.ts:212,734`, `viewPolicy.ts:32-34,125`, `chatMeta.ts:67`, `sessionCore.ts:809` | Preferencias, no switches | — | Conservar. Ver nota 6. |

Notas:
1. **UI_SHELL.** Usa 55 reglas `html[data-shell="v2"]` en `shell-v2.css` y 8 en otros CSS (verificado con grep). Cambiar de shell en caliente solo funciona de v1 a v2: `initShellV2()` mueve DOM y no tiene inversa (`main.ts:149`).
2. **`?bar=stacked`.** Para eliminarlo hay que quitar:
   - las ramas `data-bar` (15 en `shell-v2.css`, 21 refs en total);
   - el proyecto `mobile-v2-stacked` (`playwright.config.ts:118-132`) con sus baselines en `e2e/__screenshots__/mobile-v2-stacked/`.

   Además, `uiShell.ts:21-32` tiene **dos docblocks seguidos que se contradicen**: el primero dice que `?bar=merged` "stores it".
3. **PROJECT_CHAT_ENABLED, wording.** Con el flag OFF, `sessionNoun` (`switcherModel.ts:385-386`) llama "project" a las sesiones, y `chatView.ts:1893` cambia el texto entre "Agents" y "Subagents".
4. **Las baselines visuales cubren la UI con los flags apagados.** El mock arranca con `projectChat = false` (`e2e/mockBackend.ts:131-132, 464`). `visual.spec.ts` no llama `enableProjects`/`enableAcp` (verificado con grep). Las baselines visuales protegen una UI que producción no muestra.
5. **ACP_AGENTS_ENABLED.** `routes/auth.ts:110-120` arma `features` con dos spreads condicionales: ACP sin proyectos queda en una rama y ACP con proyectos en otra. Se simplifica a un solo objeto.
6. **Claves de `localStorage`.** Los prefijos son inconsistentes: `shared-terminal:`, `st.` y `st-`.

---

### 4. Dependencias sin usar

**Ninguna** (verificado: depcheck en las dos copias; knip marca `axe-core` y `pino-pretty`, que son falsos positivos, ver §1.4). Un NIT: el backend usa `uuid` en 4 archivos sin tests (verificado con `grep -rln 'from "uuid"'`). Se podría reemplazar por `crypto.randomUUID` y quitar `uuid` y `@types/uuid`.

---

### 5. Peores capas en `sessionCore.ts`, `viewSwitch.ts` y `main.ts`

#### 5.1 La "vista de aterrizaje" es una máquina de estados repartida en dos módulos y siete variables
**Estado:**
- `viewSwitch.ts:67-81, 252-264`: `applying`, `pendingRoute`, `forced`, `landingOwner`, `choiceGen`.
- `sessionCore.ts:144`: `filesOnlySessionId`.
- `sessionCore.ts:~1225`: `agentsWaitSpent`.

**Firma de tres valores** (`sessionCore.ts:1246`):

    function decideLanding(sessionId: string, running: boolean): View | null | Promise<View | null> {

`null` significa "el flujo propio de v1". `land()` (`sessionCore.ts:1333-1347`) lo traduce de nuevo a `showFilesOnly()`. Las ramas de shell aparecen en tres lugares: `landsByPolicy(v2 ? "v2" : "v1", agent)`, `landingNow` y `landingFor` (`viewSwitch.ts:376-383`).

**Por qué cuesta seguirlo:** para saber qué vista ve una sesión detenida hay que cruzar cinco cosas:
- `decideLanding`;
- `beginLanding`/`endLanding` (llaves por id);
- la guarda `landingOwner` dentro de `syncSessionViews` (`viewSwitch.ts:446`);
- `choiceGeneration()` comparado después de un `await`;
- el `forced` que fija `setView`.

**Capas** (`git log -S`):
1. `forced` y `filesOnlySessionId`: #442 (b088ac1).
2. `beginLanding` y `decideLanding`: #501 (2ea5700).
3. `choiceGen`: #504 (c47a83a, carreras A–F).
4. `agentsWaitSpent` y `landsByPolicy`: #702 (16d387e, 2026-11-20).

Cada capa parcheó una carrera de la anterior.

#### 5.2 Dos mecanismos independientes para "la sesión arrancó, salir de Files"

    function reattachIfStarted(): void {            // sessionCore.ts:446-454
    	...
    	filesOnlySessionId = null;
    	setActiveSessionId(null);
    	void openSession(id);

`openSession` empieza con `if (activeSessionId === sessionId) return;` (`sessionCore.ts:1290`). Por eso, para reabrir la sesión, primero hay que anular `activeSessionId`, un estado global, durante un tick.

En paralelo, `syncSessionViews` (`viewSwitch.ts:452-456`) aplica el snap-back de `forced` con `landView(landingFor(s.sessionId, true))`. Los dos disparan desde el mismo poll de `refreshSessions` (`sessionCore.ts:430`, y vía `updateToolbar`). El orden entre ellos es implícito. Origen: #442.

#### 5.3 `main.ts` como hub de estado global mutable, con imports circulares
- `main.ts:218-251` declara `export let sessions`, `activeSessionId`, `currentTabs`, `currentActiveTabId`, `sessionsLoadedOnce` y `currentFontSize`, con setters, porque "ESM forbids reassigning imported bindings" (`sessionCore.ts:6-9`).
- **Verificado:** 18 módulos importan `./main.js` y 7 forman un ciclo directo con `main.ts` (loop de grep).
- Síntoma: `handleLogout` hace `sessions = []` sin pasar por el setter y tiene que resetear el flag a mano. El comentario lo admite (`main.ts:663-670`): "Direct `sessions = []` bypasses setSessions(), so reset the loaded-once flag here too … PR #397 review SHOULD-FIX".
- Origen: extracción #312/#337 (f35e5c4).
- Capa de compatibilidad asociada: `main.ts:716-718` reexporta `showToast`/`showCopySuccessToast` ("historical names stay exported", #496 c7d7885). 14 módulos siguen tomando toast desde `main.js` y solo 4 desde `components/toast.js` (verificado con grep).

#### 5.4 Resolución de shell en dos pasadas y solo en una dirección (`main.ts:143-151`)

    const shellOverride = consumeShellQuery();
    function applyResolvedShell(): void {
    	const shell = resolveShell({ stored: shellOverride, server: serverUiShell() });
    	if (shell === currentShell() && document.documentElement.dataset.shell) return;
    	applyShell(shell);
    	applyBar(shell === "v2" ? (readStoredBar() ?? DEFAULT_BAR) : null);
    	if (shell === "v2") initShellV2();
    }

- La primera pasada (antes de `/auth/status`) siempre pinta v1 si no hay override. Con `UI_SHELL=v2` se ve primero v1 y después hay un salto.
- `initShellV2` mueve DOM y no tiene inversa, así que el rollback v2→v1 necesita un reload. Hoy eso pasa siempre, porque el servidor solo se lee al boot.
- El shell después se consulta otra vez en `sessionCore.ts:1232, 1247, 1607` y `viewSwitch.ts:381`, en lugar de un valor resuelto una sola vez.
- Origen: 21cb192 (preview de shell v2).

(Lo de `syncViewportHeight`, `main.ts:152-200`, también es un workaround, pero está justificado por iOS y documentado. Conservar.)

---

### 6. Deuda fuera de alcance (una línea cada una)

- Archivos gigantes (verificado con wc): `api.ts` 2411, `sessionCore.ts` 2264, `newSession.ts` 2064, `chatView.ts` 2029, `acpThread.ts` 1733, `terminal.ts` 1599 líneas.
- `internalPrompt.ts` es una copia byte a byte front/back (verificado con `cmp`). Ningún test exige la igualdad. `conversationTitle.ts` sí la exige (`chatMeta.test.ts:4`, con `?raw`).
- `sessionCore.ts:425` hace `console.debug` con la lista de sesiones en cada poll de producción.
- El drop de las tablas P3a y de `.projects` está pendiente, condicionado al backup en el NAS.
- `docs/design/project-chat/` (8 docs) y la mención a `/team` en `CLAUDE.md:180` describen un diseño retirado.
- `ACP_AGENTS_ENABLED` y `PROJECT_CHAT_ENABLED` siguen documentados como "experimental" aunque están en uso en producción.

---

### Tabla resumen

| Elemento | Problema | Evidencia | Acción propuesta | Riesgo |
|---|---|---|---|---|
| `sendConversationMessage`, `ComposerSendResult` (`api.ts:1876-1930`) | Envío del Composer retirado; solo lo usan mocks de test | grep: solo `chatView*.test.ts` | eliminar (junto con los mocks) | Bajo |
| `ConversationSummary.canSendInput/composer/transport` (`api.ts:1851-1873`, `service.ts:162-178`) | Campos que nunca se asignan o que siempre valen false, y que nadie lee | `service.ts:2224,2250`; grep "composer:" = 0 | eliminar (el contrato pasa a la versión siguiente en `CONVERSATION.md`) | Bajo; un cliente externo podría leer `canSendInput` (verificar Agent Hub) |
| `composerSends` / `trackComposerSend` / `releasedComposerSend` (`store.ts:133-156, 632-650, 721`) | Idempotencia del Composer sin lector | grep: solo `store.test.ts` | eliminar; el parser de snapshots tiene que tolerar el campo viejo | Medio-bajo (formato del snapshot) |
| Render de `composer_send`/background (`conversationModel.ts`) | Solo historia | `normalize.ts:53` | conservar | — |
| `readConversationEvent`, `updateEnvVars`, `acpAgentOfSession`, `projectHasAcpAgents`, `isApplyingRoute` | 0 consumidores | `grep -rnw` = 0 (§1.1) | eliminar | Bajo |
| `fetchConversationEvent` | Solo lo usan tests | knip --production + grep | eliminar o conservar si hay plan de "Copy report" | Bajo |
| ~17 exports internos (`close*Modal`, …) | `export` innecesario | knip | quitar el `export` (NIT) | Nulo |
| `__fixtures__/project-*-5{90,600}.json` | Fixtures D1/D2 sin referencia | grep = 0; 30.5 KB verificado | eliminar | Nulo |
| 26 `.pv-*` (`projects.css`) | CSS de la UI P3a borrada en #678 | css.py + `git log -S` | eliminar (~216 líneas, estimado) | Bajo (revisar el screenshot de la página de proyecto) |
| `.session-kill`, `.session-agent-link`, `.btn.danger.solid` | Selectores sin consumidor | css.py + grep | eliminar | Bajo |
| Rutas legacy `/projects/<pid>/{chat,team,new,agents,threads}` (`router.ts:117-127`) | Compatibilidad con bookmarks | `router.test.ts:173` | conservar (revisar en ~1 mes) | — |
| Comentarios sobre `composerText.ts`/`composerCli.ts`/"composer CLI"/"P3a" | Nombran código borrado | §2.4 | reemplazar el texto | Nulo |
| `CLAUDE.md:180` "/team" | Doc obsoleta | grep | reemplazar | Nulo |
| Tablas P3a en `backup.ts:116-123`, `db.ts` v19 | Retiradas pero todavía se vuelcan | `CLAUDE.md:176` | conservar hasta la migración de drop | — |
| `ST_SCENARIO=sha256` (`mock-anthropic.mjs`) | Escenario D2 que solo usa su propio test | grep en smokes = 0 | eliminar | Bajo |
| `?bar=stacked` + proyecto `mobile-v2-stacked` + baselines | Variante descartada por el owner | `uiShell.ts:27-35`, `playwright.config.ts:118-132` | eliminar (después de confirmarlo con el owner) | Bajo |
| Docblock duplicado y contradictorio (`uiShell.ts:21-32`) | Doc incorrecta | lectura | consolidar | Nulo |
| `?vvdebug` (`vvDebug.ts`) | Diagnóstico temporal (#616) | 179 líneas, verificado | conservar mientras siga D1; después eliminar | Bajo |
| Comentario `?pilot=1` (`vvDebug.ts:8`) | El flag ya no existe | `git log -S"pilot=1"` | reemplazar | Nulo |
| `UI_SHELL` v1/v2 | Doble shell | 63 reglas CSS v2, ramas en sessionCore/viewSwitch | conservar hasta decidir que v2 sea el default; después consolidar | Alto si se adelanta |
| `PROJECT_CHAT_ENABLED` / `ACP_AGENTS_ENABLED` | Ramas OFF que producción no usa; las baselines e2e corren con OFF | `mockBackend.ts:131-132,464`; `visual.spec.ts` sin `enable*` | primero: baselines con ON. Después: retirar los flags (consolidar) | Medio (CI y baselines) |
| `features` en `/auth/status` (`routes/auth.ts:110-120`) | Dos spreads anidados | lectura | consolidar en un solo objeto | Bajo |
| Landing (`decideLanding` + 7 variables, §5.1) | Máquina de estados implícita de 4 capas | #442, #501, #504, #702 | reemplazar por un solo módulo de landing con estado explícito | Alto (carreras ya conocidas; tests landing-race) |
| `reattachIfStarted` + snap-back `forced` (§5.2) | Dos mecanismos; anula `activeSessionId` para forzar una reapertura | `sessionCore.ts:446-454, 1290`; `viewSwitch.ts:452-456` | consolidar | Medio |
| Estado global en `main.ts` + 7 ciclos (§5.3) | Setters a mano, reset manual de flags | `main.ts:218-251, 663-670`; grep de ciclos | reemplazar por un módulo de estado (store) sin ciclo | Medio |
| Reexport de toast en `main.ts:716-718` | Capa histórica | 14 importadores vía `main.js` | consolidar (importar `components/toast.js`) | Nulo |
| Shell en dos pasadas y sin inversa (§5.4) | Flash v1→v2 y consultas repetidas | `main.ts:143-151` | conservar hasta resolver UI_SHELL | Bajo |
| `uuid` (backend) | Reemplazable por la API nativa | 4 archivos | reemplazar (NIT) | Bajo |
| Dependencias npm | — | depcheck/knip | conservar todas | — |

