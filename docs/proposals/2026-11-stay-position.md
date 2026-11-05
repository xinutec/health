# A stay's position: stray fixes and moving spots

**Status (2026-11-05):** design A built and refuted as an addition (below); the rework — every mode scoring each fix the same way — is built behind `segEmission.position` and measured in `2026-11-generative-day.md` (step 1). Layer 1 and 2 of the
position-first rebuild (#1947); the activity terms (the heart rate answering the
steps, the fitted cadence with edge minutes) wait on it.

## Why position first

Whether a stretch of minutes is a stay or a walk should be decided by where the
fixes are, not by what the wearer is doing there. The decoder today decides it
partly by activity — steps and heart rate — and its terms compensate for one
another: the heart rate counts the steps a second time (with the steps in, a
walk's heart-rate level is a stay's: 80.4 against 81.5 bpm), and that double
count props up the hand-set cadence. Every arm that fixed one activity term lost
confirmed rows elsewhere (`tests/golden/fits/README`, 2026-11-04 and -05). The
position terms cannot take over the decision as they stand:

* A placeless stay weighs each fix by `1 / (σ² + accuracy²)` with σ hand-set at
  150 m; a listed one pays a per-minute 150 m Gaussian. Fitted, σ is 7 m, and a
  7 m spread holds a visit to one spot: 11-03 (desks 58 m apart) breaks into
  nine stays (`arm-position-2026-11-05.patch`).
* A per-stay spread integrated out fits a degenerate prior, because a few far
  fixes dominate a stay's scatter (`instruments/hr-level/stay-scale-fit.py`).

## Measured: what a stay's fixes look like

165 narrated stays of ten minutes or more, 12,657 lit minutes (each minute's
median fix), distance from the stay's median position
(`instruments/hr-level/strays.py`, `strays3.py`):

| | |
|---|---|
| distance in units of √(7² + accuracy²) | q50 0.13, q90 1.08, q99 5.25, q999 713 |
| core (scattered at λ·(7² + accuracy²)) | λ 0.02 — about 0.14 of the reported accuracy, ~2 m |
| local scatter, uniform within 60 m | 16% of minutes |
| far strays, within 5 km | 2% of minutes |
| a stay's own λ, its strays removed | q10 0.00, q50 0.02, q90 0.06, max 0.1 |

So a still phone is far tighter than it reports; a sixth of minutes sit
elsewhere inside the building (a second desk, indoor multipath); and one in fifty
is a far stray. Without the strays every stay's spread is the same to within a
factor of a few — the degenerate fit was the strays.

## The constraint

The decoder scores every segment `(d, e)` from prefix sums: a Gaussian centre
integrated out is closed form in `Σw, Σwx, Σwy, Σw|x|²`. A per-fix mixture is
not: each fix's share between core and stray depends on the centre, which
depends on the segment. Two designs keep it exact or principled:

**A. A robust filter from each start.** For every start, an assumed-density
filter over the spot (a level that rarely relocates — a desk change — inside the
place's footprint), each fix scored under the three-part mixture. Exact in the
same sense as the heart-rate level's sweep (`arm-hr-level-2026-11-05.patch`);
the place's prior is the filter's start, so one sweep per place in play (5–13 a
day) plus the placeless one. Cost: ~1 M steps per sweep with a few logs and
exps; a triangle table of ~8 MB per sweep, ~100 MB at the day's largest.

**B. A robust pass over the day before the decode.** Once per request, O(T):
each minute's fix judged against its neighbours (a far stray is inconsistent
with both at any plausible speed) and given its stray probability; the position
sums then weigh each fix by its core share. Segmentation-independent, so an
approximation, but the far strays are a local fact (a spike), and it costs no
table. Moving spots are then the spell's job: a spell inside a stay may move the
spot, the run after it scored about its own centre.

## Recommendation

B for the far strays (cheap, local, exact enough for a spike), then the moving
spot inside the spell sweep, which already runs once per start; A only if B's
approximation shows in the loss report. Each step ships alone, measured against
the confirmed rows, the history's round trips (`instruments/roundtrips.py`) and
the loss report by kind (`instruments/lossreport.py`), with time and memory.

## Design A, measured: a stay-only density cannot be weighed

Built (`tests/golden/fits/arm-spot-2026-11-05.patch`): the spot filter orders the
cases right on position alone — 11-03's desk move −9.6 against splitting,
Currys and Lidl −22.0, the stop and Paul −22.8, a real four-minute walk −50.7 —
and collapses as an arm (74 rows lost, phantoms 3 → 51, long stays become
rides). A stay paid a density for its fixes that no moving state pays.

## The rework: one question per fix, asked of every mode

For each lit minute, every state answers the same question — how probable is
this fix, given the segment's earlier fixes? — as a density of the fix in
square metres, so the states are compared on the same observation:

* a stay: the spot filter's predictive density (the spot from the pin, or the
  placeless prior, then sometimes moving; core, local and far fixes);
* a moving mode: the fix from the one before it, the displacement a 2-D
  density — the mode's fitted speed, in any direction, convolved with both
  fixes' noise. Today's pair terms score the speed alone; the speed's density
  becomes the displacement's by its Jacobian, which a stay does not share.

It replaces, for every state: the pair terms, the placeless centre term, the
listed place's per-minute 150 m term, and `centreSigmaM`. A segment's first
fix is scored against its predecessor by the mode either side (a stay's spot
prior is its Occam factor). Before any decoder code, a prototype on the
narrated minutes must show: a still minute's density far higher for a stay
than for a walk, a walking minute's the reverse, a desk move in between; and on
the cases above, the office one stay and the separations split.

