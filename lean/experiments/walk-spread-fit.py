#!/usr/bin/env python3
"""A walk's spread against moving about inside a place.

The decoder's segment statistics carry the lit minutes' weighted positions
(`SegmentEmission.withPositions`: each minute's median fix, weight
`1 / (sigmaM² + accuracy²)`), so a segment's RMS radius about its own weighted
centre is free. Two narrated populations, every enforcing truth row whatever
the decoder does with it:
  W  whole narrated walks;
  M  runs of stepped minutes (at least STEP steps) inside a narrated stay,
     not at its edges: moving about the place.
Each population's log radius is fitted as `a + b·log d + N(0, s)` over the
segment length d (minutes) by least squares, which is the maximum likelihood
of that form, one width shared so the log-odds is monotone in the radius.
Printed: the fits, and per case the term a walk segment would
pay, `log fW(r|d) − log (fW(r|d) + fM(r|d))` (a flat prior over the two
explanations; ≤ 0, near 0 for a walk that goes somewhere).

`--extent` reads `sqrt(r² + (D/2)²)` in place of `r`, `D` the decoder's net
displacement window: a walk trimmed at its ends still goes somewhere.

Run from the repo root, over the decoder's requests (one `<day>-<user>.json`
per frozen day in DIR, `dump_decode_request`):
  python3 lean/experiments/walk-spread-fit.py DIR
"""
import datetime, glob, json, math, os, re, statistics, sys, zoneinfo

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
G = f"{ROOT}/tests/golden"
STEP = 30
SIGMA_M = 150.0   # Emissions.PLACE_RADIUS_M, the request carries no centreSigmaM
ACC_DEFAULT = 10.0  # Assemble.ACCURACY_DEFAULT_M
R_FLOOR = 1.0       # a radius below a metre is read as one


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
        mode = m[5].strip().replace("**", "").split()[0].lower()
        if mode not in ("walking", "stationary"): continue
        a, b = int(m[1]) * 60 + int(m[2]), int(m[3]) * 60 + int(m[4])
        if b <= a: b += 1440
        out.append((a, b, mode))
    return tz, out

def local(ref, lat, lon):
    return ((lon - ref[1]) * 111320 * math.cos(math.radians(ref[0])), (lat - ref[0]) * 111320)

EXTENT = "--extent" in sys.argv

def net(mins, lo, hi):
    """The decoder's net displacement window: the minute fix at or before the
    first minute to the one at or after the last (`SegmentEvidence.windowFor`)."""
    before = [t for t in mins if t <= lo]
    after = [t for t in mins if t >= hi - 1]
    if not before or not after: return None
    a, b = mins[max(before)], mins[min(after)]
    x1, y1 = a[0], a[1]; x2, y2 = b[0], b[1]
    p1, p2 = math.radians(x1), math.radians(x2)
    h = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(y2 - y1) / 2) ** 2
    return 2 * 6371000 * math.asin(math.sqrt(h))

def feature(mins, lo, hi, ref):
    r = radius(mins, lo, hi, ref)
    if r is None or not EXTENT: return r
    dn = net(mins, lo, hi)
    return None if dn is None else math.sqrt(r * r + (dn / 2) ** 2)

def radius(mins, lo, hi, ref):
    w = wx = wy = wrr = 0.0
    n = 0
    for t in range(lo, hi):
        g = mins.get(t)
        if g is None: continue
        x, y = local(ref, g[0], g[1])
        k = 1 / (SIGMA_M ** 2 + g[2] ** 2)
        w += k; wx += k * x; wy += k * y; wrr += k * (x * x + y * y); n += 1
    if n < 2: return None
    return math.sqrt(max(0.0, wrr - (wx * wx + wy * wy) / w) / w)

W, M = [], []
for md in sorted(glob.glob(f"{G}/ground-truth/2026-*.md")):
    day = os.path.basename(md)[:10]
    found = glob.glob(f"{sys.argv[1]}/{day}-*.json")
    if not found: continue
    fx = found[0]
    o = json.load(open(fx))["observation"]
    tz, rows = rows_of(md)
    d0 = datetime.datetime.fromisoformat(day).replace(tzinfo=zoneinfo.ZoneInfo(tz))
    mm = lambda ts: int((ts - d0.timestamp()) // 60)
    steps = {}
    for s in o["steps"]: steps[mm(s["ts"])] = steps.get(mm(s["ts"]), 0) + s["steps"]
    per = {}
    for p in o["points"]: per.setdefault(mm(p["ts"]), []).append(p)
    mins = {}
    for t, ps in per.items():
        accs = [p["accuracyM"] for p in ps if p.get("accuracyM") is not None]
        mins[t] = (statistics.median(p["lat"] for p in ps), statistics.median(p["lon"] for p in ps),
                   statistics.median(accs) if accs else ACC_DEFAULT)
    if not mins: continue
    ref = next(iter(mins.values()))
    for a, b, mode in rows:
        if mode == "walking":
            r = feature(mins, a, b, ref)
            if r is not None: W.append((b - a, r, day, a))
        else:
            t = a
            while t < b:
                if steps.get(t, 0) >= STEP:
                    u = t
                    while u < b and steps.get(u, 0) >= STEP: u += 1
                    if t > a and u < b:
                        r = feature(mins, t, u, ref)
                        if r is not None: M.append((u - t, r, day, t))
                    t = u
                else: t += 1

def fit(xs):
    pts = [(math.log(d), math.log(max(R_FLOOR, r))) for d, r, *_ in xs]
    n = len(pts); mx = sum(x for x, _ in pts) / n; my = sum(y for _, y in pts) / n
    sxx = sum((x - mx) ** 2 for x, _ in pts)
    b = sum((x - mx) * (y - my) for x, y in pts) / sxx if sxx > 0 else 0.0
    a = my - b * mx
    return a, b, sum((y - a - b * x) ** 2 for x, y in pts), n

# One width for both: the log-odds is then monotone in the radius, so the term
# never charges a walk for going far.
aW, bW, ssW, nW = fit(W)
aM, bM, ssM, nM = fit(M)
S = math.sqrt((ssW + ssM) / (nW + nM))
print(f"walks   n {nW:4d}  log r = {aW:.3f} + {bW:.3f} log d   (median at 2/5/10 min: "
      + ", ".join(f"{math.exp(aW + bW * math.log(d)):.0f}" for d in (2, 5, 10)) + " m)")
print(f"inside  n {nM:4d}  log r = {aM:.3f} + {bM:.3f} log d   (median at 2/5/10 min: "
      + ", ".join(f"{math.exp(aM + bM * math.log(d)):.0f}" for d in (2, 5, 10)) + " m)")
print(f"shared width s {S:.3f}")
print("walkSpread:", json.dumps([round(aW, 4), round(bW, 4), round(aM, 4), round(bM, 4), round(S, 4)]))

def term(d, r):
    lr, ld = math.log(max(R_FLOOR, r)), math.log(d)
    zW, zM = (lr - aW - bW * ld) / S, (lr - aM - bM * ld) / S
    x = (zW * zW - zM * zM) / 2
    return -(x + math.log1p(math.exp(-x)) if x > 0 else math.log1p(math.exp(x)))

print("the term a walk segment pays, by length and radius:")
for d in (2, 3, 5, 10):
    print(f"  {d:2d} min: " + "  ".join(f"r {r:3d} m {term(d, r):6.2f}" for r in (5, 10, 20, 40, 80, 160)))
ts = sorted(term(d, r) for d, r, *_ in W)
print(f"over the narrated walks: q01 {ts[len(ts)//100]:.2f} q05 {ts[len(ts)//20]:.2f} q10 {ts[len(ts)//10]:.2f} median {ts[len(ts)//2]:.2f}")
print("the narrated walks it charges most:")
for d, r, day, a in sorted(W, key=lambda x: term(x[0], x[1]))[:15]:
    print(f"  {day} {a//60:02d}:{a%60:02d} {d:3d} min r {r:5.1f} m  {term(d, r):6.2f}")
