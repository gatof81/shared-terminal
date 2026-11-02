# Mobile soft keyboard — how the app follows it, and how to validate on a real iPhone

Playwright cannot raise a real keyboard, and Chromium never pans the visual
viewport the way iOS Safari does. `frontend/e2e/keyboard.spec.ts` replaces
`window.visualViewport` with a stand-in and proves the app *follows* the two
numbers Safari reports; whether Safari reports them as expected, and when, can
only be checked on the device. This page is that check.

## What the app does

- `main.ts` mirrors `visualViewport.height` into `--app-vh` (body height) and
  `visualViewport.offsetTop` into `--app-top` (body `translateY`). To reveal a
  focused field Safari pans the visual viewport instead of scrolling the page,
  so without the offset the app sits that far above the keyboard.
- `--app-top` follows both `resize` and `scroll` of the visual viewport (a pan
  can change the offset without changing the height). It is ignored under a
  pinch zoom (`visualViewport.scale ≠ 1`: the offset is then the reader panning
  the magnified page) and bounded by `innerHeight − visualViewport.height`
  (at scale 1 the visual viewport lies inside the layout one), so an offset
  Safari might still report after the keyboard closes cannot push the app down.
  Whether Safari ever does report such a stale offset is not known; the bound
  makes it harmless either way.
- `html[data-kb="open"]` is set while the visual viewport is more than 120 px
  shorter than the layout viewport; `base.css` then drops the bottom safe-area
  padding (the home indicator is under the keyboard).
- While Files, Git or Chat covers the terminal, the terminal keeps its geometry
  (`terminalGeometry.ts`): no fit, no tmux resize. Returning to the Terminal
  view runs one fit, which sends one resize only if the size changed.

## Measuring on the device

1. On a Mac: Safari → Settings → Advanced → "Show features for web developers".
   On the iPhone: Settings → Safari → Advanced → Web Inspector on. Connect by
   cable; the page appears under Develop → (iPhone name).
2. Open the app (`https://terminal.lamia.casa/`, and again with `?ui=v2`), sign
   in, open a session, go to Chat and open a conversation.
3. Paste in the Web Inspector console (or save as a bookmarklet with a
   `javascript:` prefix) — it overlays the live numbers and never sends
   anything anywhere:

```js
(()=>{const d=document.createElement('pre');Object.assign(d.style,{position:'fixed',top:'0',left:'0',zIndex:99999,background:'#000c',color:'#0f0',font:'11px monospace',margin:0,padding:'4px',pointerEvents:'none'});document.body.append(d);const f=()=>{const vv=visualViewport,cs=getComputedStyle(document.documentElement),ta=document.querySelector('.chat-composer textarea'),nav=document.getElementById('view-nav');const b=e=>e?Math.round(e.getBoundingClientRect().bottom):'-';d.textContent=`scrollY ${scrollY} inner ${innerHeight}\nvv.h ${Math.round(vv.height)} vv.top ${Math.round(vv.offsetTop)}\n--app-vh ${cs.getPropertyValue('--app-vh')} --app-top ${cs.getPropertyValue('--app-top')} kb ${document.documentElement.dataset.kb||'-'}\nta.bottom ${b(ta)} nav.top ${nav&&!nav.hidden?Math.round(nav.getBoundingClientRect().top):'-'}\nkbTop ${Math.round(vv.offsetTop+vv.height)}`};f();visualViewport.addEventListener('resize',f);visualViewport.addEventListener('scroll',f);setInterval(f,500)})()
```

## What to check (both shells, Safari and the home-screen app)

| Step | Expected | If not |
|---|---|---|
| Tap the composer | keyboard opens; `kb open`; `ta.bottom` within a few px of `kbTop` (v2) or of `nav.top` (v1) | `vv.top` > 0 but the gap ≈ `vv.top`: the offset mirror is not applied — report the numbers |
| Same, read `scrollY` | stays `0` | Safari scrolled the layout viewport; report it (needs `scrollTo(0,0)` too) |
| Type 4 lines | the textarea grows; the last message stays visible (once the re-anchor PR lands) | the thread slides under the composer |
| Tap outside / Done | `kb -`, `--app-top 0px`, `ta.bottom` back where it was | numbers stuck: report them |
| Terminal view → note the rows (`stty size` in the pane) → Chat → open and close the keyboard 3× → Terminal | `stty size` unchanged while in Chat; at most one change on return, matching the visible area | any change while in Chat |
| Rotate the phone in Chat with the keyboard up | layout follows; no gap | report the numbers |
| With the keyboard up, tap another field (or drag the page slightly) | `vv.top` may change alone; the app follows it | the app lags behind the pan |
| Close the keyboard and read `vv.top` | `0`, or if not, `--app-top 0px` anyway | `--app-top` > 0 with the keyboard down |
| Pinch-zoom anywhere, pan around | the zoomed page pans normally; `--app-top 0px` | content chases the finger |

v1 keeps its bottom view bar above the keyboard while typing in Chat (about
54 px); that is expected in v1 and absent in v2.
