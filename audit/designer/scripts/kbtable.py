import json,sys
rows=[json.loads(l) for l in open(sys.argv[1])]
for r in sorted(rows,key=lambda r:(r['kind'],r['p'],float(r['step'].split('-')[0].replace('b','.5')))):
    if r['p'].startswith(('1280','1440')) and r['step'] not in ('0-rest','3-send1'): continue
    if r['step'] in ('3-send2','2-kb-nopan'): continue
    t=r.get('thread') or {}; c=r.get('composer') or {}; h=r.get('header') or {}; n=r.get('nav') or {}; b=r.get('bar') or {}
    print(f"{r['kind'][:3]} {r['p']:12} {r['step'][:14]:14} vv={r['vvH']}/{r['vvTop']} bar={b.get('top','-')}-{b.get('bottom','-')} th={t.get('top','-')}+{t.get('h','-')} g={t.get('gap','-')} cmp={c.get('top','-')}-{c.get('bottom','-')} nav={n.get('top','-')} f={int(r['focusIn'])} a={r['anchorTop']} sc={','.join(r.get('scrolled',[]))}")
