#!/usr/bin/env python3
"""Minutes against their stay's place: the distance distribution that the
stay's position term (`Emissions.placeTerm`, σ 150 m, floor −3) should be
fitted from, and the one it must refuse.

For every narrated stay at a named place (matched to the request's places by
name), the decoder's own minute fixes: distance from the place for the stay's
minutes (still, and stepped at 30+ steps), and for the first/last four minutes
of a narrated walk bordering that stay. Quartiles, q90, q99 per group.

Run from the repo root:
  python3 lean/experiments/stay-distance-census.py <dir of req-<date>.json dumps>
"""
import datetime, json, math, os, re, struct, subprocess, sys, zoneinfo

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CLI = f"{ROOT}/lean/.lake/build/bin/verified_cli"
scr = sys.argv[1]
days = json.load(open(f"{ROOT}/tests/golden/fits/decoder-params.json"))["provenance"]["days"]

def f(x):
    return struct.unpack('<d', int(x).to_bytes(8, 'little'))[0] if isinstance(x, str) else float(x)
def hav(a, b, c, d):
    R = 6371000; p1, p2 = math.radians(a), math.radians(c); dp = p2 - p1; dl = math.radians(d - b)
    x = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(x))

def rows_of(day):
    p = f"{ROOT}/tests/golden/ground-truth/{day}.md"
    if not os.path.exists(p): return None, []
    txt = open(p).read()
    tz = "Europe/London"
    m = re.search(r"Times?:\s*([A-Za-z]+/[A-Za-z_]+)", txt)
    if m: tz = m[1]
    elif re.search(r"Times?:.*UTC", txt) or "declares UTC" in txt: tz = "UTC"
    out = []
    for line in txt.splitlines():
        m = re.match(r"\|\s*(\d\d):(\d\d)\s*[–-]\s*(\d\d):(\d\d)\s*\|\s*([^|]+)\|\s*([^|]+)\|", line)
        if not m or not m[6].strip().startswith("correct"): continue
        truth = m[5].strip(); mode = truth.split()[0].lower()
        if mode not in ("walking", "stationary"): continue
        place = None
        pm = re.match(r"stationary\s*@\s*([^(]+)", truth)
        if pm: place = pm[1].strip().lower()
        a, b = int(m[1]) * 60 + int(m[2]), int(m[3]) * 60 + int(m[4])
        if b <= a: b += 1440
        out.append((a, b, mode, place))
    return tz, out

def ts_of(day, tz, mm):
    z = zoneinfo.ZoneInfo(tz); d = datetime.date.fromisoformat(day) + datetime.timedelta(days=mm // 1440)
    return int(datetime.datetime(d.year, d.month, d.day, (mm % 1440) // 60, mm % 60, tzinfo=z).timestamp())

groups = {}
def add(g, v): groups.setdefault(g, []).append(v)
for day in days:
    reqp = f"{scr}/req-{day}.json"
    if not os.path.exists(reqp): continue
    tz, rows = rows_of(day)
    if not rows: continue
    req = json.load(open(reqp))
    places = [(p.get("name", "").lower(), f(p["lat"]), f(p["lon"])) for p in req.get("places", []) if p.get("name")]
    def coord(name):
        if not name: return None
        for n, la, lo in places:
            if n == name or name in n or n in name: return (la, lo)
        return None
    req["mode"] = "assemblesegments"
    start = req["observation"]["startUtc"]
    req["emissionDebug"] = {"fromTs": start, "toTs": start + 1440 * 60}
    r = subprocess.run([CLI, "serve"], input=json.dumps(req), capture_output=True, text=True)
    try:
        ed = json.loads(r.stdout.strip().splitlines()[-1])["result"]["emissionDebug"]
    except Exception as e:
        print(day, "serve failed", e, file=sys.stderr); continue
    by_ts = {o["ts"]: o for o in ed}
    rows.sort()
    for a, b, mode, place in rows:
        if mode != "stationary": continue
        c = coord(place)
        if c is None: continue
        for mm in range(a, b):
            o = by_ts.get(ts_of(day, tz, mm))
            if not o or o.get("lat") is None: continue
            d = hav(o["lat"], o["lon"], *c)
            add("stay still" if (o.get("cadence") or 0) < 30 else "stay stepped 30+", d)
        for a2, b2, mode2, _ in rows:
            if mode2 != "walking": continue
            if b2 == a:   # walk arriving at this stay
                for k in range(1, 5):
                    o = by_ts.get(ts_of(day, tz, b2 - k))
                    if o and o.get("lat") is not None: add(f"walk end {k}", hav(o["lat"], o["lon"], *c))
            if a2 == b:   # walk leaving this stay
                for k in range(1, 5):
                    o = by_ts.get(ts_of(day, tz, a2 + k - 1))
                    if o and o.get("lat") is not None: add(f"walk start {k}", hav(o["lat"], o["lon"], *c))
    print(day, "done", file=sys.stderr)

def q(xs, p):
    xs = sorted(xs); return xs[min(len(xs) - 1, int(p * len(xs)))]
print("group                 n     q25    q50    q75    q90    q99")
for g in ["stay still", "stay stepped 30+"] + [f"walk start {k}" for k in range(1, 5)] + [f"walk end {k}" for k in range(1, 5)]:
    xs = groups.get(g, [])
    if xs: print(f"{g:20s} {len(xs):5d}  {q(xs,.25):6.0f} {q(xs,.5):6.0f} {q(xs,.75):6.0f} {q(xs,.9):6.0f} {q(xs,.99):6.0f}")
