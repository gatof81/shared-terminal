# Auditoría 2026-11 — @designer (U1–U4)

Pedido: #630 de @architect (auditoría #624/#625 de @owner). Línea de base: `origin/main` @ `d28dad7`. Solo investigación: no hay código de producto, ni PR, ni merge.

**Método.** Corrí Playwright con **Chromium headless**, que no es WebKit ni un iPhone, contra el backend mock de `frontend/e2e/mockBackend.ts`. Usé shell v1 y v2 y 8 tamaños:

| proyecto | viewport | teclado supuesto | lo visible con teclado |
|---|---|---|---|
| `se-safari` | 375×548 (SE en Safari) | 260 | 288 |
| `13-safari` | 390×664 (13 en Safari) | 336 | 328 |
| `13-pwa` | 390×844 (13 en la app de inicio) | 336 | 508 |
| `13-land` | 844×358 (13 en horizontal) | 208 | 150 |
| `320` | 320×568 | 260 | 308 |
| `ipad` | 820×1100 | 313 | 787 |
| `1280` | 1280×800 | — | — |
| `1440` | 1440×900 | — | — |

**Las alturas de teclado y de Safari son estimaciones**, no medidas en un dispositivo.

**Cómo simulé el teclado:**
- **iOS:** reemplacé `window.visualViewport` por la misma pieza que usa `e2e/keyboard.spec.ts`. El viewport de layout conserva su alto, el visual se achica y Safari puede desplazar la vista (`offsetTop`).
- **Android:** achiqué el viewport de verdad (`interactive-widget=resizes-content`).

Esto prueba lo que la app *hace con esos números*. **No** prueba lo que hace Safari: el desplazamiento propio de la vista, el momento en que lo hace y si desplaza ancestros por su cuenta. Eso solo se juzga en un iPhone real; para medirlo ahí está `?vvdebug=1` (#616) o el bookmarklet de `docs/MOBILE_KEYBOARD.md`.

**Evidencia en esta rama:**
- `designer/kb/kb.jsonl`: 392 mediciones. Resumen legible en `designer/kb/kb-table.txt`.
- `designer/shots/*.jsonl`: controles visibles, salida de la página de proyecto y alto del terminal.
- Capturas `designer/kb/*.png` y `designer/shots/*.png`. En las capturas con teclado, todo lo que queda por debajo de lo visible es la zona del teclado y aparece vacía.
- Scripts en `designer/scripts/`. Para reproducir: copiarlos a `frontend/e2e-audit/` sobre `d28dad7` y correr `npx playwright test -c e2e-audit/audit.config.ts`.

Las cifras marcadas **[V]** están verificadas con esa evidencia. Las marcadas **[E]** son estimaciones.

---

## U1 (P0) Comportamiento correcto de los inputs de Chat y Project Chat

### U1.1 Qué pasa hoy (Chromium, teclado simulado)

| Hecho | Dónde | Evidencia |
|---|---|---|
| **H1. Algo que no es el hilo se desplaza y la interfaz "sube".** En horizontal (150 px visibles) el mínimo del layout no entra. Al enviar, el navegador desplaza un contenedor que no debería desplazarse: `#terminal-area` 115–138 px en el chat de agente y `#project-view` 144–146 px en Project Chat. La barra de sesión queda en y = −83…−22 y el hilo desaparece. | v1 y v2, ambos chats | **[V]** `kb.jsonl`, pasos `3-send*` de `13-land`, campo `scrolled`. Captura `kb/agent-13-land-v2-3-sent.png` |
| **H2. El composer queda debajo del teclado** cuando el campo crece. El hilo conserva un mínimo de 96 px y la regla dice que el composer no cede (`acp-chat.css:13-25`, `.acp-thread{min-height:auto}`). Si cabecera + 96 + composer superan lo visible, el borde inferior del composer queda tapado: 9–15 px en `13-safari` (v1 y Project Chat) y 37–43 px en `se-safari` y `320` v1. | v1 en ambos chats; v2 en Project Chat | **[V]** pasos `4-grow6`. Captura `kb/project-13-safari-v1-4-grow6.png` |
| **H3. Hasta 107 px de cabecera con teclado.** Chat de agente: v1 102 px (header + fila del agente), v2 46 px. Project Chat: 107 px en **ambos** shells, una fila de 44 px con solo ☰ más la cabecera de la página de 63 px. Con 328 px visibles, eso es un tercio de la pantalla. | | **[V]** `kb.jsonl`, valor `th` en `1-kb-pan`. Captura `shots/project-13-safari-v2.png` |
| **H4. Margen distinto bajo el composer.** Project Chat deja 12 px entre el composer y el teclado o el borde (`acp-chat.css:186`, `padding-bottom: var(--s-3)`); el chat de agente deja 0. Con teclado: 316 frente a 328. En desktop: 888 frente a 900. | | **[V]** `kb.jsonl` |
| **H5. Lo que ya funciona:** <ul><li>`window.scrollY` = 0 en todos los casos.</li><li>Si el hilo estaba al final, sigue al final al abrir el teclado (gap 0).</li><li>Leyendo más arriba, la fila ancla no se mueve (±0 px) al abrir, cerrar y reabrir el teclado, tanto en el modo iOS como en el Android.</li><li>Tres envíos seguidos: el foco queda en el campo, el campo se vacía y el hilo va al final.</li><li>Enviar estando arriba lleva al final.</li><li>El campo usa 16 px en el teléfono, así iOS no hace zoom (`acp-chat.css:988`).</li></ul> | Todos los tamaños en vertical | **[V]** pasos `1`, `3`, `5`–`8` y `7b` |
| **H6. No confirmado:** tras crecer el campo estando al final, a 2 frames el hilo a veces quedó 29–110 px por encima del final (Project Chat `13-safari` y `13-pwa`). En otra corrida dio 0. No medí si se corrige solo después. | | Dos corridas con resultados distintos. **@qa debería repetirlo con espera.** |

**Hipótesis para @developer y @qa, no demostrada en iPhone:** H1 y H2 son la misma situación. **El layout es más alto que lo visible**, entonces el navegador tiene algo que desplazar y lo desplaza para mostrar el campo enfocado. Safari lo hace de forma más agresiva que Chromium. En vertical, Chromium solo llega a desbordar al crecer el campo. En un iPhone real, la barra de sugerencias, la barra de Safari o los 102–107 px de cabecera pueden ser los que falten. Eso explicaría que "la interfaz sube hasta arriba" pase en los dos chats y en los dos shells. **Para confirmarlo falta** una lectura de `?vvdebug=1` en el iPhone de @owner, con el valor de `scrollTop` de `#terminal-area` y `#project-view` en el momento del salto.

### U1.2 Reglas: comportamiento esperado, igual en los dos chats

Referencia: Mensajes de iOS, WhatsApp y Telegram. El hilo es lo único que se desplaza, la barra de arriba y el campo no se mueven, y el teclado empuja el campo, no la pantalla.

Estado hoy: ✅ cumple en Chromium simulado · ❌ falla en Chromium simulado · 📱 solo se puede juzgar en un iPhone real.

| # | Regla (medible) | Hoy |
|---|---|---|
| **R1** | **Un solo desplazamiento: el del hilo.** Con un chat abierto, en todo momento (abrir o cerrar el teclado, escribir, enviar, crecer el campo, rotar): `window.scrollY = 0` y `scrollTop = 0` en todo ancestro del chat (`body`, `#terminal-area`, `#project-view`, `.pv-page`). Solo pueden tener `scrollTop ≠ 0` `.acp-chat-thread`, el propio campo cuando pasa su tope y los paneles con scroll interno. **Condiciona la técnica:** ninguna caja del chat puede tener contenido más alto que ella misma. Si cabecera + composer no entran, el que cede es el hilo, que puede llegar a 0, y no el layout. | ❌ horizontal (H1). ✅ vertical. 📱 Safari |
| **R2** | **El campo pegado al teclado.** Con teclado: borde inferior del composer = `visualViewport.offsetTop + visualViewport.height`, ±1 px, **en los dos chats**, con el mismo margen interno. Sin teclado: borde inferior = alto visible − `safe-area-inset-bottom`. | ❌ Project Chat 12 px (H4). ❌ al crecer en pantallas bajas (H2). 📱 |
| **R3** | **La barra superior no se mueve.** Su borde superior queda en la parte de arriba de lo visible (0, o `safe-area-inset-top` en standalone) al abrir el teclado, al enviar y al crecer el campo. Diferencia permitida: 0 px. | ❌ horizontal (−83). ✅ vertical. 📱 la transición |
| **R4** | **Una sola fila arriba con el teclado abierto**, de ≤ 46 px en teléfono: ☰ · identidad (agente o proyecto) · acciones. Ninguna cabecera propia del chat debajo. | ✅ v2 agente (46). ❌ v1 agente (102). ❌ Project Chat en v1 y v2 (107) |
| **R5** | **Orden de cesión cuando falta alto:** primero el hilo, después el tope del campo. El campo nunca sale de lo visible y la barra nunca se va. Tope del campo en el teléfono = min(8 líneas, 30 % de lo visible): ya es la regla actual (`acpThread.ts:892-897`); se mantiene. Un aviso del composer («N en espera», «Para…») ocupa su línea dentro del composer y cuenta para el tope. | ❌ H2 |
| **R6** | **Al abrir el teclado estando al final, sigue al final:** distancia al final ≤ 4 px después de abrirse. | ✅ |
| **R7** | **Leyendo más arriba, el lugar no se pierde:** la fila que estaba arriba del hilo queda a ±1 px de su posición respecto del borde superior del hilo, al abrir, cerrar y reabrir el teclado y al crecer o achicarse el campo. | ✅ (simulado). 📱 |
| **R8** | **Varios envíos seguidos:** después de cada envío el foco sigue en el campo, el campo queda vacío, **el teclado no se cierra** y el hilo queda al final (≤ 4 px). Vale también si se envió estando arriba (el envío propio lleva al final). | ✅ foco, vacío, final. 📱 el teclado (el botón ya evita el blur: `acpThread.ts:275-277`) |
| **R9** | **Crecer el campo estando al final no tapa el último mensaje:** distancia al final ≤ 4 px después de cada línea nueva. | ⚠ H6 sin confirmar |
| **R10** | **Cerrar el teclado** (tocar afuera, Listo o el gesto) devuelve la barra, el hilo y el composer a sus posiciones de reposo (±1 px), mantiene la fila ancla (R7) y no deja una franja entre el composer y el indicador de inicio. | ✅ simulado. 📱 `offsetTop` residual |
| **R11** | **«Ir al final»** aparece solo si la distancia al final supera un alto de pantalla del hilo o llegan mensajes nuevos. Queda por encima del composer, **nunca encima del campo ni de las opciones de una pregunta**. Un toque lleva al final y conserva el foco y el teclado. | ✅ (`e2e/chat-scroll.spec.ts:211`, `:371`). 📱 teclado |
| **R12** | **Pregunta abierta a la vista:** con el teclado abierto, las opciones de la pregunta que está al final quedan enteras por encima del composer. Si no entran, el hilo se desplaza para mostrarlas y la barra y el campo no se mueven (R1, R3). | ✅ parcial (`:371`). 📱 |
| **R13** | **Sin saltos animados en la transición del teclado:** durante la apertura y el cierre ningún elemento fuera del hilo cambia de posición en más de lo que cambia el teclado, y no hay un cuadro intermedio con la barra fuera de pantalla. | 📱 solo (hace falta un video del iPhone) |
| **R14** | **Desktop:** sin teclado virtual. El composer queda abajo con el mismo margen en los dos chats (R2), R6–R9 y R11 iguales. Ctrl/⌘+Enter envía y Enter hace salto de línea, como hoy. | ❌ margen (H4). ✅ resto |
| **R15** | **Orientación:** <ul><li>**Teléfono vertical: se soporta** con R1–R13.</li><li>**Teléfono horizontal: no se rompe** (R1, R2, R3, R5). Puede quedar 0 px de hilo con el teclado abierto, pero no se aceptan la barra afuera, el campo tapado ni la interfaz desplazada. Sin teclado, el layout tiene que ser el del teléfono (sidebar como cajón, una fila arriba), no el de desktop (ver U4-6).</li><li>**Tablet, vertical y horizontal: se soporta** con las mismas reglas.</li></ul> | ❌ horizontal (H1 y U4-6). ✅ iPad simulado |
| **R16** | **Áreas seguras y standalone:** <ul><li>En la app de inicio (`viewport-fit=cover`), la barra superior empieza debajo de la zona de estado (`safe-area-inset-top`) y el fondo pinta esa franja.</li><li>Sin teclado, el composer termina a `safe-area-inset-bottom` del borde (el indicador de inicio no tapa el campo).</li><li>Con teclado, esa franja desaparece (0 px entre el composer y el teclado).</li><li>En horizontal, la cabecera y el composer respetan `safe-area-inset-left/right` (muesca).</li></ul> | 📱 solo (Chromium da 0 en todos los insets) |

**Lo que @qa puede automatizar en Chromium:** R1–R12 y R14–R15, con la misma pieza de `keyboard.spec.ts` y los tamaños de arriba. Agregar el caso de 150 px visibles en horizontal es el que hoy falla.

**Lo que solo se valida en un iPhone (Safari y app de inicio, v2):** R1 en Safari (la lectura de `scrollTop` de los ancestros), R3 y R13 en la transición, R8 (el teclado no se cierra), R10 con el `offsetTop` residual y R16.

---

## U2 (P2) Project Chat: la X y los controles redundantes

### U2.1 Para qué sirve hoy la ×

- **Qué hace:** `projectsView.ts:311` crea `button("×", "pv-close", leavePage, "Cerrar el proyecto")`. `leavePage` (`projectsView.ts:264-268`) llama a `pushSessionAddress()` y a `sync()`: deja la página de proyecto y muestra **la sesión que estaba debajo**, la última elegida. Si no había ninguna, muestra la portada vacía «Select or create a session →» (`shots/project-afterX-13-safari-v2.png`). Atrás vuelve al proyecto. **[V]** `shots/leave.jsonl`, `shots/x.jsonl`.
- **Tamaño:** 44×44 en teléfono, 32×33 en desktop. **[V]** `shots/controls.jsonl`.
- **Otras formas de salir:**
  - Desktop (v1 y v2): el sidebar siempre visible. Cualquier sesión, agente o proyecto del árbol sale de la página.
  - Teléfono: ☰ abre el cajón con lo mismo.
  - En los dos: Atrás del navegador y el gesto de iOS.
  - La barra de sesión **no** está mientras se ve el proyecto. En v2 sus pestañas y su ⋯ se ocultan (`shell-v2.css:187-188`); en v1 se ocultan `#chrome-toggle` y `#actions-btn` (`projects.css:261-264`). No hay otra salida dentro de la página.
- **Defecto encontrado** [V] (mock, Chromium, `13-safari-v2` y `1440-v1`). Pasos: abrir un chat de agente, abrir el proyecto desde el sidebar y tocar ×. Se ve el chat, **pero la dirección queda vacía** (`hash ""`). Al recargar aparece la portada vacía y no la sesión (`shots/x-reload-*.png`, `shots/x2.jsonl`). La × es hoy el único camino conocido que deja la dirección sin la sesión. No investigué la causa: es área de @developer. **@qa debería confirmarlo.**

**Conclusión:** la × repite lo que ya hacen el sidebar, el cajón y Atrás, y además lleva a un estado roto o vacío. Se puede eliminar sin perder ningún camino, en desktop y en teléfono, y en v1 y v2.

### U2.2 Qué queda en la cabecera

**Teléfono:** una sola fila, la de la barra (≤ 46 px), con `☰ · Título del proyecto (elipsis) · avatares ●N · ⋯`.
- Desaparecen la fila de 44 px con solo ☰ y la cabecera propia de 63 px.
- Ganancia de alto en el hilo: **+51 px** medidos en v2 por #715 [V, de #715]. Frente a hoy son 107 → 46 px de cabecera [V].
- Sin la ×, el título gana **44 px de ancho**, unos 5–6 caracteres a 15 px [E].

**Desktop:** la fila `Título · avatares · ⋯`, sin ×. El ⋯ pasa a ser `.btn-icon` como el de la barra de sesión (hoy es `.pv-btn` contorneado de 44×32: U4-5).

**⋯ del proyecto:** Renombrar · Archivar. «Administrar agentes» sale del menú: ver el punto siguiente.

### U2.3 Otros controles redundantes en el mismo sector

1. **Hay dos paneles para los agentes del proyecto** (`acpProjectChat.ts:156-251`):
   - **«Agentes del proyecto»**, que se abre desde los avatares: estado y «Abrir su chat» (`shots/panel-list-*.png`).
   - **«Administrar agentes»**, que se abre desde ⋯: «Quitar», «Agregar agente existente…», «+ Nueva sesión con agente» y un párrafo de ayuda (`shots/panel-manage-*.png`).

   Los dos listan los mismos agentes, cada uno con su ×, y el sidebar los lista una tercera vez.

   **Propuesta:** un solo panel **«Agentes»** que se abre desde los avatares.
   - Cada fila: avatar, nombre, chip de estado y «Abrir su chat»; «Quitar» queda en el ⋯ de la fila o como `.btn.sm` secundario.
   - Al pie: «Agregar existente…» y «+ Nueva sesión con agente».
   - El párrafo de ayuda se elimina, porque el placeholder ya dice «Empezá con @agente (uno o varios)».
   - Desaparecen un panel, una × y una entrada del ⋯.
2. **La × de cada panel se conserva**: cierra un panel, no navega, y es el cierre visible en un teléfono. #718 ya suma Escape, el toque afuera y el toggle de los avatares.

### U2.4 Relación con #715 y #718 (congelados)

- **#715** (D: la cabecera de Project Chat como barra en el teléfono v2). **Mi propuesta lo simplifica:**
  - Se queda con la parte de la barra en el teléfono.
  - Quita la × también en desktop.
  - No agrega «Cerrar» al ⋯.
  - Su rama v1 (título en el header) pierde sentido si v1 se elimina.
- **#718** (lista de agentes superpuesta y estado tocable). **Se mantiene y pasa a ser el panel único:**
  - Sus criterios valen para el panel unificado: superpuesto al hilo, filas de 64 px, chip tocable solo para «trabajando en #N» o «esperando tu respuesta», salto con resaltado.
  - Se le suman las acciones de administración al pie.

---

## U3 (P1) v1 frente a v2 desde el uso

Producción responde `uiShell: "v1"` (dato de @architect). Medido en Chromium con mock [V]: `shots/terminal.jsonl`, `kb.jsonl`, capturas `shots/{agent,terminal,sidebar,project}-*`.

| Aspecto | v1 | v2 | Mejor | Qué llevar a la interfaz única |
|---|---|---|---|---|
| **Desktop:** cuenta y app | «Templates» y «Logout» sueltos en el header | Un menú de cuenta (avatar) | v2 | v2 |
| **Desktop:** barra en Chat, Files y Git | Muestra herramientas del terminal en cualquier vista: Aa 14, Observers, Ports, buscar | Solo la sesión: nombre, estado, pestañas con ícono y ⋯. Observers y Ports pasan al ⋯; Aa y buscar quedan junto a las pestañas del terminal | v2 | v2 |
| **Teléfono:** cambiar de vista | Barra inferior de 54 px (Chat · Terminal · Files · Git), solo sobre las vistas superpuestas. Desde el Terminal hay que ir por el selector o el cajón | 4 íconos en la barra superior, siempre | v2 en consistencia; v1 en alcance del pulgar | v2. Los íconos de 40×44 quedan arriba: es aceptable, y la vuelta atrás del sistema cubre una mano |
| **Teléfono:** alto del hilo en el chat de agente (390×664) | 447 px (102 de cabecera + 55 de barra inferior) | **556 px** (46 de cabecera) | v2 (+109) | v2 |
| **Teléfono:** alto del Terminal (390×664) | **566 px** (pestañas del terminal y barra de sesión escondidas en el cajón ▾) | 526 px (fila de pestañas siempre visible, 38 px) | **v1 (+40 ≈ 2 filas [E])** | **Migrar:** una forma de esconder la fila de pestañas del terminal en el teléfono. Lo prevé `docs/design/ui-unificada.md` §5.3 («ocultable con un toque, estado persistido») y no está hecho |
| **Teléfono:** selector de sesión y conversación | «sesión › vista ▾» en el header, a un toque | En el cajón: ☰ y después «Go to a conversation…», dos toques; el header muestra el nombre | v1 por un toque | Conservar v2. El toque de más es menor que la fila que ahorra |
| **Teléfono:** Project Chat | 107 px de cabecera | 107 px de cabecera (igual) | — | La fila única de U2.2 |
| **Teléfono:** cuenta | Templates y Logout al pie del cajón | Igual (v2 no usa su menú de cuenta en el teléfono) | — | Un solo menú de cuenta (U4-4) |
| **Horizontal en teléfono** (844×358) | Layout de desktop: sidebar fijo de 260 px, dos cabeceras, sin barra de teclas en el Terminal | Igual | — | Layout de teléfono (U4-6) |

**Lo que notaría @owner el día que quede solo v2:**
- **Desktop:**
  - «Templates» y «Logout» pasan al menú del avatar.
  - Observers y Ports pasan al ⋯ de la sesión.
  - Aa y buscar quedan solo junto a las pestañas del Terminal.
- **Teléfono:**
  - Desaparece la barra inferior y las vistas pasan a íconos arriba.
  - Desaparece «sesión › vista ▾» del header.
  - El chat de agente gana unos 109 px de hilo.
  - **El Terminal pierde unos 40 px**: es lo único de v1 que propongo migrar.

**Peor resuelto en v2 que en v1:**
1. El alto del Terminal en el teléfono (arriba).
2. Un toque más para cambiar de conversación en el teléfono.
3. **Dos implementaciones del menú de cuenta dentro de v2**: el menú en desktop y los botones del cajón en el teléfono.

---

## U4 (P2/P3) Navegación, paneles y consistencia: lo que sigue duplicado o sobra

Sobre `d28dad7`, con lo resuelto en la iteración 3 excluido. Ordenado por valor.

| # | Qué | Evidencia | Acción |
|---|---|---|---|
| **1** | **Project Chat en el teléfono tiene dos filas arriba:** una de 44 px con solo ☰ y la cabecera de la página de 63 px. Son 107 px en v1 y v2. Es lo que más cuesta con el teclado (R4). | `shots/project-13-safari-v2.png`, `kb.jsonl` | **Unificar** en la fila de la barra (U2.2) |
| **2** | **Dos paneles para los mismos agentes** («Agentes del proyecto» y «Administrar agentes»), cada uno con su ×, más el sidebar. | `shots/panel-list-*.png`, `shots/panel-manage-*.png` | **Unificar** en un panel «Agentes» (U2.3) |
| **3** | **La × de la página de proyecto:** repite el sidebar y Atrás, y deja la dirección vacía. | `shots/x2.jsonl`, `shots/x-reload-*.png` | **Eliminar** (U2.1) |
| **4** | **El menú de cuenta en tres formas:** botones en el header de v1, menú de avatar en el desktop de v2, botones al pie del cajón en el teléfono (v1 y v2). | `shots/agent-1440-v1.png`, `agent-1440-v2.png`, `sidebar-13-safari-v2.png` | **Unificar** en el menú de cuenta de v2. En el teléfono, una sola fila «Cuenta» en el cajón que abre el mismo menú |
| **5** | **El ⋯ en tres variantes en la misma pantalla:** <ul><li>barra de sesión: `.btn.btn-icon.sm` con borde (`shell-v2.css:55-60`), 28×26;</li><li>cabecera de proyecto: `.pv-btn.pv-menu-btn` contorneado, 44×32;</li><li>filas del sidebar: sin borde.</li></ul> Además, la × es `.pv-close` (32×33). | `shots/project-1440-v2.png`, `shots/controls.jsonl` | **Unificar** en `.btn-icon` (base.css, #712). Es lo que #715 empezaba |
| **6** | **El teléfono en horizontal recibe el layout de desktop:** sidebar fijo de 260 px, header y cabecera de página (124 px), sin barra de teclas en el Terminal. Con teclado: 150 px visibles y la interfaz se desplaza (H1). | `shots/project-13-land-v2.png`, `terminal-13-land-v2.png`, `kb/agent-13-land-v2-3-sent.png` | **Conservar el layout de teléfono** cuando la altura es de teléfono (sidebar como cajón, una fila). Criterio: a 844×358 con puntero táctil, ningún panel fijo lateral y una sola fila arriba |
| **7** | **El ☰ mide 38×30 en el teléfono**, por debajo de 44 y en todas las vistas, mientras que todo lo demás de la barra ya mide ≥ 44. | `shots/controls.jsonl` (`Toggle sessions sidebar` 38×30) | **Unificar** como `.btn-icon` (44×44 con `pointer: coarse`) |
| **8** | **El margen bajo el composer es distinto entre chats:** Project Chat 12 px y chat de agente 0. | H4 | **Unificar** en un valor (R2) |
| **9** | **Componentes de v1 que duplican a v2:** <ul><li>barra inferior `#view-nav`, frente a las pestañas arriba;</li><li>cajón «chrome» (`#chrome-toggle`), frente a la barra siempre visible;</li><li>fila propia del agente en el teléfono v1 («@solo libre · Ajustes», 57 px), frente a la identidad en la barra;</li><li>selector «sesión › vista ▾» en el header, frente a «Go to a conversation…» del cajón.</li></ul> | `shots/agent-13-safari-v1.png`, `terminal-13-safari-v1.png` | **Eliminar con v1.** Solo se migra «esconder la fila de pestañas del Terminal» (U3) |
| **10** | **Portada vacía** «Select or create a session →»: en inglés, con una flecha hacia la derecha donde no hay nada (en el teléfono el sidebar está cerrado). Es el destino de la × y de la recarga del defecto U2.1. | `shots/home-13-safari-v2.png`, `home-1440-v2.png` | **Conservar y postergar.** @architect la dejó fuera en la iteración 3. Con la × eliminada, se llega menos a ella |

**Se conservan a propósito** (no son duplicados):
- «Conversations Ctrl K» en el header de desktop y «Go to a conversation…» en el cajón del teléfono: es la misma acción ubicada según el ancho.
- La × de los paneles.
- La lista del proyecto en el sidebar. Es navegación y el panel es estado y administración; con el panel único (U4-2) ya no se repite la administración.

---

## Lo que no pude demostrar y la evidencia que falta

1. **La causa en iPhone.** H1 y H2 son una hipótesis coherente con el síntoma, no una prueba. Falta, en el iPhone de @owner, Safari y app de inicio, en v1 (producción) y `?ui=v2`, en los dos chats:
   - una lectura de `?vvdebug=1` al tocar el campo y al enviar;
   - si es posible, el `scrollTop` de `#terminal-area` y `#project-view` en el instante del salto.
2. **Las alturas reales de Safari y del teclado** (barra de sugerencias, barra de Safari compacta o expandida). Las que usé son estimaciones.
3. **H6** (crecer el campo estando al final): resultados distintos entre corridas. @qa debería repetirlo esperando unos 300 ms.
4. **WebKit:** no hay WebKit de Playwright en esta máquina. Todo es Chromium.
5. **Lector de pantalla y teclado físico** en los paneles unificados: no se evaluaron porque la propuesta no está implementada.
