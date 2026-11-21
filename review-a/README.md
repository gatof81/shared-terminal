# Revisión visual, hito (a): CSS consolidado

- **Qué se comparó:** `integration/simplify` @ `c3c137f` contra `d28dad7` en v2 (`?ui=v2`, la interfaz que pasó a ser la única).
- **Método:** backend mock del e2e, Chromium a 1x, transiciones apagadas y píxel exacto (`maxDiffPixels: 0`).
- **Tamaños:** 320×568, 390×844, 820×1100 (táctil), 1280×800 y 1440×900.
- **Pantallas (13):** terminal, sesión detenida, Files, Git, chat de agente, Project Chat, lista de agentes, ⋯ del proyecto, portada, cajón, menú de usuario, ⋯ de la sesión y nueva sesión.
- **Estabilidad de la base:** dos corridas sobre `d28dad7` dieron 0 diferencias entre sí.
- **Resultado:** el nuevo commit se corrió dos veces. Las dos dieron píxel idéntico en todo, salvo el ⋯ de la sesión a 320 y 390, que difiere porque tiene el ítem nuevo «Ocultar pestañas» (U-1 B, ya en curso). Ver `diffs.txt` y las dos capturas.
- **Lo que no cubre:** v1 (producción), el teléfono en horizontal, el teclado abierto, WebKit y el iPhone real.
