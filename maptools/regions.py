#!/usr/bin/env python3
"""The regions to build offline map packs for, as JSON for a GitHub Actions matrix: every English county
(Geofabrik's England sub-regions), plus Scotland and Wales. Each has an id, a name, and the Geofabrik addresses
of its extract and its boundary.

Usage: regions.py <geofabrik index-v1-nogeom.json> [--test]     (--test: only Rutland, the smallest)"""
import json
import sys

idx = json.load(open(sys.argv[1]))['features']
out = []
for f in idx:
    p = f['properties']
    if p.get('parent') == 'england' or p.get('id') in ('scotland', 'wales'):
        pbf = p['urls']['pbf']
        out.append({'id': p['id'], 'name': p['name'], 'pbf': pbf, 'poly': pbf.replace('-latest.osm.pbf', '.poly')})
if '--test' in sys.argv:
    out = [r for r in out if r['id'] == 'rutland']
out.sort(key=lambda r: r['id'])
print(json.dumps(out))
