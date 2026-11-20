# UX iter3: propuesta para las cinco áreas

**Pedido:** @architect, msg #509, por encargo de @owner (#508).
**Autor:** @designer, 2026-11-20.
**Base:** `main` = `fa78f98` (incluye #707, #708 y #709).
**Rama:** `assets/ux-iter3`. No se mergea y no incluye código de producto.

**Evidencia:**
- **Antes:** la app real con el mock e2e, en Chromium headless, en `before/`. Las capturas del audit anterior siguen valiendo y están en `assets/ux-audit-2026-11-20`; acá no se repiten.
- **Después:** maquetas HTML/CSS estáticas hechas solo con los tokens de `tokens.css` (copia de `fa78f98`), en `mock/`, y renderizadas en `after/`.
- **Scripts:** `scripts/` (Playwright).

**Tamaños:** 320×568, 390×844, 390×450 (teclado simulado por alto), 1280×800, 1440×900 y 1920×1080, en v1 y v2.

**Límites:**
- **Solo Chromium.** No hay nada probado en Safari, WebKit ni iPhone real.
- **Las maquetas no son la app.** Las fuentes son las del sistema del contenedor. Los glifos ⎕ / ⑂ de los íconos faltan en esas fuentes, igual que en las capturas e2e.
- **Medidas:** cada medida «antes» sale de la app renderizada (`measure.jsonl`). Cada medida «después» es de la maqueta, o un cálculo cuando lo indico.

## Resumen

| Área | Propuesta en una línea | Ganancia medible |
|---|---|---|
| 1. Sidebar | Árbol **Proyectos → agentes**, luego «Agentes sin proyecto» y luego «Sesiones». El agente se identifica por `@nombre` (avatar), no por el nombre de la sesión. Un solo vocabulario de estado: punto + palabra. Selección con barra de acento. | Filas de 32 px en desktop y 48 en el teléfono. El estado «te espera» se ve también con el proyecto plegado. |
| 2. Headers | **Una barra de contexto** de alto fijo, con 5 zonas, para todas las vistas. La identidad del agente va en la barra de sesión (E) y Project Chat usa esa misma barra (D). | Chat ACP en el teléfono: el hilo empieza en y=47 en lugar de 104 (**+57 px**). Project Chat en el teléfono: y=47 en lugar de 110 (**+63 px**). Desktop v2: **+45 px** (ACP). |
| 3. Composer | **Una superficie** en grid de 3 columnas: `+`, campo y flecha, alineados abajo. 44 px en reposo y tope de líneas con scroll interno. | En 390×450 multilínea, el hilo pasa de unos 155 px visibles a unos 230 (medido sobre captura). Desktop: 73 → 60 px en el chat individual. |
| 4. Ir al final | Píldora neutra elevada con flecha de acento y contador `↓ 3`, a 12 px por encima del composer y centrada en la columna. | Mismo componente en los tres chats. |
| 5. Controles | `.btn` en 4 variantes y 2 alturas (28/32, y 44 táctil), un chip de estado y tabs, menú y diálogo con una sola forma. | Hoy conviven 8 alturas de botón (15 a 44 px). |

---

## 1. Sidebar y navegación (prioridad 1)

### Problema
Capturas: `before/sidebar-1440-v1.png`, `before/sidebar-390-v2.png` y `before/sidebar-320-v1.png`.

- **Dos nombres para lo mismo.** Cada agente ocupa dos líneas: el nombre de la sesión (`hz-architect`) y debajo `@arq ● te espera`. A la persona le habla `@arq`; `hz-architect` es un detalle de infraestructura.
- **La jerarquía no se lee.** El orden es «PROJECTS [+]», después «Show terminated ↻», después «+ New session» y después los proyectos. Los controles de las sesiones quedan entre el título de proyectos y sus proyectos (hallazgo 8). «Sin proyecto» mezcla agentes y sesiones de terminal.
- **Estado sin sistema.**
  - El punto verde de la izquierda es el estado del **contenedor**. La palabra («libre», «te espera») es el estado del **agente**: dos indicadores en la misma fila.
  - El ámbar significa a la vez «te espera» y «detenida» (el círculo hueco de `docs`).
  - «te espera» lleva un cuadrado; el resto, un punto.
- **Selección poco evidente.** Hoy es un fondo azul oscuro (`#1f3a5f`-ish), sin borde.
- **Teléfono.**
  - El bloque superior ocupa unos 150 px: «PROJECTS» con un `+` de 44 px, «Show terminated», y «Go to a conversation…» junto a «+ New session».
  - A 320 px, el pie (Templates, Logout) tapa la última fila.

### Propuesta: alternativa A (recomendada), árbol por proyecto
Capturas: `after/1-sidebarA-1280.png`, `after/1-sidebarA-1440.png` y `after/1-sidebarA-1920.png`.

```
[+ Nueva sesión]                         ← acción primaria, arriba, una sola
PROYECTOS                          [+]   ← «+» de proyecto en su sección
▾ Educación HZ                 ●1  ⋯     ← nombre: abre Project Chat · chevron: pliega · ●1 = alguien te espera
    (A) @arq              ● te espera    ← agente = avatar + @nombre (una línea)
    (D) @dev              ◉ trabajando
    (Q) @qa               ● libre
▸ Portal docentes               3  ⋯     ← plegado: cantidad, o ●N si alguien espera
AGENTES SIN PROYECTO
    (S) @solo             ○ sin señal
SESIONES                           [⋯]   ← ⋯ = «Mostrar terminadas», «Actualizar»
 ● my-project                       ⋯
 ○ docs          detenida   ▶       ⋯
```

**Cómo se distinguen las cosas:**

| Elemento | Cómo se ve |
|---|---|
| Proyecto | Texto 600 en `--c-text`, con chevron |
| Agente | Avatar con su `--acp-hue` y `@nombre`. Es la misma identidad que en el chat (#691). El nombre de la sesión pasa al `title`, al nombre accesible y a la barra de contexto (área 2). |
| Sesión de terminal | Punto de estado del contenedor y nombre |

**Un solo vocabulario de indicadores.** Forma del punto = vivo o no; color = qué te pide. Es el mismo chip del área 5.

| Estado | Punto | Color | Palabra (fila) |
|---|---|---|---|
| libre | lleno | `--c-ok` | libre |
| trabajando | lleno, con halo | `--c-accent` | trabajando |
| te espera / login | lleno | `--c-warn`, palabra 600 | te espera · login |
| sin señal / iniciando | **hueco** | `--c-muted` | sin señal · iniciando |
| error / falló | lleno | `--c-err` | error |
| sesión en marcha | lleno | `--c-ok` | — |
| sesión detenida | **hueco** | `--c-muted` (deja de ser ámbar) | detenida |

Reglas del vocabulario:
- El **ámbar queda reservado para «te necesita»**.
- En la fila de un agente se ve **un solo indicador**: el del agente. Si el contenedor está detenido, la palabra es «detenida», que es lo que ya decide el #703.

**Selección:** fondo `--c-accent-bg`, texto blanco y una **barra de 3 px de `--c-accent` a la izquierda**. Ya no se confunde con el hover (`--c-surface-2`).

**Agrupación y colapso:** cada proyecto se pliega con el chevron. Plegado muestra la cantidad, o `●N` en ámbar si un agente espera, que es lo que ya hace hoy el #703 en el encabezado del grupo.

**Acciones contextuales:**
- `⋯` por fila: visible al pasar el mouse o con la fila seleccionada en desktop, y siempre en el teléfono.
- Las acciones de sesión (Detener, Terminar…) son las de hoy.
- Las de proyecto, las del ⋯ de Project Chat.

**Medidas en desktop:** ancho de 264 px (igual que hoy), filas de 32 px, sangría de agentes de 26 px y botones de icono de 28 px.

**Qué NO cambia:** qué abre cada fila (Project Chat, Chat del agente, vista de la sesión), el orden dentro de cada grupo, «Mostrar terminadas», los observables de admin/lead (otra sección al final) y el ancho.

### Alternativa B: dos listas (Agentes | Sesiones)
Capturas: `after/1-sidebarB-1280.png` y `after/1-sidebarB-1440.png`.

Un segmentado arriba con dos pestañas. «Agentes» muestra los agentes agrupados por proyecto (encabezado sticky con «Project Chat ›»); «Sesiones» muestra las sesiones de terminal.
- **A favor:** listas más cortas y cada lista es homogénea.
- **En contra:**
  - lo que pasa en la otra pestaña se ve solo como un número en el segmento;
  - cambiar entre un agente y su terminal cuesta un clic más;
  - suma un control nuevo de navegación (un estado más que mantener, más tests de router).

**Recomiendo A:** prioriza proyectos y agentes, como pide la dirección del producto, y mantiene todo a la vista.

### Mobile (versión de A)
Capturas: `after/1-drawerA-390.png` y `after/1-drawerA-320.png`.

- **Drawer** de `min(100vw − 44px, 340px)`, con un borde de 44 px a la derecha para cerrarlo con un toque y con scrim.
  - Hoy ocupa todo el ancho (#641); el borde es la forma estándar de cerrar con una mano.
  - Se cierra **al seleccionar**, como hoy.
- **Arriba:** «⌕ Ir a proyecto, agente o sesión…» (44 px), y después «+ Nueva sesión» (44 px). «Mostrar terminadas» y «Actualizar» pasan al `⋯` de «Sesiones».
- **Filas de 48 px:**
  - una línea con avatar de 24 px, `@nombre`, palabra de estado y `⋯` de 44 px;
  - en las sesiones detenidas, `▶` de 44 px;
  - sin segunda línea, así ninguna fila queda saturada.
- **Estados importantes visibles:** «te espera» y «login» en ámbar 600, también en el encabezado del proyecto plegado.
- **Pie:** la cuenta (Templates, Logout) queda en el **pie sticky del drawer**. El contenido tiene padding inferior de su alto para que no tape la última fila, que es el defecto que hoy se ve a 320.
- **Cambio rápido:** «Ir a…» arriba del drawer (Ctrl K en desktop). Tocar un agente lleva a su Chat.

### Nota sobre Ctrl K
Entra en la navegación propuesta como **el mismo «Ir a…»** del header en desktop y de la primera fila del drawer en el teléfono. Hoy solo indexa conversaciones capturadas.

Propongo, como **PR separado y posterior al sidebar**, que indexe:
- proyectos, que abren Project Chat;
- agentes `@nombre`, que abren su Chat;
- sesiones.

El estado se muestra con el mismo chip. No bloquea el área 1.

---

## 2. Headers (prioridad 2)

### Problema
Capturas: `before/acp-chat-1280-v2.png`, `before/project-chat-390-v2.png`, `before/terminal-1280-v1.png`, `before/files-390-v2.png` y `before/chat-1280-v1.png`.

**Mediciones en la app** (`measure.jsonl`): «y del hilo» es dónde empieza el hilo, «cromo» es la suma de las filas que van arriba.

| Vista | Ancho | y del hilo hoy | Cromo |
|---|---|---|---|
| Chat ACP v2 | 1280 | 142 | header 57 + barra 40 + header del agente 45 |
| Project Chat v2 | 1280 | 124 | header 57 + header del proyecto 51 + padding |
| Chat ACP v2 | 390 | **104** | header fusionado 47 + header del agente **57** |
| Project Chat v2 | 390 | **110** | header 47 + header del proyecto **51** + padding |
| Chat ACP v1 | 390 | 102 | header 45 + header del agente 57 |

- **Cuatro estilos de cabecera:**
  - la barra de sesión;
  - el header del agente (`.acp-chat-header`);
  - el `pv-header` del proyecto;
  - las sub-barras de Files, Git y Chat capturado (`#files-header`, `#git-header`, `#chat-header`), cada una con su alto y su refresh.
- **Identidad repetida:** «scratch RUNNING» arriba y «@solo libre» debajo.

### Propuesta: una barra de contexto
Capturas: `after/2-header-*.png`.

Alto fijo: **40 px en desktop** (el de hoy) y el **header fusionado de 47 px en el teléfono** (v2).

```
[1 Contexto] [2 Identidad: avatar/título · chip] [3 Navegación] ── espacio ── [4 Acción primaria] [5 ⋯]
```

| Zona | Contenido | Regla |
|---|---|---|
| 1 Contexto | ☰ (teléfono; en desktop está en el header global) | Siempre a la izquierda |
| 2 Identidad | Título (`min-width: 8ch`, elipsis, nombre completo en `title`), chip de estado y subtítulo opcional | El chip nunca se recorta. En el teléfono queda **solo el punto**: la palabra va al nombre accesible y al ⋯. |
| 3 Navegación | Tabs de vista (sesión) o grupo de avatares (proyecto) | Por debajo de 1100 px, tabs solo con ícono (como v2) |
| 4 Acción primaria | Como máximo una visible (por ejemplo ↻ en Files o Git) | Lo demás va a ⋯ |
| 5 Menú | `⋯` (btn-icon de 28 px; 44 en táctil) | El último elemento |

**Qué va en cada zona, por vista:**

| Vista | 2 Identidad | 3 Navegación | 4 | 5 |
|---|---|---|---|---|
| Project Chat (D) | Nombre del proyecto · «archivado» si corresponde | Avatares (abren «Agentes del proyecto»), `●N` | — | ⋯ (Administrar agentes, Renombrar, Archivar; «Cerrar» en el teléfono) · × en desktop |
| Chat ACP individual (E) | Avatar + `@agente` · chip del agente · subtítulo «sesión X · proyecto ↗» (≥ 1100 px) | Tabs | — | ⋯ (**Ajustes del agente**, más las acciones de sesión de hoy) |
| Sesión tradicional (Terminal, Files, Git, Chat) | Nombre de la sesión · chip «en marcha», «detenida»… | Tabs | — | ⋯ (el de hoy) |
| Sub-barra de Files, Git y Chat capturado | Breadcrumb · rama y cambios · «Conversaciones» | Filtros propios | ↻ (btn-icon de 28) | — |
| Gestión (Nueva sesión, Nuevo proyecto, admin) | Diálogo: título + × (área 5) | Pestañas del formulario | — | — |

**Las sub-barras** (Files, Git y Chat capturado) se quedan, porque son de la vista, no de la sesión, pero las unifico:
- 36 px de alto, borde `--c-border-soft`;
- refresh como btn-icon a la derecha;
- en v2 desaparece su «‹ Terminal», como ya hace hoy.

**Nombres largos:**
- el título se elipsa primero, con un mínimo de 8ch (7 en el teléfono);
- después, las tabs pasan a íconos;
- después, el subtítulo desaparece;
- el chip y el ⋯ no se mueven nunca.

Capturas: `after/2-header-long-1280.png` y `after/2-header-project-long-320.png`.

**Muchas acciones:** solo una en la zona 4; el resto va al ⋯ en el orden de hoy.

**Teléfono:**
- La barra **es** el header: ☰, identidad, tabs con íconos de 40 px, ⋯ y cuenta.
- El avatar del agente sale del header: el nombre toma su color y el estado queda en el punto.
- A **360 px o menos**, la cuenta pasa al pie del drawer y las tabs bajan a 34 px, para que el título conserve al menos 7 caracteres (`after/2-header-acp-320.png`).

**Alineación:**
- La barra va a todo el ancho y alineada al gutter de la página, no a `--chat-col`: lleva tabs y acciones, y en una columna de 56rem quedarían lejos de los bordes del panel.
- El contenido del chat sigue en la columna (#708).
- La barra no se alinea con el sidebar; el sidebar tiene su propio encabezado.

### E: identidad del agente en la barra de sesión (desktop y teléfono)
**Qué hace:**
- Para una sesión de agente, la zona 2 muestra `@agente`, su chip, y «sesión scratch · proyecto ↗» (≥ 1100 px).
- **Desaparece** la fila `.acp-chat-header`, que mide 45 px en desktop y 57 en el teléfono.
- El panel **Ajustes** se abre desde ⋯ → «Ajustes del agente», debajo de la barra, igual que hoy desde el botón.
- El aviso de login sigue como franja propia dentro del chat (`.acp-chat-notice`): es contenido, no cabecera.

**Condición técnica 1, el alto no cambia:**
- Lo que cambia es el **contenido** de la barra, y depende del **tipo de sesión** (agente o no), no de la vista.
- El alto de `#terminal-toolbar` sigue siendo 40 (39 en v1) en Terminal, Files, Git y Chat.
- Una vista nueva no agrega ni quita filas de la barra.
- **Cómo verificarlo:** el e2e `terminal-invariant` (cero `resize` al cambiar de vista) más un test nuevo que compare el alto de `#terminal-toolbar` en las 4 vistas de una sesión de agente.

**Condición técnica 2, v1 y v2:**

| Shell | Comportamiento |
|---|---|
| v2 | Como en las maquetas. |
| v1 desktop | Misma barra («Session:» pasa a la identidad), con Aa, Observers y Ports como hoy. |
| v1 teléfono | La barra vive dentro del drawer de cromo. La píldora del header pasa a decir «@solo · Chat» (hoy «scratch › Chat»). **Se mantiene la fila del agente**: sin ella el estado no se vería sin abrir el drawer. |

**El shell por defecto no cambia.**

Depende del #644 solo para decidir si v1 en el teléfono también pierde esa fila; la propuesta funciona sin él.

### D: Project Chat en el teléfono, con la barra como header
**Qué hace:**
- En **v2**, el header fusionado muestra ☰, el título del proyecto, los avatares (3 y `+N`, como en el #706), `●N` y ⋯.
- Desaparece el `pv-header` de 51 px más su padding.
- «Cerrar el proyecto» va al ⋯.
- Capturas: `after/2-header-project-390.png` y `after/2-header-project-long-320.png`.

**En v1 teléfono:**
- La píldora de contexto del header pasa a mostrar el título del proyecto, sin toggle.
- El ⋯ del proyecto queda a su derecha.

**Condición:** la propuesta mueve el mismo header que @owner todavía no validó en su iPhone (#706). **Se implementa después de esa validación.**

**Qué NO cambia:** las tabs de vista y su orden, el ⋯ de sesión y su contenido, el header global de desktop (57/55 px) y la key-bar.

---

## 3. Composer (prioridad 3)

### Problema
Capturas: `before/project-composer-multiline-390x450-v2.png`, `before/acp-composer-focus-1280-v2.png` y `before/project-chat-390-v2.png`.

- **El `+` queda fuera del campo**, como una caja aparte.
- **En desktop el campo mide 52 px en reposo**, porque el placeholder ocupa dos líneas. El composer mide 73 px.
- **Flecha:** 40×40 en desktop y 44 en el teléfono.
- **Con el teclado** (390×450), el multilínea crece hasta dejar unos **155 px de hilo** (medido sobre captura). En v1, sin texto, el hilo mide 232 px (`measure.jsonl`).
- **El foco se ve distinto según el ancho.** En las capturas de teléfono (Chromium, táctil) el campo muestra un anillo amarillo; en desktop, uno azul. Ninguna regla de `acp-chat.css` lo pide, así que parece el anillo por defecto del navegador. En cualquier caso, son dos aspectos para lo mismo.

### Propuesta: una superficie
Capturas: `after/3-composer-*.png`.

```
.composer  (grid: [+] auto | [campo] 1fr | [→] auto ; align-items: end)
┌──────────────────────────────────────────────────────────┐
│ (+)  Mensaje…                                       (↑)  │  44 px en reposo
└──────────────────────────────────────────────────────────┘
```

| Medida | Valor |
|---|---|
| Alto en reposo | **44 px**, en desktop y en el teléfono |
| Superficie | Borde 1 px `--c-border`, radio `--radius-m` (10 px), fondo `--c-surface` |
| Campo | `font 15px/22px` (16 px en táctil, para que iOS no haga zoom), padding vertical 11 px. La superficie no tiene padding horizontal: lo dan las celdas de `+` y `→`, o 12 px a la izquierda si no hay `+`. |
| `+` y `→` | **Área táctil 44×44** (la celda entera del grid), **círculo visible de 30 px**. Sin offsets ni transforms: la celda de 44 centra el círculo con `place-items`. |
| Cuando el campo crece | Los botones quedan **abajo** (`align-items: end`), a la altura de la última línea, donde están el cursor y el pulgar. Así no se mueven mientras se escribe. |
| Tope | Desktop: 8 líneas (198 px). Táctil: `min(6 líneas, 30vh)`, o sea unos 135 px con el teclado en 390×450, con **scroll interno**. El hilo conserva unos 230 px (`after/3-composer-multi-390x450.png`). |
| `+` | Solo en Project Chat con **más de un agente**, como hoy. Si no hay `+`, la columna se cae (`no-plus`) y el campo empieza a 12 px. |

**Estados** (todos en la misma superficie):

| Estado | Aspecto |
|---|---|
| Vacío | Placeholder `--c-muted`; flecha en `--c-surface-2` (apagada pero enfocable; enviar vacío no hace nada) |
| Con texto | Flecha en `--c-accent-strong` y blanco |
| Multilínea | Crece hasta el tope; los botones quedan abajo |
| Enviando | Flecha con spinner (14 px, `prefers-reduced-motion` = sin giro). El texto ya salió del campo (reserva del #706). |
| Error | Borde `--c-err`. Debajo de la superficie, no adentro: «No se envió a @x.» y **Recuperar el texto** (btn sm). Es texto fijo, sin código del servidor: corresponde al NIT de @qa en el #709. |
| Deshabilitado | Fondo `--c-surface-2`, borde `--c-border-soft`, sin botones, y el placeholder dice por qué («Proyecto archivado · solo lectura») |
| Foco | **Uno solo:** `:focus-within` en la superficie, con borde `--c-accent` y halo de 3 px `--c-accent-bg`. El textarea no tiene outline, explícito, para que no aparezca el anillo por defecto del navegador. |

**Destinatarios** (solo visual, fuera del texto; **las menciones iniciales siguen siendo la fuente**, sin chips en el textarea):
- Una línea de 18 px **encima** de la superficie, solo en Project Chat.
  - Vacía: «Empezá con @agente para elegir a quién va · Ctrl+Enter envía». En el teléfono, solo «Empezá con @agente».
  - Con menciones: «Para **@arq** · **@dev**», derivado en vivo de las menciones iniciales.
- Reemplaza el hint que hoy va en el placeholder de dos líneas.
- Hay que decidir el costo en el teléfono:
  - **(a) recomendada:** la línea siempre reservada, con 18 px menos de hilo;
  - **(b)** la línea aparece solo con menciones; el hilo pierde 18 px en ese momento y, si estaba al final, sigue pegado.

**Alturas resultantes:**

| Chat | Ancho | Hoy | Propuesta |
|---|---|---|---|
| Individual | desktop | 73 | ≈ 60 |
| Individual | teléfono | 61 | ≈ 60 |
| Project Chat | desktop | 73 | ≈ 78 |
| Project Chat | teléfono | 61 | ≈ 78 con (a) |

**Qué NO cambia:** Ctrl+Enter, el menú de destinatarios del `+`, los borradores por chat, la reserva al enviar, «Recuperar el texto», y que la superficie quede siempre en pantalla con los paneles abiertos (#700).

---

## 4. Botón «ir al final» (solo visual; el comportamiento es el que define @architect)

### Problema
Captura: `before/acp-pill-1440-v2.png`.

Hoy es una píldora `--c-accent` rellena con «↓ 3 nuevos» en texto. Compite con los mensajes enviados, que también son azules, y en el chat capturado dice «New».

### Propuesta (mismo componente en los tres chats, sobre `.chat-float`)
Capturas: `after/4-pill-*.png`.

**Forma:**
- Píldora de 32 px, radio 999 y padding `0 12px 0 10px`.
- Fondo `--c-surface-2`, borde `--c-border` y sombra `0 6px 16px rgba(1,4,9,.55)`.
- **Flecha ↓ en `--c-accent`.**
- Área táctil de 44 px con el `::before` de hoy.

**Contador:** **`↓ 3` discreto.** Es un badge de 18 px `--c-accent-strong` con el número, sin la palabra «nuevos»; el nombre accesible dice «3 mensajes nuevos, ir al final».
- Sin novedades (el lector solo subió): **flecha sola**, círculo de 36 px (`after/4-pill-arrow-320.png`).
- Con 100 o más: `99+`.

**Posición:**
- **Centrada horizontalmente en la columna de lectura.** El hilo va a todo el ancho con el gutter de #708, así que el centro del panel es el centro de la columna.
- **12 px por encima del borde superior del composer.**
- Se ancla al composer, no al viewport: con el teclado abierto sube con él (`after/4-pill-count-390x450.png`). En la columna ancha queda en el centro de la columna (`after/4-pill-count-1920.png`).

**Animación:**
- Entrada: `opacity` 0→1 y `translate` 8 px→0 en 160 ms ease-out. Salida: 120 ms.
- Con `prefers-reduced-motion: reduce`, **solo opacidad** en 100 ms, sin desplazamiento.

**Qué NO cambia:** cuándo aparece, qué cuenta y qué hace al tocarlo (#700, #705 y lo que implementa @developer).

---

## 5. Botones y controles (prioridad 5)

Capturas: `after/5-controls-1280.png` y `after/5-controls-390.png`.

No es un sistema de componentes nuevo: son **clases CSS sobre los tokens de hoy**, que se aplican de a poco a los controles existentes.

| Clase | Uso | Medidas |
|---|---|---|
| `.btn` | Secundario (por defecto) | 32 px (md) / 28 px (`.sm`) · padding 0 12/10 · `--radius-s` · fondo `--c-surface-2` · borde `--c-border` |
| `.btn.primary` | Una acción principal por superficie | Fondo `--c-ok-bg`, borde `--c-ok-strong`, texto blanco (el verde de hoy) |
| `.btn.danger` | Destructiva | Texto `--c-err` sobre transparente; `.solid` (relleno) solo en la confirmación final |
| `.btn.icon` | Solo ícono (⋯, ×, ↻, +) | Cuadrado de 28/32, transparente, y fondo `--c-surface-2` en hover |
| Táctil | `@media (pointer: coarse)` | `min-height: 44px`; ícono `min-width: 44px` |

**Estados:**
- **hover:** borde `--c-muted`; en primario, fondo `--c-ok-strong`.
- **focus-visible:** outline de 2 px `--c-accent` con offset de 2 px, el mismo en todo.
- **active:** fondo `--c-border-soft`.
- **disabled:** opacidad .45, sin hover y `cursor: not-allowed`.
- **loading:** spinner de 14 px, la etiqueta en gerundio y `aria-busy`.

**Inputs y selects:**
- 32 px (44 en táctil, con 16 px de fuente) y fondo `--c-bg`.
- Foco: borde `--c-accent` y halo de 3 px. Error: borde `--c-err`.

**Tabs de vista:** el segmentado de v2, de 28 px (36 en táctil), con la seleccionada en `--c-accent-bg` y `--c-accent`.

**Menús:**
- Superficie `--c-surface` con `--radius-m` y ítems de 32 px (48 en hoja táctil), con hint debajo.
- Los destructivos van al final, separados y en `--c-err`.
- Popover o diálogo: decisión de @owner, más abajo.

**Diálogos:**
- Ancho `min(100%, 32rem)` y `--radius-l`.
- Header de 48 px con título y × (btn-icon sm).
- Pie con borde superior: Cancelar (secundario) y el primario a la derecha, al final.

**Chip de estado:** `.chip.tone-{ok,busy,warn,err,off}`, con punto de 8 px y palabra de 11.5 px, alto de 20.
- Variante `bare` (sin fondo) en las filas del sidebar y en los mensajes.
- Con fondo en las barras.

Reemplaza a `RUNNING`/`STOPPED`, la pill «libre», «hecho» y el badge «te espera», con el vocabulario del área 1.

### Hoy → variante (los controles más visibles)

| Control (hoy) | Medida hoy | Variante |
|---|---|---|
| «+ New session» (sidebar) | 227×31 verde | `.btn.primary.sm` (desktop) / md 44 (teléfono) |
| `+` de proyecto | 29×29 (44×44 en el teléfono) | `.btn.icon.sm` |
| ↻ del sidebar | **23×15** (también en el teléfono) | Pasa al `⋯` de «Sesiones» |
| Templates, Logout (header v1) | 24 px | `.btn.sm` (v2 ya los tiene en el menú de cuenta) |
| ⋯ de sesión (barra) | 32×23 (34×34 en el teléfono) | `.btn.icon.sm` (44 táctil) |
| ⋯ y × de Project Chat | 44×32 y 32×33 | `.btn.icon.sm` |
| «Ajustes» (header ACP) | 61×24 | Ítem del ⋯ (E) |
| `files-btn` (Quitar, Agregar, Guardar, Cambiar modelo) | 24 a 28 px | `.btn.sm` |
| «Reintentar» (`pv-btn`) | 30 px | `.btn.sm` |
| Cancel / Create / Save as template (diálogos) | 30 px | `.btn` / `.btn.primary` (md) |
| Badge `RUNNING` / `STOPPED` | Pill en mayúsculas | `.chip.tone-ok` «en marcha» / `.chip.tone-off` «detenida» |
| «libre» con borde, «hecho» en texto | — | `.chip` (`bare` en mensajes) |
| `+` y → del composer | 40/44 | Celdas de 44 con círculo de 30 (área 3) |

**Por dónde empezar, sin reemplazo masivo:**
1. Agregar `.btn`, `.chip` y `.btn.icon` a una hoja existente (por ejemplo `base.css`), sin tocar nada más.
2. Aplicarlos **solo dentro de los PRs de las áreas 1 a 3**, en los controles que esos PRs ya tocan.
3. Después, un PR por superficie (diálogos y admin) cuando cada una se toque por otra razón.

Sin un barrido global: `files-btn` y `pv-btn` conviven hasta que su superficie se toque.

---

## Orden de implementación y dependencias

1. **Chip y `.btn`** (CSS, chico): es la base del vocabulario. Lo usan 1, 2 y 3.
2. **Sidebar A**: depende de 1. Es independiente del resto.
3. **Composer**: depende de 1 (botones). Es independiente del header.
4. **Ir al final (visual)**: en paralelo con la implementación de @developer. Depende de que el composer tenga alto estable para anclarse; con el de hoy también funciona.
5. **Barra de contexto (E)**: depende de 1. Su verificación es el invariante de la terminal más el alto constante. Conviene después del #644 si v1 en el teléfono también pierde la fila.
6. **D (Project Chat en el teléfono)**: depende de 5 y de que @owner valide el #706 en su iPhone.
7. **Ctrl K con proyectos y agentes**: después de 2.
8. **Controles restantes** (diálogos, admin, templates): de a poco.

**Dependencias cruzadas:**
- **2 y 3:** la línea «Para…» del composer y los avatares de la barra usan el mismo `--acp-hue`.
- **3 y 4:** la píldora se ancla al borde superior del composer.
- **1 y 2:** el chip del sidebar y el de la barra tienen que ser el mismo componente.

## Decisiones para @owner

1. **Idioma de la UI.** Hoy se mezcla, a veces dentro del mismo diálogo («Nuevo proyecto»: Cancel / Crear).
   - **(a) todo en español.**
   - **(b)** todo en inglés.

   **Recomiendo (a)**: lo nuevo (ACP, proyectos) ya está en español y es lo que más se usa. Las maquetas están en español. i18n queda fuera: suma una capa sin pedido.
2. **Menús en desktop.**
   - **(a) popover anclado al botón** (hoja abajo en el teléfono, como hoy).
   - **(b)** diálogo centrado, como hoy.

   **Recomiendo (a)**: «Account» con 2 ítems y el ⋯ de sesión abren hoy un modal centrado, lejos del botón.
3. **Panel lateral en pantallas de 1440 px o más.**
   - **(a) solo la columna centrada** (#708) y nada más por ahora.
   - **(b)** un panel derecho de unos 280 px con los agentes del proyecto y su actividad cuando sobra espacio.

   **Recomiendo (a) por ahora**: el sidebar A ya muestra el estado de cada agente, y (b) duplicaría esa información. Se puede retomar si el sidebar no alcanza.
4. **Estado vacío de inicio** (C2).
   - **(a)** dos acciones que ya existen («+ Nueva sesión», «+ Proyecto») y, en el teléfono, «Ver sesiones» (abre el drawer).
   - **(b)** abrir directamente el último chat usado.

   **Recomiendo (a)**: no esconde nada y es honesto con la primera vez.

## Qué no se validó
- Safari, WebKit e iPhone real (teclado de iOS, `visualViewport`).
- Lector de pantalla real.
- Las maquetas son estáticas: no prueban scroll, foco ni teclado reales. Eso se valida sobre cada PR con la app renderizada, que es la validación que @architect me pidió después.
