> **Documento histórico (investigación de #512), no es un contrato vigente.** Se incorpora a main
> porque `docs/PROJECTS.md` lo cita como fuente de diseño. Los contratos vinculantes son
> [`docs/PROJECTS.md`](../../PROJECTS.md), [`docs/PROJECT_CONVERSATION.md`](../../PROJECT_CONVERSATION.md) y
> [`docs/CONVERSATION.md`](../../CONVERSATION.md): ante cualquier diferencia, mandan ellos. Los enlaces a otros
> documentos de #512 que no están en main apuntan a archivos que solo existen en la rama
> `docs/project-chat-channels` (conservada).

# 18 — Estado y camino mínimo al primer piloto de colaboración

Estado: **propuesta para revisión del responsable** (B, 2026-11-10). No se implementa nada de lo que
sigue hasta que el responsable la revise. No cambia el diseño aprobado (01–17): donde el piloto se
aparta de él, lo dice y lo deja como decisión (§3.6).

**Objetivo del responsable:** probar cuanto antes el chat colaborativo entre agentes. Primer hito:
*enviar un mensaje a dos agentes desde una conversación y ver sus respuestas, con aprobación humana y sin
autonomía entre agentes.*

## 0. Respuesta corta

- **Hoy, sin código nuevo (Piloto 0):** con Projects activado (una ventana operativa, sin deploy), se
  puede crear un proyecto con dos agentes ligados a dos sesiones, ver su presencia y escribirle a cada uno
  con el Composer desde su propia conversación. Es «dos agentes, aprobación humana, sin autonomía», pero
  sin una vista única: dos envíos y dos conversaciones.
- **Lo mínimo para el hito (Piloto 1):** un PR de **frontend** sin backend nuevo: un panel «Preguntar a
  los agentes» en la página del proyecto que hace **un envío del Composer existente por agente** y
  muestra las respuestas lado a lado, más un «Reenviar a @otro» que la persona revisa y envía. Sin
  Channels, sin tablas, sin protocolo nuevo, sin envíos de agente a agente.
- **Lo que de verdad necesita Channels/PASS-B/monitor:** entregar a un agente ocupado (cola), que un
  agente publique o escriba a otro, invitados en la conversación del anfitrión, el modo Colaboración, y
  las tareas con despacho (P6–P9, T2–T3).
- **Bloqueos imprescindibles para el Piloto 1:** activar Projects (GO propio), dos sesiones de agente con
  captura efectiva y CLI validado para el Composer, y la revisión de esta propuesta. **Recomendado antes:**
  el deploy de R1 (#572), para que la presencia sea honesta.

## 1. Estado actualizado (2026-11-10)

| Pieza | Estado |
| --- | --- |
| Captura de conversaciones (3.0–3.0d), vista Chat (3.1), Composer (3.2) | en producción |
| G3-1 (origen de red en la ingesta) | en producción, `INGEST_REQUIRE_SESSION_ORIGIN=observe` |
| P3a — directorio de proyectos (#557, v19) | en producción **con la bandera apagada** (`PROJECT_CHAT_ENABLED` vacío) |
| Presencia del agente (#569), página del agente (#565), `generatedAt`, «Needs you» sólo por hook (#573) | en producción (#573 sólo frontend vivo; su backend es aditivo) |
| Permisos de backups (#570) | en producción (`75e1547`, G2/G3 PASS) |
| `lastEventAt` = actividad, contrato v1.9.1 (#572) | **mergeado `c36078e`, sin deploy** (R1 pendiente) |
| SSRF de Push (#574) | **mergeado `a240548`, sin deploy** (falta la lectura de hosts de A) |
| Composer de sesiones en segundo plano (v1.9, #547) | en código, bandera `CONVERSATION_COMPOSER_BG_ENABLED` apagada |
| POC de Channels (P1), PASS-B1 | bloqueada: PASS-B1 INCONCLUSIVE (run 2 inválida), preflight con el operador |
| G3-2 (identidad del remitente agente) | NO-GO |
| P3 completo, P4–P9, T1–T3 | bloqueadas tras el GO de la POC (05, 15 §5.1) |

## 2. Lo que ya se puede probar — Piloto 0 (sin código)

**Requiere sólo activar Projects** (§5) y dos sesiones de agente preparadas (§4.1).

1. Crear un proyecto y dos agentes (`@dev-a`, `@dev-b`) ligados a dos sesiones propias, desde la página
   Projects (`createProject`, `createAgent`, ya en la UI).
2. Ver la presencia de cada uno (Working / Ready / Needs you / No recent activity), con la regla honesta
   de #569/#573.
3. Desde la tarjeta del agente, un toque abre su **Chat** (#565). Escribir con el **Composer** (3.2):
   la persona escribe y envía; el texto llega al CLI del agente como si lo tecleara.
4. Leer las respuestas en cada Chat, y saltar entre ambos con el conmutador (Ctrl+K).
5. «Colaborar» a mano: copiar la respuesta de `@dev-a` y enviarla a `@dev-b` con el Composer.

**Qué valida:** la identidad del agente (handle, rol, sesión), la presencia, el envío humano→agente
confirmado (`delivered` con el `user_prompt` del propio CLI) y la experiencia de «trabajo en paralelo».
**Qué no valida:** una vista única de la conversación con varios agentes, ni el reenvío asistido.

## 3. Lo mínimo para el hito — Piloto 1 (propuesta, no implementada)

### 3.1 Qué es

Un panel **«Preguntar a los agentes»** en la página del proyecto, sólo frontend:

1. La persona elige agentes (casillas; sólo los que el backend declara capaces de recibir: la
   conversación ligada al pane del agente con `canSendInput: true`), escribe un mensaje y pulsa Enviar.
2. El cliente hace **un envío del Composer existente por agente**
   (`POST /api/sessions/:sid/conversations/:cid/messages`), cada uno con su propio `clientMessageId`,
   en paralelo. Cada agente muestra su resultado tal como lo da el contrato §8: `delivered`,
   `unconfirmed`, `failed{…}`, o el 409 con su razón (`busy`, `needs-terminal`, `composer-not-empty`…)
   explicada con `explainCode`. **Sin reintentos automáticos.**
3. Las respuestas se ven **en carriles, uno por agente**: el cliente se suscribe a la conversación de
   cada agente con el WS existente (`/ws/conversation/<sid>`, `subscribe{conv, after}`) y muestra, desde
   el `user_prompt` del envío, los mensajes del asistente y las herramientas con el modelo actual
   (`conversationModel.ts`, sólo lectura).
4. **«Reenviar a @otro»** en una respuesta: abre el panel con el texto **pre-rellenado y editable**,
   encabezado «De @dev-a:», y sólo sale cuando la persona pulsa Enviar. Es un envío humano más.

### 3.2 Qué no es (para no cambiar el diseño en silencio)

- **No** es la conversación del anfitrión con invitados (P7), ni crea `chats`, `chat_participants`,
  aristas ni un log de proyecto (P3). No persiste un «hilo»: el carril es una **vista** de las
  conversaciones que ya existen.
- **No** es el monitor ni Channels (P5–P6): no hay cola, no hay entrega a un agente ocupado.
- **No** hay envíos de agente a agente ni Colaboración (P8, T3, G3-2): ningún agente dispara nada; todo
  envío nace de un clic humano.
- **No** toca el Composer del backend: ni el contrato §8, ni sus precondiciones, ni sus límites.

### 3.3 Seguridad

- Mismo permiso que hoy: el Composer es `assertCanOperate` (dueño o admin); los agentes son sesiones del
  dueño. No hay superficie nueva en el backend.
- **Inyección entre agentes:** lo que «Reenviar» copia es texto de un agente. La persona lo ve completo
  y lo edita antes de enviar; nunca sale sin su clic. Límite del Composer (≤ 48 × 800 puntos de código)
  intacto; si se excede, se explica y no se trunca en silencio.
- **Aislamiento:** las sesiones siguen en `sessions-net` compartida (#291). Aceptable para un piloto
  del responsable con sus propios agentes; se declara.
- **Acceso:** opt-in por navegador (`?pilot=1`, guardado como `?ui=v2`) **y** `features.projectChat`.
  Sin la bandera de Projects, el panel no existe.

### 3.4 Limitaciones conocidas (las resuelve Channels, §4)

- Sólo se envía a un agente **en su prompt** (el probe lo confirma, v1.7.4). Ocupado ⇒ 409 `busy`,
  «@dev-b está trabajando; reintentá cuando esté Ready». No hay cola.
- Una sesión con varias conversaciones vivas: el panel usa la ligada al pane; si hay ambigüedad, se
  pregunta.
- La respuesta se lee de la captura: con la captura apagada o revocada, el carril lo dice.

### 3.5 Tamaño y aceptación

- **1 PR de frontend** (+ docs), detrás del opt-in. Sin migración, sin backend, sin deploy de VM100: Pages
  lo publica al mergear, y sólo aparece con `?pilot=1` y Projects activado.
- **Aceptación:**
  - un envío a dos agentes produce dos `composer_send` independientes y dos `user_prompt`
    del CLI, uno en cada conversación;
  - un 409 en uno no afecta al otro;
  - nada se reintenta;
  - «Reenviar» nunca envía sin clic;
  - el Terminal no se redimensiona (invariante e2e);
  - e2e con el mock backend (envío doble, un `busy`, un `delivered`, carriles, reenvío).

### 3.6 Decisiones que pide (sin ellas no se implementa)

| ID | Pregunta | Recomendación |
| --- | --- | --- |
| D-PIL1 | El riesgo transversal de 05 dice «Composer congelado (sin features nuevas)». ¿Se acepta un cliente nuevo **del** Composer (frontend) sin cambiar el Composer (backend)? | **sí**, sólo como piloto: el backend no cambia, y P9 ya deja el Composer como camino humano→agente hasta el GO de Channels |
| D-PIL2 | ¿Dónde vive el panel: la página del proyecto o la vista Chat de una sesión (donde P7 pondrá al anfitrión)? | **página del proyecto**: no adelanta ni contradice la forma de P7 |
| D-PIL3 | ¿«Reenviar a @otro» entra en el piloto? | **sí**: es la colaboración con aprobación humana que se quiere validar |
| D-PIL4 | ¿El piloto se retira o se conserva cuando llegue P7? | **se retira** (o pasa a «Control Directo» de P9 si el responsable lo decide entonces) |
| D-PIL5 | Duración y criterio de éxito del piloto | p. ej. 1 semana de uso real; qué tiene que haber funcionado para pedir el GO de la POC de Channels |

### 3.7 Resultado del Piloto 1 y registro de evidencias (2026-11-11)

- **Resultado (A, #512 16:44Z).** El piloto corrió con el GO del responsable sobre una tarea real, Dev ↔ QA,
  en 3 rondas de revisión. Hubo 10 intercambios, todos `delivered`:
  - `noRetry`: 10/10, con un POST por `clientMessageId`;
  - `attributionOk`: 10/10, con el `turn_end` en el `promptId` acusado.

  Hicieron falta unas 8 intervenciones manuales, todas de transporte: el panel solo vivía en memoria, no
  había «Reenviar» desde Chat, la copia del límite del Composer en el frontend estaba desactualizada (256
  en vez de 48, corregido en #586) y un agente no puede copiar de forma fiable un blob base64 a un
  archivo.
- **Registro de evidencias para el próximo piloto:** un archivo JSONL append-only con una fila por carril.
  Lo reconstruye A desde los eventos del servidor:

  ```
  exchange, at, textSha256, forwardOf, lane, sid, cid, clientMessageId,
  http{status, result, promptId, seq}, composerSendStates, postsForThisClientMessageId,
  replyPromptId, turnEndSeq, verdict{noRetry, attributionOk}
  ```

  - **Se quitan `panelShowed` y `matchesChatView`:** son comprobaciones de interfaz. Los reemplaza una
    revisión manual de 2 intercambios por día.
  - **`authorized`:** hasta que exista la conversación del proyecto, es una línea diaria del responsable
    («E01–En: destinatarios según lo previsto: sí/no»). Con D1 pasa a ser mecánico: las entregas están
    incluidas en `message.to[]` y su cantidad es igual a `|to[]|`.

## 4. Lo que realmente requiere Channels, PASS-B y el monitor

| Capacidad | Por qué no la cubre el Composer | Fase | Bloqueo |
| --- | --- | --- | --- |
| Entregar a un agente **ocupado** (encolar hasta un punto seguro) | el Composer pega en el prompt; ocupado ⇒ 409 | P5–P6 (monitor) | GO de la POC (PASS-B1 válido, G3 `source`, B2/B3) |
| Que un agente **publique** en la conversación o **escriba a otro** | el agente no tiene un canal propio; su texto sólo vive en su conversación | P8 (`chat_post`, `chat_send`) | Channels + **G3-2** (identidad del remitente) |
| Invitados en la conversación del anfitrión, participantes, estados de entrega | no hay modelo de chat ni log de proyecto | P3 completo, P7 | GO de la POC |
| Modo Colaboración con presupuesto y vencimiento | requiere turnos entre agentes | P8 | Channels + G3-2 |
| Tareas con despacho, puntos seguros, `CHANGE`/`STOP` | requieren el monitor | T2, T3 | P6 + TG1–TG5; T3 además G3-2 |
| Envío a sesiones del CLI en segundo plano | existe en código (v1.9) | — | su propia activación (`CONVERSATION_COMPOSER_BG_ENABLED`) |

### 4.1 Enmienda: el camino Composer (GO del responsable, 2026-11-11)

El responsable aprobó un camino incremental **sin Channels** para parte de lo anterior. Su contrato vive en
main: `docs/PROJECT_CONVERSATION.md`, versión v0.1, pendiente de revisión.

**En todo este camino, el único que envía es el backend, a través del Composer existente.** Ningún agente
emite peticiones, así que **G3-2 sigue en NO-GO y no se toca**.

| Capacidad de la tabla de §4 | Camino Composer | Qué sigue requiriendo Channels |
| --- | --- | --- |
| Conversación con varios agentes y estados de entrega | **D1:** un registro por proyecto (`.projects/<pid>/conversation.events.jsonl`, garantías de 03 §2.2) y el envío a varios agentes hecho por el servidor con el Composer | invitados en la conversación del anfitrión, la cola y la entrega a un agente ocupado (P5–P7) |
| Pasar resultados entre agentes | **D2:** artefactos de texto de hasta 1 MiB, de workspace a workspace, por sha256 | — |
| Colaboración con presupuesto y vencimiento | **D3:** el backend pasa el informe final de un turno que él mismo entregó, bajo un permiso de la persona por tarea. Requiere `INGEST_REQUIRE_SESSION_ORIGIN=true`, con GO operativo propio | que un agente publique o escriba a otro por su cuenta (P8, G3-2) |

AD7 («un tipo de conversación de proyecto solo con necesidad probada, en su propio log, sin copiar
mensajes») se cumple así:
- la necesidad la probó el Piloto 1 (§3.7);
- el registro es propio, con rutas que no chocan con las que 03 §2.2 reserva;
- el texto de los agentes queda solo en la captura, y el registro guarda referencias con hash.

## 5. Bloqueos: imprescindibles y diferibles

**Imprescindibles para el Piloto 0:**
1. **Activar Projects** en producción: `PROJECT_CHAT_ENABLED=true` y recrear `app`. Ventana propia, sin
   código nuevo ni otro deploy en la misma ventana; GO propio. Su vuelta atrás es la bandera (PROJECTS.md
   §1, «kill switch» seguro).
2. **Dos sesiones de agente aptas para el Composer:** captura efectiva (imagen con relay `="2"`, sesión
   recreada si hace falta), CLI en la lista validada (`COMPOSER_CLI_VERSIONS`, 2.1.314/2.1.316) y
   `CONVERSATION_COMPOSER_ENABLED` encendido (a confirmar por A).

**Imprescindibles para el Piloto 1:** los anteriores, más la revisión de esta propuesta (D-PIL1–D-PIL5) y
el PR con su revisión independiente.

**Recomendado antes de activar Projects:** **R1 (#572)**. Sin v1.9.1, un probe sin confirmación todavía
mueve `lastEventAt` y puede hacer parecer fresca una afirmación vieja en la presencia del agente. No
impide el piloto, pero la presencia sería menos honesta. Ventana propia, antes de la de activación.

**Diferibles (no bloquean el piloto):**
- deploy de #574 (Push), #561 (backup de suscripciones), #575 (reasignación con prueba de control);
- G4/G5 de backups;
- `true` de G3-1;
- aislamiento de red por proyecto (#291);
- T1 (tareas sin despacho);
- todo lo de §4.

## 6. Camino propuesto (una cosa por ventana)

| Paso | Qué | Quién | Autorización |
| --- | --- | --- | --- |
| 1 | Revisar esta propuesta; decidir D-PIL1–5 | responsable | — |
| 2 | Ventana R1: deploy de `c36078e` | A | GO de R1 sobre el procedimiento de A |
| 3 | Ventana de activación de Projects (sólo la bandera) | A | GO propio |
| 4 | Preparar dos sesiones de agente; **Piloto 0** | A + responsable | uso |
| 5 | PR del Piloto 1 (si D-PIL1 = sí); revisión; merge | B | GO de merge |
| 6 | **Piloto 1** con `?pilot=1` | responsable | uso |
| 7 | Con lo aprendido: pedir o no el GO de la POC de Channels (P1) | responsable | GO separado |

El deploy de #574 va en su propia ventana, cuando A haya leído los hosts. No se mezcla con 2 ni con 3.

## 7. Activación de Projects: lo que se le pide a A

Un procedimiento propio, sin deploy de código:
- **preflight:** `b_idle`, fuera de 08–09Z, sin backup corriendo, imagen y SHA en curso
  registrados; el último backup nocturno con `projects.jsonl`, `project_agents.jsonl`,
  `agent_bindings.jsonl` y `project_agent_creations.jsonl` en el manifiesto (TABLES `sinceSchema` 19);
- **cambio:** `.env` con `PROJECT_CHAT_ENABLED=true` (diff append-only verificado); recrear `app` con
  la misma imagen (`--no-build`); `compose config` / `printenv`;
- **comprobaciones:** `GET /api/auth/status` ⇒ `features.projectChat: true`; `GET /api/projects` ⇒ 200
  `[]`; `GET /api/sessions` con la clave `binding`; sesiones, captura y Composer como antes;
  `CONVERSATION_COMPOSER_BG_ENABLED` vacío, `observe` igual;
- **vuelta atrás:** quitar la bandera y recrear; con agentes creados, el hard delete de una sesión ligada
  sigue protegido (PROJECTS.md §1, §6).
