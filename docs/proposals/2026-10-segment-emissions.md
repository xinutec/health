---
created: 2026-10-11
status: built behind harness flags (`flags.segEmission`, `flags.transFit`); nineteen arms measured; s16 (no self-loop mass, displacement as the mode's posterior, fitted durations) ahead of the shipped decoder on the referee (132 vs 126), leg modes and lines; behind on scoreboard journeys (115 vs 121), stations (44 vs 47) and phantoms (12 vs 6)
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
| s6: s4 + windowed speed | 102 | 287 | 61 | 41 | 9 | 118 |
| s7: s6 + speed Gaussians fitted on windowed speeds | 103 | 287 | 60 | 41 | 11 | 119 |
| s8: s7 + the observation chain | 106 | 289 | 60 | 42 | 11 | 122 |
| s9: s8 + fitted per-minute cadence | 108 | 284 | 56 | 30 | — | not run |
| s10: s8 + edge minutes as mixtures | 103 | 284 | 58 | 43 | 19 | not run |
| s11: s8 without `LineProximity` | 110 | 291 | 40 | 34 | 11 | not run |
| s12: s8 with `LineProximity` ranking lines only | 110 | 291 | 59 | 46 | 11 | 126 |
| s13: s12 + a step chain in place of the cadence term | 93 | 265 | 52 | 28 | 5 | not run |
| s14b: s12 + the place chosen by the entry alone | 110 | 293 | 60 | 45 | 10 | not run |
| s14a: s12 without the self-loop's cross mass | 113 | 295 | 61 | 46 | 10 | not run |
| s14ab: both | 113 | 296 | 60 | 45 | 11 | not run |
| s15a: s14a without the per-segment displacement | 114 | 298 | 60 | 44 | 21 | not run |
| s15b: s15a + gap pairs spread over their dark minutes | 115 | 297 | 59 | 44 | 19 | not run |
| s17: s14a with the displacement as the mode's posterior | 115 | 296 | 59 | 44 | 11 | not run |
| s16: s17 + duration priors fitted on the narrated runs | 115 | 296 | 59 | 44 | 12 | 132 |
| s18: s16 + the measured stationary cadence (16% of stay minutes with steps) | 115 | 288 | 60 | 44 | — | not run |

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

**Windowed speed** (s6, `speedWindow`): the cycling blips were not one bad fix
but GPS scatter — fixes hopping 100–200 m sideways every thirty seconds while
the track advanced at walking pace, which reads as 20–40 km/h fix to fix. A
minute's speed scored as the net speed between the minutes either side of it
(their mean positions, two minutes apart) cuts walking's 99th percentile from
23 to 15 km/h and a stay's tail entirely, on the narrated minutes. Phantoms
21 → 9; leg modes and lines above the shipped decoder; stations −4.

Of s6's misses against the served day, ten are rides read as `driving`
(Tube rides above ground, the TGVs, the Paris Métro): the fix chain was fitted
on trains that are mostly underground, so a lit train minute costs a train
more than a car.

**Speed fitted on windowed speeds** (s7): stays 0.1 ± 0.4 km/h (floored at
1), walks 3.6 ± 2.9, cars and buses 16 ± 12, trains 42 ± 47 (against the
hand-set 0 ± 2, 5 ± 2, 40 ± 20, 50 ± 30). Neutral on the counts, but it no
longer breaks stays as the per-minute refit did: with the scatter windowed
out, the fitted spread is safe. Kept, as a fitted table in place of a hand-set
one.

**The observation chain** (s8, `obsChain`): a minute is one of three classes —
no fix, a fix within 30 m of a railway (the measured GPS noise), a fix
elsewhere — scored given the minute before by a 3×3 chain per mode. It carries
fix presence and rail adjacency together. Within 30 m of rail: 68% of train
fix-minutes, 6% driving, 9% stationary, 19% walking; but a stay keeps its
class (0.985 near → near) where a car does not (0.33), so a stay beside the
tracks is not pulled toward a train while a hop on the rails is one. It
replaces the fix chain. Journeys +3, leg modes +2, referee +3.

**Refuted: fitted per-minute cadence** (s9). A one-stop hop's minute holds the
walk onto the train (cadence 92 at 34 km/h); the hand-set train cadence (99%
zero, 5 ± 10) charges it 49 nats and cycling takes the minute. The narrated
fit (18.5% of train minutes with steps, 29 ± 33) is the truth about edge
minutes, but applied to every minute it lets rides take the walks' edge
minutes: stations 42 → 30. Third instance (with the speed outlier share and
the platform waits) of one cause: a segment boundary falls inside a minute,
so the edge minute is a mixture, and loosening a mode everywhere to absorb it
moves every boundary.

**Refuted: edge minutes as mixtures** (s10). A segment's first and last minute
scored as half its own mode and half its neighbour's (by the fitted
transitions): a blended minute can score better than either pure mode, so a
boundary placed at an awkward minute is rewarded and short segments get
cheaper — phantoms 11 → 19. The edge minute is real; it needs a model where
the boundary's position inside the minute is a variable, not a blend at every
boundary.

**`LineProximity` ranks lines and nothing else** (s12, `lineRankOnly`). Its hand
constants (+1.5 on a line's track, −2.5 off it or nearer a road) did two
jobs: the mode (train or not) and the line. Removed (s11), the mode decision
improves (journeys +4, leg modes +2) and the line is lost (lines 60 → 40,
stations 42 → 34). Kept only as a ranking — each minute the best train state's
term is subtracted from every train state's — it picks the line and leaves the
mode to the observation chain: journeys 110, leg modes 291, lines 59, stations
46, referee 126, level with the shipped decoder.

**Refuted: steps as a chain** (s13). Steps are bursty (15% of a stay's and a
train's interior minutes have some), so the cadence term was put in the
chain form that worked for fixes: three classes (none, under 60 a minute,
walking cadence), each minute given the one before. Phantoms reach the gate
(5) but walks bleed into rides: narrated trains keep walking cadence from one
minute to the next at 0.67 (0.63 with the rows' edges, 0.67 with three
minutes trimmed — interchanges inside a row, or the watch counting a bumpy
carriage), so a train pays about 0.3 nats a minute more than a walk for a
walk's steps, where the hand-set term charged about 50. Journeys 110 → 93,
stations 46 → 28. About 70 such transitions cannot tell labelling from
behaviour; the strict hand-set step term stays until they can.

## Where s12 loses: the price of a segment

Of the 149 truth journeys, s12 misses 39 (`SCOREBOARD_JOURNEYS=1`). Read one
by one, most are one shape: a short segment the decoder does not place — a
10-minute pharmacy stop inside a walk (06-18), a 4-minute walk between two
hospital buildings (06-18), a 135 m walk from a hotel to dinner and back
(09-30), a one-stop hop of two minutes between walks (07-01, 07-02, 07-14,
07-15). Each lost stay also joins two truth journeys into one decoder journey,
so it costs twice.

`path_debug` (the decoded path against the truth's segmentation, term by term,
with the model's own cells) puts the margin at 1 to 12 nats, and names what
a segment pays before any evidence is read:

| term | per boundary or segment | form |
|---|---|---|
| the self-loop's cross mass, `log 0.05` | −3.0 per boundary | a compensation: the duration prior already owns a segment's length |
| the even split of a mode's share over its states | −4.8 per entry into a stay (119 stay states), −2 to −3 into a line | the place is also chosen by the entry prior, so it is paid twice |
| the entry prior | −5 to −12 per stay (a 4-visit place at an hour its profile never saw: −11.7) | floors (`0.001` an hour, `1/(10·nPlaces)` a place) multiplied: a prior with no smoothing |
| the heart-rate marginal's between term | about −3 per segment | a proper Occam factor for a new segment mean |
| the net-displacement density | −4 to −8 per segment | a per-segment statistic scored as an independent observation |
| the duration prior | −3.6 for a short walk, −4.6 for a 2-minute ride, −10 under the floor | hand-set gammas, nearly flat |

A stay–walk–stay excursion therefore starts about 35 nats behind, and a
one-stop hop about 25. The first three rows are compensations (design Rule 8)
and the fifth is a count bias: a density over a segment's net displacement is
about `−log(scale)` whatever the displacement, so every extra segment pays
−4 to −8 for existing — the single 25-minute walk on 07-14 pays one such term
where walk–hop–walk pays three. The honest form scores each fix-to-fix pair
once, under the mode of the minutes it spans, so the count of terms does not
depend on the segmentation. On the narrated runs the pairs that matter are the
gap-bridging ones: stays' fixes two or more minutes apart land a median 5 m
from the last (p90 50 m), trains' a median 35 km/h (p10 16); walks are lit
every minute, where the windowed speed already scores them.

**The cross mass** (s14a, `transFit.noSelfMass`): journeys 110 → 113, with
both 06-18 segments, three one-stop hops and the 09-30 return walk found, and
three lost to new edge segments (a walk minute before a taxi, one after a
drive, a cycling blip). **The place split** (s14b, `transFit.placeByEntry`)
finds the pharmacy and loses a journey to a short drive; on top of s14a it
adds nothing. Kept out until the entry prior is remodelled, since both are
about who chooses the place.

**Refuted: the displacement off, and as gap pairs** (s15a, s15b). Without
the per-segment density, phantoms 10 → 21: dark stretches inside stays read
as rides again (09-14: 33 minutes of `train` inside an eight-hour dark stay,
on a few pottering steps a minute), because the density was also the only
term that priced a ride with no net displacement. Scoring each gap-bridging
pair once and spreading it over the dark minutes it spans (`gapPairs`) does
not restore that: a 33-minute phantom inside an eight-hour gap carries a
thirtieth of the pair's evidence. The pair's displacement belongs to the
moving minutes inside the gap, which a per-minute term cannot know.

The form that keeps the evidence and drops the count bias: the segment's
displacement as its *vote for the mode* — `log f_mode(D) − log Σ_m f_m(D)`
over the modes with a fitted displacement (`dispPosterior`), the posterior
of the mode under a flat prior. At most 0, about 0 for a displacement typical
of the mode, the log odds against for one typical of another; a ride with no
net displacement still pays, and a segment no longer pays for existing.

**The posterior form** (s17): journeys 115, phantoms 11 — the count bias gone
without s15's phantoms. Against s14a it finds five more (a drive, the 09-30
dinner walk, three short segments) and loses four to short `driving` blips
inside lit walks; stations −2. **Fitted durations** (s16, maximum likelihood
on the narrated run lengths: walking Γ(2.4, 0.19), train Γ(1.1, 0.046),
stationary Γ(0.84, 0.006), driving Γ(1.3, 0.08)): the same four counts, one
more phantom. Nearly flat below fifteen minutes — one-stop hops are common in
the narrated runs — so they replace four hand-set pairs and price out no blip.

What is left of the phantoms is one shape: a stay whose wearer potters (steps
in 16% of a stay's minutes on the narrated days, against the hand-set 1%)
while the fixes scatter at 1–3 km/h, read as six to eight minutes of
`driving` or `cycling`. **Refuted: the measured stationary cadence** (s18,
zero share 0.84, 22 ± 21 steps when not): leg modes 296 → 288 and phantoms
up — stays absorb the walks' edge minutes, the s9 pattern for one mode. The
scatter is the fixes' own reported accuracy (40–150 m indoors), which the
frozen fixtures and the observation rows do not carry; the term that reads it
is the next form, and the capture-side fixtures have it.

Next: the fix's accuracy on the observation row and in the windowed speed's
noise; the entry prior as smoothed counts of stay beginnings; the edge
minute's offset as a latent (the one-stop hop's first minute is the walk onto
the train, and the decoder now places a one-minute ride there).

## Next

- The remaining misses against the served day, read one by one (the method
  that found every piece above).
- Speed in the same form (a segment's jitter around its mean).
- The boundary's position inside its minute as a latent (one shared edge
  minute per boundary, a proper likelihood over the offset) — the form the
  three edge-minute refutations (s5, s9, s10) point at.
- Modes with no narrated runs (cycling, plane, bus) keep the hand-set
  per-minute terms, and the remaining blips are theirs: EM over the captured
  days with the narrated days clamped (roadmap step 3) fits them.
- Held-out fits (by day) before anything ships.
- Gate: phantoms not above the shipped 6, journeys and the referee not below
  the shipped counts. Then `unknown`, the per-minute mode prior and the
  per-minute heart-rate and fix constants retire.
