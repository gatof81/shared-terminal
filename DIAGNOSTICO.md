# Auditoría UI/UX: diagnóstico priorizado (2026-11-20)

**Base:** `main` @ d3b042e (incluye #700–#706).
**Cómo:** Playwright con Chromium headless y el mock backend de `frontend/e2e/` (ACP y proyectos activados).
- 8 configuraciones: desktop 1280×800, wide 1920×1080, tablet 820×1180 y teléfono 390×844, cada una con shell v1 y v2.
- Capturas en `before/<config>/` y mediciones en `before/metrics.jsonl`.

**Límites:**
- Solo Chromium, nada probado en Safari ni WebKit.
- Mock backend: no hay datos reales ni latencia real.

**Artefactos del entorno de prueba, no son hallazgos:**
- El glifo ⎕ del logo y de algunos botones (falta en las fuentes vendorizadas).
- La fuente monoespaciada en las burbujas enviadas (el CSS de e2e fuerza mono sobre `pre`).
- El toast "GPU rendering unavailable" (WebGL está desactivado en el harness).

## Mediciones clave

| Medida | Valor |
|---|---|
| Chat ACP en wide 1920: distancia entre el borde derecho del pedido y el izquierdo de la respuesta | **1632 px** (`wide-v2/03-acp-chat.png`) |
| Project Chat en wide 1920: el mismo ancho de lectura | 882 px, en una caja de 912 px centrada (`wide-v2/02-project-chat.png`) |
| Chat ACP desktop v2: cromo antes del primer mensaje (header 57, barra de sesión 40, header del agente 45) | **142 px = 18 %** de 800 px |
| Project Chat en teléfono: cromo superior (header con solo ☰ y 👤, más el header del proyecto) | **109 px** de 844 |
| Chat ACP en teléfono v2: cromo superior (barra fusionada) | 47 px, buena referencia |
| Teléfono v1: barra inferior de vistas en overlays | 55 px adicionales |

## Hallazgos, por prioridad

### P1: alto impacto, criterio claro

1. **Ancho de lectura inconsistente entre los dos chats.**
   - **Problema:** el chat ACP individual ocupa todo el ancho: en 1920 el pedido queda pegado a la derecha y la respuesta a la izquierda, y el composer mide 1630 px. Project Chat, en cambio, tiene un máximo de unos 912 px, centrado y enmarcado con borde. En una pantalla grande, ninguno de los dos aprovecha el espacio: uno lo estira y el otro lo deja vacío.
   - **Propuesta:** una sola columna de lectura compartida (unos 56rem) para hilo y composer en ambos chats, sin la caja con borde.
   - Capturas: `wide-v1/03-acp-chat.png`, `wide-v2/02-project-chat.png`.
2. **Cromo apilado en el chat ACP (desktop).**
   - **Problema:** la barra de sesión dice `scratch RUNNING` y debajo el header del agente repite `@solo libre` y suma `Ajustes`. Son dos filas para la misma identidad.
   - **Propuesta:** llevar la identidad y el estado del agente, más Ajustes, a la barra de sesión cuando la sesión es de un agente. Así se recuperan unos 45 px. En teléfono v2 ya funciona así.
   - Captura: `desk-v2/03-acp-chat.png`.
3. **Project Chat en teléfono desperdicia la primera fila.**
   - **Problema:** el header global solo tiene ☰ y 👤, y el título del proyecto ocupa otra fila de 64 px. Además, el hilo queda dentro de una caja con borde y márgenes de 16 px.
   - **Propuesta:** el título, los avatares y ⋯ en la fila del header, igual que la barra fusionada de la sesión. Hilo sin caja.
   - Captura: `mob-v2/02-project-chat.png`.
4. **El estado de error de Project Chat se contradice.**
   - **Problema:** se muestran tres mensajes a la vez: «No se pudo cargar el proyecto» con Reintentar, «Sin mensajes en este proyecto todavía…» (falso, porque no se sabe) y «No se pudo actualizar: internal» (código crudo).
   - **Propuesta:** un solo estado de error con Reintentar, sin estado vacío y sin códigos internos.
   - Captura: `desk-v2/10-project-feed-error.png`.
5. **La pantalla de inicio sin sesión no orienta.**
   - **Problema:** «Select or create a session →» apunta a la derecha, pero la lista está a la izquierda, y en teléfono está escondida en el drawer. No hay ningún botón.
   - **Bug en teléfono v2:** sin sesión abierta se ven los controles de terminal (⎕, `Aa 14`) abajo a la derecha (`mob-v2/01-home.png`).
   - **Propuesta:** un estado vacío con acciones (Nueva sesión, Nuevo proyecto y, en teléfono, Ver sesiones), y ocultar `#terminal-tabs` cuando no hay sesión.

### P2: consistencia (algunas necesitan decisión)

6. **Idioma mezclado** (decisión de @owner).
   - **Problema:** la parte ACP y de proyectos está en español («libre», «hecho», «Ajustes», «Nuevo proyecto», «Crear», «Reintentar»). El resto está en inglés: «PROJECTS», «Show terminated», «+ New session», «Templates», «Logout», «Stopped», «Waiting for input».
   - **Casos mixtos en un mismo elemento:** el diálogo «Nuevo proyecto» tiene los botones «Cancel» y «Crear», y el formulario «New session» incluye «Agente ACP (opcional)».
   - Capturas: `desk-v2/07-new-project.png`, `desk-v2/06-new-session.png`.
7. **Vocabulario de estado sin sistema.**
   - **Problema:** coexisten `RUNNING` (chip relleno en mayúsculas), `STOPPED`, «Stopped» (texto gris), `libre` (pill con borde), «hecho» (texto verde suelto), «Waiting for input», «Ended» y un punto verde suelto en el header sin etiqueta.
   - **Propuesta:** un solo componente de chip de estado con tres variantes (activo, atención, inactivo), reutilizando los tokens actuales.
8. **La jerarquía del sidebar es confusa.**
   - **Problema:** el orden es «PROJECTS [+]», después «Show terminated ↻», después «+ New session» y recién ahí la lista de proyectos. Los controles de sesiones quedan entre el título de proyectos y sus proyectos.
   - **Teléfono:** el botón «+» de proyecto mide 44×44 junto a una etiqueta de 11 px.
   - **Propuesta:** primero la acción primaria, después las secciones, y el filtro dentro de un menú.
   - Capturas: `desk-v1/01-home.png`, `mob-v2/01b-sidebar-open.png`.
9. **En desktop, los menús son diálogos centrados** (v2; decisión, porque es un componente compartido).
   - **Problema:** «Account» tiene solo 2 ítems y el ⋯ de sesión abre un diálogo modal en el centro, lejos del botón que lo abrió. En desktop se espera un popover anclado. En teléfono la hoja está bien.
   - Capturas: `desk-v2/07b-user-menu.png`, `desk-v2/07c-session-menu.png`.
10. **Cierre inconsistente.**
    - **Problema:** la página de proyecto tiene un «×» sin destino claro. El chat ACP no lo tiene, y Files y Git usan las pestañas.
11. **Composer de Project Chat.**
    - **Problema:** escribir «@» no sugiere agentes (no hay autocompletado y los destinatarios están detrás del «+»). El placeholder ocupa dos líneas en tablet.
    - Capturas: `desk-v2/02b-project-chat-mention.png`, `tab-v2/02-project-chat.png`.
12. **Botones sin escala de tamaños.**
    - **Desktop (medido):** el refresh del sidebar mide 23×15, las pestañas de vista en v1 20 px de alto, el ⋯ de sesión 23, Templates/Logout/Ajustes 24, el «+» de proyecto 29, «+ New session» 31, el ⋯ de proyecto 32 y el menú de usuario 32.
    - **Teléfono, por debajo de 44 px:** el refresh del sidebar mide **23×15** (es un objetivo táctil), y el menú de usuario y el ⋯ de sesión miden 34×34.
    - **Propuesta:** dos alturas en desktop (28 para los botones compactos y 32 para el resto) y un mínimo táctil de 44.

### P3: menor o para más adelante

13. En tablet vertical (820), el sidebar fijo de 260 px se queda con el 32 % del ancho y no hay modo compacto. Se puede ocultar con ☰, pero no se recuerda la elección.
14. **v1 vs v2:**
    - v2 resuelve mejor el teléfono: barra fusionada, sin barra inferior y sin el drawer de cromo que redimensiona la terminal.
    - En desktop, v1 todavía muestra «Session:» y los botones Aa/Observers/Ports con texto.
    - **Recomendación:** diseñar las mejoras nuevas pensando en v2 y verificarlas en v1. No propongo cambiar el shell predeterminado.

### Aportes de @architect (msg #460, no verificados por mí todavía)

15. «Go to a conversation…» (Ctrl K) no conoce proyectos ni agentes ACP. Afecta la navegación entre proyectos, agentes y sesiones, uno de los objetivos especiales.
16. En shell v1, la pestaña Chat va última y los controles de terminal se ven apagados en Chat.
17. A 320 px, el grupo de avatares corta enseguida el título de Project Chat.
18. Limpieza: 27 reglas CSS sin uso en `projects.css` y rutas `/team` que ya muestran Project Chat.
19. Un agente que figura «trabajando» con el runner muerto necesita backend; queda fuera de este alcance.

### Aportes de @qa (msg #461, heredados o aceptados, no bloqueantes)

20. «Nueva sesión» (diálogo común) en teléfono: Escape devuelve el foco a `#new-session-btn`, que queda oculto dentro del drawer cerrado. Es un problema real de accesibilidad y foco.
21. «Nueva sesión»: un puerto inválido no lleva a la pestaña Ports, y el error queda en una pestaña que no se ve.
22. Idioma mezclado dentro de «Nueva sesión»: Repo, Env, Ports, Advanced y el modo común están en inglés, y el modo agente en español. Se suma al punto 6.
23. En desktop, «+» y la flecha miden 40×40, ⋯ mide 44×32 y × 32×33. Se suma al punto 12 (escala de botones).
24. **Sin validar en ningún lado:** Safari/WebKit e iPhone real (riesgo principal: que tocar «+» o Enviar cierre el teclado de iOS) y un lector de pantalla real.

25. Un proyecto archivado sin mensajes dice «Sin mensajes… Mencioná a un agente para empezar», pero es de solo lectura y no se puede escribir. El estado vacío tendría que decir que el proyecto está archivado y no tiene historial. Lo encontré verificando el #708.

26. Un error de envío todavía muestra el código del servidor: «No se envió a @arq: internal. …». Es heredado y lo marcó @qa en la revisión del #709. Pide el mismo arreglo que tuvo el feed: un texto fijo que conserve la segunda frase.

## Propuesta de las 5 mejoras (a acordar con @architect)

| # | Mejora | Tamaño | Quién |
|---|---|---|---|
| A | Columna de lectura común para chat ACP y Project Chat, más el hilo sin caja | S, mayormente CSS | @designer |
| B | Estado de error único en Project Chat | S | @designer o @developer |
| C1 | Bug: los controles de terminal se ven en teléfono v2 sin sesión | S | @designer |
| C2 | Estado vacío de inicio con acciones que ya existen (es una decisión de producto, pendiente de @owner) | S | @designer, si @owner lo aprueba |
| D | Project Chat en teléfono: fusionar la barra superior de la app (45 px, solo ☰ y 👤) con el header del proyecto (64 px). Es un cambio de shell que se comporta distinto en v1 y v2; espera la validación de #706 en iPhone | M | @owner decide, @developer implementa |
| E | Chat ACP en desktop: identidad del agente en la barra de sesión, sin segundo header. Condición: el alto de `#terminal-toolbar` no cambia entre vistas (si cambia, hay un resize de tmux, y el e2e del invariante lo prohíbe), en v1 y en v2. Depende de #644 | M | @owner decide; @architect revisa el diseño antes de que llegue a @developer |

## Decisiones pendientes de @owner

1. Idioma de la UI: todo en español, todo en inglés o i18n. Afecta casi todas las pantallas, así que conviene decidirlo antes de unificar textos.
2. Menús en desktop: popover anclado o diálogo centrado (como hoy).
3. Reestructurar el sidebar (punto 8).
4. En pantallas de 1440 px o más, ¿usar el espacio libre a los costados del chat para un panel lateral (agentes del proyecto y su actividad)? La otra opción es solo centrar.
