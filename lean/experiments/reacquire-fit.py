#!/usr/bin/env python3
"""The reacquire widening against the narrated minutes it is applied to.

For every narrated day, the decoder's own per-minute rows (emissionDebug) are
joined to the graded truth rows; each walking or stationary minute inside a
bright run after a fixless gap is kept with its age in the run, the gap's
length, its smoothed speed and the rail distance. Printed: per age, the
empirical sd of the speed residual against the mode's prior, beside the
form's widened sigma at the shipped constants; then the (W, tau) that
maximise the widened Gaussian's likelihood over those minutes.

Run from the repo root:
  python3 lean/experiments/reacquire-fit.py <dir of req-<date>.json dumps>
"""
import glob, json, math, os, re, subprocess, sys, datetime, zoneinfo

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CLI = f"{ROOT}/lean/.lake/build/bin/verified_cli"
scr = sys.argv[1]
rec = json.load(open(f"{ROOT}/tests/golden/fits/decoder-params.json"))
days = rec["provenance"]["days"]
mp = rec["fittedPriors"]["modePriors"]
PRIOR = {"walking": (mp["walking"][1], mp["walking"][2]), "stationary": (mp["stationary"][1], mp["stationary"][2])}
W0, TAU0, RAIL_SIGMA, RESET_GAP = 2.5, 3.0, 100.0, 10

def truth_rows(day):
    p = f"{ROOT}/tests/golden/ground-truth/{day}.md"
    if not os.path.exists(p): return None, []
    txt = open(p).read()
    tz = "UTC" if re.search(r"Times?:.*UTC", txt) or "declares UTC" in txt else "Europe/London"
    m = re.search(r"Times?:\s*([A-Za-z]+/[A-Za-z_]+)", txt)
    if m: tz = m[1]
    rows = []
    for line in txt.splitlines():
        m = re.match(r"\|\s*(\d\d):(\d\d)\s*[–-]\s*(\d\d):(\d\d)\s*\|\s*([^|]+)\|\s*([^|]+)\|", line)
        if not m: continue
        status = m[6].strip()
        if not status.startswith("correct"): continue
        mode = m[5].strip().split()[0].lower()
        if mode not in ("walking", "stationary"): continue
        rows.append((int(m[1]) * 60 + int(m[2]), int(m[3]) * 60 + int(m[4]), mode))
    return tz, rows

def minutes_of(day, tz, rows):
    z = zoneinfo.ZoneInfo(tz)
    d = datetime.date.fromisoformat(day)
    out = {}
    for a, b, mode in rows:
        if b <= a: b += 1440
        for mm in range(a, b):
            dd = d + datetime.timedelta(days=mm // 1440)
            t = datetime.datetime(dd.year, dd.month, dd.day, (mm % 1440) // 60, mm % 60, tzinfo=z)
            out[int(t.timestamp())] = mode
    return out

samples = []  # (mode, age, gap, speed, rail)
for day in days:
    reqp = f"{scr}/req-{day}.json"
    if not os.path.exists(reqp): print(day, "no dump", file=sys.stderr); continue
    tz, rows = truth_rows(day)
    if not rows: continue
    truth = minutes_of(day, tz, rows)
    req = json.load(open(reqp)); req["mode"] = "assemblesegments"
    start = req["observation"]["startUtc"]
    req["emissionDebug"] = {"fromTs": start, "toTs": start + 1440 * 60}
    r = subprocess.run([CLI, "serve"], input=json.dumps(req), capture_output=True, text=True)
    try:
        res = json.loads(r.stdout.strip().splitlines()[-1])["result"]
    except Exception as e:
        print(day, "serve failed", e, r.stderr[-200:], file=sys.stderr); continue
    ed = res.get("emissionDebug") or []
    rowsd = ed if isinstance(ed, list) else ed.get("rows", [])
    n = 0
    for o in rowsd:
        mode = truth.get(o["ts"])
        if mode is None or o.get("reacquireAgeMin") is None or o.get("speedKmh") is None: continue
        samples.append((mode, int(o["reacquireAgeMin"]), int(o.get("reacquireGapMin") or 0), float(o["speedKmh"]), o.get("railDistM")))
        n += 1
    print(day, len(rowsd), "rows", n, "post-gap narrated minutes", file=sys.stderr)

print(len(samples), "post-gap narrated minutes (walking/stationary)")
def sigma_w(mode, age, gap, rail, W, T):
    mu, sd = PRIOR[mode]
    scale = 1.0
    if mode == "stationary" and rail is not None:
        scale = 1.0 - math.exp(-(rail * rail) / (2 * RAIL_SIGMA * RAIL_SIGMA))
    tau = min(T, max(1.0, gap)) if gap else T
    return sd * (1 + W * scale * math.exp(-age / tau))
for mode in ("walking", "stationary"):
    mu, sd = PRIOR[mode]
    print(f"\n{mode}: prior mean {mu:.2f} sd {sd:.2f}")
    print(" age   n   rms residual  share above prior   form sigma(W=2.5,tau=3,gap>=3)")
    for age in range(0, 7):
        xs = [s for s in samples if s[0] == mode and s[1] == age]
        if not xs: continue
        rms = math.sqrt(sum((x[3] - mu) ** 2 for x in xs) / len(xs))
        above = sum(1 for x in xs if x[3] > mu) / len(xs)
        print(f" {age:3d} {len(xs):4d}   {rms:7.2f}        {above:5.2f}             {sigma_w(mode, age, 3, None, W0, TAU0):6.2f}")
    xs = [s for s in samples if s[0] == mode and s[1] > 6]
    if xs:
        rms = math.sqrt(sum((x[3] - mu) ** 2 for x in xs) / len(xs))
        print(f"  >6 {len(xs):4d}   {rms:7.2f}        {sum(1 for x in xs if x[3] > mu)/len(xs):5.2f}             {sd:6.2f} (base)")
    # grid MLE of the widened Gaussian over ages 0..5 (the correction's reach)
    best = None
    for W in [x / 4 for x in range(0, 41)]:
        for T in [x / 2 for x in range(2, 21)]:
            ll = 0.0
            for s in samples:
                if s[0] != mode or s[1] > 5: continue
                sg = sigma_w(mode, s[1], s[2], s[4], W, T)
                ll += -0.5 * ((s[3] - mu) / sg) ** 2 - math.log(sg)
            if best is None or ll > best[0]: best = (ll, W, T)
    ll0 = sum(-0.5 * ((s[3] - mu) / sigma_w(mode, s[1], s[2], s[4], W0, TAU0)) ** 2 - math.log(sigma_w(mode, s[1], s[2], s[4], W0, TAU0)) for s in samples if s[0] == mode and s[1] <= 5)
    print(f"  MLE over ages 0..5: W {best[1]:.2f} tau {best[2]:.1f} (loglik {best[0]:.1f}; shipped W 2.5 tau 3: {ll0:.1f})")
