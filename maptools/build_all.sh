#!/usr/bin/env bash
# Builds every offline map pack: one per English county (Geofabrik's England sub-regions), plus Scotland and Wales.
# Used by .github/workflows/maps.yml. With TEST=1 it only builds Rutland (the smallest), as a quick check.
# Map data © OpenStreetMap contributors (ODbL), downloaded from Geofabrik (download.geofabrik.de).
set -euo pipefail
OUT=${OUT:-packs}; WORK=${WORK:-work}
mkdir -p "$OUT" "$WORK"
GF=https://download.geofabrik.de/europe/united-kingdom
UA="leafdash-maps (github.com/A2405U/Leafdash)"
HERE=$(cd "$(dirname "$0")" && pwd)

# Keep only what the Drive screen uses (the same as the app's Overpass query). Referenced nodes come too.
roads() {
  osmium tags-filter --overwrite "$1" \
    w/highway=motorway,trunk,primary,secondary,tertiary,unclassified,residential,living_street,motorway_link,trunk_link,primary_link,secondary_link,tertiary_link,service \
    n/highway=traffic_signals,crossing,mini_roundabout,speed_camera,red_light_camera n/enforcement n/man_made=surveillance \
    r/type=enforcement -o "$2"
}

curl -fsSL -A "$UA" https://download.geofabrik.de/index-v1-nogeom.json -o "$WORK/index.json"
# English counties: id, name, polygon address
python3 - "$WORK/index.json" > "$WORK/counties.tsv" <<'PY'
import json, sys
for f in json.load(open(sys.argv[1]))['features']:
    p = f['properties']
    if p.get('parent') == 'england':
        print(f"{p['id']}\t{p['name']}\t{p['urls']['pbf'].replace('-latest.osm.pbf', '.poly')}")
PY
echo "$(wc -l < "$WORK/counties.tsv") English counties"

if [ "${TEST:-}" = 1 ]; then
  curl -fsSL -A "$UA" "$GF/england/rutland-latest.osm.pbf" -o "$WORK/rutland.osm.pbf"
  curl -fsSL -A "$UA" "$GF/england/rutland.poly" -o "$WORK/rutland.poly"
  roads "$WORK/rutland.osm.pbf" "$WORK/rutland-roads.osm.pbf"
  python3 "$HERE/build_pack.py" "$WORK/rutland-roads.osm.pbf" "$OUT/rutland.ldmap" rutland Rutland "$WORK/rutland.poly"
else
  # England: one download, filtered once, then cut into counties in a single pass
  curl -fsSL -A "$UA" "$GF/england-latest.osm.pbf" -o "$WORK/england.osm.pbf"
  roads "$WORK/england.osm.pbf" "$WORK/england-roads.osm.pbf"
  rm "$WORK/england.osm.pbf"
  mkdir -p "$WORK/poly" "$WORK/counties"
  python3 - "$WORK" <<'PY' > "$WORK/extract.json"
import json, sys
work = sys.argv[1]
ex = []
for line in open(f'{work}/counties.tsv'):
    cid, name, poly = line.rstrip('\n').split('\t')
    ex.append({'output': f'{cid}.osm.pbf', 'polygon': {'file_name': f'{work}/poly/{cid}.poly', 'file_type': 'poly'}})
print(json.dumps({'directory': f'{work}/counties', 'extracts': ex}))
PY
  while IFS=$'\t' read -r cid name poly; do curl -fsSL -A "$UA" "$poly" -o "$WORK/poly/$cid.poly"; done < "$WORK/counties.tsv"
  osmium extract --overwrite -c "$WORK/extract.json" "$WORK/england-roads.osm.pbf"
  while IFS=$'\t' read -r cid name poly; do
    python3 "$HERE/build_pack.py" "$WORK/counties/$cid.osm.pbf" "$OUT/$cid.ldmap" "$cid" "$name" "$WORK/poly/$cid.poly"
  done < "$WORK/counties.tsv"
  for nation in scotland wales; do
    curl -fsSL -A "$UA" "$GF/$nation-latest.osm.pbf" -o "$WORK/$nation.osm.pbf"
    curl -fsSL -A "$UA" "$GF/$nation.poly" -o "$WORK/$nation.poly"
    roads "$WORK/$nation.osm.pbf" "$WORK/$nation-roads.osm.pbf"
    rm "$WORK/$nation.osm.pbf"
    python3 "$HERE/build_pack.py" "$WORK/$nation-roads.osm.pbf" "$OUT/$nation.ldmap" "$nation" "${nation^}" "$WORK/$nation.poly"
  done
fi

# The list the app shows: id, name, size, build date
python3 - "$OUT" > "$OUT/index.json" <<'PY'
import gzip, json, os, sys
out = sys.argv[1]
packs = []
for f in sorted(os.listdir(out)):
    if not f.endswith('.ldmap'):
        continue
    with gzip.open(os.path.join(out, f), 'rt', encoding='utf-8') as g:
        h = json.loads(g.readline())
    packs.append({'id': h['region'], 'name': h['name'], 'bytes': os.path.getsize(os.path.join(out, f)), 'built': h['built'], 'tiles': h['tiles'], 'ways': h['ways']})
print(json.dumps({'format': 'leafdash map index v1', 'source': 'Map data © OpenStreetMap contributors, ODbL', 'packs': packs}, indent=1))
PY
ls -la "$OUT"
