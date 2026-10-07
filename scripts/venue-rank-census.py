#!/usr/bin/env python3
"""Where does the TRUE venue of each narrated stay rank by distance? (#325)

For every golden day with a narrative, every row `stationary @ <Venue> (...)`
whose status is graded (`correct` or `wrong`, any provenance) is matched to the
fixture's landmark rows by name. Its distance is measured two ways:

  centre  from the mean of the stay's fixes (what the naming coordinate is
          built from), and
  early   from the mean of the fixes in the stay's first EARLY_MIN minutes
          (sitting down first, drifting later — 04-29's Pistache lunch).

For each, the rank of the true venue among named landmarks within RADIUS_M of
that point, and what the fold served over the window. Run from the repo root:

    scripts/venue-rank-census.py [EARLY_MIN] [RADIUS_M]

Prints names, distances and ranks only — never a coordinate (the fixtures and
narratives are private; this output is not).
"""
import glob
import json
import math
import re
import sys
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

EARLY_MIN = float(sys.argv[1]) if len(sys.argv) > 1 else 10.0
RADIUS_M = float(sys.argv[2]) if len(sys.argv) > 2 else 100.0
ROW = re.compile(r"^\|\s*(\d\d:\d\d)\s*[–-]\s*(\d\d:\d\d)\s*\|\s*stationary @ ([^|]+?)\s*\|\s*([^|]+?)\s*\|")


def meters(a, b):
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * 6371008.8 * math.asin(math.sqrt(h))


def norm(name):
    return re.sub(r"[^a-z0-9]", "", name.lower())


def mean(fixes):
    return (sum(f["lat"] for f in fixes) / len(fixes), sum(f["lon"] for f in fixes) / len(fixes))


def rank_of(target, point, venues):
    near = sorted((meters(point, (v["lat"], v["lon"])), v["name"]) for v in venues)
    near = [(d, n) for d, n in near if d <= RADIUS_M]
    td = meters(point, target)
    return 1 + sum(1 for d, _ in near if d < td), td, near[0][1] if near else None


rows_out = []
for gt in sorted(glob.glob("tests/golden/ground-truth/*.md")):
    day = gt.split("/")[-1][:10]
    fx_paths = glob.glob(f"tests/golden/days/{day}-*.json")
    if not fx_paths:
        continue
    fx = json.load(open(fx_paths[0]))
    text = open(gt).read()
    m = re.search(r"^Times:\s*(\S+)", text, re.M)
    tz = ZoneInfo(m.group(1) if m else "Europe/London")
    fixes = sorted(fx["inputs"]["phonetrack"]["today"], key=lambda f: f["ts"])
    venues = [p for p in fx["inputs"]["osmRowSet"]["points"] if p.get("featureType") == "landmark" and p.get("name")]
    by_name = {}
    for v in venues:
        by_name.setdefault(norm(v["name"]), v)
    states = fx["expected"]["statesOut"]
    base = datetime.fromisoformat(day).replace(tzinfo=tz)
    for line in text.splitlines():
        r = ROW.match(line)
        if not r:
            continue
        a, b, truth, status = r.groups()
        status = status.split("{")[0].strip()
        if status not in ("correct", "wrong"):
            continue
        name = truth.split(" (")[0].strip()
        v = by_name.get(norm(name))
        if v is None:
            continue  # Home/Work, a station, or a venue the row set does not carry
        t0 = base.replace(hour=int(a[:2]), minute=int(a[3:]))
        t1 = base.replace(hour=int(b[:2]), minute=int(b[3:]))
        if t1 <= t0:
            t1 += timedelta(days=1)
        s, e = t0.timestamp(), t1.timestamp()
        win = [f for f in fixes if s <= f["ts"] <= e]
        if len(win) < 2:
            continue
        early = [f for f in win if f["ts"] <= win[0]["ts"] + EARLY_MIN * 60] or win[:1]
        served = {st.get("place") for st in states if st.get("place") and st["startTs"] < e and st["endTs"] > s}
        rc, dc, nc = rank_of((v["lat"], v["lon"]), mean(win), venues)
        re_, de, ne = rank_of((v["lat"], v["lon"]), mean(early), venues)
        rows_out.append((day, a, name, status, len(win), len(early), rc, dc, re_, de, nc, ne, sorted(served)))

print(f"early = first {EARLY_MIN:.0f} min of fixes; ranks among named landmarks within {RADIUS_M:.0f} m")
print(f"{'day':10} {'from':5} {'truth':28} {'status':7} {'n':>4} {'nE':>3}  centre(rank,m)  early(rank,m)  served")
moved_up = moved_down = 0
for day, a, name, status, n, ne_, rc, dc, re_, de, nc, ne, served in rows_out:
    mark = "  ^" if re_ < rc else ("  v" if re_ > rc else "")
    moved_up += re_ < rc
    moved_down += re_ > rc
    print(f"{day} {a} {name[:28]:28} {status:7} {n:4} {ne_:3}  {rc:3} {dc:5.0f}      {re_:3} {de:5.0f}{mark:4} {', '.join(served)[:50]}")
first_c = sum(1 for r in rows_out if r[6] == 1)
first_e = sum(1 for r in rows_out if r[8] == 1)
print(f"\n{len(rows_out)} graded venue stays; truth NEAREST from centre {first_c}, from early fixes {first_e}; "
      f"early ranks it higher on {moved_up}, lower on {moved_down}")
