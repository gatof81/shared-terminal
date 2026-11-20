# «Agentes del proyecto» en el teléfono: diagnóstico y criterios

Pedido de @owner (#571), encargado por @architect (#575). Es para que @developer implemente y @qa valide.

**Base:** `feat/project-chat-bar` @ `3111bef` (#715, tope de la pila).
**Cómo se midió:** Playwright con Chromium 1x y el mock backend del e2e.
- Proyecto «Educación HZ» con **2 agentes** (@arq esperando respuesta, @dev trabajando en #12) y con **7 agentes**, sumando nombres largos y los estados login, en espera y sin señal.
- Tamaños 320, 390 y 390x450 (teclado), v1 y v2; 1280 v2 como referencia.
- Datos: `measure.jsonl`. Script: `iter3-agl.spec.ts`.
- **Solo probé Chromium; Safari/iOS no.**

Capturas en `before/`: `list2-*`, `list7-*` y `list7-scrolled-*` (`<tamaño>-<shell>`).

---

## 1. Diagnóstico

| # | Problema | Evidencia |
|---|---|---|
| D1 | **El panel empuja el hilo y se lo come.** Es un bloque en el flujo, entre el header y el hilo, de hasta el 40 % del alto visible. | 390x450 v1 con 2 agentes: al hilo le quedan **96 px**; con 7, también 96. En v2, 133 a 139 px. A 320 v1, 152 a 158 px. Abrir y cerrar la lista mueve todo el hilo. |
| D2 | **Las filas se parten en 2 o 3 líneas sin orden.** El `flex-wrap` deja el nombre, el estado y «Abrir su chat» donde caen. | A 320, cada fila mide **73 px** (2 líneas) y la de un nombre largo **87 px**, con el nombre partido en 2 líneas (36 px). «Abrir su chat» queda solo en una línea, a la derecha y debajo (`list7-320-v2`). A 390, con nombres largos, 73 px. Ninguna fila tiene el mismo alto que otra. |
| D3 | **Con 7 agentes entran 2½ filas a 320.** | Panel de 227 px con 583 px de contenido: se ven 2 filas y media, y la tercera queda cortada por el borde (`list7-320-v2`). |
| D4 | **El estado es una pastilla con borde** (`.acp-status`), **no el `.chip` de #712.** | Es otro vocabulario que el del sidebar y el de la barra. Además, una pastilla con borde ya parece un botón, y el pedido nuevo necesita distinguir un estado tocable de uno que no se toca. |
| D5 | **«Abrir su chat» es texto subrayado repetido en cada fila.** | 72×44 en cada fila. Es lo más llamativo de la fila y queda fuera de lugar cuando se parte la línea. |
| D6 | **Al bajar, el título fijo tapa la fila.** | `list7-scrolled-390x450-v1`: el estado «3 en espera» y el enlace de la fila anterior quedan cortados a medias bajo la cabecera fija. Es correcto que la cabecera quede fija, pero sin separación se lee como un recorte. |

**Lo que está bien y se conserva:**
- la × de 44×44 en la cabecera fija;
- Escape cierra y el foco vuelve al grupo de avatares;
- el orden: primero quien te necesita, después quien trabaja y después el resto;
- el scroll interno con `overscroll-behavior: contain`;
- en desktop, el panel dentro de la columna.

---

## 2. Criterios del arreglo

Solo se usan `.btn`, `.btn-icon` y `.chip` (#712) y los tokens existentes. No hay componentes nuevos ni textos traducidos: se quedan «Agentes del proyecto», «Abrir su chat» y las etiquetas de estado tal como están.

### 2.1 Panel en el teléfono (≤ 640 px), v1 y v2

| Criterio | Valor medible |
|---|---|
| Posición | **Superpuesto** al hilo (`position: absolute`, por encima del hilo), **no en el flujo**. Abrirlo o cerrarlo no cambia el `top` ni el alto del hilo (Δ = 0 px) ni su `scrollTop`. |
| Borde superior | 4 px por debajo del borde inferior de lo que lo abre: el header en v2 (y = 48) y la fila del grupo de avatares (`pv-header`) en v1 (y = 105 a 390). |
| Laterales | 8 px a cada lado del viewport (a 320: x = 8, ancho 304). |
| Borde inferior | **Nunca tapa el composer**: el panel termina como mínimo 8 px por encima de su borde superior. |
| Alto máximo | `min(60 % del alto visible, espacio entre el borde superior y el composer − 8 px)`. Con el teclado (390x450), ≤ 270 px y el composer visible entero. |
| Alto con pocos agentes | El del contenido. Con 2 agentes no queda espacio vacío. |
| Scroll | Interno al panel, con `overscroll-behavior: contain`. El hilo no se mueve mientras se desplaza la lista. |
| Cabecera | Fija dentro del panel, de 44 px, con un borde inferior de 1 px `--c-border-soft`, que es lo que corrige D6. |
| Superficie | `--c-surface`, borde de 1 px `--c-border`, `--radius-m` y la sombra de `.chat-end` (`0 6px 16px rgba(1,4,9,.55)`). |
| Desktop (≥ 641 px) | Sigue como hoy, en el flujo y dentro de la columna. Solo cambia la fila (2.2). |

### 2.2 Fila (todos los anchos)

```
┌──────────────────────────────────────────────────┐
│ (A)  @infraestructura-y-desp…    [Abrir su chat] │  línea 1: avatar 24 · nombre en 1 línea con elipsis · .btn.sm
│      ● trabajando en #7  ›                       │  línea 2: .chip (tocable) o .chip.bare (no tocable)
└──────────────────────────────────────────────────┘
```

| Criterio | Valor medible |
|---|---|
| Grilla | `grid-template-columns: 24px minmax(0, 1fr) auto`, con el avatar y el botón ocupando las dos líneas (`align-self: center`), column-gap de 10 px, row-gap de 4 px y padding vertical de 8 px (8 + 20 de nombre + 4 + 24 de chip + 8 = 64). |
| Alto | **Igual en todas las filas** de la lista, con nombre corto o largo y con cualquier estado: 64 px. Tolerancia: ±1 px. |
| Nombre | `@nombre` en **una sola línea**, 14 px, peso 600, color del agente (`--acp-hue`) y elipsis. El nombre completo va en `title` y en el nombre accesible. A 320 caben al menos 12 caracteres. |
| Estado | En la línea 2, alineado con el nombre: `.chip` del tono que corresponda (`warn`: esperando respuesta o login; `busy`: trabajando; `ok`: libre o en espera; `off`: sin señal o iniciando). Nunca se recorta y nunca pasa a otra línea. |
| «Abrir su chat» | `.btn.sm`, 44 px de alto en táctil (regla `pointer: coarse` de #712), alineado a la derecha. Se va el enlace subrayado. Nombre accesible: «Abrir su chat (@nombre)», el de hoy. |
| Solapes | Ninguno entre avatar, nombre, chip y botón, y nada sale de la fila: se verifica con `getBoundingClientRect` a 320, con el nombre `@infraestructura-y-despliegues`. |
| Separador | 1 px `--c-border-soft` entre filas, sin línea después de la última. |

### 2.3 Cierre

- × de 44×44 (`.btn.btn-icon`; en táctil la regla de #712 ya le da 44), Escape, tocar el grupo de avatares otra vez, y **tocar fuera del panel**. Tocar fuera no pasa el toque al hilo: el primer toque solo cierra.
- Elegir una acción de la fila (abrir chat o ir al mensaje) **cierra el panel**.
- El foco vuelve al grupo de avatares cuando se cierra con ×, Escape o tocando fuera. Con una acción, el foco va al destino (2.4).
- Al abrir, el foco va a la primera acción de la primera fila, como hoy.

### 2.4 El estado se puede tocar (pedido nuevo de #571)

**Cuándo es tocable:** solo cuando el agente tiene un mensaje en curso con número: «trabajando en #N» o «esperando tu respuesta», que corresponde al mensaje con la pregunta abierta. «libre», «N en espera», «esperando login», «sin señal» e «iniciando» **no se tocan**.

| | Tocable | No tocable |
|---|---|---|
| Elemento | `<button class="chip tone-…">` | `<span class="chip bare tone-…">` |
| Fondo | Sí: el del `.chip` (tono al 14 %) | No (`.bare`) |
| Indicador | `›` de 12 px después de la palabra, en el color del tono | Ninguno |
| Hover (puntero fino) | Fondo al 24 % | — |
| Foco | `outline` de 2 px `--c-accent` con offset de 2 px (el de `.btn`) | No recibe foco |
| Área táctil | 44 px de alto como mínimo, con un `::before` transparente; el ancho visible más 8 px por lado. No se superpone al botón «Abrir su chat». | — |
| Nombre accesible | «Ir al mensaje #12 de @dev (trabajando)» / «Ir a la pregunta de @arq» | Solo la palabra, como texto |
| Cursor | `pointer` | `default` |

**Prueba de distinción** (para @qa): en una misma lista, un estado tocable y uno no tocable del mismo tono (por ejemplo «trabajando en #7» frente a «libre») se diferencian sin depender del color, por el fondo y el `›`.

**Al tocarlo:**
1. Se cierra el panel.
2. El hilo de Project Chat lleva el mensaje #N a la vista.
   - El borde superior de la burbuja queda a **un 25 % del alto del hilo**, para que se vea contexto arriba. Si es el último mensaje, queda donde caiga al final del hilo.
   - En el caso «esperando tu respuesta», el destino es la tarjeta de la pregunta (`.acp-question`) de ese mensaje.
3. **Resaltado breve:**
   - `box-shadow: 0 0 0 2px var(--c-accent)` (en `--c-warn` si es una pregunta) más el fondo `--c-accent-bg`;
   - se mantiene 1200 ms y se desvanece en 600 ms;
   - no cambia el layout: nada de `border` ni `margin`, solo sombra y fondo.
4. El foco pasa a la burbuja (`tabindex="-1"`) o, si es una pregunta, a su primer control. El `role=status` del hilo dice «Mensaje #12».
5. Si el mensaje no está en la página cargada, se cargan las anteriores hasta encontrarlo. Mientras tanto el chip lleva `aria-busy="true"` y el spinner de 14 px de `.btn[aria-busy]`. Si no aparece, el error va en la línea de avisos del composer. **Nunca falla en silencio.**

**`prefers-reduced-motion: reduce`:** el desplazamiento es instantáneo, sin `smooth`, y el resaltado aparece sin transición, dura 1500 ms y se quita de golpe.

**El botón «Ir al final» (#710):** después del salto, el lector queda más arriba del final, así que puede aparecer según sus reglas de siempre. No se lo fuerza.

---

## 3. Qué mide @qa

1. Δ de `top`, alto y `scrollTop` del hilo al abrir y cerrar el panel: 0 px, a 320, 390 y 390x450, en v1 y v2.
2. Borde superior del panel: borde inferior de lo que lo abre + 4 px. Borde inferior: ≤ borde superior del composer − 8 px. Las dos con el teclado (390x450).
3. Alto del panel con 7 agentes a 390x450: ≤ 270 px, con scroll interno y el composer visible entero.
4. Filas: todas con el mismo alto (64 ± 1 px). Nombre en 1 línea con elipsis. Ningún solape ni nada fuera de la fila, a 320 con `@infraestructura-y-despliegues`.
5. Objetivos táctiles ≥ 44 px de alto: ×, «Abrir su chat» y chip tocable. El área del chip no se superpone con la del botón.
6. Cierre con ×, Escape, grupo de avatares y toque fuera (que no pasa al hilo). Foco de vuelta en el grupo.
7. Estado tocable frente a no tocable: fondo y `›` en uno, `.bare` sin `›` en el otro; el no tocable no recibe foco.
8. Al tocar: el destino queda en el 25 % del hilo (±8 px), con el resaltado (sombra de 2 px) visible a los 200 ms y quitado a los 2000 ms. Con reduced-motion, sin `transition` ni `scroll-behavior: smooth`.
9. Desktop (1280 v2): el panel sigue en el flujo y dentro de la columna; solo cambia la fila.
