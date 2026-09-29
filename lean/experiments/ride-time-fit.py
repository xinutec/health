#!/usr/bin/env python3
"""Fit the station chain's ride-time model to the confirmed tube rides (#238).

    DECODE_REQUEST_OUT=/tmp/dreq cargo nextest run --release -p backend --test hsmm_decode_corpus
    ride-time-fit.py /tmp/dreq tests/golden/ground-truth

Every narrative row `train A → B · L Line` with status `correct` is a ride of
known line, stations and window. The along-track path is the shortest path on
L's edges between the two stations' footprints (nodes within 200 m, as the
chain's `stationFootprintNodes`); the intermediate calls come from L's stop
relations (fewest over its relations, either direction). The model is
`minutes = km / run_kmh * 60 + stop_min * calls + fixed_min`, fitted at the
LOWER QUARTILE: a window includes the platform wait by the narrative
convention, so waits only lengthen it.
"""
import glob
import heapq
import json
import math
import os
import re
import struct
import sys

req_dir, truth_dir = sys.argv[1], sys.argv[2]


def fb(x):
    return struct.unpack('<d', int(x).to_bytes(8, 'little'))[0] if isinstance(x, str) else float(x)


def hav(a, b):
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dl, dp = math.radians(b[1] - a[1]), p2 - p1
    return 2 * 6371000 * math.asin(math.sqrt(math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2))


def norm(n):
    n = n.lower().replace('st.', 'st').replace("'", '').replace('’', '')
    n = re.sub(r'\b(underground|station|london)\b', '', n)
    return re.sub(r'\s+', ' ', n).strip()


adj, coords, stations, rels = {}, {}, {}, {}
for f in glob.glob(os.path.join(req_dir, '*.json')):
    r = json.load(open(f))
    if 'edges' not in r:
        continue
    for e in r['edges']:
        g = [(fb(p['lat']), fb(p['lon'])) for p in e['geometry']]
        length = sum(hav(g[i], g[i + 1]) for i in range(len(g) - 1))
        for line in e['lineMemberships']:
            adj.setdefault(line, {}).setdefault(e['startNode'], {})[e['endNode']] = length
            adj[line].setdefault(e['endNode'], {})[e['startNode']] = length
        coords[e['startNode']], coords[e['endNode']] = g[0], g[-1]
    for n in r['nodes']:
        if n['stationName']:
            stations.setdefault(norm(n['stationName']), []).append((fb(n['lat']), fb(n['lon'])))
    for rel in r.get('railStopRelations') or []:
        rels[rel['osmRelationId']] = rel


def calls(line, a, b):
    best = None
    for r in rels.values():
        if r['lineRef'] != line:
            continue
        names = [norm(s['name']) for s in r['stops']]
        if norm(a) in names and norm(b) in names:
            hops = abs(names.index(norm(a)) - names.index(norm(b)))
            if hops and (best is None or hops - 1 < best):
                best = hops - 1
    return best


def footprint(line, st):
    return [n for n in adj.get(line, {}) if any(hav(coords[n], s) <= 200 for s in stations.get(norm(st), []))]


def track_m(line, a, b):
    src, dst = footprint(line, a), set(footprint(line, b))
    dist = {n: 0 for n in src}
    pq = [(0, n) for n in src]
    while pq:
        d, n = heapq.heappop(pq)
        if n in dst:
            return d
        if d > dist.get(n, 1e18):
            continue
        for m, w in adj[line].get(n, {}).items():
            if d + w < dist.get(m, 1e18):
                dist[m] = d + w
                heapq.heappush(pq, (d + w, m))
    return None


rides = []
row = re.compile(r'^\|\s*(\d\d):(\d\d)\s*[–-]\s*(\d\d):(\d\d)\s*\|\s*train (.+?) → (.+?) · (.+?) Line\s*\|\s*correct')
for f in sorted(glob.glob(os.path.join(truth_dir, '*.md'))):
    for text in open(f):
        m = row.match(text)
        if not m:
            continue
        h1, m1, h2, m2, a, b, line = m.groups()
        minutes = int(h2) * 60 + int(m2) - int(h1) * 60 - int(m1)
        k, p = calls(line, a.strip(), b.strip()), track_m(line + ' Line', a.strip(), b.strip())
        if k is not None and p and minutes >= 4:
            rides.append((minutes, k, p))

best = None
for v in range(30, 121, 2):
    for s in [x / 20 for x in range(0, 41)]:
        for c in [x / 4 for x in range(-8, 17)]:
            loss = sum(max(0.25 * e, -0.75 * e) for e in (mn - (p / 1000 / v * 60 + s * k + c) for mn, k, p in rides))
            if best is None or loss < best[0]:
                best = (loss, v, s, c)
print(f'{len(rides)} rides: run {best[1]} km/h, {best[2]} min per call, {best[3]} min fixed (q25 loss {best[0]:.1f})')
