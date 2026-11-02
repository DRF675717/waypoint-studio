#!/bin/bash
# usage: mklight.sh <version> <prefix> <full-prefix> "<notes>" → light-only release: program (core.js + www) as one small file;
# the full parts of the last full build (upd_<full-prefix>) stay in latest.json for machines that need the whole app
set -e; cd /home/claude/mac; V=$1; P=$2; FP=$3; N=$4; D=/mnt/user-data/outputs/upd_$P; F=/mnt/user-data/outputs/upd_$FP/latest.json
rm -rf "$D" && mkdir -p "$D"
SHELLV=$(grep -o "const SHELL = [0-9]*" appsrc/main.js | grep -o "[0-9]*$")
L=/tmp/ws_light; rm -rf $L && mkdir -p $L && cp appsrc/core.js $L/ && cp -r /home/claude/ws/app $L/www && rm -f $L/www/config.js $L/www/server.js
python3 -c "import json;json.dump({'version':'$V','shell':$SHELLV},open('$L/manifest.json','w'))"
tar czf "$D/${P}.light.tgz" -C $L . && LSHA=$(sha256sum "$D/${P}.light.tgz" | cut -d' ' -f1)
python3 - "$F" "$D/latest.json" "$V" "$SHELLV" "${P}.light.tgz" "$LSHA" "$N" <<'P'
import json,sys
f,out,v,sh,lf,ls,n=sys.argv[1:]
full=json.load(open(f))
json.dump({'version':v,'shell':int(sh),'light':{'file':lf,'sha256':ls},'parts':full['parts'],'sha256':full['sha256'],'fullVersion':full.get('fullVersion',full['version']),'notes':n},open(out,'w'),ensure_ascii=False,indent=1)
P
ls -la "$D"; cat "$D/latest.json"
