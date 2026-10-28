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

**Dictamen de Work (sobre `6bfd302`): CHANGES REQUIRED.** A1 confirmado como P1; A2 confirmado,
con P1 recomendado por exposición involuntaria; A3 P2; C1–C3 a corregir; y un P2 nuevo en el
runbook (§6.1).

**Revisión de #469 en `d79e5e2`:** A2, A3, C1–C3 y el runbook, cerrados. Quedaban dos defectos de A1
(A1.1 y A1.2), corregidos en `86ee413`. **Revisión en `86ee413`:** quedaban dos P1 residuales
(A1.1a y A1.1b), corregidos en `79a3574`. **Work aprobó `79a3574`, y el responsable autorizó el
merge: #469 está mergeado en `main` como `d5faa1a`** (el mismo árbol). Quedan cerrados A1, A1.1,
A1.1a, A1.1b, A1.2, A2, A3 y C1–C3. Lo pendiente está clasificado en §9. A4–A8 siguen
separados de los bloqueantes, y #465–#467 son decisiones del responsable. La auditoría integral no se
cierra ni se avanza al piloto hasta el dictamen de Work.

**Estado al 2026-10-28:** A7 corregido en #470 (`a81ecc0`). A9 (§1), hallado por el smoke S1a,
corregido en #473 (`5d8bbff`, con GO de Work). La ampliación de smokes, #471, mergeada como
`dd1b941` (GO de Work sobre `1077873`, el mismo árbol) con la matriz completa en verde (§10).
**Dictamen integral de Work sobre `f053932`: CHANGES REQUIRED documentales.** GO técnico para las
etapas 0–1, condicionado al runbook (§6) y a una autorización posterior; **todavía no hay GO para
el piloto**. Hallazgos: **F1/P2**, la evidencia de bootstrap (corregida en §7, comprobación 3); **F2/P2**,
las garantías reales de D8 (corregidas en §12 y §4); e inconsistencias menores (migraciones hasta
v17, anexo A frente a la matriz de #471, NV obsoletos), corregidas en esta revisión. Se pide a Work
una revisión incremental de F1, F2 y la consistencia documental.

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
- **Corrección (#469).** La propuesta original ("comprobar y luego borrar") dejaba una carrera,
  como señaló Work. Lo implementado, sin poner la revocación detrás de ningún lock:
  - **D1:** `sessions.revocation_seq` (v17). Cada revocación lo incrementa en su sentencia, y la
    escritura del enable es un CAS sobre el valor leído al empezar.
  - **Marca (protocolo final, tras A1.1a/b):** `REVOKED` nunca se mueve ni se borra; los escritores
    solo lo reemplazan de forma atómica. El enable levanta la revocación que leyó publicando
    `LIFTED` = sha256 de los bytes exactos de ese `REVOKED`; una revocación está en efecto si
    `REVOKED` existe y no es la que nombra `LIFTED`. El lector lee `LIFTED` y después `REVOKED`, y
    falla cerrado ante cualquier error de lectura. Tras publicar, el enable relee: una revocación
    más nueva se reaplica en D1 y el enable responde 409. (La primera versión, con `rename` y
    `link`, se sustituyó en `79a3574`: ver A1.1 y A1.1a/b.)
  - **Orden inverso:** deshabilitar y la emergencia reafirman su marca al terminar.
  - **Regresiones** (`captureAuth.test.ts`, `revocationRetire.test.ts`):
    - cinco ventanas × {CLI, API, `--all`} × {rehabilitar, primera vez}, deterministas. Comprueban
      `requested`, los dos hashes, la revocación, el siguiente spawn sin token, y que no quedan
      archivo de hooks ni `relay.enabled`;
    - una carrera ×100 con tiempos aleatorios. Desde #469 comprueba el estado final en D1
      (`requested=0`, hash NULL), la revocación (`session`) y el siguiente spawn sin token. No
      comprueba los archivos: eso lo afirman los casos deterministas.

### A1.1 / P1 — retirar la marca dejaba la sesión sin revocación visible (hallado en #469, `d79e5e2`)

- **Qué:** el retiro apartaba `REVOKED` con un nombre único antes de comparar. Si la marca era de
  una emergencia más nueva, quedaba invisible para el receptor hasta el `link`. Con la caché de
  autorización poblada, Work reprodujo que el servicio real aceptaba y persistía un evento.
- **Corrección (#469 `86ee413`):**
  - la marca se aparta con el nombre fijo `REVOKED.retiring`, que `checkRevocation` cuenta como
    revocación, así que en todo instante existe uno de los dos nombres;
  - un retiro interrumpido deja ese nombre (fail-closed), y el siguiente enable lo devuelve a
    `REVOKED` antes de nada (`recoverRetiring`).
- **Regresiones:** con el receptor real, la caché poblada y el CLI como otro proceso: pausa tras el
  `rename` (directo y a través del enable), interrupción y recuperación.

### A1.1a / P1 y A1.1b / P1 — residuales de la corrección de A1.1 (hallados en #469, `86ee413`)

- **A1.1a:** el receptor comprobaba `REVOKED` y `REVOKED.retiring` con dos `stat` separados; un
  `rename` entre ambos los hacía ver ausentes los dos, en cualquiera de los dos sentidos.
- **A1.1b:** la recuperación hacía "comprobar y después renombrar", y podía sustituir la marca de
  una emergencia concurrente por la anterior.
- **Reproducidos en rojo sobre `86ee413`,** de forma determinista y con operaciones de archivo
  reales: los dos sentidos de A1.1a (`accepted:true`, evento persistido) y A1.1b (la marca final
  era la de la API, no la de la emergencia).
- **Corrección (#469 `79a3574`):** se cambia el protocolo.
  - `REVOKED` no se mueve ni se borra nunca, y no hay paso de recuperación.
  - Levantar la revocación es publicar `LIFTED` con el sha256 de la marca exacta.
  - Una revocación más nueva tiene otros bytes, así que sigue en vigor diga lo que diga `LIFTED`.
  - El receptor lee `LIFTED` y después `REVOKED`, y responde revocado ante cualquier error de
    lectura (fail-closed).
- **Pruebas:**
  - una entrega de sondeo tras cada operación de archivo del levantamiento y de un enable en
    carrera;
  - el lector pausado entre sus dos lecturas, en ambos sentidos;
  - la emergencia antes y justo después de publicar `LIFTED`, comprobando el contenido y el `id`
    de su marca, D1 y `revocation_seq`, el resultado del enable, el siguiente spawn y que la
    ingesta no se reabre;
  - el fallo al publicar, y la lectura ilegible.

  Mutaciones: el orden de lectura invertido y la falta de relectura hacen fallar las pruebas.

### A1.2 / P2 — reaplicar el disable de la API destruía el hash suspendido (hallado en #469, `d79e5e2`)

- **Qué:** `suspendIngestToken` reemplazaba el hash suspendido por el activo, que ya era NULL. El
  enable posterior respondía `token-mismatch` y pedía recrear.
- **Corrección (#469 `86ee413`):** `COALESCE(ingest_token_hash, ingest_token_hash_suspended)`. La
  suspensión es idempotente, y tras la emergencia o `--all` los dos hashes siguen NULL.
- **Regresiones:** suspensión aplicada dos veces; carrera entre un re-enable y un disable de la API,
  y después un enable efectivo sin recrear. Los casos API de las ventanas comprueban ahora el hash
  suspendido.

### A2 / P1 (Work) — el paso 6 escribe los puertos leídos en las precondiciones y pisa un `PATCH /ports` concurrente

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
- **Corrección (#469).** Releer no bastaba: el `PATCH` podía entrar entre la lectura y la
  escritura. `PATCH /ports` toma ahora el lock de ciclo de vida (op `ports`, modo `wait`), y la
  recreación y cada pasada de resolución lo tienen desde la lectura hasta la escritura de los
  mapeos. Con el intento sin resolver, la puerta del lock lo rechaza. Hay regresiones de ruta y de
  motor: retirado y público→privado, durante el arranque y entre la última lectura y la aplicación;
  la configuración y el dispatcher coinciden al terminar.

### A3 / P2 (documentación) — DEPLOYMENT.md manda actualizar el CLI, y eso bloquea el piloto

- **Dónde:** `docs/DEPLOYMENT.md`, paso 2 del orden de despliegue: "check `claude --version`
  ≥ 2.1.308 … (`claude update` in the session)".
- **Qué:** la allowlist aprobada es **exactamente** {2.1.308}. Seguir ese paso, o que el CLI se
  autoactualice al usarlo, deja la sesión piloto con `control-marker-incompatible`.
- **Corrección (#469):** 2.1.308 exacta, sin `claude update` y con `DISABLE_AUTOUPDATER=1` en la
  sesión piloto. El smoke de la imagen comprueba **estáticamente** que el CLI fijado conoce la
  variable. Que no haya actualización solo se observa con el tiempo, así que el piloto compara la
  versión antes y después (§7).

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

### A9 / bloqueante del piloto (hallado por el smoke S1a de #471) — una sesión en la que se usó el CLI no es recreable

- **Qué:** basta un `claude -p` en `O` para que el CLI 2.1.308 deje en la capa `/tmp/cc-socks/` y
  `/tmp/claude-1000/…`; la allowlist exacta de §2.7.1 bloquea con `layer-tmp`. Evidencia: el
  `docker diff` real de CI (runs 40593988271 y 40595716788 de #471). Además, el CLI **interactivo**
  escribe en HOME, en su primer turno (no al arrancar ni con `-p`),
  `~/.local/share/applications/claude-code-url-handler.desktop` (290 bytes, texto fijo del CLI),
  que bloquea con `layer-home`.
- **Impacto:** fail-closed, sin efectos ni pérdida de datos; pero el piloto de §7 (usar el CLI,
  recrear, `claude --resume`) no podía completarse, y ninguna sesión usada sería recreable.
- **Decisión del responsable (2026-10-27):** ampliar la allowlist solo a los artefactos de runtime
  verificados del CLI 2.1.308, con forma y tipo exactos, sin comodines amplios y fail-closed ante lo
  desconocido.
- **Decisión del responsable (2026-10-28), opción 1 para HOME:** excepción mínima solo para
  `~/.local`, `~/.local/share`, `~/.local/share/applications` (directorios) y ese `.desktop` (archivo
  regular, 290 bytes, idéntico byte a byte al texto fijado, sha256 `b186d2bd…`). Todo lo demás en
  HOME sigue bloqueando (D2/D3); sin cambios en entrypoint, montajes ni persistencia de HOME, y nada
  se copia de `O` a `N`.
- **Corrección: #473, mergeado como `5d8bbff`** (Work GO sobre `739f5f4`, el mismo árbol; CI de
  `main` verde). Evidencia `cli-tmp-evidence.sh` (casos A–F: contenido idéntico en todos los
  contenedores, sin datos del usuario ni valores dinámicos; un contenedor nuevo y `N` lo reescriben
  igual); `layer.ts` (60 tests de capa con mutantes, un test del motor); §2.7.1; smoke con Docker
  real (5 variantes bloqueantes en `/tmp`, 6 en `~/.local`). El P3 de Work sobre el script de
  evidencia (observaciones frente a aserciones, código de salida) es el seguimiento #474.
- **Verificado en #471** (run 40709156468, sobre `main` con #473): S1a en verde, ver §10.

## 2. Inconsistencias del contrato (redacción; corregidas en #469)

- **C1:** §10, smoke "Recreación correcta": "el backend muerto … después del 4 ⇒ completa con `N`"
  contradice D8 y la fila A2/P2 del mismo §10 ("Caída entre el CAS y 6.1 ⇒ … `recreate-unresolved`").
  El código sigue D8. Igualmente, "muerto entre los pasos 2 y 4 ⇒ `O` intacto": tras el reinicio `O`
  queda renombrado `-old-<ts>` y la sesión bloqueada (D8), sin vuelta automática.
- **C2:** §10 "Eliminación incierta": "con la eliminación confirmada en el siguiente `reconcile`".
  Tras un reinicio nada la confirma (D8); solo la pasada de resolución del proceso dueño del intento.
- **C3:** §2.7.5 dice que una incompatibilidad bloquea con `control-marker-incompatible` también en
  `PATCH {enabled:true}`. La frase es condicional ("Si falla") y la validación pasó, pero el `PATCH`
  no tiene esa comprobación (relacionado con la decisión P-2).

## 3. Decisiones del responsable (aprobadas el 2026-10-27, sin implementar)

Aprobadas como decisiones del responsable, sin implementación inmediata. Se registraron en cada issue.
La implementación va separada y se completa **antes de la etapa 3**, salvo que Work identifique un
bloqueo del piloto que exija adelantar alguna.

- **#465:** auditoría **fail-closed** del `PATCH {enabled:true}` sobre la sesión de otro usuario; el
  disable no se bloquea por fallos de auditoría.
- **#466:** la allowlist de versiones del CLI se aplica también al `PATCH {enabled:true}`.
- **#467:** se impide la recreación con un bootstrap en vuelo, exigiendo **evidencia positiva** de
  que terminó.

Planteamiento original:

- **P-1. Auditoría del `PATCH` sobre la sesión de otro usuario (#465).** El contrato no la exige.
  Recomendación de Work: auditar la habilitación ajena de forma fail-closed; para deshabilitar, un
  fallo de auditoría no debe impedir el corte.
- **P-2. Allowlist del CLI aplicada al `PATCH {enabled:true}` (#466).** La decisión aprobada limita la
  recreación. Extenderla al `PATCH` requiere otra decisión explícita (Work no la exigiría).
- **P-3 (nueva, de A5, #467).** Si la recreación debe bloquear con un bootstrap en curso, con un código de
  precondición nuevo.

## 4. Restricciones operativas aceptadas

- **D8 fail-closed.** Un intento interrumpido queda `recreate-unresolved` y nada lo resuelve tras
  reiniciar: queda bloqueado indefinidamente, sin resolución heurística por espera (§12). El piloto es solo una sesión nueva y descartable. No se recrean sesiones reales hasta
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
- **Docker real + CLI real 2.1.308 con modelo simulado, ampliación de #471
  (`recreateAudit.smoke.ts`, §10):** CLI interactivo en `O` y `--resume` en `N` (S1a); recreación
  con workspace, Git, secreto, puertos y dispatcher real (S1); SIGKILL real del backend en los dos
  cortes (S2); relay no disponible y `kill -9` con la cota de 3 s (S3, S4, Phase 12); stop/start
  (S5); `PATCH` con pestaña abierta y nueva (S6); revocación con el CLI de emergencia (S7);
  `apt-get install` sin efectos (S8). **D1 está simulado** en todos (un JSON por sesión), igual que el
  modelo, el D1 del CLI de emergencia y la ruta `PATCH` con su lock.
- **Huecos reales que quedan** (detalle en el anexo A; ninguno se declara cubierto):
  - la fila "ni `O` ni `N`" (`recreateOrphans`) y "nombre canónico ocupado ⇒ incierto";
  - postStart que sobrevive a `T_rec` o colgado;
  - variantes de reinicio "aplicado antes del reinicio" y "después de `T_d1`", y deshabilitar o la
    emergencia tras un reinicio;
  - la ausencia de efectos tardíos tras un SIGKILL (§12: no demostrable);
  - "ambos hashes NULL tras la emergencia nunca se reautorizan";
  - skills byte a byte tras un POST bloqueado y tras una recreación correcta (tras una interrumpida
    sí: S2);
  - el receptor rechazando una petición real tras la emergencia (#475);
  - con D1 real, el modelo real, la ruta HTTP real y el CLI del workspace del piloto: solo en el
    piloto (PIL).

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
   contenedores de sesión no se tocan. Las migraciones pendientes (hasta v17, `sessions.revocation_seq`) son aditivas.
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

**Límite del rollback de backend.** Un backend anterior a 3.0d no conoce el registro de intento ni
la puerta `recreate-unresolved`: con un intento sin resolver, `start`, `stop` y el borrado duro
actuarían sobre la sesión piloto.

- **Con un intento sin resolver no se hace rollback de backend.** Tras un reinicio, D8 impide
  resolverlo automáticamente, y el borrado duro también queda bloqueado (`recreate-unresolved`),
  así que **no hay salida disponible**. Se detiene el procedimiento y se mantiene desplegado el
  backend 3.0d, compatible con D8: la sesión queda bloqueada y el resto sigue funcionando.
  Deshabilitar y el comando de emergencia siguen disponibles.
- Se espera al procedimiento de recuperación administrativa manual, cuando exista y esté validado.
  Ni el borrado duro ni la intervención a mano en Docker o D1 se presentan como salida.
- Un rollback a 3.0c y vuelta a 3.0d dejaría sin captura (sin montaje de control) a las sesiones
  creadas en medio con captura. Hoy no existen, porque 3.0b y 3.0c nunca se desplegaron con el flag
  encendido.

### 6.2 Etapa 1 — flag encendido, nadie solicitado

1. `CONVERSATION_ENABLED=true` en `.env`; `docker compose up -d` (compose ya reenvía la variable,
   #464).
2. Verificar: `reconcile` sin correcciones ni huérfanos; `enabledSessions = 0`; ningún archivo de
   hooks ni marca; ingest de un token desconocido rechazado y contado.

**Rollback:** quitar la variable y `docker compose up -d`; `reconcile` retira cualquier archivo.

### 6.3 Etapa 2 — piloto aislado (D8)

Ver §7. Requiere autorización explícita y se acepta que la sesión piloto pueda quedar bloqueada en
`recreate-unresolved`.

**Antes del piloto:** #469 tiene que estar aprobado y mergeado. Con él, el corte de la emergencia
es persistente y continuamente observable: la marca no se mueve ni se borra (A1.1a/b).

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

**Sesión:** nueva, creada para el piloto por el responsable, sin repositorio ni datos reales,
**sin ningún disparador de bootstrap** (comprobación 3), **sin** estar en `CONVERSATION_ALLOW_USERS`
(nace sin token ni montajes); se usa lo mínimo para tener un transcript (una sesión interactiva corta)
y se detiene.

**Comprobaciones previas:**

1. `claude --version` en la sesión = **exactamente 2.1.308** (allowlist; cualquier otra versión
   bloquea con `control-marker-incompatible`).
   - **No** ejecutar `claude update`.
   - Crear la sesión piloto con `DISABLE_AUTOUPDATER=1` en sus variables de entorno. El smoke de la
     imagen comprueba estáticamente que 2.1.308 conoce la variable.
   - Anotar la versión al crearla y volver a comprobarla justo antes del `POST`.
   - Una sesión cuyo CLI se actualizó ya no es recreable hasta validar esa versión. El propio
     entorno de desarrollo de esta auditoría pasó solo a 2.1.311: el riesgo es real.
2. `PATCH /api/admin/sessions/<sid>/conversation {"enabled":true}` → `requested:true`,
   `effective:false`, `requiresRecreate:true` (`container-without-capture`).
3. **Sesión sin bootstrap** (precondición del piloto inicial; F1 de Work). El piloto inicial **no
   admite ninguna sesión con bootstrap**: no hay hoy evidencia terminal positiva de que un bootstrap
   terminó bien, así que el piloto exige que no exista ninguno.
   - **Por qué `running` + `bootstrap-log` no prueban nada.** Contraejemplo de Work: con un
     `postCreate` que falla, `finishWithFail` (`bootstrap.ts`) persiste el log **antes** de
     `failSession`, que es quien marca `failed` y mata el contenedor. Entre una cosa y otra la sesión
     muestra `status:"running"` con un `log` no nulo, y el teardown aún no terminó. Ni un log no nulo
     ni `running` (ni los dos juntos) prueban que el bootstrap acabó, ni que acabó bien. Además
     `persistLog` es best-effort: un `log: null` tampoco prueba que no hubo bootstrap.
   - **Qué dispara el bootstrap** (`routes/sessions.ts`, `POST /api/sessions`, `hasBootstrapConfig`
     y `postCreateCmd`): `repo`, `gitIdentity`, `dotfiles`, `agentSeed`, `writeEnvFile: true`, un
     `ports[]` con `readiness`, o `postCreateCmd`. Cualquiera lanza `runAsyncBootstrap` y la respuesta
     lleva `bootstrapping: true`. Fuera del bootstrap, `postStartCmd` lanza un daemon en cada arranque
     del contenedor (también en `N`): tampoco se admite. El bootstrap solo se lanza en ese create; ni
     `start` ni la recreación lo repiten.
   - **Configuración del piloto:** el create lleva solo `name` y las variables de entorno simples que
     necesita el piloto (`DISABLE_AUTOUPDATER=1`, de tipo no secreto); **ningún** campo de los
     anteriores, ni `postStartCmd`, ni `writeEnvFile`, ni puertos con `readiness`.
   - **Evidencia que se registra**, antes de usar la sesión:
     - el cuerpo exacto del `POST /api/sessions` enviado;
     - de la respuesta 201: `sessionId`, `createdAt`, y que **no** incluye `bootstrapping`
       (`bootstrapping: true` ⇒ esa sesión no se usa para el piloto);
     - la configuración efectiva en D1, por consulta de solo lectura:
       `SELECT * FROM session_configs WHERE session_id = '<sid>'`. Con la configuración mínima de
       arriba la fila no existe, o solo lleva `env_vars_json` y, si acaso, límites; `repos_json`,
       `git_identity_json`, `dotfiles_json`, `agent_seed_json`, `post_create_cmd` y
       `post_start_cmd` son NULL, `write_env_file` no es 1, `ports_json` no tiene ninguna entrada
       con `readiness`, y `bootstrapped_at` es NULL. Se anota la fila completa (no lleva valores
       secretos: no se configura ninguno);
     - `GET /api/sessions/<sid>` → `status:"running"` y `runtimeReady:true` (estado de la sesión,
       no prueba de bootstrap).

   Si falta cualquiera de esas evidencias, o alguna muestra un disparador, la sesión no se usa: se
   crea otra. Una variante futura del piloto **con** bootstrap queda fuera de esta corrección y exigirá
   evidencia terminal positiva del éxito de la ejecución actual (lo que #467 tendrá que definir).
4. `GET …/recreate` → `recreatable:true`, `blockers:[]`, `captureAfter:true`; anotar
   `currentImageId`.

**Recreación:** `POST …/recreate {"expectImageId":"<currentImageId>"}`. **Mientras dure está
prohibido editar los recursos de la sesión** (`PATCH /admin/sessions/:id/resources`; A6, restricción
del responsable que se mantiene).

- Éxito esperado: `200 committed`, sin `unresolved`; `capture.effective:true`.
- Si responde `unresolved:true` o 500 `{unresolved:true}`: **parar el piloto**, sin reintentar y
  sin intervenir a mano (tampoco con un borrado duro, que queda bloqueado).
  - Recoger los logs (`[recreate]`) y el registro `.st-control/<sid>/recreate-attempt.json`
    para Work.
  - La sesión puede quedar bloqueada (D8) hasta que exista un procedimiento manual validado.
  - No hacer rollback del backend (§6.1).

**Verificación (checklist):**

1. `docker inspect st-<sid12> --format '{{.Image}}'` = `currentImageId`; `O` eliminado; etiquetas de
   intento en `N`.
2. Workspace intacto: `claude --resume` encuentra la conversación previa. (En el piloto no hay
   identidad git configurada: `gitIdentity` es una etapa de bootstrap, comprobación 3.)
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

1. **PR de correcciones: #469**, mergeado como `d5faa1a`. A4–A8 van aparte (§9).
2. **PR de documentación de A7** y **PR de smokes** (§10), cada uno con revisión de Work.
3. **Dictamen integral de Work** sobre 1 y 2. Las decisiones P-1 a P-3 (#465–#467) están aprobadas
   (§3); su implementación va aparte, antes de la etapa 3.
4. **Despliegue coordinado:** etapas 0 y 1 (§6), con autorización expresa.
5. **Piloto (etapa 2, §7),** con autorización expresa.

## 9. Estado tras #469 y clasificación de lo pendiente

Criterio: lo que puede afectar al piloto **tal como está aprobado** (§7: una sesión nueva y
descartable, creada por el responsable, así que sin usuario ajeno; recreada una vez; CLI fijado en
2.1.308) bloquea el piloto. Lo que solo aparece al ampliar (etapa 3, `CONVERSATION_ALLOW_USERS`,
sesiones de otros usuarios, recrear sesiones existentes) es un seguimiento posterior, que se cierra
antes de esa etapa. Ninguno se implementa sin revisión y autorización.

| Pendiente | ¿Bloquea el piloto? | Por qué | Cuándo |
| --- | --- | --- | --- |
| A9 — una sesión que usó el CLI no es recreable (`layer-tmp`, `layer-home`) | **Sí** | El piloto de §7 usa el CLI y recrea; sin la corrección, la recreación queda bloqueada | **Corregido:** #473 (`5d8bbff`); S1a de #471 en verde (run 40709156468, `dd1b941`) |
| A7 — DEPLOYMENT.md desactualizado (sección de conversación en términos de 3.0c, rollback solo hasta 3.0b, pérdidas del procedimiento de emergencia) | **Sí** | Es el documento que se sigue al desplegar; con texto obsoleto el operador podría actuar mal en las etapas 0 a 2 | **Corregido:** #470 (`a81ecc0`) |
| Ampliación de smokes (§10) | **Sí** | Work: los huecos de smoke se cierran con evidencia antes del piloto, y lo que corre en CI no espera al despliegue | **Cerrada:** #471 (`dd1b941`), matriz completa en verde (§10) |
| A4 — `PATH` con el directorio del usuario primero | No | Solo afecta a la propia sesión del usuario; en el piloto, el usuario es el responsable, en una sesión descartable | Antes de la etapa 3 (sesiones de otros usuarios) |
| A5 — `failSession` fuera del lock | No, con una precondición verificable del piloto: una sesión **sin ningún disparador de bootstrap** (§7, comprobación 3) | Sin bootstrap no hay `failSession` que pueda correr durante la recreación | Antes de la etapa 3; mover la escritura dentro del lock es una corrección aislada |
| A6 — `PATCH /resources` sin lock | No, con una restricción operativa que se mantiene: prohibido editar recursos durante la recreación | Solo actúa si un admin edita los límites mientras recrea | Antes de recrear fuera del piloto |
| A8 — redacción (identificación del relay, `sleep` del supervisor) | No | Documentación y un proceso por cada 0,5 s sin marca; no afecta a la captura | Seguimiento |
| #465 — auditoría fail-closed del `PATCH` enable sobre la sesión de otro usuario (**aprobada**) | No | En el piloto el admin es el dueño: no hay sesión ajena | Implementación aparte, antes de la etapa 3 |
| #466 — allowlist del CLI en `PATCH {enabled:true}` (**aprobada**) | No, si el piloto mantiene el CLI en 2.1.308 (`DISABLE_AUTOUPDATER=1`, comprobado antes y después) | La recreación ya lo comprueba. Fuera del piloto, un CLI autoactualizado seguiría capturando por `PATCH` o por spawn (etapa 3) sin validar | Implementación aparte, antes de la etapa 3 |
| #467 — impedir la recreación con un bootstrap en vuelo, con evidencia positiva de fin (**aprobada**) | No, con la precondición verificable del piloto: sesión sin bootstrap (§7, comprobación 3) | El mismo motivo que A5. Un piloto **con** bootstrap queda excluido hasta #467 | Implementación aparte, antes de la etapa 3 |
| #463 — fallo aislado de tests del motor (dos apariciones, sin reproducir) | No bloquea por sí mismo; se mantiene abierto | Sin diagnóstico, no se le atribuye causa. En cada nueva aparición se conservan stdout, stderr, el código de salida y el contexto completo (SHA, comando, número de ejecución, entorno) | Abierto |

## 10. Ampliación de smokes (implementada en #471, mergeada como `dd1b941`)

**Resultado verificado:** #471 sobre `main` `5d8bbff` (con #473), head `1077873` aprobado por Work y
mergeado como `dd1b941` (mismo árbol), run de Session Image
**40709156468 en verde**: 110 comprobaciones en 10 escenarios (`recreation audit smoke: all ok`),
más `recreation smoke: all ok` (#473), `CONVERSATION SMOKE TEST PASSED` (Phase 12) y
`SMOKE TEST PASSED`. El run anterior (40706623966, `79ab63b`) falló en una comprobación de S8 por una
carrera de lectura del propio harness: `listContainers` decía `running` justo después de que
`docker stop` hubiera vuelto (dockerd despierta al `stop` antes de actualizar la réplica que lee el
listado; `daemon/monitor.go`), mientras el `inspect` del motor ya lo veía detenido. Se corrigió en el
harness (estados por `inspect`), y el log completo se conserva en ese run.

**Qué es real y qué es simulado.** Real: dockerd del runner, la imagen (entrypoint, relay,
supervisor), el CLI 2.1.308 (interactivo en tmux, `-p` y `--resume`), el motor y la autoridad de
captura, `docker diff` y lecturas de archivo, el receptor de ingesta, el dispatcher con
`http-proxy` y DNS de Docker, el CLI de emergencia en otro proceso y un proceso backend aparte matado
con SIGKILL. Simulado: **D1** (un JSON por sesión, leído también por la SQL real de
`lookupDispatchTarget`), el **modelo** (`mock-anthropic.mjs`), las sentencias D1 del CLI de emergencia
(un stub: el corte lo prueba la marca que el receptor lee en cada evento) y la ruta `PATCH` con su
lock (cubiertas por los tests de `routes.conversationAdmin`; S6 usa la autoridad directamente).

| Escenario | Plan (abajo) | Resultado | Comprobado |
| --- | --- | --- | --- |
| S1a — CLI interactivo en `O` (turno simple, Bash, subagente, `/exit`), recreación, `claude --resume` en `N` | 1 | ok (15) | `O` recreable con los artefactos del CLI en la capa; `N` sin `/tmp/cc-socks`, `/tmp/claude-1000` ni `~/.local`; transcripts del padre y del subagente con mismos nombres, tamaños y mtimes (sin leerlos); `.env`, clave SSH, estado del CLI y repo Git con mismos hashes, modos, HEAD y status; identidad Git reaplicada; `--resume` en la misma conversación y el modelo recibió el turno de `O` |
| S1 — recreación completa con workspace, Git, secreto y puertos | 1 | ok (17) | datos idénticos, secreto por hash, mapeos = puertos declarados; dispatcher: público 200, privado 401 sin cookie, 403 con otro usuario, 200 con el dueño, 404 no declarado; captura efectiva e ingesta persistida |
| S2-rename / S2-commit — SIGKILL real del backend entre los pasos 2 y 4, y tras el CAS (D8) | 3 | ok (12) / ok (12) | `uncertain` + `orphanedAt` tras el reinicio; start/stop/delete 409 `recreate-unresolved`; D1 en `O` / en `N`; `O` no eliminado; nada se resuelve |
| S3 — relay no disponible en el paso 5 | 4 | ok (9) | comprometido sin resolver, `authorize` pendiente, sin archivo de hooks ni marca; al liberar el puerto converge y queda `resolved` |
| S4 — `kill -9` del relay | 5 | ok (5) | primera consulta `relay-unavailable`; efectivo de nuevo **≤ 3 s absolutos desde el kill** (1274 ms); marca y archivo intactos |
| S5 — stop/start de `N` | — | ok (6) | marca y archivo conservados, `effectiveAfterRestart`; efectivo tras el start sin `PATCH` ni recreación |
| S6 — `PATCH {enabled:true}` con una pestaña abierta y una nueva | 6 | ok (10) | ambas completan el turno con 0 "hook error"; el prompt de la nueva se persiste |
| S7 — revocación con el CLI de emergencia real | 7 | ok (13) | nada aceptado tras el CLI; siguiente start sin token nuevo ni relay; preflight `revoked`, POST 409 sin contenedor |
| S8 — paquete instalado en la capa de `O` | 2 | ok (11) | preflight y POST `layer-system`, sin efectos: sin hook de auditoría ni registro, D1 idéntico byte a byte, mismos contenedores y estados, archivos y datos sin cambios |
| Phase 12a/12b (`conversation-smoke.sh`) | 4, 5 | PASSED | relay no disponible: 0 "hook error", 0 peticiones; relay matado: identificado de nuevo en 1150 ms, errores acotados, 0 en el turno siguiente |

**Plan original:**

Se dividen por dónde pueden correr. Lo de CI corre en el runner aislado (workflow `Session Image`),
sin tocar la VM.

**En CI, con Docker real y el CLI real 2.1.308 con modelo simulado**, antes del despliegue:

1. **Recreación completa con datos.** El hash del workspace es idéntico antes y después, y en `N`
   están intactos `git config user.email` (con `gitIdentity`), un secreto (variable de entorno) y un
   puerto declarado (el mapeo y la configuración coinciden). `claude --resume` sigue listando la
   conversación previa.
2. **Variantes que bloquean sin efectos:** `apt-get install` en la capa ⇒ `layer-system`, y un
   `POST` sin efectos (estado idéntico), no solo el preflight.
3. **Backend matado entre los pasos 2 y 4, y después del 4,** con el resultado de D8: la sesión
   queda `recreate-unresolved`, D1 sigue en `O` (o pasa a `N`), y nada se resuelve tras el
   reinicio.
4. **Relay no disponible con el CLI real:** el puerto ocupado antes del boot, la marca o el archivo
   retirados y el hash cambiado ⇒ `effective:false` con su motivo, sin archivo de hooks y con 0
   "hook error" (hoy es una nota, no una comprobación).
5. **`kill -9` del relay:** la primera consulta da `relay-unavailable`, `effective:true` vuelve en
   ≤ 3 s, los "hook error" quedan acotados y hay 0 en el turno siguiente.
6. **`PATCH {enabled:true}` sobre un contenedor en marcha con el CLI real:** un prompt en una pestaña
   ya abierta y otro en una nueva, sin "hook error".
7. **Revocación de extremo a extremo con el receptor real:** `conversation:disable` corta la
   ingesta de un contenedor real y el siguiente start no regenera token.

**En tests unitarios o de integración** (sin Docker), donde el anexo A marca huecos: la fila "ni `O`
ni `N`" (`recreateOrphans`), postStart que sobrevive a `T_rec`, las variantes de reinicio ("aplicado
antes del reinicio" y "después de `T_d1`"), y las skills comparadas byte a byte tras bloquear o
recrear.

**Solo en el piloto** (sesión y modelo reales): la prueba manual documentada (eventos reales en
`GET …/conversations` y en el archivo, corte inmediato), la validación con el CLI del workspace del
piloto, y los criterios de 48 h de §7.

## 11. Criterios para cerrar la auditoría integral

1. #469 mergeado, con E1–E6, A1–A3 y C1–C3 cerrados. **Hecho:** `d5faa1a`.
2. A7 corregido (PR de documentación revisado por Work). **Hecho:** #470, `a81ecc0`.
2b. A9 corregido (#473) con GO de Work, y la matriz completa de #471 en verde sobre una base que lo
    incluya (S1a incluido). **Hecho:** #473 (`5d8bbff`) y #471 (`dd1b941`).
3. Los smokes de §10 en CI, con evidencia verde y revisados por Work. **Hecho:** #471, GO de Work.
4. Cada pendiente de §9 con decisión o plan aceptado por Work y el responsable, y las restricciones
   operativas del piloto escritas en §7.
5. Dictamen integral GO de Work sobre este documento.

**Comprobaciones de cierre que el responsable pide a Work** (no son hallazgos nuevos):

- **Bootstrap terminado (§7, comprobación 3):** verificar que el `bootstrap-log` corresponde a la
  ejecución actual de la sesión y que no puede confundirse con la evidencia de un bootstrap
  anterior. *Resultado (F1 de Work):* el `bootstrap-log` no sirve como prueba de fin; el piloto
  inicial exige una sesión sin bootstrap (§7, comprobación 3).
- **Muerte real del backend (smoke S2 de #471):** además de que el intento quede `uncertain` tras el
  reinicio, verificar que ningún proceso de la ejecución anterior sigue produciendo efectos que el
  backend nuevo desconozca. *Resultado (F2 de Work):* no puede demostrarse; lo que sí garantiza D8 está
  en §12.

Con eso se podría pedir autorización para las etapas 0 y 1 (§6). El piloto (etapa 2) requiere
además una autorización propia.

## 12. Resumen para el dictamen integral final

Base: `main` en `dd1b941`. Lo que se pidió a Work: **GO / CHANGES REQUIRED de 3.0d**, y en concreto si
queda algún bloqueante para el **despliegue coordinado** (etapas 0 y 1, §6) y para el **piloto
descartable** (etapa 2, §7). Dictamen sobre `f053932`: CHANGES REQUIRED documentales (F1, F2,
consistencia); GO técnico para las etapas 0–1 condicionado al runbook y a autorización posterior; sin
GO todavía para el piloto. Esta revisión corrige F1 (§7, comprobación 3), F2 (abajo y §4) y la
consistencia (§5, §6.1, anexo A), sin cambios en el motor ni en los smokes, para revisión incremental
de Work. Nada de esto autoriza por sí mismo el despliegue ni el piloto.

**Cerrado.**

- Defectos A1, A1.1, A1.1a, A1.1b, A1.2, A2, A3 y contrato C1–C3: #469 (`d5faa1a`).
- **A7** (DEPLOYMENT.md): #470 (`a81ecc0`).
- **A9** (CLI usado ⇒ no recreable): #473 (`5d8bbff`). Excepción exacta en `/tmp` y en HOME solo para
  `~/.local{,/share,/share/applications}` y el `.desktop` de 290 bytes fijado (§1, A9).
- **Smokes** (§10): #471 (`dd1b941`), **110 comprobaciones en 10 escenarios** en verde (run
  40709156468), más `recreation smoke` (#473) y Phase 12.

**Límites de lo simulado** (§10): D1 es un archivo JSON por sesión; el modelo es
`mock-anthropic.mjs`; las sentencias D1 del CLI de emergencia van a un stub; la ruta `PATCH` y su lock
solo los cubren tests unitarios. Quedan para el piloto: D1 real, el modelo real, la ruta HTTP real
y el CLI del workspace del piloto (anexo A, filas marcadas **PIL**).

**D8 ante SIGKILL: qué garantiza y qué no** (comprobación de cierre del responsable; F2 de Work):

- **Lo que prueba S2** (los dos cortes, con SIGKILL real de un proceso backend aparte): la muerte del
  proceso (se afirma la señal) y el **bloqueo posterior**: el proceso nuevo deja el intento
  `uncertain` + `orphanedAt`, la sesión rechaza start/stop/delete con `recreate-unresolved`, la pasada
  de arranque deja el `-old-` tal cual, `O` no se elimina y nada se resuelve.
- **Lo que S2 no prueba:** la **ausencia de efectos tardíos** en el tiempo. No hay observación
  prolongada, y no se puede afirmar que ningún efecto de la ejecución anterior aparezca después.
- **Por qué no puede afirmarse:**
  - un SIGKILL del backend no cancela necesariamente las peticiones que **Docker o D1 ya
    recibieron**: dockerd termina un create, un rename, un start o un remove ya enviado;
  - una **sentencia enviada por HTTP a D1** (Cloudflare) puede completarse aunque el backend haya
    muerto antes de leer la respuesta, incluido el CAS del paso 4;
  - los **timeouts de exec** (`timeout -k 2 <s>` de `recreateExec` dentro del contenedor) acotan
    el proceso del exec, pero **no prueban que todas las operaciones remotas hayan terminado**: no
    cubren peticiones ya aceptadas por dockerd ni por D1, ni lo que el exec haya lanzado fuera de
    su grupo.
- **Lo que D8 garantiza:** la operación queda `unresolved` y la sesión **bloqueada indefinidamente**
  para todo verbo del ciclo de vida, **sin resolución heurística por espera**: nada la resuelve tras
  un reinicio, pase el tiempo que pase. Ningún efecto tardío lo interpreta el backend nuevo como
  resolución. La deshabilitación y la emergencia siguen funcionando (no pasan por la puerta).
- **Ante un resultado ambiguo** (`unresolved`, 500 `{unresolved:true}` o un reinicio del backend
  durante el intento) **no está autorizado** reiniciar, recuperar a mano ni recrear sesiones reales
  fuera del procedimiento aprobado: se para y se reporta (§7). El procedimiento de recuperación
  manual no existe todavía; tendrá que observar el estado real de Docker y D1 y tiene su propia
  autorización.

**Bootstrap** (comprobación de cierre del responsable; F1 de Work): el `bootstrap-log` y `running`
no prueban que un bootstrap terminó (contraejemplo del `postCreate` fallido, §7 comprobación 3). El
piloto inicial exige una sesión nueva **sin disparadores de bootstrap**, comprobada con el cuerpo del
create, la respuesta sin `bootstrapping`, `sessionId` + `createdAt` y la fila de `session_configs`.

**Restricciones operativas que se mantienen** (no bloquean el piloto tal como está aprobado, §9):

- A4 (`PATH`): solo afecta a la propia sesión; el piloto es del responsable.
- A5 (`failSession` fuera del lock): el piloto inicial usa una sesión sin bootstrap.
- A6 (`PATCH /resources` sin lock): prohibido editar recursos durante la recreación.
- A8: redacción; seguimiento.
- D8 fail-closed; CLI fijado en 2.1.308 (`DISABLE_AUTOUPDATER=1`, comprobado antes y después); un
  solo backend; solo una sesión nueva y descartable.

**Decisiones aprobadas, implementación antes de la etapa 3:** #465 (auditoría fail-closed del
enable ajeno), #466 (allowlist del CLI en el `PATCH`), #467 (bloquear la recreación con un bootstrap
en vuelo, con evidencia positiva).

**Seguimientos independientes, no bloqueantes:** #463 (fallo aislado de tests del motor, abierto,
sin causa atribuida), #472 (documentación), #474 (P3: aserciones y código de salida del script de
evidencia), #475 (P3: S7 con una petición real rechazada por revocación y su mutación).

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
- **AUD**: `recreate/recreateAudit.smoke.ts` (#471; escenarios S1a–S8, D1 simulado)
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
| 13 | Reinicio con un intento `open`/`uncertain` (D8) | P (U+RD) | E, ER, RA, RLL; AUD S2 (SIGKILL real en los dos cortes: `uncertain`, bloqueo, nada se resuelve). Falta: las variantes "aplicado antes del reinicio" y "después de `T_d1`"; deshabilitar y emergencia tras el reinicio; la ausencia de efectos tardíos no es demostrable (§12) |
| 14 | Registro del intento | V (U) | RA, E, RCA |
| 15 | Paso 4 atómico | V (U) | `recreate/d1.test.ts` (forma de la sentencia) |
| 16 | `docker start` manual de `O` | V (U+RD) | E, SMK |
| 17 | Skills personalizadas (A2/P1) | P (U+RD+RC) | E, SMK, `skills.test.ts`, CSM; AUD S2 (byte a byte tras una recreación interrumpida). Falta: byte a byte tras un POST bloqueado y tras recrear |
| 18 | Aplazamiento (A2/P2) | V (RD+U+RC) | SMK, CSM, E, ER |
| 19 | Eliminación incierta (A2/P2) | P (U) | E. Falta: que `N` no siembre y las skills byte a byte (y C2) |
| 20 | Precondición 7 | P (U) | E. Falta: `.npm-global` como symlink; `.claude.json` heredado |
| 21 | Topes con Docker que no responde | P (U) | E, ER, `sessionLifecycleLock.test.ts`, RLL. Falta: postStart colgado; probe colgado dentro del motor |
| 22 | Revisión #459 E1–E4 | P (U) | ER, CP, `dockerManager.capturePort.test.ts`. Falta: que el **registro** nombre la operación colgada |
| 23 | Segunda revisión (E1, E2, E5) | V (U) | E2 |
| 24 | E6 con el puerto real | V (U) | E2 |
| 25 | Las cuatro filas de `reconcile`; nombres reservados; rename con el canónico ocupado | P (U) | E. **NV:** la fila "ni `O` ni `N`" (`recreateOrphans`); "nombre canónico ocupado ⇒ incierto" |
| 26 | `PATCH {enabled:true}` ⇒ marca → relay ≤ 5 s → archivo; **con el CLI real**, prompts en pestaña abierta y nueva | P (U+RC) | RCA, CA, ACT, CP; AUD S6 (CLI real, pestaña abierta y nueva, 0 "hook error"). Falta: la ruta HTTP y su lock con el CLI real (S6 llama a la autoridad; D1 simulado) |
| 27 | Conservación durante el stop (K2) | P (U+RC) | CA, `service.test.ts`, ACT; AUD S5 (marca y archivo conservados, relay al boot en un contenedor real). Falta: la revocación con el contenedor detenido en `reconcile` |
| 28 | Preparación del spawn (K2) | P (U) | ACT, `dockerManager.conversation.test.ts`. Falta: efectivo tras el boot; creación fallida + `reconcile` |
| 29 | Contenedor de 3.0c sin montaje de control (K3) | V (U+RD) | ACT, RCA, CA, SMK |
| 30 | Residuales; disable ×100 concurrente | V (U) | ACT, RCA, `service.test.ts`, CA. Desde #469 el ×100 comprueba D1 (`requested`, hash), la revocación y el siguiente spawn sin token; los archivos los comprueban las ventanas deterministas de A1 |
| 31 | Compatibilidad de `/etc/st-control` con el CLI real | P (RC+U) | CSM con 2.1.308. **PIL:** el CLI del workspace del piloto |
| 32 | Correspondencia; suspendido restaurado; ambos NULL tras la emergencia | P (U) | ACT, CA. Falta: "ambos NULL nunca se reautorizan" (A1) |
| 33 | `effectiveAfterRestart` por condición | P (U+RC) | CA, RCA, ACT; AUD S5 (rama de conservación: efectivo tras el start). Falta: el "efectivo tras el start" de las demás ramas |
| 34 | Probe D7 | V (U) | CA, `dockerManager.capturePort.test.ts` |
| 35 | Smoke de recreación con el CLI real (hash, `--resume`, git, secreto, puerto, eventos; variantes) | V (RC), D1 simulado | SMK; AUD S1a (CLI interactivo, `--resume` con continuidad, transcripts por metadatos, preservación por huellas), S1 (hash, git, secreto, puertos, dispatcher, eventos), S2, S8 (variantes). C1 corregido en #469. **PIL:** con D1 real |
| 36 | (a) Relay no disponible ⇒ `effective:false`, 0 "hook error" | V (U+RC) | RCA, CA, E2, `conversation/relay.test.ts`; AUD S3; CSM Phase 12a (0 "hook error", 0 peticiones) |
| 37 | (b) Caída del relay | V (U+RC) | CA; CSM fase 6 y Phase 12b; AUD S4: cota de 3 s absoluta desde el kill (1274 ms) y "hook error" acotados, 0 en el turno siguiente |
| 38 | Prueba manual documentada | PIL | — |
| 39 | DEPLOYMENT.md y session-image/README.md actualizados | Hecho (docs) | Con las salvedades de A3 y A7 |
