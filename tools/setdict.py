#!/usr/bin/env python3
"""Set English translations for exact Russian texts: tools/setdict.py <pairs.json>  ([[ru, en], ...]).
An existing entry for the same Russian text is replaced, otherwise the entry is added."""
import json, sys, os
p = os.path.join(os.path.dirname(__file__), '..', 'app', 'js', 'i18n-en.js')
d = open(p, encoding='utf-8').read()
jsq = lambda s: json.dumps(s, ensure_ascii=False)
for ru, en in json.load(open(sys.argv[1])):
    key = jsq(ru) + ':'
    lines = [l for l in d.split('\n') if not l.startswith(key)]
    d = '\n'.join(lines).rstrip().rstrip('};').rstrip() + '\n' + key + ' ' + jsq(en) + ',\n};\n'
open(p, 'w', encoding='utf-8').write(d)
print('ok')
