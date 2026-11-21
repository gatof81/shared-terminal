# U-1 · Menú de usuario declarado y ocultar las pestañas del Terminal en el teléfono

Pedido de @architect (#649), para @developer. Base: `d28dad7`. Interfaz única = la actual v2.
No es un rediseño: fija lo que ya hace el menú del avatar y agrega un único control nuevo. Los textos quedan en inglés, como están.

---

## A. Menú de usuario

### A.1 Qué cambia

Hoy `shellV2.ts:77-106` **arma el menú copiando** los botones del grupo del header de v1 (`#templates-btn` … `#logout-btn`, `index.html:138-143`).
En el teléfono, por debajo de 400 px, la cuenta pasa a la otra copia: los botones `#sidebar-*-btn` del pie del cajón (`index.html:214-221`, `shell-v2.css:259-274`).

Con v1 eliminado queda **una sola lista declarada** en código, con los ítems explícitos y un único `onPick` que llama a la acción directamente (`openTemplates…`, `openInvitesModal`, …). Se eliminan los dos grupos de botones ocultos y su sincronización (`main.ts:400-406`, `main.ts:423-445` para las dos copias de notificaciones).

### A.2 Ítems y orden (el orden de hoy)

| # | Ítem (label) | Quién lo ve | Tipo |
|---|---|---|---|
| 1 | Templates | todos | normal |
| 2 | Invites | solo admin | normal |
| 3 | My groups | solo si lidera algún grupo (`lead`) | normal |
| 4 | Admin | solo admin | normal |
| 5 | Enable notifications / Disable notifications / Install to enable notifications | solo cuando hoy se muestra (la lógica de `main.ts:423-445`, sin cambios); el label y el `hint` son los del estado | normal |
| — | **separador** | | |
| 6 | Logout | todos | `danger` |

- **Título del menú:** el nombre del usuario (lo que hoy muestra `#sidebar-user-display`). Si no se conoce, «Account».
- **Separador:** uno solo, antes de Logout. Se implementa con CSS en el ítem, sin un componente nuevo: `.action-menu .kind-danger { border-top: 1px solid var(--c-border-soft); margin-top: 4px; }`.
- **Un admin (= @owner) ve** los ítems 1, 2, 4, 6 y, si corresponde, el 5. El 3 solo aparece si lidera un grupo.
- **Un usuario sin admin ve** los ítems 1, 6, el 3 si lidera y el 5 si corresponde.
- Un ítem que no corresponde **no se muestra**; no se muestra deshabilitado.

### A.3 Dónde se abre

| Ancho | Abridor |
|---|---|
| > 768 px | `#user-menu-btn` (avatar), al final del header, como hoy. |
| 400–768 px | `#user-menu-btn` en la barra unificada, 44×44, como hoy (`shell-v2.css:253-257`). |
| < 400 px | **Una sola fila «Account»** al pie del cajón (reemplaza los 6 botones de `#sidebar-footer`): un `.btn` de ancho completo, 44 px de alto, que muestra el nombre del usuario a la izquierda y abre **el mismo menú**. Al tocarla se cierra el cajón y se abre el menú. Nombre accesible: «Account and app menu». |

El menú es el mismo `openActionMenu` en todos los anchos, con su presentación actual en el teléfono. Escape o × lo cierran y el foco vuelve al abridor; si el abridor era la fila del cajón, vuelve al ☰.

### A.4 Qué verifica @qa

1. Con un admin, el menú tiene exactamente: Templates, Invites, Admin, (notificaciones si aplica), separador y Logout, en ese orden. Sin admin: Templates, (My groups), (notificaciones) y Logout.
2. A 1280, 768, 400 y 390 hay un solo abridor visible y es el avatar. A 399, 360 y 320 el abridor es la fila del cajón y no hay avatar en la barra.
3. Cada ítem hace lo mismo que su botón actual (abre el mismo modal; Logout cierra la sesión).
4. No quedan en el DOM `#templates-btn`…`#logout-btn` ni `#sidebar-templates-btn`…`#sidebar-logout-btn`.
5. El foco vuelve al abridor al cerrar; ↑ y ↓ recorren los ítems, como hoy.

---

## B. Ocultar la fila de pestañas del Terminal en el teléfono

### B.1 Por qué

Es lo único de v1 que se conserva (auditoría, U3). En el teléfono v2, la fila `#terminal-tabs` (pestañas, buscar, Aa, +) está siempre visible y le quita **unos 40 px** al Terminal: 526 px frente a 566 en v1, a 390×844 (medido en la auditoría, Chromium).

### B.2 El control

- **Dónde vive:** como **primer ítem del ⋯ de la sesión** (`#session-menu-btn`), usando `setSessionMenuExtras` (`sessionCore.ts:285-307`), el mismo mecanismo de «Ajustes del agente».
- **Cuándo aparece:** solo con ≤ 768 px, en la vista **Terminal** y en una sesión con al menos una pestaña. En desktop, en Files, Git o Chat, o sin pestañas, no aparece.
- **Label:** «Hide tabs» cuando la fila está visible y «Show tabs» cuando está oculta. Hint: «Tabs, search and text size row». Tipo `normal`.
- **Cómo se vuelve a mostrar:** con el mismo ítem, «Show tabs». No hay otro control ni un gesto.
- **Estado:** uno por dispositivo, guardado en `localStorage` (`st.terminalTabsHidden = "1"`). Por defecto, visible. Sobrevive a la recarga, al cambio de sesión y al cambio de vista.
- **Implementación esperada:** un atributo en `<html>` (por ejemplo `data-tabs="hidden"`) y **una regla** dentro de `@media (max-width: 768px)`: `html[data-tabs="hidden"] #terminal-tabs { display: none; }`. En desktop la regla no aplica, aunque el valor esté guardado.

### B.3 Invariante de cero resize (no negociable)

- El estado **no depende de la vista**: Files, Git y Chat se superponen a `#terminal-area` como hoy, y la fila conserva el mismo estado debajo. **Cambiar de vista con la fila oculta o visible no cambia la caja del terminal** y no envía ningún `resize`.
- El **único** momento en que la caja cambia es cuando la persona toca «Hide tabs» o «Show tabs». Ahí hay exactamente un fit y un `resize`, como al cambiar Aa o rotar el teléfono. Es intencional.
- Nada oculta ni muestra la fila automáticamente: ni el teclado, ni elegir una pestaña, ni abrir una sesión. Se descarta el colapso automático de v1 (`main.ts:1052-…`).

### B.4 Qué se pierde mientras está oculta (aceptado)

Las pestañas, buscar, Aa y + (Insert) quedan inaccesibles hasta tocar «Show tabs». La barra de teclas inferior (`#key-bar`) no cambia. Si la sesión se queda sin pestañas, el panel de estado del terminal ya ofrece «Open a tab», así que no hace falta una excepción.

### B.5 Qué verifica @qa

1. A 390×844, vista Terminal con una pestaña: en el ⋯ el primer ítem es «Hide tabs». Al tocarlo, `#terminal-tabs` deja de verse y `#terminal-container` gana el alto de la fila (≈ 40 px, ±2). En el ⋯ el ítem pasa a decir «Show tabs».
2. Con la fila oculta, Terminal → Files → Git → Chat → Terminal: **0 frames `resize`** (la misma medición del spec de invariante en los proyectos `*-v2`), y el alto de `#terminal-container` es idéntico antes y después. Lo mismo con la fila visible.
3. «Hide tabs» y «Show tabs» envían exactamente un `resize` cada uno.
4. Al recargar, la fila sigue oculta. A 1280 la fila se ve, y el ⋯ no tiene el ítem aunque el valor esté guardado.
5. En Files, Git o Chat y en una sesión sin pestañas, el ítem no aparece.
6. Abrir y cerrar el teclado, o elegir una pestaña, no cambia el estado de la fila.
