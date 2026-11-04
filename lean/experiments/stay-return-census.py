#!/usr/bin/env python3
"""Where a stay's still minutes are after moving about, against where the next
place is.

Over the narrated days (every enforcing truth row): for each run of stepped
minutes inside a narrated stay, the distance between the centre of the stay's
still minutes before the run and the centre of those after it (R: a spell that
came back); and for each narrated walk of at most WALK minutes between two
narrated stays at different places, the distance between the two stays'
centres (D: a walk to somewhere near). Each log distance (floored at a metre)
fitted as a normal, one width; printed: the fits, `stayReturn: [aR, aD, s]`,
and the term a spell's return pays at a distance.

Run from the repo root, over the decoder's requests (one `<day>-<user>.json`
per frozen day in DIR, `dump_decode_request`):
  python3 lean/experiments/stay-return-census.py DIR
"""
import datetime, glob, json, math, os, re, statistics, sys, zoneinfo

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
G = f"{ROOT}/tests/golden"
STEP = 30
WALK = 10

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
        if mode not in ("walking", "stationary"): continue
        place = re.sub(r"\s*\(.*?\)\s*$", "", truth.split("@", 1)[1]).strip() if "@" in truth else None
        a, b = int(m[1]) * 60 + int(m[2]), int(m[3]) * 60 + int(m[4])
        if b <= a: b += 1440
        out.append((a, b, mode, place))
    return tz, out

def local(ref, lat, lon):
    return ((lon - ref[1]) * 111320 * math.cos(math.radians(ref[0])), (lat - ref[0]) * 111320)

R, D = [], []
for md in sorted(glob.glob(f"{G}/ground-truth/2026-*.md")):
    day = os.path.basename(md)[:10]
    found = glob.glob(f"{sys.argv[1]}/{day}-*.json")
    if not found: continue
    o = json.load(open(found[0]))["observation"]
    tz, rows = rows_of(md)
    d0 = datetime.datetime.fromisoformat(day).replace(tzinfo=zoneinfo.ZoneInfo(tz))
    mm = lambda ts: int((ts - d0.timestamp()) // 60)
    steps = {}
    for s in o["steps"]: steps[mm(s["ts"])] = steps.get(mm(s["ts"]), 0) + s["steps"]
    per = {}
    for p in o["points"]: per.setdefault(mm(p["ts"]), []).append(p)
    if not per: continue
    mins = {t: (statistics.median(p["lat"] for p in ps), statistics.median(p["lon"] for p in ps)) for t, ps in per.items()}
    ref = next(iter(mins.values()))
    xy = {t: local(ref, *g) for t, g in mins.items()}
    def centre(ts):
        ts = [t for t in ts if t in xy and steps.get(t, 0) < STEP]
        if len(ts) < 2: return None
        return (sum(xy[t][0] for t in ts) / len(ts), sum(xy[t][1] for t in ts) / len(ts))
    for a, b, mode, place in rows:
        if mode != "stationary": continue
        t = a
        while t < b:
            if steps.get(t, 0) >= STEP:
                u = t
                while u < b and steps.get(u, 0) >= STEP: u += 1
                if t > a and u < b:
                    c1, c2 = centre(range(a, t)), centre(range(u, b))
                    if c1 and c2: R.append(math.hypot(c1[0] - c2[0], c1[1] - c2[1]))
                t = u
            else: t += 1
    for i in range(1, len(rows) - 1):
        a, b, mode, _ = rows[i]
        pa, pb = rows[i - 1], rows[i + 1]
        if mode != "walking" or b - a > WALK or pa[2] != "stationary" or pb[2] != "stationary": continue
        if abs(pa[1] - a) > 2 or abs(pb[0] - b) > 2 or not pa[3] or not pb[3] or pa[3] == pb[3]: continue
        c1, c2 = centre(range(pa[0], pa[1])), centre(range(pb[0], pb[1]))
        if c1 and c2: D.append(math.hypot(c1[0] - c2[0], c1[1] - c2[1]))

def fit(xs):
    ys = [math.log(max(1.0, x)) for x in xs]
    m = sum(ys) / len(ys)
    return m, sum((y - m) ** 2 for y in ys), len(ys)

aR, ssR, nR = fit(R)
aD, ssD, nD = fit(D)
S = math.sqrt((ssR + ssD) / (nR + nD))
q = lambda xs, f: sorted(xs)[int(f * (len(xs) - 1))]
print(f"spells that came back  n {nR:4d}  centres apart: median {math.exp(aR):6.1f} m  q90 {q(R, .9):6.1f}")
print(f"walks to a near place  n {nD:4d}  centres apart: median {math.exp(aD):6.1f} m  q10 {q(D, .1):6.1f}  min {min(D):6.1f}")
print(f"shared width s {S:.3f}")
print("stayReturn:", json.dumps([round(aR, 4), round(aD, 4), round(S, 4)]))

def term(x):
    z = math.log(max(1.0, x))
    zR, zD = (z - aR) / S, (z - aD) / S
    v = (zR * zR - zD * zD) / 2
    return -(v + math.log1p(math.exp(-v)) if v > 0 else math.log1p(math.exp(v)))

print("the term a spell's return pays: " + "  ".join(f"{x} m {term(x):5.2f}" for x in (2, 5, 10, 20, 30, 50, 85, 150)))
