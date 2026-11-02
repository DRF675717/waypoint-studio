#!/bin/bash
# usage: build.sh <version>  → refresh out/Waypoint Studio.app from ws/app + appsrc, set version, sign (ad-hoc)
set -e; cd /home/claude/mac; V=$1; A="out/Waypoint Studio.app/Contents"
W="$A/Resources/app/www"; cp "$W/config.js" /tmp/ws_config.js; rm -rf "$W"; cp -r /home/claude/ws/app "$W"; rm -f "$W/server.js"; cp /tmp/ws_config.js "$W/config.js"
cp appsrc/main.js "$A/Resources/app/main.js"; cp appsrc/core.js "$A/Resources/app/core.js"; cp app-icon-master.icns "$A/Resources/app.icns"  # program icon (user pictogram) in every version
python3 - "$V" "$A" <<'P'
import sys,json,plistlib
v,a=sys.argv[1],sys.argv[2]
for p in ['appsrc/package.json',a+'/Resources/app/package.json']:
    j=json.load(open(p)); j['version']=v; json.dump(j,open(p,'w'),ensure_ascii=False,indent=2)
pl=plistlib.load(open(a+'/Info.plist','rb')); pl['CFBundleShortVersionString']=v; pl['CFBundleVersion']=v
pl['NSLocationUsageDescription']=pl['NSLocationWhenInUseUsageDescription']='Waypoint Studio определяет страну, чтобы автоматически выбрать официальные карты геозон, и показывает ваше место на карте.'
plistlib.dump(pl,open(a+'/Info.plist','wb'))
P
N=$(ls sign*.log | sed 's/[^0-9]//g' | sort -n | tail -1); N=$((N+1))
./apple-codesign-0.29.0-x86_64-unknown-linux-musl/rcodesign sign "out/Waypoint Studio.app" > sign$N.log 2>&1 || { tail sign$N.log; exit 1; }
echo built $V; tail -2 sign$N.log
