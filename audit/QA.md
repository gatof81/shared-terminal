# Auditoría 2026-11 — QA: bugs, reproducción, cobertura y criterios de aceptación

Responsable: @qa. Pedido: @architect #629 (auditoría de @owner #627).
Línea de base: `origin/main` @ `d28dad7`. Todas las referencias `archivo:línea` son sobre ese SHA.
Solo investigación: no se tocó código de producto, ni PRs, ni merges, ni deploys. Los experimentos están en `audit/qa/`.

Convención para las cifras:
- **[V]** verificado, con el comando o la referencia.
- **[E]** estimado.

---

## Q1 (P0) — Teclado del iPhone en los inputs de Chat y Project Chat

### Q1.1 Línea de tiempo (reportes, arreglos y lo que quedó sin resolver)

La parte de «qué código quedó de cada intento» es de @developer; le pasé esta lista en #631.

| Fecha | PR / issue | Superficie | Qué reportaba o qué cambió | Qué pasó después |
|---|---|---|---|---|
| 07-03 | #341 | toda la app | PWA standalone, `viewport-fit=cover`, safe-areas, 16 px contra el auto-zoom, `vh`→`dvh` en modales, `interactive-widget=resizes-content` (solo Android) y el espejo `visualViewport.height → --app-vh` | Es la base. Pidió una pasada en iPhone que no consta. |
| 11-02 | #506 | Chat de captura (composer 3.2) | Agrega `--app-top = visualViewport.offsetTop` + `translateY` en body, `data-kb` (umbral de 120 px) sin safe-area abajo, y `terminalGeometry` congelada bajo los overlays. Hipótesis: «Safari hace pan, `scrollY` queda en 0». | Solo con un `visualViewport` simulado (`keyboard.spec.ts`). Nunca se midió en el dispositivo. |
| 11-12 | issue #616 | ambos | El owner reporta: (1) Copy report mueve la lectura y (2) al tocar el input, la conversación salta arriba. | — |
| 11-12 | #611, #612 | workspace v3 de Project Chat (`.tw`) y Chat | #611: el hilo abría en el más viejo y no seguía al final. #612: copiar con el fallback enfocaba un textarea sin `preventScroll`. | Copy report: **PASS en el iPhone** (comentario de A, 11-13). |
| 11-13 | #623 | workspace v3 (`.tw`) | El owner: «el input de Project Chat lo manda arriba». La causa propuesta era la falta de alto con 300–380 px visibles. Cambio solo de CSS: `#project-view` como size container, menos de 560 px de alto, y `short-height.spec.ts`. | Solo Chromium («Needs a real iPhone: the visual viewport pan itself»). |
| 11-13 | #624 | workspace v3 | Densidad en el teléfono. | — |
| 11-13 | #636 | toda la app | `?vvdebug=1`. Nueva hipótesis, contraria a la de #506: iOS revela el campo **scrolleando la página** (`scrollY`), no con pan. Queda aparcada la rama `fix/ios-keyboard-pagetop` (`pageTop`). | **No hay registro de vvdebug del iPhone** en #616 ni en ningún PR. |
| 11-17 | #659 | toda la app | `html[data-kb="open"] body { position: fixed }`: «iOS no puede scrollear la página». Reemplaza la rama `pageTop`. | #616 **cerrado por GO del owner sin medición en el dispositivo**. El mismo día entran los chats ACP (#672). |
| 11-18 | #678 | — | Se retiran Composer y el workspace D1–D3: se borran `projects.spec.ts`, `thread-scroll.spec.ts` y **`short-height.spec.ts`**, y desaparecen las reglas `@container` de #623 (hoy `grep -rn "@container\|560px" frontend/src/styles` no devuelve nada [V]). | Las protecciones de #611/#623/#624 eran de una UI que ya no existe. |
| 11-20 | #700 | chats ACP | Composer de una fila, `kb-typing` (`viewSwitch.ts:202-240`) que esconde `#view-nav` mientras se escribe en un overlay, Enviar con `preventDefault` en `pointerdown`, y el lector al final sigue al final. | Solo Chromium. |
| 11-20 | #710, #711, #717 | 3 chats | Un solo scroll (R1–R4), el composer como una superficie, y `pinnedTop`. | Solo Chromium. |
| 11-21 | #627 | ambos chats ACP, Safari y Chrome iOS, v1 | «la interfaz se desplaza hacia arriba, en ocasiones hasta el extremo superior». | **Abierto.** |

Conclusiones de la línea de tiempo:

1. **El síntoma sobrevivió a tres implementaciones de chat distintas:**
   - el Chat de captura con composer 3.2 (#506);
   - el workspace v3 de Project Chat (#611/#623);
   - los chats ACP de hoy (#700/#711).

   Lo único común a las tres es la **capa global de viewport**:
   - `frontend/src/main.ts:153-205`;
   - `frontend/src/styles/base.css:8-52`;
   - el `<meta viewport>` de `frontend/index.html:14`.

   Es evidencia de que la causa está en esa capa y no en un componente de chat. Esto es una inferencia, no una prueba.
2. **Cinco cambios del teclado (#341, #506, #623, #659, #700) se basaron en hipótesis contradictorias sobre iOS**, y ninguno tuvo una medición del dispositivo:
   - #506 asume pan del visual viewport;
   - #636 y #659 asumen scroll de la página.

   La herramienta para medirlo (#636) existe desde el 11-13 y no se usó antes de cerrar #616.
3. El cierre de #616 se validó contra una UI (workspace v3) que se retiró al día siguiente.

### Q1.2 Defectos del diagnóstico que hay que conocer antes de medir

### [SHOULD-FIX] `?vvdebug=1` no registra el scroll de ninguno de los dos chats con el bug

**Where:** `frontend/src/vvDebug.ts:81-82`, `frontend/src/vvDebug.ts:173-174`
**What:** Mide `scroller("#project-view .tw-timeline")` y `scroller("#chat-thread .chat-scroll")`, y solo graba eventos `project-scroll`/`chat-scroll` para esas clases:
- `.tw-timeline` es del workspace v3, retirado en #678; hoy no aparece en ningún `.ts` ni `.css` [V].
- `.chat-scroll` es el Chat de captura, que es de solo lectura y no tiene input.

El hilo de los dos chats ACP es `.acp-chat-thread` (`frontend/src/acpThread.ts:78`), y vvdebug no lo mide.
**Why it matters:** El registro que el owner va a copiar no puede mostrar si lo que «sube» es el hilo (scrollTop), la página (scrollY) o el body (transform). Esa es justamente la distinción que separa las hipótesis de Q1.4.
**Fix:** Es tarea de @developer, en una rama de diagnóstico, si @architect lo aprueba. Medir `#chat-view .acp-chat-thread` y `#project-view .acp-chat-thread` y grabar sus eventos `scroll`. Agregar `document.documentElement.dataset.shell` a cada muestra, porque hoy el registro tampoco dice en qué shell se tomó.

### [NIT] `docs/MOBILE_KEYBOARD.md` describe un modelo que el código ya no sigue

**Where:** `docs/MOBILE_KEYBOARD.md:13`, `:51`, `:59`
**What:** El documento quedó atrás en tres puntos:
- dice «Safari pans the visual viewport instead of scrolling the page», pero #659 se basó en la hipótesis contraria;
- espera «the re-anchor PR», que ya entró con #700/#710;
- dice «v1 keeps its bottom view bar above the keyboard», pero desde #700 `kb-typing` la oculta (`frontend/src/styles/viewnav.css:81-84`).

**Why it matters:** Es el único protocolo para iPhone que tiene el repo, y seguirlo hoy da expectativas equivocadas para la fila «v1».
**Fix:** Reemplazarlo por el protocolo de Q1.2 bis cuando se apruebe el plan, o borrarlo si el plan elimina v1.

### Q1.2 bis Protocolo de reproducción en un iPhone real (≈10 min, producción, solo lectura)

Antes de empezar:
- No hace falta Mac ni cable.
- El panel `?vvdebug=1` no envía nada; solo guarda en memoria y copia al portapapeles.
- No se escribe ningún mensaje: solo se toca el campo y se cierra el teclado.

> Importante: hasta que se arregle el defecto de arriba, el registro **no incluye** el scroll del hilo ACP. El protocolo lo compensa con capturas. Si @developer agrega los campos, se repite la sección A con la versión nueva.

**Preparación (1 min)**
1. Abrir `https://terminal.lamia.casa/?vvdebug=1` (Safari). Aparece un recuadro rojo arriba a la derecha con «Copy log» y «Clear».
2. Anotar la versión de iOS (Ajustes → General → Información) y el modelo de iPhone.
3. Anotar si se usa como app instalada en la pantalla de inicio (PWA). Si sí, repetir los pasos también ahí.

**A. Chat individual de un agente, shell v1, vertical (3 min)**
1. Abrir un agente con **hilo largo** (más de 20 mensajes). Esperar a que se vea el final.
2. «Clear» en el panel. Captura de pantalla 1, sin teclado.
3. Tocar el campo de mensaje **una vez**. Esperar 2 s sin tocar nada. Captura 2.
4. Tocar fuera del campo o «Listo» para cerrar el teclado. Esperar 2 s. Captura 3.
5. Tocar el campo otra vez (**segundo foco**). Esperar 2 s. Captura 4.
6. Con el teclado abierto, scrollear el hilo hacia arriba unos mensajes y volver a tocar el campo. Captura 5.
7. Cerrar el teclado. «Copy log» y pegarlo en Project Chat o en una nota como **A-v1-largo**.

**B. Project Chat, el mismo shell (2 min).** Abrir un proyecto con hilo largo y repetir A.2–A.7 como **B-v1-largo**.

**C. Hilo corto (1 min).** Un agente o proyecto con 1–3 mensajes. Repetir solo A.2–A.4 y copiar como **C-v1-corto**.

**D. Shell v2 (2 min).** Abrir `https://terminal.lamia.casa/?ui=v2&vvdebug=1` y repetir A y B (A.2–A.4 alcanza) como **D-v2-chat** y **D-v2-proyecto**. Al terminar, volver con `?ui=`: eso borra la preferencia de este navegador.

**E. Horizontal (1 min).** Girar el teléfono. En v1, repetir A.2–A.4 en el chat individual como **E-v1-horizontal**.

**F. Chrome iOS (1 min).** Abrir la misma dirección en Chrome. Repetir A.2–A.4 y copiar como **F-chrome**.

**Qué mandar**
- Los registros etiquetados.
- Las capturas numeradas.
- En una frase, para cada caso: «qué subió» (todo, solo el hilo, el campo quedó arriba o abajo), «quedó así» o «volvió solo», y «primer foco» frente a «segundo foco».

**Qué contesta cada dato.** Numeración de hipótesis de @developer, `audit/DEVELOPER.md` §D1.6 (rama `assets/audit-2026-11-developer` @ `666615f`); la uso en todo este archivo.
- **H1** scroll de la página antes del fijo: `focusin` → `win-scroll` con `sy`/`doc` > 0 **antes** de la primera muestra con `kb: "open"`.
- **H2** el clamp anula el pan: con foco, `kb: ""`, `ih ≈ vv.h` y `vv.top > 0`. Si `ih` baja con el teclado, `maxTop = 0` (`main.ts:188`) y `data-kb` nunca se activa (`main.ts:193`): #506 y #659 no actúan en el dispositivo. **Se ve con los campos actuales.**
- **H3** un ancestro `overflow:hidden` desplazado: necesita el campo 2 de abajo.
- **H4** pan y scroll a la vez: `vv.pageTop ≠ vv.top + sy`, o `bodyBox[0] ≠ vv.top`. Se ve con los campos actuales.

**Campos que hay que agregar a `?vvdebug=1` antes de la medición completa.** Los define @developer (§D1.6) y los implementa @developer si @architect lo autoriza; QA los pide como condición del protocolo:
1. `scrollTop` de `#project-view .acp-chat-thread` y `#acp-chat .acp-chat-thread`, en lugar de `.tw-timeline` y `.chat-scroll` (todas las muestras).
2. `scrollTop` de `#app-view`, `main`, `#terminal-area`, `#project-view`, `#chat-view` y `.acp-chat` (todas las muestras; H3).
3. `document.scrollingElement.scrollHeight` (`focusin` y cada `win-scroll`; H1).
4. Caja `[top,bottom]` de `.acp-chat-composer` y de `#terminal-toolbar`/`header` (todas las muestras).
5. Una muestra en `pointerdown`/`touchstart` sobre el campo, antes del `focusin`.
6. `navigator.userAgent`, que ya está en la cabecera de «Copy log» (`vvDebug.ts:133`), y `data-shell` (QA).

**Si la corrección no está autorizada todavía:** el protocolo mínimo de @developer (un registro por chat en Safari y en Chrome si se puede: abrir con `?vvdebug=1`, tocar el campo, esperar 2 s, escribir una línea, enviar, cerrar el teclado y copiar) ya decide **H2 y H4** con los campos actuales. Se corre primero, y las secciones A–F completas después de la corrección.


### Q1.2 ter Preview de diagnóstico (`preview/kbd-diagnostic` @ `532f72b`), verificada por QA

- **Dónde está:** URL `https://preview-kbd-diagnostic.shared-terminal.pages.dev`. Tiene un backend falso dentro de la página y el medidor siempre encendido. La armó @developer (#637) a pedido de @architect (#633/#636). No se mergea.
- **Cómo la verifiqué (2026-11-21):** Chromium a 390×844 con touch, contra el sitio publicado. Las pasadas fueron Project Chat largo y corto, el chat de @solo y Project Chat con `?ui=v2`. En cada una: Clear → tap en el campo → 2,3 s → escribir y Enter → blur → Copy log → leer el portapapeles. [V]
- **Resultados:**
  - **0 pedidos a `/api` y `/ws`** en las cuatro pasadas.
  - **Cabecera:** UA, `dpr`, `screen`, `shell=v1|v2` y `url`.
  - **Eventos:** `pointerdown`, `touchstart`, `focusin`, `focus+50…2000`, `p-thread-scroll` o `a-thread-scroll`, `focusout`, `blur+100…1000`.
  - **Campos por muestra:** `n,t,ev,vv{h,w,top,pageTop,s},ih,sy,doc,docSH,body,appVh,appTop,kb,bodyBox,focus,focusBox,hid{app,main,area,pv,cv,acp},pThread,aThread,chat,composerBox,barBox,headerBox`.
  - **Qué hilo se mide en cada chat:** `pThread` en Project Chat y `aThread` en el chat individual; el que no corresponde queda en `null`, como se espera.
  - El botón «Show log» existe.
- **Observaciones:**
  - `barBox` es `null` en la página de proyecto en v1 y en v2, porque la barra de sesión está oculta allí (`projects.css:261-263`). En Project Chat la referencia arriba es `headerBox`.
  - El proyecto «corto» no es corto (`pThread` scrollHeight 3113 contra clientHeight 641), así que no aísla el caso «sin scroll del hilo». Lo dejé fuera de los pasos del owner; si se quiere ese caso, hace falta un proyecto de 1–3 mensajes.
  - En Chromium no hay teclado: `kb` queda en `""` y `vv` no cambia. Lo que importa medir sale del iPhone.

**Pasos publicados para @owner (Project Chat, un solo mensaje):** preguntas previas (shell y app instalada en cada dispositivo) → Safari: Project Chat y chat de @solo (Clear, tocar el campo, esperar 2 s, escribir y enviar, cerrar el teclado, tocar el campo otra vez, esperar 2 s, cerrar, Copy log) → lo mismo en Chrome iOS → lo mismo con `?ui=v2` si usa v2 → si usa la app instalada, nota de que la preview no se instala y que se informe la diferencia.

### Q1.3 Qué puede y qué no puede probar la automatización

Experimento aislado: no se tocó la configuración del repo.
- **Archivos:** `audit/qa/qa-webkit.config.ts`, `audit/qa/wk-probe.mjs`.
- **Cómo se armó:** una copia de `~/.cache/ms-playwright/webkit-2158` en `/tmp/wk-iso`, con el wrapper `minibrowser-wpe/MiniBrowser` parcheado para agregar las bibliotecas de `.st/pwlibs`. Se lanzó con `__EGL_VENDOR_LIBRARY_DIRS`/`LIBGL_DRIVERS_PATH`/`GBM_BACKENDS_PATH` de mesa y `PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1`.

| Pregunta | Resultado | Evidencia |
|---|---|---|
| ¿Corre Playwright WebKit acá? | **Sí**, con esa preparación. Sin ella falla: faltan libatk, EGL y GStreamer. | `audit/qa/webkit-probe-result.txt` [V] |
| ¿Simula el teclado de iOS? | **No.** Con el dispositivo «iPhone 13» (UA iOS), un `tap` en un input deja `innerHeight = visualViewport.height = 664`, `offsetTop = 0` y `scrollY = 0`: no hay teclado, ni pan, ni scroll. | `webkit-probe-result.txt` [V] |
| ¿El motor WebKit dibuja bien la app con el viewport simulado? | `keyboard.spec`, `chat-scroll.spec` y `acp-composer.spec` en `wk-mobile` (v1) y `wk-mobile-v2`: **41 passed, 1 skipped, 4 failed**. 2 fallos se repiten siempre por el entorno: xterm no deja texto en el DOM en este WebKit. Los otros 2 pasaron 6/6 al repetirlos (inestabilidad con carga, no del motor). | `webkit-run1.txt`, `webkit-run2-repeat.txt` [V] |

Qué **sí** se puede automatizar, con Chromium o WebKit y un `visualViewport` simulado:
- que la app siga los números que el navegador reporta (alto, pan, `data-kb`);
- que el composer quede pegado al borde del área visible;
- que no haya `resize` del terminal;
- R1–R4 del scroll;
- que nada tape el campo.

Qué **solo** se valida con el teclado real de iOS:
- si iOS revela el campo con pan, con scroll de la página o con las dos cosas, y en qué orden respecto de los eventos `resize`/`scroll` del visual viewport;
- el valor real de `innerHeight` con el teclado abierto;
- la animación del teclado;
- la barra de sugerencias (QuickType) y la de «Listo»;
- la PWA standalone;
- Chrome iOS, que es WebKit con otra barra;
- el gesto de volver;
- la rotación con el teclado abierto.

Agregar WebKit al CI no ayuda con P0, porque no reproduce el síntoma, y suma un motor más al mantenimiento. No lo recomiendo.

### Q1.4 Condiciones que lo agravan y si es igual en los dos chats

Esto sale del código y de los reportes; sin el dispositivo queda como hipótesis.

- **Los dos chats comparten** el mismo componente de hilo y composer (`acpThread.ts`, `AcpThread`) y la misma capa de viewport global. Que el owner lo vea en ambos coincide con eso.
- **Los dos chats difieren en el contenedor:**
  - el individual es un overlay absoluto dentro de `#terminal-area` (`#chat-view`) y en v1 comparte la pantalla con `#view-nav`, que `kb-typing` oculta;
  - Project Chat es `#project-view`, una «página» que tapa el área (`frontend/src/styles/projects.css:261-263`), sin `#view-nav`.

  Si el síntoma fuera igual en ambos, eso descarta que la causa sea `#view-nav`/`kb-typing`. Pregunta B frente a A del protocolo.
- **Primer foco frente a los siguientes.**
  - En el primer foco, `data-kb` todavía no está y body está en flujo con `transform: translateY(0)` hasta el primer `resize` del visual viewport (`main.ts:193`, `base.css:38-52`). Esa ventana es justo cuando iOS decide cómo revelar el campo (H1).
  - En los focos siguientes con el teclado abierto, body ya está fijo.

  El protocolo separa los dos casos (A.3 frente a A.5).
- **Hilo largo frente a corto.** El hilo es el único que scrollea por dentro. Con un hilo corto no hay nada que scrollear y cualquier movimiento es de la página o del body. C frente a A aísla eso.
- **Reflujo del campo mientras tiene el foco.** `fitInput()` (`acpThread.ts:877-899`) pone `height = "auto"` y después el alto final en cada `resize` del visual viewport y en cada tecla. iOS vuelve a revelar el caret cuando el campo cambia de caja (hipótesis de agravante).
- **Horizontal.** El visual viewport queda en unos 120–160 px [E]. `KEYBOARD_MIN_PX = 120` (`main.ts:175`) está en el límite, así que `data-kb` puede no activarse según el modelo de iPhone.
- **PWA standalone.** No hay barra de Safari: `innerHeight` y el reparto de alto cambian.
- **Safari frente a Chrome iOS.** Es el mismo motor, así que si difieren es por la barra inferior o superior de cada uno.

---

## Q2 (P1) — Cobertura y dos shells

### Q2.1 Mapa de e2e × proyectos

Comando: `npx playwright test --list --reporter=json`, perfil completo y `E2E_PROFILE=pr` [V]. Las cuentas son tests **listados**; los `test.skip` por shell, móvil o desktop se resuelven en ejecución.

| Proyecto | main (completo) | PR | Capturas de referencia |
|---|---|---|---|
| desktop (v1) | 233 | 233 | 10 |
| mobile (v1) | 233 | 233 | 10 |
| desktop-v2 | 233 | 52 | 10 |
| mobile-v2 | 233 | 52 | 10 |
| mobile-v2-stacked (`?bar=stacked`) | 25 | 15 | 10 |
| **total** | **957** | **585** | **50** (1,9 MB) |

- **38 specs.** 33 corren idénticos en los cuatro proyectos principales. `navigation`, `shell-v2`, `terminal-invariant` y `visual` corren además en `stacked`.
- **Hoy el PR protege a v1 en todo y a v2 solo en 8 specs** (`playwright.config.ts:12-28`), porque producción responde `uiShell: "v1"`. Si se elimina v1, este perfil queda invertido y hay que reescribirlo, no solo borrarlo.

### Q2.2 Qué existe solo por v1 o por mantener dos shells

| Prueba | Qué protege | Si se elimina v1 |
|---|---|---|
| `v1-landing.spec.ts` (3 tests, solo v1) | Aterrizaje v1: Files/Terminal, sin «chat-first» | **Desaparece.** Aviso: es el comportamiento que hoy tiene producción. |
| `agent-landing.spec.ts:163` (`describe` del testigo v1) | Que un landing en espera no bloquea la sesión tradicional en v1 | Se reescribe con un testigo v2 o se elimina si `chat-first` ya lo cubre (@developer decide). |
| `keyboard.spec.ts:274` (solo v1) | `#view-nav` no ocupa lugar con el teclado (`kb-typing`) | Desaparece junto con `#view-nav` **si v2 no lo usa**. Hay que verificarlo: CLAUDE.md dice que v2 no usa la barra de abajo. |
| `terminal-invariant.spec.ts:25-38` (rama v1 mobile) | Registra el costo del drawer de v1 («resizes > 0») | Se elimina la rama. **Queda intocable** la parte pura: cero `resize` al cambiar de vista. |
| `router.spec.ts:87` (`deferredSync` v1) | Un sync diferido solo en v1 mobile | Se simplifica a 0. |
| `fixtures.ts:78-100,211-219` (`openChromeDrawer`, rutas por shell) | Lógica de la suite | Se simplifica. |
| `chat-first.spec.ts` y `shell-v2.spec.ts` (`skip` si no es v2) | Comportamiento v2 | **Pasan a ser la suite base**, sin `skip`. |
| Proyecto `mobile-v2-stacked` (25 tests, 10 capturas) | Variante `?bar=stacked` de v2 | Si la barra apilada se elimina junto con v1, desaparece entero. Es una decisión de @architect u @owner: hoy es una «alternativa» sin usuarios conocidos. |
| `uiShell.test.ts` (vitest) | El selector `?ui=` y `?bar=` | Desaparece con el selector. |

Cifras si se elimina v1 y la barra apilada:
- **466 tests listados** en lugar de 957 (−491, −51 %) [V por resta].
- **20 capturas** en lugar de 50 [V por resta].
- Si la barra apilada se conserva: 491 tests y 30 capturas.

### Q2.3 Duplicados y obsoletos (con evidencia, sin pretender cubrir todo)

- **Duplicación estructural.**
  - Los 33 specs que no dependen del shell corren desktop y desktop-v2 con el mismo mock y el mismo DOM de chat, y lo mismo pasa con mobile y mobile-v2 (`playwright.config.ts:18-21`, el propio comentario lo admite).
  - Es el mayor duplicado de la suite, y desaparece solo al quedar un shell.
- **Obsoleto en el código de pruebas:**
  - `frontend/src/vvDebug.test.ts:50,58` prueba el foco con `textarea.tw-text`, una clase del workspace retirado. La prueba no falla, pero valida un caso que ya no existe.
  - `frontend/src/chatView.test.ts:989`: la cabecera «3.2 composer» encabeza tests de otra cosa (enlace de la barra lateral). Es un resto de #678 [NIT].
  - `conversationModel.test.ts:632-650` (`composer_send`) **no** es obsoleto: los registros históricos siguen trayendo ese evento.
- **No encontré** specs e2e que prueben código retirado: #678 ya borró `projects`, `thread-scroll`, `short-height`, `drafts`, `background-session` y `chat` (parcial) [V `git show a19dca8 --stat`].

### Q2.4 Intocables al quedar una sola interfaz

- **Invariante del terminal:** cambiar de vista manda cero `resize` y no abre sockets (`terminal-invariant.spec.ts`), en desktop y en teléfono.
- **Teclado:** `keyboard.spec.ts:242`, el terminal tapado no manda `resize` mientras el teclado se abre y cierra en Chat, y hace un solo sync al volver.
- **`auth-cookie.spec.ts`:** la red y las cookies reales de Chromium.
- **Scroll R1–R4:** `chat-scroll.spec.ts`, los 8 tests, en los tres chats.
- **Rutas e historial:** `router.spec.ts`, `router-async.spec.ts` y `navigation.spec.ts`.
- **Races:** `races.spec.ts`, `session-create-race.spec.ts` y los `*.race.test.ts` de vitest.
- **`a11y.spec.ts`** (axe).

### Q2.5 Riesgos de eliminar v1: comportamiento que hoy solo protegen los tests de v1

1. **Producción usa v1** (dato de @architect, 2026-11-21). Eliminar v1 cambia lo que hoy ve el owner, aunque sus navegadores puedan estar en v2 por `?ui=v2`:
   - el aterrizaje: v1 abre Terminal o Files y v2 abre Chat primero;
   - el drawer del teléfono;
   - el `#view-nav` de abajo;
   - el header con varios botones en lugar de un menú.

   Antes de borrar v1 hay que confirmar en qué shell trabaja el owner en cada dispositivo. El protocolo D también sirve para eso.
2. **La suite de PR solo corre completa en v1.** En main, todo v2 está cubierto, pero un PR que rompa v2 fuera de los 8 specs pasa el PR y falla recién en main (lo vi en este stack: los fallos de `mobile-v2` aparecían solo en el push a main). Al eliminar v1, el perfil de PR tiene que pasar a correr v2 completo, no a borrar proyectos.
3. **La X de Project Chat y la salida de la página** no tienen test e2e en ningún shell: `grep -rn "pv-close\|Cerrar el proyecto" frontend/e2e` no devuelve nada [V]. Ver Q4.
4. **Bugs causados por tener dos shells:**
   - #707: el `!important` de `shell-v2.css` contra el drawer de `mobile.css` dejaba las herramientas del terminal flotando sin sesión;
   - #563: la barra unida de v2 actuaba sobre la sesión de abajo;
   - la variante `stacked`.

   Esta clase de bug desaparece con un solo shell.

---

## Q3 (P3) — Bugs recurrentes y causas comunes

Fuente: los 531 PRs y 187 issues del repo (`gh pr list`/`gh issue list --state all`) [V]. Hay pocos issues abiertos sobre la UI (23 abiertos, casi todos de backend o decisiones). La historia de los bugs está en los PRs.

| Grupo | Números | Patrón | ¿Lo resuelve una refactorización estructural? |
|---|---|---|---|
| **G1 Teclado y viewport iOS** | #341, #506, #611, #623, #624, #636, #659, #700; issue #616 (cerrado sin medición); #627 | Cinco arreglos sin medir en el dispositivo, con hipótesis contrarias. El síntoma sobrevive a tres UIs de chat. | **Sí, si la capa global de viewport se rehace a partir de una medición** (Q1.2 bis). Sin medición, la refactorización sería el sexto intento a ciegas. |
| **G2 Lugar de lectura y scroll del hilo** | #157/#161/#174/#178 (terminal); #476 (captura); #611 (v3); #700, #705, #710, #717; los arreglos de prueba e8c66c3 y d50889f | Tres implementaciones de scroll, unificadas recién en #710. #717 arregla una carrera que había metido el propio #710. | **Ya consolidado** (`chatScroll.ts` + `acpThread`). Conservar; no rehacer. |
| **G3 Carreras de listas y aterrizaje** | #396/#397/#398 (el mismo bug en 3 PRs), #504, #682, #702, #716, #717 | Respuestas viejas que pisan estados nuevos; tests inestables por relojes falsos. | Parcial: menos rutas de aterrizaje con un shell (v1-landing y chat-first son dos políticas). |
| **G4 Densidad y cabeceras en el teléfono** | #563, #623, #624, #700, #701, #706, #707; #715 abierto | Compactar la cabecera y los controles cuatro o cinco veces, en cada UI y en cada shell. | **Sí:** una sola cabecera en un solo shell (Q4). |
| **G5 Dos shells que chocan** | #707, #563, el `!important` y el `:not([data-shell="v2"])` en `mobile.css` | Reglas de un shell que anulan las del otro. | **Sí:** desaparece con la eliminación de v1. |
| **G6 Toasts que tapan controles** | Observado en #710–#714 (flecha de envío en desktop, «Cargar anteriores» en mobile-v2); arreglo solo de test d50889f | El toast fijo tapa el composer y el principio del hilo. | No es estructural. Es una regla de posición del toast; lo vería @designer. |
| **G7 Terminal (fuera de alcance)** | #155→#159→#175 (re-aplicado), #157→#178 (regresión), #171/#173/#176/#177/#180 (el wheel ruteado 4 veces) | Arreglos encadenados en mayo. | Fuera de alcance (#627 §6). Se documenta. |

Observaciones de mi revisión del stack #710–#714, que no bloquearon y siguen en main:
- primer cuadro con un hueco intermitente de 11–12 px al recargar Project Chat en desktop;
- axe `scrollable-region-focusable` en el hilo de Project Chat;
- el chip de estado usa la palabra en inglés del servidor;
- el ⋯ de desktop v1 mide 28×22.

---

## Q4 (P2) — La X de Project Chat: qué comportamientos preservar

Hoy (`frontend/src/projectsView.ts:311`) la X es `button("×", "pv-close", leavePage, "Cerrar el proyecto")`:
- `leavePage` llama a `pushSessionAddress()` (`router.ts:269-274`), que crea una **entrada nueva** con la ruta de la sesión de abajo, o vacía si no hay sesión, para que Atrás vuelva al proyecto;
- tocar una fila de sesión de la barra lateral o la barra de sesión hace lo mismo, mediante un listener de captura (`projectsView.ts:458-470`).

| Comportamiento a preservar | Desktop | Teléfono | Riesgo si se quita la X |
|---|---|---|---|
| Atrás del navegador vuelve a lo que estaba antes del proyecto | ✓ | ✓ | Ninguno. |
| **Deep link** `#/projects/<pid>/chat` como primera entrada del historial | — | — | **Atrás saca de la app.** La única salida dentro de la app queda en la barra lateral. |
| **PWA standalone en iOS** | — | sin botón Atrás de Safari; el gesto de volver no está garantizado en standalone | **Alto:** sin X, la salida es solo la barra lateral (drawer). Hay que confirmar si el owner usa la PWA (protocolo, preparación 3). |
| Barra lateral: tocar otra sesión o proyecto | siempre visible | drawer (hamburguesa) | Ninguno; es la salida natural. |
| Barra de sesión (v2): tocar la barra devuelve a la sesión | ✓ | ✓ | La barra está, pero en v2 con `project-page-on` el tab de vista y el ⋯ quedan sin acción (`shell-v2.css:180-188`). Que «tocar la barra sale» no se descubre solo. |
| v1 teléfono: `#chrome-toggle` y `#actions-btn` ocultos en la página (`projects.css:261-263`) | — | — | Quedan Atrás y el drawer. |
| Foco: al abrir, el foco va a `.pv-title` con `preventScroll` (`projectsView.ts:245`); al salir, a la sesión | ✓ | ✓ | Si se quita la X, verificar a dónde va el foco con el teclado (Tab). Hoy la X es el último control con Tab de la cabecera. |
| `Escape` | no cierra la página (solo diálogos o menús) | — | Si se quiere un atajo de teclado en desktop, es una decisión nueva, no algo que preservar. |

Recomendación de QA: se puede quitar la X si queda una salida visible dentro de la app en el teléfono **sin depender de Atrás**: la hamburguesa del drawer alcanza si está en la cabecera de la página. Antes de quitarla, sumar un test e2e de salida, que hoy no existe.

---

## Q5 — Plan de QA (sección G del informe)

### Q5.1 Matriz chica de pruebas representativas (interfaz única)

Automatizable: Chromium, mock y viewport simulado, en CI. Manual: iPhone real (Safari, Chrome y PWA) y Android si hay.

| # | Escenario | Desktop 1280 | Teléfono 390 | iPhone real |
|---|---|---|---|---|
| M1 | Abrir el chat individual y Project Chat → al final (R1) | auto | auto | manual |
| M2 | Atrás/Adelante restaura la fila (R2); una navegación nueva va al final | auto | auto | manual (gesto) |
| M3 | Lector arriba + noticias, teclado y página anterior → no se mueve (R3) | auto | auto | manual |
| M4 | «Ir al final»: umbral, contador, 44 px, no tapa preguntas (R4) | auto | auto | — |
| M5 | Foco en el composer: el campo queda visible, pegado al teclado, y el hilo no salta (primer foco y siguientes) | — | auto (simulado) | **manual (la prueba real de P0)** |
| M6 | Escribir 6 líneas y enviar 3 mensajes seguidos sin cerrar el teclado | auto | auto | manual |
| M7 | Cambiar de vista: cero `resize`, sin sockets nuevos; teclado en Chat: cero `resize` | auto | auto | manual (`stty size`) |
| M8 | Salir de Project Chat: Atrás, barra lateral o drawer, deep link | auto | auto | manual (PWA) |
| M9 | axe en las dos vistas de chat | auto | auto | — |
| M10 | Capturas: chat, Project Chat, sesión detenida y el estado sin sesión | auto (≤ 10 por proyecto) | auto | — |

### Q5.2 Criterios de aceptación por refactorización probable

**(a) Un solo layout de composer + hilo con el teclado**
- *Automatizable (CI):*
  - `keyboard.spec.ts` sigue verde, adaptado a la capa nueva;
  - el composer queda a ≤ 2 px del borde del área visible en 290, 330 y 380 px de alto en los dos chats;
  - R1–R4 sin cambios (`chat-scroll.spec.ts`);
  - cero `resize` del terminal;
  - la misma regla para los dos chats: un test parametrizado por chat, no dos specs.
- *Criterio de código, que verifica QA:*
  - un solo mecanismo de viewport;
  - se borra lo que se reemplaza (`--app-top`, `data-kb` y `kb-typing` solo si la medición los justifica);
  - el balance de líneas es negativo o se justifica.
- *Lista de control en el iPhone real.* Se ejecuta en Safari y en Chrome iOS, vertical, en los dos chats, más una pasada en la PWA:
  1. Abrir un chat con hilo largo: se ve el final, sin teclado.
  2. Tocar el campo (primer foco): el teclado sube, el campo queda justo encima del teclado y **la cabecera sigue visible**. Ni la app ni el hilo saltan al principio.
  3. Esperar 2 s: nada se mueve solo.
  4. Escribir tres líneas: el campo crece y el último mensaje sigue visible.
  5. Enviar; escribir y enviar otra vez sin cerrar el teclado: el campo no pierde el foco y el teclado no se cierra.
  6. Con el teclado abierto, scrollear el hilo hacia arriba: se puede leer; la cabecera y el campo se quedan quietos.
  7. Tocar el campo otra vez desde ahí (segundo foco): el lector no es llevado al principio. Va al final solo si estaba al final.
  8. Cerrar el teclado: la app vuelve a ocupar la pantalla sin franja ni salto. `--app-top` (o su reemplazo) vuelve a 0 en el registro.
  9. Girar a horizontal con el teclado abierto: el campo sigue visible; al volver a vertical no quedan restos.
  10. Repetir 2–8 en Project Chat y en la PWA. Adjuntar el registro de `?vvdebug=1` (corregido) de los pasos 2 y 7.
- *Condición de aprobación:* CI verde, y la lista 1–10 en PASS en el iPhone del owner con los registros adjuntos. Sin ese registro, la etapa no se declara resuelta: el error de #616 fue cerrar sin él.

**(b) Eliminación de v1**
- Cada comportamiento de v1 que se conserve se mueve a v2 con su test. Los de la tabla Q2.2 se migran o se eliminan explícitamente; ninguno «desaparece de paso».
- El perfil de PR (`playwright.config.ts`) corre la interfaz única completa en desktop y teléfono.
- Los intocables de Q2.4 quedan en verde y sin `skip` nuevos.
- Ni `?ui=` ni `UI_SHELL` cambian nada. Después del deploy, `/api/auth/status` sin `uiShell` no rompe una versión del frontend que se haya quedado vieja en caché. Esto se verifica en un smoke de producción sin login.
- Producción: smoke sin login, más el owner abriendo sesión, Chat, Project Chat y Terminal en desktop y teléfono.
- Rollback: `git revert` del PR del frontend más un nuevo deploy de Pages. El backend no se toca en esta etapa; el retiro de `UI_SHELL` va aparte y con GO del owner.

**(c) Cabecera y navegación de Project Chat**
- Un test e2e nuevo: salir de Project Chat por Atrás, por la barra lateral (desktop) y por el drawer (teléfono), y desde un deep link.
- Foco correcto con Tab.
- Las capturas de Project Chat se actualizan una sola vez, con la diferencia revisada contra los criterios de @designer.
- En el iPhone: salir desde la PWA standalone.

**(d) Limpieza de código muerto**
- CI completo verde (los 5 proyectos o los que queden).
- Las capturas sin cambios: si una cambia, no era código muerto.
- Revisión de QA: cada eliminación tiene una búsqueda de consumidores (`grep` y la ruta del bundle) en la descripción del PR.

### Q5.3 Regresiones críticas a vigilar

1. Un `resize` del terminal al cambiar de vista o con el teclado: afecta a todos los que miran la sesión.
2. Perder la posición de lectura (R2/R3), sobre todo al abrir y cerrar el teclado.
3. Un mensaje enviado dos veces, perdido o en el chat equivocado (invariantes de `acpThread`, #680).
4. Auth y cookie (`auth-cookie.spec`).
5. Una salida de Project Chat que no sea alcanzable en el teléfono o la PWA.
6. Una sesión, un contenedor o un dato tocado: no debería pasar en ninguna etapa del frontend; si un PR toca backend, sale del alcance.

### Q5.4 Sin aumentar la cantidad de tests

| Test nuevo propuesto | Qué se retira a cambio |
|---|---|
| Salida de Project Chat (c) | `v1-landing.spec.ts` (3) y la rama v1 de `terminal-invariant` (b) |
| Test parametrizado por chat del composer con el teclado (a) | `keyboard.spec.ts:274` (`#view-nav` v1) y las aserciones duplicadas de los dos chats en `keyboard.spec.ts:170` y `:290-316` |
| Campos de vvdebug corregidos (diagnóstico, vitest) | `vvDebug.test.ts:50,58` (`tw-text`) se reemplaza, no se suma |

El balance neto en la suite es negativo:
- **e2e:** de 957 a unos 470 tests listados [E].
- **Capturas:** de 50 a 20 [V por resta, si se quita `stacked`].

---

## Lo que no pude demostrar y qué evidencia falta

- **La causa raíz del P0 no está demostrada.** Hay cuatro hipótesis (H1–H4 de @developer, ver Q1.2 bis). H2 y H4 se deciden con el vvdebug actual; H1 y H3 necesitan los campos 1–5. Se deciden con un registro de `?vvdebug=1` del iPhone, mejor con los campos corregidos. No hay **ningún** registro del dispositivo en el repo ni en los issues.
- El shell que usa el owner en cada dispositivo (producción dice v1; puede haber `?ui=v2` guardado).
- Si el owner usa la PWA standalone: decide el riesgo de quitar la X.
- WebKit/iPhone, lectores de pantalla reales y producción con login: no validados en ningún PR del stack.
