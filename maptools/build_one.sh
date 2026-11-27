#!/usr/bin/env bash
# Builds one offline map pack: download the region's extract and boundary from Geofabrik, keep only what the
# Drive screen uses (the same as the app's Overpass query; referenced nodes come too), then build_pack.py.
# Usage: build_one.sh <id> <name> <pbf address> <poly address> <output folder>
# Map data © OpenStreetMap contributors (ODbL).
set -euo pipefail
id=$1; name=$2; pbf=$3; poly=$4; out=$5
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
UA="leafdash-maps (github.com/A2405U/Leafdash)"
mkdir -p "$out"
curl -fsSL -A "$UA" "$pbf" -o "$work/in.osm.pbf"
curl -fsSL -A "$UA" "$poly" -o "$work/area.poly"
osmium tags-filter --overwrite "$work/in.osm.pbf" \
  w/highway=motorway,trunk,primary,secondary,tertiary,unclassified,residential,living_street,motorway_link,trunk_link,primary_link,secondary_link,tertiary_link,service \
  n/highway=traffic_signals,crossing,mini_roundabout,speed_camera,red_light_camera n/enforcement n/man_made=surveillance \
  r/type=enforcement -o "$work/roads.osm.pbf"
rm "$work/in.osm.pbf"
python3 "$(dirname "$0")/build_pack.py" "$work/roads.osm.pbf" "$out/$id.ldmap" "$id" "$name" "$work/area.poly"
ls -la "$out/$id.ldmap"
