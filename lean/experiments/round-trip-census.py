#!/usr/bin/env python3
"""Walks that come back to where they left, by length.

Over the narrated days (every enforcing truth row): each narrated walk with a
narrated stay on both sides, whether the two stays are at the same place, its
length, and the distance between its two anchors — the lit minute before the
walk and the one after it, which the decoder's segment statistics carry
(`Stats.anchorW`). Printed: per length bucket, how many walks return to the
place they left and how many go elsewhere, and the anchor distances of each.

Run from the repo root, over the decoder's requests (one `<day>-<user>.json`
per frozen day in DIR, `dump_decode_request`):
  python3 lean/experiments/round-trip-census.py DIR
"""
import datetime, glob, json, math, os, re, statistics, sys, zoneinfo

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
G = f"{ROOT}/tests/golden"

def rows_of(path):
    txt = open(path).read()
    tz = "Europe/London"
    m = re.search(r"Times?:\s*([A-Za-z]+/[A-Za-z_]+)", txt)
    if m: tz = m[1]
    elif re.search(r"Times?:.*UTC", txt): tz = "UTC"
    out = []
    for line in txt.splitlines():
        m = re.match(r"\|\s*(\d\d):(\d\d)\s*[–-]\s*(\d\d):(\d\d)\s*\|\s*([^|]+)\|\s*([^|]+)\|", line)
        if not m or not re.match(r"(correct|wrong)\b", m[6].strip()): continue
        if not re.search(r"\{(user|corroborated|derived)\}", line): continue
        truth = m[5].strip().replace("**", "")
        mode = truth.split()[0].lower()
        place = re.sub(r"\s*\(.*?\)\s*$", "", truth.split("@", 1)[1]).strip() if "@" in truth else None
        a, b = int(m[1]) * 60 + int(m[2]), int(m[3]) * 60 + int(m[4])
        if b <= a: b += 1440
        out.append((a, b, mode, place))
    return tz, out

def dist(p, q):
    p1, p2 = math.radians(p[0]), math.radians(q[0])
    h = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(q[1] - p[1]) / 2) ** 2
    return 2 * 6371000 * math.asin(math.sqrt(h))

same, other = [], []
for md in sorted(glob.glob(f"{G}/ground-truth/2026-*.md")):
    day = os.path.basename(md)[:10]
    found = glob.glob(f"{sys.argv[1]}/{day}-*.json")
    if not found: continue
    o = json.load(open(found[0]))["observation"]
    tz, rows = rows_of(md)
    d0 = datetime.datetime.fromisoformat(day).replace(tzinfo=zoneinfo.ZoneInfo(tz))
    mm = lambda ts: int((ts - d0.timestamp()) // 60)
    per = {}
    for p in o["points"]: per.setdefault(mm(p["ts"]), []).append(p)
    mins = {t: (statistics.median(p["lat"] for p in ps), statistics.median(p["lon"] for p in ps)) for t, ps in per.items()}
    lit = sorted(mins)
    for i in range(1, len(rows) - 1):
        a, b, mode, _ = rows[i]
        pa, pb = rows[i - 1], rows[i + 1]
        if mode != "walking" or pa[2] != "stationary" or pb[2] != "stationary": continue
        if abs(pa[1] - a) > 2 or abs(pb[0] - b) > 2: continue
        if not pa[3] or not pb[3]: continue
        before = [t for t in lit if t < a]
        after = [t for t in lit if t >= b]
        anchor = dist(mins[before[-1]], mins[after[0]]) if before and after else None
        (same if pa[3] == pb[3] else other).append((b - a, anchor, day, a, pa[3], pb[3]))

print("narrated walks between two narrated stays, by length:")
for lo, hi in ((1, 2), (3, 5), (6, 10), (11, 20), (21, 999)):
    s = [x for x in same if lo <= x[0] <= hi]; o = [x for x in other if lo <= x[0] <= hi]
    sa = sorted(x[1] for x in s if x[1] is not None); oa = sorted(x[1] for x in o if x[1] is not None)
    med = lambda xs: f"{xs[len(xs)//2]:6.0f}" if xs else "     -"
    print(f"  {lo:2d}-{hi:3d} min: back to the same place {len(s):3d} (anchors apart, median {med(sa)} m)   elsewhere {len(o):3d} (median {med(oa)} m)")
print("the walks back to the same place:")
for d, an, day, a, p, q in sorted(same):
    print(f"  {day} {a//60:02d}:{a%60:02d} {d:3d} min  anchors {an if an is None else round(an)} m  {p}")
