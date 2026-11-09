# The generative day: the decoder's end state

**Status (2026-11-05):** vision, for review. No decoder code under it until
it is agreed. It refines [`decoder-roadmap.md`](decoder-roadmap.md) (the
worldline) under the contract in
[`../design/probabilistic-principles.md`](../design/probabilistic-principles.md);
where they disagree, the principles win.

## What it is

One generative model of a day: a latent physical history, and observations
drawn from it. A served day is a reading of the posterior over that history;
uncertainty is part of the answer. Every layer is a physical model whose
numbers are measured facts or fits, so no number compensates for another
(principles, Rules 7 and 8).

## His decisions (2026-11-05)

What the served day shows, decided by the person it describes:

* **Unsure:** the best guess, marked as unsure when the posterior is not
  confident — never a list to choose from (Rule 6), never false certainty.
* **Pauses in a walk** (a light, waiting to cross): one walk. Only a real
  stop at a place is a stay.
* **Moving about inside a place:** not shown. It is one stay.
  Built in the day's fold (`SegmentMerge.absorbMoveInsidePlace`, 2026-11-09):
  a moving run between two stays at one place whose fixes never leave the
  place, as the stays' own fixes show it that visit, is that stay. History
  round trips 29 → 10; no confirmed row moved.
* **Meanwhile:** the live decoder stays as shipped on 2026-11-04; the work
  goes into the rebuild, shipped when it is clearly better.

## The layers

The history is three latent processes; the observations depend on them.

**1. Where — the worldline.** Minute by minute, a position. Either at a
*spot* inside a *place* (the spot may move — another desk, another room —
and never leaves the place's footprint), or *moving* along the walk, road
and rail network, at a mode's physical speed, between nodes it shares with
the legs either side. Hard, in the generator (Rule 1): one position at a
time, no teleport, a line runs between its own stations, a mode's true
speed bound. Map knowledge has its escape hatch (an unmapped place,
station, line).

**2. What — the activity.** Still, moving about in place, walking, riding,
asleep. Its own latent, *not* the location: moving about inside a place is
activity at a spot, not a journey. A journey is a change of place, and only
the worldline makes one. Activity's transitions carry their own fitted
rates; its durations are its own.

**3. The body — physiology.** A heart-rate level that drifts slowly and is
pulled toward the wearer's own resting level, plus a fast response to recent
activity. Steps are produced by the activity. Sleep is an activity whose
heart rate has its own level.

**4. Observations,** each a heavy-tailed likelihood of the latent state,
never a filter:

* a GPS fix given the true position — a core at the fix's (calibrated)
  accuracy, local scatter inside buildings, a share of far strays;
* steps given the activity, the edge minute a part of each activity it
  touches;
* heart rate given the physiology;
* sleep stages given the activity.

**5. Inference.** Exact dynamic programming over segments where the
structure allows it (the HSMM and its proofs), forward–backward for the
posterior; the MAP path is one reading of it.

**6. Output.** Per minute, a distribution over where and what; the timeline
shows the top reading and its confidence (Rule 5). The composition layer
groups a run of the worldline into the events a person narrates (a tube
journey with its changes).

## The invariants, each a test

Correct by construction means each holds for any parameters, and a test
fails when it does not:

* **Every hypothesis explains every observation.** Each state scores each
  minute's fix, steps and heart rate as a density of that observation. No
  state is free of an observation another pays for. (Broken today: a stay
  pays for its fixes' scatter, a moving state pays only the fix-pair speed,
  so a proper stay density lost to rides everywhere — measured 2026-11-05.)
* **Splitting never pays for itself.** For data with no change in it,
  scoring a stretch as one segment is at least as good as as two of the same
  state. (Broken today: one constant heart-rate level per segment, so a long
  stay's drift paid ~21 nats for a split on 11-03.)
* **Each piece of evidence counts once.** A signal enters through the latent
  it measures. (Broken today: the heart rate's level difference between
  walking and sitting is the steps' — with the steps in, a walk's level is a
  stay's — so steps count twice.)
* **Position decides location; activity decides activity.** A fix pattern
  that stays inside a place cannot become a journey on steps or heart rate
  alone.
* **No compensation constants.** Every constant is a measured fact or a fit
  with provenance; a clamp, floor, margin, gate or scale names a missing
  model (Rule 8).
* **Calibration over agreement.** The posterior's confidence matches how
  often it is right, measured, beside the narrated rows (Rule 5).

## The invariants, measured on the shipped decoder (2026-11-05)

Each is an instrument over the shipped cells (`segScore` on an
`assemblesegments` request scores any list of segments with the trellis's own
terms; the instruments are under `tests/golden/fits/instruments/invariants/`,
each with its run in `tests/golden/fits/README`):

| Invariant | Test | Shipped |
|---|---|---|
| Every hypothesis explains every observation | One fix moved over a polar grid; each state's evidence integrated over the plane (`density.py`) | Broken: no state integrates. Moving a still minute's fix, the stays level off at −23 (the place term's floor), the walk at −15 (the speed outlier share), driving, train and the journey hardly move; on a walking minute a fix 362 m off costs a stay −4 and the walk −17 |
| Splitting never pays for itself | Each narrated stay of an hour or more, one segment against the best split into two of the same state, evidence only (`split.py`) | Broken on 126 of 187: the heart-rate level, one constant per segment (07-14's office +76.9, 11-03's +20.9) |
| Each piece of evidence counts once | Walk against still on the narrated walks and stays, with the heart rate and without it, the steps kept (`once.py`) | Broken in sign, small in size: the heart rate adds a median +1.8 a walk and −2.7 a stay beside the steps; the segment level's saturation keeps it to a few nats |
| Position decides location | Walking steps and their heart rate injected into a still stretch of a stay, the fixes kept (`position.py`) | Holds at a listed place (the spells); broken at a placeless one (the day shifted off every listed place): three minutes of steps on the spot decode as a walk |
| No compensation constants | The cell's files' `Float` constants (Rule 8's count) | 112, among them the place term's floor and width, the one-minute floor, the hand cadence, the pre-filter's 250 km/h |
| Calibration over agreement | `posterior_calibration` over the narrated minutes | Broken: 49,241 minutes claimed at 0.999 are right 98.3% of the time; 5,598 at 0.000 are right 89% — every decoded ride among them (likely: the journey state's legs carry no posterior of their own) |



## What the measurements so far say

From the narrated days (instruments under `tests/golden/fits/instruments/`,
each with its run in `tests/golden/fits/README`):

| Layer | Finding |
|---|---|
| Where | A still phone's fix is tight: about 0.14 of its reported accuracy (λ 0.02 on 7² + accuracy²); 16% of a stay's minutes sit elsewhere within ~60 m (another desk, multipath); ~2% are far strays. The spot moves about 3% of minutes, by ~30 m. A place's visits sit off its pin by a spread of its own (Work ~14 m per axis, Home ~2 m). |
| What | 1 of 68 narrated walks between two named stays returns to the place it left. A stay's moving-about spells start ~1% of minutes and last ~3 min; a walk's pauses are rare once the walking cadence is fitted. |
| Body | The heart rate answers the steps within ~1.5 min (β ≈ 0.3 bpm per step/min); with that in, its level is a person's, not a mode's (walking 80.4, sitting 81.5 bpm). The level drifts: a long stay's halves differ by ~6 bpm sd; it returns to its mean over ~2 h. |
| Steps | An interior minute and an edge minute differ: a stay's edge minutes step far more than its interior, a walk's far less. |

## From here to there

Each step ships alone, under the invariants above as tests, measured on the
confirmed rows, the round trips across the history
(`instruments/roundtrips.py`), the loss report by kind
(`instruments/lossreport.py`), and time and memory (no extra CPUs; a day
computed on read stays the goal).

1. **One observation model for position, for every state.** Each state's
   density of each fix: a stay's from its spot (core, local, far), a
   moving state's from the fix before it and the mode's speed in any
   direction, both with the same noise model. Replaces the pair terms, the
   placeless centre term, the listed place's per-minute term and
   `centreSigmaM`. The invariant test: every state scores every fix.
2. **Activity apart from location.** Inside a stay, the activity chain (still
   / moving about) carries the steps; a journey's legs carry theirs. The
   spells shipped 2026-11-04 are the first part; they become the stay's
   activity rather than a correction.
3. **The body.** The heart rate as level and response to recent steps, the
   level the person's; the per-mode heart-rate means retire.
4. **Steps from activity,** the edge minute a part of each, the cadence
   fitted per activity; the hand-set cadence priors retire.
5. **Posterior output and calibration,** with `2026-10-posterior-confidence.md`.

**Step 1, built (2026-11-05)** behind `segEmission.position` (with
`listedCentre` and each place's `visitSpread`): every state scores each fix
as a density, a stay from its spot (`SegmentEmission.spotTable`), a moving
mode from the fix before at its speed in any direction (`ringLog`); the
pair, boundary, centre, place, gap, feasibility and displacement terms off.
Absent, nothing moves (scoreboard and flip rows equal to the shipped decoder).
Every stay's spot starts given the fix before it (reached across the
boundary, and inside the footprint for a listed place), and which place a
stay begins at is its posterior given the hour and that fix
(`Assemble.positionEntryTable`), so the fix is not scored twice. A segment's first fix after a gap begun before it is scored over its own
minutes of the gap, a stay's rare move stays inside the place however long
the gap, and every asleep heart-rate difference belongs to the segment it
ends in (a split at a jump hid the jump). On, alone: 14 narrated rows lost
and 3 gained (10 of them a boundary a minute off), journeys 130 of 131,
phantoms 3 → 6; with the joint emission (`hrLevel`,
`edgeCadence`, `walkPause`, spells at every stay) 47 lost and 6 gained.
11-03's office is Work throughout, split by two moves inside the building
(13:01–13:05, 19:21–19:23) — the spot's rare jump is all a stay has for
them. A stay's activity and spot together, its centre a latent of the place, lost
more rows than it saved (stays absorbed walks and dark rides). The runs:
`tests/golden/fits/README`.
With the heart rate as a drifting level answering the steps
(`awakeDrift`) and the net displacement kept (`positionDisp`), the history's
round trips are 24 against the shipped 29, and 11-03's office one stay; the
rows lost to it are short train hops merged into walks, waits into trains
and edges. A moving state may score each fix from the last that was not a
far stray (`moveHold`): correct, and neutral on both measures. What keeps
10-08's waits inside the trains is the journey's rule that a wait precedes
only a ride boarding at its station, which has no escape hatch for a line
the map does not have.

Steps 1–4 are the one knot Rule 7 describes: each has been measured alone
and each lost confirmed rows alone (`tests/golden/fits/README`, 2026-11-04
and -05), because the terms it would replace compensate for one another.
They land behind one switch and are judged together; the invariant tests let
each be checked alone before that.
