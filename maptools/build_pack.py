#!/usr/bin/env python3
"""Make a Leaf Dash offline map pack from an OpenStreetMap extract (.osm.pbf).

Keeps only what the Drive screen draws: drivable roads (with the tags it reads), traffic lights, crossings,
mini-roundabouts, and speed and red-light cameras. Everything else is left out, which makes a county a few MB.

The pack is gzipped JSON Lines:
  line 1   header: format, region id and name, build date, source and licence, tile size, counts
  then     one line per tile: {"k": "<row>,<col>", "f": 1, "e": [elements]}
           "f": 1 marks a tile entirely inside the region (from its boundary), so the app knows it has every road
           there, even when there are none (a field or a lake: "e" is then empty). Tiles on the boundary have no "f".
Elements are compact versions of what the Overpass servers return (offmap.js turns them back):
  way      {"w": id, "n": [node ids], "g": [lat, lon, lat, lon, ...], "t": {tags}}
  node     {"p": id, "a": lat, "o": lon, "t": {tags}}
  relation {"r": id, "t": {tags}, "m": [[node id, role, lat, lon], ...]}   (camera enforcement, device members)
A way is stored in every tile it passes through, so a tile on its own always has whole roads.

Map data © OpenStreetMap contributors, under the Open Database License (ODbL). A pack is a derived database and
is published under the same licence.

Usage: build_pack.py <input.osm.pbf> <output.ldmap> <region id> "<Region name>" [<boundary.poly>]
"""
import datetime
import gzip
import json
import math
import sys

import osmium

TILE_LAT, TILE_LON = 0.02, 0.032          # about 2.2 × 2.2 km in the UK; offmap.js must use the same
HW = {'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street',
      'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link', 'service'}   # = OSM_HW
WAY_TAGS = {'highway', 'name', 'ref', 'maxspeed', 'maxspeed:forward', 'maxspeed:backward', 'lanes',
            'lanes:forward', 'lanes:backward', 'oneway', 'junction'}
NODE_TAGS = {'highway', 'crossing', 'crossing_ref', 'crossing:signals', 'speed_camera', 'enforcement', 'man_made',
             'surveillance', 'surveillance:type', 'note', 'description', 'name'}
REL_TAGS = {'type', 'enforcement', 'maxspeed', 'note', 'description', 'name'}
NODE_HW = {'traffic_signals', 'crossing', 'mini_roundabout', 'speed_camera', 'red_light_camera'}


def read_poly(path):
    """An Osmosis .poly boundary: a list of (ring, is_hole), each ring a list of (lon, lat)."""
    rings, cur, hole = [], None, False
    with open(path) as f:
        lines = [x.strip() for x in f][1:]                # first line is the name
    for x in lines:
        if not x:
            continue
        if cur is None:
            if x == 'END':
                break
            cur, hole = [], x.startswith('!')
        elif x == 'END':
            rings.append((cur, hole))
            cur = None
        else:
            lon, lat = map(float, x.split()[:2])
            cur.append((lon, lat))
    return rings


def inside(rings, lon, lat):
    """Point in polygon (even-odd over every ring, so holes work)."""
    c = False
    for ring, _ in rings:
        j = len(ring) - 1
        for i in range(len(ring)):
            xi, yi = ring[i]
            xj, yj = ring[j]
            if (yi > lat) != (yj > lat) and lon < (xj - xi) * (lat - yi) / (yj - yi) + xi:
                c = not c
            j = i
    return c


def full_tiles(rings):
    """Tiles entirely inside the boundary. Uses shapely (fast) when it's installed."""
    try:
        from shapely.geometry import Polygon, box
        from shapely.ops import unary_union
        from shapely.prepared import prep
    except ImportError:
        return full_tiles_slow(rings)
    outer = unary_union([Polygon(r).buffer(0) for r, hole in rings if not hole and len(r) >= 3])
    holes = [Polygon(r).buffer(0) for r, hole in rings if hole and len(r) >= 3]
    area = outer.difference(unary_union(holes)) if holes else outer
    shape = prep(area)
    lon0, lat0, lon1, lat1 = area.bounds
    out = set()
    for r in range(math.floor(lat0 / TILE_LAT), math.floor(lat1 / TILE_LAT) + 1):
        for c in range(math.floor(lon0 / TILE_LON), math.floor(lon1 / TILE_LON) + 1):
            s, w = r * TILE_LAT, c * TILE_LON
            if shape.contains(box(w, s, w + TILE_LON, s + TILE_LAT)):
                out.add(f'{r},{c}')
    return out


def full_tiles_slow(rings):
    """Without shapely: all four corners and the middle inside (close enough at 2 km, but slow for big areas)."""
    pts = [p for r, _ in rings for p in r]
    lon0, lon1 = min(p[0] for p in pts), max(p[0] for p in pts)
    lat0, lat1 = min(p[1] for p in pts), max(p[1] for p in pts)
    out = set()
    for r in range(math.floor(lat0 / TILE_LAT), math.floor(lat1 / TILE_LAT) + 1):
        for c in range(math.floor(lon0 / TILE_LON), math.floor(lon1 / TILE_LON) + 1):
            s, w = r * TILE_LAT, c * TILE_LON
            corners = [(w, s), (w + TILE_LON, s), (w, s + TILE_LAT), (w + TILE_LON, s + TILE_LAT), (w + TILE_LON / 2, s + TILE_LAT / 2)]
            if all(inside(rings, x, y) for x, y in corners):
                out.add(f'{r},{c}')
    return out


def tile(lat, lon):
    return f'{math.floor(lat / TILE_LAT)},{math.floor(lon / TILE_LON)}'


def keep(tags, allowed):
    return {t.k: t.v for t in tags if t.k in allowed}


def is_feature(t):
    """Nodes the Drive screen shows: the same ones the Overpass query asks for."""
    return (t.get('highway') in NODE_HW or 'enforcement' in t
            or (t.get('man_made') == 'surveillance' and any(x in t.get('surveillance', '') for x in ('red_light', 'traffic'))))


class Devices(osmium.SimpleHandler):
    """Pass 1: the camera nodes that enforcement relations point at."""
    def __init__(self):
        super().__init__()
        self.ids = set()

    def relation(self, r):
        if r.tags.get('type') == 'enforcement':
            self.ids.update(m.ref for m in r.members if m.type == 'n' and m.role == 'device')


class Pack(osmium.SimpleHandler):
    """Pass 2: roads and features, sorted into tiles."""
    def __init__(self, devices):
        super().__init__()
        self.devices, self.device_at = devices, {}
        self.tiles = {}
        self.counts = {'ways': 0, 'nodes': 0, 'relations': 0}

    def add(self, key, el):
        self.tiles.setdefault(key, []).append(el)

    def node(self, n):
        if not n.location.valid():
            return
        lat, lon = round(n.location.lat, 6), round(n.location.lon, 6)
        if n.id in self.devices:
            self.device_at[n.id] = (lat, lon)
        t = keep(n.tags, NODE_TAGS)
        if t and is_feature(t):
            self.add(tile(lat, lon), {'p': n.id, 'a': lat, 'o': lon, 't': t})
            self.counts['nodes'] += 1

    def way(self, w):
        if w.tags.get('highway') not in HW or w.tags.get('area') == 'yes':
            return
        ids, g, keys = [], [], set()
        prev = None
        for nd in w.nodes:
            if not nd.location.valid():
                return                                   # cut off at the extract's edge: skip, the neighbour has it
            lat, lon = round(nd.location.lat, 6), round(nd.location.lon, 6)
            ids.append(nd.ref)
            g += [lat, lon]
            keys.add(tile(lat, lon))
            if prev:                                     # a long straight piece can cross a tile with no point in it
                steps = int(max(abs(lat - prev[0]) / TILE_LAT, abs(lon - prev[1]) / TILE_LON) * 2)
                for i in range(1, steps + 1):
                    f = i / (steps + 1)
                    keys.add(tile(prev[0] + (lat - prev[0]) * f, prev[1] + (lon - prev[1]) * f))
            prev = (lat, lon)
        if len(ids) < 2:
            return
        el = {'w': w.id, 'n': ids, 'g': g, 't': keep(w.tags, WAY_TAGS)}
        for k in keys:
            self.add(k, el)
        self.counts['ways'] += 1

    def relation(self, r):
        if r.tags.get('type') != 'enforcement':
            return
        m = [[x.ref, x.role, *self.device_at[x.ref]] for x in r.members
             if x.type == 'n' and x.role == 'device' and x.ref in self.device_at]
        if not m:
            return
        el = {'r': r.id, 't': keep(r.tags, REL_TAGS), 'm': m}
        for k in {tile(x[2], x[3]) for x in m}:
            self.add(k, el)
        self.counts['relations'] += 1


def main(src, out, region, name, poly=None):
    dev = Devices()
    dev.apply_file(src)
    pack = Pack(dev.ids)
    pack.apply_file(src, locations=True)
    full = full_tiles(read_poly(poly)) if poly else set()
    for k in full:
        pack.tiles.setdefault(k, [])                     # empty but known: no roads there
    head = {'format': 'leafdash map pack v1', 'region': region, 'name': name,
            'built': datetime.date.today().isoformat(),
            'source': 'Map data © OpenStreetMap contributors, available under the Open Database License (ODbL)',
            'tile': [TILE_LAT, TILE_LON], 'tiles': len(pack.tiles), 'full': len(full), **pack.counts}
    with gzip.open(out, 'wt', encoding='utf-8', compresslevel=9) as f:
        f.write(json.dumps(head, separators=(',', ':')) + '\n')
        for k in sorted(pack.tiles):
            line = {'k': k, **({'f': 1} if k in full else {}), 'e': pack.tiles[k]}
            f.write(json.dumps(line, separators=(',', ':'), ensure_ascii=False) + '\n')
    print(json.dumps(head))


if __name__ == '__main__':
    if len(sys.argv) not in (5, 6):
        sys.exit(__doc__)
    main(*sys.argv[1:])
