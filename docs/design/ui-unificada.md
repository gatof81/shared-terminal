# Interfaz unificada — auditoría UI/UX y propuesta

Estado: **v1.0, dirección y decisiones aprobadas el 2026-10-31** (§9). La auditoría (§1–§4) es
el diagnóstico de partida y no se repite; la hoja de ruta (§7) es la secuencia de PR autorizada.
Ningún PR de esta iniciativa implementa algo que contradiga este documento sin actualizarlo
primero. Fases previas: Workspace Explorer (#442), Git Changes (#443), Chat 3.1 (#476),
Composer 3.2 (#488) — todas mergeadas y desplegadas.

Alcance: `frontend/` completo (index.html, 25 módulos TS, main.css). No se tocan contratos de
backend salvo donde se señala explícitamente como decisión de producto (§5.6, §8).

---

## 0. Resumen ejecutivo

La aplicación hoy es **un shell de Terminal al que se le fueron adosando vistas** (Files, Git,
Chat) como overlays, y **doce diálogos modales** que cubren todo lo demás (crear sesión,
plantillas, invitaciones, grupos, admin, observar, puertos, pegar, insertar, log de bootstrap).
Cada pieza es sólida por sí misma — la auditoría encontró muy pocos defectos de corrección — pero
el conjunto no se lee como una sola aplicación:

1. **La navegación entre vistas vive en un lugar distinto según el dispositivo y la vista**: en
   desktop es un segmented control dentro de la toolbar del Terminal; en mobile está escondido
   dentro del "cajón" de controles (`Session ▾`) y la barra inferior de navegación aparece
   **solo cuando el Terminal no está a la vista** (`viewSwitch.ts:166-168`). Llegar a Chat desde
   el Terminal en un teléfono son dos toques en un control que no se ve.
2. **Hay seis pares de botones duplicados** (Templates, Invites, My groups, Admin,
   Notifications, Logout) en `header-right` y `sidebar-footer`, y tres implementaciones del
   mismo patrón "lista | detalle con panel único en mobile" (Files, Git, Chat), tres `copyText`,
   doce modales abiertos/cerrados a mano y una cadena `if/else` de quince ramas para Escape
   (`main.ts:1024-1076`).
3. **Dos de los controles más usados no son accesibles por teclado**: las filas de sesión y los
   chips de tab son `div` con `click` (`sessionCore.ts:103`, `:483`). Los toasts no tienen
   `aria-live`. Ningún modal atrapa el foco.
4. **Los estados de desconexión están mal resueltos en mobile**: cuando un socket se rinde, el
   pane se elimina y el contenedor se oculta (`sessionCore.ts:643-671`); la única forma de
   reconectar es tocar el chip del tab, que en mobile está dentro del cajón colapsado.
5. **Las sesiones ajenas (observe/operate) viven fuera del shell**, en un modal con su propio
   xterm que solo muestra el primer tab (`observeModal.ts:156-158`); no tienen Chat, Files ni
   Git (owner-only en backend) y no comparten contexto con la sesión activa.
6. **No hay sistema de diseño**: 616 selectores en un solo archivo de 4.374 líneas, ~40 literales
   hexadecimales repetidos (`#30363d` ×81, `#58a6ff` ×67), y las variables `--c-*` existen solo
   para la sección Chat (`main.css:3333`). Un solo breakpoint (768 px); no existe tier tablet.

La propuesta (§5–§7) no es un rediseño "big bang": es **un shell común** (barra de sesión +
navegación de vistas persistente + menú de usuario), **un router hash** que incluya la vista, **un
registro de acciones de sesión** con predicados de capacidad que alimente todas las superficies,
**cuatro componentes compartidos** (Dialog, Toast, SplitPane, ActionMenu) y **Chat como vista por
defecto** cuando hay conversaciones, con Terminal como vista avanzada siempre a un toque. Se
entrega en nueve PRs independientes y reversibles (§7), con el invariante del Terminal
(§5.1) protegido por un test que falla si un cambio de vista envía un `resize` o reabre un socket.

---

## 1. Inventario

### 1.1 Pantallas y superficies

| # | Superficie | Tipo | Archivo | Entrada |
|---|---|---|---|---|
| S1 | Login / Registro | pantalla | `main.ts:239-535`, `index.html:35-66` | carga |
| S2 | Shell app (header + sidebar + área de sesión) | pantalla | `main.ts`, `index.html:69-398` | post-login |
| S3 | Terminal (tabs + xterm + key bar) | vista base | `sessionCore.ts`, `terminal.ts`, `keyBar.ts` | sesión running |
| S4 | Files (Workspace Explorer) | overlay | `filesView.ts` | view-switch / forzado si no running |
| S5 | Git Changes | overlay | `gitView.ts` | view-switch |
| S6 | Chat (+ panel Agents + composer) | overlay | `chatView.ts` | view-switch |
| S7 | New session (5 tabs) / Edit template | modal | `newSession.ts`, `index.html:406-966` | sidebar `+ New session`, Templates → Use/Edit |
| S8 | Templates | modal | `newSession.ts:1286-1600` | header / sidebar-footer |
| S9 | Save as template | modal anidado | `newSession.ts:1193-1285` | S7 |
| S10 | Bootstrap log | modal (DOM dinámico) | `newSession.ts:290-384` | fila `failed` en sidebar |
| S11 | Invites | modal | `invites.ts` | header / sidebar-footer (admin) |
| S12 | Admin dashboard (stats, sesiones, usuarios/cuotas, grupos, observe log) | modal | `admin.ts` | header / sidebar-footer (admin) |
| S13 | Admin group create/edit, Members | modales anidados | `admin.ts:852-1050` | S12 |
| S14 | My groups | modal | `myGroups.ts` | header / sidebar-footer (lead) |
| S15 | Observe / Operate (xterm en modal) | modal | `observeModal.ts` | S12, S14, sidebar observables, deep link admin |
| S16 | Observers (observe log por sesión) | modal | `admin.ts:1100-1165` | toolbar Terminal |
| S17 | Ports (editor de puertos) | modal | `ports.ts` | toolbar Terminal |
| S18 | Insert (+): Paste / Attach / Download / Select & copy | menú modal | `actions.ts` | header (solo con sesión y sin overlay) |
| S19 | Paste into terminal | modal | `paste.ts` | S18 |
| S20 | Toast | global | `main.ts:616-649` | todos |

Trece modales (S7–S19) sobre un solo shell. Tres se apilan (S9 sobre S7, S13 sobre S12, S15
sobre S12/S14).

### 1.2 Navegación

- **Selección de sesión**: lista en sidebar (`renderSessionList`), ruta `#/sessions/<id>`
  (`deepLink.ts`), salto desde notificación (`#session=<id>`), mensaje del service worker.
  Solo el id va en la URL: **la vista activa, el tab y la conversación abierta no** → Back del
  navegador no navega entre vistas y en mobile el gesto Back saca al usuario de la PWA.
- **Vistas**: `viewSwitch.ts` (Terminal ⇄ Files ⇄ Git ⇄ Chat). Controles: `#view-switch` en la
  toolbar (desktop y dentro del cajón en mobile), `#view-nav` inferior (solo mobile y solo con
  overlay activo), y tres botones `‹ Terminal` (uno por overlay, solo mobile).
- **Mobile**: dos cajones independientes — sidebar (hamburguesa) y "chrome" (`Session ▾`, que
  muestra toolbar + tabs). Ambos con reglas de auto-colapso distintas repartidas por
  `main.ts:915-989`, `sessionCore.ts:335,345,839,923` y `viewSwitch.ts:217,228,237`.
- **Rol**: botones admin/lead se ocultan por clase (`applyAdminVisibility`), pero `Observers` y
  `Ports` se muestran a todos y fallan con toast (`index.html:206-212`).

### 1.3 Menús y acciones por superficie

| Superficie | Acciones |
|---|---|
| Header desktop | sidebar toggle, Templates, Invites*, My groups*, Admin*, Notifications, Logout, `+` Insert |
| Header mobile | sidebar toggle, pill `Session › Tab/Vista` (abre cajón), `+` Insert |
| Sidebar | Refresh, Show terminated, `+ New session`, por sesión: abrir, ▶ Start / ⏸ Stop / ↻ Restore, ✕ Terminate (Shift = hard), sección observables (lead), footer (6 botones duplicados) |
| Toolbar Terminal | nombre + badge estado, view-switch, Aa (font), Observers, Ports, ⌕ búsqueda (Ctrl+Shift+F) |
| Tabs | chip (click), × cerrar (confirm nativo), `+` nuevo tab |
| Key bar (mobile, pointer coarse) | esc, tab, ctrl (sticky), ^C, ↑↓←→ (repeat) |
| Files | `‹ Terminal`, breadcrumbs, ↻, árbol (teclado ok), preview: `‹ Files`, Preview/Source, Format JSON, Copy, Download |
| Git | `‹ Terminal`, resumen rama, ↻, lista (teclado ok), Start session (si stopped), candidatos de repo, diff: `‹ Changes` |
| Chat | `‹ Terminal`, `‹` back, ↻, lista (teclado ok), hilo: Load earlier, Copy Markdown/report/code, Agents, pill ↓N new / Jump to latest, composer (Send, Ctrl+Enter), "Open terminal", "I checked the Terminal" |
| Insert (+) | Paste text, Attach file, Download file… (`prompt()` nativo), Select & copy |
| Admin | Refresh, por sesión: Observe, Stop, Delete, Edit caps; usuarios: Edit quotas; grupos: New/Edit/Members/Delete |
| My groups | Refresh, Observe "<name>" por sesión running |
| Observe | Take control / Release control (confirm nativo), cerrar |

\* visibilidad por rol.

---

## 2. Auditoría funcional por pantalla

Formato: hallazgo → consecuencia → evidencia. Severidad en §4.

### 2.1 Shell, header y sidebar

- **Dos menús de usuario idénticos** (`index.html:119-127` y `:167-175`), seis pares de
  botones, cada par con su propio wiring y su propia lógica de "qué botón devolver el foco"
  (`myGroups.ts:61-63`, `invites.ts`, `admin.ts:101`). Mobile además muestra `●` como "usuario"
  (`main.ts:283`) — no hay nombre de usuario visible en ninguna superficie.
- **Filas de sesión no accesibles por teclado**: `div.session-item` con `click`
  (`sessionCore.ts:103,251`). Tampoco las observables (`myGroups.ts:265-287`). Un usuario de
  teclado o lector de pantalla no puede abrir una sesión.
- **Acciones destructivas con `confirm()` nativo** y semántica oculta: Shift-click en ✕ = hard
  delete (`sessionCore.ts:217-233`). No hay equivalente táctil del Shift; en una sesión
  `terminated` el mismo botón pasa a ser "Delete permanently".
- **Sesiones `failed` no abren**: clic → modal de log (`sessionCore.ts:256-263`); el workspace
  existe pero Files no es alcanzable para ellas.
- **El sidebar en desktop no se puede colapsar a "rail"**: o 260 px o 0 (`main.css:459-467`),
  con el toggle en el header. A 1024 px (iPad landscape) el área útil para Chat de tres columnas
  queda en ~380 px.
- **Auto-poll cada 5 s** re-renderiza la lista completa (`renderSessionList` hace `innerHTML =
  ""`): pierde foco/hover; en mobile las acciones ▶/⏸/✕ siempre visibles (`main.css:2295`)
  con targets de ~24 px.

### 2.2 Terminal (S3)

- **Controles exclusivos del Terminal** (correcto que lo sean, mal que vivan en la toolbar
  compartida): Aa y ⌕ se deshabilitan con overlay (`viewSwitch.ts:140-142`); `+` Insert y key
  bar se ocultan (`main.ts:951`, `inert`). Observers y Ports (acciones de **sesión**, no de
  terminal) quedan en la misma toolbar y siguen activos.
- **Desconexión definitiva = pantalla vacía**: tras agotar los 6 reintentos (`reconnect.ts:13`),
  `sessionCore.ts:643-671` elimina el pane y oculta el contenedor. Queda la toolbar con badge
  `running` (si el backend sigue running) y nada debajo. No hay CTA "Reconectar"; en mobile el
  chip está en el cajón colapsado. El badge `disconnected` existe en CSS (`main.css:1744`) pero
  nunca se asigna (solo `reconnecting`, `:687-688`).
- **Terminal deshabilitado en sesión parada** solo explica por `title`
  (`viewSwitch.ts:198-200`), invisible en táctil. Git sí ofrece "Start session"
  (`gitView.ts:557-558`); Files y Chat no.
- **Chips de tab no accesibles** (`div.tab-chip`, `sessionCore.ts:483-514`); no hay rename;
  cerrar usa `confirm()`.
- **Hint de selección** (`main.ts:666-711`) se inyecta por pane y usa `innerHTML` controlado;
  es la única ayuda contextual de la app y no tiene equivalente en mobile.
- **Búsqueda** (`searchBar.ts`): input en la toolbar; Enter/Shift+Enter sin indicación visual;
  resultado es la UI de copy-mode de tmux. Cerrar cancela copy-mode **del pane donde se buscó**
  (bien) pero no hay feedback de "n coincidencias".
- **Fuente**: ciclo de 7 tamaños con un solo botón (`main.ts:994-1022`), sin menú. Tema de
  xterm hardcodeado (`terminal.ts:172-177`) separado de los tokens CSS.

### 2.3 Files (S4)

- Sólido: estados loading/empty/error con Retry, teclado en árbol, breadcrumbs, 403/404
  explicados, abort de previews superadas.
- **Mobile**: panel único tree/preview con `mobilePane` propio (`filesView.ts:95`) y botón
  `‹ Files` construido en TS (`:539-551`) — el mismo patrón que Git (`gitView.ts:112, 599-611`)
  y Chat (`chatView.ts:146, backBtn`), tres veces.
- `copyText` local (`filesView.ts:316-334`) duplicado en `chatView.ts:1664-1685`; el Terminal
  tiene un tercero con estrategia distinta (`terminal.ts:382-404`, execCommand primero).
- No hay "Abrir en Terminal" (p. ej. `cd` al directorio) ni "Ver diff" desde un archivo
  modificado — las vistas no se enlazan entre sí.
- `Download file…` del menú `+` pide la ruta con `prompt()` (`actions.ts:119`): duplica a
  Files con peor UX.

### 2.4 Git (S5)

- Sólido: cola FIFO respetando el cap del backend, estados `session-not-running` con Start y
  auto-reload al poll, candidatos de repo, diff capado y explicado.
- Mismo triplicado de panel-único mobile (§2.3). Sin enlace "Abrir archivo en Files" desde una
  fila de cambio, ni "Ver cambios" desde Files.
- La cabecera (`#git-summary`) usa `aria-live="polite"` y se reconstruye en cada render:
  anuncia la rama en cada refresh.

### 2.5 Chat (S6)

- Lo más completo: skeletons, offline banner, pill de nuevos, anchor de lectura, unread por
  conversación, composer con razones en palabras, anuncios ARIA de respuestas finales.
- **Es la única vista con tokens CSS** (`main.css:3333-3349`) — su identidad visual ya es la
  que debería adoptar el resto.
- **Botón "Open terminal" en el estado vacío solo si no es mobile o capture es efectivo**
  (`chatView.ts:716-717`): en mobile sin capture el usuario no tiene cómo ir al Terminal salvo
  el nav inferior; la condición no tiene explicación en el código.
- **Composer en mobile**: textarea al pie del overlay; el nav inferior (`#view-nav`, z-index 30,
  `bottom:0`) y el teclado virtual compiten por el borde inferior. `--app-vh` reduce
  `#terminal-area`, así que debería funcionar, pero **no está verificado en iOS**
  (`.chat-float { bottom: 4.4rem }` sugiere que se compensó a mano).
- Panel Agents como bottom sheet (`main.css:4356-4368`) sin gesto de cierre ni backdrop.
- No hay enlace de un tool call a Files (p. ej. `Edit` de `src/x.ts` → abrir en Files) ni
  del bloque `Open terminal` al tab correcto.

### 2.6 Modales (S7–S19)

- **Trece implementaciones de open/close**: cada módulo hace `classList.add("open")` +
  `aria-hidden` + foco al cerrar a mano; Escape centralizado en `main.ts:1024-1076` con el
  orden de apilado **codificado a mano**; la guarda del sidebar mobile repite la lista
  (`main.ts:839-874`). Un modal nuevo exige tocar tres sitios.
- **Ningún modal atrapa el foco** (Tab sale al fondo). `aria-modal="true"` sin focus trap es
  una promesa incumplida para lectores de pantalla.
- **New session**: 5 tabs dentro de un modal; en mobile, formularios largos (SSH key, agent
  seed) dentro de un card con scroll interno y teclado virtual. El live tail del bootstrap se
  inyecta en el tab Basics (`newSession.ts:200`) y cerrar el modal pierde el tail (la sesión
  sigue creándose sin indicación en el sidebar hasta el próximo poll).
- **Admin**: dashboard entero (stats, sesiones, usuarios, grupos, log) como un modal con
  `#admin-scroll-area`. Es una página. Las acciones usan `confirm()`; "Edit caps"/"Edit quotas"
  son formularios inline con validación propia.
- **Observe (S15)**: xterm en modal, solo primer tab, `fontSize` fijo al abrir; cerrar desde
  My groups por backdrop está parcheado (`myGroups.ts:73-90`). Es, de hecho, una segunda
  "app de terminal" sin tabs, sin Files/Git/Chat, sin key bar.
- **Observers (S16)**: visible para todos; si 403 → toast y se cierra (`admin.ts:1118-1125`).
- **Ports (S17)**: tabla de 5 columnas en un card de modal; en mobile no cabe (inputs a 16 px
  forzados, `main.css:2179-2183`).
- **Insert (S18)**: menú implementado como modal con título "Insert" y ×; en desktop se abre
  centrado aunque el `+` está en la esquina.

### 2.7 Estados: error, carga, desconexión, reconexión

| Situación | Hoy | Problema |
|---|---|---|
| WS terminal cae (1006) | badge `reconnecting`, 6 intentos con backoff | bien; pero sin contador ni "reintentar ahora" |
| WS terminal se rinde | pane eliminado, contenedor oculto, toast rojo | sin CTA; mobile: chip oculto |
| Sesión parada desde otro dispositivo | probe → `disconnected` | igual que arriba |
| Backend caído en login | `showAuth()` sin mensaje (`main.ts:267-269`) | el usuario ve un login que fallará |
| 401 / cookie expirada | evento → logout + toast | bien |
| Toasts | un solo `#toast`, 4 s, sin `aria-live`, se pisan | errores perdidos; no anunciados |
| Chat WS cae | banner "Connection lost" + pill Live/Offline | bien |
| Files/Git/Chat error de carga | `stateBox` + Retry | bien, pero estilos `.files-state` compartidos por nombre |
| Crear sesión | tail en el modal; cerrar = perder el tail | sin indicador en la fila del sidebar |
| Poll 5 s falla | toast rojo cada 5 s (`refreshSessions` catch) | ruido en cortes de red |

### 2.8 Responsive, viewport, gestos

- **Un solo breakpoint** (768 px). Tablet portrait (768) cae en mobile (drawer + key bar si
  pointer coarse); tablet landscape (1024) cae en desktop con sidebar fija de 260 px.
- **Mobile Terminal**: `--app-vh` desde `visualViewport` (`main.ts:149-157`), `interactive-widget`
  en el meta, `touch-action:none` + scroll sintetizado a SGR (`terminal.ts:809-974`), key bar
  con `pointerdown` para no perder el foco. Esta parte es madura y debe conservarse íntegra.
- **Cajón "chrome"** oculta toolbar + tabs con `!important` (`main.css:2258-2263`); la toolbar
  hace scroll horizontal cuando se muestra (`:2268-2275`). El view-switch está ahí dentro.
- **`#view-nav`** solo con overlay activo: el usuario en Terminal no ve que existe Chat.
- **Gestos**: no hay swipe entre panes mobile ni para cerrar el bottom sheet de Agents; el
  sidebar drawer no se cierra con swipe. Back del sistema no cierra modales ni vuelve de un
  overlay (nada en `history`).
- **Teclado virtual**: Terminal ok; composer de Chat y formularios de modales no verificados
  en iOS standalone (safe-area + `--app-vh`).
- **Desktop**: toolbar sin `flex-wrap` (`main.css:1714-1723`); con sidebar abierta y ventana
  ~1000 px, el input de búsqueda + view-switch + 4 botones pueden desbordar (a verificar).

### 2.9 Accesibilidad

- Positivo: `inert` en subárboles cubiertos, `aria-pressed` en switches, roles `tree`/`list`,
  roving focus en listas, `aria-live` en Chat, `prefers-reduced-motion` (`main.css:3798`),
  labels en botones-glifo, 16 px en inputs mobile.
- Negativo: filas de sesión y chips de tab no focalizables; toasts sin `aria-live`; modales sin
  focus trap ni `inert` del fondo; `#toast` único (los errores se pisan); color como único
  canal de estado en `.session-dot` (sin texto); `--c-faint #6e7681` sobre `#0d1117` ≈ 4.0:1
  (límite para texto pequeño); sin tema claro; sin `:focus-visible` consistente fuera de Chat
  (`main.css:3365`); idioma de UI inglés con `lang="en"` fijo.

---

## 3. Matriz de controles y acciones

Leyenda: ✔ funciona · ◐ visible pero deshabilitado con explicación · ✖ visible y no funciona
(o falla tarde) · — no existe en esa superficie · (m) solo mobile · (d) solo desktop.

| Acción | Terminal | Chat | Files | Git | Sesión parada | Sesión ajena (observe) | Dónde debería vivir |
|---|---|---|---|---|---|---|---|
| Cambiar vista | ✔ toolbar (d) / cajón (m) | ✔ nav (m) / toolbar (d) | ✔ | ✔ | ✔ (Terminal ◐ por `title`) | — | Barra de sesión persistente (§5.2) |
| Start / Stop / Restore | ✔ sidebar | ✔ sidebar | ✔ sidebar | ✔ sidebar + Start inline | ✔ sidebar | — | Menú de acciones de sesión + CTA en estados vacíos |
| Terminate / Delete (hard) | ✔ sidebar (Shift) | ✔ | ✔ | ✔ | ✔ | — | Menú de acciones con diálogo propio (sin Shift) |
| Nuevo tab / cerrar / cambiar | ✔ chips (no teclado) | — (`inert`) | — | — | ✖ (toast "start it first") | ✖ (solo tab 1) | Barra de tabs del Terminal (como botones) |
| Reconectar tras `disconnected` | ✖ (solo re-click chip; m: oculto) | — | — | — | — | ✖ toast | Estado vacío del Terminal con CTA |
| Font size | ✔ | ◐ | ◐ | ◐ | ◐ | ✖ (fijo al abrir) | Menú del Terminal (y aplicar a observe) |
| Buscar historial | ✔ (Ctrl+Shift+F) | ◐ | ◐ | ◐ | ◐ | — | Toolbar del Terminal |
| Observers | ✔ (403 → toast) | ✔ | ✔ | ✔ | ✔ | — | Menú de sesión, oculto si no autorizado |
| Ports | ✔ | ✔ | ✔ | ✔ | ✔ | — | Menú de sesión ("Configuración") |
| Paste / Attach / Select&copy | ✔ `+` | ✖ oculto | ✖ oculto | ✖ oculto | ◐ (Attach sube igual, toast) | — | Toolbar del Terminal (m) |
| Download archivo | ✔ `prompt()` | — | ✔ preview | — | ✔ Files | — | Files (quitar del `+`) |
| Copiar texto | ✔ auto/Cmd-C | ✔ botones | ✔ botón | — (sin copiar diff) | ✔ Files/Chat | ✔ auto | `clipboard.ts` único |
| Enviar mensaje a Claude | — (escribir en tmux) | ✔ composer | — | — | ◐ razón | — | Chat; atajo "Open terminal" al tab correcto |
| Abrir archivo desde otra vista | — | ✖ (tool calls sin enlace) | — | ✖ (fila → sin Files) | — | — | Enlaces cruzados Chat→Files, Git→Files, Files→Git |
| Refresh | sidebar | ✔ | ✔ | ✔ | ✔ | — | Por vista (ok) + global en sidebar |
| Templates / Invites / Groups / Admin / Notif / Logout | ✔ header (d) + footer (m) ×2 | igual | igual | igual | igual | igual | Menú de usuario único |
| Observar sesión ajena | My groups / sidebar / Admin / deep link | igual | igual | igual | igual | modal aparte | Abrir en el shell como sesión "ajena" (§5.6) |
| Escape / Back | cierra modal topmost (lista a mano) | cierra Agents / vuelve a lista (m) | — | — | — | cierra modal | Dialog stack + router (`history`) |

Controles que **solo funcionan desde Terminal**: `+` Insert (paste/attach/select), key bar,
font size, búsqueda, Ctrl+Shift+F, hint de selección, tabs. Controles **visibles que no están
conectados o fallan tarde**: Observers para no autorizados; Terminal deshabilitado sin CTA;
`Open terminal` ausente en Chat mobile sin capture; Download por `prompt()`; chips/filas sin
teclado. Acciones **ausentes**: reconectar, renombrar tab, enlaces cruzados entre vistas,
colapsar sidebar a rail, cambiar tema/idioma, "copiar diff", abrir sesión ajena con contexto.

---

## 4. Problemas UX por severidad

Criterio: **Alta** = bloquea una tarea o excluye a un grupo de usuarios; **Media** = fricción
frecuente o inconsistencia que confunde; **Baja** = pulido.

### Alta

- **UX-01 Navegación de vistas invisible desde Terminal en mobile.** `#view-nav` solo con
  overlay (`viewSwitch.ts:166-168`); el switch está en el cajón colapsado. Consecuencia: Chat,
  la vista que se quiere principal, está a dos toques de un control oculto.
- **UX-02 Sesiones y tabs no operables por teclado / lector de pantalla.**
  `sessionCore.ts:103-266, 483-514`.
- **UX-03 Desconexión sin salida.** Pane eliminado, sin CTA, chip oculto en mobile
  (`sessionCore.ts:643-671`). El usuario cree que la app se rompió.
- **UX-04 Modales sin focus trap, con apilado manual y Escape por lista.** Trece modales,
  `main.ts:839-874` y `:1024-1076`. Riesgo real de regresión con cada modal nuevo; a11y rota.
- **UX-05 Sesión ajena fuera del shell.** Observe = segundo terminal en modal, primer tab,
  sin vistas (`observeModal.ts`). Admin/lead no tienen "la misma sesión y contexto".
- **UX-06 Toasts sin `aria-live` y con pisado.** `main.ts:616-649`, `index.html:400`. Errores
  de red se pierden; el poll de 5 s puede generar uno por tick.

### Media

- **UX-07 Seis pares de botones duplicados header/footer** y `●` como identidad de usuario.
- **UX-08 Tres implementaciones de master-detail mobile** (`mobilePane` ×3, back ×3,
  clases `show-preview/show-diff/show-thread`).
- **UX-09 Acciones destructivas con `confirm()`/`prompt()` nativos y Shift-click oculto**
  (`sessionCore.ts:217-233`, `actions.ts:119`, `observeModal.ts:187-193`, `closeTab`).
- **UX-10 Terminal deshabilitado sin acción en sesión parada** salvo en Git. Files y Chat no
  ofrecen Start; Chat forzado a Files al abrir una sesión parada (`viewSwitch.ts:205-208`).
- **UX-11 Sin enlaces cruzados entre vistas** (Chat tool → Files; Git fila → Files; Files →
  Git; Chat → tab de Terminal correcto).
- **UX-12 URL sin vista/tab/conversación**; Back no navega; gesto Back sale de la PWA.
- **UX-13 Admin y New session como modales.** Página entera en un card con scroll interno;
  formulario de 5 tabs en mobile.
- **UX-14 Sin tier tablet**; sidebar no colapsable a rail; Chat 3 columnas a 1024 px.
- **UX-15 Sin sistema de tokens**: 616 selectores, ~40 literales hex, variables solo en Chat,
  tema xterm aparte. Un tema claro o un cambio de acento es inabordable.
- **UX-16 Poll de sesiones re-renderiza todo** y toasta en cada fallo (`sessionCore.ts:71-86`).
- **UX-17 Ports y Observers son acciones de sesión en la toolbar del Terminal**; `+` Insert y
  key bar desaparecen en overlays sin indicación.

### Baja

- **UX-18** `Open terminal` condicionado en Chat mobile (`chatView.ts:716-717`).
- **UX-19** `#git-summary aria-live` anuncia en cada refresh.
- **UX-20** Panel Agents (bottom sheet) sin backdrop ni gesto.
- **UX-21** Bootstrap live tail se pierde al cerrar el modal; sin indicador en la fila.
- **UX-22** Font size: ciclo ciego de 7 pasos; no aplica al observe abierto.
- **UX-23** Hint de selección solo desktop; única ayuda contextual.
- **UX-24** Sesiones `failed` no abren Files.
- **UX-25** Insert menu como modal centrado en desktop.
- **UX-26** Sin `:focus-visible` consistente fuera de Chat; `--c-faint` al límite de contraste.
- **UX-27** Badge `disconnected` nunca asignado; `stopped` ambar igual que `reconnecting`.
- **UX-28** `lang="en"` fijo; sin i18n (no se propone traducir ahora, solo no cerrar la puerta).

---

## 5. Arquitectura propuesta

### 5.1 Invariantes que se conservan (no negociables)

1. **El Terminal nunca se desmonta, redimensiona ni reconecta por un cambio de vista.** Files,
   Git y Chat siguen siendo overlays absolutos sobre `#terminal-area`; `inert` sigue
   protegiendo el subárbol cubierto. Se añade un **test de invariante** (§8.2) que espía
   `WebSocket.send` y falla si un `setView` produce `{type:"resize"}` o un `new WebSocket`.
2. **La caja del Terminal en mobile es constante** entre vistas. La propuesta de barra inferior
   persistente (§5.3) se diseña para cumplir esto, no para romperlo.
3. **Todo lo de `terminal.ts`, `keyBar.ts`, `paste.ts`, `searchBar.ts`, `reconnect.ts`** se
   conserva. Cambia quién los invoca, no qué hacen.
4. **Chat, Composer, Files, Git y sus sockets/colas** no cambian de contrato: `chatView.ts`,
   `gitView.ts`, `filesView.ts` solo ceden su "cascarón" (header, back, mobilePane) al
   componente compartido; el modelo, la cola FIFO, el anchor de lectura y el composer se
   mantienen.
5. **Autorización sigue siendo del backend.** La UI oculta/deshabilita por capacidad, pero
   ningún gate del cliente reemplaza un `assert*` del servidor.
6. **Un cambio de vista no tiene efectos secundarios fuera del navegador.** No reinicia
   Claude, no crea procesos, no reabre WebSockets que sigan vivos, no altera el pane de tmux,
   no envía `resize` y no pierde el estado de Chat, Terminal, Files ni Git. El modelo de sesión
   (metadatos, capacidades, permisos, estado de conexión, acciones) es **uno** y lo comparten
   todas las vistas.
7. **Ningún control se dibuja sin función real.** Una acción no disponible se muestra
   deshabilitada con su razón (texto visible, no solo `title`) o no se muestra.

### 5.2 Shell de aplicación

```
┌──────────────────────────────────────────────────────────────────┐
│ AppHeader   [☰] Shared Terminal                 [🔔] [usuario ▾] │
├────────────┬─────────────────────────────────────────────────────┤
│ Sidebar    │ SessionBar  ● my-project  running   [Chat][Term][Files][Git]  [⋯] │
│ (sesiones, │─────────────────────────────────────────────────────│
│ observables│ View area (una vista activa; Terminal siempre montado) │
│ , + New)   │                                                     │
│ colapsable │                                                     │
│ a rail     │                                                     │
└────────────┴─────────────────────────────────────────────────────┘
```

- **AppHeader**: solo global. Un **UserMenu** (nombre de usuario, rol, Templates, Invites,
  My groups, Admin, Notifications, Logout) reemplaza a `header-right` + `sidebar-footer`. Un
  solo componente, un solo wiring.
- **SessionBar** (nuevo, `sessionBar.ts`): nombre, badge de estado **con texto**, el
  **ViewTabs** (Chat · Terminal · Files · Git) y el **SessionActionMenu** (⋯): Start/Stop/
  Restore, Ports, Observers (solo si autorizado), Rename, Copy link, Terminate, Delete. Visible
  en **todas** las vistas y en mobile sin cajón. Sustituye a `#terminal-toolbar` como contenedor
  de lo que es de sesión; lo que es del Terminal (Aa, ⌕, tabs, `+` Insert) pasa a una
  **TerminalToolbar** dentro de la vista Terminal.
- **Sidebar**: lista de sesiones como `button`s con roving focus (como ya hacen Files/Git/Chat),
  acciones por fila delegadas al mismo `SessionActionMenu`; colapsable a rail en desktop
  (iconos + inicial) y drawer en mobile (como hoy).
- **Terminal view**: `TerminalToolbar` (tabs como `button`s, `+` tab, Aa como menú de tamaños,
  ⌕, `+` Insert en mobile) + panes + key bar. Estado vacío propio: "Sin tabs → Abrir tab";
  "Sesión parada → Iniciar"; "Desconectado → Reconectar / Ver estado".

### 5.3 Mobile

```
┌────────────────────────────┐
│ ☰ my-project ▾  💬 ▣ ▤ ⎇  ⋯│  SessionBar compacta: nombre + ViewTabs (iconos) + menú
├────────────────────────────┤
│                            │
│   vista activa             │
│                            │
│                            │
├────────────────────────────┤   Terminal con teclado abierto: la KeyBar
│ esc tab ctrl ^C ↑ ↓ ← →    │   como hoy, pegada al teclado. Las vistas
│ [   teclado del sistema  ] │   siguen a la vista arriba, en la SessionBar.
└────────────────────────────┘
```

- **ViewTabs compactos en la SessionBar** (decisión §9.2): los cuatro iconos (Chat, Terminal,
  Files, Git) viven en la barra superior, siempre visibles en todas las vistas, con la activa
  resaltada y etiquetada (`aria-label` + texto para la activa, tooltip para el resto). Caben
  en 360 px con el nombre de sesión truncado. **No hay barra inferior de navegación**: con el
  teclado abierto las vistas siguen a la vista, la KeyBar conserva su sitio y comportamiento
  exactos (`pointerdown + preventDefault`), y el Terminal no cede ni un píxel más que hoy.
  Como el único elemento que cambia entre vistas es cuál overlay está visible, **la caja del
  Terminal no cambia al cambiar de vista** (invariante 5.1.2). Un punto de no leído sobre el
  icono de Chat reemplaza al texto "Chat •" del desktop.
- **Cajón "chrome" desaparece**: la SessionBar compacta siempre visible (una línea), los tabs
  del Terminal como fila scrollable dentro de la vista Terminal (ocultable con un toque en el
  nombre del tab, estado persistido). Se elimina la lógica repartida de auto-colapso.
- **Master-detail** (Files, Git, Chat): `SplitPane` compartido con panel único en mobile,
  título del detalle en la SessionBar compacta y back por `history` (gesto Back del sistema
  vuelve al listado, no sale de la app).
- **Sheets**: el menú ⋯, el panel Agents y el Insert son `BottomSheet` (backdrop, swipe-down,
  Escape) — un componente.

### 5.4 Router

`#/sessions/<id>/<view>[/<detalle>]` con `view ∈ chat|terminal|files|git` y `detalle` =
`cid` (chat), `path` (files), `area:path` (git), `tabId` (terminal). Extiende `deepLink.ts`
(el parser de `#/sessions/<id>` sigue aceptando la forma corta). `pushState` para vistas y
detalles, `replaceState` para selección de sesión (como hoy, para no convertir Back en un
carrusel). Páginas no-sesión: `#/admin`, `#/templates`, `#/groups`, `#/invites` (hoy modales).
`viewSwitch.ts` pasa a ser consumidor del router; `setView` sigue existiendo como API interna.
Los modales de confirmación **no** van al historial.

### 5.5 Registro de acciones de sesión

`sessionActions.ts` (puro, testeable): para una `SessionInfo` + rol + estado de conexión
devuelve la lista de acciones con `{ id, label, icon, enabled, reason?, danger?, run() }`.
Predicados: `canStart`, `canStop`, `canRestore`, `canDelete(hard)`, `canOpenTerminal`,
`canEditPorts`, `canSeeObservers` (owner/admin/lead — hoy el backend lo decide; la UI usa
`isAdmin()/isLead()` + ownership para ocultar en vez de fallar tarde), `canReconnect`.
Lo consumen: SessionActionMenu (barra y sidebar), estados vacíos (CTA = la acción habilitada),
command palette futura. Las confirmaciones pasan por `Dialog.confirm()` con texto y botón
peligroso explícito (adiós Shift-click: "Terminar" y "Eliminar definitivamente" son dos
entradas).

### 5.6 Sesión ajena en el shell (decisión de producto)

Una sesión observable (lead) u observable/operable (admin) se abre **en el mismo shell** como
`foreign: true`: SessionBar con "de <owner> · solo lectura / control", Terminal con todos los
tabs (hoy solo el primero) en modo observe/operate, KeyBar y `+` Insert solo en operate, y
**Chat/Files/Git deshabilitados con razón** ("solo el propietario puede ver archivos").
Esto no cambia el backend (`listTabs` ya es `assertCanObserve`, el WS ya acepta `?observe`).
**Ampliar Chat/Files/Git a admin/lead** es otra decisión (CLAUDE.md: "widening is a product
decision", sin audit trail de lectura) y queda fuera de esta propuesta.

### 5.7 Componentes compartidos (`frontend/src/components/`)

| Componente | Reemplaza | Notas |
|---|---|---|
| `dialog.ts` (Dialog/Sheet, stack, focus trap, `inert` del fondo, Escape, retorno de foco, `confirm()`/`prompt()` asíncronos) | 13 open/close manuales, dos cadenas de Escape, `confirm()`/`prompt()` nativos | un `<dialog>` nativo por diálogo (soporte ≥ 2022) con fallback a la implementación actual |
| `toast.ts` (cola, `aria-live`, tipos info/success/error, acción opcional "Reintentar", dedupe) | `showToast`, `showCopySuccessToast` | API compatible: `showToast(msg, isError)` sigue existiendo |
| `splitPane.ts` (lista \| detalle; mobile panel único; back; título al SessionBar) | `mobilePane` ×3, `‹ Files/‹ Changes/‹` ×3, clases `show-*` | Files, Git y Chat registran `renderList`/`renderDetail` |
| `actionMenu.ts` (desktop popover, mobile BottomSheet) | Insert (+) modal, acciones de fila del sidebar, Agents sheet | consume `sessionActions` |
| `segmented.ts` (ViewTabs, Preview/Source) | `#view-switch`, `.files-seg` | `aria-pressed`, teclado ←→ |
| `listRow.ts` (dot de estado + título + sub + badges, `button` con roving focus) | filas de sesión, observables, conversaciones, cambios git, árbol | el árbol conserva `role=treeitem` |
| `stateBox` (ya en `ui.ts`) | — | se mueve y gana variante con CTA de `sessionActions` |
| `clipboard.ts` | tres `copyText` | estrategia única: execCommand en gesto → `writeText` |

### 5.8 Sistema visual

- `styles/tokens.css`: los `--c-*` de Chat promovidos a toda la app + espaciado (`--s-1..6`),
  radios, tipografías (`--font-ui`, `--font-mono`), sombras, z-index escalonado
  (`--z-overlay 20`, `--z-nav 30`, `--z-dialog 40`, `--z-toast 50`). El tema de xterm se deriva
  de los tokens (`getComputedStyle`) para que Terminal y UI concuerden.
- `styles/{base,shell,terminal,files,git,chat,admin,forms}.css` importados desde `main.ts`
  (Vite los concatena); los `!important` del cajón desaparecen con el cajón.
- Iconografía: sprite SVG inline único (hoy: glifos Unicode `↻ ⌕ ▶ ⏸ ✕ 🔒` mezclados con SVG).
- Tema claro vía `prefers-color-scheme` **después** de los tokens (no en la primera fase).
- Breakpoints: `--bp-mobile 768`, `--bp-tablet 1100`. Tablet = sidebar en rail por defecto,
  Chat en 2 columnas (Agents como sheet), Files/Git en 2 columnas.

### 5.9 Chat como vista principal

- **Vista por defecto al abrir una sesión**: Chat si la sesión tiene ≥ 1 conversación
  (`GET …/conversations?capture=0`, ya barato) o capture efectivo; si no, Terminal (running) o
  Files (parada). Preferencia por usuario (`localStorage`, "última vista por sesión").
- **Sesión parada**: Chat sigue leyendo (los eventos están en el host); composer deshabilitado
  con "Inicia la sesión para escribir" + CTA Start. Hoy fuerza Files.
- **Terminal como vista avanzada**: siempre a un toque; "Open terminal" desde Chat lleva al
  **tab donde corre esa conversación** cuando el backend lo conoce (el pane/tab ya se usa para
  `binding-stale`), si no al tab activo.
- **Unread**: el punto por conversación que ya calcula Chat se eleva al ViewTab (desktop) / icono de Chat (mobile)
  ("Chat •") y a la fila de sesión del sidebar.
- **Enlaces cruzados**: tool call con ruta → "Abrir en Files"; fila de Git → Files; archivo
  modificado en Files → "Ver cambios"; Files/Git → "Abrir terminal aquí" (envía `cd` solo si el
  usuario confirma; opcional).

---

## 6. Propuesta visual

### 6.1 Desktop (≥ 1100 px)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ ☰  ⬛ Shared Terminal                                        🔔   diego ▾   │
├──────────────┬──────────────────────────────────────────────────────────────┤
│ Sessions  ↻ ⚙│ ● my-project  RUNNING   ┌──────┬──────────┬───────┬─────┐  ⋯│
│──────────────│                         │ Chat•│ Terminal │ Files │ Git │    │
│ ● my-project │                         └──────┴──────────┴───────┴─────┘    │
│   cpu 0.3 · 1G├──────────────────────────────────────────────────────────────┤
│ ○ api-poc    │ Conversations      │ Refactor auth flow          working ● Live│
│ ○ docs (stop)│ ───────────────────│ ───────────────────────────────────────── │
│              │ ● Refactor auth    │  You  10:21                               │
│ Observable   │   working · 2m     │  …                                        │
│ ◐ lead-sess  │ ○ Fix tests        │  Claude 10:22        [Copy] [Open in Files]│
│              │   idle · 1h        │  ✓ 3 tool calls  Edit src/auth.ts ▸       │
│ + New session│                    │ ───────────────────────────────────────── │
│──────────────│                    │ [ Message Claude…               ] [Send]  │
│ Templates    │                    │ Ctrl+Enter sends · / and ! → Terminal     │
└──────────────┴────────────────────┴───────────────────────────────────────────┘
```

Terminal view en el mismo marco: fila de tabs (`Tab 1 ×  Tab 2 •  +`) + `Aa ▾  ⌕` a la
derecha, xterm debajo. Admin/Templates/Groups/Invites: páginas en el área principal con la
SessionBar reemplazada por un PageHeader (título + acciones), sidebar intacta.

### 6.2 Mobile (≤ 768 px)

```
 Terminal (teclado cerrado)        Terminal (teclado abierto)      Chat
┌──────────────────────┐          ┌──────────────────────┐      ┌──────────────────────┐
│☰ my-proj ▾ 💬 ▣ ▤ ⎇ ⋯│          │☰ my-proj ▾ 💬 ▣ ▤ ⎇ ⋯│      │☰ my-proj ▾ 💬 ▣ ▤ ⎇ ⋯│
│ Tab 1 • │ Tab 2 │ +  │          │ Tab 1 • │ Tab 2 │ +  │      │‹ Refactor auth       │
│                      │          │ $ claude             │      │ working ● · Live     │
│ $ claude             │          │ > _                  │      │  You 10:21           │
│ > _                  │          ├──────────────────────┤      │  …                   │
│                      │          │esc tab ctrl ^C ↑↓←→  │      │  Claude 10:22        │
│                      │          │ [   teclado iOS   ]  │      │  ✓ 3 tool calls ▸    │
│                      │          │                      │      ├──────────────────────┤
│                      │          │                      │      │[Message Claude…][➤]  │
└──────────────────────┘          └──────────────────────┘      └──────────────────────┘
```

- La SessionBar compacta reemplaza al pill `Session ▾` y a la barra inferior: nombre (abre el
  selector de sesión), ViewTabs como iconos con la vista activa resaltada, `⋯` abre el
  BottomSheet de acciones (Start/Stop, Ports, Observers, Insert: Paste/Attach/Select,
  Terminate…).
- KeyBar exactamente como hoy, solo con Terminal enfocado y teclado abierto (§5.3).
- En Chat/Files/Git mobile el título del detalle va en la SessionBar con `‹` (back por
  `history`).

### 6.3 Tablet (769–1100 px)

Sidebar en rail (56 px, iconos + inicial, expandible al pasar/tocar), SessionBar completa,
Chat 2 columnas (lista 280 px + hilo; Agents como sheet lateral), Files/Git 2 columnas, KeyBar
solo con `pointer: coarse`.

### 6.4 Identidad

Paleta actual (GitHub-dark) conservada y tokenizada; acento `--c-accent #58a6ff`; estados
ok/warn/err ya definidos. Tipografía UI `system-ui` + mono `ui-monospace`. Radios 6/10/14.
Un solo set de iconos (SVG 20 px, trazo 1.8). Sin cambios de marca; el objetivo es coherencia,
no restyling.

---

## 7. Hoja de ruta incremental (un PR = un cambio coherente)

Cada PR es desplegable solo, mantiene CI (Biome + tsc + vitest) y respeta §5.1. Orden pensado
para que los primeros PRs no cambien nada visible y reduzcan riesgo a los que sí.

| PR | Nombre | Contenido | Toca | Riesgo | Verificación |
|---|---|---|---|---|---|
| 0 | `docs: UI unificada` | este documento (v1.0) | docs | — | — |
| 1 | `refactor(ui): tokens + split CSS` | `styles/tokens.css` (los `--c-*` de Chat promovidos a toda la app + espaciado, radios, z-index), partir `main.css` por área en el mismo orden de cascada, sustituir literales por tokens; xterm theme desde tokens. **Sin cambio visual.** | CSS, `terminal.ts:172` | bajo | screenshot diff antes/después con el harness del PR 3 ejecutado localmente |
| 2 | `feat(ui): dialog + toast compartidos` | `components/dialog.ts` (`<dialog>`, stack, focus trap, Escape, retorno de foco, `confirm`/`confirmDanger({ requireText })`/`prompt` async), `components/toast.ts` (`aria-live`, cola, dedupe). Migrar los 13 modales y las dos cadenas de Escape; sustituir `confirm()`/`prompt()`; eliminación irreversible exige escribir el nombre (decisión §9.5, el Shift-click sigue hasta el PR 4). | `main.ts`, todos los módulos de modal | medio (foco) | `dialog.test.ts`, `toast.test.ts`; checklist manual de cada modal |
| 3 | `test(frontend): harness Playwright` | Playwright (chromium) contra `vite dev` con backend mockeado determinista (`e2e/mockBackend.ts`, reutilizable por jsdom); screenshots 6 pantallas × 3 viewports + pruebas funcionales (login, abrir sesión, cambiar de vista, diálogos, reconexión). Job obligatorio en CI. | `frontend/e2e/`, `package.json`, `ci.yml` | bajo | el propio job |
| 4 | `feat(ui): sessionActions + a11y de listas` | `sessionActions.ts` con predicados (estado × rol × conexión → acciones con razón); filas de sesión y chips como `button` con roving focus; `SessionActionMenu` con "Terminar" y "Eliminar definitivamente" (adiós Shift-click); estados vacíos del Terminal con CTA (sin tabs / parada / desconectado + Reconectar); badge `disconnected`. Cierra UX-02, UX-03, UX-09, UX-10. | `sessionCore.ts`, `terminal` empty states | medio | `sessionActions.test.ts`; jsdom de reconectar; e2e |
| 5 | `feat(ui): router de vistas` | `router.ts` sobre `deepLink.ts`: `#/sessions/<id>/<view>[/<detalle>]`, `pushState`, Back; `viewSwitch` consume el router; rutas de página reservadas (`#/admin`…) todavía abren el modal actual. | `deepLink.ts`, `viewSwitch.ts`, vistas (leer/escribir detalle) | medio | `router.test.ts`; test de invariante Terminal (§8.2) |
| 6 | `feat(ui): shell v2 — SessionBar, ViewTabs, UserMenu` | SessionBar persistente con ViewTabs en todas las vistas (iconos compactos en mobile, §5.3); UserMenu único; fin del cajón "chrome" y de `#view-nav`; TerminalToolbar dentro de la vista. Detrás del flag runtime (§8.4). **Antes de activarlo por defecto: vista previa funcional desktop + mobile para revisión.** Cierra UX-01, UX-07, UX-17. | `index.html`, `main.ts`, `viewSwitch.ts`, CSS shell | **alto** (mobile/teclado) | matriz §8.3; invariante 5.1.2 medido (`term.rows` constante entre vistas); e2e |
| 7 | `refactor(ui): SplitPane + listRow` | Files, Git y Chat adoptan `splitPane`/`listRow`/`actionMenu` (Agents, Insert); back por router; `clipboard.ts` único. Cierra UX-08, UX-20, UX-25. | las tres vistas (solo cascarón) | medio | suites existentes sin cambios de aserción salvo selectores |
| 8 | `feat(chat): Chat como vista por defecto + enlaces cruzados` | regla §5.9 con última vista por sesión y fallback; Chat en sesión parada; unread en ViewTabs/sidebar; "Open terminal" al tab de la conversación; enlaces Chat→Files, Git→Files, Files→Git. Cierra UX-11, UX-18. | `chatView.ts`, `sessionCore.ts`, `filesView.ts`, `gitView.ts` | medio | tests del modelo intactos; jsdom de la regla; e2e |
| 9 | `feat(ui): páginas Admin/Templates/Groups/Invites + sesión ajena en el shell` | rutas `#/admin`, `#/templates`, `#/groups`, `#/invites` como páginas; observe/operate abre en el shell (`foreign`), todos los tabs, vistas deshabilitadas con razón; New session como página/sheet full-height en mobile. Cierra UX-05, UX-13, UX-21. | `admin.ts`, `newSession.ts`, `observeModal.ts` → `sessionCore` | medio | audit log: un open = un close; manual admin/lead; e2e |
| 10 | `feat(ui): tablet + rail + pulido; retiro del flag` | tier tablet, sidebar rail, tema claro por tokens, iconos SVG, `:focus-visible` global, contraste; se elimina el shell v1 y el flag. Cierra UX-14, UX-15 (resto), UX-26. | CSS, sidebar, `index.html` | bajo | screenshots |

Dependencias reales: 2 → 4, 6, 9; 4 → 6, 8; 5 → 6, 7, 8, 9; 6 → 7. PR 1, 2 y 3 son
independientes entre sí y pueden ir en paralelo. PRs 1–5 no cambian el layout visible de
producción; el primer cambio que un usuario nota es el PR 6, y solo con el flag activado.

---

## 8. Riesgos técnicos y estrategia de regresión

### 8.1 Riesgos

| Riesgo | Dónde | Mitigación |
|---|---|---|
| Un cambio de vista provoca `resize`/reattach del Terminal (reflow en todos los viewers) | PR 6, 7 | overlays absolutos se mantienen; nada se añade ni quita del borde inferior; test de invariante (§8.2); `term.rows/cols` asertados antes/después de `setView` |
| KeyBar deja de mantener el foco del xterm (teclado se cierra al tocar una tecla) | PR 6 | `keyBar.ts` no se toca: `pointerdown + preventDefault` y su montaje siguen idénticos |
| `<dialog>` nativo: `inert` del fondo y foco difieren entre Safari/Chrome; el observe-WS debe cerrarse al cerrar el diálogo | PR 2, 8 | `onClose` obligatorio en la API; test "un open = un close" (audit row) |
| Router: `pushState` en overlays + `replaceState` de sesión pueden pelearse con `#session=` del SW y con `hashchange` externo (#419) | PR 3 | parser único; tests puros con los tres formatos; `hashchange` solo consume formas nuevas |
| Chat por defecto cuesta una request extra al abrir sesión | PR 7 | `?capture=0` (sin probe); se reutiliza el poll de 15 s de Chat; fallback a Terminal si tarda > 300 ms |
| Migrar `confirm()` a diálogos asíncronos cambia el orden de `await` en handlers con guardas de identidad (`activeSessionId !== sessionId`) | PR 2, 4 | mantener las re-comprobaciones tras cada `await` (ya es el patrón); tests jsdom por acción |
| Focus/scroll de listas re-renderizadas (poll 5 s) con filas como `button` | PR 4 | mismo truco que Files/Git/Chat (recordar `data-*` enfocado); render por diff cuando sea trivial |
| Partir `main.css` cambia el orden de cascada | PR 1 | importar en el mismo orden que las secciones actuales; screenshot diff de 6 pantallas |
| Sesión ajena en el shell abre superficies owner-only por error | PR 8 | `foreign` deshabilita Chat/Files/Git en el cliente **y** el backend sigue respondiendo 404/403; test jsdom de que no se dispara ninguna request owner-only |
| Composer + teclado iOS | PR 6 | verificar en iOS standalone (sin barra inferior el composer solo compite con el teclado, como hoy) |
| ViewTabs compactos no caben con nombres largos a 320 px | PR 6 | el nombre se trunca primero; por debajo de 340 px el nombre se reduce al punto de estado y el nombre completo vive en el menú ⋯ |

### 8.2 Tests automáticos

- **Invariante Terminal** (nuevo, vitest + jsdom): monta un `TerminalSession` con `WebSocket`
  falso, llama `setView` por los cuatro valores y afirma: cero `send({type:"resize"})`, cero
  `new WebSocket`, `term.rows/cols` sin cambio, `inert` correcto. Se añade en el PR 3 y
  protege 5, 6, 7.
- **Puros**: `router.test.ts` (parser/serializer, compatibilidad con `#/sessions/<id>` y
  `#session=`), `sessionActions.test.ts` (matriz estado × rol × conexión → acciones),
  `dialog.test.ts` (stack, Escape topmost, retorno de foco), `toast.test.ts` (cola,
  `aria-live`).
- **Vistas**: las suites existentes (`filesView`, `gitView`, `chatView`, `conversationModel`,
  `composerText`) deben pasar sin cambios de aserción salvo selectores del cascarón.
- **Playwright** (decisión §9.6, PR 3): dev-dependency, chromium, job **obligatorio** en CI.
  Contra `vite dev` con un backend mockeado determinista (`e2e/mockBackend.ts`: sesiones,
  tabs, conversaciones, archivos, git; WebSockets simulados con `page.routeWebSocket`).
  Screenshots de 6 pantallas × 3 viewports (390, 900, 1280) y pruebas funcionales de
  navegación, diálogos (foco, Escape), reconexión y composer, desktop y mobile. Lo que exige
  tmux o Docker reales sigue en los smokes del workflow Session Image.

### 8.3 Verificación manual (matriz)

| Dispositivo | Qué verificar |
|---|---|
| iOS Safari + PWA standalone | KeyBar y ViewTabs con teclado abierto; safe-area; composer visible con teclado; Back gesture vuelve de detalle a lista; copiar |
| Android Chrome | `interactive-widget=resizes-content` + KeyBar; ViewTabs visibles con teclado; sheets; paste |
| iPad portrait / landscape | tier tablet; rail; Chat 2 columnas; key bar solo con touch |
| Desktop Chrome / Firefox / Safari | focus trap de diálogos; `:focus-visible`; Ctrl+Shift+F; selección Shift/Option+drag; WebGL fallback |
| Dos navegadores en la misma sesión | cambiar de vista en uno **no** redibuja tmux en el otro |
| Admin y lead | observe/operate en el shell; un open = un close en el observe log; vistas deshabilitadas |
| Sesión parada / terminada / failed | Chat lee historial; Files; Start desde CTA; failed abre Files + log |

### 8.4 Estrategia de despliegue

Feature flag de **runtime** (decisión §9.7) para los PRs 6–9. El backend expone
`uiShell: "v1" | "v2"` en `GET /api/auth/status`, leído de la variable de entorno `UI_SHELL`
(default `v1`); el frontend monta el shell indicado al arrancar. Rollback = cambiar la variable
y reiniciar el backend, sin redeploy de Pages. Override de prueba por navegador: `?ui=v2` (o
`v1`) se guarda en `localStorage` y gana sobre el valor del servidor; `?ui=` lo borra. Es el
único cambio de backend de la iniciativa: un campo nuevo en una respuesta existente, sin
migración. El flag y el shell v1 se retiran en el PR 10.

---

## 9. Decisiones aprobadas (2026-10-31)

1. **Chat como vista por defecto** cuando la sesión tiene conversaciones o captura efectiva
   (§5.9); se recuerda la **última vista por sesión** y gana sobre la regla por defecto, con
   fallback cuando esa vista no está disponible (Terminal en sesión parada → Chat si hay
   historial, si no Files).
2. **Navegación mobile siempre visible**: ViewTabs compactos (iconos) en la SessionBar
   superior, en todas las vistas, también con el Terminal enfocado y el teclado abierto. Sin
   barra inferior; la KeyBar conserva su sitio y no se convierte en una segunda navegación
   (§5.3).
3. **Sesión ajena en el shell** (§5.6) con observe/operate, validación obligatoria en backend
   en cada request y sin ampliar Chat/Files/Git a admin/lead.
4. **Admin, Templates, Groups e Invites como páginas** enrutadas (§5.4).
5. **Sin Shift-click**: "Terminar sesión" y "Eliminar definitivamente" son acciones explícitas
   con diálogo propio; la irreversible exige escribir el nombre de la sesión.
6. **Playwright** con screenshots y pruebas funcionales desktop/mobile sobre mocks
   deterministas, job obligatorio en CI; los smokes reales siguen en Session Image.
7. **Feature flag de runtime** `UI_SHELL` v1/v2 expuesto por `/api/auth/status`, override
   `?ui=` por navegador, rollback sin redeploy; se retira al completar la migración (§8.4).
8. **Orden**: tokens y componentes reutilizables primero (PR 1, 2, 3 en paralelo), luego
   acciones (PR 4), router (PR 5) y por último el shell (PR 6), sin dependencias artificiales
   entre PR. Antes de activar el shell v2 por defecto se presenta una vista previa funcional
   en desktop y mobile para revisar navegación, accesibilidad y comportamiento.

Fuera de alcance explícito: i18n, tema claro (solo preparado por tokens), ampliar permisos de
lectura a admin/lead, cambios de contrato de backend más allá del campo `uiShell`.

**Estado (2026-11-01).** Decisión 1 implementada en el shell v2 (`frontend/src/viewPolicy.ts`:
última vista elegida por sesión → Chat si hay historial capturado → Terminal/Files; una URL con
vista gana; la memoria vive en `localStorage` por navegador y la única consulta es la lista de
conversaciones de una sesión que el navegador no conoce, en paralelo al listado de tabs). El shell
v1 conserva su aterrizaje. Decisión 2: tras probar ambas variantes en un iPhone, la **barra
fusionada** (sesión y vistas en la línea del header) es la variante por defecto de v2; la barra en
dos líneas sigue disponible como alternativa con `?bar=stacked`. El botón Insert (+) pasa a los
controles del Terminal en la tira de tabs para que el nombre de sesión siga legible a 390 px.
