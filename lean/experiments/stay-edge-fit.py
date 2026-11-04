#!/usr/bin/env python3
"""A stay's first and last minutes against the walk minutes it would take in.

A stay that runs into a walk ends on one of the walk's minutes, and a walk's
k-th minute sits farther from the stay than the stay's own edge does. Over the
narrated days (every enforcing truth row): each narrated stay of ten minutes
or more, its weighted centre as the decoder takes it (`withPositions`: each
minute's median fix, weight `1 / (sigmaM² + accuracy²)`), and the distance from
it of the stay's first and last lit minutes (E), and of the first to fourth
minutes of a walk beside it (W, pooled). Each log distance (floored at a metre)
fitted as a normal with one width; printed: the fits, `stayEdge: [aE, aW, s]`,
and the term a stay's edge minute pays at a distance,
`log fE(x) − log (fE(x) + fW(x))`.

Run from the repo root, over the decoder's requests (one `<day>-<user>.json`
per frozen day in DIR, `dump_decode_request`):
  python3 lean/experiments/stay-edge-fit.py DIR
"""
import datetime, glob, json, math, os, re, statistics, sys, zoneinfo

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
G = f"{ROOT}/tests/golden"
SIGMA_M = 150.0     # Emissions.PLACE_RADIUS_M, the request carries no centreSigmaM
ACC_DEFAULT = 10.0  # Assemble.ACCURACY_DEFAULT_M
X_FLOOR = 1.0

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

E, W = [], []
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
    if not per: continue
    mins = {}
    for t, ps in per.items():
        accs = [p["accuracyM"] for p in ps if p.get("accuracyM") is not None]
        mins[t] = (statistics.median(p["lat"] for p in ps), statistics.median(p["lon"] for p in ps),
                   statistics.median(accs) if accs else ACC_DEFAULT)
    ref = next(iter(mins.values()))
    xy = {t: local(ref, g[0], g[1]) for t, g in mins.items()}
    for i, (a, b, mode) in enumerate(rows):
        if mode != "stationary" or b - a < 10: continue
        lit = [t for t in range(a, b) if t in mins]
        if len(lit) < 5: continue
        w = sum(1 / (SIGMA_M ** 2 + mins[t][2] ** 2) for t in lit)
        cx = sum(xy[t][0] / (SIGMA_M ** 2 + mins[t][2] ** 2) for t in lit) / w
        cy = sum(xy[t][1] / (SIGMA_M ** 2 + mins[t][2] ** 2) for t in lit) / w
        d = lambda t: math.hypot(xy[t][0] - cx, xy[t][1] - cy)
        E.extend([d(lit[0]), d(lit[-1])])
        for j, side in ((i - 1, "before"), (i + 1, "after")):
            if not 0 <= j < len(rows) or rows[j][2] != "walking": continue
            wa, wb = rows[j][0], rows[j][1]
            if (side == "before" and abs(wb - a) > 2) or (side == "after" and abs(wa - b) > 2): continue
            for k in (1, 2, 3, 4):
                t = wb - k if side == "before" else wa + k - 1
                if wa <= t < wb and t in mins: W.append(d(t))

def fit(xs):
    ys = [math.log(max(X_FLOOR, x)) for x in xs]
    m = sum(ys) / len(ys)
    return m, sum((y - m) ** 2 for y in ys), len(ys)

aE, ssE, nE = fit(E)
aW, ssW, nW = fit(W)
S = math.sqrt((ssE + ssW) / (nE + nW))
print(f"stay edges     n {nE:4d}  median {math.exp(aE):5.1f} m")
print(f"walk minutes   n {nW:4d}  median {math.exp(aW):5.1f} m")
print(f"shared width s {S:.3f}")
print("stayEdge:", json.dumps([round(aE, 4), round(aW, 4), round(S, 4)]))

def term(x):
    z = math.log(max(X_FLOOR, x))
    zE, zW = (z - aE) / S, (z - aW) / S
    v = (zE * zE - zW * zW) / 2
    return -(v + math.log1p(math.exp(-v)) if v > 0 else math.log1p(math.exp(v)))

print("the term a stay's edge minute pays: " + "  ".join(f"{x} m {term(x):5.2f}" for x in (2, 5, 10, 20, 40, 80, 160)))
ts = sorted(term(x) for x in E)
print(f"over the narrated stays' edges: q05 {ts[len(ts)//20]:.2f} q10 {ts[len(ts)//10]:.2f} median {ts[len(ts)//2]:.2f}")
