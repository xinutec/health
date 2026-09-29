"""Which coordinate should NAME a stay that elected a mined place? (#325)

For every stationary stay in the corpus that elected a mined place, measure the
day's own centroid against the place's stored centroid: the offset between them,
the spread of the day's fixes, the place radius, and how far each candidate
coordinate (day, mined, precision-weighted blend) lies from the venue the user
confirmed and from the venue the fold served.

Inputs: /tmp/dayout/<fixture name>.json (`backend day <fixture>` per corpus day, same file names),
tests/golden/days/*.json, /tmp/truth-rows.jsonl (TRUTH_ROWS_OUT from the truth grader).
Output goes to stdout only — it carries coordinates."""
import json, glob, math, os, re, sys, time, collections

GOLD = os.path.join(os.path.dirname(__file__), '..', '..', 'tests', 'golden', 'days')

def norm(s): return re.sub(r'\s+', ' ', (s or '').strip().lower())

def hav(lat1, lon1, lat2, lon2):
    R = 6371008.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp/2)**2 + math.cos(p1)*math.cos(p2)*math.sin(dl/2)**2
    return 2*R*math.asin(math.sqrt(a))

def local_xy(lat0, lon0, lat, lon):
    return ((lon - lon0) * 111320 * math.cos(math.radians(lat0)), (lat - lat0) * 111320)

def dist_to_poly(lat, lon, coords):
    """Metres from (lat, lon) to a polyline; 0 when inside a closed ring."""
    pts = [local_xy(lat, lon, a, b) for a, b in coords]
    if len(pts) >= 3 and coords[0] == coords[-1]:
        inside = False
        for i in range(len(pts) - 1):
            (x1, y1), (x2, y2) = pts[i], pts[i+1]
            if (y1 > 0) != (y2 > 0) and 0 < x1 + (0 - y1) * (x2 - x1) / (y2 - y1):
                inside = not inside
        if inside: return 0.0
    best = float('inf')
    for i in range(len(pts)):
        x1, y1 = pts[i]
        if i + 1 < len(pts):
            x2, y2 = pts[i+1]
            dx, dy = x2 - x1, y2 - y1
            t = max(0.0, min(1.0, -(x1*dx + y1*dy) / (dx*dx + dy*dy))) if dx or dy else 0.0
            px, py = x1 + t*dx, y1 + t*dy
        else:
            px, py = x1, y1
        best = min(best, math.hypot(px, py))
    return best

def venue_features(fixture):
    """name -> list of (kind, payload): point (lat, lon) or ring (coords)."""
    out = collections.defaultdict(list)
    rs = fixture['inputs']['osmRowSet']
    for p in rs['points']:
        if p.get('name'): out[norm(p['name'])].append(('pt', (p['lat'], p['lon'])))
    for l in rs['lines']:
        if l.get('name'):
            coords = json.loads(l['coords']) if isinstance(l['coords'], str) else l['coords']
            out[norm(l['name'])].append(('ring', coords))
    return out

def dist_to_named(feats, name, lat, lon):
    cands = feats.get(norm(name))
    if not cands:
        # a truth like "Currys" against an OSM "Currys PC World"
        cands = [c for k, v in feats.items() if norm(name) in k for c in v]
    if not cands: return None
    ds = []
    for kind, payload in cands:
        ds.append(hav(lat, lon, *payload) if kind == 'pt' else dist_to_poly(lat, lon, payload))
    return min(ds)

def load_rows():
    rows = collections.defaultdict(list)
    for l in open('/tmp/truth-rows.jsonl'):
        j = json.loads(l); rows[j['date']].extend(j['rows'])
    return rows

def truth_for(rows, s, e):
    best = None
    for r in rows:
        t = r.get('truth') or {}
        if t.get('mode') not in ('stationary', 'sleeping') or not t.get('place'): continue
        if (r.get('provenance') or '') != 'user': continue
        ov = min(e, r['endTs']) - max(s, r['startTs'])
        if ov <= 0: continue
        if best is None or ov > best[0]: best = (ov, t['place'], r.get('status'))
    return best

SPREAD_FLOOR_M = 10.0

def blend(day, spread, mined, radius):
    wd = 1 / max(spread, SPREAD_FLOOR_M) ** 2
    wp = 1 / max(radius, SPREAD_FLOOR_M) ** 2
    return ((day[0]*wd + mined[0]*wp) / (wd + wp), (day[1]*wd + mined[1]*wp) / (wd + wp))

def main():
    rows_by_date = load_rows()
    only = set(sys.argv[1:])
    hdr = f"{'date':10} {'utc':5} {'served':26} {'truth':24} {'st':5} {'n':>3} {'off':>5} {'spr':>5} {'acc':>4} {'days':>4} {'slp':>4} {'label':14} | {'T@day':>6} {'T@min':>6} {'T@bl':>6} | {'S@day':>6} {'S@min':>6} {'S@bl':>6}"
    print(hdr)
    for out in sorted(glob.glob('/tmp/dayout/*.json')):
        name = os.path.basename(out)
        date = name[:10]
        if only and date not in only: continue
        try: r = json.load(open(out))
        except Exception: continue
        fx = json.load(open(os.path.join(GOLD, name)))
        fixes = fx['inputs']['phonetrack']['today'] + fx['inputs']['phonetrack']['morning'] + fx['inputs']['phonetrack']['priorEvening']
        places = {p['id']: p for p in fx['inputs']['knownPlaces']}
        feats = venue_features(fx)
        for seg in r.get('segsEnriched') or []:
            if seg.get('mode') != 'stationary' or seg.get('focusPlaceId') is None: continue
            pl = places.get(seg['focusPlaceId'])
            if pl is None: continue
            s, e = seg['startTs'], seg['endTs']
            inw = [f for f in fixes if s <= f['ts'] <= e]
            if not inw: continue
            dlat = sum(f['lat'] for f in inw) / len(inw); dlon = sum(f['lon'] for f in inw) / len(inw)
            spread = math.sqrt(sum(hav(dlat, dlon, f['lat'], f['lon'])**2 for f in inw) / len(inw))
            accs = sorted(f['accuracy'] for f in inw if f.get('accuracy') is not None)
            acc = accs[len(accs)//2] if accs else float('nan')
            mined = (pl['centroidLat'], pl['centroidLon'])
            off = hav(dlat, dlon, *mined)
            bl = blend((dlat, dlon), spread, mined, pl['radiusM'])
            tr = truth_for(rows_by_date.get(date, []), s, e)
            truth = tr[1] if tr else ''
            st = tr[2] if tr else ''
            served = seg.get('place') or ''
            def d(name, c):
                v = dist_to_named(feats, name, *c) if name else None
                return f"{v:6.1f}" if v is not None else f"{'-':>6}"
            print(f"{date:10} {time.strftime('%H:%M', time.gmtime(s)):5} {served[:26]:26} {truth[:24]:24} {st[:5]:5} {len(inw):3d} {off:5.0f} {spread:5.1f} {acc:4.0f} {pl['uniqueDays']:4.0f} {pl['sleepHours']:4.0f} {(pl.get('amenityLabel') or '-')[:14]:14} | {d(truth,(dlat,dlon))} {d(truth,mined)} {d(truth,bl)} | {d(served,(dlat,dlon))} {d(served,mined)} {d(served,bl)}")

if __name__ == '__main__':
    main()
