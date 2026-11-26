# Etapa 4 — Tablero de tareas: propuesta (exploración corta)

Prototipo: `index.html` (HTML estático, sin dependencias; datos ficticios en `data.js`). El panel «escenario»
cambia entre: con tareas, proyecto sin tareas, error al cargar, error al recargar y «la próxima acción choca (409)».
`?noproto` oculta el panel. Capturas en `shots/`. Base: la UI 3B de `main@7b683f0` (rail, temas, Pendientes,
Herramientas). Modelo: #794 §2–§5.
**Validado en Chromium** a 1440×900, 1280×800, 900×1100, 390×844 y 320×640; axe sin violaciones (WCAG 2.1 AA).
**No lo probé en Safari ni en un iPhone real.**

## 1. Dónde vive

- **Una sola fila en el rail**, sección **Tareas**, debajo de Conversaciones: «▦ Tablero» y debajo un resumen
  de solo señales (`9 abiertas · 1 bloqueada · 1 por aprobar`; ámbar si hay bloqueos o aprobaciones). No es
  una lista: las conversaciones siguen arriba y con todo su espacio.
- El tablero se abre en el área central, como un tema (`#/projects/<pid>/tasks`, detalle en `…/tasks/<id>`). En el
  teléfono es un paso más de la pila: proyecto → tablero → tarea, y Pendientes sigue en cada encabezado.
- **Ida y vuelta con la conversación sin duplicar.** Un mensaje con `task_id` lleva el chip `▦ #21 título`, que abre
  la tarea. El encabezado del tema muestra `◆ objetivo · 1/5` si el tema originó uno. El detalle enlaza
  «donde se pidió» y abre el tema en ese mensaje. Ninguno de los dos copia mensajes.

## 2. Tablero

- **Desktop (área central de 860 px o más): Kanban de 4 columnas** con encabezado fijo y conteos. Cada **objetivo es una franja**: la cabecera
  lleva título, `#id`, estado declarado, coordinador, `2/5 terminadas`, `31/40 pedidos` y ⋯. Las tareas sin
  objetivo van en una franja punteada «Sin objetivo». Terminado muestra lo reciente y abajo
  «Ver N terminadas anteriores» (paginado).
- **Teléfono y áreas angostas (tablet vertical, ventana partida): lista agrupada.** Arriba van los Objetivos (con barra de
  progreso, coordinador y alerta de presupuesto). Después vienen los grupos por estado, en orden de supervisión:
  En progreso, En revisión, Por hacer y Terminado. En la lista, cada tarjeta repite su objetivo (`◆ Login con OAuth`).
- Un objetivo tiene **un solo nivel**. Tocar la franja o la fila abre el detalle del objetivo, con sus tareas
  agrupadas por estado.

## 3. Tarjeta: declarado ≠ derivado

| Qué | Cómo se ve | Por qué |
|---|---|---|
| Estado **declarado** | La **columna** (en el teléfono, el grupo); en el detalle, una pastilla «En progreso ▾» con «declarado por @dev · 10:41» | Solo cambia con «Mover a…» |
| Actividad **derivada** | Líneas con un **punto** y texto: `● @dev trabajando en «tema» desde 10:41`, `○ en cola para @dev: detrás de #21`, `● ejecución interrumpida · Revisar`, `● @arq espera tu respuesta · Responder`, `■ trabajo ⎇ x activo` | Nunca mueve la tarjeta de columna. Los textos repiten las palabras del Equipo de 3B |
| Contradicción | La tarjeta en Terminado con borde ámbar y «⚠ Terminado, pero con trabajo activo». En el detalle explica que el estado no se corrige solo | El backend la devuelve como tal (#794 §4) |
| Bloqueo | Borde izquierdo rojo + «Bloqueada: motivo» | Es declarado: va fuera de «Ahora» |
| Dependencia | «↳ Depende de #21 (en progreso)». Desaparece cuando la otra está terminada | |
| Externa | «⏱ Espera algo externo: …». Sin barra ni porcentaje | No se inventa progreso |
| Presupuesto | Tarea: «Presupuesto de la tarea agotado (12/12)». Objetivo: en la franja, en rojo, con «Ampliar» | |
| Prioridad | Solo se marca si no es normal: `↑ Alta` y `↓ Baja` | Menos ruido |
| Revisión del owner | Si la tarea está En revisión **sin revisor**: «Espera tu aprobación» + «Aprobar» | La única acción en la cara de la tarjeta |

La actividad sale de los datos de la lectura y de `/ws/acp`. **En el prototipo nada se mueve solo**: no hay temporizadores.
«desde 10:41» es un dato, no un reloj que avanza.

## 4. Detalle

En desktop es un panel lateral de 440 px sobre el tablero; ✕ o Esc vuelve a la tarjeta con el foco. En el teléfono es una pantalla
completa con ‹. El orden:

1. aviso de conflicto, si lo hay;
2. título y estado declarado ▾, con «Aprobar · Terminado» si está En revisión;
3. bloqueos y dependencias;
4. **Ahora** («según mensajes y trabajos · no cambia el estado»), con «Ver en el tema», «Revisar», «Responder» y «Herramientas»;
5. datos: responsable · Reasignar, revisor (o «vos»), prioridad (segmentado), objetivo y coordinador, pedidos usados;
6. descripción;
7. enlaces: conversación, trabajo (abre Herramientas en ese workspace) y PR (GitHub ↗);
8. historial: las últimas 5 entradas y «Ver todo».

El detalle de un **objetivo** cambia «Ahora» por **Presupuesto** (barra, «Ampliar») y por **Tareas**. Ahí van
«Coordina · Cambiar».

## 5. Acciones del owner (todas por menú o botón; sin arrastrar)

- **Mover a…**: desde el ⋯ de la tarjeta (junto con Prioridad, Reasignar y Abrir) o desde la pastilla de estado. Terminado con
  trabajo activo pide confirmación: marcarla Terminado no detiene nada y la contradicción queda visible. Un objetivo con
  hijas abiertas avisa que estas quedan como están.
- **Reasignar**: diálogo con el equipo y su estado. Si la ejecución anterior sigue activa, muestra un aviso ámbar
  («@dev sigue trabajando… Reasignar no la detiene; ⎇ oauth-callback queda abierto y sigue siendo de @dev»).
  Reasignar no envía ningún mensaje.
- **Aprobar Terminado**, **Prioridad**, **Cambiar coordinador** (con lo que pierde el anterior) y **Ampliar presupuesto**
  (+10/+20/+40; los pedidos rechazados no se reintentan solos).
- Después de cada acción: un toast y un destello en la tarjeta.

## 6. Vacíos y errores

- **Proyecto sin tareas:** «Las crean los agentes cuando un pedido tuyo necesita varios pasos; los simples se
  resuelven en la conversación» y el botón «Ir a las conversaciones». La persona no crea tareas desde el board: no está entre las acciones pedidas.
- **Columna vacía:** «—» tenue. En el teléfono: «Nada en revisión».
- **Error al cargar:** mensaje y «Reintentar»; aclara que las conversaciones siguen funcionando.
  **Error al recargar** con datos previos: una franja roja dice «Mostrando lo cargado a las 10:52; los cambios en vivo están en pausa» y ofrece Reintentar. No se vacía la pantalla.
- **409 `stale`:** el detalle muestra la **fila actual que vino en el 409**, con el aviso «La tarea cambió antes de
  guardar tu cambio: @qa la devolvió a En progreso (…). Tu cambio («Aprobar · Terminado») no se aplicó». Ofrece
  «Repetir: …» y «Dejarlo así». Nunca se reintenta solo.
- **Tarea inexistente** (por ejemplo, un enlace viejo): «Esta tarea ya no existe» y «Volver al tablero».

## 7. Para decidir (@architect)

1. **¿«Espera tu aprobación» entra en Pendientes?** Propongo que no sume al contador: el contador sigue contando preguntas e interrupciones, como en 3A.
   Solo el resumen de la fila del rail («1 por aprobar») lo mostraría.
2. **Lo que la lectura tiene que traer por tarea** para que esto no haga N+1: una lista `activity[]` con
   `{kind: running|queued|uncertain|waitOwner|work, agent, conversationId, since, behindTaskId?, questionId?, workId?}`,
   la contradicción ya calculada y los conteos de la fila del rail (o el evento `task` de `/ws/acp` los mantiene).
3. **Panel sobre el tablero** en desktop (tapa En revisión y Terminado mientras está abierto). Acoplarlo empujaría el
   tablero a la vista de lista en 1440. Recomiendo dejarlo encima.
