#!/usr/bin/env python3
"""Heart rate after a walk: a narrated stay's minute k against the stay's own
settled level (the median of its minutes from 15 on), for stays that begin as
a narrated walk ends, beside stays that begin out of anything else.

The decoder prices a stay's minute at the stay's resting level; this measures
how long the walk's heart rate lingers into the stay — the excess a short stay
after a walk carries.

Run from the repo root:
  python3 lean/experiments/hr-recovery-census.py <dir of req-<date>.json dumps>
"""
import json, math, os, statistics, sys

HERE = os.path.dirname(os.path.abspath(__file__))
census = {"__file__": f"{HERE}/stay-distance-census.py"}
exec(open(f"{HERE}/stay-distance-census.py").read().split("groups = {}")[0], census)
days, ts_of = census["days"], census["ts_of"]
scr = sys.argv[1]

def rows_of(day):
    tz, rows = census["rows_of"](day)
    return tz, sorted(rows)

K = 12
after_walk = {k: [] for k in range(K)}
other = {k: [] for k in range(K)}
walk_tail = []
for day in days:
    p = f"{scr}/req-{day}.json"
    if not os.path.exists(p): continue
    tz, rows = rows_of(day)
    if not rows: continue
    hr = {h["ts"]: h["bpm"] for h in json.load(open(p))["observation"]["hr"] if h.get("bpm")}
    for a, b, mode, _ in rows:
        if mode != "stationary" or b - a < 25: continue
        settled = [hr[t] for t in (ts_of(day, tz, m) for m in range(a + 15, b)) if t in hr]
        if len(settled) < 8: continue
        base = statistics.median(settled)
        prev = [r for r in rows if r[1] == a]
        walked = bool(prev) and prev[0][2] == "walking"
        for k in range(K):
            t = ts_of(day, tz, a + k)
            if t in hr: (after_walk if walked else other)[k].append(hr[t] - base)
        if walked:
            t = ts_of(day, tz, a - 1)
            if t in hr: walk_tail.append(hr[t] - base)
print(f"walk's last minute: n {len(walk_tail)}, median excess {statistics.median(walk_tail):+.1f} bpm")
print(" k   after a walk: n  median  q75   |  otherwise: n  median")
for k in range(K):
    xs, ys = after_walk[k], other[k]
    q = lambda v, f: sorted(v)[int(f * (len(v) - 1))] if v else float("nan")
    print(f"{k:2d}   {len(xs):4d}  {statistics.median(xs) if xs else float('nan'):+6.1f} {q(xs,.75):+6.1f}   |  {len(ys):4d}  {statistics.median(ys) if ys else float('nan'):+6.1f}")
# An exponential decay fitted to the median excess after a walk.
pts = [(k, statistics.median(after_walk[k])) for k in range(K) if len(after_walk[k]) >= 10]
best = min(((sum((m - d0 * math.exp(-k / tau)) ** 2 for k, m in pts), d0, tau)
            for d0 in [x / 2 for x in range(0, 61)] for tau in [x / 4 for x in range(1, 61)]))
print(f"median excess ≈ {best[1]:.1f} · exp(−k / {best[2]:.2f} min)")
