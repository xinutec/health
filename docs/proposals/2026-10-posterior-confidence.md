---
created: 2026-10-10
status: phase A built (instrument); phase B measured and refuted at two cuts and at a 720-minute cap
references:
  - decoder-roadmap.md
  - 2026-10-station-states.md
  - ../design/probabilistic-principles.md
---

# Confidence as a posterior: "don't know" is an output, not a state

The decoder roadmap's step 3. Two lines of work arrived here on 2026-10-10:
the station chain's gates (`2026-10-station-states.md`: its terms cannot move
without them) and the `unknown` state, measured below. Phase A is built
(`Hsmm.Posterior`, `examples/posterior_calibration`, harness flags
`posterior` and `unknownBelow`); read "What phases A and B measured" first.

## What phases A and B measured (2026-10-10)

**Calibration (phase A), today's decoder, 47,595 labelled minutes:** Brier
0.042; accuracy rises with confidence in every band, but the decoder is
overconfident — 98% of minutes sit above 0.9 at 0.961 accuracy, and the
0.8–0.9 band is right 0.56 of the time. About 12 s a day (43 s at most):
fine for an instrument, too slow to serve (the all-pairs transition sums in
both directions dominate; the base matrix depends mostly on the source, so
they factor).

**The phantom question, without `unknown` in the state space:** decoded rides
by confidence — below 0.5, 1 real and 71 phantom; 0.5–0.9, 7 and 7; 0.9 and
above, 98 and 16. Most phantoms are uncertain; sixteen are confident.

**Phase B, `unknown` out of the states and into the output below a cut:**

| arm | journeys | legMode | legLine | stations | phantoms | served referee |
|---|---|---|---|---|---|---|
| today (`unknown` a state) | 121 | 286 | 53 | 47 | 6 | 126 |
| no `unknown`, cut 0.5 | 111 | 288 | 58 | 53 | 22 | 122 |
| no `unknown`, cut 0.7 | 100 | 273 | 58 | 53 | 21 | 109 |
| no `unknown`, cap 720 | 113 | 290 | 58 | 53 | 36 | 124 |
| no `unknown`, cap 720, cut 0.5 | 110 | 287 | 58 | 53 | 18 | 121 |

Refuted at both: the confident phantoms stay, and cutting uncertain stretches
to `unknown` breaks journeys the state had held together.

Most of the removal arm's phantoms are a trellis artefact, not evidence: a
segment lasts at most `maxD` (240 minutes) and consecutive segments differ in
state, so a long stay must be broken, and `unknown`'s one-minute blips were the
breakers (102 of them, after stays of 229–240 minutes). Without `unknown` the
breaker is a two-minute ride. The 720-minute cap stands in for "a stay at the
cap may continue as itself": phantoms 92 → 36, and 18 with the cut, still
three times the gate, with journeys down 8–11 (04-29 loses five of six under
the cut). So the same-state continuation in the verified trellis would not
clear phase B alone, and is not built. Fitted per-mode fix shares (minutes
with a fix: stationary 0.35, train 0.43, walking 0.97, driving 0.94, against
a uniform 0.85) were refuted too: alone journeys 118, stations 42, phantoms 8;
with phase B 112/287/57/51/25. What the arms keep
is the prize (lines +5, stations +6); what is missing is the risk named
below — a model of what a dark minute says about each mode, so that the
confident phantoms stop being confident.

## What `unknown` is doing

`unknown` is a mode nobody is ever in: a state with deliberately broad
likelihoods (speed 20 ± 200 km/h, heart rate 80 ± 100) and a per-minute prior
as high as walking's. Measured over the narrated days on the decoder as of
2026-10-10:

- It holds 535 decoded minutes: 120 of them narrated as train, 40 as walking,
  375 outside any narrated movement.
- It wins a ride whenever ONE signal is atypical. 09-30's 20-minute
  Metropolitan ride is `unknown` throughout because the heart rate was 105–113
  (hurrying to the train): the train's 75 ± 15 charges about 2.7 nats a minute
  for that, `unknown`'s flat curve nothing, and the two otherwise tie.
- It is also the decoder's only way to say "no evidence". Removed from the
  state space: legMode +5, legLine +5, stations +6, but phantom rides 6 → 92
  and journeys −7. The minutes it had held were mostly dark (a fix on 4 of the
  112 that became stays, 26 of the 68 that became bike rides): without it the
  priors and transitions fill a dark stretch with some ride.
- A robust (contaminated) heart-rate term does not replace it: beyond three
  standard deviations sit under 1% of narrated minutes in every mode, and the
  09-30 readings are 2.3 deviations out.

So `unknown` does two jobs, one wrong (beating a real mode on one odd signal)
and one necessary (saying a stretch has no evidence). The second is not a
mode: it is how spread the posterior over the real modes is.

## The design

- **Forward–backward over the same trellis.** The segmental forward recursion
  with log-sum-exp in place of max, then the backward one, over the cells the
  Viterbi already builds (emission, entry, duration, transitions with the
  chain context). Cost about twice the decode's O(T·S·maxD); memory T·S
  floats per direction plus the open-run cells. It runs in `Float`, outside
  the verified integer envelope: the decoded path stays the verified Viterbi;
  the posterior only says how sure that path is.
- **Per-minute mode marginals, per-segment confidence.** A segment's
  confidence is the posterior mass of its mode over its minutes (and of its
  line, for a ride).
- **`unknown` becomes an output.** The state goes. A decoded segment whose
  confidence is below a level reads as "don't know" in what leaves the decoder
  (the same `unknown` the readers already handle). The level is read off a
  reliability curve on the narrated minutes, not chosen.
- **The station chain's gates become posteriors.** `MARGIN_NATS` and
  `ABS_ANCHOR_FLOOR` compare scores whose scale the terms set; a station is
  emitted when its sum-marginal over the chain clears a calibrated level. Then
  the anchor and transfer terms can become the densities and feasibility
  probabilities of step 1, together with their gate, which is the only way the
  2026-10-10 slice says they can move.

## Phases, each gated on the scoreboard, the served referee and the floors

- **Phase A, the instrument.** Forward–backward in Lean beside the decode, emitting
  per-segment confidence; a reliability table and Brier score of segment mode
  confidence against the narrated minutes. Changes no output. Gate: the decode
  is byte-identical; the memory smoke holds on a travel day.
- **Phase B, `unknown` out of the state space, into the output.** Gate: phantoms
  not above today's 6, journeys and the served-referee count not below today's,
  modes and lines up (the removal arm's +5 and +5 are the prize).
- **Phase C, the station chain on posteriors.** The gates go, then the terms move
  one family at a time. Gate: stations up, no wrong emission added.

## Risks

- **Calibration on 43 days.** The narrated corpus is small; the reliability
  curve gets coarse bins, and the level is chosen held out (by day, both ways
  round, as `tune_weights` does).
- **The phantoms may not be uncertain.** If the 92 phantom rides of the removal
  arm come out confident, the posterior cannot hide them, and the missing piece
  is a model of the dark (what a minute with no fix says about each mode) —
  measured in phase A before phase B is built.
- **Memory.** Two directions of float cells beside the packed trellis; the
  travel-day smoke is in phase A's gate.
