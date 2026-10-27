# Auditoría integral de 3.0d (antes de desplegar)

Estado: **para dictamen de Work**. Revisa `main` en `a3f3fc3` (#452–#456, #459, #461, #464) contra
[CONVERSATION.md](../CONVERSATION.md) v1.6 §2.4, §2.5, §2.7 y §7, el diseño
[phase3-3.0d-activation.md](./phase3-3.0d-activation.md) v5 y los criterios de §10 "3.0d activación".
No se ha desplegado nada ni se ha recreado ningún contenedor real, y la captura sigue apagada.

**Método.** Tres revisiones independientes, de solo lectura:

- trazabilidad de cada criterio de §10 a sus tests (anexo A);
- fallos entre componentes: locks, registro, autorización, motor y endpoints;
- imagen, relay, smokes reales y despliegue.

Los hallazgos de código los verificó después quien redacta: leyendo el código y, cuando se indica,
reproduciéndolos con un test temporal que no queda en el repositorio. Los smokes con Docker real
corren en el runner aislado de CI (workflow `Session Image`). En este entorno no hay daemon.

**Propuesta de dictamen: CHANGES REQUIRED** por A1 y A2, más A3 en la documentación de despliegue.
El resto son P3, inconsistencias del contrato y decisiones pendientes que no bloquean, salvo que
Work o el responsable digan lo contrario.

## 1. Defectos de implementación

### A1 / P1 (propuesto) — una deshabilitación de emergencia concurrente con `PATCH {enabled:true}` queda deshecha

- **Dónde:** `backend/src/conversation/activation.ts`, `enableSession` (comprobación de revocación
  al entrar → `restoreIngestToken` o `setConversationRequested(true)` → `removeSessionRevocation`).
- **Qué:** la revocación global se comprueba solo al entrar, y la marca por sesión se borra después
  de la escritura en D1 sin comprobar que sea la misma que había al empezar. `conversation:disable`
  no toma el lock (correcto, §2.4), así que puede ejecutarse entero entre esas dos comprobaciones.
- **Reproducido** (test temporal sobre las funciones reales, D1 simulado): el comando de emergencia
  termina entre la comprobación y la escritura del enable. Estado final:
  `conversation_requested = 1`, los dos hashes NULL, **sin marca de revocación**, sin archivos. La
  captura no vuelve en ese contenedor (no hay hash), pero el siguiente spawn de la sesión (tras
  `kill`, un borrado soft o un contenedor que ya no existe) ve requested ∧ flag ∧ sin revocación y
  genera token nuevo: **la captura vuelve**. Contradice §2.4 ("Emergencia… persistente: el siguiente
  `start` no regenera nada") y "la revocación nunca se bloquea". El test de 100 repeticiones de §10
  solo comprueba archivos y `effective`, no D1 ni la marca.
- **Variante con `--all`:** la fila queda con `requested = 1` bajo la marca global. Tras
  `enable-all`, su siguiente spawn captura y las demás no.
- **Corrección propuesta:** en `enableSession`, leer la marca por sesión al entrar y, tras la
  escritura en D1, volver a comprobar la revocación (global y por sesión). Si apareció o cambió,
  devolver D1 al estado revocado (el mismo `revokeIngestTokens` de la emergencia), no borrar la marca
  y responder 409 `revoked`/`revoked-globally`. Ampliar el test de 100 repeticiones para que
  compruebe también D1 y la marca al final.

### A2 / P2 — el paso 6 escribe los puertos leídos en las precondiciones y pisa un `PATCH /ports` concurrente

- **Dónde:** `backend/src/recreate/engine.ts`, el elemento `ports` del paso 6
  (`setPorts(sessionId, facts.config.ports, …)`); `facts.config` se lee en `evaluate()`. El mismo
  origen tienen `gitIdentity` y `postStart` del paso 6.
- **Qué:** `PATCH /api/sessions/:id/ports` es metadato puro, sin lock (#190). Si el dueño cambia o
  retira un puerto mientras `N` arranca, el paso 6 reescribe la lista vieja. Un puerto vuelto privado
  o retirado queda **público** en el dispatcher (`is_public = 1`), mientras `GET /ports` muestra la
  configuración nueva, hasta el siguiente start o reconcile. `convergedOnN` no mira los puertos,
  así que el registro se resuelve `committed`.
- **Reproducido** por la revisión de fallos entre componentes (motor real con el harness: config
  cambiada durante `start(N)` ⇒ el paso 6 escribió la lista anterior, registro `resolved`).
  Verificado leyendo el código. La resolución (`resolveToN`) ya relee la configuración.
- **Corrección propuesta:** releer `getConfig` en el paso 6, justo antes de `setPorts`, gitIdentity
  y postStart, como hace `resolveToN`.

### A3 / P2 (documentación) — DEPLOYMENT.md manda actualizar el CLI, y eso bloquea el piloto

- **Dónde:** `docs/DEPLOYMENT.md`, paso 2 del orden de despliegue: "check `claude --version`
  ≥ 2.1.308 … (`claude update` in the session)".
- **Qué:** la allowlist aprobada es **exactamente** {2.1.308}. Seguir ese paso, o que el CLI se
  autoactualice al usarlo, deja la sesión piloto con `control-marker-incompatible`.
- **Corrección:** exigir 2.1.308 exacta, no actualizar, comprobar justo antes del `POST` y
  desaconsejar arrancar el CLI de la sesión piloto sin el autoupdater desactivado (§7).

### A4 / P3 — `PATH` con un directorio del usuario primero

- **Dónde:** `session-image/Dockerfile` (`ENV PATH=/home/developer/.npm-global/bin:$PATH`).
  `seed-skills.sh` llama a `stat`, `cp` y `mkdir` por nombre; `recreateExec` y `probeRelay`, a
  `timeout` y `curl`; el entrypoint, a `python3`.
- **Qué:** `~/.npm-global/bin` está en el workspace y lo escribe el usuario. Un `stat` falso hace
  sembrar con `defer-skill-seed` presente, lo que rompe la garantía de §2.7.3 durante una recreación.
  Un `curl` falso da `effective:true` sin relay.
- **Impacto:** solo afecta a la propia sesión del usuario, que ya tiene el token en su entorno. No
  hay escalada.
- **Corrección:** `PATH=/usr/sbin:/usr/bin:/sbin:/bin` al principio de `seed-skills.sh`, y rutas
  absolutas en los `Cmd` del backend (`/usr/bin/timeout`, `/usr/bin/curl`) y en el entrypoint.

### A5 / P3 — `failSession` marca `failed` fuera del lock, y la recreación no mira un bootstrap en curso

- **Dónde:** `backend/src/bootstrap.ts`, `failSession` (`updateStatus("failed")` antes de
  `sessionLifecycleLock.run(…, "kill", …)`); precondiciones de `engine.ts`.
- **Escenario:** el dueño detiene una sesión recién creada mientras el bootstrap espera la
  readiness (≤ 60 s) y un admin la recrea en esa ventana. El bootstrap puede acabar corriendo dentro
  de `N`, o marcar `failed` en mitad del intento.
- **No reproducido;** la ventana es estrecha.
- **Corrección:** mover el cambio a `failed` dentro del cuerpo del lock. Bloquear la recreación con
  el bootstrap en curso sería una precondición nueva: es un cambio de contrato (decisión P-3).

### A6 / P3 — `PATCH /admin/sessions/:id/resources` sin lock durante una recreación

- **Qué:** aplica `docker update` a `O`, que va a desaparecer. Si llega después de construir las
  opciones de `N`, `N` conserva los límites viejos, aunque el admin recibió 204.
- **Corrección:** tomar el lock (en modo `fail`, con `busy`), o releer los límites al crear `N`.

### A7 / P3 — documentación desactualizada o incompleta

- **DEPLOYMENT.md:**
  - la sección de conversación aún describe 3.0c: el relay "con token y archivo de hooks", "Making
    enable effective is an entry requirement of 3.0d", "only the 3.0c image has";
  - no menciona `/etc/st-control`, la etiqueta `="2"` ni `relay.enabled`;
  - el rollback de backend solo contempla volver a 3.0b, no el límite de §6.1;
  - el procedimiento de emergencia no nombra lo que el diseño §8 pide nombrar: la identidad git y
    los dotfiles.
- **Comentarios en el código:** el de `hooks/relay.py` ("token + managed hooks file") y el de
  `conversation-smoke.sh` sobre los permisos del directorio de control (ahora 0755).

### A8 / P3 — redacción que promete de más

- La identificación del relay (`GET /st-relay/status`) distingue "algo escucha" de "el relay
  escucha", pero no autentica: el propio usuario puede ocupar el puerto y responder esos headers.
  Solo se quita captura a sí mismo, y la autorización de ingesta sigue siendo el token. Conviene
  decirlo así en §2.6 y en session-image/README.md.
- El supervisor espera con `sleep 0.5` externo: un proceso cada 0,5 s mientras falte la marca,
  frente al "sin procesos nuevos" de §2.6. Corregir el bucle o la frase.

## 2. Inconsistencias del contrato (redacción; se resuelven en CONVERSATION.md)

- **C1:** §10, smoke "Recreación correcta": "el backend muerto … después del 4 ⇒ completa con `N`"
  contradice D8 y la fila A2/P2 del mismo §10 ("Caída entre el CAS y 6.1 ⇒ … `recreate-unresolved`").
  El código sigue D8. Igualmente, "muerto entre los pasos 2 y 4 ⇒ `O` intacto": tras el reinicio `O`
  queda renombrado `-old-<ts>` y la sesión bloqueada (D8), sin vuelta automática.
- **C2:** §10 "Eliminación incierta": "con la eliminación confirmada en el siguiente `reconcile`".
  Tras un reinicio nada la confirma (D8); solo la pasada de resolución del proceso dueño del intento.
- **C3:** §2.7.5 dice que una incompatibilidad bloquea con `control-marker-incompatible` también en
  `PATCH {enabled:true}`. La frase es condicional ("Si falla") y la validación pasó, pero el `PATCH`
  no tiene esa comprobación (relacionado con la decisión P-2).

## 3. Decisiones pendientes del responsable (no implementadas)

- **P-1. Auditoría del `PATCH` sobre la sesión de otro usuario (#465).** El contrato no la exige.
  Recomendación de Work: auditar la habilitación ajena de forma fail-closed; para deshabilitar, un
  fallo de auditoría no debe impedir el corte.
- **P-2. Allowlist del CLI aplicada al `PATCH {enabled:true}` (#466).** La decisión aprobada limita la
  recreación. Extenderla al `PATCH` requiere otra decisión explícita (Work no la exigiría).
- **P-3 (nueva, de A5, #467).** Si la recreación debe bloquear con un bootstrap en curso, con un código de
  precondición nuevo.

## 4. Restricciones operativas aceptadas

- **D8 fail-closed.** Un intento interrumpido queda `recreate-unresolved` y nada lo resuelve tras
  reiniciar. El piloto es solo una sesión nueva y descartable. No se recrean sesiones reales hasta
  que exista y se valide un procedimiento de recuperación administrativa manual.
- **Allowlist exacta {2.1.308}, solo para el piloto.** Una versión no validada, también una
  autoactualizada, bloquea la recreación.
- **Un solo backend.** El lock de ciclo de vida es local al proceso.
- **No verificados:**
  - la durabilidad frente a un corte eléctrico real (punto 10);
  - el fallo aislado de #463, sin reproducir y sin causa atribuida.
- **`effectiveSessions` es una estimación de configuración, nunca disponibilidad verificada.**
- **Deshabilitar sin recrear deja el relay inerte** hasta que el contenedor se recrea (§2.4).

## 5. Cobertura de pruebas (resumen; detalle en el anexo A)

- **Verificado con tests unitarios y de integración**, la mayor parte de §10 3.0d:
  - precondiciones y clases de `docker diff`;
  - `expectImageId` y D6;
  - registro durable;
  - CAS atómico;
  - concurrencia con el intento sin resolver (K1);
  - evidencia frente a tiempo (K1.2);
  - E1–E6;
  - R1–R3;
  - el probe D7;
  - la conservación tras el stop;
  - los contenedores de 3.0c (K3);
  - los residuales.
- **Docker real (CI, `realDocker.smoke.ts`):**
  - una capa limpia es recreable; bloquean `layer-home`, `layer-gitconfig-modified` y
    `managed-skills-customized`;
  - `start` manual de `O` ⇒ rollback sin arrancar `N`;
  - CAS rechazado tras dos arranques de `N` ⇒ skills intactas;
  - camino exitoso: `N` desde el ID comprobado, `O` borrado, D1 en `N`, probe real ⇒
    `effective:true`;
  - evidencia de terminación de exec; `N` sobrevive a boot passes y stop/start; un sobrante real se
    elimina.
- **Docker real + CLI real 2.1.308 con modelo simulado (CI, `conversation-smoke.sh`):**
  - el relay se lanza con `relay.enabled` y se identifica;
  - la identificación no filtra secretos;
  - la compatibilidad de `/etc/st-control` (vacío, con marcas, JSON inválido, ilegible) da los
    mismos hooks y ningún aviso;
  - la siembra diferida y fail-closed;
  - el reinicio del relay produce `gap relay_restart`.
- **Huecos** (detalle en el anexo A):
  - casi todo el bloque "Smoke de Docker con el CLI real": `--resume` y hash del workspace tras
    recrear, git email, secreto y puerto en `N`, `apt-get install`, backend muerto entre pasos
    (con el resultado de D8), relay no disponible con 0 "hook error", y la cota de 3 s tras
    `kill -9`;
  - `PATCH` con el CLI real (pestaña abierta y nueva);
  - la fila "ni `O` ni `N`" (`recreateOrphans`);
  - postStart colgado más allá de `T_rec`;
  - variantes de reinicio;
  - "ambos hashes NULL tras la emergencia nunca se reautorizan" (relacionado con A1);
  - skills byte a byte.
- **Propuesta:** ampliar los smokes de CI (runner aislado, sin tocar la VM) con los huecos que no
  dependen de un modelo real antes del despliegue. Dejar para el piloto solo lo que necesita una
  sesión y un modelo reales (§7).

## 6. Despliegue coordinado (propuesta; no ejecutado)

Un único despliegue al final de 3.0d, cuando el responsable lo autorice. Hasta entonces la VM no se
toca. Cada etapa se puede detener y revertir; avanzar de etapa requiere autorización explícita.

### 6.0 Antes de empezar (sin cambios en la VM)

1. Registrar el SHA desplegado hoy (`git rev-parse HEAD` en la VM) y la imagen de sesión vigente
   (`docker image inspect shared-terminal-session --format '{{.Id}}'`). Son los puntos de rollback.
2. `docker compose exec app npm run backup` y comprobar que el directorio tiene `manifest.json`.
3. Confirmar que existe `sessions-net` (`docker network inspect sessions-net`) y que hay espacio en
   disco para `.conversations/` (L7) y una imagen más.
4. `CONVERSATION_ENABLED` y `CONVERSATION_ALLOW_USERS` **sin definir** en `.env`.
5. Anotar las sesiones existentes y su estado (`GET /api/admin/sessions`) para comparar después.

### 6.1 Etapa 0 — backend 3.0d + imagen `="2"`, flag apagado

1. Etiquetar la imagen actual para el rollback:
   `docker tag shared-terminal-session shared-terminal-session:pre-3.0`.
2. `git pull` al SHA aprobado; `docker build -t shared-terminal-session ./session-image`;
   comprobar `docker image inspect … --format '{{index .Config.Labels "io.shared-terminal.conversation-relay"}}'` = `2`.
3. `docker compose up -d --build`. Compose recrea solo `app` (con el alias `st-backend`); los
   contenedores de sesión no se tocan. Las migraciones pendientes (hasta v16) son aditivas.
4. Verificar, sin crear ni recrear sesiones:
   - el arranque registra `conversation capture disabled`, sin errores de `reconcile` ni de
     `recoverOnBoot` (no hay registros de intento);
   - las sesiones existentes siguen igual (estado, `container_id`, imagen): `start` reutiliza su
     contenedor y no escribe marcas ni archivos (§2.4.1);
   - `POST /ingest/claude/hook` → 204 (`disabled`) desde un contenedor de sesión
     (`curl … http://st-backend:3001/ingest/claude/hook`);
   - `GET /api/admin/sessions/<sid>/recreate` → `recreatable:false` con `flag-off` (sin efectos);
   - `GET /api/admin/stats` → `conversation.enabledSessions = 0`, `effectiveSessions = 0`;
   - no existe ningún `.claude-managed/*/conversation.json` ni `.st-control/*/relay.enabled`.

**Rollback de la etapa 0:** `git checkout <SHA anterior>` + `docker compose up -d --build` (el
esquema aditivo no estorba al backend anterior) y `docker tag shared-terminal-session:pre-3.0
shared-terminal-session`. Con el flag apagado no hay captura que retirar. Las sesiones nuevas creadas
durante la etapa 0 conservan la imagen `="2"` hasta recrearse; sin token ni montajes son
indistinguibles de las anteriores.

**Límite del rollback de backend:** un backend anterior a 3.0d no conoce el registro de intento ni
la puerta `recreate-unresolved`: con un intento sin resolver, `start`, `stop` y el borrado duro
actuarían sobre la sesión piloto. **No se hace rollback de backend con un intento sin resolver**;
primero se resuelve o se elimina (borrado duro) la sesión piloto con el backend 3.0d. Un rollback a
3.0c y vuelta a 3.0d dejaría sin captura (sin montaje de control) a las sesiones creadas en medio con
captura; hoy no existen, porque 3.0b/3.0c nunca se desplegaron con el flag encendido.

### 6.2 Etapa 1 — flag encendido, nadie solicitado

1. `CONVERSATION_ENABLED=true` en `.env`; `docker compose up -d` (compose ya reenvía la variable,
   #464).
2. Verificar: `reconcile` sin correcciones ni huérfanos; `enabledSessions = 0`; ningún archivo de
   hooks ni marca; ingest de un token desconocido rechazado y contado.

**Rollback:** quitar la variable y `docker compose up -d`; `reconcile` retira cualquier archivo.

### 6.3 Etapa 2 — piloto aislado (D8)

Ver §7. Requiere autorización explícita y se acepta que la sesión piloto pueda quedar bloqueada en
`recreate-unresolved`.

**Corte inmediato en cualquier momento:**
`docker compose exec app npm run conversation:disable -- <sid>` (o `--all`). La ingesta se
rechaza desde la marca; deshabilitar no necesita el lock y funciona con la recreación sin resolver.

### 6.4 Lo que el despliegue no hace

- No recrea ningún contenedor existente ni habilita captura en sesiones reales.
- No usa el procedimiento manual de emergencia (`docker rm` + `start`).
- No define `CONVERSATION_ALLOW_USERS` (etapa 3, decisión aparte). Definirlo junto con el flag haría
  que las sesiones nuevas de esos usuarios capturen desde el spawn, saltándose el piloto: queda vacío
  hasta que el piloto pase.

## 7. Plan de piloto (etapa 2)

**Sesión:** nueva, creada para el piloto por el responsable, sin repositorio ni datos reales, sin
dotfiles, **sin** estar en `CONVERSATION_ALLOW_USERS` (nace sin token ni montajes); se usa lo mínimo
para tener un transcript (una sesión interactiva corta) y se detiene.

**Comprobaciones previas:**

1. `claude --version` en la sesión = **exactamente 2.1.308** (allowlist; cualquier otra versión
   bloquea con `control-marker-incompatible`). **No** ejecutar `claude update`, y evitar que el CLI
   se autoactualice antes del `POST`: crear la sesión piloto con `DISABLE_AUTOUPDATER=1` en sus
   variables de entorno (a verificar con la versión del CLI) y volver a comprobar la versión justo
   antes del `POST`. Una sesión cuyo CLI se actualizó ya no es recreable hasta validar esa versión.
2. `PATCH /api/admin/sessions/<sid>/conversation {"enabled":true}` → `requested:true`,
   `effective:false`, `requiresRecreate:true` (`container-without-capture`).
3. `GET …/recreate` → `recreatable:true`, `blockers:[]`, `captureAfter:true`; anotar
   `currentImageId`.

**Recreación:** `POST …/recreate {"expectImageId":"<currentImageId>"}`.

- Éxito esperado: `200 committed`, sin `unresolved`; `capture.effective:true`.
- Si responde `unresolved:true` o 500 `{unresolved:true}`: **parar el piloto**, no reintentar ni
  intervenir a mano; recoger logs (`[recreate]`) y el registro
  `.st-control/<sid>/recreate-attempt.json` para Work. La sesión puede quedar bloqueada (D8).

**Verificación (checklist):**

1. `docker inspect st-<sid12> --format '{{.Image}}'` = `currentImageId`; `O` eliminado; etiquetas de
   intento en `N`.
2. Workspace intacto: `claude --resume` encuentra la conversación previa; `git config user.email`
   si había identidad.
3. Relay identificado: `GET /api/sessions/<sid>/conversations` → `capture.effective:true`; eventos
   en `.conversations/<sid>/`.
4. Un prompt en una pestaña ya abierta y otro en una nueva: entregados, sin "hook error".
5. `stop` → `start`: `effectiveAfterRestart:true` antes del start y `effective:true` después, sin
   PATCH ni recreación.
6. Deshabilitar (`PATCH {enabled:false}`): la ingesta rechaza al instante; marca y archivo retirados
   (≤ 1 s); `emissionStopsAfterRestart:true`.
7. Emergencia (`conversation:disable -- <sid>`) en una segunda pasada, con la misma verificación.
8. Durante 48 h: `rejected` solo esperados, `relayDropped = 0` fuera de pruebas, RSS del relay
   ≤ 20 MiB, sin "hook error".

**Criterio de salida:** todas las comprobaciones con evidencia adjunta, revisada por Work. Avanzar a
la etapa 3 (`CONVERSATION_ALLOW_USERS`) es una decisión aparte del responsable; recrear sesiones
existentes sigue bloqueado hasta que exista y se valide el procedimiento de recuperación
administrativa manual (D8).

## 8. Orden propuesto (pendiente de autorización)

1. **PR de correcciones:**
   - A1 y A2, con regresiones;
   - A3, A4, A5 (solo mover `failed` dentro del lock) y A6, si Work los acepta en el mismo PR;
   - A7 y A8 en la documentación;
   - C1–C3 en la redacción del contrato.
2. **PR de smokes:** los huecos de §5 que se pueden probar en el runner aislado.
3. **Dictamen integral de Work** sobre 1 y 2, y decisiones P-1 a P-3 del responsable.
4. **Despliegue coordinado:** etapas 0 y 1 (§6), con autorización expresa.
5. **Piloto (etapa 2, §7),** con autorización expresa.

## Anexo A. Trazabilidad de §10 "3.0d activación"

Estados:

- **V:** verificado, un test afirma el resultado.
- **P:** parcial, faltan subafirmaciones.
- **NV:** no verificado.
- **PIL:** solo verificable en el piloto.

Niveles:

- **U:** unitario o integración con fakes.
- **RD:** Docker real.
- **RC:** Docker real con el CLI real y un modelo simulado.

Rutas relativas a `backend/src/`, salvo los smokes. Siglas de los archivos:

- **E**: `recreate/engine.test.ts`
- **ER**: `recreate/engine.review.test.ts`
- **E2**: `recreate/engine.round2.test.ts`
- **CP**: `recreate/capturePort.test.ts`
- **CA**: `conversation/captureAuth.test.ts`
- **ACT**: `conversation/activation.test.ts`
- **RCA**: `routes.conversationAdmin.test.ts`
- **RLL**: `routes.lifecycleLock.test.ts`
- **RA**: `recreateAttempt.test.ts`
- **SMK**: `recreate/realDocker.smoke.ts`
- **CSM**: `session-image/conversation-smoke.sh`

| # | Criterio | Estado | Evidencia principal / lo que falta |
| --- | --- | --- | --- |
| 1 | Endpoint, allowlist y stats según §7; deshabilitar ≤ 1 s; stats sin títulos ni ids | V (U) | RCA PATCH/GET/POST/stats; `routes.create.test.ts` allowlist; `sessionManager.test.ts` INSERT. El limitador `adminActionIp` no se prueba |
| 2 | Lock en start/stop/kill/delete/recreate; esperan y actúan sobre el estado final; nunca se purga con `N` arrancando; `busy` | P (U) | RLL, E, RCA. Falta: delete soft concurrente; el `kill` del bootstrap; un borrado duro encolado tras una recreación |
| 3 | `start` de un contenedor existente no recrea ni escribe | V (U) | `dockerManager.conversation.test.ts` |
| 4 | Cada precondición con su código; clases de `docker diff`; `~/.gitconfig` | V (U+RD) | E, ER, `layer.test.ts`, `skills.test.ts`, SMK |
| 5 | `expectImageId`, tag movido, `.Image = imageId` | V (U+RD) | E, RCA, SMK, `dockerManager.conversation.test.ts` |
| 6 | Rollback resuelto con el estado previo idéntico; CAS con 0 filas | P (U+RD) | E (`stateOf`), `recreate/d1.test.ts`, SMK. Falta: las skills en `stateOf` para los pasos 1–3 |
| 7 | Rollback no resuelto ⇒ 500 `unresolved`, marca conservada, `capture` y preflight con `recreate-unresolved` | P (U) | E. Falta: `capture.pendingReasons` con `recreate-unresolved`; el estado final completo tras la resolución |
| 8 | Respuestas tardías (K1) | P (U) | E, CP. **NV:** postStart que sobrevive a `T_rec` |
| 9 | Concurrencia en `uncertain` (K1) | V (U) | RLL, E, RCA, CA, `service.test.ts`, `recreate/d1.test.ts`, E2 |
| 10 | Camino exitoso sin bloqueo circular (K1.3) | V (U+RD) | E, CP, SMK |
| 11 | El `N` confirmado nunca es sobrante (K1.1) | P (U+RD) | E, SMK. Falta: que la captura siga efectiva tras los ciclos |
| 12 | Evidencia y no tiempo (K1.2) | V (U) | E, `recreate/run.test.ts`, `dockerManager.capturePort.test.ts` |
| 13 | Reinicio con un intento `open`/`uncertain` (D8) | P (U) | E, ER, RA, RLL. Falta: las variantes "aplicado antes del reinicio" y "después de `T_d1`"; deshabilitar y emergencia tras el reinicio |
| 14 | Registro del intento | V (U) | RA, E, RCA |
| 15 | Paso 4 atómico | V (U) | `recreate/d1.test.ts` (forma de la sentencia) |
| 16 | `docker start` manual de `O` | V (U+RD) | E, SMK |
| 17 | Skills personalizadas (A2/P1) | P (U+RD+RC) | E, SMK, `skills.test.ts`, CSM. Falta: comparación byte a byte tras un POST bloqueado y tras recrear |
| 18 | Aplazamiento (A2/P2) | V (RD+U+RC) | SMK, CSM, E, ER |
| 19 | Eliminación incierta (A2/P2) | P (U) | E. Falta: que `N` no siembre y las skills byte a byte (y C2) |
| 20 | Precondición 7 | P (U) | E. Falta: `.npm-global` como symlink; `.claude.json` heredado |
| 21 | Topes con Docker que no responde | P (U) | E, ER, `sessionLifecycleLock.test.ts`, RLL. Falta: postStart colgado; probe colgado dentro del motor |
| 22 | Revisión #459 E1–E4 | P (U) | ER, CP, `dockerManager.capturePort.test.ts`. Falta: que el **registro** nombre la operación colgada |
| 23 | Segunda revisión (E1, E2, E5) | V (U) | E2 |
| 24 | E6 con el puerto real | V (U) | E2 |
| 25 | Las cuatro filas de `reconcile`; nombres reservados; rename con el canónico ocupado | P (U) | E. **NV:** la fila "ni `O` ni `N`" (`recreateOrphans`); "nombre canónico ocupado ⇒ incierto" |
| 26 | `PATCH {enabled:true}` ⇒ marca → relay ≤ 5 s → archivo; **con el CLI real**, prompts en pestaña abierta y nueva | P (U) | RCA, CA, ACT, CP. **NV:** la parte con el CLI real |
| 27 | Conservación durante el stop (K2) | P (U) | CA, `service.test.ts`, ACT. Falta: la revocación con el contenedor detenido en `reconcile`; el relay al boot en un contenedor real |
| 28 | Preparación del spawn (K2) | P (U) | ACT, `dockerManager.conversation.test.ts`. Falta: efectivo tras el boot; creación fallida + `reconcile` |
| 29 | Contenedor de 3.0c sin montaje de control (K3) | V (U+RD) | ACT, RCA, CA, SMK |
| 30 | Residuales; disable ×100 concurrente | V (U) | ACT, RCA, `service.test.ts`, CA. **El ×100 no comprueba D1 ni la marca: ver A1** |
| 31 | Compatibilidad de `/etc/st-control` con el CLI real | P (RC+U) | CSM con 2.1.308. **PIL:** el CLI del workspace del piloto |
| 32 | Correspondencia; suspendido restaurado; ambos NULL tras la emergencia | P (U) | ACT, CA. Falta: "ambos NULL nunca se reautorizan" (A1) |
| 33 | `effectiveAfterRestart` por condición | P (U) | CA, RCA, ACT. Falta: el "efectivo tras el start" de cada rama |
| 34 | Probe D7 | V (U) | CA, `dockerManager.capturePort.test.ts` |
| 35 | Smoke de recreación con el CLI real (hash, `--resume`, git, secreto, puerto, eventos; variantes) | P (RD) | SMK: relay, `effective`, `O` borrado, D1, `~/.bash_history`. **NV:** el resto (y C1) |
| 36 | (a) Relay no disponible ⇒ `effective:false`, 0 "hook error" | P (U) | RCA, CA, E2, `conversation/relay.test.ts`. **NV:** la parte con el CLI real |
| 37 | (b) Caída del relay | P | CA (U); CSM fase 6 (reinicio, `gap relay_restart`). Falta: la cota de 3 s; los "hook error" (hoy es una nota, no una comprobación) |
| 38 | Prueba manual documentada | PIL | — |
| 39 | DEPLOYMENT.md y session-image/README.md actualizados | Hecho (docs) | Con las salvedades de A3 y A7 |
