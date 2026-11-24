# Traspaso 3A → 3B (para @architect)

**La dirección UX está aprobada por el owner** (#1086). Material en esta rama:

- `PROPUESTA.md` (la §11 tiene los ajustes);
- `index.html` (el prototipo);
- `shots/` y `shots2/` (capturas);
- `current/` (la UI actual);
- `capture/` (los specs con los que se tomaron las capturas).

Este documento **no es un encargo de implementación**: el owner encargará 3B por separado.

## 1. Qué se aprobó, en una línea por pieza

| Pieza | Comportamiento visible |
|---|---|
| Rail del proyecto | Selector de proyecto · Pendientes · Conversaciones · Equipo (estado en palabras) · Trabajos · Archivo |
| Conversación (tema) | Equipo compartido del proyecto; cualquier agente entra con `@`; no hay membresía |
| Destinatarios | Chips explícitos, persistentes **dentro del tema**; un tema nuevo arranca vacío; «Todo el equipo» se resuelve al enviar |
| Estado de un mensaje | Una fila **por destinatario**: trabajando · en cola (motivo) · respondió · interrumpida; sin progreso agregado |
| Consultas entre agentes | La respuesta va anidada en su consulta; si llega tarde, al final aparece **solo una referencia** «Ir a la respuesta» |
| Interrupción (`uncertain`) | «Revisar interrupción»: hechos, informe de solo lectura, Git/Terminal; la acción principal es «Dar por revisada»; reencolar exige una confirmación explícita (el mismo `requeue`) |
| Pendientes | Global; el contador = preguntas abiertas + interrupciones sin revisar; los «resultados sin ver» van aparte, sin contador |
| Herramientas | Agente → Workspace (principal / trabajo) → Files · Git · Terminal; una franja con rama, directorio, base y puertos; Terminal = la sesión, sin workspace |
| Archivo | Los chats individuales y el Project Chat anterior pasan a ser temas de solo lectura con «Continuar en una conversación nueva» |
| Móvil | Pila: proyecto → tema → herramientas; Pendientes desde cada pantalla; el hilo conserva el punto de lectura con el teclado y al volver |

## 2. Lo que la UI necesita del backend (contrato mínimo, a validar)

1. **Tema en cada mensaje:** `conversation_id`, cuyo alcance es proyecto + tema. La respuesta lo hereda,
   como hoy `project_id`. Un mensaje `--work` conserva su tema y suma el trabajo.
2. **Temas:** crear, renombrar, archivar y listar por proyecto, con la última actividad.
3. **Por agente**, para el vocabulario de estado de la §4 de la propuesta:
   - los mensajes en curso, cada uno con su tema;
   - la cola, con el tema y la posición;
   - la pregunta abierta;
   - la consulta pendiente.

   `/agents` ya lista lo que está en curso (#747). Nada de slots en la UI.
4. **Respuesta ↔ origen:** el `reply_to` existe. La UI necesita el `reply_to` también para las
   respuestas de un agente a un mensaje del owner con varios destinatarios: es lo que permite la fila
   «respondió · ver» de cada uno.
5. **Visto / no visto en el servidor:** la última lectura por tema, igual en el teléfono y el
   escritorio. «Resultado» = la respuesta de un agente a un mensaje del owner.
6. **Interrupción revisada:** un estado o una marca `reviewed` que **no** reencola y saca el mensaje de
   Pendientes, además de los hechos que muestra la revisión: hora y motivo del corte, última actividad,
   y el vínculo con el informe de solo lectura que envía el runner. El reencolado sigue siendo el
   `POST /api/acp/messages/:id/requeue` actual.
7. **«Todo el equipo»:** que se guarde como tal (marca en el envío) además de las N filas por
   destinatario, para mostrar «→ Todo el equipo (4)».
8. **Pendientes global:** que sea un endpoint o una agregación en el cliente sobre todos los proyectos.
9. **Files/Git sobre un trabajo:** `.st/` está en `isRestrictedPath` (`workspaceFiles.ts`), así que hoy
   no se puede abrir `.st/ctx/<id>`. Hace falta una raíz por trabajo que no exponga el resto de `.st/`.
10. **Trabajo ↔ tema de origen:** para el enlace en la franja de Herramientas y en el rail.
11. **Archivo:** los mensajes directos (`project_id` NULL) y los de Project Chat anteriores se leen como
    temas de solo lectura; no se migran a temas activos.

## 3. Invariantes que el diseño asume (no romper)

- **Terminal:** cambiar entre tema, Herramientas, bandeja y menús ⇒ **0 `resize`**.
  - Los paneles se superponen; nunca achican la caja.
  - El hilo y la terminal siguen montados (el modelo de overlays con `inert` de hoy).
  - Hay que extender `terminal-invariant.spec.ts` a estos cambios.
- **Volver a un tema conserva la posición de lectura.** Un mensaje nuevo nunca mueve al lector que no
  está al final.
- **Nada se reintenta sin una decisión explícita del owner** (garantía de `uncertain`).
- La UI no muestra slots, sesiones ACP ni el ciclo de vida de recursos: solo el estado del agente en el
  vocabulario aprobado.

## 4. Criterios de aceptación sugeridos (para que @qa los adopte)

1. Un mensaje a un agente ocupado en otro tema muestra «en cola — ocupado en «X»» **antes y después** de
   enviar.
2. Un mensaje a 3 agentes tiene 3 filas de estado independientes; responder uno no cambia las otras dos.
3. Un tema nuevo arranca sin destinatarios; cambiar de tema y volver conserva los chips del tema.
4. Una respuesta tardía a una consulta queda anidada; el anuncio final no contiene el texto y lleva a la
   respuesta.
5. Desde Pendientes, una interrupción no se puede reencolar con un solo clic: «Reencolar» está
   deshabilitado hasta confirmar; «Dar por revisada» la saca del contador sin crear mensajes.
6. Herramientas siempre muestra la rama y el directorio del workspace elegido; con Terminal, el
   workspace aparece como «Sesión completa».
7. Tema ⇄ Herramientas ⇄ bandeja: 0 `resize` en escritorio y en móvil.
8. En el teléfono, Atrás del navegador sigue la pila: herramientas → tema (mismo scroll) → proyecto.
9. **iPhone real:** teclado abierto o cerrado sin saltos del hilo, composer accesible, menciones.
   Pendiente: no se probó.

## 5. Corte sugerido en PRs pequeños (orientativo)

1. Modelo de temas (`conversation_id`, rutas, herencia en la respuesta), sin UI.
2. Rail del proyecto + lista de temas + hilo por tema (reusa `acpThread.ts`).
3. Destinatarios por tema + «Todo el equipo» + estado por destinatario.
4. Pendientes global + visto/no visto + revisión de interrupciones.
5. Herramientas con selector de workspace (incluye la raíz por trabajo en Files/Git).
6. Archivo de solo lectura + retiro del chat individual.

Cada PR, con su validación visual a escritorio y 390 px, y la prueba del invariante de la terminal.

## 6. No validado

- **Safari / iPhone real:** solo se probó Chromium (390×844 emulado).
- **Rendimiento con hilos largos y muchos temas:** el prototipo no lo mide.
- **Textos finales:** los textos del prototipo son de referencia, no copy definitivo.
