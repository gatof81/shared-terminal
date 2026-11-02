# Project Chat + Agent Monitor — visión de producto

Estado: borrador (2026-11-02).

## 1. Qué estamos construyendo

Shared Terminal pasa de ser "terminales Docker con Claude Code" a ser **un lugar donde una persona
coordina a sus agentes desde un chat por proyecto**. Cada agente sigue siendo una sesión de Claude
Code interactiva en su contenedor, con su Terminal y su historial; lo nuevo es:

- un **chat del proyecto** donde la persona escribe a uno o varios agentes con `@menciones`;
- un **monitor** en el backend que decide cuándo y cómo llega cada mensaje, registra qué pasó y
  nunca reintenta por su cuenta;
- **Channels** de Claude Code como el transporte que pone el mensaje delante del agente sin tocar
  tmux — si la POC lo valida;
- el **Composer** como **Control Directo**: herramienta avanzada para diagnóstico y recuperación.

## 2. Para quién

El usuario actual de Shared Terminal: una persona (el owner) con varias sesiones de Claude Code,
frecuentemente desde el móvil, que hoy salta de terminal en terminal para pedir cosas y ver si
terminaron.

## 3. Casos de uso de la primera fase

| # | Caso | Hoy | Con Project Chat |
| --- | --- | --- | --- |
| U1 | Pedir una tarea a un agente desde el móvil | Abrir la sesión, Chat, Composer (con sus precondiciones) | Escribir `@backend revisá el test que falla` en el chat del proyecto |
| U2 | Saber quién trabaja y quién espera | Abrir cada sesión | Roster: trabajando / esperando input / desconectado / sin canal |
| U3 | Ver el resultado | Leer el hilo de la conversación | Tarjeta de resultado bajo el mensaje, con enlace al hilo completo |
| U4 | Pedir lo mismo a dos agentes | Dos sesiones, dos envíos | `@backend @frontend …` — una entrega por agente, cada una con su estado |
| U5 | Un agente pide ayuda a otro | No existe | `chat_send` desde el agente; la persona aprueba (o declaró antes que ese par puede hablar). El resultado se publica en el proyecto; devolverlo al agente que pidió sigue la misma regla de aprobación |
| U6 | Un mensaje no llegó | Composer: `unconfirmed`, mirar el Terminal | Estado explícito ("sin confirmar: no sabemos si llegó"); reenviar o usar Control Directo es decisión de la persona |
| U7 | Algo se trabó | Terminal | Control Directo (Composer) o Terminal, como hoy |

## 4. Principios

1. **Un hecho, un lugar.** El texto de un mensaje vive en el chat del proyecto; la ejecución vive en
   la conversación del agente. Se enlazan, no se copian.
2. **Transportado ≠ recibido ≠ resuelto.** La UI nunca dice "entregado" sin evidencia del CLI.
3. **Nada se reenvía solo.** Ni por Channels ni por Composer.
4. **Los agentes no se mandan órdenes sin permiso.** Un mensaje de agente a agente necesita
   aprobación humana o una regla explícita del owner.
5. **Reutilizar antes que construir.** Mismo backend, misma captura, mismo almacenamiento en el
   host, misma activación.
6. **El Terminal sigue siendo la verdad última.** Nada de esto lo reemplaza.

## 5. Alcance

Dentro (fase 1, tras GO): proyectos de un solo owner; agente = una sesión; mensajes humano→agente,
agente→proyecto, agente→agente con aprobación; menciones explícitas; presencia; tarjetas de
resultado; límites anti-bucle.

Fuera (fase 1): tareas con estados de flujo, asignaciones, tableros (no es Jira); proyectos
compartidos entre personas; admin/lead leyendo chats; varios agentes por contenedor; agentes
headless (`-p`) y teammates; adjuntos; edición o borrado de mensajes; notificaciones push nuevas
(se reutiliza 3.4 cuando llegue); relay de permisos por el chat.

## 6. Cómo sabremos que funciona

- La POC da GO con los criterios de [04-poc.md](./04-poc.md) §5.
- En el piloto: ≥ 95 % de los mensajes humanos a un agente disponible llegan a `accepted`; 0
  duplicados; 0 reentregas automáticas; cada `unconfirmed` tiene una causa visible.
- La persona deja de abrir el Terminal para tareas rutinarias (medido por uso del Composer frente al
  chat del proyecto en el piloto).
