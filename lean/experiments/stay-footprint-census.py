#!/usr/bin/env python3
"""How far a stay's stepped minutes go from the stay, against the walks that
leave one.

Over the narrated days (every truth row that enforces, whatever the decoder
does with it): each run of stepped minutes (at least STEP steps) inside a
narrated stay, and each narrated walk that begins or ends at a narrated stay.
For both, the farthest fix from the stay's own centre (the median of its
still minutes' fixes) over the run's minutes, and for a walk over its first
or last minutes beside the stay. Printed as quantiles by run length: what a
term on a stay's footprint would have to separate.

Run from the repo root, over the requests as the decoder receives them
(`cargo run --release --example dump_decode_request -- <day>-<user>`, one
`<day>-<user>.json` per frozen day in DIR):
  python3 lean/experiments/stay-footprint-census.py DIR
"""
import datetime, glob, json, math, os, re, statistics, sys, zoneinfo

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
G = f"{ROOT}/tests/golden"
STEP = 30
ACC = 60  # a fix worse than this says little about where in a building he is

def dist(a, b, c, d):
    p1, p2 = math.radians(a), math.radians(c)
    h = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(d - b) / 2) ** 2
    return 2 * 6371000 * math.asin(math.sqrt(h))

def rows_of(path):
    txt = open(path).read()
    tz = "Europe/London"
    m = re.search(r"Times?:\s*([A-Za-z]+/[A-Za-z_]+)", txt)
    if m: tz = m[1]
    elif re.search(r"Times?:.*UTC", txt): tz = "UTC"
    out = []
    for line in txt.splitlines():
        m = re.match(r"\|\s*(\d\d):(\d\d)\s*[–-]\s*(\d\d):(\d\d)\s*\|\s*([^|]+)\|\s*([^|]+)\|", line)
        if not m: continue
        status = m[6].strip()
        if not re.match(r"(correct|wrong)\b", status): continue
        if not re.search(r"\{(user|corroborated|derived)\}", line): continue
        truth = m[5].strip().replace("**", "")
        mode = truth.split()[0].lower()
        if mode not in ("walking", "stationary"): continue
        place = truth.split("@", 1)[1].strip() if "@" in truth else None
        a, b = int(m[1]) * 60 + int(m[2]), int(m[3]) * 60 + int(m[4])
        if b <= a: b += 1440
        out.append((a, b, mode, place))
    return tz, out

stepped, walks, walkrad = [], [], []
for md in sorted(glob.glob(f"{G}/ground-truth/2026-*.md")):
    day = os.path.basename(md)[:10]
    found = glob.glob(f"{sys.argv[1]}/{day}-*.json")
    if not found: continue
    fx = found[0]
    req = json.load(open(fx))
    o = req["observation"]
    tz, rows = rows_of(md)
    zi = zoneinfo.ZoneInfo(tz)
    d0 = datetime.datetime.fromisoformat(day).replace(tzinfo=zi)
    mm = lambda ts: int((ts - d0.timestamp()) // 60)
    steps = {}
    for s in o["steps"]:
        steps[mm(s["ts"])] = steps.get(mm(s["ts"]), 0) + s["steps"]
    fixes = {}
    for p in o["points"]:
        if p.get("accuracyM", 0) <= ACC: fixes.setdefault(mm(p["ts"]), []).append((p["lat"], p["lon"]))
    def rad(lo, hi):
        pts = [p for t in range(lo, hi) for p in fixes.get(t, [])]
        if len(pts) < 2: return None
        cx = sum(a for a, _ in pts) / len(pts); cy = sum(b for _, b in pts) / len(pts)
        return math.sqrt(sum(dist(cx, cy, a, b) ** 2 for a, b in pts) / len(pts))
    def far(c, lo, hi):
        ds = [dist(c[0], c[1], a, b) for t in range(lo, hi) for a, b in fixes.get(t, [])]
        return max(ds) if ds else None
    centres = []
    for a, b, mode, place in rows:
        if mode != "stationary": centres.append(None); continue
        pts = [p for t in range(a, b) if steps.get(t, 0) < STEP for p in fixes.get(t, [])]
        centres.append((statistics.median(x for x, _ in pts), statistics.median(y for _, y in pts)) if len(pts) >= 3 else None)
    for (a, b, mode, place), c in zip(rows, centres):
        if mode != "stationary" or c is None: continue
        t = a
        while t < b:
            if steps.get(t, 0) >= STEP:
                u = t
                while u < b and steps.get(u, 0) >= STEP: u += 1
                if t > a and u < b:  # inside the stay, not at its edges
                    stepped.append((u - t, far(c, t, u), day, t, place, rad(t, u)))
                t = u
            else: t += 1
    for i, (a, b, mode, place) in enumerate(rows):
        if mode != "walking": continue
        for k in (1, 2, 3, 5, 10):
            for lo in range(a, b - k + 1, max(1, k)):
                r = rad(lo, lo + k)
                if r is not None: walkrad.append((k, r, day, lo))
        for j, side in ((i - 1, "start"), (i + 1, "end")):
            if not 0 <= j < len(rows) or rows[j][2] != "stationary" or centres[j] is None: continue
            if abs((rows[j][1] if side == "start" else rows[j][0]) - (a if side == "start" else b)) > 2: continue
            for k in (2, 3, 5, 10):
                if b - a < k: continue
                lo, hi = (a, a + k) if side == "start" else (b - k, b)
                walks.append((k, far(centres[j], lo, hi), day, lo, side))

def q(xs, f): return sorted(xs)[min(len(xs) - 1, int(f * len(xs)))]
print(f"stepped runs inside narrated stays (>= {STEP} steps a minute, fixes <= {ACC} m):")
for lo, hi in ((1, 1), (2, 3), (4, 10), (11, 999)):
    xs = [f for n, f, *_ in stepped if lo <= n <= hi and f is not None]
    nofix = sum(1 for n, f, *_ in stepped if lo <= n <= hi and f is None)
    if xs: print(f"  {lo:2d}-{hi:3d} min  n {len(xs):3d} (+{nofix} fixless)  farthest m: q50 {q(xs,.5):6.0f} q90 {q(xs,.9):6.0f} q99 {q(xs,.99):6.0f} max {max(xs):6.0f}")
print("narrated walks beside a narrated stay, over their first/last k minutes:")
for k in (2, 3, 5, 10):
    xs = [f for kk, f, *_ in walks if kk == k and f is not None]
    if xs: print(f"  k {k:2d}  n {len(xs):3d}  farthest m: q01 {q(xs,.01):6.0f} q10 {q(xs,.1):6.0f} q50 {q(xs,.5):6.0f}")
print("RMS radius of the fixes about their centre, by run length (stays' stepped runs; walks' k-minute windows):")
for lo, hi, k in ((1, 1, 1), (2, 3, 2), (2, 3, 3), (4, 10, 5), (4, 10, 10)):
    xs = [r for n, f, d, t, pl, r in stepped if lo <= n <= hi and r is not None]
    ws = [r for kk, r, *_ in walkrad if kk == k]
    if xs and ws:
        print(f"  stay runs {lo}-{hi} min n {len(xs):3d}: q50 {q(xs,.5):5.0f} q90 {q(xs,.9):5.0f} q99 {q(xs,.99):5.0f}   walk windows {k:2d} min n {len(ws):4d}: q01 {q(ws,.01):5.0f} q10 {q(ws,.1):5.0f} q50 {q(ws,.5):5.0f}")
print("the widest stepped runs:")
for n, f, day, t, place, r in sorted((x for x in stepped if x[1] is not None), key=lambda x: -x[1])[:12]:
    print(f"  {day} {t//60:02d}:{t%60:02d} {n:3d} min {f:6.0f} m  {place}")
print("the tightest walk ends (k=3):")
for k, f, day, t, side in sorted((x for x in walks if x[0] == 3 and x[1] is not None), key=lambda x: x[1])[:12]:
    print(f"  {day} {t//60:02d}:{t%60:02d} {side:5s} {f:6.0f} m")
