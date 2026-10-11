---
created: 2026-10-11
status: built behind harness flags (`flags.segEmission`, `flags.transFit`); five arms measured, not at the gate yet
references:
  - decoder-roadmap.md
  - 2026-10-posterior-confidence.md
  - ../design/probabilistic-principles.md
---

# Correlated evidence: segment-level heart rate, a fix-presence chain, fitted displacement

The decoder scores every minute as an independent observation. Heart rate and
fix presence are not independent from minute to minute, so a small bias
between two modes compounds with a segment's length without bound. The
hand-set emission numbers, the `unknown` state and the per-minute mode prior
have been compensating for that, which is why refitting the numbers one at a
time makes the decoder worse (below). This replaces the per-minute terms with
models of how each signal is generated, with parameters fitted on the
narrated days.

## What the narrated days say

Over the confirmed runs of the 43 narrated days (consecutive rows of one mode):

- **Heart rate is mostly a property of the run.** Lag-1 autocorrelation 0.81
  in stays and 0.82 on trains (0.57 walking); the spread between runs' means
  (about 9 bpm) is as large as the spread within a run (about 8).
- **Fix presence switches between long regimes.** The spread of a stay's fix
  share across runs is 0.46 where independent minutes would give 0.04; 20 stays
  have no fix at all and 84 one every minute. Per minute: a stay keeps a fix
  with probability 0.98 and gains one after a dark minute with 0.009; a train
  switches far more (0.85 and 0.10); a walk is lit (0.998 and 0.31).
- **A ride goes somewhere.** Net speed between the fixes bracketing a run:
  trains p5 15 km/h, median 30; walks median 3.5; a stay's net displacement
  median 33 m. One of 73 narrated train runs is under 2 km/h.
- **The hand-set per-minute table is wrong as a description** (heart-rate
  means 10 to 12 bpm off for stays, trains and cars; steps in 16% of stay
  minutes against 1%), but refitting it per minute, held out by day, lost 13
  stations and kept 73 phantom rides: correct marginals, scored as
  independent minutes, still compound.

## The model (`Verified.Hsmm.SegmentEmission`)

- **Heart rate, per segment** (awake minutes): the segment's mean is a draw
  around the mode's mean (spread τ, pooled), the minutes scatter around it
  (σw) with lag-1 correlation ρ, leaving `nEff = n·(1−ρ)/(1+ρ)` independent
  minutes; the term is the closed-form marginal in the segment's count, sum
  and sum of squares, from prefix sums. Asleep minutes keep their term.
- **Fix presence, a two-state chain per mode**: each minute scores
  `P(fix | the minute before)`. A regime change costs one switch.
- **Net displacement, per segment**: a ride's net speed lognormal, a stay's
  displacement in metres lognormal, every mode with a fitted outlier share
  spread over 0–300 km/h (a round trip, a bad fix), so it is evidence and
  never a veto. It replaces `SegmentEvidence` (its net-speed table, 200 m
  noise floor, 500 m/min slop and −6 clamp) for the modes it is fitted for.

Per-segment terms enter through the duration hook (`durAtFrom`, the same path
`SegmentEvidence` takes), tabulated per day: the trellis and its proofs do
not change. Modes with no narrated runs (cycling, plane) keep the per-minute
terms. Cost at a 720-minute cap: about 22 s for a heavy day against 18 s
without the terms (13 s shipped at 240).

**Refuted on the way: fix presence as one beta-binomial per segment.** It
assumes a segment's fixes are exchangeable, so a stay that goes from dark to
lit reads as two stays, and the decoder splits it with a one-minute ride (the
4-hour-cap blips' successors at 05:5x on the Spain days).

## Measurements

Scoreboard (journeys, leg modes, lines, stations, phantom rides) and the
served-day referee (journeys matched of 149). Every arm below has `unknown`
out of the state space, no per-minute mode prior, a 720-minute cap and the
place entry normalised over places per hour.

| arm | journeys | legMode | legLine | stations | phantoms | referee |
|---|---|---|---|---|---|---|
| shipped decoder | 121 | 286 | 53 | 47 | 6 | 126 |
| per-minute terms as shipped (x2) | 83 | 287 | 60 | 51 | 90 | 121 |
| x2 + fitted per-minute fix shares (x3) | 94 | 288 | 58 | 51 | 52 | 120 |
| x2 + full per-minute refit, held out (x4) | 79 | 285 | 57 | 38 | 73 | 124 |
| s1: segment heart rate + beta-binomial fixes | 97 | 288 | 59 | 49 | 54 | 123 |
| s2: s1 + fitted displacement | 101 | 285 | 56 | 44 | 37 | 121 |
| s3: s2 with the fix chain | 100 | 283 | 56 | 44 | 21 | 117 |
| s4: s3 + fitted transitions | 99 | 283 | 59 | 45 | 21 | 115 |
| s5: s4 + a per-minute speed outlier share | 104 | 247 | 21 | 5 | 12 | 106 |

From x2 to s3 the phantoms fall 90 → 21 and every long phantom (hours of
"train" or "driving" inside a stay) is gone. Of s3's 21, 13 are one- or
two-minute `cycling` blips: a walking minute whose fix speed jumped. s3 against s2
loses two short walks (06-18, 05-20) and moves a drive's start (06-02).

**Fitted transitions** (s4, `Transitions.fittedWeight`, `flags.transFit`): the
mode-to-mode matrix from consecutive confirmed rows (418 changes: walking ↔
stationary 248, walking ↔ train 144, nothing for cycling), add-one smoothed,
each mode's share split evenly over the states of that mode a state may move
to; the hard zeros stay. Before it, a stay's outgoing mass was split evenly
over every valid state, so the many train-line states held most of it and
cycling as much as walking. Lines +3, stations +1, but the cycling blips stay:
they are paid for by the speed term, not the transition.

**Refuted: a per-minute outlier share on speed** (s5). The cycling blips are a
walking minute whose fix speed jumped (23 and 32 km/h at a cadence of 108);
walking's Gaussian (5 ± 2) charges about 58 nats for it and cycling takes the
minute. An outlier share (walking 1.9%, measured beyond four standard
deviations) removes those blips and halves the phantoms, but it also prices a
walk at train speed at about 10 nats a minute instead of about 90: walking
splits rides at their edges, and lines fall 59 → 21, stations 45 → 5. A fix
that jumped is a one-minute event, not a rate; it needs that form.

## Next

- **A speed glitch as an event**: the minute after a jump scored against the
  minutes around it (the speed the fixes on either side imply), so one bad fix
  cannot flip a walk, while a run of fast minutes still reads as a ride.
- Speed in the same form (a segment's jitter around its mean).
- Held-out fits (by day) before anything ships.
- Gate: phantoms not above the shipped 6, journeys and the referee not below
  the shipped counts. Then `unknown`, the per-minute mode prior and the
  per-minute heart-rate and fix constants retire.
