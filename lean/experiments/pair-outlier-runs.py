#!/usr/bin/env python3
"""Do a walk's fast pairs come alone? On the narrated walks and rides, each
one-minute pair speed between consecutive lit minutes (the decoder's own
`Assemble.pairSpan`: minute medians), and how often a fast pair follows a fast
pair. A GPS jump snaps back; a train keeps going. Fast here is only a census
cut (above a walk's pace by far), not a term.

Run from the repo root:  python3 lean/experiments/pair-outlier-runs.py
"""
import json, glob, re, os, math, statistics, datetime, zoneinfo, collections

G = "tests/golden"; FAST = 30.0
def hav(a, b, c, d):
    R = 6371000; p1, p2 = math.radians(a), math.radians(c); dp = p2 - p1; dl = math.radians(d - b)
    return 2 * R * math.asin(math.sqrt(math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2))

stats = {m: collections.Counter() for m in ("walking", "train")}
runs = {m: collections.Counter() for m in ("walking", "train")}
for md in sorted(glob.glob(f"{G}/ground-truth/2026-*.md")):
    day = os.path.basename(md)[:10]
    found = glob.glob(f"{G}/days/{day}-*.json")
    if not found: continue
    txt = open(md).read()
    tz = "Europe/London"; m = re.search(r"Times?:\s*([A-Za-z]+/[A-Za-z_]+)", txt)
    if m: tz = m[1]
    elif "Times: UTC" in txt: tz = "UTC"
    z = zoneinfo.ZoneInfo(tz); d0 = datetime.date.fromisoformat(day)
    fx = json.load(open(found[0]))
    per = collections.defaultdict(list)
    for p in fx["inputs"]["phonetrack"]["today"]:
        per[p["ts"] // 60 * 60].append((p["lat"], p["lon"]))
    med = {t: (statistics.median(a for a, _ in v), statistics.median(b for _, b in v)) for t, v in per.items()}
    T = lambda h, mi: int(datetime.datetime(d0.year, d0.month, d0.day, h, mi, tzinfo=z).timestamp())
    for line in txt.splitlines():
        m = re.match(r"\|\s*(\d\d):(\d\d)\s*[–-]\s*(\d\d):(\d\d)\s*\|\s*([^|]+)\|\s*([^|]+)\|", line)
        if not m or not m[6].strip().startswith("correct"): continue
        mode = m[5].strip().split()[0].lower()
        if mode not in stats: continue
        a, b = T(int(m[1]), int(m[2])), T(int(m[3]), int(m[4]))
        if b <= a: b += 86400
        prev = None; run = 0
        for t in range(a, b - 60, 60):
            if t in med and t + 60 in med:
                v = hav(*med[t], *med[t + 60]) / 60 * 3.6
                fast = v > FAST
                stats[mode]["pairs"] += 1; stats[mode]["fast"] += fast
                if prev is not None:
                    stats[mode]["after_fast"] += prev
                    stats[mode]["fast_after_fast"] += prev and fast
                prev = fast
                run = run + 1 if fast else 0
                if fast: runs[mode][run] += 1
            else:
                prev = None; run = 0
for mode, s in stats.items():
    pf = s["fast"] / max(1, s["pairs"]); cont = s["fast_after_fast"] / max(1, s["after_fast"])
    longest = max(runs[mode]) if runs[mode] else 0
    print(f"{mode:8s} pairs {s['pairs']:5d}  fast {s['fast']:4d} ({pf:.1%})  fast after fast {s['fast_after_fast']}/{s['after_fast']} ({cont:.1%})  longest run {longest}")
