#!/bin/bash
# usage: mkupd.sh <version> <prefix> "<notes>"  → parts + latest.json in /mnt/user-data/outputs/upd_<prefix>
set -e; cd /home/claude/mac; V=$1; P=$2; N=$3; D=/mnt/user-data/outputs/upd_$P
rm -rf "$D" && mkdir -p "$D"
tar czf /tmp/ws_app.tar.gz -C out "Waypoint Studio.app"
SHA=$(sha256sum /tmp/ws_app.tar.gz | cut -d' ' -f1)
( cd "$D" && split -b 25m /tmp/ws_app.tar.gz "${P}.0" ) && rm /tmp/ws_app.tar.gz
PARTS=$(cd "$D" && ls ${P}.0* | python3 -c "import sys,json;print(json.dumps([l.strip() for l in sys.stdin]))")
# light package: program only (core.js + www), installed into userData/live/<version> by the running app
SHELLV=$(grep -o "const SHELL = [0-9]*" appsrc/main.js | grep -o "[0-9]*$")
L=/tmp/ws_light; rm -rf $L && mkdir -p $L && AP="out/Waypoint Studio.app/Contents/Resources/app"
cp "$AP/core.js" $L/ && cp -r "$AP/www" $L/www && rm -f $L/www/config.js
python3 -c "import json;json.dump({'version':'$V','shell':$SHELLV},open('$L/manifest.json','w'))"
tar czf "$D/${P}.light.tgz" -C $L . && LSHA=$(sha256sum "$D/${P}.light.tgz" | cut -d' ' -f1)
python3 -c "import json,sys;json.dump({'version':'$V','shell':$SHELLV,'light':{'file':'${P}.light.tgz','sha256':'$LSHA'},'parts':$PARTS,'sha256':'$SHA','notes':sys.argv[1]},open('$D/latest.json','w'),ensure_ascii=False,indent=1)" "$N"
ls -la "$D/${P}.light.tgz"
cat "$D/latest.json"
