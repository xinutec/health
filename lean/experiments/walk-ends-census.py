#!/usr/bin/env python3
"""A walk's first and last minutes against the stay they leave or reach.

For every narrated walk that borders a narrated stay, the decoder's own rows
(emissionDebug) give each minute's pair speed to the next minute; printed, per
offset from the boundary (1 = the walk's minute beside the stay), the pair
speeds' quartiles and the share below 4 km/h — the population the stay's pair
model, with its outlier share, must refuse for the stay not to absorb the
walk's ends.

Run from the repo root:
  python3 lean/experiments/walk-ends-census.py <dir of req-<date>.json dumps>
"""
import datetime, glob, json, os, re, subprocess, sys, zoneinfo

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CLI = f"{ROOT}/lean/.lake/build/bin/verified_cli"
scr = sys.argv[1]
days = json.load(open(f"{ROOT}/tests/golden/fits/decoder-params.json"))["provenance"]["days"]

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
        mode = m[5].strip().split()[0].lower()
        if mode not in ("walking", "stationary"): continue
        a, b = int(m[1]) * 60 + int(m[2]), int(m[3]) * 60 + int(m[4])
        if b <= a: b += 1440
        out.append((a, b, mode))
    return tz, out

def ts_of(day, tz, mm):
    z = zoneinfo.ZoneInfo(tz); d = datetime.date.fromisoformat(day) + datetime.timedelta(days=mm // 1440)
    return int(datetime.datetime(d.year, d.month, d.day, (mm % 1440) // 60, mm % 60, tzinfo=z).timestamp())

by_off = {}   # offset -> list of (pairKmh, side)
for day in days:
    reqp = f"{scr}/req-{day}.json"
    if not os.path.exists(reqp): continue
    tz, rows = rows_of(day)
    if not rows: continue
    req = json.load(open(reqp)); req["mode"] = "assemblesegments"
    start = req["observation"]["startUtc"]
    req["emissionDebug"] = {"fromTs": start, "toTs": start + 1440 * 60}
    r = subprocess.run([CLI, "serve"], input=json.dumps(req), capture_output=True, text=True)
    try:
        ed = json.loads(r.stdout.strip().splitlines()[-1])["result"]["emissionDebug"]
    except Exception as e:
        print(day, "serve failed", e, file=sys.stderr); continue
    pair = {o["ts"]: o.get("pairKmh") for o in ed}
    rows.sort()
    for i, (a, b, mode) in enumerate(rows):
        if mode != "walking": continue
        # the stay before (its end = the walk's start) and after
        before = any(r2[2] == "stationary" and r2[1] == a for r2 in rows)
        after = any(r2[2] == "stationary" and r2[0] == b for r2 in rows)
        n = b - a
        for k in range(1, min(4, n) + 1):
            if before:
                v = pair.get(ts_of(day, tz, a + k - 1))
                if v is not None: by_off.setdefault(("start", k), []).append(v)
            if after:
                v = pair.get(ts_of(day, tz, b - k))
                if v is not None: by_off.setdefault(("end", k), []).append(v)
    print(day, "done", file=sys.stderr)

def q(xs, p):
    xs = sorted(xs); return xs[min(len(xs) - 1, int(p * len(xs)))]
print("side offset    n   q25   q50   q75   share<4km/h   share<2km/h")
for side in ("start", "end"):
    for k in range(1, 5):
        xs = by_off.get((side, k), [])
        if not xs: continue
        print(f"{side:5s} {k:6d} {len(xs):4d} {q(xs,.25):5.1f} {q(xs,.5):5.1f} {q(xs,.75):5.1f}   {sum(1 for x in xs if x < 4)/len(xs):10.2f}   {sum(1 for x in xs if x < 2)/len(xs):10.2f}")
