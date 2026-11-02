#!/usr/bin/env python3
"""Replace a Russian interface text in the sources and keep the English dictionary in step.
Usage: tools/retip.py <pairs.json>   — [[ru_old, ru_new, en_new], ...]
ru_old is replaced everywhere in app/js/*.js and app/index.html (must occur at least once);
the dictionary entry for ru_old is removed and ru_new → en_new is added."""
import json, sys, glob, os
ROOT = os.path.join(os.path.dirname(__file__), '..', 'app')
pairs = json.load(open(sys.argv[1]))
files = [f for f in glob.glob(os.path.join(ROOT, 'js', '*.js')) if not f.endswith('i18n-en.js')] + [os.path.join(ROOT, 'index.html')]
src = {f: open(f, encoding='utf-8').read() for f in files}
dpath = os.path.join(ROOT, 'js', 'i18n-en.js'); d = open(dpath, encoding='utf-8').read()
def jsq(s): return json.dumps(s, ensure_ascii=False)
def esc_in_js(s): return s.replace('\\', '\\\\').replace("'", "\\'").replace('\n', '\\n')
bad = 0
for old, new, en in pairs:
    hit = 0
    for f in files:
        js = f.endswith('.js')
        # in JS sources a one-line text sits in a quoted string: its new version must be escaped; a multi-line one
        # (template literal) keeps real line breaks
        for o, n in ((old, new if not js or '\n' in old else esc_in_js(new)), (esc_in_js(old), esc_in_js(new))):
            if o in src[f]: src[f] = src[f].replace(o, n); hit += 1; break
    if not hit: print('NOT FOUND:', old[:80]); bad += 1; continue
    # drop the old dictionary line, add the new one
    lines = d.split('\n'); key = jsq(old) + ':'
    lines = [l for l in lines if not l.startswith(key)]
    d = '\n'.join(lines)
    d = d.rstrip().rstrip('};').rstrip() + '\n' + jsq(new) + ': ' + jsq(en) + ',\n};\n'
for f in files: open(f, 'w', encoding='utf-8').write(src[f])
open(dpath, 'w', encoding='utf-8').write(d)
print('done', len(pairs) - bad, 'of', len(pairs))
sys.exit(1 if bad else 0)
