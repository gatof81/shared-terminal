# Renovación UI/UX — auditoría y propuesta (2026-11-13)

Estado: **dirección aprobada por el owner (2026-11-14)**. El rediseño se construye sobre
**shell v2**; la activación global de `UI_SHELL` todavía no está autorizada — ver
[`shell-v2-activation.md`](./shell-v2-activation.md) (criterios de aceptación y rollback).

- [`proposal.html`](./proposal.html) — el entregable: hallazgos con evidencia, **prototipo
  navegable** (desktop y mobile; sidebar A/B/C), sistema visual, plan por PR, límites con D3.
  Es un archivo autónomo: abrirlo en un navegador. No forma parte del build de producción.
- [`screenshots/`](./screenshots) — estado actual (`before-*`), generado con Playwright contra
  `frontend/e2e/mockBackend.ts` (sin backend ni datos reales). Proyectos `desktop`, `mobile`,
  `desktop-v2`, `mobile-v2`, más un escenario de carga (3 proyectos, 16 sesiones, nombres
  largos) a 320/375/430/768/1024/1440/1920 px y un barrido axe-core.

## Resumen de hallazgos

| Id | P | Problema |
|---|---|---|
| N1 | 1 | Proyectos listados dos veces en el sidebar, sin colapsar |
| N2 | 1 | La fila de sesión prioriza CPU/Mem sobre agente y estado de Claude (78 px por fila) |
| N3 | 1 | Mobile: 330 px de controles antes de la primera sesión (5 de 16 visibles a 320 px) |
| B1 | 1 | Un nombre largo parte la barra de sesión en dos líneas (cambia la caja de la terminal) |
| V1 | 1 | Project Chat y el directorio usan otra escala visual que las vistas de sesión |
| V2 | 1 | 30 tamaños de fuente, 24 radios, 34 colores fuera de `tokens.css` |
| V3 | 1 | Dos fondos para todo: no hay niveles navegación / contenido / elevado |
| M1 | 1 | El composer de Project Chat ocupa ~45 % de la pantalla del teléfono |
| M2 | 1 | #616 teclado iOS (abierto; requiere iPhone real) |
| A1–A2 | 1 | axe crítico: `aria-allowed-attr` en filas de Git, `aria-required-children` en `#tab-strip` |
| A3–A4 | 2 | Contraste en fila seleccionada y contadores; nombre accesible ≠ texto visible |
| V4, V5, C1, C2, S1, N4–N6, M3–M7 | 2–3 | Ver `proposal.html` |

## Sistema visual (resumen)

Superficies `0 lienzo #0a0d12 · 1 navegación #10141a · 2 elevado #171c24 · 3 flotante #1e242e`;
tipografía 11/12/13/14/16/20 px (monoespaciada para nombres de sesión, ramas, rutas);
espaciado 2/4/6/8/12/16/24/32; radios 4/6/10; controles 24/28/36 px con área táctil de 44 px;
estado de sesión por **forma + color**, estado de Claude como texto aparte, y «Te necesita»
solo con evidencia fresca del hook (regla vigente de presencia).

## Decisiones del owner (2026-11-14)

1. **Shell v2 es la base** de las vistas y componentes nuevos. No se invierte trabajo considerable
   en v1. `UI_SHELL` en VM100 no cambia hasta validar v2 en desktop y en iPhone con `?ui=v2`.
2. **Presencia de Claude en el sidebar**: sí, compacta, con las lecturas existentes — cada 30 s,
   solo proyectos expandidos y página visible, sin lecturas duplicadas, «desconocido» cuando la
   evidencia venció, estado por forma o texto además de color.
3. **#616** sigue abierto hasta una validación real en iOS.
4. Los cambios estructurales de navegación global necesitan validación visual del owner antes de
   activarse para todos.

## Estado (2026-11-14)

Mergeados: #638 (esta auditoría), #639 (B1, A1, A3), #640 (sidebar en árbol, N1–N3), #641
(drawer y toasts en el teléfono). En curso: #642 (presencia en el sidebar), accesibilidad
A2/A4 con barrido axe en CI, sistema visual (superficies por rol, escala tipográfica, radios).

## Plan

1. Correcciones (B1, A1–A4, toasts) — autónomo.
2. Tokens + iconos SVG — autónomo, sin cambio de estructura.
3. Sidebar en árbol — **borrador hasta el visto bueno**.
4. Vistas de sesión sobre tokens; tablet ≥ 768 px con sidebar fijo.
5. Project Chat (densidad, composer, markdown) — coordinado con B (`team.css` compartido).
6. Mobile (navegador a pantalla completa, composer compacto, #616 con prueba en iPhone).
7. Inicio y tema claro.

## Límites con D3 (Claude B)

Actualizado 2026-11-14 (diseño de D3, #643 §8.2 y §12.8): **B no toca archivos del frontend**.
A es dueño de todo `frontend/`, incluida la presentación de Project Chat (`team.css`,
`teamView.ts`); la lógica de `teamModel.ts` no se cambia sin acordarlo en el PR de B.
Para D3, A **solo diseña el espacio visual** (tarjeta de colaboración, tarjeta de alcance al
autorizar, estados de entrega, Pausar / Reanudar / Detener, entradas nuevas de «Para vos»); la
implementación espera el contrato de `GET …/grants/:id` y los eventos de D3 ya mergeados. No se
inventan campos ni APIs.
