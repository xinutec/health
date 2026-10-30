#!/usr/bin/env python3
"""σ and ε of the stay's position term from the narrated stay minutes' distances
to their listed place: a 2-D Gaussian (Rayleigh in distance) with a share ε
anywhere within R m, by EM."""
import json, math, sys
g = json.load(open(sys.argv[1]))  # the census dump (STAY_DISTANCE_DUMP)
ds = g.get("stay still", []) + g.get("stay stepped 30+", [])
R = 500.0
sigma, eps = 20.0, 0.05
for _ in range(200):
    # responsibilities
    w_in = []
    for d in ds:
        pin = (1 - eps) * (d / (sigma * sigma)) * math.exp(-d * d / (2 * sigma * sigma))
        pout = eps * (2 * d / (R * R)) if d < R else eps * 1e-9
        w_in.append(pin / (pin + pout) if pin + pout > 0 else 0.0)
    n_in = sum(w_in)
    sigma2 = sum(w * d * d for w, d in zip(w_in, ds)) / (2 * n_in)
    ns, ne = math.sqrt(sigma2), 1 - n_in / len(ds)
    if abs(ns - sigma) < 1e-4 and abs(ne - eps) < 1e-6: sigma, eps = ns, ne; break
    sigma, eps = ns, ne
print(f"n {len(ds)}  sigma {sigma:.2f} m  eps {eps:.4f}  (log eps {math.log(eps):.2f})")
for grp in ("walk start 1","walk start 2","walk start 3","walk end 1","walk end 2","walk end 3"):
    xs = g.get(grp, [])
    if not xs: continue
    cost = [math.log((1-eps)*math.exp(-0.5*(d/sigma)**2) + eps) for d in xs]
    cost.sort()
    print(f"{grp:13s} n {len(xs):3d}  term median {cost[len(cost)//2]:6.2f}  q25 {cost[len(cost)//4]:6.2f}")
