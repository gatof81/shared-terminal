# 3.0d — Activación progresiva: propuesta

Estado: **v5 aprobada (Work y el responsable, `ac1024d`, 2026-10-26), no implementada. D7
decidido: probe fresco.** Lo vinculante está en [CONVERSATION.md §2.7](../CONVERSATION.md); este
documento conserva el razonamiento, y si difieren, manda el contrato. Base: `main` en
`a836434` (3.0c + #448 + #450 mergeados; `CONVERSATION_ENABLED` desactivado; backend no
desplegado).

La v1 recomendaba recrear el contenedor automáticamente en `start`. La v2 incorporó las
decisiones D1–D6 del responsable, que siguen las recomendaciones de Work (§9). La v3 corrige los
hallazgos de Work sobre la v2 (A2, A3 y A4), la v4 los de Work sobre la v3 (`c9174d9`) y la v5 los de Work sobre la v4 (`870218e`). §10
mantiene la trazabilidad original:

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
    arrancar, y cualquier fallo vuelve exactamente al estado anterior. Si Docker no confirma la
    eliminación de `N`, el estado queda incierto y lo resuelve §5.6.
  - Después, no hay vuelta atrás automática, ni hace falta.
- **El token del contenedor y el hash autorizado en D1 se comprueban siempre:** el `sha256` del
  token que el contenedor tiene en su env debe ser el hash de D1. Sin correspondencia no hay
  `effective:true` ni promesa tras un restart.
- **El relay arranca cuando la captura se autoriza por completo, no solo al arrancar el
  contenedor.** Activarla en un contenedor en marcha no requiere otra recreación.
  - Las marcas viven en un directorio de control del host, fuera de los settings del CLI.
  - `effective` exige que el relay se haya identificado.
- **Las skills personalizadas se conservan byte a byte, o la recreación se bloquea.**
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
- **Cambios en la imagen (entrypoint y relay) necesarios para A2, A3 y A4:**
  - siembra de skills diferible mientras exista la marca de control (§5.4);
  - relay que arranca cuando aparece la marca de autorización (§5.8.2);
  - `GET /st-relay/status` para identificarlo.
- **El directorio de control** `<WORKSPACE_ROOT>/.st-control/<sid>/`, montado ro en
  `/etc/st-control` en los contenedores con captura (§5.8.1).

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
     (`image-without-relay`). El valor `2` declara:
     - un entrypoint con la siembra de skills diferible (§5.4);
     - el relay que arranca con la marca de autorización y se identifica (§5.8.2);
     - `/opt/st/seed-skills.sh`. La imagen de
     3.0c no tiene la etiqueta, así que no sirve.
   - Desde aquí, todo usa `imageId`, nunca la etiqueta del tag.
5. **Captura:** `CONVERSATION_ENABLED`, `conversation_requested=1`, sin marca de revocación
   (`flag-off`, `not-requested`, `revoked`).
   - Recrear sin captura pedida no es parte de 3.0d.
6. **Capa del contenedor** (§5.2): sin pérdidas (`layer-*`).
7. **Workspace, `.npm-global` y layout** (§5.4), con `lstat` en el host, sin seguir symlinks:
   - `workspace/.npm-global` es un directorio real (`workspace-cli-missing`);
   - no hay layout heredado `workspace/.claude` pendiente de migrar (`workspace-legacy-layout`).

   Si no se cumplen, el entrypoint de `N` escribiría en el workspace contenido de su imagen antes
   de la confirmación.
8. **Skills gestionadas** (§5.4): ninguna personalizada ni en colisión
   (`managed-skills-customized`, `managed-skills-collision`). Se evalúa en el preflight contra la
   imagen de `O` y se repite en el paso 1 contra la de `N`.

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

Notación:

- `O`: el contenedor viejo.
- `N`: el contenedor nuevo.
- `H`: el hash del token nuevo.
- **Directorio de control:** `<WORKSPACE_ROOT>/.st-control/<sid>/`. Está en el host, fuera del
  workspace y fuera del directorio de settings del CLI, y se monta ro en `/etc/st-control` (§5.8).

1. **Preparar sin efectos visibles.**
   - Se genera el token y su hash `H`.
   - En el directorio de control:
     - se escribe `defer-skill-seed` (§5.4);
     - se borra `relay.enabled` si quedara.
     `O` no monta ese directorio, porque se crea en 3.0d y `O` no tiene captura, así que nada de
     esto afecta a `O`.
   - Del directorio gestionado se borra `conversation.json` si quedara. Un hash viejo en D1 pudo
     hacer que `reconcile` de 3.0b lo escribiera, y `O` tampoco lo monta.
   - Se crea `N` con un **nombre temporal** (`st-<12>-new-<ts>`), `Image: imageId` y la
     configuración de spawn de siempre: env con el token, binds con el directorio gestionado y el
     de control (ambos ro), caps y red.
   - Se añaden las etiquetas `io.shared-terminal.session=<sid>` e
     `io.shared-terminal.recreate-of=<O>`.
   - Con `N` creado y **sin arrancar**, `getArchive(N, /opt/session-skills)` da las skills de la
     imagen de `N`. Se repite la comprobación de skills de la precondición 8 contra ellas (§5.4);
     si bloquea, rollback.
   - `N` no se arranca. D1 y el workspace quedan intactos.
2. **Renombrar.** `O` → `st-<12>-old-<ts>`, y `N` → `st-<12>` (el nombre canónico).
3. **Recomprobar `O` y arrancar `N`.**
   - **Primero**, `inspect(O)`: `State.Running` debe seguir en `false`. Si no (por ejemplo un
     `docker start` manual entre los pasos 2 y 3), rollback sin arrancar `N`.
   - `start()` de `N`.
   - El sentinel de readiness en ≤ 60 s y que `N` siga en marcha.
   - El entrypoint de `N`:
     - ve `/etc/st-control/defer-skill-seed` y **no** siembra skills, en este arranque y en
       cualquier otro mientras la marca exista: un reinicio de `N` antes del paso 4, o un
       `docker restart` (§5.4);
     - el supervisor del relay ve el token, pero no `relay.enabled`, así que espera sin arrancar
       el relay (§5.8).
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
   - D1 responde con error ⇒ rollback.
   - Un timeout ambiguo se resuelve releyendo la fila: `container_id = N` significa que se aplicó.
     Si la relectura también falla, se trata como §5.6.
   - Con el tope vencido (§5.3.1) no se ejecuta.
5. **Autorizar el relay y escribir los hooks** con el procedimiento completo de §5.8: autorización
   completa → `relay.enabled` → relay identificado → `conversation.json`.
   - Si el relay no se identifica en 5 s, se borra la marca y **no** se escribe el archivo:
     `effective:false` con `relay-unavailable`. No hay hooks sin relay ni "hook error". El hash
     sigue autorizado y corresponde al token.
   - La reparación es `PATCH {enabled:true}` (§5.8), sin recrear.
6. **Completar** (convergencia sobre `N`):
   1. Se borra `defer-skill-seed` del directorio de control.
   2. Se siembran las skills en `N`, que está en marcha, con `execCapture` del mismo script que
      usa el entrypoint (`/opt/st/seed-skills.sh`). La precondición 8 garantiza que no sobrescribe
      ninguna skill personalizada (§5.4).
   3. Mapeos de puertos desde la config.
   4. `status=running`.
   5. gitIdentity si aplica (§5.2).
   6. postStart.
   7. `remove()` de `O`. Es seguro: §5.2 probó que su capa no tenía nada que perder y estuvo
      detenido todo el tiempo.

   Un fallo aquí se registra y no deshace nada: `N` es la sesión.

**Rollback (cualquier fallo en los pasos 1–4).** Cada paso es idempotente y se ejecuta incluso si
el anterior falló, salvo donde se indica:

1. `stop` y `remove` de `N` si existe.
2. **Confirmar que `N` ya no existe:** `inspect(N)` por id debe responder 404.
3. `O` vuelve a su nombre canónico si fue renombrado. Si `N` sigue teniendo ese nombre
   (eliminación incierta), el rename falla. Es el resultado esperado del estado incierto y no un
   error inesperado: §5.6 lo completa cuando se resuelve el destino de `N`.
4. **Solo si el paso 2 confirmó la eliminación**, se borra `defer-skill-seed`.

> Contrato v1.6 (§2.7.3): el rollback **resuelto** exige además que no quede trabajo en vuelo, y
> busca `N` también por la etiqueta `recreate-of`. Responde sin `unresolved`. Todo lo demás es
> estado incierto, con `unresolved: true`.

**Estado incierto.** Si `remove` falla o su resultado es ambiguo (timeout, daemon sin respuesta,
`inspect(N)` sin respuesta o con `N` todavía presente), la marca **se conserva**.

- Mientras exista `N`, cualquier arranque suyo seguirá sin sembrar. Puede ser un `docker start`
  manual, una política de reinicio o el `start` de un operador sobre el contenedor equivocado.
- La sesión queda marcada como "recreación interrumpida" (§5.3.1) y la marca solo se retira cuando
  §5.6 resuelve con D1 y Docker:
  - `N` confirmado inexistente y D1 = `O` ⇒ se retira;
  - D1 = `N` (el CAS sí se aplicó) ⇒ convergencia sobre `N` (tabla de abajo);
  - Docker sin respuesta ⇒ no se toca nada.

Una marca que sobrevive no hace daño. `O` no monta el directorio de control y no la ve, así que
`O` siembra como siempre.

D1 y el workspace no necesitan restauración: antes del paso 4 no se escribió nada en ellos. En el
directorio gestionado y en el de control solo se tocaron archivos que `O` no monta. Lo único que
`N` pudo escribir en el workspace, en cualquier número de arranques, son los `mkdir -p` que `O`
hace igual al arrancar (§5.4).

Estado final: idéntico al previo. `O` está detenido, con D1 apuntándolo, y sin cambios en la
captura ni en las skills. Respuesta: 500 `recreate-failed` con `{ step }`, más
`{ unresolved: true }` cuando la marca se conservó por estado incierto.

**Después del paso 4: convergencia sobre `N`, nunca reversión.** No se vuelve a `O` ni se promete
revertir el workspace: lo que `N` haga a partir de aquí es lo que hace cualquier sesión en marcha.
Todo estado intermedio converge sin recrear:

| Quedó a medias | Detección | Convergencia |
| --- | --- | --- |
| Marca o archivo ausentes, o relay no identificado | `pendingReasons: hooks-file-missing` / `relay-unavailable` | **Inmediata:** `PATCH …/conversation {enabled:true}` aplica §5.8. **Automática:** `reconcile` al arrancar el backend, con la misma autorización completa |
| `defer-skill-seed` no se borró (caída entre 4 y 6.1) | `reconcile` (D1 = `N` y la marca existe) | `reconcile` la borra desde el host, aunque `N` esté detenido. Si `N` está en marcha, siembra con `execCapture`; si no, siembra el siguiente arranque de `N`. La precondición 8, evaluada antes del paso 4, sigue garantizando que no se sobrescribe ninguna personalización: nada pudo personalizar una skill en `N` mientras no había CLI en marcha |
| Skills sin sembrar (fallo de 6.2) | log | El siguiente arranque de `N` siembra, ya sin marca |

Nada de esto exige una segunda recreación, que §5.2 probablemente bloquearía, porque para entonces
`N` ya tiene `~/.bash_history`.

#### 5.3.1 Tope de tiempo

> **Precisado en el contrato v1.6 (§2.7.4, revisión de consistencia K1):**
>
> - Un timeout no significa que la operación haya terminado. Una llamada vencida sigue en vuelo
>   hasta que su promesa se resuelve.
> - `T_d1` = 60 s vale **solo para D1**, que tiene una duración máxima por sentencia. Docker no
>   tiene un límite equivalente.
> - Las peticiones a Docker **no se abortan en el cliente**: los topes solo dejan de esperar, y
>   la respuesta de dockerd es la evidencia de cómo terminó cada una.
> - Un **registro durable del intento** (`recreate-attempt.json`, sin secretos) tiene tres
>   estados:
>   - `open`: el propio intento actúa bajo su lock, paso 5 incluido, sin bloqueo circular;
>   - `uncertain`: hay peticiones sin respuesta, o se encontró tras un reinicio del backend;
>   - `resolved`.
> - Tras un reinicio no hay evidencia de terminación, así que la sesión **queda en
>   `recreate-unresolved`**. D8 (decidida): fail-closed, sin resolución automática heurística, y
>   el piloto solo con una sesión descartable.
> - Un sobrante solo es un contenedor con la etiqueta de un intento `resolved` cuyo id **no** es el
>   vigente de D1. El `N` confirmado nunca se elimina.
>
> Donde este apartado diga otra cosa, manda el contrato.

Una llamada a Docker sin tope (`create`, `start`, `inspect`, `changes`, `rename`) con el daemon
colgado retendría el lock hasta reiniciar el backend. Por eso hay dos topes:

- **Recreación: `T_rec` = 5 min**, desde el lock hasta el final del paso 6, incluidos todos los
  pasos posteriores al CAS. Incluye la espera de readiness (≤ 60 s). Cada llamada a Docker o
  `execCapture` corre contra el tiempo que le queda, y postStart contra
  `min(lo que queda, el tope propio de streamExec)`.
  - Si el tope vence antes del paso 4, se aborta y se pasa al rollback.
  - La espera del probe del paso 5 (≤ 5 s) también corre contra lo que queda. Un probe cortado
    cuenta como `relay-unavailable`, y no deshace nada.
  - El paso 4 comprueba el tope **justo antes** del compare-and-set: con el tope vencido no
    confirma. Así una recreación abortada nunca cambia D1.
  - Si vence después del paso 4, no se deshace nada (§5.3). Se abandona el resto del paso 6, se
    registra qué faltó, se libera el lock, y lo pendiente converge (tabla de §5.3). Así ninguna
    operación espera más de `T_rec` + `T_rb`.
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
  | **Skills:** `cp -r /opt/session-skills/. ~/.claude/skills/` | **Sí** (sobrescribe las skills gestionadas con el contenido de la imagen de `N`) | **Diferida durante todos los arranques anteriores al paso 4.** El entrypoint omite la siembra mientras exista `/etc/st-control/defer-skill-seed`. La marca vive en el directorio de control del host (ro dentro de `N`), así que ni el entrypoint ni el usuario pueden borrarla, y el host puede retirarla con `N` en marcha o detenido. La retira el backend en el paso 6.1, el rollback, o `reconcile` (§5.3, tabla de convergencia). La siembra la ejecuta el backend en el paso 6.2 con `/opt/st/seed-skills.sh`, extraído del entrypoint sin cambiar su semántica. Un contenedor creado sin el directorio de control (3.0c o sin captura) siembra como hoy |
  | Siembra de `workspace/.npm-global` desde la imagen si falta | **Sí** | **No puede ocurrir:** la precondición 7 exige un directorio real |
  | Migración del layout heredado `workspace/.claude` a `.st/claude-state` | **Sí** (la imagen de `O` puede ser anterior a la migración) | **No puede ocurrir:** la precondición 7 la bloquea |

- **Skills personalizadas (precondición 8): se conservan o la recreación se bloquea.** La
  siembra posterior a la confirmación no puede sobrescribir nada que el usuario haya cambiado.
  Para cada archivo que la imagen de `N` sembraría (`/opt/session-skills/**`), el backend compara
  tres versiones:
  - **W:** la del workspace, leída con el opener de `workspaceFiles.ts` y la prueba
    `/proc/self/fd`, nunca con un `readFile` sobre una ruta del usuario;
  - **I_O:** la de la imagen de `O`, con `getArchive(O, /opt/session-skills)`, que funciona con
    `O` detenido y no lo modifica;
  - **I_N:** la de la imagen de `N`, con `getArchive` sobre `N` creado y sin arrancar (paso 1).
    El preflight, que no crea nada, solo puede comparar W con I_O, y avisa de que la comparación
    con I_N se hará en el paso 1.

  | W | Resultado |
  | --- | --- |
  | No existe | Siembra nueva; no hay nada que perder |
  | Igual a I_N | Nada cambia |
  | Igual a I_O, distinta de I_N | Es lo que sembró el último arranque de `O`: la actualización a I_N equivale a lo que haría cualquier arranque con la imagen nueva. Se permite |
  | Distinta de I_O y de I_N | **Personalizada** ⇒ **bloquea** `managed-skills-customized` |
  | Existe, y la ruta no está en la imagen de `O` | Una skill del usuario que coincide con un nombre gestionado nuevo ⇒ **bloquea** `managed-skills-collision` |

  - Los archivos que solo están en el workspace (skills con otros nombres) nunca se tocan: `cp -r`
    combina, no borra. Se comprueba igualmente byte a byte en el test.
  - Si `O` no tiene `/opt/session-skills` (imagen anterior a las skills), toda W existente en una
    ruta gestionada es una colisión.
  - **Falso positivo aceptado:** `sync-skills.sh` (copia en vivo, sin rebuild) deja W igual al
    repositorio y distinta de I_O, así que bloquea. La salida es que el owner mueva o descarte esos
    archivos, sin forzar nada (D4).
  - No se devuelve ninguna ruta, solo recuentos por código.

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
| `= O` (no se confirmó) | `N` existe | `stop` + `remove` de `N`, **confirmado** con `inspect(N)` 404; `O` vuelve a su nombre canónico; solo entonces se retira `defer-skill-seed`. Es el mismo rollback de §5.3. Si la eliminación no se confirma, la marca se conserva y se reintenta en el siguiente `reconcile` o en la siguiente operación de ciclo de vida |
| `= O` | `N` no existe (404 confirmado) y `defer-skill-seed` presente | Se retira la marca; `O` vuelve a su nombre si hace falta |
| `= N` (se confirmó) | `O` existe | `remove` de `O`; mapeos y `status` según el estado real de `N`, como en cualquier reconcile; postStart no. El hash ya es el de `N` (paso 4, atómico), así que la marca y el archivo los converge el `reconcile` de captura (§5.8) si el token de `N` corresponde al hash (§6.1). Si `defer-skill-seed` sigue, la retira y siembra (§5.3, tabla de convergencia) |
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
- **Regresión A2/P1 (skills personalizadas): se conservan o se bloquea.** Workspace con:
  - una skill gestionada **personalizada** (W ≠ I_O);
  - una gestionada sin tocar (W = I_O);
  - una del usuario con otro nombre;
  - imagen de `N` con contenido distinto en las dos gestionadas.

  Resultados:
  - el preflight bloquea con `managed-skills-customized: 1`, y el POST también;
  - sin ningún efecto: D1, nombres, directorios y todas las skills byte a byte.

  Variantes:
  - sin la personalizada: éxito, la gestionada sin tocar pasa a I_N, la del usuario sigue igual
    byte a byte, y la siembra ocurre solo en el paso 6.2;
  - una skill del usuario en una ruta que solo existe en la imagen de `N`: `managed-skills-collision`
    en el paso 1 (el preflight no podía verlo), rollback, todo intacto;
  - `O` sin `/opt/session-skills`: toda W en ruta gestionada colisiona.
- **Regresión A2/P2 (aplazamiento en todos los arranques previos al CAS):**
  1. skill gestionada en W = I_O, e imagen de `N` distinta;
  2. `N` arranca, se detiene y vuelve a arrancar antes del paso 4, por un reinicio inyectado y por
     un `docker restart`;
  3. fallo inyectado antes del CAS.

  ⇒ La skill queda byte a byte como estaba, `defer-skill-seed` fue retirada por el rollback y `O`
  queda intacto.

  Variantes de retirada y recuperación tras el CAS:
  - éxito: la marca se retira en 6.1 y la siembra ocurre en 6.2, una sola vez;
  - caída entre el CAS y 6.1: `reconcile` (D1 = `N`) retira la marca con `N` en marcha y siembra
    por exec, o con `N` detenido y siembra el siguiente arranque;
  - en ningún caso queda una marca que impida la siembra para siempre: toda marca conservada
    tiene un `N` existente o un estado no resuelto, y `reconcile` la resuelve en cuanto Docker
    responde;
  - fallo en 6.2: siembra el siguiente arranque de `N`.
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
- **`effectiveAfterRestart` sin contenedor (A3/P2), un test por condición falsa** y las demás
  verdaderas:
  - `conversation_requested = 0`;
  - flag apagado;
  - marca de revocación por sesión;
  - marca global;
  - imagen actual sin `="2"`.

  Cada uno ⇒ `effectiveAfterRestart:false`. Con todas verdaderas ⇒ `true`, y el `start`
  siguiente deja la captura efectiva. Lo mismo para la rama del contenedor detenido, con cada
  condición de su lista.
- **Probe (disponibilidad):**
  - positivo ⇒ `effective:true` con `checkedAt` de esa petición;
  - relay caído o puerto ocupado sin identificación ⇒ `false`;
  - consulta inmediatamente después de la caída ⇒ `false`, sin caché positiva;
  - dos consultas concurrentes ⇒ un solo probe;
  - una consulta posterior a un probe terminado ⇒ probe nuevo;
  - cualquier otra condición falsa ⇒ `false` sin ejecutar el probe.

  (D7 se decidió por el probe fresco: no hay tests de caché.)
- Paso 4 atómico: en ningún instante observable `container_id = N` con un hash distinto al de `N`.
  Se prueba leyendo D1 entre cada llamada simulada.
- `expectImageId` distinto ⇒ 409 sin efectos.
- El tag se mueve entre el preflight y el POST ⇒ `image-changed`.
- `start`, `stop`, `kill` y `DELETE ?hard=true` concurrentes durante cada paso de la
  recreación ⇒ esperan el lock y actúan después sobre el estado final. Nunca se purga un
  workspace con `N` arrancando.
- `recreate` sobre una sesión con otra operación en curso ⇒ `busy`, sin efectos.
- `docker start` manual de `O` entre los pasos 2 y 3 ⇒ rollback sin arrancar `N`.
- Fallo al escribir la marca o el archivo tras la confirmación ⇒ `hooks-file-missing`; `PATCH
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

- **Regresión A2/P2 (eliminación de `N` incierta):** `remove(N)` falla, y en otra variante queda
  ambiguo (timeout con `N` todavía presente). Luego `N` arranca antes de cualquier CAS, por un
  `docker start` manual.

  ⇒ `defer-skill-seed` sigue presente, el arranque de `N` **no siembra**, la skill gestionada
  sigue byte a byte, y D1 sigue en `O`. Cuando Docker confirma la eliminación (siguiente
  `reconcile`), la marca se retira y `O` queda en su nombre. En ningún momento se sembró en el
  workspace con la imagen de `N`.
- **A4 (relay sin recreación adicional):**
  1. un contenedor que arranca con token y **sin** archivo ni marca (deshabilitado por API antes
     del arranque);
  2. el relay no escucha;
  3. `PATCH {enabled:true}` ⇒ autorización completa → marca → relay identificado en ≤ 5 s →
     archivo;
  4. debe haber un prompt real en una pestaña ya abierta y otro en una pestaña nueva, entregados
     al receptor, con `capture.effective:true`, ningún "hook error" y el mismo `container_id` (sin
     recreación).
- El paso 5 de la recreación sigue el mismo camino.
- **Compatibilidad de las marcas con el CLI real (§5.8.1):** con `/etc/st-control` vacío, con
  marcas, ilegible y con un `.json` inválido dentro, la secuencia de hooks y los eventos son
  idénticos y no hay avisos de settings. Si falla, la activación queda bloqueada
  (`control-marker-incompatible`) y el smoke lo comprueba.

**Estado efectivo (A3/P2), con el CLI real y la sesión en marcha.** Se distinguen dos situaciones
que no prometen lo mismo.

*(a) Activación con el relay no disponible.* El backend **no** activa los hooks: no hay
`conversation.json`, así que ningún hook apunta a un puerto cerrado. Aquí **sí** se exige cero
"hook error".

| Caso | Resultado |
| --- | --- |
| Puerto 47613 ocupado por otro proceso antes del boot (el relay no puede escuchar; el ocupante no se identifica) y `PATCH {enabled:true}` | `effective:false`, `relay-unavailable`, marca retirada, sin archivo, 0 "hook error" |
| Relay impedido en la recreación (paso 5) | Ídem, y la sesión es `N` |
| Marca o archivo borrados a mano en el host | `effective:false`, `hooks-file-missing`; si falta el archivo, ningún hook se dispara |
| Hash de D1 cambiado a otro valor | `effective:false`, `token-mismatch`; ingest rechazado |

*(b) Caída del relay después de la activación.* Los hooks ya están configurados. Mientras el relay
no escucha, los hooks bloqueantes que dispare un CLI abierto fallan, y el CLI puede mostrar
"hook error". **No se promete cero errores.** Se comprueban la detección y la recuperación, con
límites explícitos:

1. Se mata el relay (`kill -9`) con una pestaña abierta.
2. **Detección:** la **primera** consulta de `capture` después del `kill` da `effective:false`,
   `relay-unavailable` (probe fresco, D7).
3. **Recuperación:** el supervisor relanza el relay en ≤ 1 s, el primer escalón de su backoff,
   más el arranque. La primera consulta que encuentra el relay identificado da `effective:true`,
   en ≤ 3 s desde el `kill`.
4. **Impacto acotado:** el turno lanzado durante la ventana termina y Claude sigue. Los
   "hook error" en pantalla son ≤ el número de hooks bloqueantes de ese turno, y 0 en el turno
   siguiente, ya recuperado.
5. **Pérdidas visibles:** lo perdido en la ventana aparece como `gap relay_restart` en la
   conversación (contrato §4.5), y nada más se pierde.

Además, el caso del probe en la misma petición, con un CLI y un relay reales:

- probe positivo ⇒ `effective:true`;
- `kill` del relay e **inmediatamente** otra consulta ⇒ `effective:false`, sin esperar ningún
  intervalo;
- (D7: sin caché positiva, así que no hay variante con caché.)

Con el contenedor detenido:

- sin marca ni archivo y con correspondencia ⇒ `effectiveAfterRestart:false`,
  `requiresRecreate:false`, `pendingReasons: [stopped, hooks-file-missing]`; después de start +
  `PATCH`, `effective:true` sin recrear;
- con marca y archivo ⇒ `effectiveAfterRestart:true`, y efectivamente lo es tras el start.

**Marcas residuales (A4)**, con `relay.enabled` y `conversation.json` presentes:

| Caso | Resultado esperado |
| --- | --- |
| Marca de revocación por sesión, y global | `effective:false`; `reconcile` y el receptor las retiran; si el contenedor arranca con ellas, su relay corre pero el backend rechaza todo con `revoked` |
| Flag apagado | `reconcile` retira todas; ingest `disabled` |
| Token no autorizado (`token-mismatch`) | `PATCH` y `reconcile` las retiran y nunca las reescriben; ingest rechazado |
| `conversation:disable` concurrente con un `PATCH {enabled:true}` (100 repeticiones) | Nunca quedan marca ni archivo tras el comando, y nunca `effective:true` |

Variantes:

- con `~/.bash_history` o un `apt-get install` ⇒ `recreatable:false` sin efectos;
- matar el backend entre los pasos 2 y 4 ⇒ `reconcile` deja `O` intacto;
- matarlo después del 4 ⇒ `reconcile` completa con `N`.

### 5.8 Arranque y autorización del relay (A4)

**Hoy** el entrypoint arranca el supervisor del relay solo si, en el momento del arranque, existen
el token y `conversation.json`. Un archivo escrito después nunca tiene relay. Afecta a dos
caminos:

- el paso 5 de la recreación;
- rehabilitar un contenedor que arrancó con la captura deshabilitada (§2).

#### 5.8.1 Ubicación de las marcas: directorio de control, no el de settings

`relay.enabled` y `defer-skill-seed` viven en `<WORKSPACE_ROOT>/.st-control/<sid>/`:

- es un directorio del host, propiedad de root, fuera del workspace y fuera de
  `.claude-managed/`;
- se monta **ro** en `/etc/st-control`, en todo contenedor creado con captura por un backend 3.0d.

Motivos:

- **No hay nada que el CLI pueda interpretar como settings.** Ninguna marca está en
  `/etc/claude-code/managed-settings.d/` ni en ninguna ruta que el CLI lea.
- **El usuario no puede crear ni borrar marcas** (montaje ro) y **el host las retira aunque el
  contenedor esté detenido.**
- Se borra con la sesión en el hard delete (`onSessionPurged`) y no entra en el backup.
  `reconcile` la regenera desde D1, como hace con `.claude-managed`.

**Validación obligatoria con el CLI real** (smoke, CLI 2.1.308 y el `claude` del workspace del
piloto), con las marcas presentes y ausentes:

- la secuencia completa de hooks y los eventos persistidos son idénticos;
- ningún aviso o error de settings en stderr ni en pantalla;
- con `/etc/st-control` vacío, ilegible y con un archivo `.json` inválido dentro, el CLI se
  comporta igual, lo que demuestra que no lo lee.

**Si alguna comprobación falla, la activación se bloquea:**

- `PATCH {enabled:true}` y `POST …/recreate` responden 409 `control-marker-incompatible`;
- 3.0d no se publica hasta resolverlo con otra ubicación revisada.

No hay respaldo silencioso en otra ruta.

#### 5.8.2 Supervisor (imagen, etiqueta `conversation-relay="2"`)

- Arranca si hay token, pero **no lanza el relay** mientras no exista
  `/etc/st-control/relay.enabled`, o `conversation.json`.
  - Comprueba cada 0,5 s con un `[ -e ]` de bash, sin procesos nuevos.
  - `conversation.json` también vale para los contenedores que creó el backend de 3.0c, que no
    tienen el directorio de control.
- Una vez lanzado, el relay sigue como hoy: reinicio con backoff, generación, muere con el
  contenedor. Que desaparezca la marca no lo detiene: queda inerte, como ya documenta §2.4 para
  deshabilitar sin reiniciar.
- **Identificación:** el relay responde `GET /st-relay/status` con `204` y `X-ST-Relay: 1`,
  `X-ST-Relay-Generation: <n>`.
  - No lleva cuerpo, ni tokens, ni contadores de contenido.
  - Cualquier otra ruta o método sigue en 404, y el `POST` de ingesta no cambia.
  - Un proceso del usuario que ocupe el puerto no responde así: es la diferencia entre "algo
    escucha" y "el relay escucha".
  - Imitarlo a propósito solo le quita la captura a su propio dueño; la autorización de ingesta
    sigue siendo el token en el backend.

#### 5.8.3 Autorización completa antes de escribir `relay.enabled`

> **Precisado en el contrato v1.6 (§2.7.5, K2/K3):** hay tres niveles.
>
> - La **autorización completa**, la de esta sección, sirve para **escribir** sobre un contenedor
>   en marcha.
> - La **autorización de conservación** (1–3, 5, 6, y el contenedor existente con ambos montajes,
>   en marcha o detenido) **mantiene** marca y archivo durante un stop. `reconcile` no los retira
>   ahí, de modo que stop + start sigue capturando sin `PATCH`.
> - La **preparación del spawn** escribe antes de crear el contenedor.
>
> Sin ambos montajes, como en un contenedor creado por 3.0c, no hay reparación sin recrear.

`relay.enabled` y `conversation.json` se escriben **solo** si, en ese momento, se cumple todo:

1. `CONVERSATION_ENABLED`;
2. `conversation_requested = 1`;
3. sin marca de revocación, por sesión ni global;
4. el contenedor de D1 existe, está en marcha y tiene los dos montajes (gestionado y control);
5. su propia imagen lleva `conversation-relay="2"`;
6. correspondencia token ↔ hash (§6.1).

Orden: autorización → `relay.enabled` → **recomprobación** de 1–3 → probe de identificación (≤ 5 s)
→ `conversation.json` → **recomprobación** de 1–3.

- Si una recomprobación falla, se borran el archivo y la marca, en ese orden.
- Si falla el probe, se borra la marca: `relay-unavailable`.

Las recomprobaciones cierran la carrera con el comando de emergencia, que corre en otro proceso.
La recomprobación final hace de la marca de revocación la última palabra, como en §2.5.

Lugares que aplican el procedimiento:

- el paso 5 de la recreación;
- `PATCH {enabled:true}` con el contenedor en marcha;
- `reconcile`, que solo converge hacia el estado autorizado y nunca escribe sin autorización.

#### 5.8.4 Marcas residuales

Una marca o un archivo que existen sin autorización completa se **retiran**, y nunca cuentan para
`effective` (§6.2).

| Origen | Retirada |
| --- | --- |
| Deshabilitar por API | Marca de revocación → D1 → `conversation.json` → `relay.enabled` |
| Comando de emergencia `conversation:disable` | Mismo orden; el paso 3 del comando borra también la marca |
| Receptor que observa una revocación (§2.5) | Ya borra el archivo; ahora también la marca |
| Flag apagado | `reconcile` borra **todos** los `conversation.json` y `relay.enabled`, como hoy con los archivos |
| `token-mismatch` o contenedor sin captura | `reconcile` y `PATCH` las borran; nunca las escriben |
| Caída entre la escritura de la marca y la del archivo | `reconcile`: autoriza y completa, o retira |

Si un contenedor arranca con una marca residual, su relay arranca. Es inocuo:

- el backend rechaza lo que llegue (revocado, flag apagado o token no autorizado: 204 con
  `ingest_rejected`);
- sin `conversation.json` ningún hook le escribe;
- `effective` es `false`.

Tests en §5.7.

**Spawn normal** (`prepareSpawn`, sesión nueva o `start` sin contenedor): con la autorización
completa salvo el punto 4, escribe hash, marca y archivo antes de crear el contenedor, como hoy.
El relay arranca en el boot.

## 6. Semántica de `capture` (A3)

`GET /api/sessions/:id/conversations` y `PATCH …/conversation` devuelven:

```
capture: {
  requested, effective,
  effectiveAfterRestart,       // el siguiente `start` deja la captura efectiva sin recrear
  requiresRecreate,            // hace falta POST …/recreate (no promete que pase el preflight)
  pendingReasons: [],          // flag-off | not-requested | revoked | image-without-relay |
                               // stopped | container-without-capture | token-mismatch |
                               // hooks-file-missing | relay-unavailable |
                               // control-marker-incompatible | cli-below-minimum (aviso)
  checkedAt                    // hora del probe del relay de esta petición (§6.2)
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

Se calculan con el `inspect` del contenedor de D1, sin deducir nada solo de D1, y con el probe de
identificación del relay (§5.8.2).

**Disponibilidad (recomendado): probe fresco para afirmar `effective:true`.**

- Cada cálculo que vaya a responder `effective:true` hace su propio probe, un `execCapture` de
  ≤ 2 s. **No hay caché positiva.**
- Peticiones concurrentes para el mismo contenedor comparten el probe que ya está en vuelo, pero
  nunca reutilizan uno terminado.
- Un resultado negativo no necesita probe: si falla cualquier otra condición, se responde `false`
  sin ejecutarlo.
- `capture.checkedAt` es la hora de ese probe.
- **Garantía:** `effective:true` significa que el relay se identificó durante esa misma petición.
  No promete nada sobre después: el relay puede caer un instante más tarde, y lo detecta la
  siguiente consulta.
- Coste: un `docker exec` por consulta positiva, en rutas owner-only y de admin, sin polling del
  backend.

**D7, decidido el 2026-10-26:** probe fresco. Se descartó la caché positiva de 15 s, que daba
una garantía más débil ("identificado en los últimos 15 s").

**Autorización completa** = los puntos 1–6 de §5.8.3.

- **`effective = true`** solo si:
  - hay autorización completa;
  - **`relay.enabled` y `conversation.json` existen**;
  - **el probe identificó al relay** (`X-ST-Relay: 1`).

  Cualquier otra combinación es `false`, con su motivo:

  | Situación | `pendingReasons` |
  | --- | --- |
  | Relay caído (el supervisor lo está reiniciando, o murió) | `relay-unavailable` |
  | Puerto 47613 ocupado por otro proceso (responde, pero no se identifica) | `relay-unavailable` |
  | Falta la marca o el archivo (configuración ausente) | `hooks-file-missing` |
  | Token ≠ hash | `token-mismatch` |
  | Revocación, flag apagado, no pedida | `revoked` / `flag-off` / `not-requested` |
  | Contenedor detenido | `stopped` |

- **`effectiveAfterRestart`**: lo que dejaría un `start` **sin reparar nada**. `start` no
  escribe marcas ni archivos (no cambia, D1). Es `true` solo si se cumple una de estas dos ramas,
  cada una con **todas** sus condiciones:
  - **no hay contenedor** (`container_id` NULL o inspect 404) **y**:
    - `conversation_requested = 1`;
    - `CONVERSATION_ENABLED`;
    - sin marca de revocación, por sesión ni global;
    - la imagen actual lleva `conversation-relay="2"`.

    Son las mismas condiciones con las que `prepareSpawn` escribe token, hash, marca y archivo, así
    que el siguiente start hace spawn completo. Si falta cualquiera, el spawn arrancaría sin
    captura, y la rama da `false`; o
  - **el contenedor está detenido y su configuración ya está completa para el arranque**:
    - autorización completa salvo "en marcha";
    - montajes;
    - correspondencia;
    - imagen `="2"`;
    - **`relay.enabled` y `conversation.json` presentes**.

    En el boot, el supervisor ve la marca y lanza el relay.

  En cualquier otro caso es `false`. En particular, un contenedor detenido con correspondencia
  pero **sin marca o sin archivo** da `effectiveAfterRestart:false`, porque el start no los
  repara.
- **`requiresRecreate`** distingue lo que se repara en el mismo contenedor de lo que solo
  resuelve un contenedor nuevo:
  - **`false`** cuando hay ambos montajes y correspondencia, o una suspensión restaurable, y solo
    falta configuración o relay. El remedio es arrancar si hace falta y luego `PATCH {enabled:true}`.
    `pendingReasons` lo dice (`hooks-file-missing` + `stopped`). **No se exige una recreación
    innecesaria.**
  - **`true`** solo con `container-without-capture`, `token-mismatch`, o un contenedor sin el
    montaje de control (por ejemplo, creado por 3.0c), sea cual sea su imagen (contrato v1.6,
    §2.7.5). Ninguno se repara en el mismo contenedor.
  - Nunca promete que la recreación vaya a pasar: §5.2 y la precondición 8 solo se evalúan en el
    preflight.
- **`PATCH {enabled:true}`** aplica §5.8.3. Con el contenedor detenido no escribe nada y responde
  el cálculo anterior. Nunca escribe la marca ni el archivo sin autorización completa.
- **Deshabilitar** no cambia: `emissionStopsAfterRestart:true` (PR #448), y nunca recrea.

## 7. Activación progresiva

Cada etapa se puede detener y revertir con `conversation:disable` o con el flag apagado. Avanzar
requiere autorización explícita del responsable.

| Etapa | Qué | Criterio para avanzar |
| --- | --- | --- |
| 0 | Desplegar backend 3.0d + imagen con etiqueta `="2"`, **flag apagado**. Requisito previo: la validación de compatibilidad de las marcas (§5.8.1) pasó en el smoke | Sesiones existentes sin cambios; `POST /ingest` → 204 `disabled`; `GET …/recreate` responde `flag-off` |
| 1 | `CONVERSATION_ENABLED=true`, nadie pedido | `reconcile` sin correcciones ni huérfanos |
| 2 | **Piloto aislado (D8):** una sesión **nueva y descartable, sin datos importantes**, creada sin captura y detenida; preflight `recreatable:true`, `cliVersion` ≥ 2.1.308. PATCH → preflight → POST. Se acepta que pueda quedar bloqueada en `recreate-unresolved` | 48 h: eventos visibles; `rejected` solo esperados; `relayDropped=0` fuera de pruebas; RSS del relay ≤ 20 MiB; sin "hook error"; checklist de §3 verificado a mano |
| 3 | `CONVERSATION_ALLOW_USERS` = el responsable: solo sesiones **nuevas**, que no necesitan recrear. Recrear sesiones existentes queda **bloqueado** hasta que exista y se valide el procedimiento de recuperación administrativa manual (D8) | Una semana con los mismos criterios; disco de `.conversations` dentro de L7 |
| 4 | Ampliar la allowlist | Decisión aparte |

## 8. Cambios de contrato y documentación (PR de docs previo al código)

- **CONVERSATION.md:**
  - §2.4: tabla con las filas nuevas ("Recrear (admin)" y las de §6). Se corrige la fila
    "Habilitar corriendo con token", que hoy promete `effective:true` sin relay (§5.8), y se añade
    la correspondencia token ↔ hash como invariante (§6.1).
  - §2.6: el relay arranca con la marca de autorización (`relay.enabled`) o con el archivo. El
    backend exige autorización completa, escribe la marca, espera a que el relay se identifique
    (`GET /st-relay/status`) y escribe el archivo (§5.8.3). Siembra de skills
    diferible (§5.4).
  - §2.1: el directorio de control (`.st-control/<sid>/`, ro en `/etc/st-control`): qué contiene,
    quién lo escribe, y que no se monta en contenedores sin captura.
  - §2.5: el comando de emergencia y el receptor retiran también `relay.enabled`.
  - §2.4.1: el requisito se resuelve por la vía de §5.
  - §7: el endpoint, el preflight, `recreateOrphans` y los contadores.
  - §10 3.0d: las pruebas de §5.7.
- **DEPLOYMENT.md:**
  - "Recreating a session container" se reescribe sobre el endpoint. El procedimiento con
    `docker rm` queda como emergencia, con la advertencia de §3: hoy pierde la identidad git, los
    dotfiles y todo lo que haya en la capa.
  - "Rollout order": el paso 4 usa el endpoint.
- **session-image/README.md:**
  - el directorio de control `/etc/st-control` con `relay.enabled` y `defer-skill-seed`;
  - `/opt/st/seed-skills.sh`;
  - `GET /st-relay/status`;
  - la etiqueta `conversation-relay="2"`.
  - Las etapas de §7.
- **Fuera de 3.0d, señalado:** DEPLOYMENT.md:124 (#190, "stopped and started once so it re-joins")
  tiene el mismo error que R1 de 3.0c. Va en un PR aparte.

## 9. Decisiones

D1–D6 las cerró el responsable con las recomendaciones de Work. D7 lo cerró el 2026-10-26. D8 surgió en la revisión de consistencia del contrato y lo cerró el 2026-10-26 (fail-closed).

| | Decisión |
| --- | --- |
| D1 | Recreación **administrativa explícita** y protegida; `start` no cambia |
| D2 | Preservación **estricta** de HOME y de la capa: cualquier pérdida bloquea; sin lista de exclusiones fuera de lo que produce el entrypoint (§5.2) |
| D3 | Solo se reconstruye lo que se puede verificar como exacto (`~/.gitconfig` de gitIdentity); dotfiles bloquean |
| D4 | **Sin bypass destructivo**: no hay `force` ni `acknowledgeLayerLoss` |
| D5 | Nunca se recrea una sesión en marcha, ni automáticamente ni por el endpoint |
| D6 | **ID inmutable de imagen**: el preflight lo muestra, el POST lo exige (`expectImageId`), la etiqueta se comprueba en ese ID y `createContainer` lo usa |
| D7 | **Decidido (2026-10-26): probe fresco**, sin caché positiva; single-flight para consultas concurrentes, timeouts acotados y `checkedAt` (§6.2) |
| D8 | **Decidido (2026-10-26): fail-closed.** Sin resolución automática de un intento `uncertain`, ni por tiempo, ni por quietud, ni por un reinicio de dockerd. El bloqueo indefinido se acepta solo en el piloto, con una sesión nueva y descartable. No se usa en sesiones reales hasta validar un procedimiento de recuperación administrativa manual (contrato §2.7.4) |

## 10. Trazabilidad de los hallazgos de Work

| | Hallazgo | Corregido en | Dónde |
| --- | --- | --- | --- |
| **A1** | Pérdida de archivos: la recreación perdía lo que vive en la capa del contenedor (`~/.gitconfig`, dotfiles, `~/.bash_history`, `apt`, …) | v2 | §3, §5.2: preservación estricta; cualquier pérdida bloquea; solo se reconstruye un `~/.gitconfig` verificado como exacto |
| **A2** | Rollback y estado compartido | v2 + v3 + v4 | §5.3–§5.6 |
| **A3** | Estado efectivo y `effectiveAfterRestart` | v2 + v3 + v4 | §6 |
| **A4** | Arranque del relay con hooks escritos después de iniciar `N` | v3 + v4 | §5.8 |

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

**v4, sobre la v3 en `c9174d9`:**

- **A2/P1.** La siembra posterior al CAS sobrescribía las skills gestionadas personalizadas. Ahora
  hay una comparación a tres versiones (workspace, imagen de `O`, imagen de `N`): solo se permite
  actualizar lo que sembró `O`, y una personalización o una colisión **bloquea**, en el preflight
  o en el paso 1 (precondición 8, §5.4). Test: conservado byte a byte o bloqueado.
- **A2/P2.**
  - La marca de aplazamiento se borraba en el primer arranque de `N`. Ahora vive en el directorio
    de control del host (ro en `N`): ningún arranque anterior al CAS siembra.
  - La retira solo el backend: en el paso 6.1, en el rollback o en `reconcile`, este último aunque
    `N` esté detenido.
  - La recuperación tras el CAS es una convergencia sobre `N` (§5.3, tabla).
  - Test: dos arranques de `N` antes del CAS + fallo ⇒ skill intacta.
- **A3/P2.**
  - `effective` exige el relay identificado por `GET /st-relay/status` (no basta con que el puerto
    acepte), además de la configuración y la correspondencia.
  - `effectiveAfterRestart` es `false` si faltan la marca o el archivo, porque `start` no repara.
  - `requiresRecreate` solo es `true` cuando un contenedor nuevo es la única salida.
  - Tests para relay caído, puerto ocupado, configuración ausente y token ≠ hash (§6.2, §5.7).
- **A4.**
  - Autorización completa (seis condiciones) antes de escribir `relay.enabled`, con
    recomprobaciones contra el comando de emergencia (§5.8.3).
  - Retirada de las marcas residuales en todos los caminos (§5.8.4).
  - Las marcas salen del directorio de settings del CLI.
  - Validación con el CLI real; si falla, la activación se bloquea (`control-marker-incompatible`)
    (§5.8.1).
  - Tests de residuales con revocación, flag apagado y token no autorizado.

**v5, sobre la v4 en `870218e`:**

- **A2/P2.** El rollback retiraba `defer-skill-seed` aunque `remove(N)` hubiera fallado. Ahora:
  - la marca solo se retira con la eliminación de `N` confirmada (`inspect` 404);
  - con un estado incierto se conserva hasta que §5.6 resuelve con D1 y Docker.
  - Regresión: `remove` falla o queda ambiguo, `N` arranca antes del CAS ⇒ no siembra y la skill
    sigue intacta.
- **A3/P2.**
  - La rama "sin contenedor" de `effectiveAfterRestart` exige `requested`, flag activo y ausencia
    de revocación, además de la imagen, con un test separado por cada condición falsa.
  - Disponibilidad: probe fresco para afirmar `effective:true`, sin caché positiva.
  - La caché de 15 s quedó como decisión D7 del responsable, que después eligió el probe fresco.
  - Tests: probe positivo, caída del relay y consulta inmediata.
- **Smoke.** Se separan:
  - (a) no activar hooks contra un relay no disponible, con 0 "hook error" exigido;
  - (b) una caída posterior a la activación, sin prometer 0 errores, comprobando detección en la
    primera consulta, recuperación en ≤ 3 s, errores acotados al turno de la ventana y
    `gap relay_restart`.

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
