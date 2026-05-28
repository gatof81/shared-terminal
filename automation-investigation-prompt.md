Home-automation investigation — find why two lights misbehaved and surface any other issues you spot in passing.

## Stack
- **Home Assistant** running on a Proxmox VM. Mosquitto broker and zigbee2mqtt run inside HA as add-ons.
- **Node-RED** on its own Proxmox VM, talking to HA's broker over MQTT and probably HA over the WebSocket API too.
- Credentials for HA (long-lived token + URL) and Node-RED (URL + basic-auth) should already be in this session's env. If they're not, stop and ask before guessing.

## Symptoms (last few days, exact timestamps unknown — grep wide)
1. **`light.cochera`** (garage) stayed ON for ~1 hour and had to be turned off manually. The automation that normally turns it off did not fire / did not reach the bulb.
2. **`light.espejos`** (bathroom mirrors) intermittently does not respond to its presence sensor. Multiple misses over the past few days, not a one-off.

## What to check — in this order

1. **HA logbook + automation traces** for `light.cochera` and `light.espejos` across the last 5 days.
   - `GET /api/logbook/<isoStartTime>?entity=light.cochera` and same for `light.espejos`.
   - `GET /api/config/automation/trace/<automation_id>` for any automation that targets either light — were they triggered? Did they fail at a condition? Were they skipped because the light state was wrong in HA's view but right at the bulb?
2. **zigbee2mqtt log + device state** for the two lights and the presence sensor:
   - z2m log (HA add-on log, or `/config/zigbee2mqtt/log/*/log.txt`) — look for `LinkQuality`, `lastSeen`, `Publish 'set' 'state'` for the cochera light around the stuck-on hour, and for the espejos sensor across the misses.
   - z2m bridge state via MQTT: `zigbee2mqtt/bridge/devices` and `zigbee2mqtt/bridge/info`. Flag any device with `power_source: Battery` and low `battery`, or `availability: offline`, or `linkquality < 40`.
   - Network map (`zigbee2mqtt/bridge/request/networkmap`) — look for nodes that lost their parent or are routing through a flaky repeater.
3. **Mosquitto broker** — anything dropping?
   - HA add-on log for Mosquitto. Look for client disconnect/reconnect spam, "client exceeded timeout", queued-message drops, or auth failures from the Node-RED VM in the relevant window.
4. **Node-RED** — is it actually the one running these flows?
   - `GET /flows` (with basic auth) and search the flow JSON for the two entity IDs. If a flow targets either light, fetch its `/debug/messages` (if exposed) or the Node-RED log on the VM for errors around the failures.
   - Check Node-RED uptime — did the VM or the runtime restart in the window? An MQTT-in node that didn't reconnect cleanly will silently miss messages.
5. **Anything else suspicious** you notice in passing — not a deep dive, just flag it:
   - Disabled / errored automations.
   - Entities `unavailable` for >1h.
   - z2m devices that have not reported in days but are "supposed" to be active.
   - Coordinator firmware / z2m version warnings.
   - Mosquitto retained-message bloat or auth-list mismatches between HA and the Node-RED user.
   - Time skew between HA VM and Node-RED VM (NTP drift breaks "after X minutes" automations).

## Output shape
Return a findings report using this repo's convention (`### [SEVERITY] headline` / Where / What / Why it matters / Fix), one block per finding. Severities:
- **BLOCKER** — an automation/device is broken right now and won't self-heal.
- **SHOULD-FIX** — the likely cause of the cochera / espejos misses, even if the device is fine right this moment.
- **NIT** — incidental cleanup.

End with a one-paragraph summary tying findings back to the two reported failures: which finding(s) most likely caused the cochera stuck-on, which the espejos misses, and whether they share a root cause.

Do **not** make changes — diagnosis only. If you'd recommend a fix that requires touching a flow or automation, describe it; don't apply it.
