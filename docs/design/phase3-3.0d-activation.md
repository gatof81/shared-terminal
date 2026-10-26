# 3.0d — Activación progresiva: propuesta

Estado: **propuesta v3 para revisión (Work + responsable), no implementada.** Base: `main` en
`a836434` (3.0c + #448 + #450 mergeados; `CONVERSATION_ENABLED` desactivado; backend no
desplegado).

La v1 recomendaba recrear el contenedor automáticamente en `start`. La v2 incorporó las
decisiones D1–D6 del responsable, que siguen las recomendaciones de Work (§9). La v3 corrige los
hallazgos de Work sobre la v2 (A2, A3 y A4). §10 mantiene la trazabilidad original:

- A1 = pérdida de archivos;
- A2 = rollback y estado compartido;
- A3 = estado efectivo y `effectiveAfterRestart`;
- A4 = arranque del relay.

Las decisiones de base son:

- La recreación pasa a ser **administrativa, explícita y protegida**.
- Los datos de HOME y de la capa del contenedor se preservan de forma **estricta**: si algo se
  perdería, se bloquea.
- No hay recreación automática ni bypass destructivo.
- Se usa un **ID inmutable de imagen** de principio a fin.

Cuando se apruebe, los cambios de §8 pasan al contrato ([CONVERSATION.md](../CONVERSATION.md)) en
un PR de docs **antes** del código.

## 0. Resumen

- **`start` no cambia.** Ningún stop, start, idle sweeper ni reconcile recrea contenedores.
- **Activar la captura en una sesión con contenedor existente** se hace con una acción
  administrativa: `POST /api/admin/sessions/:id/recreate`.
- **Esa acción se rechaza** si la sesión está en marcha. También se rechaza si recrear perdería
  cualquier dato que no se pueda reconstruir de forma exacta, o si la imagen no es apta. **No hay
  forzado.**
- **La recreación tiene un punto de confirmación único:** un compare-and-set en D1 que cambia
  `container_id` **y** el hash del token en la misma sentencia.
  - Antes de ese punto, `N` no escribe nada en el workspace que `O` no escribiría igual al
    arrancar, y cualquier fallo vuelve exactamente al estado anterior.
  - Después, no hay vuelta atrás automática, ni hace falta.
- **El token del contenedor y el hash autorizado en D1 se comprueban siempre:** el `sha256` del
  token que el contenedor tiene en su env debe ser el hash de D1. Sin correspondencia no hay
  `effective:true` ni promesa tras un restart.
- **El relay arranca cuando la captura se autoriza, no solo al arrancar el contenedor.**
  Activarla en un contenedor en marcha no requiere otra recreación.
- **`effectiveAfterRestart` solo es `true`** si el siguiente `start` deja la captura efectiva sin
  recrear. Lo demás se informa con `requiresRecreate` y motivos explícitos.

## 1. Alcance

**Dentro:**

- El endpoint de recreación (§5).
- **Un lock por sesión en `start`, `stop`, `kill` y `delete` (soft y hard)**, que hoy no tienen
  ninguno. Sin él, el lock de `recreate` no protege de nada: un `DELETE ?hard=true` concurrente
  podría purgar el workspace mientras `N` arranca sobre él. Es un cambio en rutas existentes y va
  en el PR de implementación con sus tests de concurrencia (§5.7).
- `PATCH /api/admin/sessions/:id/conversation`.
- `CONVERSATION_ALLOW_USERS`.
- Las estadísticas de `GET /api/admin/stats → conversation`.
- La etiqueta de imagen y su verificación por ID.
- **Cambios en la imagen (entrypoint) necesarios para A2 y A4:**
  - siembra de skills diferible (§5.4);
  - relay que arranca cuando aparece la marca de autorización (§5.8).

  No alteran nada para un contenedor sin captura.
- La comprobación de correspondencia token ↔ hash en todo cálculo de `capture` y antes de
  escribir la marca o los hooks (§6.1).
- La detección de recreaciones interrumpidas en `reconcile` (§5.6).
- La semántica nueva de `capture` (§6).
- El plan por etapas (§7).
- Las correcciones de DEPLOYMENT.md (§8).

**Fuera:**

- La vista (3.1) y el composer (3.2).
- #444.
- La activación global.
- Actualizar en masa la imagen de los contenedores existentes.
- Cambios de comportamiento en `start`, `stop`, `kill` o el borrado, aparte del lock.
- Copiar datos de la capa del contenedor al contenedor nuevo (§11).
- UI para el owner.

## 2. Punto de partida (verificado en `29645bd`)

- **`startContainer`** (`backend/src/dockerManager.ts`):
  - Sin `container_id`, hace spawn (`prepareSpawn` incluido).
  - Con contenedor existente, hace `start()` del mismo contenedor, sin `prepareSpawn`.
  - Con id obsoleto, hace spawn.
  - No hay lock por sesión.
- **`spawnWithConfig`** hace, en este orden:
  1. `prepareSpawn`: hash de token a D1 y luego el archivo de hooks.
  2. `createContainer` con `Image: SESSION_IMAGE`, que es una **etiqueta** y no un ID.
  3. `start()`.
  4. `setContainerId`.
  5. Mapeos de puertos.

  Es un camino sin rollback: si algo falla después de `start()`, el contenedor queda corriendo sin
  que D1 lo apunte.
- **`captureStatus`** (`activation.ts`) calcula `effectiveAfterRestart = requested && !effective`.
  Es falso para un contenedor existente sin token, porque el siguiente start lo reutiliza.
  - Hoy no es alcanzable: no hay ruta que ponga `conversation_requested=1`.
- **El hash de token no siempre describe al contenedor.** Un spawn con el flag apagado no toca D1,
  así que puede quedar un hash de un contenedor anterior.
  - Es inocuo hoy, porque ese contenedor tampoco tiene el montaje.
  - Pero impide deducir "el contenedor tiene token" solo a partir de D1 (§6).
- **`prepareSpawnCapture`** escribe hooks y token aunque la imagen no tenga relay.
- **El entrypoint arranca el relay solo si al arrancar ya existen el token *y*
  `conversation.json`** (`entrypoint.sh`, bloque del relay). Consecuencias:
  - Escribir los hooks después de arrancar `N` dejaría hooks sin relay: "hook error" visible y
    nada capturado (A4).
  - Ya pasa en `main`, en la fila "habilitar con token" de CONVERSATION.md §2.4. Un contenedor que
    arrancó con la captura deshabilitada (token presente, archivo borrado) responde
    `effective:true` al rehabilitarse, sin relay. Es inalcanzable hoy (flag apagado, sin ruta de
    activación) y se corrige con §5.8.
- **El entrypoint escribe en el workspace compartido en cada arranque:**
  - **Skills:** `cp -r /opt/session-skills/. ~/.claude/skills/` sobrescribe, con el contenido de
    *esa* imagen, toda skill gestionada que el usuario haya personalizado bajo el mismo nombre.
  - **`.npm-global`:** lo siembra desde la imagen si la copia del workspace falta.
  - **Layout heredado:** migra `workspace/.claude` a `.st/claude-state`.

  Las tres dependen de la imagen (A2, §5.4).
- **El bootstrap** (gitIdentity → clone → dotfiles → agentSeed → postCreate) solo corre al crear la
  sesión.
  - `~/.gitconfig` y `~/dotfiles` viven en la **capa** del contenedor.
  - Cualquier recreación de hoy los pierde: id obsoleto, soft delete + start, o el procedimiento
    manual de DEPLOYMENT.md.

## 3. Qué conserva y qué pierde una recreación (A1)

| Estado | Dónde vive | Recreación |
| --- | --- | --- |
| Workspace; estado y transcripts del CLI (`--resume`); `~/.npm-global`, VS Code CLI, `gh`, `~/.ssh` | bind del workspace (directo o vía symlink del entrypoint) | Se conserva: **es el mismo directorio** (estado compartido, §5.4) |
| Uploads; fila de sesión y `session_configs`; historial de conversaciones | host y D1 | Se conserva |
| `~/.gitconfig` escrito por gitIdentity | capa | Reconstruible **solo** si su contenido es exactamente el que escribe gitIdentity (§5.2) |
| Cualquier otra cosa en la capa: `~/.bash_history`, `~/dotfiles` y lo que escribió su install, paquetes `apt`, archivos en `/tmp` del usuario, `/etc`, `/usr`, `/opt` | capa | **Se perdería ⇒ la recreación se rechaza** |
| Procesos y pestañas tmux | memoria | Ya se pierden con el stop; la recreación exige una sesión detenida |

Consecuencia esperada: con preservación estricta, **muchas sesiones usadas no serán recreables**.
`~/.bash_history` aparece en cuanto alguien abrió una pestaña. La respuesta del endpoint dice qué
categorías bloquean (§5.2), y el owner decide si mover o descartar esos datos por su cuenta. No hay
atajo. Para el piloto (§7) se elige una sesión que pase.

## 4. Decisión de vía (D1)

**Recreación administrativa explícita (opción B de la v1).** Se descartan:

- la recreación automática en `start` (opción A de la v1), porque cambia el ciclo de vida de todos
  los starts;
- el procedimiento manual con `docker rm` (opción C) como vía normal: queda como procedimiento de
  emergencia del operador, con las correcciones de §8.

## 5. `POST /api/admin/sessions/:id/recreate`

**Auth y límites:**

- `requireAuth` + `requireAdmin` + `adminActionIp`.
- Con un owner ajeno, escribe una fila `operate` en `session_observe_log` **antes** de tocar nada.
  Es fail-closed, como el start de #429.
- El cuerpo es `{ expectImageId: "sha256:…" }`, obligatorio. Es el ID que el admin vio en el
  preflight (§5.1). Si no coincide con el de ahora, responde 409 `image-changed` y no hace nada.

**`GET /api/admin/sessions/:id/recreate`:** preflight de solo lectura. Devuelve:

- `{ recreatable, blockers[], imageId, currentImageId, captureAfter }`;
- `blockers` lleva códigos y recuentos por categoría, nunca nombres de archivo;
- con el mismo cálculo exacto que usa el POST.

### 5.1 Precondiciones (todas, en este orden; la primera que falla responde 409 con su código)

1. **Lock por sesión** adquirido. Es un mapa en proceso; el backend es único. `start`, `stop`,
   `kill`, `delete` (soft y hard, incluida la purga del workspace) y `recreate` toman el mismo
   lock (§1). `recreate` no espera: si está ocupado, responde `busy`. Las otras cuatro esperan a
   que termine, como mucho **T_rec + T_rb = 6 min** (§5.3.1). Pasado ese tiempo responden 409
   `busy` y no hacen nada. Al obtener el lock actúan sobre el estado que dejó la recreación.
2. La sesión existe, su `status` no es `failed` ni `terminated`, y tiene `container_id`
   (`no-container`: el siguiente start ya crea uno nuevo, así que no hay nada que recrear).
3. `inspect(container_id)`: el contenedor existe y `State.Running === false`
   (`running`, `container-missing`).
4. **Imagen:**
   - `inspect(SESSION_IMAGE)` → `imageId`, que debe ser igual a `expectImageId` (`image-changed`).
   - La etiqueta `io.shared-terminal.conversation-relay="2"` debe estar **en ese ID**
     (`image-without-relay`). El valor `2` declara un entrypoint con la siembra de skills
     diferible (§5.4) y el relay que arranca con la marca de autorización (§5.8). La imagen de
     3.0c no tiene la etiqueta, así que no sirve.
   - Desde aquí, todo usa `imageId`, nunca la etiqueta del tag.
5. **Captura:** `CONVERSATION_ENABLED`, `conversation_requested=1`, sin marca de revocación
   (`flag-off`, `not-requested`, `revoked`).
   - Recrear sin captura pedida no es parte de 3.0d.
6. **Capa del contenedor** (§5.2): sin pérdidas (`layer-*`).
7. **Workspace** (§5.4), con `lstat` en el host, sin seguir symlinks:
   - `workspace/.npm-global` es un directorio real (`workspace-cli-missing`);
   - no hay layout heredado `workspace/.claude` pendiente de migrar (`workspace-legacy-layout`).

   Si no se cumplen, el entrypoint de `N` escribiría en el workspace contenido de su imagen antes
   de la confirmación.

### 5.2 Preservación estricta de la capa (A1; D2, D3)

`container.changes()` (`docker diff`) del contenedor detenido. Cada entrada se clasifica en una
de estas dos clases.

**Producida por el entrypoint, con forma exacta.** Se permite solo si coincide en tipo y destino:

- `~/.npm-global`, `~/.vscode-cli`, `~/.config/gh`, `~/.claude`, `~/.claude.json` y `~/.ssh`:
  symlinks a su destino exacto bajo el workspace;
- los directorios padre que el entrypoint crea (`~/.config`);
- `/tmp/.st-ready`;
- `/tmp/st-relay.log`;
- el socket de tmux `/tmp/tmux-<uid>/`.

Una entrada con la ruta correcta y otra forma bloquea: por ejemplo, un directorio real en lugar
del symlink. El entrypoint dejó estado en la capa porque su symlink falló.

**`~/.gitconfig`:** se lee del contenedor detenido con `getArchive`, ≤ 4 KiB. Se permite solo si
al parsearlo contiene **exactamente** `user.name` y `user.email`, iguales a los de
`session_configs`. Así lo deja gitIdentity. Con cualquier otra clave o valor, bloquea
`layer-gitconfig-modified`.

**Todo lo demás bloquea**, agrupado por categoría:

- `layer-home`: bajo `/home/developer`, fuera del workspace y fuera de lo anterior;
  `~/.bash_history` cuenta aquí;
- `layer-dotfiles`: si la sesión tiene dotfiles configurados, su clone y su install no se pueden
  reproducir exactamente;
- `layer-tmp`;
- `layer-system`: `/etc`, `/usr`, `/opt`, `/var`, …

Las rutas no se devuelven: `docker diff` de un usuario es contenido. Solo se registra el recuento
en el log.

**D3:** tras la recreación solo se rehace gitIdentity, cuando el archivo existía y pasó el chequeo.
Los dotfiles nunca se rehacen: una sesión con dotfiles queda bloqueada por `layer-dotfiles`.

### 5.3 Secuencia y punto de confirmación (A2)

Notación: `O` es el contenedor viejo, `N` el nuevo y `H` el hash del token nuevo.

1. **Preparar sin efectos visibles.**
   - Se genera el token y su hash `H`.
   - Se crea `N` con un **nombre temporal** (`st-<12>-new-<ts>`), `Image: imageId` y la
     configuración de spawn de siempre (env con el token, binds con el directorio gestionado, caps,
     red).
   - Se añaden las etiquetas `io.shared-terminal.session=<sid>` e
     `io.shared-terminal.recreate-of=<O>`.
   - Con `putArchive` se deja en la capa de `N` la marca `/tmp/.st-defer-skill-seed` (§5.4).
   - `N` no se arranca. D1, el directorio gestionado y el workspace quedan intactos.
2. **Renombrar.** `O` → `st-<12>-old-<ts>`, y `N` → `st-<12>` (el nombre canónico).
3. **Recomprobar `O` y arrancar `N`.**
   - **Primero**, `inspect(O)`: `State.Running` debe seguir en `false`. Si no (por ejemplo un
     `docker start` manual entre los pasos 2 y 3), rollback sin arrancar `N`.
   - `start()` de `N`.
   - El sentinel de readiness en ≤ 60 s y que `N` siga en marcha.
   - El entrypoint de `N`:
     - ve la marca y **no** siembra skills;
     - el supervisor del relay ve el token, pero no la marca de autorización (§5.8), así que
       espera sin arrancar el relay.
   - No hay hooks, ni postStart, ni ninguna escritura que dependa de la imagen (§5.4).
4. **Confirmar en D1 (punto de no retorno), en una sola sentencia:**

   ```sql
   UPDATE sessions
   SET container_id = :N, ingest_token_hash = :H, ingest_token_hash_suspended = NULL
   WHERE session_id = :sid AND container_id = :O
     AND conversation_requested = 1
   ```

   - El contenedor y el hash autorizado cambian juntos: no existe ningún instante en que D1 apunte
     a `N` con un hash que no sea el de su token (A3).
   - 0 filas (alguien cambió la fila: un hard delete, o un disable que puso `requested=0`) ⇒
     rollback.
   - D1 no responde ⇒ rollback, porque la sentencia no se aplicó.
   - Un timeout ambiguo se resuelve releyendo la fila: `container_id = N` significa que se aplicó.
     Si la relectura también falla, se trata como §5.6.
   - Con el tope vencido (§5.3.1) no se ejecuta.
5. **Autorizar el relay y escribir los hooks** (§5.8), en este orden:
   1. la marca `relay.enabled` en el directorio gestionado;
   2. esperar a que el relay de `N` escuche: `execCapture` de un probe de `/dev/tcp/127.0.0.1/47613`,
      ≤ 5 s;
   3. `conversation.json`.

   Si el relay no escucha en ese tiempo, se borra la marca y **no** se escribe el archivo:
   `effective:false` con `relay-not-listening`. No hay hooks sin relay ni "hook error". El hash
   sigue autorizado y corresponde al token. La reparación es `PATCH {enabled:true}` (§5.8), sin
   recrear.
6. **Completar.**
   - Siembra de skills diferida, con el mismo script que usa el entrypoint (§5.4).
   - Mapeos de puertos desde la config.
   - `status=running`.
   - gitIdentity si aplica (§5.2).
   - postStart.
   - `remove()` de `O`. Es seguro: §5.2 probó que su capa no tenía nada que perder y estuvo
     detenido todo el tiempo.

   Un fallo aquí se registra y no deshace nada: `N` es la sesión.

**Rollback (cualquier fallo en los pasos 1–4).** Cada paso es idempotente y se ejecuta incluso si
el anterior falló:

1. `stop` y `remove` de `N` si existe.
2. `O` vuelve a su nombre canónico si fue renombrado.

D1, el directorio gestionado y el workspace no necesitan restauración: antes del paso 4 no se
escribió nada en ellos. Lo único que `N` pudo escribir en el workspace son los `mkdir -p` que `O`
hace igual al arrancar (§5.4).

Estado final: idéntico al previo. `O` está detenido, con D1 apuntándolo, y sin cambios en la
captura ni en las skills. Respuesta: 500 `recreate-failed` con `{ step }`.

**Fallos después del paso 4.** No se vuelve a `O`. El hash ya corresponde a `N`, así que todo
estado intermedio se repara sin recrear:

- **Falta la marca o el archivo** (fallo de disco, caída entre 5.1 y 5.3):
  `pendingReasons: ["hooks-file-missing"]` o `["relay-not-listening"]`. Se repara de dos formas:
  - **inmediata:** `PATCH …/conversation {enabled:true}`. Si el token de `N` corresponde al hash
    de D1 (§6.1), reescribe la marca, espera al relay y escribe el archivo;
  - **automática:** el `reconcile` de 3.0b al arrancar el backend, ampliado con la marca y la
    misma comprobación de correspondencia.
- **Las skills no se sembraron** (paso 6): se siembran en el siguiente arranque de `N`, como
  cualquier arranque.

Nada de esto exige una segunda recreación, que §5.2 probablemente bloquearía, porque para entonces
`N` ya tiene `~/.bash_history`.

#### 5.3.1 Tope de tiempo

Una llamada a Docker sin tope (`create`, `start`, `inspect`, `changes`, `rename`) con el daemon
colgado retendría el lock hasta reiniciar el backend. Por eso hay dos topes:

- **Recreación: `T_rec` = 5 min**, desde el lock hasta el final del paso 6. Incluye la espera de
  readiness (≤ 60 s). Cada llamada a Docker corre contra el tiempo que le queda.
  - Si el tope vence antes del paso 4, se aborta y se pasa al rollback.
  - El tope no se aplica a la espera del paso 5.2, que tiene su propio tope de 5 s y no deshace
    nada.
  - El paso 4 comprueba el tope **justo antes** del compare-and-set: con el tope vencido no
    confirma. Así una recreación abortada nunca cambia D1.
  - Si vence después del paso 4, no se deshace nada (§5.3). Lo que quede del paso 6 se registra.
- **Rollback: `T_rb` = 60 s**, propio. Si tampoco termina (Docker sigue colgado), el lock se
  libera igual y la sesión queda marcada en memoria como "recreación interrumpida".
  - La siguiente operación de ciclo de vida sobre esa sesión (`start`, `stop`, `kill`, `delete`,
    `recreate`) aplica primero, bajo el lock, la misma resolución por estado de §5.6 y después
    actúa.
  - Si la resolución tampoco puede hablar con Docker, la operación responde 503
    `docker-unavailable` sin tocar D1 ni el workspace.
  - Por eso un `DELETE ?hard=true` nunca purga un workspace sobre el que `N` pudiera estar
    corriendo.
  - Si el backend se reinicia, la marca en memoria se pierde, pero `reconcile` hace la misma
    resolución al arrancar.

### 5.4 Estado compartido del workspace (A2)

`O` y `N` montan **el mismo** directorio de workspace. El estado del CLI, `~/.ssh`, `gh` y
`.npm-global` viven ahí. Reglas:

- **Nunca dos escritores.**
  - `O` está detenido desde la precondición 3 hasta su borrado.
  - El lock impide un `start` concurrente de la sesión.
  - Lo que no pasa por el backend no lo protege el lock, por ejemplo un `docker start` manual. Por
    eso el paso 3 vuelve a comprobar que `O` sigue detenido justo antes de arrancar `N`. Si no lo
    está, hace rollback.
- **Efectos de `N` en el workspace antes de la confirmación.** Regla: antes del paso 4, `N` no
  escribe en el workspace nada que `O` no escribiría **igual** al arrancar. Si no fuera así, un
  rollback dejaría a `O` con contenido de otra imagen. Revisión exhaustiva de `entrypoint.sh`:

  | Escritura del entrypoint | Depende de la imagen | Antes del paso 4 |
  | --- | --- | --- |
  | `mkdir -p` de `.st`, `.st/claude-state`, `.st/ssh`, `.vscode-cli`, `.config/gh`; `.st/.gitignore` si falta; `chmod 700` de `.st/ssh` | No | Se permite: `O` hace lo mismo en cada arranque. Tras un rollback quedan como estaban o como `O` las dejaría |
  | Rescate de `~/.claude`, `~/.claude.json` o `~/.ssh` de la capa al workspace | — | No ocurre: la capa de `N` es nueva |
  | **Skills:** `cp -r /opt/session-skills/. ~/.claude/skills/` | **Sí** (sobrescribe las skills gestionadas personalizadas con el contenido de la imagen de `N`) | **Diferida.** El entrypoint omite la siembra si existe `/tmp/.st-defer-skill-seed`, que el backend pone en la capa de `N` en el paso 1 y el entrypoint borra al verla. Así los arranques siguientes siembran como siempre. El backend la ejecuta en el paso 6 con `execCapture` del mismo script (`/opt/st/seed-skills.sh`, extraído del entrypoint sin cambiar su semántica) |
  | Siembra de `workspace/.npm-global` desde la imagen si falta | **Sí** | **No puede ocurrir:** la precondición 7 exige un directorio real |
  | Migración del layout heredado `workspace/.claude` a `.st/claude-state` | **Sí** (la imagen de `O` puede ser anterior a la migración) | **No puede ocurrir:** la precondición 7 la bloquea |

  Después del paso 4 la siembra de skills se comporta como cualquier arranque de hoy: sobrescribe
  las skills **gestionadas** con el contenido de la imagen vigente y nunca toca las demás. No es
  una pérdida que introduzca la recreación (`start` de `O` haría lo mismo con su imagen), y
  cambiar esa semántica queda fuera de 3.0d. El preflight sí informa `managedSkillsDiffer: n`:
  el número de skills gestionadas cuyo contenido en el workspace difiere del de la imagen.
  La lectura pasa por el opener de `workspaceFiles.ts`, con la prueba
  `/proc/self/fd`, nunca un `readFile` sobre una ruta del usuario. Comparar contenidos no expone
  ninguna ruta. Así el admin ve, antes de confirmar, que la siembra
  posterior a la confirmación las va a reemplazar.

  postStart, que es arbitrario, y gitIdentity corren **después** del paso 4, así que tampoco dejan
  efectos del usuario que deshacer.
- **El CLI vive en el workspace, no en la imagen.** `N` usa el `claude` de `workspace/.npm-global`,
  que puede ser anterior a 2.1.308.
  - El paso 6 ejecuta `claude --version` en `N` y lo devuelve como `cliVersion`.
  - Por debajo del mínimo devuelve el aviso `cli-below-minimum`. La captura queda activa, porque el
    backend sigue siendo la garantía, y la etapa 2 de §7 exige el mínimo.
  - No se actualiza el CLI automáticamente: es estado del usuario.
- **Conversaciones.**
  - El stop previo ya llevó las conversaciones a `container_down`.
  - Un `claude --resume` en `N` reanuda el mismo transcript del workspace; su `session_id` decide si
    se escribe en la misma conversación, y no se le asigna ninguna continuidad.
  - El relay de `N` es un proceso nuevo (generación 0). Lo que el relay de `O` no entregó se perdió
    con el stop, como hoy.

### 5.5 Consistencia de `container_id` en D1 (A2)

- **D1 apunta a `O` o a `N`, nunca a un contenedor inexistente:**
  - antes de la confirmación, `O` existe (renombrado o no);
  - después, `N` existe y está en marcha;
  - `O` se borra solo después de confirmar.
- **Las lecturas concurrentes** (attach WS, exec, git, files) resuelven el contenedor por el
  `container_id` de D1.
  - Antes de la confirmación ven `O` detenido y responden como a una sesión detenida, que es lo
    que es.
  - Después ven `N`.
  - El dispatcher de puertos resuelve por **nombre**. El nombre canónico pasa a `N` en el paso 2,
    pero el dispatcher solo encamina sesiones `running` y la sesión no lo es hasta el paso 6.
- **`reconcile`** usa el mismo `container_id`. Un `O` renombrado sigue siendo inspeccionable por id,
  porque renombrar no cambia el id.

### 5.6 Recreación interrumpida (caída del backend o de Docker)

`reconcile`, al arrancar, añade una pasada nueva:

1. `docker ps -a --filter label=io.shared-terminal.recreate-of`: los `N`, que llevan las
   etiquetas desde su creación.
2. `docker ps -a --filter name=-old-`, y de ese resultado **solo** los nombres que encajan
   exactamente con `^st-[0-9a-f]{12}-old-[0-9]+$` y cuyo prefijo de 12 caracteres corresponde a
   una sesión de D1.
   - `O` es un contenedor ya existente y no se le pueden añadir etiquetas; por eso se busca por
     nombre.
   - Los sufijos `-new-<ts>` y `-old-<ts>` sobre `st-<12>` quedan **reservados** para la
     recreación. Se documenta junto a `containerName`, y un test fija el formato.
   - Un nombre que no encaje no se toca nunca.

Para cada sesión afectada, decide con D1:

| D1 `container_id` | Estado encontrado | Acción |
| --- | --- | --- |
| `= O` (no se confirmó) | `N` existe | `stop` + `remove` de `N`; `O` vuelve a su nombre canónico. Es el mismo rollback de §5.3 |
| `= N` (se confirmó) | `O` existe | `remove` de `O`; mapeos y `status` según el estado real de `N`, como en cualquier reconcile; postStart no. El hash ya es el de `N` (paso 4, atómico), así que la marca y el archivo los converge el `reconcile` de captura (§5.8) si el token de `N` corresponde al hash (§6.1). La siembra de skills ocurre en el siguiente arranque de `N` |
| ni `O` ni `N` | — | No tocar nada; log de error y contador `recreateOrphans` en stats; operador |

Cada acción se registra en el log. Ninguna borra un contenedor que D1 apunte. Esto resuelve el
hallazgo del bot de revisión sobre la v1: el `reconcile` actual itera sobre filas de D1 y nunca
vería un contenedor renombrado.

### 5.7 Pruebas del endpoint

**Unitarias, con Docker y D1 simulados:**

- Cada precondición, con su código.
- Cada clase de `docker diff`, incluidas las formas incorrectas de los symlinks.
- `~/.gitconfig` exacto, con una clave extra y con otro email.
- Fallo inyectado en cada paso del 1 al 4 ⇒ estado final idéntico al previo: D1, nombres, hash,
  archivo, marca, mapeos y skills.
- Compare-and-set con 0 filas ⇒ rollback.
- Timeout ambiguo de D1.
- Fallo en el paso 5 ⇒ `N` se queda y converge.
- **Regresión A2 (skills):**
  1. una skill gestionada personalizada en el workspace;
  2. una imagen con contenido distinto para esa skill;
  3. un fallo inyectado antes del paso 4, en el 3 tras el readiness, y otro en el CAS.

  ⇒ El contenido original de la skill sigue byte a byte, y `O` queda como estaba. Variante con
  éxito: la siembra ocurre en el paso 6, nunca antes, y el preflight informó
  `managedSkillsDiffer: 1`.
- Precondición 7: `workspace/.npm-global` ausente o symlink, o layout heredado ⇒ bloqueado sin
  efectos.
- **Regresión A3 (correspondencia):** hash viejo en D1 y token nuevo en el contenedor, por
  ejemplo un spawn con flag apagado. Con el contenedor en marcha y con el contenedor detenido:
  - nunca `effective:true`;
  - nunca `effectiveAfterRestart:true`;
  - `token-mismatch` + `requiresRecreate:true`;
  - `PATCH {enabled:true}` no escribe ni la marca ni el archivo y no copia la huella a D1.

  Después de una recreación correcta, la correspondencia se cumple y es `effective:true`.
  Variantes: el hash suspendido igual a la huella se restaura; los dos NULL tras una revocación de
  emergencia nunca se vuelven a autorizar.
- Paso 4 atómico: en ningún instante observable `container_id = N` con un hash distinto al de `N`.
  Se prueba leyendo D1 entre cada llamada simulada.
- `expectImageId` distinto ⇒ 409 sin efectos.
- El tag se mueve entre el preflight y el POST ⇒ `image-changed`.
- `start`, `stop`, `kill` y `DELETE ?hard=true` concurrentes durante cada paso de la
  recreación ⇒ esperan el lock y actúan después sobre el estado final. Nunca se purga un
  workspace con `N` arrancando.
- `recreate` sobre una sesión con otra operación en curso ⇒ `busy`, sin efectos.
- `docker start` manual de `O` entre los pasos 2 y 3 ⇒ rollback sin arrancar `N`.
- Fallo al escribir el archivo tras la confirmación ⇒ `hooks-file-missing`; `PATCH
  {enabled:true}` lo repara sin recrear; `reconcile` también.
- Las tres filas de §5.6.
- Tope (§5.3.1), con Docker simulado que no responde:
  - en el paso 3 ⇒ aborta, no confirma, hace rollback;
  - con el rollback colgado ⇒ el lock se libera a los `T_rec + T_rb` y la marca queda;
  - el `DELETE ?hard=true` siguiente resuelve primero o responde 503, y nunca purga;
  - las operaciones en espera responden `busy` al vencer.
- Nombres que no encajan con el patrón reservado ⇒ no se tocan.

**Smoke de Docker con el CLI real:**

1. Sesión con repo, transcript reanudable, identidad git, un puerto y un secreto.
2. stop → preflight → POST.
3. Debe dar:
   - hash del workspace idéntico;
   - `claude --resume` encuentra la conversación;
   - `git config user.email` intacto;
   - secreto y puerto presentes;
   - `docker inspect N` → `.Image == imageId`;
   - relay escuchando, eventos en `.conversations/` y `capture.effective:true`;
   - `O` ya no existe.

- **A4 (relay sin recreación adicional):**
  1. un contenedor que arranca con token y **sin** archivo ni marca (deshabilitado por API antes
     del arranque);
  2. el relay no escucha;
  3. `PATCH {enabled:true}` ⇒ marca → listener en ≤ 5 s → archivo.
  4. Debe haber un prompt real en una pestaña ya abierta y una en una pestaña nueva, entregados al
     receptor, con `capture.effective:true`, ningún "hook error" y el mismo `container_id` (sin
     recreación).
- El paso 5 de la recreación sigue el mismo camino. Con el relay de `N` impedido (puerto
  ocupado), ⇒ `relay-not-listening`, sin archivo de hooks, sin "hook error", y se repara con
  `PATCH`.
- Medición: el CLI no lee `relay.enabled` como settings (§5.8).

Variantes:

- con `~/.bash_history` o un `apt-get install` ⇒ `recreatable:false` sin efectos;
- matar el backend entre los pasos 2 y 4 ⇒ `reconcile` deja `O` intacto;
- matarlo después del 4 ⇒ `reconcile` completa con `N`.

### 5.8 Arranque del relay (A4)

**Hoy** el entrypoint arranca el supervisor del relay solo si, en el momento del arranque, existen
el token y `conversation.json`. Un archivo escrito después nunca tiene relay. Afecta a dos
caminos:

- el paso 5 de la recreación;
- rehabilitar un contenedor que arrancó con la captura deshabilitada (§2).

**Cambio en la imagen** (etiqueta `conversation-relay="2"`):

- **Marca de autorización** `relay.enabled`, en el mismo directorio gestionado montado ro
  (`/etc/claude-code/managed-settings.d/`), **sin extensión `.json`**. La escribe el backend
  **solo** cuando el hash del token del contenedor está autorizado en D1.
  - **A verificar en el smoke:** el CLI 2.1.308 no la lee como settings. Si la leyera, se usaría
    un subdirectorio del mismo montaje. Que el CLI no recorre subdirectorios también hay que
    medirlo. La implementación decide con esas mediciones.
- **El supervisor arranca si hay token**, con o sin archivo, pero **no lanza el relay** hasta que
  existe `relay.enabled` o `conversation.json`.
  - Comprueba cada 0,5 s. Es un `[ -e ]` de bash, sin procesos nuevos.
  - Que también valga `conversation.json` mantiene compatibles los contenedores que el backend de
    3.0c creó con el archivo ya escrito.
  - Una vez lanzado, el relay sigue como hoy: reinicio con backoff, generación, muere con el
    contenedor.
  - Que desaparezca la marca no lo detiene: queda inerte, como ya documenta §2.4 para
    deshabilitar sin reiniciar.
- La condición 2 del responsable para el relay ("arranca solo cuando la captura es efectiva") se
  mantiene. El relay arranca cuando el backend autorizó el token, no por la mera presencia del
  token.

**Orden en el backend**, igual en el paso 5 de la recreación, en `PATCH {enabled:true}` con
contenedor en marcha y en `reconcile`:

1. el token del contenedor corresponde al hash de D1 (§6.1);
2. escribir la marca;
3. esperar el listener (probe por `execCapture`, ≤ 5 s);
4. `conversation.json`.

El archivo de hooks nunca existe sin un relay que escuche. Así ningún CLI ya abierto, que recarga
los settings en caliente (medido en 3.0c), dispara hooks contra un puerto cerrado.

**Spawn normal** (`prepareSpawn`, sesión nueva o `start` sin contenedor): escribe hash, marca y
archivo antes de crear el contenedor, como hoy. El relay arranca en el boot, como en 3.0c.

**Deshabilitar** no cambia: marca de revocación → D1 → borrado del archivo. La marca
`relay.enabled` se borra después del archivo, para que la de autorización nunca sobreviva a la
autorización. No hay recreación.

## 6. Semántica de `capture` (A3)

`GET /api/sessions/:id/conversations` y `PATCH …/conversation` devuelven:

```
capture: {
  requested, effective,
  effectiveAfterRestart,       // el siguiente `start` deja la captura efectiva sin recrear
  requiresRecreate,            // hace falta POST …/recreate (no promete que pase el preflight)
  pendingReasons: []           // flag-off | revoked | image-without-relay | running |
                               // container-without-capture | token-mismatch |
                               // hooks-file-missing | relay-not-listening |
                               // cli-below-minimum (aviso)
}
```

### 6.1 Correspondencia token ↔ hash

**Huella del contenedor:** `sha256` de `ST_INGEST_TOKEN` tal como aparece en `Config.Env` del
`inspect` del contenedor al que apunta D1.

- Se calcula en memoria y se compara en tiempo constante con `ingest_token_hash`.
- El token nunca se registra, nunca se devuelve y nunca se guarda.
- El `inspect` ya trae el env completo en otros caminos (`startContainer`), así que no aparece
  ningún dato nuevo en el proceso.
- Funciona igual con contenedores creados por el backend de 3.0c, sin etiquetas nuevas.

Estados:

| Contenedor | D1 | Correspondencia |
| --- | --- | --- |
| Sin token en el env | — | `container-without-capture` |
| Con token | `ingest_token_hash` = huella | **Sí** |
| Con token | `ingest_token_hash` NULL y `…_suspended` = huella | Suspendida (deshabilitado por API): `PATCH {enabled:true}` la restaura, como hoy |
| Con token | `ingest_token_hash` ≠ huella (hash viejo de otro contenedor, o un spawn con flag apagado que dejó el de antes, §2) | **`token-mismatch`** |
| Con token | ambos NULL (revocado por el comando de emergencia) | `revoked` mientras haya marca. Sin marca, `token-mismatch`: el token del contenedor no se vuelve a autorizar nunca |

Un `token-mismatch` **no** se repara copiando la huella a D1. Eso volvería a autorizar un token
que alguien desautorizó, o que nunca se autorizó para este contenedor. Solo lo resuelve un
contenedor nuevo: la recreación, o un spawn si el contenedor ya no existe.

### 6.2 Reglas

Se calculan con el `inspect` del contenedor de D1: una llamada a Docker, y nada se deduce solo de
D1.

- **`effective`**: requested ∧ ¬revoked ∧ `running` ∧ **correspondencia (§6.1)** ∧ marca
  `relay.enabled` ∧ `conversation.json` ∧ montaje gestionado en el contenedor.
- **`effectiveAfterRestart = true`** solo si se cumple `requested ∧ ¬revoked ∧ flag` y además una
  de estas:
  - el contenedor **no existe** (`container_id` NULL o inspect 404) y la imagen actual lleva
    `conversation-relay="2"`. El siguiente start hace spawn con un token nuevo y su hash;
  - el contenedor existe, está detenido, tiene montaje, **correspondencia**, y su propia imagen
    lleva `conversation-relay="2"`, o ya tiene la marca y el archivo escritos para el arranque. Un
    restart deja la captura efectiva.
- **En cualquier otro caso es `false`**, en particular con `token-mismatch` o
  `container-without-capture`. Ahí `requiresRecreate:true`.
- **`requiresRecreate`** nunca promete que la recreación vaya a pasar: §5.2 solo se evalúa en el
  preflight (`GET …/recreate`), porque requiere `docker diff`.
- **`PATCH {enabled:true}`** aplica §5.8 cuando hay correspondencia o una suspensión restaurable.
  Si no, responde `effective:false, effectiveAfterRestart:false, requiresRecreate:true` con su
  motivo. Nunca escribe la marca ni el archivo sin correspondencia.
- **Deshabilitar** no cambia: `emissionStopsAfterRestart:true` (PR #448), y nunca recrea.

## 7. Activación progresiva

Cada etapa se puede detener y revertir con `conversation:disable` o con el flag apagado. Avanzar
requiere autorización explícita del responsable.

| Etapa | Qué | Criterio para avanzar |
| --- | --- | --- |
| 0 | Desplegar backend 3.0d + imagen con etiqueta, **flag apagado** | Sesiones existentes sin cambios; `POST /ingest` → 204 `disabled`; `GET …/recreate` responde `flag-off` |
| 1 | `CONVERSATION_ENABLED=true`, nadie pedido | `reconcile` sin correcciones ni huérfanos |
| 2 | **Piloto:** una sesión del responsable, detenida, preflight `recreatable:true`, `cliVersion` ≥ 2.1.308. PATCH → preflight → POST | 48 h: eventos visibles; `rejected` solo esperados; `relayDropped=0` fuera de pruebas; RSS del relay ≤ 20 MiB; sin "hook error"; checklist de §3 verificado a mano |
| 3 | `CONVERSATION_ALLOW_USERS` = el responsable (sesiones **nuevas**, que no necesitan recrear) + 2–3 existentes que pasen el preflight | Una semana con los mismos criterios; disco de `.conversations` dentro de L7 |
| 4 | Ampliar la allowlist | Decisión aparte |

## 8. Cambios de contrato y documentación (PR de docs previo al código)

- **CONVERSATION.md:**
  - §2.4: tabla con las filas nuevas ("Recrear (admin)" y las de §6). Se corrige la fila
    "Habilitar corriendo con token", que hoy promete `effective:true` sin relay (§5.8), y se añade
    la correspondencia token ↔ hash como invariante (§6.1).
  - §2.6: el relay arranca con la marca de autorización (`relay.enabled`) o con el archivo. El
    backend escribe la marca, espera al listener y escribe el archivo (§5.8). Siembra de skills
    diferible (§5.4).
  - §2.1: `relay.enabled` en el directorio gestionado.
  - §2.4.1: el requisito se resuelve por la vía de §5.
  - §7: el endpoint, el preflight, `recreateOrphans` y los contadores.
  - §10 3.0d: las pruebas de §5.7.
- **DEPLOYMENT.md:**
  - "Recreating a session container" se reescribe sobre el endpoint. El procedimiento con
    `docker rm` queda como emergencia, con la advertencia de §3: hoy pierde la identidad git, los
    dotfiles y todo lo que haya en la capa.
  - "Rollout order": el paso 4 usa el endpoint.
- **session-image/README.md:** la marca de autorización, `/opt/st/seed-skills.sh`, la marca
  `/tmp/.st-defer-skill-seed` y la etiqueta `conversation-relay="2"`.
  - Las etapas de §7.
- **Fuera de 3.0d, señalado:** DEPLOYMENT.md:124 (#190, "stopped and started once so it re-joins")
  tiene el mismo error que R1 de 3.0c. Va en un PR aparte.

## 9. Decisiones (cerradas por el responsable con las recomendaciones de Work)

| | Decisión |
| --- | --- |
| D1 | Recreación **administrativa explícita** y protegida; `start` no cambia |
| D2 | Preservación **estricta** de HOME y de la capa: cualquier pérdida bloquea; sin lista de exclusiones fuera de lo que produce el entrypoint (§5.2) |
| D3 | Solo se reconstruye lo que se puede verificar como exacto (`~/.gitconfig` de gitIdentity); dotfiles bloquean |
| D4 | **Sin bypass destructivo**: no hay `force` ni `acknowledgeLayerLoss` |
| D5 | Nunca se recrea una sesión en marcha, ni automáticamente ni por el endpoint |
| D6 | **ID inmutable de imagen**: el preflight lo muestra, el POST lo exige (`expectImageId`), la etiqueta se comprueba en ese ID y `createContainer` lo usa |

## 10. Trazabilidad de los hallazgos de Work

| | Hallazgo | Corregido en | Dónde |
| --- | --- | --- | --- |
| **A1** | Pérdida de archivos: la recreación perdía lo que vive en la capa del contenedor (`~/.gitconfig`, dotfiles, `~/.bash_history`, `apt`, …) | v2 | §3, §5.2: preservación estricta; cualquier pérdida bloquea; solo se reconstruye un `~/.gitconfig` verificado como exacto |
| **A2** | Rollback y estado compartido | v2 + v3 | §5.3–§5.6 |
| **A3** | Estado efectivo y `effectiveAfterRestart` | v2 + v3 | §6 |
| **A4** | Arranque del relay con hooks escritos después de iniciar `N` | v3 | §5.8 |

**A2 (v2).**

- La v1 creaba `N` con `spawnWithConfig`, que arranca el contenedor y escribe hash y archivo sin
  rollback. La v2 introdujo:
  - un punto de no retorno único (compare-and-set de D1);
  - un rollback idempotente;
  - la recuperación por estado en `reconcile` (§5.6);
  - topes de tiempo (§5.3.1);
  - un solo escritor en el workspace (lock + recomprobación de `O`);
  - postStart y gitIdentity después de la confirmación.

**A2 (v3), sobre la v2 en `5803612`:**

- **Skills.** El entrypoint de `N` sobrescribía las skills gestionadas personalizadas antes del
  CAS, y el rollback no las restauraba. Ahora la siembra se difiere con una marca en la capa de
  `N` y se ejecuta en el paso 6 (§5.4). Va con su regresión (§5.7).
- **Revisión exhaustiva del entrypoint.** Las otras dos escrituras que dependen de la imagen
  (sembrar `.npm-global` y migrar el layout heredado) se bloquean con la precondición 7.
- **Hash atómico.** El hash del token pasa a cambiar en la **misma** sentencia que
  `container_id` (§5.3 paso 4). Antes del CAS no se escribe nada en D1 ni en el directorio
  gestionado.

**A3 (v2).** `effectiveAfterRestart:true` solo cuando el siguiente start produce la captura, se
calcula con `inspect` y se añaden `requiresRecreate` y `pendingReasons`.

**A3 (v3).** Se exige la correspondencia entre el token del contenedor y el hash autorizado
(§6.1):

- es parte de `effective` y de `effectiveAfterRestart`;
- es condición para escribir la marca o los hooks;
- `token-mismatch` nunca se repara copiando la huella;
- va con su regresión (hash viejo + token nuevo, §5.7).

**A4 (v3).** El supervisor arranca con el token y lanza el relay cuando aparece la marca de
autorización. El backend escribe la marca, espera al listener y solo entonces escribe
`conversation.json`. Esto sirve en la recreación y en `PATCH` sobre un contenedor en marcha, sin
recreación adicional. También corrige la fila de §2.4 que hoy promete `effective:true` sin relay.
Smoke en §5.7.

**Hallazgos del bot de revisión en GitHub** (no son de Work):

- v1:
  - la imagen sin relay en `requires-stop`;
  - el `reconcile` de huérfanos.
- v2:
  - la recomprobación de `O` en el paso 3;
  - la reparación tras la confirmación;
  - el lock en el alcance;
  - los topes de tiempo;
  - los nombres reservados.

Todos están incorporados.

## 11. Riesgos y preguntas abiertas

- **Pocas sesiones recreables.** Es la consecuencia buscada de D2. Si en la etapa 3 eso bloquea el
  avance, la vía sería una propuesta aparte de **traslado verificado** de rutas de HOME
  enumeradas, por ejemplo `~/.bash_history`, copiadas de `O` a `N` antes de la confirmación y
  comparadas byte a byte. No está en 3.0d.
- **Tiempo de la recreación:** `docker diff`, create, start y readiness (≤ 60 s), dentro de
  `T_rec` (§5.3.1). Se mide en el
  smoke. Es una acción administrativa, no un camino caliente.
- **Lock en proceso:** vale mientras haya un único backend, que es el despliegue actual. Varios
  backends exigirían un lock en D1.
- **La recreación toma la imagen vigente:** trae también cualquier otro cambio de imagen. El
  preflight muestra `imageId` y `currentImageId` para que el admin lo vea antes.
