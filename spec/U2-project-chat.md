# U-2 · Project Chat: especificación única

Pedido de @architect (#649), para @developer y @qa. Base: `d28dad7`, interfaz única (v2).
Junta y **reemplaza** dos documentos anteriores:
- la sección U2 de `audit/DESIGNER.md` (`assets/audit-2026-11-designer` @ `cedd720`);
- `agents-list/AGENTES-LISTA.md` (`assets/ux-iter3`).

Donde difieran, vale este. #715 (`feat/project-chat-bar` @ `70e7b3a`) y #718 (`feat/project-agents-goto` @ `a7dd852`) están cerrados: se puede reutilizar su código, pero la referencia es este documento.

**Lo que no cambia:** los textos (en español, como están hoy), los tokens y `.btn`, `.btn-icon` y `.chip` (#712). No hay componentes nuevos.

---

## 1. Qué se elimina

| Qué | Dónde está hoy | Por qué |
|---|---|---|
| La × de la página (`pv-close`, «Cerrar el proyecto») y `leavePage` | `projectsView.ts:264-268`, `:311` | Repite el sidebar, el cajón y Atrás, y deja la dirección vacía (defecto de la auditoría U2.1) |
| El panel «Administrar agentes» y su entrada en el ⋯ | `acpProjectChat.ts:207-251`, `projectsView.ts:287` | Se une con «Agentes del proyecto» en un solo panel (§3) |
| El párrafo de ayuda del panel (`acp-project-help`) | `acpProjectChat.ts:205` | El placeholder del composer ya lo dice |
| En el teléfono, la fila propia de la cabecera del proyecto (63 px) | `pv-header` | Su contenido pasa a la fila del header (§2.1) |

---

## 2. Cabecera

### 2.1 Teléfono (≤ 768 px): una sola fila, la del header

```
┌───────────────────────────────────────────────┐
│ ☰ │ Educación HZ…          │ (A)(B)(C)+2 ●│ ⋯ │ (👤) │   44 px
└───────────────────────────────────────────────┘
```

| Criterio | Valor medible |
|---|---|
| Filas encima del hilo | **Una**, la del header: 44 px (≤ 46). Hoy son 107 (44 + 63). |
| Contenido, en orden | ☰ · título del proyecto · grupo de avatares · ⋯ del proyecto · cuenta (solo con ≥ 400 px, según U-1 A.3) |
| ☰ | 44×44. Hoy mide 38×30 (auditoría U4-7). |
| Título | 15 px, peso 600, una línea con elipsis, ocupa todo el ancho libre. Sigue siendo `h2#pv-title` con `tabindex=-1`, que recibe el foco al entrar. A 320 caben al menos 8 caracteres. |
| Grupo de avatares | Botón de ≥ 44 px de alto: 3 avatares de 24 px superpuestos, «+N» y el punto de estado (como hoy). Con 0 agentes muestra un solo avatar «+», con nombre accesible «Agregar agentes». |
| ⋯ del proyecto | `.btn-icon` de 40×44, el mismo que el ⋯ de la sesión en la barra. |
| Controles de la sesión de debajo | Ni las pestañas de vista ni el ⋯ de la sesión se ven ni reciben foco o toques mientras se ve el proyecto (hoy: `shell-v2.css:187-188`). |
| Alto del header | **Δ = 0 px** al entrar y salir del proyecto. El header es parte de la caja del terminal: ningún `resize` al entrar o salir. |

### 2.2 Desktop (> 768 px)

- El header de la app queda como está.
- La cabecera del proyecto es **una fila de ≤ 48 px**: título · grupo de avatares · ⋯. No hay ×.
- El ⋯ es el mismo `.btn-icon` de la barra de sesión (hoy es `.pv-btn` contorneado de 44×32: auditoría U4-5).

### 2.3 ⋯ del proyecto

Lleva dos ítems: **Renombrar** y **Archivar** (`danger`, con el hint actual). Solo aparece en un proyecto activo, como hoy.

### 2.4 Notas de estado

«Proyecto archivado · solo lectura», «Proyecto no encontrado.» y los errores se muestran como hoy. En el teléfono van como **una línea al tope del área del hilo**, no como una fila más de cabecera. Esa línea mide ≤ 32 px y es la misma `pv-status`.

---

## 3. Panel «Agentes» (uno solo)

Se abre desde el grupo de avatares y reúne lo que hoy hacen los dos paneles.

### 3.1 Contenido

```
┌ Agentes ──────────────────────────────── × ┐  cabecera fija, 44 px
│ (A) @arq                 [Abrir su chat] ⋯ │  fila, 64 px
│     ● esperando tu respuesta ›             │
├────────────────────────────────────────────┤
│ (D) @infraestructura-y…  [Abrir su chat] ⋯ │
│     ● trabajando en #7 ›                   │
├────────────────────────────────────────────┤
│ (C) @rev                 [Abrir su chat] ⋯ │
│     ○ libre                                │
├────────────────────────────────────────────┤  pie fijo
│ [Agregar agente existente…      ▾] [Agregar]│
│ [+ Nueva sesión con agente]                │
└────────────────────────────────────────────┘
```

- **Título:** «Agentes». El nombre accesible de la región es «Agentes del proyecto».
- **Orden de las filas** (como hoy): primero quien te necesita, después quien trabaja y después el resto.
- **El ⋯ de la fila:** `.btn-icon`, 44×44 en táctil, nombre accesible «Acciones de @nombre». Abre un menú con un ítem, **«Quitar del proyecto»** (`danger`). Mantiene el `confirmDialog` actual (`acpProjectChat.ts:432`).
- **Pie fijo** (fuera del scroll):
  - Una fila con el selector «Agregar agente existente…» y «Agregar» (`.btn.sm`). Solo aparece si hay agentes fuera del proyecto.
  - «+ Nueva sesión con agente» (`.btn.sm`), que hace lo que hace hoy.
  - Un separador de 1 px `--c-border-soft` encima del pie.
- **Proyecto sin agentes:** el panel se abre solo al entrar (hoy se abre el de administración). Muestra la cabecera, el texto «Todavía no hay agentes en este proyecto.» y el pie.
- **Proyecto archivado o no confirmado:** las filas sin ⋯ y sin pie (solo lectura, fail-closed como hoy).

### 3.2 Posición: superpuesto en todos los anchos

Esto simplifica AGENTES-LISTA, que en desktop lo dejaba en el flujo: un comportamiento en vez de dos.

| Criterio | Valor medible |
|---|---|
| Flujo | `position: absolute`, por encima del hilo. Al abrir o cerrar, el `top`, el alto y el `scrollTop` del hilo **no cambian** (Δ = 0 px). |
| Teléfono (≤ 640 px) | Borde superior a 4 px del borde inferior del header. 8 px a cada lado (a 320 px: x = 8, ancho 304). |
| > 640 px | Ancho de 400 px. Borde derecho alineado con el borde derecho del grupo de avatares. Borde superior a 4 px de la cabecera del proyecto. |
| Borde inferior | Siempre ≥ 8 px por encima del composer, que **nunca queda tapado**, con o sin teclado. |
| Alto máximo | `min(60 % del alto visible, espacio hasta el composer − 8 px)`. Con pocos agentes, el alto del contenido. |
| Scroll | Solo la lista de filas, con `overscroll-behavior: contain`. La cabecera (44 px, borde inferior de 1 px `--c-border-soft`) y el pie quedan fijos. |
| Superficie | `--c-surface`, borde de 1 px `--c-border`, `--radius-m` y la sombra de `.chat-end`. |

### 3.3 Fila

Es la de AGENTES-LISTA §2.2, con el ⋯ de la fila agregado:

| Criterio | Valor medible |
|---|---|
| Grilla | `24px minmax(0,1fr) auto auto`, column-gap 8 px, padding vertical 8 px. El avatar, el botón y el ⋯ ocupan las dos líneas. |
| Alto | 64 px (±1) en **todas** las filas, sea cual sea el nombre o el estado. |
| Nombre | `@nombre`, una línea con elipsis, 14 px, peso 600, `--acp-hue`. El nombre completo en `title`. A 320 px caben al menos 10 caracteres. |
| Estado | `.chip` en la línea 2, sin recortarse ni partirse. Tonos: `warn` para esperando respuesta o login, `busy` para trabajando, `ok` para libre o en espera y `off` para sin señal o iniciando. |
| «Abrir su chat» | `.btn.sm` (44 px de alto en táctil). Nombre accesible «Abrir su chat (@nombre)». |
| Solapes | Ninguno entre las cajas ni entre las áreas táctiles. Se mide con `getBoundingClientRect` a 320 px y `@infraestructura-y-despliegues`. |
| Separador | 1 px `--c-border-soft` entre filas. |

### 3.4 Estado tocable (el salto al mensaje en curso)

Es igual que AGENTES-LISTA §2.4, sin cambios.
- **Cuándo es tocable:** solo «trabajando en #N» y «esperando tu respuesta», y entonces se muestra como `<button class="chip">` con `›`. El resto es `<span class="chip bare">`: no recibe foco.
- **Al tocarlo:**
  1. Se cierra el panel.
  2. El mensaje (o su `.acp-question`) queda con el borde superior al 25 % del alto del hilo (±8 px).
  3. Se resalta con sombra de 2 px más fondo, 1200 ms, y se desvanece en 600 ms. El resaltado no cambia el layout.
  4. El foco pasa al destino.
  5. Si el mensaje no está cargado, se cargan las páginas anteriores, con `aria-busy` mientras tanto. Si no aparece, se muestra el error en la línea de avisos del composer: nunca falla en silencio.
- **Con `prefers-reduced-motion`:** el salto es instantáneo y el resaltado dura 1500 ms sin transición.

### 3.5 Cierre y foco

- **Cómo se cierra:** con la × de la cabecera (44×44), con Escape, tocando de nuevo el grupo de avatares o tocando fuera. Tocar fuera solo cierra: ese toque no llega al hilo.
- **Elegir una acción** (abrir chat, saltar al mensaje, agregar, nueva sesión) cierra el panel y el foco va al destino.
- **Cerrar con ×, Escape, toque fuera o el grupo:** el foco vuelve al grupo de avatares.
- **Quitar un agente:** el panel queda abierto y el foco va a la fila siguiente o, si no la hay, al selector del pie.
- **Al abrir:** el foco va a la primera acción de la primera fila, o al selector del pie si no hay agentes.

---

## 4. Navegación y dirección

| # | Regla | Cómo se mide |
|---|---|---|
| N1 | Ningún control de la página del proyecto navega a «la sesión de debajo». Solo quedan la × de los paneles, que cierra un panel. | No hay `.pv-close` fuera de un panel. |
| N2 | **Siempre hay una salida visible:** ☰ en el teléfono y el sidebar en desktop. Vale en los cuatro estados (activo, archivado, no encontrado, error), con y sin agentes, y entrando por enlace directo, por recarga o desde la app instalada sin historial. | En cada estado, a 320, 390 y 1280: ☰ visible de ≥ 44×44, o sidebar visible. |
| N3 | **La dirección nunca queda vacía.** Mientras se ve el proyecto, `location.hash` es `#/projects/<pid>/chat`. Toda acción de la app que sale del proyecto lleva a una dirección que se puede recargar (sesión, chat de agente u otro proyecto). | Después de cada acción del §3 y del ⋯: `location.hash !== ""`. Al recargar, se ve lo mismo que antes de recargar. |
| N4 | **Archivar** deja la página en el estado «archivado · solo lectura», con la misma dirección. Ya no hace `leavePage` (`projectsView.ts:361`). Para salir se usa N2. | Después de archivar: el hash no cambió, se ve la nota de archivado y no hay composer. |
| N5 | **«Abrir su chat»** es una entrada de historial (`pushState`): Atrás vuelve al proyecto con el hilo donde estaba. | Abrir el chat → Atrás: el hash del proyecto y el mismo `scrollTop` (±1 px). |
| N6 | **Entrar al proyecto** no cambia la sesión activa ni su terminal: 0 `resize` al entrar y al salir. | Spec de invariante: entrar al proyecto y salir por el sidebar o Atrás, 0 frames `resize`. |

---

## 5. Qué mide @qa (resumen ejecutable)

Medidas a 320×568, 390×844, 390×450 (teclado simulado) y 1280×800.

1. **Teléfono:** hay una fila arriba del hilo, de alto ≤ 46 px, con ☰, título, grupo y ⋯. El header mide lo mismo dentro y fuera del proyecto.
2. **Desktop:** la cabecera del proyecto es de una fila de ≤ 48 px y no tiene ×.
3. **El ⋯ del proyecto** tiene exactamente Renombrar y Archivar.
4. **Hay un solo panel de agentes en el DOM** (`#acp-agents-panel` ya no existe). Al abrirlo y cerrarlo, el `top`, el alto y el `scrollTop` del hilo cambian 0 px.
5. **Posición del panel:** a 4 px de lo que lo abre, a ≥ 8 px del composer (también con teclado) y con alto ≤ 60 % de lo visible. Con 7 agentes, a 390×450, el scroll queda solo en la lista y el pie está visible.
6. **Filas:** todas de 64 ± 1 px, sin solapes a 320 px, con el nombre en una línea y una elipsis.
7. **Áreas táctiles** ≥ 44 px de alto: ☰, grupo, ⋯ del proyecto, × del panel, «Abrir su chat», ⋯ de la fila y chip tocable.
8. **Quitar** pasa por el ⋯ de la fila y una confirmación. Después de quitar, el agente aparece en «Agregar agente existente…».
9. **Proyecto sin agentes:** el panel se abre solo y muestra el texto y el pie.
10. **Chip tocable frente a no tocable:** se distinguen sin depender del color. El salto deja el destino al 25 % (±8 px), con el resaltado visible a los 200 ms y quitado a los 2000 ms.
11. **Cierre y foco** como en §3.5.
12. **Navegación N1–N6.**
13. **Archivado y no encontrado:** el panel queda en solo lectura, sin ⋯ de fila ni pie, y N2 se cumple.

Chromium solo. El comportamiento con el teclado real de iOS lo juzga @owner en su iPhone y queda en el hito del teclado.
