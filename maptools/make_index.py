#!/usr/bin/env python3
"""Writes index.json, the list of packs the app shows: id, name, size, build date. Usage: make_index.py <folder>"""
import gzip
import json
import os
import sys

out = sys.argv[1]
packs = []
for f in sorted(os.listdir(out)):
    if not f.endswith('.ldmap'):
        continue
    with gzip.open(os.path.join(out, f), 'rt', encoding='utf-8') as g:
        h = json.loads(g.readline())
    packs.append({'id': h['region'], 'name': h['name'], 'bytes': os.path.getsize(os.path.join(out, f)),
                  'built': h['built'], 'tiles': h['tiles'], 'ways': h['ways']})
with open(os.path.join(out, 'index.json'), 'w') as f:
    json.dump({'format': 'leafdash map index v1', 'source': 'Map data © OpenStreetMap contributors, ODbL', 'packs': packs}, f, indent=1)
print(f'{len(packs)} packs, {sum(p["bytes"] for p in packs) / 1e6:.1f} MB in all')
