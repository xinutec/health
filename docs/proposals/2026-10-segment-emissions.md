---
created: 2026-10-11
status: built behind harness flags (`flags.segEmission`, `flags.transFit`, `flags.entryCounts`); thirty-two arms measured; s32 ahead of the shipped decoder on the referee (132 vs 126), leg modes (297 vs 286), lines (60 vs 53), stations (52 vs 47) and phantoms (5 vs 6), behind on scoreboard journeys (119 vs 121) — the one gate bar left
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
| s19: s16 + the fixes' reported accuracy in the windowed speed's noise | 113 | 296 | 57 | 37 | — | not run |
| s20: s16 + the entry prior as smoothed counts of visits | 115 | 296 | 59 | 44 | 12 | not run |
| s21: s20 + the reacquire correction taken out with the Gaussian | 114 | 293 | 59 | 50 | 12 | 130 |
| s22: s21 + the fixes' accuracy in the windowed speed's noise | 115 | 296 | 59 | 50 | 12 | 132 |
| s23: s22 with the duration cap at a whole day | 115 | 296 | 59 | 50 | 8 | 132 |
| s24: s23 with the window over the nearest fixes either side | 112 | 295 | 58 | 51 | 6 | 127 |
| s25: s23 with the window one minute each side, one-sided beside a dark minute | 115 | 296 | 59 | 50 | 6 | 131 |
| s26a: s25 + the place chosen by the entry alone | 117 | 296 | 59 | 50 | 7 | 131 |
| s26b: s26a + the measured share of stays at no listed place (5%) | 117 | 297 | 59 | 51 | 8 | 132 |
| s27: s26b with an unfitted mode voting flat on displacement | 117 | 297 | 59 | 51 | 8 | 132 |
| s28: s27 with the asleep heart rate per segment, for every state | 117 | 297 | 59 | 51 | 5 | 132 |
| s29a: s28 with the Tube and mainline train speeds fitted apart | 119 | 298 | 60 | 52 | 5 | 133 |
| s30: s29a with a standstill component in a vehicle's windowed speed | 113 | 300 | 62 | 51 | 9 | 133 |
| s31: s29a with the placeless stay's centre a latent, one Gaussian prior over the listed places | 119 | 296 | 60 | 51 | 5 | 131 |
| s32: s31 with the prior a mixture over the listed places at a 308 m bandwidth | 119 | 297 | 60 | 52 | 5 | 132 |

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

**Refuted: the accuracy as the speed's noise** (s19). The fix's reported
accuracy now reaches the observation row (`GpsPoint.accuracyM`, joined by
timestamp from the raw PhoneTrack rows on the capture path and from the
capture-side fixtures in the harness; median 10 m, p90 59 m, p99 about 1 km
on the narrated days). Added in quadrature to the windowed speed's spread
(`accuracyNoise`), it costs a station on seven days (46 → 37 against s16's
44) and two journeys: at a ride's reacquisition the first fixes carry
hundreds of metres of accuracy, the speed there goes uninformative, the
boundary slides a minute, and the station chain's margins — tuned to the old
boundaries — lose the station. A tight stay's speed also pays the wider
normalisation on every minute. The plumbing stays (it is what a position
process needs); the flag stays off.

**The entry prior as counts** (s20, `flags.entryCounts`): `P(place | a stay
begins at hour h)` from each place's visit count and hour profile with two
pseudo-counts (`Assemble.entryCountsTable`), a place off the list included;
the places carry `visits` on the request. A four-visit place at an hour its
profile never saw reads −6.3 instead of −11.7. The same four counts as s16:
it retires the ratios and floors at no cost.

**A bug in the arm, found on the day of writing.** Reading the morning ride's
last minutes with `emission_debug` (which now prints the arm's share of each
emission): at the minute after Baker Street, walking's emission was +37.6 —
a positive log-probability. The arm replaces the base speed Gaussian with the
windowed speed, but the base also carries the reacquire-robust correction
(`max 0 (widened − base)`, about +70 on a 44 km/h fix shortly after a gap),
and that stayed in: walking and stays were credited twice on every fast fix
after a gap — the ride-tail minutes. With the correction factored out
(`EmissionFull.reacquireCorrection`) and taken out with the Gaussian, the
day's ride runs to Euston Square and that minute reads −48.6. Measured
(s21): stations 44 → 50, above the shipped decoder's 47 for the first time;
three counts went to `driving` blips on fast reacquire fixes inside walks,
which the bogus credit had been covering. **The accuracy as the speed's
noise, re-measured on the fixed arm** (s22): those three back, stations
held — s19's station loss was the bug's, not the accuracy's. The flag is on.

**The pottering stays are the cap.** `path_debug` scores the single home stay
26 and 19 nats *above* the decoded path on 06-09 and 05-20: those stays are
995 and 1070 minutes, over the 720-minute cap, so the trellis has to break
them somewhere, and a few minutes of `driving` at the pottering minutes is
the cheapest break — the 4-hour blips of the shipped cap, at the next cap.
With the cap at a whole day the decoder finds the single stay (wall 49 → 58 s
on that day). The duration prior's support has to cover the longest real
stay; a cap below it is a compensation, and it manufactures a ride. Measured
(s23): phantoms 12 → 8 on the lister and 10 → 6 on the scoreboard, level with
the shipped decoder; every other count unchanged. The scoreboard now decodes
the days in parallel over the Lean worker pool and writes the arm's dump in
the same pass (391 s for the 43 days, counts identical to the serial run):
an arm is minutes, not an hour.

**The four `driving` blips that remain at stays are a fix that jumped beside
a dark minute.** `emission_debug` now prints the base's parts for a named
state: at 10-02 10:05 the stay's −203 is the speed Gaussian on the fix's own
20 km/h — the windowed speed fell back to the raw fix speed whenever a
neighbouring minute was dark, and the phone's 300 m-accuracy fixes beside it
had been dropped as outliers, so the neighbour *was* dark. The window is now
the net speed between the nearest fixes either side of the minute (tabled
once per minute, `windowSpeedTable`), the same quantity as before when both
neighbours are lit and the span's own GPS noise when they are not. The two
stays read as stays (+198 and +52 at the jump minutes).

Measured two ways. **Over the nearest fixes either side, however far** (s24):
the stays are right and phantoms reach 6 on the lister, but the referee
falls 132 → 127: a lit minute after a tunnel was handed the whole gap's net
speed as its own (30 km/h on the first walking minute off a train), and
`driving` and `cycling` blips appeared at alightings. **One minute each
side, one-sided beside a dark minute, never across a gap** (s25): the same
counts as s23 on everything, phantoms 8 → 6 on the lister and 6 → 4 on the
scoreboard, referee 131. The gap term owns the gap; a window describes its
minute or nothing.

Against the gate: phantoms level with the shipped decoder's 6, referee 131
against 126, stations 50 against 47; scoreboard journeys 115 against 121 is
the bar left. The six phantoms left are three one-minute Metropolitan blips
inside walks, a one-minute night blip, and two `driving` stretches at stays
(04-29 on the hospital grounds, which the narrative itself marks partial;
06-17, three minutes).

**The 04-29 dark stop, and the entry prior's unlisted place.** A nine-minute
dark, near-stepless stop reads as `train|unknown_rail`; the placeless stay
loses by 4.2 nats, paid twice at its entry: the walk-to-stay transition
still split evenly over 119 stay states, and the counts prior pricing a
place not on the list at `α/(V + α(K+1))`, about 0.15%. Measured by position
on the narrated days, 8 of 162 lit stays (5%) are more than 150 m from every
listed place — the list is mined from his own fixes, so it is wide — so the
unlisted share is a measured number (`entryCounts.newShare`), not the
Dirichlet's. The place chosen by the entry alone (`placeByEntry`, neutral in
the morning on a prior that was ratios and floors) now carries: journeys
115 → 117, the two 04-29 walks back and nothing else moved (s26a); the
measured share adds a leg mode, a station and a referee point (s26b). Both
add a one-minute night blip: a stay at Home becoming a placeless stay at
waking, bridged by a one-minute `plane` — the stay-to-stay hard zero is
right, and the bridge is cheap only because a mode with no fitted
displacement had no vote in the displacement posterior.

**An unfitted mode votes flat** (s27): a plane or a bicycle has no fitted
displacement, so its vote is the flat component (anywhere within 300 km/h
over the span). The one-minute plane became a two-minute train: the bridge
was wanted, not merely cheap. **The night's heart rate per segment** (s28):
the per-minute asleep term's mean depended on the state — 58 ± 10 at a known
place, the mode's own anywhere else — so at waking, with the heart rate
rising in bed, Home lost 0.3 to 0.7 a minute to a placeless stay for two
hours and the decoder bought the change with a bridge. Measured on 54
narrated nights: in bed 63.5 bpm, the nights' means spread 5.2, within a
night 5.1 with lag-1 0.68 — a random effect per segment, the same for every
state (`Params.asleep`), and the minute term comes out for all. Phantoms
8 → 5 on the lister and 6 → 3 on the scoreboard; nothing else moved. Three
of the five left are one- and two-minute Metropolitan blips inside walks.

**Two train speeds** (s29a). Read on the 05-15 and 07-07 blips with the
parts printed: on an above-ground Metropolitan stretch with 50–200 m fixes,
the train's one speed Gaussian — fitted on a pool of Tube and TGV minutes,
42 ± 47 km/h — is nearly flat, so `driving` ties it at 40 km/h and takes the
minutes without steps. Measured apart on the narrated minutes: Tube lines
38.8 ± 26.3 km/h, the other lines 163.5 ± 388. The state already carries
which it is (`unknown_rail` against a named line), so the mainline speed is
a fitted parameter beside the metro one (`fittedPriors.mainlineSpeed`).
Journeys 117 → 119, leg modes 298, lines 60, stations 52, referee 133. The
mainline's spread says the next form: a train stops (21% of mainline
minutes, 10% of Tube, 28% of driving at a standstill on the narrated days),
so a vehicle's speed is a stopped-or-moving mixture, not one Gaussian.

**Refuted: a vehicle's stop as a share** (s30). A standstill component
beside the moving Gaussian in a vehicle's windowed speed
(`ModePrior.stopShare`: the narrated minutes at a standstill, Tube 10%,
mainline 21%, driving 28%, the moving fits re-measured without them). It
finds 05-15's platform wait and takes the `driving` out of 09-30's boarding,
but journeys 119 → 113 and phantoms 5 → 9: four lit stays abroad — a café, a
dinner, a beach bar, a Paris café, 32 to 100 minutes, none on his place
list — read as `train|unknown_rail`. `path_debug` on the 10-04 café: the
placeless stay emits −387 over its 84 minutes, the mainline train −281. Not
the stop: on a stopped minute the mixture prices the train at about −1.5
and the stay's own Gaussian at −0.9. The gap is `placeTerm`: a stay at no
listed place pays `OFF_NETWORK_LOG_PRIOR` (−2) on every lit minute, 168
nats over the café, where a train pays nothing for its position; before
s30 the mainline's 0 km/h minutes cost −7.1 each under its 206 ± 426 km/h
Gaussian and covered it. A per-segment fact (where the stay is) charged per
minute, Rule 7's shape, beside `newShare`, which already prices the
unlisted place once at the entry. The stop share stays off; the form it
asked for — a stop is a run of minutes, a chain, not a share — waits behind
the place term.

**The placeless stay's centre as a latent** (s31, `unlistedCentre`). The
fixes scatter around a centre at the place radius and their own reported
accuracy, the centre a draw from a prior, integrated out in closed form
from weighted position prefix sums: the scatter about the centroid and one
Occam factor per segment, floored at every fix an outlier (the listed
place's per-minute floor; without the floor a stay hypothesis spanning a
day's travel overflowed the packed trellis). Two things found on the way.
The duration tensor is built once per class keyed by mode and named train,
with the class's first state standing in for all of them, so a per-segment
term that depends on the place is silently scored with the wrong state:
the placeless stay is now its own class, and `path_debug` and the trellis
agree again. And the prior matters: as one Gaussian over the listed places
its spread is 221 km (London to Spain), so a free centre pays the Occam
factor of that disc — −16.6 for a seven-minute in-station stop at Baker
Street that the per-minute term charged −14, and the decoder boards the
Met five minutes early. Journeys and phantoms level with s29a; leg modes
−2, a station and two referee points, both boundary shifts: that stop, and
two slow station-approach minutes on 10-08 that the placeless stay takes
from the walk by 2.4 nats. Measured on the narrated days: 9 of 110 lit
stays are beyond 150 m of every listed place, all within 700 m, root mean
square 308 m — an unlisted place is near a listed one. The prior is a
mixture of Gaussians at that bandwidth over the listed places (s32), the
bandwidth a number in the fit artefact. Measured: the in-station stop is
back; journeys, lines, stations and phantoms level with s29a, a leg mode
and a referee point behind on 10-08's two approach minutes. The per-minute
off-network term is retired in the arm, and s32 is the recipe: the stop
share (s30) can be re-measured on it, since the place term no longer leans
on the vehicle's speed to price a long unlisted stay.

Next: the edge minute's offset as a latent (the one-stop hop's first
minute is the walk onto the train, and the decoder now places a one-minute
ride there); the fix's accuracy in a position model rather than a speed
term.

## Next

- The listed place's per-minute Gaussian and its floor are the next step of
  the placeless stay's form (s31/s32): the same prefix sums score a stay at
  a known centre in closed form, with a fitted outlier share in place of the
  floor.
- The edge minute: a boundary falls inside a minute, so the minute is a
  mixture of two modes. Three forms that loosened a mode everywhere were
  refuted above; the form still open is the boundary's offset inside its one
  minute as a latent, scored as a proper likelihood. The one-minute
  Metropolitan blips inside walks and the one-stop hops decoded a minute
  short are its cases.
- Two narratives to settle, not the decoder: 09-30's journey begins at
  boarding (three walking minutes to the platform, a standing train from
  10:47) where the narrative starts it at departure; 04-29's hospital
  grounds (ten minutes of slow drift with no steps) are marked partial.
- Held-out fits by day before anything ships: every number in the golden
  fits was fitted on the days it is judged on.
- The gate: scoreboard journeys not below the shipped 121 (119 at s29a);
  phantoms, referee and stations already clear it. Then the flags become
  defaults and the old paths retire — `SegmentEvidence`, the per-minute
  heart-rate, presence and asleep terms, `unknown`, the per-minute mode
  prior, `LineProximity`'s constants, the self-loop mass, the duration cap.
- The fix's accuracy in a position model rather than a speed term (the
  plumbing is in; as the speed's noise it is on).
