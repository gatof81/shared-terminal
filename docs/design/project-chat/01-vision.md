# Project Chat + Agent Monitor — visión de producto

Estado: borrador (2026-11-02). Dirección de producto actualizada el 2026-11-03: conversación del
agente con invitados temporales (decisiones D1–D6 del responsable, registradas como R10–R15 en
[02 §9](./02-architecture-rfc.md#9-decisiones-del-responsable-2026-11-02); propuesta y razones en
[08](./08-host-chat-guests.md)).

## 1. Qué estamos construyendo

Shared Terminal pasa de ser "terminales Docker con Claude Code" a ser **un lugar donde una persona
conversa con cada uno de sus agentes y, cuando hace falta, suma a otros a esa conversación**. Cada
agente sigue siendo una sesión de Claude Code interactiva en su contenedor, con su Terminal y su
historial; lo nuevo es:

- la **conversación del agente** (conversación anfitriona): la conversación individual de la persona
  con un agente, como hoy con el Composer. Un mensaje sin mención va a ese agente, el **anfitrión**;
- **invitados temporales**: con una `@mención` la persona invita a otro agente del mismo proyecto a
  esa conversación. El invitado conserva su runtime, su sesión y su historial; nada se fusiona, y
  retirarlo no borra lo que pasó;
- el **modo Colaboración**: un permiso temporal que la persona activa en una conversación para que
  los participantes que elige se escriban entre sí sin aprobar cada mensaje, con presupuesto y
  vencimiento, y que se detiene con un clic;
- un **monitor** en el backend que decide cuándo y cómo llega cada mensaje, registra qué pasó y
  nunca reintenta por su cuenta;
- **Channels** de Claude Code como el transporte que pone el mensaje delante del agente sin tocar
  tmux — si la POC lo valida. Hasta el GO de Channels, el camino de envío de la conversación del
  agente sigue siendo el Composer 3.2;
- el **Composer** como **Control Directo**: herramienta avanzada para diagnóstico y recuperación.

El **proyecto** se conserva como directorio de agentes (`@handles` únicos) y frontera de permisos;
deja de ser una sala de chat.

## 2. Para quién

El usuario actual de Shared Terminal: una persona (el owner) con varias sesiones de Claude Code,
frecuentemente desde el móvil, que hoy salta de terminal en terminal para pedir cosas y ver si
terminaron.

## 3. Casos de uso de la primera fase

| # | Caso | Hoy | Con la conversación del agente |
| --- | --- | --- | --- |
| U1 | Pedir una tarea a un agente desde el móvil | Abrir la sesión, Chat, Composer (con sus precondiciones) | Abrir el agente y escribir `revisá el test que falla`: sin mención va al anfitrión, cuyo chip se ve antes de enviar |
| U2 | Saber quién trabaja y quién espera | Abrir cada sesión | Disponibilidad en el selector `@` y en la barra de participantes: trabajando / esperando input / desconectado / sin canal |
| U3 | Ver el resultado | Leer el hilo de la conversación | El turno del anfitrión, en su carril, como hoy; el de un invitado, en una tarjeta propia con su `@handle` y "→ respondiendo a" |
| U4 | Pedir algo también a otro agente | Dos sesiones, dos envíos | Invitar a `@frontend` con una mención. Con mención reciben **sólo** los mencionados; para incluir al anfitrión, se lo menciona también. Una entrega por agente, cada una con su estado |
| U5 | Un agente pide ayuda a otro | No existe | El agente lo pide (`chat_invite` o `chat_send`) y la persona aprueba. Invitar **siempre** requiere aprobación. La respuesta del invitado se le muestra a la persona y **no** vuelve sola al agente que pidió: la persona la reenvía con un clic, o activa Colaboración (U11) |
| U6 | Un mensaje no llegó | Composer: `unconfirmed`, mirar el Terminal | Estado explícito ("sin confirmar: no sabemos si llegó"); reenviar o usar Control Directo es decisión de la persona |
| U7 | Algo se trabó | Terminal | Control Directo (Composer) o Terminal, como hoy |
| U8 | Invitar a un agente a la conversación | No existe | La primera `@mención` de un agente que no participa muestra "Invitar a @x a esta conversación" antes de enviar; enviar es la confirmación. Sólo agentes del mismo proyecto |
| U9 | Retirar a un invitado sin perder el historial | No existe | "Retirar" en la barra de participantes: lo que estaba en cola para él se cancela, lo que ya estaba en vuelo sigue y se marca, y el historial queda intacto. Reinvitarlo es una participación nueva |
| U10 | Elegir a qué agente escribir | Recordar qué sesión es cuál | Selector `@` con nombre, proveedor, rol y disponibilidad; el mensaje guarda el `agent_id`, nunca el handle |
| U11 | Dejar que dos agentes se consulten un rato | No existe | "Activar colaboración" en esa conversación: la persona elige participantes, cantidad de intercambios (6 por defecto) y vencimiento (30 min por defecto). Un banner muestra "4/6 intercambios · vence 14:30 · [Detener]". Sólo cubre `chat_send` explícitos entre esos participantes, en esa conversación |

## 4. Principios

1. **Un hecho, un lugar.** El texto de un mensaje vive en el log de la conversación anfitriona; la
   ejecución vive en la conversación del CLI de cada agente. Se enlazan, no se copian.
2. **Transportado ≠ recibido ≠ resuelto.** La UI nunca dice "entregado" sin evidencia del CLI.
3. **Nada se reenvía solo.** Ni por Channels ni por Composer. La respuesta de un invitado tampoco
   vuelve sola al anfitrión.
4. **Los agentes no se mandan órdenes sin permiso.** Un mensaje de agente a agente necesita
   aprobación humana, una regla explícita del owner, o una Colaboración activa que la persona
   autorizó para esa conversación. Invitar a otro agente siempre necesita aprobación.
5. **El destinatario siempre está visible antes de enviar.** El chip del anfitrión o de los
   mencionados se ve y se puede quitar; si el conjunto de participantes cambió, el envío se rechaza
   y el borrador se conserva. El servidor nunca adivina destinatarios a partir del texto.
6. **Contexto mínimo autorizado.** Un invitado recibe el mensaje que lo menciona y sólo el contexto
   que la persona elige en ese envío (nada preseleccionado, con vista previa). El hilo del CLI del
   anfitrión nunca viaja.
7. **Reutilizar antes que construir.** Mismo backend, misma captura, mismo almacenamiento en el
   host, misma activación, la misma vista Chat de la sesión.
8. **El Terminal sigue siendo la verdad última.** Nada de esto lo reemplaza.

## 5. Alcance

Dentro (fase 1, tras GO): proyectos de un solo owner como directorio de agentes; agente = una
sesión; una conversación anfitriona activa por agente (archivable, con historial); invitados del
mismo proyecto por `@mención`; retirar invitados; mensajes humano→agente, agente→conversación,
agente→agente con aprobación, arista `allow` o Colaboración; menciones explícitas; presencia;
tarjetas de invitado; límites anti-bucle. Hasta el GO de Channels el envío por defecto de la
conversación anfitriona sigue siendo el Composer 3.2.

Modelo multiproveedor **sólo como modelo**: cada agente declara `provider` (`claude-code` en v1;
`codex` reservado) y `role`, y su runtime se describe por un adaptador con capacidades declaradas.
No se implementa ningún adaptador fuera de Claude Code ni ninguna integración con ChatGPT.

Fuera (fase 1): tareas con estados de flujo, asignaciones, tableros (no es Jira); proyectos
compartidos entre personas; invitados de otro proyecto; varias conversaciones anfitrionas activas
por agente; admin/lead leyendo chats; varios agentes por contenedor; agentes headless (`-p`) y
teammates; adjuntos; edición o borrado de mensajes; reenvío automático de respuestas entre agentes;
notificaciones push nuevas (se reutiliza 3.4 cuando llegue); relay de permisos por el chat.

## 6. Cómo sabremos que funciona

- La POC da GO con los criterios de [04-poc.md](./04-poc.md) §5.
- En el piloto: ≥ 95 % de los mensajes humanos a un agente disponible llegan a `accepted`; 0
  duplicados; 0 reentregas automáticas; 0 entregas a un agente que no era destinatario visible; cada
  `unconfirmed` tiene una causa visible.
- La persona deja de abrir el Terminal para tareas rutinarias (medido por uso del Control Directo
  frente a la conversación del agente en el piloto).
