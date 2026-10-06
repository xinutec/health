#!/usr/bin/env python3
"""The naming census (#325): how often a venue that read CLOSED sat near a stay
and lost, and to what.

Input: the fold's namings, dumped by running the corpus with `LEAN_DUMP_DIR`
set — each naming lands as `<dir>/place-<n>.json` in the shape the
`bestplace` serve mode reads (`DayEntry.placeInputJson`). One directory per
day, under the root this script is given:

    for f in tests/golden/days/*.json; do d=$(basename $f .json)
      mkdir -p /tmp/pcensus/$d
      LEAN_DUMP_DIR=/tmp/pcensus/$d rust/target/release/backend day $f >/dev/null
    done
    scripts/place-census.py /tmp/pcensus 20

Each dump is replayed through `verified_cli serve` mode `bestplace`, which
answers the label and the ranker's view of every candidate (open fraction,
distance, the hours term), so the census reads the fold's own decision rather
than a model of it. Prints names and counts, never a coordinate.

Measured 2026-10-06 over 352 namings: a closed-reading venue within 20 m won
0 and lost 24 times, every loss to the right place — recorded on #325.
"""

import glob
import json
import subprocess
import sys
from collections import Counter

import os
HERE = os.path.dirname(os.path.abspath(__file__))
CLI = os.path.join(HERE, "..", "lean", ".lake", "build", "bin", "verified_cli")
ROOT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/pcensus"
NEAR_M = float(sys.argv[2]) if len(sys.argv) > 2 else 20.0
CLOSED = 0.1  # open fraction at or below this reads as closed for the stay

proc = subprocess.Popen([CLI, "serve"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)

def ask(req):
    proc.stdin.write(json.dumps(req) + "\n")
    proc.stdin.flush()
    return json.loads(proc.stdout.readline())["result"]

stays = 0
namings = 0
with_hours_evidence = 0
closed_near_lost = []
closed_near_won = 0
no_hours_won_over_closed = 0
by_winner_subtype = Counter()
for f in sorted(glob.glob(os.path.join(ROOT, "*", "place-*.json"))):
    day = f.split("/")[-2][:10]
    d = json.load(open(f))
    namings += 1
    if d.get("stay") is None:
        continue
    stays += 1
    r = ask({"mode": "bestplace", **d})
    label = r.get("label")
    ranked = r.get("ranked") or []
    if any(c["openFraction"] is not None for c in ranked):
        with_hours_evidence += 1
    winner = ranked[0] if ranked else None
    for c in ranked:
        of = c["openFraction"]
        if of is None or of > CLOSED or c["distanceM"] > NEAR_M:
            continue
        if label == c["name"]:
            closed_near_won += 1
            continue
        closed_near_lost.append((day, c, label, winner))
        if winner and winner["openFraction"] is None:
            no_hours_won_over_closed += 1
        if winner:
            by_winner_subtype[winner["subtype"]] += 1

proc.stdin.close()
proc.wait()
dur_h = lambda d: (d["stay"]["endUnix"] - d["stay"]["startUnix"]) / 3600 if d.get("stay") else 0
print(f"namings {namings}, with a stay window {stays}, with any hours evidence {with_hours_evidence}")
print(f"closed-reading candidate within {NEAR_M:.0f} m: won {closed_near_won}, lost {len(closed_near_lost)}"
      f" (of which to a winner with NO hours tag: {no_hours_won_over_closed})")
print("winners' subtypes when a near closed venue lost:", dict(by_winner_subtype))
for day, c, label, w in closed_near_lost:
    print(f"  {day}  closed {c['name']!r} ({c['subtype']}, {c['distanceM']:.0f} m, open {c['openFraction']:.2f},"
          f" hours term {c['hours']})  ->  label {label!r}"
          + (f" (winner {w['name']!r} {w['subtype']} {w['distanceM']:.0f} m, open {w['openFraction']})" if w else ""))
