# Conversación de proyecto por el Composer (D1–D3)

Estado: **contrato propuesto, v0.3, para aprobación del responsable** (B, 2026-11-11). Nada de lo
que sigue está implementado.

- **v0.1** pasó una revisión adversarial independiente: 2 BLOCKER, 9 SHOULD-FIX y 1 NIT, todos
  incorporados.
- **v0.2** incorpora los tres ajustes del responsable:
  - asentamiento antes de que una respuesta sea elegible para D3 (§4.1, §7.3);
  - idempotencia sobre todo el cuerpo, adjuntos incluidos (§3.4);
  - un solo proceso escritor (§2.1).
- **v0.3** cierra los puntos de la revisión del responsable y agrega lo que UX v3 (aprobado) necesita de D1, sin tocar garantías: `reply_settling`, `owner_ack`, paginación filtrable y el Apéndice A (tipos y ejemplos para el frontend):
  - toda escritura del registro bajo el lock, incluido `artifact-failed` (§3.3 S2b);
  - creación del permiso atómica respecto del registro (§7.2 S_G);
  - publicación del restore desde staging, con diario (§8);
  - el punto de verificación garantizado del binding, sin prometer atomicidad entre D1 y el registro
    (§3.3 c0);
  - idempotencia por el cuerpo canónico normalizado (§3.4);
  - y los ajustes de la revisión independiente del head (diario antes del staging, relevo inicial por el camino normal, aviso de la UI sin comparar relojes, tablas al día).

Decisión que lo origina (responsable, 2026-11-11, sobre la evaluación de B en #512 a las 16:57Z):

- **GO para el camino Composer de D1–D3.** Es una vía incremental para el chat de equipo. No abandona
  Channels ni levanta el NO-GO de G3-2.
- Condiciones: **persistencia segura de entregas**, **cero reintentos incluso tras reinicios**,
  **binding del destinatario fijado al envío**, **backup/restore de `.projects`**, **seguridad en la
  transferencia de artefactos** y **permisos de colaboración revocables y auditables**. Cada una tiene
  su regla en este documento (tabla de §0.2) y su prueba en §10.
- **Sin GO para cambiar `INGEST_REQUIRE_SESSION_ORIGIN`.** D3 lo exige en `true`, pero esa activación
  tiene una autorización operativa propia (§7.1, §12).

Como CONVERSATION.md y PROJECTS.md, este documento es **vinculante**: el contrato cambia antes que el
código, nunca al revés. Cada PR de §11 cita la sección que implementa.

## 0. Alcance

### 0.1 Qué es y qué no es

**Es:**
- una **conversación del proyecto** (D1): un registro propio por proyecto con los mensajes de la
  persona, a quién se entregaron y referencias a las respuestas;
- el **traslado de artefactos** entre workspaces del mismo proyecto (D2);
- una **colaboración Dev ↔ QA** aprobada una vez por tarea, en la que el backend pasa el informe final
  de un turno de un agente al otro (D3).

En los tres casos **el único que envía es el backend, a través del Composer existente** (CONVERSATION.md
§8). Envía cuando la persona hace clic o, en D3, bajo un permiso que la persona dio para esa tarea.

**No es:**
- **Channels.** No hay entrega a un agente ocupado, ni cola, ni `chat_send`/`chat_post` de agente, ni
  invitados, ni monitor. Doc 18 §4 sigue siendo la lista de lo que solo Channels resuelve.
- **Un remitente agente.** Ningún agente emite una petición que el backend obedezca. Por eso G3-2
  (identidad del remitente agente) no se toca y sigue en NO-GO.
- **Un cambio del Composer.** Sus precondiciones, su exclusión por pane, su no-reintento, sus límites
  (48 pastes de ≤ 800 code points, L1 = 64 KiB) y su acuse por `prompt_id` siguen exactamente como en
  §8. Este contrato lo **llama**; no lo modifica.

### 0.2 Las seis condiciones del responsable, dónde se cumplen

| Condición | Regla | Prueba |
| --- | --- | --- |
| Persistencia segura de entregas | §2 (fsync, nunca descarta, escritor envenenado, un solo proceso escritor §2.1), §3.3 (intención en disco antes del efecto) | §10 T1–T4b, T22b, T22c |
| Cero reintentos, también tras reinicios | §2.1, §3.1, §3.4 | §10 T2–T5c, T8b, T8c, T22b |
| Binding del destinatario fijado al envío | §3.2, §3.3 (c0, S3), §7.2 | §10 T6–T7, T18b |
| Backup/restore de `.projects` | §2.1, §8 | §10 T15–T17 |
| Seguridad en la transferencia de artefactos | §6 | §10 T9–T14, T12b, T13b |
| Colaboración revocable y auditable | §4.1, §7.2–§7.5 | §10 T18–T22 |

## 1. Banderas y compatibilidad

| Bandera | Exige | Con la bandera apagada (por defecto) |
| --- | --- | --- |
| `PROJECT_CONVERSATION_ENABLED` | `PROJECT_CHAT_ENABLED` y `CONVERSATION_COMPOSER_ENABLED` | Las rutas de §5 no se montan (404) y no se escribe nada bajo `.projects/`. `/api/auth/status` y el resto del API quedan byte-idénticos |
| `PROJECT_ARTIFACTS_ENABLED` | `PROJECT_CONVERSATION_ENABLED` | `artifacts[]` no vacío ⇒ 409 `artifacts-off`; no se lee ni se escribe ningún archivo de workspace |
| `PROJECT_RELAY_ENABLED` | `PROJECT_CONVERSATION_ENABLED` e `INGEST_REQUIRE_SESSION_ORIGIN=true` (§7.1) | Crear un permiso ⇒ 409 `relay-off`; no corre ningún relevo |

- Una bandera encendida sin sus requisitos se registra en el arranque y **queda apagada**. Nunca
  enciende algo a medias.
- **Vuelta atrás:** apagar la bandera y recrear `app`. Lo escrito en `.projects/` queda en disco, intacto
  y sin efecto. Al volver a encender, la recuperación de §3.4 corre igual que tras cualquier reinicio.
- **Sin migración de D1.** Todo el estado nuevo vive en archivos del host. Las tablas de P3a (v19) ya
  están en el backup.

## 2. Almacenamiento: el registro del proyecto (D1)

```
<WORKSPACE_ROOT>/.projects/<project_id>/conversation.events.jsonl   append-only, seq del proyecto
<WORKSPACE_ROOT>/.projects/<project_id>/conversation.index.json     snapshot atómico (caché)
<WORKSPACE_ROOT>/.projects/<project_id>/artifacts/<sha256>          contenido de artefactos (§6)
<WORKSPACE_ROOT>/.projects/<project_id>/artifacts/<sha256>.json     metadatos del artefacto
```

**Nombres de las rutas.** 03 §2.2 reserva `.projects/<pid>/chats/` y `runtimes.events.jsonl` para
Channels. Estos nombres no chocan con ellos, y un futuro P7 puede convivir con este registro o
reemplazarlo sin migrarlo.

**Formato y garantías.** Son las de 03 §2.2 (rama de #512), escritas aquí completas para que el contrato no dependa de ese borrador:
- Un **único escritor por proyecto** asigna `seq`. Dentro del proceso lo garantiza un lock con clave
  `project:<pid>`; entre procesos, §2.1.
  Un evento está **persistido si y solo si su línea, con `seq`, está escrita**.
- **Toda escritura resuelve solo tras `write` + `fsync` del archivo.** Al crear archivos o
  directorios se hace además `fsync` del directorio y de cada padre hasta `WORKSPACE_ROOT`, con el
  mismo `fsyncDir` de `paneRecord.ts`/`recreateAttempt.ts`. Un error de `fsync` es un error de
  escritura.
- **Nunca se descarta un evento.** No hay cola con descarte ni `gap backpressure`. Si no se puede
  escribir, la operación falla: 503 `persist-failed` y ningún efecto.
- **Un error de escritura envenena el escritor.** Cualquier error de `write` o `fsync` deja el
  escritor de ese proyecto `poisoned` hasta que el registro se vuelva a abrir.
  - Mientras tanto no se escribe nada más y **no se envía nada más**: las entregas que todavía no
    escribieron su `sending` quedan sin enviar, y toda request nueva recibe 503 `persist-failed`.
  - Motivo: tras un `fsync` fallido, en Linux uno posterior puede tener éxito aunque las páginas
    anteriores se hayan perdido. Además, una línea a medio escribir pegada a la siguiente dejaría
    ilegible un `sending` que sí se envió.
- **Al abrir:** se trunca el archivo a la última línea completa que se puede parsear (un final roto
  es una escritura que nunca se confirmó). Una línea ilegible **en medio** del archivo deja el registro
  `unverifiable`: se puede leer, pero no acepta envíos ni permisos (409 `project-log-unverifiable`) y
  no se repara solo.
- El **snapshot** (`.index.json`, temp + fsync + rename) es una caché **opcional**: al abrir se
  recupera desde el archivo de eventos, y si discrepa gana el archivo. D1 no lo escribe: recalcula el
  estado desde el archivo al abrir (≤ 64 MiB). Guarda el último `seq`, el estado plegado de cada
  mensaje, entrega y permiso, y el **conjunto completo** de `clientMessageId` del proyecto (no una
  ventana; ver §3.4).
- **Sin rotación en v1.** Pasado `PROJECT_LOG_MAX_BYTES` (64 MiB por defecto), un mensaje nuevo recibe
  409 `project-log-full` y no tiene efecto. Las entregas y permisos en curso todavía pueden terminar,
  hasta un margen de 1 MiB. Nada se borra; la retención queda para #567.
- Modos: los directorios `0700` y los archivos `0600`, de root. El contenido de un workspace nunca se
  escribe aquí sin pasar por §6.

**Una sola fuente de verdad por dato:**
- **En el registro del proyecto:** los mensajes de la persona, sus destinatarios, las entregas con su
  binding, los permisos de colaboración y los relevos.
- **Solo en la captura** (CONVERSATION.md §4): el texto de los agentes. El registro guarda una
  **referencia** con hash (§4), nunca una copia.
- **En los archivos de §6:** el contenido de los artefactos, direccionado por sha256.

### 2.1 Un solo proceso escritor (exclusión entre procesos)

**Hoy nada garantiza una sola instancia del backend.** El servicio `app` no tiene `container_name`. El
arranque hace `migrateDb`, `reconcile` y la recuperación **antes** de `listen`, así que un segundo
proceso trabaja antes de fallar al abrir el puerto. Puede ser un recreate de compose que se solapa, un
`npm run dev` o un `node dist/index.js` a mano contra el mismo `WORKSPACE_ROOT`. Por eso el subsistema
de este contrato tiene **su propia exclusión, aplicada por el kernel:**

1. **Lock de escritor.** Antes de abrir cualquier registro de proyecto, de recuperar o de aceptar una
   request, el backend lanza un proceso auxiliar:

   `/usr/bin/flock --exclusive --nonblock <WORKSPACE_ROOT>/.projects/.writer.lock sh -c 'echo held; exec cat'`

   con `stdin` conectado a un pipe del backend.
   - **El lock está tomado** solo cuando llega la línea `held`. Un fallo inmediato (exit 1) significa
     que otro proceso lo tiene.
   - **El kernel lo libera solo cuando el auxiliar termina.** El auxiliar termina cuando el backend
     muere, incluso con SIGKILL, porque el pipe se cierra y `cat` sale por EOF. También termina si el
     contenedor se detiene.
   - **El lock funciona entre contenedores,** porque es el mismo inodo en el bind mount del host.
   - **Por qué así.** Node no tiene `flock` ni `fcntl`, y un archivo de lock con `O_EXCL` no se libera
     si el proceso muere. El patrón de proceso auxiliar con el lock tomado es el mismo del
     preflight F1.
2. **Sin el lock, el subsistema no arranca.** Si el lock no se obtiene, `/usr/bin/flock` no existe o
   el auxiliar no responde en 5 s:
   - el subsistema queda apagado en ese proceso: no abre registros, no recupera, no escribe, no envía y
     no releva;
   - las rutas de §5 responden 503 `project-writer-unavailable`, y el arranque lo registra en voz alta;
   - el resto del backend sigue igual.

   El subsistema **no** reintenta tomar el lock por su cuenta. Lo intenta de nuevo en el próximo
   arranque.
3. **Pérdida del lock en vivo.** Si el auxiliar termina mientras el backend vive (un `kill`, un OOM), el
   subsistema se **envenena al instante** (§2): no escribe ni envía nada más hasta reiniciar. Las
   secciones críticas comprueban además que el auxiliar sigue vivo antes de escribir.
4. **Comprobación de tamaño antes de escribir.** Cierra la ventana residual entre la muerte del
   auxiliar y la detección.
   - Antes de cada append, el escritor compara el tamaño del archivo (`fstat`) con el que él mismo dejó.
   - Si difieren, alguien más escribió: el escritor se envenena y no escribe esa línea ni hace el
     efecto que venía detrás.
   - Cada línea lleva además `w` (el `boot_id` del escritor). La recuperación informa las líneas de más
     de un `w` intercaladas como `recovery{foreign_writer}`.
5. **CLIs.** `npm run restore` toma el mismo lock con `--nonblock` antes de tocar `.projects/`. Si no
   lo obtiene, se niega y no toca nada. El backup solo lee una copia (§8) y no lo toma.
6. **Alcance (declarado).** Este lock protege **las escrituras y los envíos de este contrato**. Dos
   backends simultáneos siguen siendo un error de operación para el resto del sistema: el Composer
   directo desde Chat, las recreaciones y la ingesta. Este contrato no lo resuelve para ellos, y el
   procedimiento de deploy de A sigue siendo detener antes de arrancar.

### 2.2 Eventos

| `ev` | Campos | Identidad |
| --- | --- | --- |
| `message` | `msg_id` (UUID v4 del servidor), `client_message_id`, `by` (user_id), `kind: owner\|relay`, `to[]` (agent_ids), `text` (normalizado, §8.1.2), `text_sha256`, `request_sha256` (§3.4 regla 2), `quote_ref?` (§4.2), `in_reply_to?` (`msg_id`), `artifacts[]` (§6: `{sha256, name, bytes}`), `relay?` (`{grant_id, round, from_delivery}` en `kind: relay`) | `client_message_id` (owner) o `grant_id` + `from_delivery` (relay: **una respuesta se releva como mucho una vez por permiso**) |
| `delivery` | `msg_id`, `agent_id`, `state` (§3.1), `binding{binding_id, epoch, sid, cid}` (desde `planned`, fijo), `composer_client_message_id` (UUID v4, fijo desde `planned`), `reason?`, `http?` (`{status, result, promptId?, seq?}` de la respuesta del Composer), `artifacts[]?` (en `placing`: lo que se va a colocar), `artifacts_placed?` (§6.4), `files_possibly_placed?`, `binding_verified_at?` (en `sending`, §3.3 c0), `authorized_by` (`owner` \| `collab:<grant_id>`) | `msg_id` + `agent_id` + `state` |
| `reply_settling` | los mismos campos que `reply_ref` salvo `attribution`, más `settle_until` (ISO) — informativo: empezó el asentamiento de §4.1; **no** es una respuesta ni da elegibilidad. Si el asentamiento no se observa entero, la recuperación escribe con esos campos el `reply_ref{ambiguous{settle-unobserved}}` | `msg_id` + `agent_id` + `turn_end_seq` |
| `reply_ref` | `msg_id`, `agent_id`, `sid`, `cid`, `prompt_id`, `seq_from`, `seq_to`, `turn_end_seq`, `report_sha256`, `report_bytes`, `truncated`, `attribution: exact\|ambiguous` | `msg_id` + `agent_id` + `prompt_id` |
| `reply_late_close` | `msg_id`, `agent_id`, `prompt_id`, `capture_seq` (el seq del cierre tardío en la captura) | `msg_id` + `agent_id` + `capture_seq` |
| `artifact` | `sha256`, `name`, `bytes`, `source{kind: owner\|relay, sid, path}`, `by` | `sha256` + `source` |
| `grant` | `grant_id`, `event: created\|revoked\|ended`, `task_msg_id`, `start` (agent_id), `initial_relay_from` (delivery o `null`, §7.2), `pairs[]` (`{from, to}` de agent_ids), `bindings[]` (`{agent_id, binding_id, epoch, sid}` de cada agente del permiso, fijados al crearlo), `bindings_read_at`, `max_relays`, `expires_at`, `artifacts: bool`, `by` (user_id, en `created`/`revoked`), `reason?` (en `ended`: §7.4), `relays_used` | `grant_id` + `event` |
| `owner_ack` | `ack_id`, `client_ack_id`, `by` (user_id), `target{msg_id, agent_id?, report_sha256?}` — la persona marcó un elemento como atendido (§4.3); sin entrega ni efecto | `client_ack_id` |
| `recovery` | `boot_id`, `at`, `source: boot\|restore`, `truncated_bytes?`, `manifest_at?` (restore), `orphaned[]` (`{msg_id, agent_id, as}`), `grants_closed[]` | `boot_id` |

**Campos comunes de toda línea:** `seq` (entero ≥ 1, contiguo y estrictamente creciente en el
archivo), `ev`, `at` (ISO 8601 UTC del backend, con milisegundos), `w` (§2.1 punto 4) y `bn` (líneas
que faltan en el mismo append; 0 en la última). Con `bn`, al abrir se descarta entero un append que un
crash dejó incompleto: su `fsync` nunca terminó, así que nadie recibió confirmación de él.

**Orden en el registro:**
- un `message` antes de cualquiera de sus `delivery`;
- un `grant{created}` antes de cualquier relevo que lo cite;
- `grant{ended, reason: budget}` inmediatamente después del `delivery{sending}` que consumió el último
  relevo.

## 3. Envío con fan-out (D1)

### 3.1 Estados de una entrega

Una entrega por (`msg_id`, destinatario):

```
planned ──► [placing] ──► sending ──► delivered | unconfirmed | misdelivered | failed | uncertain | refused
   │            │
   └────────────┴──► not-sent{reason}
```

- **`planned`:** fija el binding y el `composer_client_message_id`. Todavía no hubo efecto.
- **`placing`:** solo con artefactos. Se escribe con su lista **antes** de tocar el workspace destino
  (§6.4). Es el registro de un efecto posible sobre archivos, no sobre el pane.
- **`sending`:** la **intención**, en disco antes de llamar al Composer. Ver §3.4.
- **`not-sent{reason}`:** el texto nunca llegó al Composer. Razones: `no-target`, `ambiguous-target`,
  `binding-changed`, `binding-unverified`, `agent-removed`, `grant-inactive`, `artifact-failed`,
  `persist-failed`.
  - **Tras un `placing`** dice además `files_possibly_placed: true`: el texto no se envió, pero alguno
    de los archivos puede estar en el `.st-inbox` del destino. La UI lo muestra así.
- **`refused{code}`:** el Composer **respondió** que rechazó antes de su primer efecto. Ningún byte llegó
  al pane. Cubre:
  - 400/409 de §8.1.2–§8.1.3;
  - 429 `rate-limited` (el Composer admite 30 envíos por minuto y usuario: un envío a 8 agentes y los
    relevos cuentan);
  - 503 `shutting-down`;
  - 404, por una conversación que ya no existe.
- **`uncertain{composer-error}`:** el Composer **lanzó una excepción** o respondió algo que este
  contrato no reconoce. Nunca se interpreta como «sin efecto».
- **`delivered | unconfirmed | misdelivered | failed | uncertain`:** el `result` del Composer
  (§8.1.4–§8.1.7), copiado tal cual en `http`.

**Un estado terminal no cambia nunca.** Un `uncertain` (incluido `uncertain{orphaned}` de §3.4) puede
recibir más tarde un `delivery{state: settled, result, promptId?}`.
- **La única fuente** son los eventos `composer_send` de la captura de `(sid, cid)` con
  `client_message_id = composer_client_message_id` (CONVERSATION.md §4.2: `delivered` con
  `prompt_id`, `unconfirmed`, `misdelivered`, `failed`, `resolved`). Los produce el propio Composer:
  por su T_ack, por `reconcile` o por la resolución de un admin de §8.1.
- **Este registro solo los lee:** no los provoca, no los espera con temporizador y no reintenta nada.
- **Un `settled{delivered}` con `promptId`** se trata como un `delivered` a efectos de §4. En D3, en
  cambio, la entrega ya terminó el permiso (§7.4), así que no dispara ningún relevo.

### 3.2 El destinatario se fija al enviar

Para cada destinatario, dentro de la request y antes de escribir nada:

1. **El agente:** que sea de este proyecto (dueño = quien envía), no esté retirado y tenga un binding
   vivo. Se lee D1 en ese momento, sin caché.
2. **La conversación destino**, con la misma regla que el Piloto 1 (PROJECTS.md §9): la única
   conversación interactiva de esa sesión con `canSendInput`, sacada de la lista ligera. Si no hay
   ninguna, `not-sent{no-target}`; si hay más de una, `not-sent{ambiguous-target}`.
3. Se escribe `delivery{planned, binding{binding_id, epoch, sid, cid}, composer_client_message_id}`.
   **Desde ese momento el destino de esa entrega es exactamente ese** `(binding_id, epoch, sid, cid)`.
   Nada lo reevalúa ni lo cambia, ni el reenvío, ni un relevo, ni la recuperación.

### 3.3 Orden de una entrega

```
POST /api/projects/:pid/conversation/messages
  0. validar: cuerpo, flag, dueño, to[] (1–8 agentes distintos del proyecto),
     texto con validateText (§8.1.2: los mismos 48 pastes y 64 KiB), artifacts[] (§6.1)
  1. (atajo sin lock) client_message_id ya en el índice ⇒ ir a 1'
  2. resolver §3.2 para cada destinatario (lecturas de D1 y de la lista ligera, sin lock)
  ── sección crítica S1, lock project:<pid> ──
     1'. client_message_id ya en el índice ⇒ mismo request_sha256 ⇒ responder lo guardado;
         distinto ⇒ 409 idempotency-conflict. Fin, en los dos casos
     escritor poisoned o registro unverifiable ⇒ 503 / 409, fin
     ESCRIBIR en un solo append + fsync: message + un delivery{planned | not-sent} por destinatario
  ── fin de S1 ──
  3. por destinatario (independientes entre sí; uno ocupado o rechazado no frena a otro):
       a. LEER el binding en D1 (sin lock, tope 5 s) ⇒ R_a
     ── sección crítica S2, lock project:<pid> ──
       R_a ≠ el binding fijado (binding_id, epoch, sid, vivo), o lectura fallida o vencida
          ⇒ ESCRIBIR delivery{not-sent, binding-changed | binding-unverified} + fsync, fin de esta entrega
          (en D3 además: el permiso sigue vivo y R_a coincide con grant.bindings, §7.3)
       b. con artefactos: ESCRIBIR delivery{placing, artifacts[]} + fsync
     ── fin de S2 (la colocación no se hace con el lock tomado) ──
       b'. colocar (§6.4), sin lock
     ── sección crítica S2b, lock project:<pid> (solo si b' falló) ──
          ESCRIBIR delivery{not-sent, artifact-failed, files_possibly_placed} + fsync, fin de esta entrega
     ── fin de S2b ──
       c0. LEER el binding en D1 otra vez (sin lock, tope 5 s) ⇒ R_c, recibido en t_c
           ← PUNTO DE VERIFICACIÓN GARANTIZADO del binding (ver abajo)
     ── sección crítica S3, lock project:<pid> ──
       c. R_c = el binding fijado y vivo (si no ⇒ not-sent{binding-changed | binding-unverified},
          con placing previo además files_possibly_placed); en D3, permiso vivo y R_c = grant.bindings;
          escritor no poisoned
          ESCRIBIR delivery{sending, artifacts_placed?, binding_verified_at: t_c} + fsync  ← la intención
     ── fin de S3 ──
       d. ComposerService.send({sid, cid, body: {text, clientMessageId: composer_client_message_id}})
          (sin el lock del proyecto: puede tardar hasta T_http)
     ── sección crítica S4, lock project:<pid> ──
       e. ESCRIBIR delivery{<result>, http} + fsync
  4. 202 {msgId, deliveries: [{agentId, state, reason?, http?}]}
```

- **Un `message` con 2xx sobrevive a un reinicio.** Ninguna entrega llega al Composer sin un
  `sending` en disco.
- **Toda escritura del registro, venga de donde venga, ocurre bajo `project:<pid>` con su `fsync`.**
  Esto incluye:
  - S1–S4 de esta sección y S_G de §7.2;
  - la revocación y el fin de un permiso (§7.4);
  - `reply_ref`, `reply_late_close` y `settled` (§3.1, §4.1);
  - el evento `artifact` (§6.2);
  - la recuperación (§3.4). Un error de `write` o `fsync` en cualquiera de ellas envenena el escritor (§2). Ninguna
  escritura, tampoco la de un fallo, se hace sin el lock.
- **El lock nunca está tomado durante un efecto** (colocación o llamada al Composer) **ni durante una
  llamada a D1.** Las lecturas de D1 se hacen antes de la sección crítica, que solo compara su
  resultado.
- **Una revocación del permiso** (una escritura del registro, §7.4) que entra antes de S3 gana. Una que
  entra después ya no puede impedir ese envío, y queda registrada como posterior.
- **Bindings: lo que se garantiza y lo que no.** Los cambios de binding (retirar un agente, religarlo,
  PROJECTS.md §3–§4.6) se confirman en D1 y **no** toman el lock del proyecto. **No hay atomicidad entre
  D1 y este registro**, y el contrato no la promete.
  - **Se garantiza esto:** en `t_c` (paso c0) D1 respondió que el binding fijado en `planned` estaba
    vivo, con el mismo `binding_id`, `epoch` y `sid`. El `sending` se escribe después, bajo el lock, y
    guarda `binding_verified_at = t_c`.
  - **Lo que no se puede impedir:** un cambio que D1 confirma después de `t_c` no detiene ese envío. El
    texto llega a la sesión fijada, que es la que la persona eligió al enviar, nunca a otra.
  - **Lo que muestra la UI:** si el binding fijado ya no está vivo cuando se muestra la entrega,
    agrega «entregado a la sesión que tenía el agente al enviar». No compara relojes: `t_c` es del
    backend y la retirada en D1 tiene resolución de un segundo, así que no se puede ordenar con
    precisión.
  - **Por su lado,** el Composer sigue protegiendo la conversación y el pane (CONVERSATION.md §8.1.3),
    con su comprobación de `binding-stale` en la propia request.
- **Si falla la escritura de S1,** responde 503 y no hubo efecto.
- **Si falla la del paso 3c** (`write` o `fsync`), esa entrega no se envía y el escritor queda
  `poisoned` (§2). Al reabrir, según lo que haya llegado al disco, la entrega aparece como `planned`
  (⇒ `not-sent{persist-failed}`) o como `sending` (⇒ `uncertain{orphaned}`). **En ningún caso se
  llama al Composer.**
- **Si falla la del paso 3e,** el envío ocurrió pero su resultado no quedó escrito. La entrega queda en
  `sending` y la recuperación la trata como huérfana (§3.4).
- **T_http.** El POST tiene un único presupuesto de 30 s, medido desde la llegada. Las entregas que
  sigan en curso al vencer responden `sending` y terminan solas, como en el Composer (§8.1.4). El
  `result` se lee después por la API de §5.
- **Auditoría.** El dueño del proyecto es el dueño de las sesiones (PROJECTS.md §4.3), así que no hay
  fila `operate`. Si alguna vez no lo fuera, se refuta con 409 `foreign-session` antes del paso 2.

### 3.4 Cero reintentos, también tras reinicios

Estas reglas son **MUST** y cada una tiene su prueba en §10:

1. **Una entrega llama al Composer como máximo una vez en toda su vida.** Ningún código vuelve a
   llamar al Composer para un (`msg_id`, `agent_id`) que tenga un `sending` escrito, sea cual sea su
   estado posterior.
2. **Idempotencia por la persona sin ventana.** El índice guarda **todos** los `client_message_id` del
   proyecto, y la decisión se toma **dentro de S1**, bajo el lock. Por eso dos POST simultáneos con el
   mismo id producen un solo `message`.
   - Un POST repetido, sea cual sea su antigüedad, devuelve lo guardado y no hace nada más.
   - Si **cualquier parte del cuerpo** difiere de lo guardado, recibe 409 `idempotency-conflict`. La
     comparación es por `request_sha256`, el sha256 del **cuerpo canónico normalizado**, no de los
     bytes recibidos. Ese cuerpo es un JSON con las claves ordenadas y sin espacios:
     - `text` después de `normalizeText` (§8.1.2);
     - `to[]` ordenado;
     - `artifacts[]` como lista de sha256 en minúsculas, en el orden enviado;
     - `quote_ref` e `in_reply_to`, con `null` si faltan;
     - los ids en minúsculas.

     Dos requests que solo difieren en espacios del JSON, orden de claves, CRLF/LF, espacios finales o
     el orden de `to[]` son **el mismo** cuerpo. Dos requests con el mismo id y adjuntos distintos, o
     los mismos adjuntos en otro orden, son un conflicto.
   - La ventana de 256 ids del Composer (§8.1.4 regla 10) es una segunda capa, no la garantía.
3. **`composer_client_message_id` se genera una sola vez, en `planned`, y se persiste.** Nunca se
   deriva ni se regenera. Un relevo o una recuperación nunca crean otro id para la misma entrega.
4. **Recuperación al abrir el registro** (arranque o encendido de la bandera; si hay una marca
   `RESTORED`, primero las reglas de §8), bajo el lock del proyecto y antes de aceptar requests:
   - primero se trunca el final roto y se comprueba que el registro es legible (§2);
   - `planned` sin `placing` ni `sending` ⇒ `not-sent{persist-failed}` (no hubo efecto: el paso 3c no
     llegó a disco);
   - `placing` sin `sending` ⇒ `not-sent{persist-failed, files_possibly_placed}`;
   - `sending` sin resultado ⇒ `uncertain{orphaned}`, **sin llamar al Composer**. Si el Composer
     resuelve ese envío más tarde por evidencia, eso se refleja como `settled`;
   - en un solo append + fsync se escribe `recovery{orphaned[], grants_closed[]}` (para los permisos,
     ver §7.4).
5. **Volver a enviar es siempre un mensaje nuevo,** con un clic nuevo de la persona y un
   `client_message_id` nuevo. La UI puede ofrecer «Enviar de nuevo» después de un `uncertain`, pero
   solo como un mensaje nuevo, nunca como continuación del anterior.
6. **Nada en este contrato tiene temporizador de reintento.**

## 4. Respuestas

### 4.1 `reply_ref`, sin copiar texto

Un observador del backend sigue las conversaciones con entregas `delivered` que todavía no tienen
`reply_ref`. Usa la suscripción en proceso del store de la captura, no un WS.

- **Cuándo escribe un `reply_ref`.** **No** al recibir el `turn_end` cuyo `prompt_id` es el `promptId`
  que el Composer acusó, sino cuando **termina su ventana de asentamiento**: `T_SETTLE` = 10 s desde que
  el backend recibió ese `turn_end` (reloj monotónico del proceso). Es la misma ventana en la que
  CONVERSATION.md §4.6 admite otro `Stop` en el mismo `prompt_id`.
  - Al empezar se escribe `reply_settling{settle_until}` (informativo). Mientras corre, la entrega
    muestra «respuesta recibida, confirmando…» con el texto de la captura, y **no es elegible para
    nada**. Un `reply_settling` sin `reply_ref` posterior (por un reinicio) termina en
    `reply_ref{ambiguous{settle-unobserved}}` al recuperar.
  - Al terminar, se evalúan las condiciones de abajo sobre la ventana **extendida** hasta el final del
    asentamiento, y solo entonces se escribe el `reply_ref` con su atribución final.
  - El `reply_ref` lleva el rango `seq_from..seq_to`, el `turn_end_seq`, el sha256 y los bytes del
    `last_assistant_message`, y si vino truncado (L3, CONVERSATION.md §4.4).
- **El asentamiento tiene que observarse entero.** Si el proceso que recibió el `turn_end` no siguió
  vivo durante los 10 s (un reinicio en medio, o un `turn_end` que se encuentra al recuperar), el
  `reply_ref` es `ambiguous{settle-unobserved}`. El texto se sigue mostrando, marcado «sin confirmar».
- **`attribution: exact` exige todas estas condiciones.** Se miran sobre los eventos persistidos de
  `(sid, cid)`, en orden de `seq`, dentro de la **ventana**: desde el `user_prompt` con `P` que el
  Composer acusó (`P` = `promptId`) hasta el primer cierre (`turn_end` o `turn_failed`) con `P`.
  1. `P` es nuevo: ningún prompt anterior al acusado llevaba `P`. Si lo llevaba, el mensaje se encoló
     detrás de otro turno. La búsqueda mira los **2000 eventos** anteriores al acuse
     (`PRE_ACK_SCAN`). Basta porque una entrada encolada se anuncia con el `prompt_id` del turno **en
     curso**, que está pocos eventos atrás. Un `P` repetido más lejos que eso queda fuera, como riesgo
     declarado, a cambio de no releer la captura entera en cada entrega.
  2. En la ventana no hay ningún otro prompt (`user_prompt` de cualquier origen o `internal_prompt`),
     sea cual sea su `prompt_id`.
  3. En la ventana no hay ningún cierre con otro `prompt_id` ni sin `prompt_id`.
  4. En la ventana no hay ningún `gap` (incluidos `relay_dropped` y `relay_restart`).
  5. Hay **un solo** cierre con `P` hasta el final del asentamiento. Un segundo `turn_end` o un
     `turn_failed` con `P` dentro de esos 10 s ⇒ `ambiguous{second-close}`. Lo mismo ocurre con
     cualquier prompt, cierre o `gap` de las condiciones 2–4 que llegue en esos 10 s.
  6. **Cierre tardío.** Un cierre con `P` que llega **después** de escrito el `reply_ref` no lo cambia,
     porque el registro es append-only. Se escribe `reply_late_close{msg_id, agent_id, prompt_id, capture_seq}`,
     que la UI muestra junto a la respuesta.

  Si falla una ⇒ `attribution: ambiguous{reason}`, y la UI no la muestra como «la respuesta». Un
  `turn_failed` con `P` ⇒ `reply_ref{attribution: failed}`, sin informe. Esta lista es la regla R8 de
  la serie de diseño (03 §3.1, rama de #512) sin las condiciones propias de Channels, escrita aquí para
  que el contrato no dependa de un borrador.
- **Sin acuse no hay atribución.** Una entrega sin `promptId` (`unconfirmed`, `uncertain`,
  `misdelivered`) nunca recibe un `reply_ref`.
- **El texto se muestra desde la captura,** verificado contra `report_sha256`. Si la captura ya no lo
  tiene por la rotación L7, la UI muestra «respuesta ya no retenida», con el hash. Es un costo
  aceptado de no copiar el texto.
- **Tras un reinicio,** el observador vuelve a leer desde el `seq` guardado en el índice. Es
  idempotente por la identidad de §2.2.

### 4.2 Reenviar y responder a

- **«Reenviar desde Chat»** es un mensaje nuevo con `quote_ref{msg_id, agent_id, prompt_id,
  report_sha256}`. El texto lo arma y lo envía la persona, y pasa por todo §3.
- `quote_ref` es solo un metadato para la UI. No da permisos ni cambia el destino.
- **«Respondiendo a…»** es `in_reply_to`, y la UI lo muestra con la hora.

### 4.3 «Hecho» de la persona (`owner_ack`)

`POST …/acks {clientAckId, target: {msgId, agentId?, reportSha256?}}` escribe un `owner_ack` (S1-like:
idempotente por `client_ack_id` bajo el lock, cuerpo canónico; otro cuerpo con el mismo id ⇒ 409
`idempotency-conflict`). No envía nada, no cambia ningún estado de entrega ni de permiso, y no se
deshace (append-only; un «deshacer» sería un evento futuro, fuera de D1). Valida sólo que `msgId`
exista en el registro; `agentId`/`reportSha256` se guardan tal cual. Lo que la UI deriva de él es
asunto de la UI.

## 5. API (dueño solamente; un id ajeno es el mismo 404)

| Método | Ruta | Respuesta |
| --- | --- | --- |
| `POST` | `/api/projects/:pid/conversation/messages` | §3.3 |
| `GET` | `/api/projects/:pid/conversation/events?before=&limit=&ev=` | páginas hacia atrás (≤ 500, ≤ 8 MiB), como §6 de CONVERSATION.md; `ev` filtra por tipo (lista separada por comas) |
| `GET` | `/api/projects/:pid/conversation/messages/:msgId` | el mensaje (`kind` `owner` o `relay`) con sus entregas plegadas, sus `reply_settling`, `reply_ref`, `reply_late_close` y `owner_ack` |
| `POST` | `/api/projects/:pid/conversation/acks` | §4.3 |
| `POST` | `/api/projects/:pid/conversation/artifacts` | §6.1, origen elegido por la persona |
| `GET` | `/api/projects/:pid/conversation/artifacts/:sha256` | contenido (`text/plain`, `nosniff`, `attachment`, CSP sandbox) |
| `POST` | `/api/projects/:pid/conversation/grants` | §7.2 |
| `POST` | `/api/projects/:pid/conversation/grants/:grantId/revoke` | §7.4 |
| `WS` | `/ws/project/<pid>` | `subscribe{after}` con la misma mecánica que `/ws/conversation/` (armado antes de leer, cola en bytes, `resync`) |

- **Paginación de eventos.** El registro es append-only y `seq` es estrictamente creciente, así que
  los cursores son estables: `before` es exclusivo; sin `before`, la última página. Cada página viene
  **en orden ascendente de `seq`** con `{events, oldestSeq, hasMore}`; la siguiente página hacia atrás
  es `before = oldestSeq`. Con `ev`, el filtro se aplica antes del límite y `oldestSeq` es el del
  último evento **examinado**, de modo que paginar con filtro nunca salta eventos que coincidan. Ni
  huecos ni duplicados entre páginas; el WS `subscribe{after}` empalma por `seq` igual que en la
  captura.
- **WS.** `/ws/project/` entra en `WS_PATH_PREFIXES` con su caso en `wsUpgrade.test.ts`, con la misma
  lección de 3.1 (CLAUDE.md). Hace la misma comprobación de origen y cookie que los demás WS.
- **Límites por usuario.** `projectSendIp` limita los POST de mensajes y permisos. Un `InFlightLimiter`
  limita las lecturas, y su slot se mantiene hasta que termina la respuesta, como en Files y Git.
- **Errores.** 400 `invalid-body` y los códigos de `validateText`; 404 (proyecto ajeno o inexistente);
  409 `project-log-full`, `project-log-unverifiable`, `idempotency-conflict`, `artifacts-off`,
  `artifacts-full`, `relay-off`, `origin-binding-off`, `grant-active`, `foreign-session`;
  415 `artifact-not-text`; 503 `persist-failed`, `project-writer-unavailable`, `binding-unverified`. Los rechazos por destinatario del Composer van dentro de
  `deliveries[]`, no como código del POST.

## 6. Artefactos (D2)

### 6.1 Origen y admisión

- **Quién elige.** La persona, desde Files o desde la conversación del proyecto, elige un archivo de
  una sesión ligada a un agente del proyecto. En D3 lo declara el informe del agente (§7.3), y solo
  bajo `.st-outbox/`.
- **Lectura.** Por el **mismo abridor** que la descarga de Files (`workspaceFiles.ts`):
  - prueba `/proc/self/fd/<n>` obligatoria;
  - `isRestrictedPath` aplicado, así que `.env*`, claves, `.git/`, `.ssh/`, `.st/` y `.config/gh/`
    nunca salen;
  - solo archivos regulares, nunca un link.
- **Topes.** `ARTIFACT_MAX_BYTES` 1 MiB por artefacto, 4 artefactos por mensaje y
  `PROJECT_ARTIFACTS_MAX_BYTES` 256 MiB por proyecto. Pasado el tope del proyecto, 409
  `artifacts-full`. Nada se borra para hacer lugar.
- **Contenido.** Debe ser UTF-8 válido y sin bytes NUL, es decir, texto: diffs, informes, logs. Lo
  binario se rechaza en v1 con 415 `artifact-not-text`.
- **Nombre.** Se toma el último componente del path, recortado a `[A-Za-z0-9._-]{1,96}`. Nunca empieza
  por `.`; los caracteres fuera del conjunto pasan a `_`. El nombre es informativo: la identidad del
  artefacto es su sha256.

### 6.2 Almacenamiento

- **Content-addressed.** Va a `artifacts/<sha256>` (0600, root), creado `O_EXCL`. Si ya existe un
  archivo con ese hash, se reutiliza, previa comprobación del hash del existente.
- **Metadatos.** `<sha256>.json` lleva nombre, bytes y origen, y se escribe un evento `artifact`.
- **Atomicidad.** Se escribe en un temporal, se hace fsync, se verifica el hash y se renombra. Solo
  después se escribe el evento.

### 6.3 Lo que lleva el mensaje

El agente recibe **una línea por artefacto**, agregada por el backend al final del texto:

```
[artefacto] <name> · <bytes> B · sha256 <hex> · ~/workspace/.st-inbox/<sha256-12>-<name>
```

- Cada línea es un paste corto, así que el texto no se acerca al límite de 48. Los artefactos cuentan
  en esa validación, que se hace antes del paso 2.
- El receptor verifica el hash y aplica el contenido, por ejemplo con `git apply`. En la conversación
  del proyecto, la persona ve el contenido; un diff se muestra con `diff.ts`.

### 6.4 Escritura en el workspace destino (pasos 3b–3b' de §3.3)

El workspace destino lo controla el agente y el backend es root en el host. Por eso, después de escribir
`delivery{placing}`:

1. **Abrir el workspace.** Se abre `<WORKSPACE_ROOT>/<sid>` y se verifica por `/proc/self/fd/<n>` que
   es exactamente esa ruta.
2. **Abrir el inbox.** Se abre `.st-inbox` **relativo a ese descriptor**, mediante
   `/proc/self/fd/<dirfd>/.st-inbox`, con `O_DIRECTORY | O_NOFOLLOW`.
   - Si no existe, se crea con `mkdir('/proc/self/fd/<dirfd>/.st-inbox', 0755)`, nunca con la ruta
     textual, se abre igual, y se hace `fchown` por su
     descriptor a `WORKSPACE_UID:WORKSPACE_GID`, modo 0755. Así el agente puede retirar lo que recibió.
   - Se verifica otra vez por `/proc/self/fd`.
   - Un link, o algo que no sea un directorio ⇒ `artifact-failed: inbox-not-dir`. **Nunca se sigue, se
     borra ni se reemplaza.**
   - Node no tiene `openat`. Por eso toda ruta de los pasos siguientes se arma sobre
     `/proc/self/fd/<inboxfd>/…`, que el kernel resuelve al directorio **abierto**, aunque alguien
     cambie la ruta textual. Ese directorio no puede salir del bind mount por un `rename` (EXDEV).
     **Nunca se vuelve a resolver la ruta textual.**
3. **Si el nombre final ya existe:**
   - se abre con `O_RDONLY | O_NOFOLLOW | O_NONBLOCK`, así que un FIFO puesto por el agente no bloquea;
   - `fstat` tiene que dar un archivo regular de tamaño ≤ `ARTIFACT_MAX_BYTES`;
   - si su sha256 es el esperado, se considera colocado;
   - en cualquier otro caso, `artifact-failed: exists-different`.

   Nunca se sobrescribe ni se borra.
4. **Si no existe:**
   - se crea un temporal `.<rand>.tmp` en el inbox con `O_CREAT | O_EXCL | O_NOFOLLOW | O_RDWR`,
     modo 0644;
   - se escribe, se hace `fsync`, se vuelve a leer por el mismo descriptor y se compara el sha256;
   - **solo entonces** se hace `fchown` a `WORKSPACE_UID:WORKSPACE_GID` (el mismo dueño que el backend
     da al bind mount; 1000:1000 por defecto);
   - se publica con `link(2)` del temporal al nombre final `<sha256-12>-<name>` (EEXIST ⇒ paso 3), se
     borra el temporal y se hace `fsync` del inbox.

   Así nunca queda un archivo parcial bajo el nombre final, y el agente no puede cambiar el contenido
   entre la escritura y la verificación.
5. Se escribe `delivery{sending, artifacts_placed: [{sha256, path}]}` en S3 (§3.3).

**Reglas generales:**
- **Una sola sesión destino por colocación,** la del binding fijado en §3.2.
- **Sin Docker exec.** Funciona también con la sesión detenida, aunque la entrega del texto no.
- **Sin reintento.** Una colocación que falló no se repite: la entrega queda `not-sent`.
- **Un temporal que quedó** por un fallo o una muerte del proceso se queda donde está. Lleva un nombre
  oculto propio y nunca bloquea un nombre final.
- **Lo que nunca se hace:**
  - escribir fuera de `.st-inbox/`;
  - crear un symlink (el único hard link es temporal → final, dentro del inbox verificado);
  - poner el bit de ejecución;
  - abrir un archivo existente para escribir, o borrarlo, salvo el temporal propio.

### 6.5 Riesgos declarados

- **Envenenamiento del destino.** Un agente puede llenar su `.st-inbox` con un nombre que choque. La
  regla `O_EXCL` + `exists-different` lo vuelve un fallo visible, no una sobrescritura.
- **El contenido es dato del otro agente.** El receptor no debe ejecutarlo sin revisarlo, igual que un
  diff de un tercero. La línea de §6.3 dice de qué agente viene.

## 7. Colaboración Dev ↔ QA aprobada por tarea (D3)

### 7.1 Requisitos

- **`PROJECT_RELAY_ENABLED` con `INGEST_REQUIRE_SESSION_ORIGIN=true`.** Se comprueba al arrancar, al
  crear cada permiso y antes de cada relevo. Con otro valor: el permiso nuevo recibe 409
  `origin-binding-off` y el permiso vivo termina con `ended{origin-binding-off}`.
- **Por qué hace falta el origen.** El relevo confía en que un `turn_end` atribuido a la sesión de @dev
  vino del contenedor vigente de @dev (CONVERSATION.md §3.1.1). Con `observe` eso solo se mide, no se
  exige.
- **La activación a `true` no la autoriza este documento.** Es una ventana operativa de A con su propio
  GO del responsable (§12).

### 7.2 El permiso

`POST …/grants {taskMsgId, start, pairs: [{from, to}], maxRelays, expiresInMin, artifacts}`. Solo lo
crea la persona, con un clic, sobre un mensaje suyo ya enviado: la tarea.

- **`start`.** El agente que trabaja primero. Tiene que ser un destinatario de la tarea cuya entrega
  quedó `delivered`. **Solo la entrega de la tarea a `start`, o un relevo del permiso, dispara
  relevos.** Las entregas de la tarea a otros destinatarios no disparan nada. Así, en el caso típico de
  «tarea a @dev, @qa revisa», @qa no recibe nada mientras trabaja en otra cosa.
- **`pairs`.** Entre 1 y 2 pares entre agentes vivos del proyecto, sin un par de un agente consigo
  mismo y **con como mucho un par saliente por agente**. Así cada respuesta tiene un único
  destinatario de relevo, que es lo que permite la identidad `grant_id` + `from_delivery` de §2.2. Lo típico es `@dev→@qa` y `@qa→@dev`.
- **Bindings fijados.** Al crearlo se leen de D1 los bindings de cada agente del permiso y se guardan en
  `grant.bindings[]` (`binding_id`, `epoch`, `sid`): son las sesiones que la persona vio al aprobar.
  - Todo relevo tiene que resolver §3.2 **a esos mismos** bindings. Si no ⇒ `ended{binding-changed}`
    sin enviar.
  - Un agente que se vuelva a ligar a otra sesión nunca recibe un relevo bajo un permiso aprobado para
    la anterior.
- **Respuestas anteriores al permiso.** Si la entrega de la tarea a `start` ya tenía un `reply_ref`
  `exact` al crearse el permiso, dispara exactamente un relevo en el momento de crearlo, y la UI lo
  avisa al aprobar. Cualquier otro `reply_ref` anterior a `grant{created}` no dispara nada.
- **`maxRelays`.** Entre 1 y 20, 6 por defecto. Fuera de ese rango ⇒ 400 `invalid-body`.
- **`expiresInMin`.** Entre 1 y 120, 30 por defecto. Fuera de ese rango ⇒ 400 `invalid-body`.
- **`artifacts`.** `false` por defecto.
- **Un solo permiso vivo por proyecto en v1.** Uno nuevo con otro vivo ⇒ 409 `grant-active`.
- **Orden de la creación.** Es atómico respecto del registro; no hay atomicidad con D1:

  ```
  0. validar cuerpo, flags, dueño, tarea (delivered a start), pares
  1. LEER de D1 los bindings de los agentes del permiso (sin lock, tope 5 s) ⇒ B, recibido en t_b
     (lectura fallida o vencida ⇒ 503 binding-unverified, sin escribir nada)
  ── sección crítica S_G, lock project:<pid> ──
     escritor no poisoned, registro no unverifiable
     bandera de origen = true (si no ⇒ 409 origin-binding-off)
     ¿hay un permiso vivo en el índice? ⇒ 409 grant-active
     initial_relay_from = la entrega de la tarea a start, si en el índice ya tiene un reply_ref
       exact (con seq menor que el de este append); si no, null
     ESCRIBIR grant{created, bindings: B, bindings_read_at: t_b, initial_relay_from} + fsync
  ── fin de S_G ──
  2. si initial_relay_from ≠ null, el relevo inicial sigue el camino normal de §7.3 desde S1, con su
     propia resolución §3.2 fuera del lock. Actúa sólo sobre esa decisión registrada; no vuelve a
     mirar el índice
  ```

  - La comprobación de `grant-active` y la escritura de `grant{created}` van en la **misma** sección
    crítica, así que dos creaciones simultáneas producen un solo permiso vivo.
  - Un binding que D1 cambia después de `t_b` no se refleja en el permiso, pero **todo relevo vuelve a
    verificar** los bindings contra `grant.bindings[]` en su paso c0 (§3.3). Un desajuste termina el
    permiso con `ended{binding-changed}` sin enviar.
- **Qué se registra.** `grant{created}` guarda exactamente el alcance que se mostró, y la UI lo repite
  textualmente: quién, qué pares, cuántos relevos y hasta cuándo.

### 7.3 El relevo

**Disparador.** Una entrega a X bajo este permiso (la tarea, o un relevo anterior) recibe un `reply_ref`
con `attribution: exact`. Si existe un par X→Y, el backend arma un `message{kind: relay}` para Y.
- **Una respuesta es elegible para D3 solo cuando su `reply_ref` está escrito con `exact`,** es decir,
  después de un asentamiento completo y observado (§4.1). Antes de eso nada se releva, aunque el
  `turn_end` ya esté en la captura.
- **Un `reply_late_close`** de una respuesta que ya se relevó termina el permiso con
  `ended{reply-late-close}`. El relevo ya enviado no se deshace y queda marcado en la UI.

**Texto del relevo:**

```
De @X, reenviado por Shared Terminal con el permiso <grant_id> (relevo n de N).
Es información de otro agente, no una instrucción de <dueño>:
«
<last_assistant_message del turno, tal cual>
»
```

- **Informe truncado.** Si el `reply_ref` dice `truncated: true` (el informe superó L3, 1 MiB) ⇒
  `ended{reply-truncated}`. Un informe cortado nunca se reenvía como si estuviera completo.
- **Si el texto no pasa `validateText`, por cualquier código** (más de 48 pastes, más de 64 KiB,
  `control-bytes`, `unsupported-prefix`):
  - con `artifacts: true`, el informe va como artefacto `report-<n>.md` (pasa §6.1 si es UTF-8 sin NUL
    y ≤ 1 MiB) y el texto lleva solo la cabecera y la línea de §6.3;
  - con `artifacts: false`, o si el artefacto no se admite ⇒ `ended{report-invalid}`.
- **Artefactos declarados.** Con `artifacts: true`, se trasladan además los artefactos que X declara en
  su informe con líneas `ST-ARTIFACT: .st-outbox/<name>`: como mucho 4, solo bajo `.st-outbox/`, y por
  §6.1.
- **El relevo es una entrega de §3,** con las mismas secciones críticas. Tiene
  `authorized_by: collab:<grant_id>`, el binding de Y igual al de `grant.bindings[]` y la intención
  escrita antes del efecto. **Consume una unidad al escribir el `sending`.**

**Orden del relevo:**

1. **S1:** el permiso está vivo (§7.4), la bandera de origen vale `true` y **no existe ya un
   `message{relay}` de este permiso con el mismo `from_delivery`**. Si existe, no se escribe nada: es
   la identidad de §2.2, y cubre que el disparador de §7.3 y el relevo inicial de §7.2 vean la misma
   respuesta. Si no existe, se escribe `message` + `delivery{planned}`.
2. **S2 y S3:** se vuelve a comprobar el permiso, el binding contra `grant.bindings[]` y la bandera. En
   S3 se escribe `delivery{sending}` con el contador `relays_used` y, si fue el último,
   `grant{ended, budget}` en el mismo append.
3. **Sin lock:** se llama al Composer.

Una revocación escrita antes de S3 gana: la entrega queda `not-sent{grant-inactive}` y el Composer no se
llama. Si se escribe después de S3, ese envío ya está en marcha: se muestra como último relevo y no hay
otro.

### 7.4 Fin del permiso (revocable)

El permiso termina, **sin reintentar nada**, en cualquiera de estos casos:

| Causa | `reason` |
| --- | --- |
| la persona pulsa «Detener» (un toque, en la conversación del proyecto y en la página del agente) | `revoked` (evento `grant{revoked, by}`) |
| se usaron todos los relevos | `budget` |
| venció el plazo | `expired` |
| una entrega del permiso no quedó `delivered` (ocupado, rechazo, `unconfirmed`, `misdelivered`, `failed`, `uncertain`, `not-sent`) | `delivery-<state>` |
| `reply_ref` `ambiguous` o `failed`, informe vacío o truncado, texto del relevo no admitido, cierre tardío de una respuesta ya relevada | `reply-<causa>` / `report-invalid` / `reply-late-close` |
| un agente del permiso fue retirado o cambió su binding | `binding-changed` |
| la bandera de origen dejó de ser `true`, o `PROJECT_RELAY_ENABLED` se apagó | `origin-binding-off` / `relay-off` |
| reinicio del backend o restore | `interrupted` (en `recovery.grants_closed[]`, §3.4) |

- **La revocación surte efecto antes del siguiente efecto.** Es una escritura bajo el lock del
  proyecto, y nunca espera a una llamada al Composer, porque esas corren sin el lock (§3.3). No anula un
  `sending` ya escrito: ese envío ya ocurrió, y se muestra como último relevo.
- **Vencimiento: definición y dónde se aplica.** Un permiso está **vivo** si y solo si no tiene
  `grant{revoked}` ni `grant{ended}` y el reloj del backend es anterior a `expires_at`.
  - **Toda comprobación de «permiso vivo»** usa esa definición: S1, S2 y S3 de §7.3, S_G de §7.2 y la
    evaluación del disparador.
  - **La primera comprobación que encuentra el plazo vencido** escribe `grant{ended, expired}` en su
    misma sección crítica. La entrega en curso queda `not-sent{grant-inactive}`.
  - **Además, un temporizador en proceso por permiso vivo**, programado a `expires_at`, escribe
    `grant{ended, expired}` bajo el lock aunque no haya ningún relevo pendiente. Así la UI muestra el
    fin a tiempo. Si otra escritura ya cerró el permiso, no escribe nada.
  - **En la recuperación tras un reinicio,** un permiso cuyo `expires_at` ya pasó se cierra como
    `expired`; los demás, como `interrupted`.
- **Un permiso terminado no se reabre.** Seguir significa crear un permiso nuevo, con un clic nuevo.
- **Tras un reinicio no queda ningún permiso vivo.** Todos se cierran como `interrupted`, o como `expired` si su plazo ya pasó. Es fail-closed:
  el backend nunca retoma una colaboración que la persona no ve en vivo.

### 7.5 Auditoría

- **Todo queda en el registro del proyecto, append-only:** cada permiso (alcance, autor y hora), cada
  relevo (con `relay{grant_id, round, from_delivery}`, la entrega de origen y su `reply_ref`), cada
  colocación de artefacto con su sha256, y el fin con su causa.
- **`GET …/messages/:msgId` de la tarea** devuelve la cadena completa del permiso, en orden.
- **Contadores agregados en `GET /api/admin/stats → projectConversation`,** sin ids ni texto: permisos
  creados, revocados y terminados por causa; relevos enviados; entregas por estado.
- **Un relevo nunca crea un permiso, nunca extiende uno, nunca agrega pares.** Solo un clic de la
  persona lo hace.

### 7.6 Riesgos declarados

- **El dominio de confianza de @dev.** Cualquier proceso dentro del contenedor de @dev puede influir en
  el informe de @dev. Es el mismo dominio de confianza que @dev mismo, y lo acota la bandera de origen,
  que excluye a otros contenedores, al túnel y a loopback.
- **Inyección entre agentes.** El texto de un agente puede intentar instruir al otro. Se **mitiga** con
  la cita como dato, el presupuesto, el plazo, la visibilidad en vivo y el «Detener». No se elimina.
  Esto queda declarado, igual que en M11/M12.

## 8. Backup y restore de `.projects`

Todas las rutas de esta sección son relativas a `<WORKSPACE_ROOT>`, bajo `.projects/` (y
`.restore-evidence/`). Los proyectos publicados están siempre en `.projects/<pid>/`.

**Backup** (`npm run backup`):
- **Corre en otro proceso,** así que no puede tomar el lock del proyecto. Por eso no hace `tar` del
  directorio vivo; arma primero una **copia de staging**:
  - `conversation.events.jsonl` se copia hasta su última línea completa, terminada en `\n`. Una línea a
    medio escribir queda fuera, como la trataría la recuperación al abrir.
  - Los artefactos se copian **solo** los de nombre `artifacts/<64 hex>` y `artifacts/<64 hex>.json`.
    Cada contenido se verifica contra su nombre; uno que no coincide queda fuera y se registra en el
    manifiesto.
  - **Los temporales y el índice no se copian.** El índice es una caché y se reconstruye al abrir.
- El tarball `<backup>/projects/<pid>.tar.gz` se arma desde esa staging, con sus miembros nombrados
  explícitamente.
- El manifiesto lista cada tarball con su sha256, sus bytes, el último `seq` copiado y el momento.
- Es un **punto de recuperación**, no una instantánea coherente: lo escrito después de la copia no
  está.
- Las tablas de D1 de P3a ya van en el backup (`TABLES`, `sinceSchema: 19`).

**Restore** (`npm run restore`, otro proceso dentro del contenedor `app`):
- **Exige el lock de escritor de §2.1** (`--nonblock`) y además `PROJECT_CONVERSATION_ENABLED` apagado
  en su propio entorno, que es el del backend. Así ningún backend tiene un registro de proyecto abierto
  mientras se reemplazan sus archivos. Si falta cualquiera de las dos cosas, el restore de `.projects`
  se niega y no toca nada. Las tablas y los workspaces
  siguen su procedimiento de siempre.
- **Antes de extraer:**
  - el tarball se llama como un proyecto del manifiesto;
  - las entradas pasan una allowlist exacta: `.projects/<pid>/conversation.events.jsonl` y
    `.projects/<pid>/artifacts/<64 hex>[.json]`;
  - ningún link, comprobado con los tipos de `tar -tv`;
  - nada fuera de `.projects/<pid>/`.
- **Sin `--force`, un destino con `.projects/<pid>` existente no se toca,** igual que con los
  workspaces.
- **Nunca se extrae sobre el directorio vivo.** El restore arma el proyecto completo en un staging y
  lo publica con un `rename(2)`. La marca `RESTORED` ya está **dentro** del staging antes de publicarlo,
  así que un directorio publicado nunca existe sin ella. Un diario durable impide que una publicación a
  medias se lea como un proyecto corriente. Cada paso hace `fsync` de lo que escribe y de su directorio:

  0. **Diario, antes de todo.** Se escribe `.projects/.restore-journal/<pid>.json` =
     `{restore_id, phase: staging}` (temp + fsync + rename + fsync del directorio). **Desde aquí** el
     proyecto está en restauración, exista o no `.projects/<pid>`.
  1. **Staging.** Se extrae en `.projects/.restore-staging/<pid>.<restore_id>.<n>/` (0700, `n` desde 1) y se verifica
     cada artefacto por su sha256. Uno que no coincide se mueve a `.restore-evidence/projects/<pid>/` y
     no se publica. Después se escribe `RESTORED` = `{restore_id, manifest_at, restored_at}` en el
     staging.
  2. **Diario a `publishing`.** Se actualiza el diario a `{restore_id, phase: publishing, aside?}`, de
     forma atómica igual que en el paso 0.
  3. **Apartar** (solo con `--force` y un `.projects/<pid>` existente): `rename` a
     `.projects/.restore-replaced/<pid>.<restore_id>`. **No se borra.**
  4. **Publicar:** `rename` del staging a `.projects/<pid>`. Si el destino existe, el paso falla y el
     restore se detiene con el diario abierto.
  5. **Cerrar:** el diario se renombra a `<pid>.<restore_id>.done`.

- **Regla del store** (al abrir un proyecto y antes de crear el directorio de uno nuevo):
  - **con un diario abierto** para ese `pid` ⇒ el proyecto queda `unverifiable{restore-incomplete}`.
    No se abre, no se recupera, no se crea un registro vacío en su lugar y no envía nada.
  - **sin diario abierto y con `RESTORED` en el directorio** ⇒ se aplican las reglas de restore de
    abajo, **antes** de la recuperación normal.
  - **Los nombres que empiezan por `.`** dentro de `.projects/` (staging, apartados, diarios, el lock)
    nunca se abren como proyectos.
- **Qué pasa si el proceso muere en cada punto.** En ningún caso un registro restaurado se lee sin su
  condición de restauración, ni se recupera como un reinicio corriente.

  | Muere… | Estado | El store |
  | --- | --- | --- |
  | antes de 0 | nada escrito | el proyecto vivo como siempre (o ausente: nada que restaurar) |
  | durante 1, o entre 1 y 2 | diario `staging`; staging incompleto u oculto; proyecto intacto o ausente | `restore-incomplete`: nunca un registro vacío nuevo |
  | entre 2 y 3, o entre 3 y 4 | diario abierto; proyecto intacto, o apartado y ausente | `restore-incomplete` |
  | entre 4 y 5 | publicado con `RESTORED` y el diario abierto | `restore-incomplete` |
  | después de 5 | publicado con `RESTORED` | reglas de restore |

- **Completar un restore interrumpido.** Se vuelve a correr el restore con el mismo backup. El diario
  se mira **antes** de la regla «sin `--force`, un destino existente no se toca». Con el diario
  abierto:
  - si `.projects/<pid>` ya tiene `RESTORED` con ese `restore_id`, solo ejecuta el paso 5;
  - si no, busca el staging completo de ese `restore_id`. Uno es completo **solo** si tiene su
    `RESTORED` con ese `restore_id`. Con exactamente uno, retoma en el paso 2, 3 o 4. Con más de uno,
    lo informa y no toca nada;
  - si el diario sigue en `staging` sin un staging completo, arma un staging nuevo bajo el mismo
    `restore_id`, con el siguiente `<n>`. El incompleto no se borra.

  Cualquier otro estado lo informa y no toca nada. **Nada se borra:** los staging incompletos y los
  directorios apartados quedan para el operador y para la retención de #567.
- **Reglas al consumir `RESTORED`,** más estrictas que las de un reinicio:
  - `planned`, `placing` y `sending` sin resultado ⇒ **`uncertain{restored}`**, nunca `not-sent`,
    porque el backup puede ser anterior al efecto;
  - los permisos vivos ⇒ `ended{interrupted}`;
  - se escribe `recovery{source: restore, restore_id, manifest_at}`, que la UI muestra como «restaurado desde el
    backup de <fecha>»;
  - la marca se renombra a `RESTORED.consumed-<boot_id>` después del `fsync` de ese append. No se borra.
    Si el proceso muere antes de ese rename, el próximo arranque vuelve a aplicar las reglas. Son
    idempotentes: ninguna entrega ni permiso cambia de estado, y no se agrega un segundo
    `recovery{restore}` si ya existe uno con ese `restore_id`.

  **Un restore nunca causa un envío.**
- **Lo que un restore no puede saber (riesgo declarado).** Los eventos posteriores al backup se pierden,
  incluidos sus `client_message_id`. Un POST repetido a mano con uno de esos ids, después del restore,
  sería un mensaje nuevo. El frontend nunca repite un POST por su cuenta (§3.4 reglas 5 y 6), así que esto
  solo puede pasar por una acción explícita; por eso el aviso «restaurado» es visible.

## 9. Retención

- **Nada se borra automáticamente.** Ni mensajes, ni artefactos, ni el registro.
- Los bytes de `.projects/` entran en las estadísticas `storage` de B-3 (#567).
- La retención la decide #567 con el inventario R1–R6. **No autoriza eliminaciones.**

## 10. Pruebas exigidas (aceptación de cada PR)

Todas corren con fakes deterministas y el store real sobre disco. Las de seguridad corren además contra
el sistema de archivos real (carreras con `rename`/`symlink`).

| # | Caso | Esperado |
| --- | --- | --- |
| T1 | fallo de `fsync` en la escritura de S1 | 503, sin `message`, sin llamada al Composer |
| T2 | muerte del proceso tras 3c (`sending` escrito, Composer no llamado o a medias) | al reabrir: `uncertain{orphaned}`, **0** llamadas nuevas al Composer |
| T3 | muerte tras 3d antes de 3e | igual a T2; si el Composer resolvió, `settled` por su evidencia, nunca reenvío |
| T4 | fallo de `write`/`fsync` en 3c (con 2 destinatarios) | ninguna de las dos se envía; escritor `poisoned`; al reabrir, `not-sent{persist-failed}` o `uncertain{orphaned}`, nunca un envío |
| T4b | línea rota al final / línea ilegible en medio | truncada y recuperada / registro `unverifiable`, 409 a envíos |
| T5 | mismo `client_message_id` repetido 1 000 mensajes después y tras un reinicio | lo guardado, 0 efectos |
| T5b | dos POST simultáneos con el mismo `client_message_id` | un solo `message`, una llamada por destinatario |
| T5c | mismo id con otro texto, otros `to[]`, otros `artifacts[]` (o en otro orden), otro `quote_ref` | 409 `idempotency-conflict`, 0 efectos |
| T5d | mismo id, mismo cuerpo canónico con otros bytes (CRLF, espacios finales, orden de claves y de `to[]`) | lo guardado, 0 efectos |
| T6 | binding cambia (epoch +1) antes de c0 / D1 no responde en 5 s | `not-sent{binding-changed}` / `not-sent{binding-unverified}`, 0 llamadas |
| T6b | binding cambia en D1 después de c0 y antes de la llamada al Composer | el envío va a la sesión fijada (nunca a la nueva); la UI indica que el binding ya no está vivo |
| T7 | el Composer recibe sid/cid distintos de los fijados | imposible por construcción; test de que el argumento sale del `planned` |
| T8 | un destinatario `busy` y dos libres | dos `delivered`, un `refused{busy}`, sin espera ni reintento |
| T8b | el Composer responde 429 / 503 / 404 / lanza | `refused{rate-limited\|shutting-down\|not-found}` / `uncertain{composer-error}` |
| T8c | `uncertain` y luego `composer_send{delivered, prompt_id}` en la captura | `settled{delivered}` y `reply_ref`; ninguna llamada nueva |
| T9 | origen `.env`, `.git/config`, link, directorio, > 1 MiB, binario | rechazados con su código, sin evento `artifact` |
| T10 | `.st-inbox` es un symlink a `/etc` | `artifact-failed: inbox-not-dir`, nada escrito fuera |
| T11 | `.st-inbox` cambiado por un symlink entre la verificación y el `open` | la creación cae en el directorio verificado o falla; nunca fuera |
| T12 | archivo destino existente con otro contenido / FIFO / > 1 MiB | `exists-different`, sin bloquearse, el archivo intacto |
| T12b | muerte del proceso entre `placing` y `sending` | al reabrir, `not-sent{persist-failed, files_possibly_placed}`; ningún archivo parcial bajo un nombre final |
| T13 | hash del contenido colocado ≠ esperado | `artifact-failed`, sin `sending` |
| T13b | dos entregas del mismo mensaje fallan su colocación a la vez | dos `not-sent{artifact-failed}` en S2b, líneas íntegras, registro legible |
| T14 | nombre `../x`, `.bashrc`, unicode | saneado; nunca empieza por `.`; nunca sale de `.st-inbox` |
| T15 | backup con un permiso vivo, un `planned` y un `sending`; restore; arranque | `ended{interrupted}`, ambos `uncertain{restored}`, 0 envíos; `RESTORED` consumida |
| T15b | restore con `PROJECT_CONVERSATION_ENABLED` encendido / backup durante escrituras de índice y artefactos | negado sin tocar nada / el tarball se restaura (sin temporales) |
| T15c | muerte del restore **antes de publicar**: durante la extracción, con el proyecto existente y con el proyecto **ausente** / antes de apartar / después de apartar; luego un mensaje al proyecto | `restore-incomplete` en todos los casos: ningún registro vacío nuevo, 0 envíos, ninguna recuperación como reinicio |
| T15d | muerte entre publicar y cerrar el diario; luego, el restore de nuevo | `restore-incomplete`; después del segundo restore, reglas de restore (`uncertain{restored}`), 0 envíos |
| T15e | muerte después de escribir `recovery{restore}` y antes del rename de `RESTORED` | el siguiente arranque no cambia ningún estado ni agrega otro `recovery` con ese `restore_id` |
| T16 | tarball con link o ruta fuera de `<pid>/` | restore lo rechaza antes de extraer |
| T17 | artefacto restaurado con hash cambiado | no instalado, queda en evidencia |
| T18 | revocación antes de S3 de un relevo / durante la llamada al Composer | `not-sent{grant-inactive}`, 0 llamadas / la revocación no espera; ningún relevo más |
| T18b | @qa se vuelve a ligar a otra sesión con el permiso vivo | `ended{binding-changed}`, nada enviado a la sesión nueva |
| T18c | la tarea entregada a `start` y a otro destinatario | solo la respuesta de `start` dispara |
| T18d | dos `POST …/grants` simultáneos | un `grant{created}` y un 409 `grant-active` |
| T18e | el `reply_ref` de la tarea se escribe justo después de S_G (carrera entre el disparador de §7.3 y el relevo inicial) | un solo relevo de esa respuesta (identidad `grant_id` + `from_delivery`), una unidad consumida |
| T19 | presupuesto 6 | el 6.º relevo escribe `ended{budget}`; no hay 7.º |
| T19b | `expiresInMin: 1`; respuesta elegible 2 min después | `not-sent{grant-inactive}` y `grant{ended, expired}` en la misma sección crítica; 0 llamadas |
| T19c | vence el plazo sin relevo pendiente / reinicio después de vencido | `grant{ended, expired}` por el temporizador / `expired` en la recuperación (no `interrupted`) |
| T19d | `maxRelays: 0` o `21`; `expiresInMin: 0` o `121` | 400 `invalid-body`, sin `grant{created}` |
| T20 | `reply_ref` ambiguo (cada una de las condiciones de §4.1) / `failed` / informe vacío / truncado / con `control-bytes` | `ended{reply-…}` o `ended{report-invalid}`, sin relevo |
| T20b | segundo `turn_end` con `P` a los 9 s del primero | `ambiguous{second-close}`, ningún relevo; el Composer no se llama durante los 10 s |
| T20c | segundo cierre con `P` a los 11 s, con el relevo ya enviado | `reply_late_close` y `ended{reply-late-close}`; ningún relevo más |
| T20d | reinicio a los 5 s del `turn_end` | `ambiguous{settle-unobserved}`, ningún relevo |
| T21 | reinicio con permiso vivo | `ended{interrupted}`; ningún relevo tras el arranque |
| T22 | bandera de origen ≠ `true` al crear / durante | 409 `origin-binding-off` / `ended{origin-binding-off}` |
| T22b | dos backends contra el mismo `WORKSPACE_ROOT` | el segundo responde 503 `project-writer-unavailable`, no escribe ni envía; al matar el primero con SIGKILL, el lock queda libre y el siguiente arranque lo toma |
| T22c | el auxiliar de `flock` muere con el backend vivo / alguien agrega bytes al registro | subsistema envenenado; ni esa línea ni su efecto |
| T23 | flags apagadas | rutas 404, `.projects/` sin escribir, API byte-idéntica |
| T25 | `owner_ack` repetido con el mismo `clientAckId` / otro cuerpo / `msgId` inexistente | uno solo / 409 `idempotency-conflict` / 404, sin escribir |
| T26 | paginar hacia atrás con y sin `ev`, mientras se escriben eventos nuevos | sin huecos ni duplicados, cada página ascendente |
| T27 | `turn_end` atribuible | `reply_settling` inmediato y `reply_ref` a los 10 s; ningún efecto entre ambos |
| T24 | `/ws/project/` por la entrada real | admitido y probado en `wsUpgrade.test.ts` |

## 11. Plan de PRs (después de aprobar este contrato)

| # | PR | Contenido | Gate |
| --- | --- | --- | --- |
| 1 | D1-a | store del proyecto (§2), lock de escritor (§2.1, con `/usr/bin/flock` comprobado en el job de la imagen del backend), recuperación (§3.4), backup/restore (§8), T1–T5d, T15–T17, T22b, T22c, T23 | contrato aprobado |
| 2 | D1-b | fan-out (§3), `reply_settling`/`reply_ref` (§4.1), `owner_ack` (§4.3), API y WS (§5), T6–T8c, T24, T25–T27 | D1-a |
| 3 | frontend | conversación del proyecto (A), sobre la API de §5 | D1-b |
| 4 | D2 | artefactos (§6), S2b (§3.3), T9–T14 y T12b, T13b, revisión de seguridad independiente | D1-b |
| 5 | D3 | permisos y relevo (§7), T18–T22 | D2, y la bandera de origen en `true` en producción (GO propio) |
| 6 | Piloto 2 | Dev ↔ QA con los criterios del Piloto 1 | GO del responsable |

**Cada PR va con su bandera apagada por defecto.** Un merge no autoriza deploy ni activación.

## 12. Bandera de origen: lo que se prepara con A (sin activar)

Solo preparación y lecturas. **El cambio a `true` tiene una autorización operativa independiente.**

1. **Evidencia de `observe`** desde que está activo: los contadores de §3.1.1 (`match` frente a cada
   causa) y las sesiones distintas que coincidieron y que no.
   - **Criterio propuesto para pedir el GO:** ≥ 24 h con 0 rechazos que no se expliquen por una
     recreación o una parada en curso.
2. **Inventario de sesiones con captura,** cada una con contenedor vigente, red `sessions-net` con
   dirección y relay `="2"`. Una sesión sin dirección en la red sería rechazada con `true`.
3. **Procedimiento de la ventana:**
   - **Preflight:** `b_idle`, fuera de 08–09Z, sin backup corriendo, SHA e imagen registrados.
   - **Cambio:** `.env` en modo append-only, recrear `app` con `--no-build`.
   - **Comprobaciones:** los contadores siguen en `match`, la captura sigue entrando y el Composer
     sigue entregando.
   - **Vuelta atrás:** volver a `observe` y recrear.
4. Nada de esto se ejecuta sin el GO, y ninguna de estas lecturas cambia nada en VM100.

## 13. Qué no cambia

- **CONVERSATION.md §8** (Composer), §3.1.1 (origen de red) y §4 (captura): sin cambios.
- **PROJECTS.md §1–§8:** sin cambios. **§9** (el panel del Piloto 1) queda como está hasta que exista
  la conversación del proyecto; su retiro se decide entonces.
- **Doc 18 §4:** se enmienda para registrar este camino. Channels, PASS-B, el monitor y G3-2 conservan
  sus gates.

## Apéndice A. Integración con el frontend (D1)

Formato de cable: los **cuerpos de request** y las **respuestas resumen** usan camelCase (como el
Composer); los **eventos** se entregan tal como están en el registro (snake_case, como los eventos de la
captura). Las fechas son ISO 8601 UTC.

```ts
// ── Eventos (GET …/events, WS frame {type:"event", event}) ────────────────
type Base = { seq: number; ev: string; at: string; w: string; bn: number };
type Binding = { binding_id: string; epoch: number; sid: string; cid: string };
type DeliveryState =
  | "planned" | "placing" | "sending" | "settled"
  | "delivered" | "unconfirmed" | "misdelivered" | "failed" | "uncertain"
  | "refused" | "not-sent";

type MessageEv = Base & {
  ev: "message"; msg_id: string; client_message_id: string | null; by: string;
  kind: "owner" | "relay"; to: string[]; text: string; text_sha256: string; request_sha256: string | null;
  quote_ref: { msg_id: string; agent_id: string; prompt_id: string; report_sha256: string } | null;
  in_reply_to: string | null;
  artifacts: { sha256: string; name: string; bytes: number }[];
  relay: { grant_id: string; round: number; from_delivery: { msg_id: string; agent_id: string } } | null;
};
type DeliveryEv = Base & {
  ev: "delivery"; msg_id: string; agent_id: string; state: DeliveryState;
  reason?: string;                       // not-sent / refused / uncertain{…} / settled{result}
  binding?: Binding; composer_client_message_id?: string;
  http?: { status: number; result?: string; promptId?: string; seq?: number };
  files_possibly_placed?: boolean; binding_verified_at?: string;
  authorized_by: "owner" | `collab:${string}`;
};
type ReplySettlingEv = Omit<ReplyRefEv, "ev" | "attribution"> & { ev: "reply_settling"; settle_until: string };
type ReplyRefEv = Base & {
  ev: "reply_ref"; msg_id: string; agent_id: string; sid: string; cid: string; prompt_id: string;
  seq_from: number; seq_to: number; turn_end_seq: number;
  report_sha256: string | null; report_bytes: number; truncated: boolean;
  attribution: "exact" | "failed" | `ambiguous{${string}}`;
};
type ReplyLateCloseEv = Base & { ev: "reply_late_close"; msg_id: string; agent_id: string; prompt_id: string; capture_seq: number };
type OwnerAckEv = Base & { ev: "owner_ack"; ack_id: string; client_ack_id: string; by: string;
  target: { msg_id: string; agent_id?: string; report_sha256?: string } };
type RecoveryEv = Base & { ev: "recovery"; boot_id: string; source: "boot" | "restore";
  manifest_at?: string; orphaned: { msg_id: string; agent_id: string; as: string }[]; grants_closed: string[] };
// grant / artifact: D2–D3 (§2.2), no aparecen con D1 solo.
type ProjectEvent = MessageEv | DeliveryEv | ReplySettlingEv | ReplyRefEv | ReplyLateCloseEv | OwnerAckEv | RecoveryEv;

// ── Requests ─────────────────────────────────────────────────────────────
type SendBody = { clientMessageId: string /* UUID v4 */; text: string; to: string[] /* agentIds, 1–8 */;
  quoteRef?: { msgId: string; agentId: string; promptId: string; reportSha256: string };
  inReplyTo?: string; artifacts?: [] /* D2 */ };
type AckBody = { clientAckId: string; target: { msgId: string; agentId?: string; reportSha256?: string } };
```

**`POST …/messages`** → `202`

```json
{ "msgId": "5b0e…", "replayed": false,
  "deliveries": [
    { "agentId": "a0…dev", "state": "delivered", "http": { "status": 202, "result": "delivered", "promptId": "p-91…", "seq": 412 } },
    { "agentId": "a0…qa",  "state": "refused",   "reason": "busy", "http": { "status": 409 } },
    { "agentId": "a0…ops", "state": "not-sent",  "reason": "ambiguous-target" },
    { "agentId": "a0…ux",  "state": "sending" }
  ] }
```

Una entrega en `sending` al responder (T_http) termina sola: su resultado llega como evento `delivery`.
Un replay devuelve el mismo cuerpo con `"replayed": true`.

**`GET …/events?before=900&limit=3`** → `200`

```json
{ "events": [
    { "seq": 897, "ev": "delivery", "at": "2026-11-12T10:00:01.120Z", "w": "b-7f…", "bn": 0, "msg_id": "5b0e…", "agent_id": "a0…dev",
      "state": "delivered", "authorized_by": "owner", "http": { "status": 202, "result": "delivered", "promptId": "p-91…", "seq": 412 } },
    { "seq": 898, "ev": "reply_settling", "at": "2026-11-12T10:03:40.002Z", "w": "b-7f…", "bn": 0, "msg_id": "5b0e…", "agent_id": "a0…dev",
      "sid": "a724…", "cid": "c-1…", "prompt_id": "p-91…", "seq_from": 412, "seq_to": 455, "turn_end_seq": 455,
      "report_sha256": "9c1d…", "report_bytes": 1834, "truncated": false, "settle_until": "2026-11-12T10:03:50.002Z" },
    { "seq": 899, "ev": "reply_ref", "at": "2026-11-12T10:03:50.010Z", "w": "b-7f…", "bn": 0, "msg_id": "5b0e…", "agent_id": "a0…dev",
      "sid": "a724…", "cid": "c-1…", "prompt_id": "p-91…", "seq_from": 412, "seq_to": 455, "turn_end_seq": 455,
      "report_sha256": "9c1d…", "report_bytes": 1834, "truncated": false, "attribution": "exact" } ],
  "oldestSeq": 897, "hasMore": true }
```

El texto de la respuesta se lee de la captura de esa sesión
(`GET /api/sessions/<sid>/conversations/<cid>/events/<turn_end_seq>`, el `last_assistant_message`) y se
compara con `report_sha256` (sha256 de sus bytes UTF-8). Si la captura ya no lo tiene: «respuesta ya
no retenida».

**`GET …/messages/:msgId`** → `200`

```json
{ "message": { "seq": 880, "ev": "message", "msg_id": "5b0e…", "kind": "owner", "to": ["a0…dev"], "text": "…", "in_reply_to": null, "quote_ref": null, "artifacts": [], "relay": null, "…": "…" },
  "deliveries": [ { "agentId": "a0…dev", "state": "delivered", "events": [ /* delivery events, ascendente */ ] } ],
  "replies": [ { "agentId": "a0…dev", "settling": { /* reply_settling */ }, "ref": { /* reply_ref */ }, "lateCloses": [] } ],
  "acks": [] }
```

**WS `/ws/project/<pid>`**: el cliente envía `{"type":"subscribe","after":<seq>}`; el servidor manda
`{"type":"event","event":<ProjectEvent>}` en orden de `seq`, sin duplicados, y si se queda atrás
`{"type":"resync","fromSeq":<n>}` (recargar por `GET …/events` desde ahí). Cierre 1008 = sin permiso.

**Errores**: `{ "error": "<code>", "detail"?: string }` con los códigos de §5.

**Flag**: `GET /api/auth/status` → `features.projectConversation: true` sólo con la bandera encendida
(la clave falta si está apagada, igual que `projectChat`; ausente ⇒ `false`). Con la bandera apagada las
rutas no existen (404) y la respuesta de `/auth/status` queda byte-idéntica.
