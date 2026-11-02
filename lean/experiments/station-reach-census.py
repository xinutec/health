#!/usr/bin/env python3
"""Fixes against their station: during a narrated platform wait, in the minute
before a narrated ride, and in the ride's first minutes — the populations the
journey's board reach (`ServeEntry.journeyReachM`, 400 m by hand) separates.

Distance is to the station's nearest node of that name in the frozen decode's
own route graph. Run from the repo root:
  python3 lean/experiments/station-reach-census.py
"""
import json, glob, re, os, math, struct, datetime, zoneinfo, collections

G = "tests/golden"
f = lambda x: struct.unpack('<d', int(x).to_bytes(8, 'little'))[0] if isinstance(x, str) else float(x)
def hav(a, b, c, d):
    R = 6371000; p1, p2 = math.radians(a), math.radians(c); dp = p2 - p1; dl = math.radians(d - b)
    return 2 * R * math.asin(math.sqrt(math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2))
def norm(s): return re.sub(r"[^a-z]", "", (s or "").lower().replace("st.", "st").replace("&", "and"))

groups = collections.defaultdict(list)
for md in sorted(glob.glob(f"{G}/ground-truth/2026-*.md")):
    day = os.path.basename(md)[:10]
    found = glob.glob(f"{G}/decoded_days/{day}-*.json")
    if not found: continue
    dp = found[0]
    req = json.load(open(dp)).get("request")
    if not req: continue
    txt = open(md).read()
    tz = "Europe/London"; m = re.search(r"Times?:\s*([A-Za-z]+/[A-Za-z_]+)", txt)
    if m: tz = m[1]
    elif "Times: UTC" in txt: tz = "UTC"
    z = zoneinfo.ZoneInfo(tz); d0 = datetime.date.fromisoformat(day)
    nodes = collections.defaultdict(list)
    for n in req.get("nodes", []):
        if n.get("stationName"): nodes[norm(n["stationName"])].append((f(n["lat"]), f(n["lon"])))
    pts = sorted((p["ts"], f(p["lat"]), f(p["lon"])) for p in req["observation"]["points"])
    def dist_at(t0, t1, st, exact=False):
        ns = nodes.get(norm(st)) or (None if exact else next((v for k, v in nodes.items() if norm(st) in k or k in norm(st)), None))
        if not ns: return []
        return [min(hav(la, lo, a, b) for a, b in ns) for t, la, lo in pts if t0 <= t < t1]
    T = lambda h, mi: int(datetime.datetime(d0.year, d0.month, d0.day, h, mi, tzinfo=z).timestamp())
    for line in txt.splitlines():
        m = re.match(r"\|\s*(\d\d):(\d\d)\s*[–-]\s*(\d\d):(\d\d)\s*\|\s*([^|]+)\|\s*([^|]+)\|", line)
        if not m or not m[6].strip().startswith("correct"): continue
        a, b = T(int(m[1]), int(m[2])), T(int(m[3]), int(m[4]))
        truth = m[5].strip()
        w = re.match(r"stationary @ (.+)", truth)
        r = re.match(r"train (.+?) → (.+?)(?: ·|$)", truth.replace("**", ""))
        if w and "platform wait" in line:
            groups["wait"] += [d for st in w[1].split(" / ") for d in dist_at(a, b, st.strip(), exact=True)][:max(1, (b - a) // 20)]
        elif r:
            board = r[1].strip()
            groups["minute before ride"] += dist_at(a - 60, a, board)
            for k in range(3):
                groups[f"ride minute {k + 1}"] += dist_at(a + 60 * k, a + 60 * (k + 1), board)
q = lambda xs, p: sorted(xs)[min(len(xs) - 1, int(p * len(xs)))]
print("group                 n    q50   q90   q95   q99   max")
for g in ["wait", "minute before ride", "ride minute 1", "ride minute 2", "ride minute 3"]:
    xs = groups[g]
    if xs: print(f"{g:20s} {len(xs):4d} {q(xs,.5):6.0f} {q(xs,.9):5.0f} {q(xs,.95):5.0f} {q(xs,.99):5.0f} {max(xs):5.0f}")

# The departure test as a likelihood comparison: a wait's fix as a 2-D
# Gaussian about the station (Rayleigh in distance), a ride's second-minute
# fix as a lognormal in distance; "still at the station" while the wait's
# density is the larger. The crossover is the one fitted distance.
w = groups["wait"]
sig = math.sqrt(sum(x * x for x in w) / (2 * len(w)))
r2 = [x for x in groups["ride minute 2"] if x > 0]
mu = sum(math.log(x) for x in r2) / len(r2)
sd = math.sqrt(sum((math.log(x) - mu) ** 2 for x in r2) / len(r2))
ray = lambda d: math.log(d / sig ** 2) - d * d / (2 * sig * sig)
lgn = lambda d: -math.log(d * sd * math.sqrt(2 * math.pi)) - (math.log(d) - mu) ** 2 / (2 * sd * sd)
cross = next(d for d in range(1, 3000) if lgn(d) > ray(d) and d > sig)
print(f"wait: Rayleigh sigma {sig:.1f} m; ride minute 2: lognormal mu {mu:.2f} sd {sd:.2f}; crossover {cross} m")
for d in (150, 244, 369, 400):
    print(f"  at {d} m: log p_wait {ray(d):.1f}, log p_ride {lgn(d):.1f}")
