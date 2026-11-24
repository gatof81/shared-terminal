# Entrega 3A — Propuesta UX/UI: proyecto → conversaciones

**Estado: dirección aprobada por el owner (#1086), con los tres ajustes de la §11 ya incorporados. 3A cerrada.**

Prototipo: `index.html` (abrir en un navegador; `?freeze` congela la simulación).
Capturas: `shots/` (prototipo), `current/` (UI actual, mock e2e en `main@3bda155`).
Validado en Chromium a 1440×900 y 390×844. **No probado en Safari ni en un iPhone real.**

## 1. Problemas de la UI actual (con evidencia)

1. **Dos chats para la misma cosa.** El mismo mensaje aparece en Project Chat y en el chat individual
   del agente (`current/desktop-project-chat.png` frente a `desktop-agent-chat.png`). Duplica lo que hay que revisar.
2. **Un solo hilo por proyecto.** Project Chat no tiene temas: CI, backend y UI se mezclan en un mismo scroll.
3. **La atención está repartida.** Para saber quién espera una decisión hay que abrir cada agente; no hay
   un lugar global.
4. **Las herramientas están lejos de la conversación.** Files/Git/Terminal viven en la sesión del agente.
   Desde Project Chat hay que salir del proyecto para abrirlas.
5. **La barra lateral mezcla tres árboles** (proyectos, agentes sin proyecto, sesiones), con «New session»
   como acción principal; conversar no es la acción principal.
6. **Los trabajos no se ven.** Los worktrees (`.st/ctx/<id>`) no aparecen, y Files/Git rechazan `.st/`.

## 2. Navegación recomendada

**El proyecto es el espacio.** El rail del proyecto tiene, en este orden:

1. Selector de proyecto ▾ y la bandeja de Pendientes (con un contador).
2. Una fila de atención: «3 te esperan · 1 resultado nuevo».
3. **Conversaciones**, con un + para crear.
4. **Equipo**: cada agente con su estado en palabras.
5. **Trabajos**: los activos; los cerrados, a pedido.
6. **Archivo · solo lectura**.

En el centro va el tema abierto. Las herramientas se abren en una **vista propia**, en la misma caja del
centro; «‹ Tema» vuelve al mismo punto de lectura.

Las sesiones sin agente y los ajustes quedan en el pie: siguen existiendo, pero ya no son la portada.

La alternativa considerada fue **la bandeja como portada**: todas las conversaciones de todos los proyectos
ordenadas por actividad. La descarto porque mezcla proyectos y se parece a Slack. La necesidad
transversal real («qué me espera») ya la cubre la bandeja de Pendientes, que es global.

## 3. Conversación unificada

- **Un tema = una conversación.** El equipo es del proyecto: cualquier agente entra con `@`, sin
  «membresía». Los avatares del encabezado se derivan de quién habló o fue mencionado.
- **Destinatarios explícitos, persistentes dentro del tema.** La fila «Para:» muestra chips; por defecto,
  los de tu último mensaje **en ese tema**. Un tema nuevo empieza vacío, o solo con lo que elijas al
  crearlo. Con `@` o con + se suman. Sin destinatario no se envía; tampoco hay un ruteo invisible a un
  «Manager» (esto cambia lo que recomendé en la investigación #780). Detalle en la §11.
- **Antes de enviar ya sabés qué va a pasar.** Si un destinatario está ocupado aparece «@developer está
  ocupado en «Optimización de CI»: tu mensaje queda en cola».
- **Quién habla:**
  - vos: «Vos → @a, @b», sobre un fondo levemente azul;
  - un agente: su avatar y su tono;
  - el sistema: una línea centrada y tenue.
- **Estado debajo de tu mensaje, una fila por destinatario:** trabajando (con su actividad), en cola (con
  el motivo y un enlace), respondió (con un enlace a la respuesta), o interrumpida (con «Revisar
  interrupción»). No hay un progreso agregado del mensaje.
- **Consultas entre agentes:** una tarjeta «@designer consulta a @developer», con la respuesta anidada
  (`reply_to`). Si la respuesta llega tarde, queda vinculada a la consulta original. Al final del hilo
  solo aparece una referencia, sin repetir el contenido: «↳ @developer respondió la consulta de
  @architect (09:20) · Ir a la respuesta ↑».
- **Preguntas al owner:** una tarjeta ámbar con las opciones («@architect está detenido hasta que
  respondas»). Se puede responder en el hilo o desde la bandeja.
- **Trabajos:** un chip `⎇ ci-cache` en el mensaje abre ese workspace en Herramientas.
- **Respuestas asíncronas:**
  - Si estás en otro tema, el tema suma un contador.
  - Al volver aparece el divisor «Nuevos desde tu última visita».
  - Si estás leyendo más arriba, nada te mueve: aparece la pastilla «↓ N nuevos».
  - Al volver a un tema recuperás tu posición; solo te lleva al final si estabas al final.

## 4. Atención pendiente

Una sola bandeja global, que se abre desde el ícono con contador (presente en todas las pantallas) o desde
la fila del rail. Tiene dos secciones:

- **Requieren tu acción** (el único número que cuenta el contador): preguntas o decisiones, y ejecuciones
  interrumpidas. Una pregunta se responde ahí mismo. Una interrupción se abre con «Revisar interrupción»
  (§11.1); nunca se reintenta con un toque. «Ver en el tema» abre el tema y resalta el mensaje.
- **Resultados sin ver**: respuestas de agentes dirigidas a vos que todavía no viste. Es informativo y no
  suma al contador.

Quién trabaja, las colas y las consultas entre agentes **no** entran en la bandeja. Eso se ve en el tema y
en Equipo.

**Vocabulario de estado de un agente:**

- disponible
- trabajando aquí
- ocupado en «X» · N en cola
- esperando a @x
- espera tu decisión
- ejecución interrumpida

No se muestran slots ni sesiones ACP.

## 5. Herramientas: agente → workspace → herramienta

En la barra de Herramientas hay tres selectores: **Agente ▾ · Workspace ▾ · Files | Git | Terminal**.
Debajo, una franja siempre visible dice exactamente qué estás mirando:

- **Workspace principal:** rama `main`, directorio `~/workspace`.
- **Trabajo ci-cache:** rama `work/ci-cache`, directorio `~/workspace/.st/ctx/ci-cache`, base, puertos,
  quién trabaja ahí y su tema.

**Terminal** no depende del workspace: es la terminal de la sesión (el contenedor y tmux). Con Terminal
elegida, el selector de workspace se desactiva («Sesión completa») y la franja lo aclara.

**Entradas:**

- el avatar de un agente (en el hilo, el encabezado o Equipo) abre un menú: Files · Git · Terminal ·
  sus trabajos;
- el chip de un trabajo;
- una fila de Trabajos.

**Volver:** el tema nunca se desmonta, así que el scroll sigue donde estaba (medido en el prototipo:
300 px → 300 px en escritorio y 168 → 168 a 390 px).

## 6. Terminal sin redimensionados

- **La caja de la terminal es la caja del centro.** Nada se abre al costado de la terminal: la bandeja,
  los menús y los diálogos son superpuestos.
- **Cambiar entre tema y Herramientas no cambia la caja.** El prototipo cuenta las redimensiones del panel:
  abrir la bandeja con la terminal visible deja **0**.
- **En el teléfono**, Herramientas ocupa la pantalla completa, con la barra de teclas abajo (como hoy).

## 7. Historial anterior

En **Archivo · solo lectura**, dentro del proyecto, aparece una entrada por cada chat individual de un
agente y una por el Project Chat anterior.

Se ven con el mismo hilo visual, con la nota «Archivo importado · solo lectura» y sin composer. En lugar
del composer hay un botón «Continuar en una conversación nueva». Un solo sistema de chat activo.

## 8. Móvil

- **Pantallas en pila:** la del proyecto (el mismo rail, a pantalla completa), luego el tema y luego
  Herramientas. La bandeja va a pantalla completa desde el ícono con contador, presente en cada pantalla.
- **Teclado:** el hilo conserva el punto de lectura; queda pegado al final solo si estabas al final. Un
  mensaje nuevo nunca te arrastra al final (aparece la pastilla). Las menciones se abren sobre el campo.
- **Composer:** los chips «Para» van en una fila con scroll horizontal y los objetivos táctiles miden
  ≥ 44 px.
- **Herramientas:** primero la lista y luego el detalle (archivo o diff), con «‹ Archivos» para volver.
  El workspace va en un select a ancho completo.

## 9. Conservar / modificar / eliminar

- **Conservar:**
  - Files, Git y Terminal, con sus vistas actuales;
  - el modelo de overlays con `inert`, que garantiza 0 resize;
  - los tokens y colores;
  - el composer de una superficie;
  - la tarjeta de preguntas;
  - el avatar con tono por agente;
  - las rutas en la dirección.
- **Modificar:**
  - Project Chat pasa a ser una conversación por tema;
  - la barra lateral pasa a ser el rail del proyecto;
  - el estado «libre/ocupado» pasa a usar el vocabulario de la §4;
  - la fila de destinatarios pasa a usar chips persistentes;
  - Files/Git ganan el selector de workspace.
- **Eliminar:**
  - el chat individual como pantalla activa (se archiva);
  - el árbol «agentes sin proyecto» como sección propia;
  - «New session» como botón principal.

## 10. Para validar con @architect en 3B

1. **`conversation_id` en `agent_messages`.** El alcance pasa a ser proyecto + tema; la respuesta lo
   hereda, como hoy con `project_id`. ¿Qué pasa con los mensajes con `--work`? Propuesta: conservan su
   tema y suman el trabajo.
2. **Sesión ACP por (agente, tema), bajo demanda.** La UI solo necesita, por agente: el tema de cada
   mensaje en curso, la cola (con su tema), la pregunta abierta y la consulta pendiente. Nada de slots.
3. **Visto o no visto, persistido en el servidor:** la última lectura por tema, para que coincida entre el
   teléfono y el escritorio. Hay que definir qué cuenta como «resultado» (propuesta: la respuesta de un
   agente a un mensaje tuyo).
4. **Bandeja global entre proyectos:** ¿un endpoint, o se agrega en el cliente?
5. **Files/Git sobre un trabajo:** `.st/` está en `isRestrictedPath`, así que hoy no se puede abrir
   `.st/ctx/<id>`. Hace falta una raíz por trabajo que no abra el resto de `.st/`.
6. **Vínculo trabajo ↔ tema:** el tema de origen al crear el trabajo, para el enlace en la franja y en el
   rail.
7. **Archivo:** importar los mensajes directos y los del Project Chat anterior como temas de solo lectura,
   sin migrarlos a temas activos.
8. **Terminal:** extender el invariante e2e a «tema ⇄ Herramientas ⇄ bandeja: 0 resize». Cambiar de
   agente en el selector conecta otra sesión, y eso no es un resize.
9. **Validar en un iPhone real** el teclado, el `visualViewport` y el scroll del hilo (aquí solo se probó
   Chromium).

## 11. Ajustes del owner (#1086), incorporados

1. **Interrupciones: «Revisar interrupción», no «Reenviar».** Un mensaje `uncertain` pudo haber ejecutado
   operaciones. La revisión (en el hilo o desde la bandeja) muestra:
   - el mensaje original, cuándo y por qué se cortó, y la última actividad conocida;
   - el aviso «Puede haber hecho parte del trabajo… Nada se reenvía solo»;
   - el informe de solo lectura que el agente ya recibe hoy al reiniciarse;
   - accesos a Git y a Terminal de ese agente.

   Acciones, de la más segura a la menos segura:
   - **Dar por revisada, sin reencolar** (botón principal): sale de Pendientes y el mensaje queda como
     «interrumpida · revisada, no reencolada».
   - **Escribirle un mensaje nuevo:** abre el tema con ese agente como destinatario, para dar
     instrucciones a partir del informe.
   - **Reencolar el mensaje original…** (plegado): explica que vuelve a la cola *el mismo* mensaje, sin
     copia, y que puede repetir operaciones. Exige marcar «Revisé el estado y acepto que puede repetir
     operaciones» antes de habilitar «Reencolar». Es el `requeue` actual del owner, con sus garantías.
2. **Destinatarios:**
   - Los chips se conservan dentro del tema. Un tema nuevo no hereda nada.
   - **«Todo el equipo»** es un chip propio (avatares apilados y «Todo el equipo · 4»). Debajo del campo
     dice «Llega a @architect, @developer, @designer, @qa, a cada uno por separado».
   - En el hilo aparece «→ Todo el equipo (4)», con los nombres al pasar el cursor.
   - Se resuelve **al enviar**: quien se sume al proyecto después no lo recibe.
   - Con varios destinatarios, la fila de estado es individual por agente. Cuando todos respondieron,
     queda una línea compacta «✓ @a ✓ @b», y cada marca lleva a su respuesta.
3. **Respuestas tardías:** la respuesta sigue anidada en su consulta. El anuncio al final es solo una
   referencia que lleva hasta ella y la resalta.

**Comprobación (Chromium, 1440×900 y 390×844):**
- **Composer:** la mención con `@de` + Enter agrega el chip; quitar el chip de equipo deja vacío.
- **Interrupción:** «Reencolar» queda deshabilitado hasta marcar la confirmación; «Dar por revisada» baja el
  contador de 3 a 2.
- **Respuesta tardía:** «Ir a la respuesta» la deja en pantalla.
- **Navegación:** un tema nuevo arranca sin destinatarios. En el teléfono, tema → trabajo → Atrás del
  navegador vuelve al tema con el mismo scroll, y un segundo Atrás vuelve al proyecto.
- Sin errores de consola. Capturas en `shots2/`.

**No es una validación de Safari ni de un iPhone real.**
