# Raíz de confianza del lanzamiento del CLI (diseño; **nada implementado**)

Estado:
- Pedido del responsable (2026-11-04) antes de B2.
- No se implementan ni el supervisor ni el gateway.
- No cambia G3, G3-A, R8, G1–G12 ni el Composer 3.2.

Relacionado: [04-poc.md §1.14](./04-poc.md#114-pass-b-integridad-de-la-evidencia-hasta-el-backend-pass-b0-pass-11413-b1b3-no-autorizados)
(PASS-B y el modelo de amenazas A1/A2) y §1.14.14 (B1).

## 1. Por qué I-env no alcanza

§1.14.14.3 proponía que el gateway, al inscribir, lea como root `/proc/<pid>/environ` y
`/proc/<pid>/cmdline` y rechace variables y banderas peligrosas (I-env). El responsable lo rechazó.
El código del kernel de VM100 (`Ubuntu-6.8.0-147.147`) le da la razón:

| Hecho | Fuente | Consecuencia |
| --- | --- | --- |
| `environ` se lee de la **memoria del proceso**: `environ_read()` copia `[mm->env_start, mm->env_end)` con `access_remote_vm()` | `fs/proc/base.c` | El proceso puede reescribir lo que muestra. Por ejemplo, una biblioteca de `LD_PRELOAD` puede borrar su propia variable antes de que el gateway la lea |
| `cmdline` también es memoria del proceso (`get_mm_cmdline`) | `fs/proc/base.c` | Mismo problema |
| `/proc/<pid>/exe` es estado del kernel (`mm->exe_file`). Cambiarlo con `prctl(PR_SET_MM_EXE_FILE)` exige `CAP_SYS_RESOURCE`, que el contenedor no tiene | `kernel/sys.c` | Es fiable, salvo un `exec` posterior |
| Un trazador que se adjuntó **antes** del `exec` de un binario ilegible conserva el control de los registros. `ptrace_access_vm()` le niega la memoria (dumpable ≠ 1), pero `GETREGS` y `SETREGS` no pasan por esa comprobación. `LSM_UNSAFE_PTRACE` sólo afecta a cambios de credenciales | `kernel/ptrace.c`, `fs/exec.c` | Con registros puede inyectar syscalls: `prctl(PR_SET_DUMPABLE,1)`, `mmap` de código propio, `execve`. **H-ND no protege a un proceso cuyo padre del mismo uid lo trazaba antes del `exec`**. Con `ptrace_scope=1`, cualquier ancestro uid 1000 (el shell del pane, el servidor tmux o un padre preparado por el agente) puede hacerlo |
| `prctl(PR_SET_DUMPABLE, 1)` está permitido al propio proceso, sin privilegios | `kernel/sys.c` | Código ajeno **dentro** del CLI deshace H-ND |
| Yama `ptrace_scope=1` limita sólo el modo ATTACH, y sólo a quien no es ancestro. `mem`, `process_vm_readv`, `pidfd_getfd` y `ptrace` usan ATTACH. `environ`, `auxv` y `maps` usan READ, que Yama no limita | `security/yama`, `fs/proc/base.c` | Un proceso **sin ancestros del agente** tiene la memoria y los fds protegidos por Yama, aun sin H-ND |

**Conclusión.** Leer el proceso después de lanzarlo no prueba cómo se lanzó. La integridad del
arranque tiene que venir de **quién lo creó** y de que **ningún proceso del agente haya tenido
control sobre él** entre su creación y su inscripción.

## 2. Qué tiene que poder demostrar la raíz de confianza

Para un proceso P que pide inscribirse en el gateway:

| # | Requisito | Cómo se verifica sin confiar en la memoria de P |
| --- | --- | --- |
| L1 | P lo creó un lanzador confiable, no un proceso del agente | El lanzador obtiene la identidad de P **al crearlo**: pid del host, pidfd y `starttime`, y guarda el registro de lanzamiento |
| L2 | El ejecutable es la copia fijada: root, sin lectura para otros, inodo conocido | `stat(/proc/P/exe)` como root en el host: dispositivo, inodo, uid y modo. Se repite en cada inscripción para detectar un `exec` posterior |
| L3 | `argv` y `envp` son los que fijó el lanzador | Los escribió el lanzador; nunca se leen de `/proc` |
| L4 | Ningún proceso del agente fue ancestro ni trazador de P desde su creación | Por construcción: el padre de P no es un proceso del uid del agente. `TracerPid` en `/proc/P/status` vale 0 al inscribir; es estado del kernel |
| L5 | La identidad de P es estable | El pidfd guardado en el lanzamiento; `starttime` igual; inscripción sólo si el pidfd sigue vivo |
| L6 | Fallar cerrado después de reinicios | Sin registro verificable ⇒ `unverified`. Nunca se readopta un proceso por lo que diga su memoria |

Lo que la raíz de confianza **no** cubre, porque lo cubren otras pruebas:
- **Código ajeno que P carga por su configuración** (mods, hooks): es B1a, la política
  administrada.
- **Contenido** (A4b): atribución del backend.
- **Disponibilidad**: el agente siempre puede matar P.

## 3. Opciones

### L0. Esquema actual: el CLI lo lanza tmux y el gateway lee `/proc` después

Hoy la persona (o el agente) escribe `claude` en un pane. El proceso desciende del servidor tmux y
del shell, que pertenecen al uid del agente. **No cumple L1, L3 ni L4**: el agente puede preparar un
padre que lo trace antes del `exec`, darle un entorno con `LD_PRELOAD`, o lanzar otra copia. El
gateway no tiene cómo distinguir ese proceso de uno legítimo. Descartado como raíz de confianza.

### L1. Supervisor en el host que lanza el CLI con `docker exec` (recomendada)

**Quién lanza.** Un supervisor en el host lanza el CLI de cada sesión de agente. Es un daemon
pequeño de root, el mismo componente que el gateway de §1.14.4; su ubicación es la decisión 4 de
§1.14.13.
- Lo lanza con `docker exec -t` y **sin pasar por tmux**.
- `argv` y `envp` son fijos.
- El ejecutable es la copia de root de la imagen, con versión fijada (R9).
- `DISABLE_AUTOUPDATER=1` y `DISABLE_UPDATES=1`.

**Registro de lanzamiento.** Con `docker exec inspect` el supervisor obtiene el pid del host. En el
mismo paso abre un pidfd y comprueba `starttime`, el inodo del ejecutable, `TracerPid=0` y el
cgroup del contenedor. Guarda el registro de forma durable, con el patrón de `recreateAttempt.ts`.

**Por qué cumple L4.** El proceso que crea `runc exec` tiene como padre a containerd-shim (o a
`runc`). Ningún proceso uid 1000 es su ancestro, así que, con `ptrace_scope=1`:
- nadie del agente puede adjuntarse a P (ATTACH);
- nadie puede abrir su `mem`;
- nadie puede usar `process_vm_readv` ni `pidfd_getfd`.

Eso vale **aun sin H-ND**. Los hijos de P (Bash, MCP, hooks) son descendientes y Yama no les deja
trazar a su ancestro. H-ND queda como defensa en profundidad, no como requisito.

**Inscripción.** El gateway recibe la conexión y obtiene el pid del host por `SO_PEERCRED`
(B0, §1.14.13). Busca el registro con ese pid y `starttime`, con el pidfd vivo. Verifica:
- que el ejecutable sea el mismo inodo;
- que `TracerPid` valga 0;
- el cgroup.

Recién entonces entrega el material de inscripción (B2). Una conexión de un CLI que no está en el
registro queda `unverified`, aunque sea el mismo binario.

### L2. Lanzador dentro del contenedor + ptrace denegado + H-ND

**Cómo se lanza:**
- El pane de tmux ejecuta un lanzador **estático** de root `0711`: no usa `ld.so`, así que
  ignora `LD_PRELOAD`.
- El lanzador abre la conexión al gateway **antes** de su `exec`.
- El gateway lo inscribe por su ejecutable: el inodo del lanzador.
- El lanzador hace `execve` del CLI de root `0711` con `argv` y `envp` fijos.
- El gateway comprueba después que el mismo pid, con el mismo `starttime`, ejecuta ahora el
  inodo del CLI.

**Exige también:**
- **`ptrace` denegado al uid del agente.** Con un perfil seccomp propio de las sesiones que
  niegue `ptrace`, `process_vm_readv/writev` y `pidfd_getfd`, o con `ptrace_scope=2` en todo el
  host. Si no, un padre preparado por el agente traza el lanzador antes del `exec` (§1).
- **H-ND.** Un ancestro preparado puede abrir `/proc/P/mem` (modo ATTACH, ancestro permitido por
  Yama) y seccomp no filtra `open`.

### L3. tmux bajo otro uid

Descartada. Con `CapDrop: ALL` y `no-new-privileges`, el servidor tmux no puede cambiar al uid del
CLI. El CLI y sus herramientas quedarían con el uid de tmux, y el problema sólo se mueve.

## 4. Comparación

| Aspecto | L0 (actual) | L1 supervisor + `docker exec` | L2 lanzador + seccomp + H-ND |
| --- | --- | --- | --- |
| L1 creador confiable | No | **Sí**, por construcción | Sí, por el registro previo al `exec` del lanzador |
| L3 `argv`/`envp` | Leídos después: no fiable | Fijados por el host | Fijados por el lanzador, que es código de root estático |
| L4 sin trazador ni ancestro del agente | No | **Sí**, sin cambiar seccomp ni Yama | Sólo con ptrace negado por seccomp (por sesión) o Yama 2 (todo el host) |
| Depende de H-ND | — | No (defensa en profundidad) | **Sí** |
| tmux | — | **El CLI de agente sale de tmux.** Se ve en un flujo de terminal propio que el supervisor sirve; las otras pestañas siguen en tmux | El CLI sigue en un pane de tmux |
| Composer 3.2 | Funciona | **Cambia el transporte**: el Composer escribe en el PTY del supervisor, no en `tmux load-buffer`/`paste-buffer`. Los registros de pane y `capture-pane` se rediseñan. Es un contrato nuevo, fuera de este diseño | **Se rompe la verificación de identidad**: `PANE_FACTS_SCRIPT` hace `readlink /proc/<pid>/exe` como uid 1000 y, con H-ND, recibe EACCES (sale con 3). Habría que mover esa lectura al host |
| Herramientas del agente (gdb, strace) | Sí | Sí | **No**: seccomp las niega en toda la sesión, o Yama 2 en todo el host |
| Recreación del contenedor | — | El CLI muere con el contenedor; el supervisor lo relanza al iniciar el nuevo (con `--resume` si hay conversación) | Igual; el pane relanza el lanzador |
| Reinicio del backend | — | **No afecta si el supervisor es un daemon aparte.** Si vive en el backend, el flujo `docker exec` se pierde: Docker no permite volver a adjuntarse a un exec (#444) y el CLI hay que relanzarlo | No afecta al CLI; el registro del gateway se pierde ⇒ `unverified` hasta relanzar |
| Reinicio del supervisor o gateway | — | Se pierde el PTY ⇒ relanzar con `--resume`. Los registros durables permiten **explicar** qué pasó, nunca readoptar la verificación | Se pierde el registro ⇒ `unverified` hasta relanzar |
| El CLI termina (`/exit`, crash) | — | El pidfd lo informa. El supervisor relanza por acción de la persona o automáticamente con `--resume` | Lo relanza la persona en el pane |
| Autoactualización | El CLI del workspace se actualiza solo | No aplica: binario de root fijado y `DISABLE_UPDATES` en el entorno fijo. Actualizar = imagen nueva + revalidación (R9). Una copia actualizada por el agente nunca se inscribe | Igual que L1 |
| Un `claude` que escribe la persona en otra pestaña | — | Funciona, sin evidencia verificada. La UI lo muestra como no verificado | Igual |
| Superficie nueva en el host | — | Un daemon root (supervisor + gateway) con `docker exec` y `/proc` del host | Un gateway root, más un perfil seccomp por sesión o Yama 2 |
| Costo de producto | — | Terminal y Composer del CLI de agente se rehacen | Sin depuradores en las sesiones y Composer adaptado |

## 5. Recomendación

**L1** como raíz de confianza del lanzamiento.
- **Por qué:**
  - es la única opción que cumple L1–L4 por construcción;
  - no depende de H-ND ni de relajar o endurecer seccomp o Yama;
  - deja a las herramientas del agente como están.
- **Lo que cuesta:**
  - el CLI de agente sale de tmux;
  - el Composer necesita otro transporte, en un contrato nuevo. Hoy no se toca: el Composer 3.2
    sigue igual y este diseño no lo cambia.
- **H-ND (B1b)** se mantiene como medición y defensa en profundidad. Su resultado ya no decide
  L1.

**Antes de implementar nada:**
1. **B1a** sigue igual: la raíz de confianza del lanzamiento no reemplaza a la política
   administrada. Un CLI bien lanzado puede cargar código ajeno por su configuración.
2. **B2** suma los ataques del lanzamiento contra el diseño elegido:
   - K1–K5 de §1.14.14.4;
   - un trazador previo al `exec` desde un ancestro preparado;
   - `LD_PRELOAD` sobre el lanzador o el CLI;
   - un CLI lanzado fuera del supervisor que se presenta con el mismo binario;
   - reutilización de pid;
   - un relanzamiento con `--resume`;
   - el reinicio del supervisor.
3. **Bun y `bunfig.toml`** (pendiente, H). Falta medir si el ejecutable autónomo de Bun lee
   `bunfig.toml` (por ejemplo, `preload`) del directorio de trabajo o de HOME. Si lo hace, es
   código dentro del proceso aunque el entorno sea fijo, y L1 tendría que fijar también el
   directorio de trabajo y HOME. Se agrega a K5.

## 6. Decisiones que se piden

1. L1 como dirección, o comparar L1 y L2 con un prototipo antes de decidir.
2. Dónde vive el supervisor/gateway: un daemon root aparte (recomendado, porque sobrevive a los
   reinicios del backend) o dentro del backend con `pid: host`.
3. Aceptar que el CLI de las sesiones de agente deje tmux (L1). Implica un contrato nuevo de
   Composer y de terminal para ese CLI, en una fase posterior.
