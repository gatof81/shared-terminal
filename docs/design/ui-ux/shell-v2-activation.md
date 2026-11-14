# Shell v2 — criterios de aceptación y rollback para la activación global

Estado: **v2 es la base del rediseño (decisión del owner, 2026-11-14). La activación global NO está autorizada todavía.** Producción sigue sirviendo `uiShell: v1`; v2 se prueba por navegador con `?ui=v2` (queda guardado en ese navegador; `?ui=` lo borra y vuelve al valor del servidor).

Este documento define qué tiene que cumplirse antes de pedir el cambio de `UI_SHELL` en VM100, cómo se hace y cómo se deshace. No cambia backend ni configuración.

## 1. Cómo probar hoy, sin tocar nada

| Dónde | Cómo |
|---|---|
| Desktop | Abrir la app con `?ui=v2` al final de la dirección. |
| iPhone | Lo mismo en Safari (y en la PWA instalada, si se usa: abrirla una vez con `?ui=v2`). |
| Volver a v1 en ese navegador | `?ui=v1`, o `?ui=` para seguir lo que diga el servidor. |

La elección es por navegador (localStorage): no afecta a otros dispositivos ni a otras personas.

## 2. Criterios de aceptación

Todos deben cumplirse. Los marcados **(iPhone real)** no se dan por cumplidos con Chromium ni con un emulador.

### A. Invariantes de terminal (bloqueantes)

1. Cambiar de vista (Terminal ⇄ Files ⇄ Git ⇄ Chat) no envía `resize` ni abre sockets, en desktop y en teléfono. Lo exige el spec de invariantes en `desktop-v2`, `mobile-v2` y `mobile-v2-stacked`.
2. La barra de sesión mantiene su altura con nombres largos, con y sin agente asignado (spec `session-bar`).
3. Abrir y cerrar el sidebar, el menú de usuario y el menú ⋯ no cambia la caja de xterm.
4. **(iPhone real)** Con el teclado abierto en Terminal: la barra de teclas queda visible, el cursor a la vista, sin saltos de scroll al escribir.

### B. Paridad funcional con v1

Cada acción de v1 tiene su lugar en v2 y fue ejercitada:

- Sesión: crear, iniciar, detener, terminar, borrar, renombrar/externalRef, puertos, env, log de bootstrap, observar (admin/lead).
- Terminal: pestañas (crear, cerrar, cambiar), búsqueda (Ctrl+Shift+F), tamaño de fuente, barra de teclas, pegar, subir archivos, menú (+).
- Vistas: Files (lista, preview, descarga), Git (status, diff, log), Chat de sesión (lectura, Composer, agentes, «Load earlier»).
- Proyectos: sidebar en árbol, página de proyecto, página de agente, Project Chat (Now / Threads / For you / New task), artifacts D2.
- Cuenta: menú de usuario (invitaciones, admin, plantillas, notificaciones push, cerrar sesión).
- Navegación: Back/Forward del navegador y gesto atrás en iPhone restauran vista y detalle; un enlace profundo (`#/sessions/<id>/<vista>/<detalle>`, `#/projects/…`) abre lo que nombra.

### C. Teléfono **(iPhone real)**

1. Nada queda bajo el notch, la barra de estado ni el indicador de inicio (safe areas), en vertical y horizontal.
2. Todos los controles tienen área táctil ≥ 44 px.
3. Los dos chats con teclado abierto: el último mensaje y el composer quedan visibles; la posición de lectura no salta. **Depende de #616, que sigue abierto.**
4. El drawer del sidebar abre, cierra (tap fuera, Escape en teclado externo) y no deja la página scrolleando detrás.
5. Los toasts no tapan controles.

### D. Calidad

1. CI en verde en los cinco proyectos de Playwright, incluidas las capturas base de `*-v2`.
2. Barrido axe sin violaciones críticas ni serias en las vistas principales con `?ui=v2`.
3. Validado a 320, 375, 390, 430, 768, 1024, 1280, 1440 y 1920 px con muchos proyectos y sesiones, nombres largos y estados vacío / error / desconectado.
4. Una semana de uso real del owner con `?ui=v2` en desktop y iPhone sin un bloqueante abierto.

## 3. Activación (cuando el owner dé el GO)

Es un cambio de configuración de backend: `UI_SHELL=v2` en el `.env` de VM100 y reinicio del backend. Lo ejecuta quien opera VM100, con el GO explícito del owner y respetando la regla de no reiniciar el backend mientras hay trabajo en curso en las sesiones.

1. Verificar que `main` desplegado en Pages es el commit validado.
2. Cambiar `UI_SHELL=v2` y reiniciar el backend.
3. Verificar: `GET /api/auth/status` responde `uiShell: "v2"`; abrir la app sin `?ui=` en desktop y iPhone; recorrer la lista corta de humo (abrir sesión, escribir en terminal, cambiar de vista, abrir Project Chat, enviar un mensaje).

No hace falta redeploy del frontend: el shell se elige en runtime.

## 4. Rollback

| Alcance | Acción | Tiempo |
|---|---|---|
| Una persona / un dispositivo | Abrir con `?ui=v1` | inmediato |
| Todos | `UI_SHELL=v1` (o quitar la variable) y reiniciar el backend | un reinicio |

Disparadores de rollback global: se pierde la entrada al terminal, un cambio de vista redimensiona tmux, no se puede enviar en un chat, o una acción de sesión (iniciar / detener) deja de estar al alcance.

Mientras v1 exista en el código, el rollback no necesita PR ni redeploy. Por eso **v1 no se retira en el mismo paso**: se retira en un PR aparte, después de un período acordado con v2 global y sin rollback.

## 5. Qué queda fuera

- Retirar el código de v1.
- Cualquier cambio de backend, flags o contratos.
- Cerrar #616: se valida aparte, en iPhone real.
