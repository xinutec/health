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

Steps 1–4 are the one knot Rule 7 describes: each has been measured alone
and each lost confirmed rows alone (`tests/golden/fits/README`, 2026-11-04
and -05), because the terms it would replace compensate for one another.
They land behind one switch and are judged together; the invariant tests let
each be checked alone before that.
