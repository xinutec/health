#!/usr/bin/env python3
"""The stay's position term about each place's DAY centre, fitted.

A listed place is a centroid mined over many days; on a given day the stay
sits somewhere inside its footprint (Work's desk sits 13–22 m off its centroid,
`stay-distance-census.py`). The day centre is the place's inlier mean over the
day's fixes under the term's own mixture — a Gaussian of width σ with a share ε
anywhere within R — by EM from the listed point. σ and ε are then fitted on the
narrated stay minutes about those centres, alternating until both settle.

A decoder term about a day centre would have to run this same EM, or σ is
fitted on one distance and priced on another.

Then the same minutes, about the listed place and about the day centre, under a
three-part family: a core, a wander and a share anywhere, with each walk-edge
minute's cost under a term that is 0 at the core's peak.

Run from the repo root:
  python3 lean/experiments/day-centre-fit.py <dir of req-<date>.json dumps>
The serve rows are cached in <dir>/day-centre-rows.json.
"""
import json, math, os, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CLI = f"{ROOT}/lean/.lake/build/bin/verified_cli"
scr = sys.argv[1]
R = 500.0
ITER = 10  # EM steps for a day centre

census = {"__file__": f"{os.path.dirname(os.path.abspath(__file__))}/stay-distance-census.py"}
exec(open(f"{os.path.dirname(os.path.abspath(__file__))}/stay-distance-census.py").read().split("groups = {}")[0], census)
rows_of, ts_of, f, hav = census["rows_of"], census["ts_of"], census["f"], census["hav"]
days = census["days"]

cache = f"{scr}/day-centre-rows.json"
if os.path.exists(cache):
    data = json.load(open(cache))
else:
    data = []
    for day in days:
        reqp = f"{scr}/req-{day}.json"
        if not os.path.exists(reqp): continue
        tz, rows = rows_of(day)
        if not rows: continue
        req = json.load(open(reqp))
        places = [(p.get("name", "").lower(), f(p["lat"]), f(p["lon"])) for p in req.get("places", []) if p.get("name")]
        allp = [(f(p["lat"]), f(p["lon"])) for p in req.get("places", [])]
        req["mode"] = "assemblesegments"
        start = req["observation"]["startUtc"]
        req["emissionDebug"] = {"fromTs": start, "toTs": start + 1440 * 60}
        r = subprocess.run([CLI, "serve"], input=json.dumps(req), capture_output=True, text=True)
        try:
            ed = json.loads(r.stdout.strip().splitlines()[-1])["result"]["emissionDebug"]
        except Exception as e:
            print(day, "serve failed", e, file=sys.stderr); continue
        fixes = [(o["ts"], o["lat"], o["lon"]) for o in ed if o.get("lat") is not None]
        stays = []
        for a, b, mode, place in sorted(rows):
            if mode != "stationary" or not place: continue
            c = next(((la, lo) for n, la, lo in places if n == place or place in n or n in place), None)
            if c is None: continue
            ts = [ts_of(day, tz, mm) for mm in range(a, b)]
            walks = [(a2, b2) for a2, b2, m2, _ in rows if m2 == "walking" and (b2 == a or a2 == b)]
            edge = []
            for a2, b2 in walks:
                if b2 == a: edge += [("walk end", k, ts_of(day, tz, b2 - k)) for k in range(1, 5)]
                if a2 == b: edge += [("walk start", k, ts_of(day, tz, a2 + k - 1)) for k in range(1, 5)]
            stays.append({"place": c, "ts": ts, "edge": edge})
        data.append({"day": day, "fixes": fixes, "stays": stays})
        print(day, "rows", file=sys.stderr)
    json.dump(data, open(cache, "w"))

def day_centre(listed, fixes, sigma, eps):
    """EM for the inlier mean from the listed point, ITER steps (planar)."""
    clat, clon = listed
    for _ in range(ITER):
        sw = sx = sy = 0.0
        for _, la, lo in fixes:
            z = hav(la, lo, clat, clon) / sigma
            pin = (1 - eps) * math.exp(-0.5 * z * z) / (2 * math.pi * sigma * sigma)
            pout = eps / (math.pi * R * R)
            w = pin / (pin + pout)
            sw += w; sx += w * la; sy += w * lo
        if sw < 1.0: return listed
        clat, clon = sx / sw, sy / sw
    return (clat, clon)

def fit(ds, sigma, eps):
    for _ in range(200):
        w_in = []
        for d in ds:
            pin = (1 - eps) * (d / (sigma * sigma)) * math.exp(-d * d / (2 * sigma * sigma))
            pout = eps * (2 * d / (R * R)) if d < R else eps * 1e-9
            w_in.append(pin / (pin + pout) if pin + pout > 0 else 0.0)
        n_in = sum(w_in)
        sigma, eps = math.sqrt(sum(w * d * d for w, d in zip(w_in, ds)) / (2 * n_in)), 1 - n_in / len(ds)
    return sigma, eps

sigma, eps = 5.8, 0.0468  # the listed-place fit (`place-term-fit.py`)
for rnd in range(8):
    ds, edge = [], {}
    for d in data:
        by = {t: (la, lo) for t, la, lo in d["fixes"]}
        for s in d["stays"]:
            c = day_centre(tuple(s["place"]), d["fixes"], sigma, eps)
            ds += [hav(*by[t], *c) for t in s["ts"] if t in by]
            for g, k, t in s["edge"]:
                if t in by: edge.setdefault(f"{g} {k}", []).append(hav(*by[t], *c))
    ns, ne = fit(ds, sigma, eps)
    print(f"round {rnd}: n {len(ds)}  sigma {ns:.2f} m  eps {ne:.4f}  (log eps {math.log(ne):.2f})")
    done = abs(ns - sigma) < 0.01 and abs(ne - eps) < 1e-4
    sigma, eps = ns, ne
    if done: break
for g in sorted(edge):
    xs = edge[g]
    cost = sorted(math.log((1 - eps) * math.exp(-0.5 * (x / sigma) ** 2) + eps) for x in xs)
    print(f"{g:13s} n {len(xs):3d}  median {sorted(xs)[len(xs)//2]:5.0f} m  term median {cost[len(cost)//2]:6.2f}  q25 {cost[len(cost)//4]:6.2f}")

# ---- the three-part family ------------------------------------------------
def collect(centred, s1=5.8, e=0.0468):
    ds, edge = [], {}
    for d in data:
        by={t:(la,lo) for t,la,lo in d["fixes"]}
        for s in d["stays"]:
            c = day_centre(tuple(s["place"]), d["fixes"], s1, e) if centred else tuple(s["place"])
            ds += [hav(*by[t], *c) for t in s["ts"] if t in by]
            for gg,k,t in s["edge"]:
                if t in by: edge.setdefault(f"{gg} {k}",[]).append(hav(*by[t],*c))
    return ds, edge
def ray(d,s): return (d/(s*s))*math.exp(-d*d/(2*s*s))
def fit3(ds):
    s1,s2,w1,w2,e = 3.0,20.0,0.7,0.25,0.05
    for _ in range(500):
        r1=[];r2=[];r3=[]
        for d in ds:
            a=w1*ray(d,s1); b=w2*ray(d,s2); c=e*(2*d/(R*R)) if d<R else 1e-12
            t=a+b+c or 1e-300; r1.append(a/t); r2.append(b/t); r3.append(c/t)
        n1,n2,n3=sum(r1),sum(r2),sum(r3); n=len(ds)
        s1=math.sqrt(sum(r*d*d for r,d in zip(r1,ds))/(2*n1)); s2=math.sqrt(sum(r*d*d for r,d in zip(r2,ds))/(2*n2))
        w1,w2,e=n1/n,n2/n,n3/n
    ll=sum(math.log(w1*ray(d,s1)+w2*ray(d,s2)+(e*2*d/(R*R) if d<R else 1e-12)+1e-300) for d in ds)
    return s1,s2,w1,w2,e,ll
for centred in (False, True):
    ds, edge = collect(centred)
    s1,s2,w1,w2,e,ll = fit3(ds)
    print(f"{'day centre' if centred else 'listed'}: core {s1:.1f} m ({w1:.3f}), wander {s2:.1f} m ({w2:.3f}), share {e:.4f}, ll {ll:.0f}")
    # the term as a density ratio against the core's peak density: log( sum_k w_k N2(d;s_k) / (w1 N2(0;s1)) ), N2 2-D density
    def term(d):
        dens=w1*math.exp(-d*d/(2*s1*s1))/(2*math.pi*s1*s1)+w2*math.exp(-d*d/(2*s2*s2))/(2*math.pi*s2*s2)+e/(math.pi*R*R)
        peak=w1/(2*math.pi*s1*s1)+w2/(2*math.pi*s2*s2)+e/(math.pi*R*R)
        return math.log(dens/peak)
    xs=sorted(ds); print("   stay minutes term median %.2f q90 %.2f q99 %.2f" % (term(xs[len(xs)//2]), term(xs[int(.9*len(xs))]), term(xs[int(.99*len(xs))])))
    for k in sorted(edge):
        v=sorted(edge[k]); print(f"   {k:13s} median {v[len(v)//2]:5.0f} m term {term(v[len(v)//2]):6.2f} q25 {term(v[len(v)//4]):6.2f}")
