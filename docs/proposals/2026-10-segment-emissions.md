---
created: 2026-10-11
status: SHIPPED — the fitted decoder decodes production from one parameter record (`DECODER_PARAMS_JSON` from Secret `health-decoder`, written by `fit_emissions`), now s43c at CLASSIFIER_VERSION 10 (pair speeds with fitted outlier shares); held out by day 125 / 305 / 61 / 54 / 6, referee 142, and under the decoder head 143 narrated journeys against the served day's 142
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
| s33a: s32 with s30's standstill component | 120 | 299 | 62 | 51 | 5 | 135 |
| s34: s33a with the unlisted centre anchored at the minutes either side | 121 | 300 | 62 | 52 | 5 | 135 |
| s34, 09-30's boarding narrated (shipped: 120 / 287 / 53 / 47 / 6) | 122 | 301 | 62 | 52 | 5 | 135 |
| s36i: s34's form, every number from `fit_emissions` on all 43 days | 120 | 297 | 59 | 50 | 6 | 129 |
| s36loo: the same, each day's numbers fitted without that day | 120 | 298 | 59 | 50 | 6 | 130 |
| s37loo: s36 with the mainline's duration fitted apart, held out (in-sample the same) | 120 | 299 | 60 | 50 | 6 | 130 |
| s38eq: s37loo from the parameter record alone (`DECODER_PARAMS`, no patch, no `HSMM_*`) | 120 | 299 | 60 | 50 | 6 | 130 |
| s39rep: s38 with exact coordinate repeats dropped (`dropRepeatedFixes`), refitted held out | 120 | 299 | 60 | 50 | 6 | 130 |
| s40bw: s38 with the generator's window reaching back over the boarding wait (`generatorBoardingWait`), refitted held out | 123 | 300 | 61 | 54 | 6 | 135 |
| s40c: s40 on the narratives with 10-08, 10-07 and 04-29's derived rows corrected from the signal | 127 | 305 | 61 | 54 | 6 | 140 |
| s41c: s40c with pooled chains for the modes no narrated minute reaches (`poolUnobservedModes`) | 127 | 305 | 61 | 54 | 6 | 140 |
| s42sided: s40c with a minute's windowed speed the span to either neighbour, equally likely | 122 | 300 | 61 | 49 | 5 | 136 |
| s43pairs: s40c with speed on the minute pairs inside a segment (`speedPairs`), the boundary pair uniform, priors as s40c | 125 | 303 | 61 | 49 | 4 | 140 |
| s43fit: s43pairs with the speed priors refitted on the pairs, held out | 125 | 303 | 61 | 48 | 4 | 141 |
| s43b: s43fit with the boundary pair exponential at the narrated boundaries' mean (7.3 km/h) | 124 | 304 | 61 | 53 | 7 | 141 |
| s43c: s43b with an outlier share fitted for every mode's pairs and the boundary pair (EM) | 125 | 305 | 61 | 54 | 6 | 142 |
| s44wait: s43c with the station chain's wait at the board (alight) station, on 2026-10-14's narratives (s43c there: 125 / 311 / 61 / 59 / 6, 142) | 125 | 311 | 62 | 67 | 6 | 142 |
| s45cad: s44wait with the step cadence fitted for stays, walks and trains (zero share, mean, spread) | 125 | 303 | 59 | 49 | 5 | 137 |
| s45stay: s44wait with the step cadence fitted for stays alone | 127 | 309 | 63 | 68 | 5 | 137 |
| s46sig: s44wait with a stay's position spread fitted (σ 7 m; `centreSigmaM`, hand-set 150 m) | 126 | 315 | 63 | 70 | 6 | 142 |
| s47: s46sig with s45stay's cadence | 128 | 310 | 63 | 68 | 5 | 138 |
| s46now: s46sig on 2026-10-15's narratives (the baseline below) | 126 | 311 | 63 | 70 | 6 | 143 |
| s48nf: s46now with no floor under the duration prior (`durationNoFloor`) | 126 | 311 | 63 | 71 | 7 | 143 |
| s49place: s48nf with the listed place's spread fitted (σ 15 m, hand-set 150 m) | 122 | 310 | 63 | 70 | 13 | 145 |
| s49mix: s48nf with the listed place's term a fitted two-scale mixture (σ 5 m; astray σ 60 m, 6%) | 121 | 310 | 63 | 70 | 16 | 144 |
| s50place: s49mix on the blessed decode's own stays, a spread per place (σ 5–59 m; astray σ 75 m, 24%) | 119 | 310 | 63 | 70 | 20 | 144 |
| s51: s50place with a stay's inside-pair speed term out (`stayPairsOff`; its place explains its fixes) | 120 | 297 | 56 | 58 | 16 | 132 |

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
inside lit walks; stations −2. **Fitted durations** (s16, moments, the variance floored at 4,
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
off-network term is retired in the arm.

**The stop share, re-measured on the place term** (s33a: s32 with s30's
priors). Journeys 119 → 120 (05-15's platform wait and ride), leg modes
297 → 299, lines 60 → 62 (06-15, 06-28), referee 132 → 135, phantoms level
at 5; stations 52 → 51: three in-station stops (07-01 Baker Street, 07-30,
09-06) read as the train at a standstill and the boarding moves, against
two found (05-15, 06-28). s30's phantoms were the place term's alone. The
share is the recipe. The form it stands in for is a chain (a stop is a run
of minutes), measured before building it: on the narrated Tube minutes,
with a stop a windowed speed under the stays' 95th percentile (0.56 km/h),
a stop continues with probability 0.66 and begins with 0.04; stop runs
have a median of 1.5 minutes and a 90th percentile of 5 (`stopchain.py`
in the fits). So a seven-minute standstill costs a train about −6 under
the chain and −15 under the share: the chain makes a long standstill
*cheaper* for a vehicle, and the three stations it would be built for are
not its cases. A stay at a station between two legs and a train held at
its platform have the same speed; what names the stay is the journey's
structure (the station-stay convention), which is the roadmap's line and
station as decoder state, not a speed term. The chain is not built.

**A stop's centre is where the walk left him** (s34, `centreAnchor`). Read
on the five-minute stops the decoder did not place (Asda on 06-24, a stop
inside a walk on 09-06): the stop loses by 21.8 and 8.5 nats, of which its
own emission against walking's is 2.8. Most of the rest is the centre's
prior: the mixture over his places charges a stop for *where* it is, and no
other mode pays for where — a walk's minutes are scored by their
displacement, and the walk that arrives at a stop already carries its
position. The prior is now a Gaussian at the lit minutes just outside the
segment, at their own noise; the mixture stands only for a stay with no lit
neighbour. A five-minute stop's centre then costs about `−log 3.5` where it
cost about `−6`. Both stops decode (Asda as three minutes of its five, the
09-06 stop exactly); 07-01's in-station stop at Baker Street, lost to the
stop share in s33a, is back. Journeys 120 → 121, leg modes 300, stations
52, phantoms level; nothing lost. On the uncorrected narratives that is
level with the shipped decoder's 121 and ahead on every other count.

**09-30's boarding, narrated from the signal.** The narrative jumped from
the St Pancras wait (to 11:35) to the Eurostar's departure (11:59). He
walked to the platform and does not remember when; the steps say it:
1–30 steps a minute from 11:39 with the heart rate rising (the boarding
queue), 90–115 from 11:44 to 11:46 (the platform), none from 11:47 (on
board). Three `{derived}` rows fill the gap; his departure row stands. The
decoder had decoded exactly that; the shipped decoder, scored on the same
narrative, loses the journey (121 → 120). On the corrected truth: s34 122
journeys against 120, every gate bar clear.

Next: the edge minute's offset as a latent (the one-stop hop's first
minute is the walk onto the train, and the decoder now places a one-minute
ride there); the fix's accuracy in a position model rather than a speed
term.

**Held out by day** (s36). Every number in the golden fits had been fitted on
the days it is judged on, most by throwaway scripts. `fit_emissions` now fits
all of them from the labelled minutes as the decoder observes them (the
`emissionDebug` rows carry the windowed speed, the rail class, in-bed and the
minute's position; a run's displacement is the decoder's own window over
it), takes the form from the golden files, and writes one set per day without
that day (`--loo`; the harness reads a directory of per-day files). Held out
against in-sample under the same fitter: 120 / 298 / 59 / 50 / 6 and referee
130 against 120 / 297 / 59 / 50 / 6 and 129 — the fit does not lean on the
day it is judged on. Against the shipped decoder (120 / 287 / 53 / 47 / 6,
126) it clears every gate bar, journeys at level.

The fitter's own numbers are two journeys, three lines and two stations
behind s34's golden ones. Swapping one golden file at a time for the
fitter's names where: segment emission, transitions and entry counts are
neutral (the heart-rate level 4–6 bpm lower, the displacement mixtures fitted
on the decoder's window, the unlisted bandwidth 502 m against 308); the
speed priors carry it all, and within them the Tube row's standstill. Fitted
as a free two-component mixture its spread is 2 km/h and a train takes slow
platform minutes (lines −3, stations −3); defined as a minute under the
stays' 95th percentile it is 0.3 km/h on 4% of Tube minutes, still a journey
short of the golden 10% at 0.4. The golden stop numbers do not reproduce from
a fixed definition: the share was chosen across arms judged on these days,
so s34's last two journeys are in-sample selection, and the held-out decoder
is level with the shipped one on journeys, not ahead. The fitter's train
durations are a second gap the swaps measured (one journey): Tube and
mainline runs share one gamma, and the TGVs make it nearly flat.

## Next

The 29 journeys s33a misses, read one by one against their narratives
(`SCOREBOARD_JOURNEYS=1` and the decoded dump side by side), are a few
shapes; counted at s33a, to re-count before acting:

- **A short stay the decoder does not place** (about nine): a station stay
  between two legs (Baker Street on 06-29 and 07-01, Stanmore on 09-06,
  the 04-29 change), or a five-minute shop or stop inside a walk (Asda on
  06-24, 09-06 at 14:24). The station ones are the station-stay convention
  — a stay at a platform and a train held at it have the same speed — and
  belong to line and station as decoder state (the roadmap's step 2). The
  others are the price of a segment, read with `path_debug`: the Asda stop
  loses by 21.8 nats, of which 2.8 is its own emission against walking's
  (a shop reads as slow indoor walking to the stay model: windowed speed,
  steps) and the rest the entry (−3), the duration prior (−4.7), the
  centre's Occam factor (about −6) and the heart rate's (about −3); the
  09-06 stop by 8.5. Each of those priors is honest on its own; together
  they price a five-minute stop at about seventeen nats before any
  evidence, and the shop's evidence does not pay it.
- **An arrival or departure a few minutes off** (about six): the decoder's
  stay begins two to ten minutes after the narrative's or ends before it
  (06-12 at 10:29, 10-01 at 15:58, 07-16 at 14:32, 05-22 at 20:38), so a
  walk trails or leads the journey: the slow minutes at a door or on a
  platform.
- **A one-stop hop or an edge minute** (three): 07-06's one-minute hop
  read as `cycling`, 07-15's hop missed, 06-16's blip at Baker Street. The
  form still open is the boundary's offset inside its one minute as a
  latent, scored as a proper likelihood; three forms that loosened a mode
  everywhere were refuted above.
- **Bus legs** (three), decoded as `driving`: no bus state (the roadmap's
  C-bus).
- **Driving against train** (two): 05-25's drive beside the rails read as
  a train twice; 10-08's Métro 4 ride read as a drive — Paris has no line
  coverage, so the ride is `unknown_rail` against `driving` on speed alone.
- **The narrative** (three): 09-30 leaves 11:35–11:59 unnarrated between
  the St Pancras wait and the Eurostar's departure, where the decoder walks
  to the platform and boards at 11:47; 10-08's unnarrated six minutes
  between two walks; 09-30's six-minute stop inside a walk the narrative
  calls walking. 04-29's hospital grounds are not one: the rows' "partial"
  is their point-of-interest labels, and the notes say he was on foot, so
  the decoder's `driving` there is a decoder miss.

**The mainline's duration apart** (s37, `durationFits.mainline`, its own
duration class). One gamma served every train: 66 Tube runs of 16 ± 9
minutes and 19 mainline runs from a local to a five-hour TGV, so the
TGVs flattened it. A train run is the mainline's when most of its minutes
are off the route model, which is exactly what the decoder can only call
`unknown_rail`. Held out: a leg mode and a line, the journeys unchanged.

**One record** (s38eq). `fit_emissions` also writes `decoder-params.json`:
the four files, the form's settings (`decoder-form.json` in the fits: the
whole-day cap, the per-minute mode prior off, `dropUnknown`) and which days
the numbers came from. `backend::decoder_params` lays it on a decode request,
the serving path's and the harness's alike; the patch that stood beside the
arms is retired (`unknown` leaves the state space by `dropUnknown`; the place
entry's renormalisation never fired once the entry counts were on). Held out
by day through the record alone, every day and every miss identical to s37.

**Refuted: a minute's speed from either side** (s42sided). The windowed speed
spans the minutes either side of a minute, so the last minute of a stop wait
carries half the pull-away after it: 09-06 18:52 reads 9 km/h from a
standstill, a stay pays −11.7 for it, and the 48 boarding steps there make a
one-minute walk the decoder stretches over the pull-away. Scored as the span
to the minute before or to the minute after, equally likely, the 09-06
boarding decodes as narrated. Held out it loses five journeys and five
stations: short rides (06-22, 07-06, 07-16, 07-30, the 06-12 bus) decode as
walking, because on a ride of two or three lit minutes every minute is an
edge, each has a slow side, and walking's tight low-speed prior takes it —
s10's blend again, one level down. The side a minute's span belongs to is
the segmentation's to decide: speed scored on the pairs of minutes inside a
segment, with the pair across a boundary scored apart.

**Speed on the pairs inside a segment** (s43, `speedPairs`,
`pairBoundaryMeanKmh`). The per-minute speed term goes; each segment scores
the one-minute spans between its consecutive lit minutes under its own mode
(prefix sums per state, `Assemble.pairTables`), and the span across each
boundary is scored apart, mode-free: uniform over 0–300 km/h in s43pairs,
which made every boundary cost about 3 nats and swallowed short stays; then
an exponential at the mean of the 336 narrated boundaries' spans (s43b). The
fitter fits the speed priors on the same pairs (`pairKmh`). 09-06's boarding
decodes as narrated, 06-16's bus is a vehicle segment, 04-29's ride is
found. On the scoreboard s43b is three journeys below s40c, but two of its
gains are buses the scoreboard counts against `driving`; under the decoder
head (`FOLD_DECODER_HEAD`, the bus labellers run) it reaches the served
day's 142, from 141. Lost: 07-01's second journey and 07-02 (a `cycling`
minute inside a train journey); 09-06's 13:23 stop (six minutes at 1 km/h
with 12–26 steps a minute) is read as part of the walk and loses by 1.4.
07-02 was a fix that jumped (187 km/h): no mode's pairs had an outlier
share, so the jump cost about −650 inside any segment and −28 as a boundary
pair, and a jump drew a boundary. s43c fits each mode's Gaussian and its
outlier share together by EM (uniform over 0–300 km/h beside it; a vehicle's
share beside its fitted stop/move mixture), and the boundary pair's
exponential with its own share (mean 2.2 km/h, 13%). Every frozen floor
clears, the referee is 142 against s40c's 140, and under the decoder head
143 against the served day's 142. Against s40c the scoreboard loses two
walks behind a short stop with steps (09-06 13:23 by 1.4 nats, 10-08 14:51
by 0.9), which the served day misses too.

**Refuted: the step cadence fitted** (s45cad, s45stay). The cadence term's
numbers are hand-set (a stay 99% step-free, else 10 ± 20 a minute); fitted on
the narrated minutes a stay is 83% step-free, else 22 ± 21, and a train 82%,
else 28 ± 32 — the platform walks inside narrated train rows. Fitted for
every mode, trains absorb the walks at their ends: stations 67 → 49. Fitted
for stays alone the scoreboard gains (journeys 127, lines 63, stations 68),
and under the decoder head the stays gain on the served day (the gap 12 → 8
named right), but short narrated walks dissolve into the stays either side:
the referee and the headed day lose five journeys (142 → 137). A stay's steps
and a short walk's are told apart by where they go, not by how many.

**A stay's spread fitted** (s46sig, `centreSigmaM`). The placeless stay's
position term weighs each fix by `1 / (σ² + accuracy²)` about the stay's
centre, σ hand-set at `PLACE_RADIUS_M` (150 m). Fitted by maximum likelihood
on the narrated stays' lit minutes, each scattered about its own stay's
centre with its reported accuracy in quadrature: σ 7 m — the fixes' error is
the scatter, the stay itself barely moves. Held out against s44wait every
count rises (journeys 126, leg modes 315, lines 63, stations 70), the referee
holds at 142, no day loses; under the decoder head journeys and stations
hold and the stays gap to the served day is 11 named right (from 12). With
s45stay's cadence beside it (s47) short walks still dissolve into stays: the
referee and the headed day 138. The cadence stays hand-set.

**No floor under the duration prior** (s48nf, `durationNoFloor`).
`Duration.minDurationByMode` gives every mode a hand-set two-minute minimum,
under which a segment scores a flat −10 whatever its fitted gamma says (−3.7
for a one-minute walk). It is what lost 05-18's change at Baker Street: the
one-minute walk and the hop to Euston Square lose by 5.8 nats, the floor
alone costing 6.3. Without it the minute is the decoder's resolution and the
fitted duration decides: 05-18 gains the hop (a leg mode and a station),
06-16 loses a leg mode, the totals hold (stations +1), the referee 143.

**Refuted: the listed place's spread fitted** (s49place). The listed place's
per-minute distance term is −(d/150 m)²/2 floored at −3. Fitted on the fixes
of the narrated stays that name a listed place, σ is 15 m; with it a stay at
Home or Work pays the floor whenever an indoor fix strays 45 m, and the
decoder breaks it into phantom trips (phantoms 6 → 12, journeys 126 → 122,
10-07, 04-29, 06-18, 07-16), though the referee gains two. The term's form —
no outlier share, a hard floor — is what fails, not its number: fitted, it
needs the outlier share the speed pairs have.

**Refuted: the listed place's term as a fitted two-scale mixture** (s49mix;
`fits/arm-placemix-2026-10-15.patch` in the golden repository). Near σ 5 m,
astray σ 60 m at 6%, by EM on the same stays, replacing the hand-set spread
and floor. Phantoms 7 → 16, journeys 126 → 121. The fit and the term see
different populations: the fit takes the narrated stays whose place NAME is a
listed one (Home, Work; 1412 minutes), the decoder applies the result to every
listed place, including the auto-made clusters a campus visit sits 100 m from
(06-18 and 06-24 at University College Hospital, 103–110 m from the nearest
listed "Stay", speed 0: −7.6 a minute under the mixture, −0.25 under the
hand-set term). Twice refuted on the number, the form is the finding: the
listed place's spread is per place (a house and a campus differ by an order of
magnitude), and comes from the place's own cluster, not from one σ over the
named stays. The decoder's short stops wait on it: see the roadmap's
"stays gap, row by row".

**Refuted a third time, and the frame named** (s50place;
`fits/arm-placemix2-2026-10-15.patch`). The fit's population made the term's:
each narrated stay tied to the listed place the blessed decode put its
midpoint at (8156 minutes, 37 places, 27 with the minutes for their own near
spread: Home 5 m, Work 11, the hospital 21, one cluster 59), the astray
share 24% at 75 m. Phantoms 7 → 20, journeys 126 → 119. A quarter of the
minutes at a listed place sit beyond its near spread, and no spread covers a
fix 300 m off: the fitted tail charges it −17 a minute where the hand-set
floor charges −3, and the floor is not a statement about fixes at all — it
is what keeps a stay whole against modes that pay nothing for where their
fixes are. The asymmetry is the frame: every mode's position is already
scored by the pair term (`speedPairs`), and a stay at a listed place pays
the place term on top. The form that can express the fit: a stay's fixes
are explained by its place (the mixture, per place) and NOT by the pair
term; the moving modes keep the pair term. Measured (s51,
`fits/arm-staypairsoff-2026-10-15.patch`): legs 311 → 297, lines 63 → 56,
stations 71 → 58, the headed day 144 → 132. The pair term inside a stay is
not a double count of its position: a stay's near-zero spans under the
stationary speed model are most of what tells a stay from a slow ride or
a walk, and the place term carries none of that. Four arms down
(s49place, s49mix, s50place, s51); the listed place's hand-set term stays
until the per-minute model retires as a whole (the roadmap's cutover: every
mode's position under one frame), not term by term.

**The replays run under the golden record** (`decoder_params::from_env`
falls back to `tests/golden/fits/decoder-params.json`; an arm's
`DECODER_PARAMS` still wins): the frozen decodes and the blessed scoreboard
are the shipped model's (125 / 309 / 63 / 69 / 4), so an old path can retire
against byte-identical replays, and an arm reads against what is served.

**Retired: the per-minute mode prior** (`modePriorLog` out of the base
sum, `modeMinuteScale`, `modeMinuteScaleWithGps`, `modeEntryScale` and
`modeEntryLog` gone): 0 in the record since s3, so the 43 frozen decodes
replay identically and the floor holds; the fitted entry prior charges a mode
once per segment, which is what the minute prior could not do.
**Retired: the `unknown` state** (`dropUnknown`): `MOVEMENT_MODES` no
longer builds it and the flag is gone; the 43 frozen decodes replay
identically. The mode stays in the enum for the served day's labels.
**Retired: the two observation-form flags.** The generator's boarding wait
(`generatorBoardingWait`, true in every record since s32) is the generator;
the repeated-fix drop (`dropRepeatedFixes`, s39rep, neutral and never in a
record) is gone; the golden form is `maxD` alone. The 43 frozen decodes
replay identically.
**Retired: the segment-emission switches.** The six the record sets
(`speedPairs`, `speedWindow`, `lineRankOnly`, `dispPosterior`,
`accuracyNoise`, `centreAnchor`) are the only behaviour; their off-paths
(the per-minute speed term and its windowed form, `windowSpeedTable`,
`dispSegment`'s density, `gapPairs`, the unanchored centre) are gone, and
so is the s49mix code that had ridden into 5caa2cc9 inert. The golden
segment-emission form loses the six keys. The 43 frozen decodes replay
identically.
**Retired: the two-state fix chain** (`fixMarkov`, `fixMinute`). The
three-class `obsChain` lists the same four modes in every record and replaces
it for each, so the two-state chain was never reached; a mode `obsChain`
lists is the one the segment's beta-binomial skips. The 43 frozen decodes
replay identically.
**Retired: the ride's head** (#366: `rideHeadMin`, `rideHeadCredit`, the
`driving|head` and `train|head` states, the crawl mixture, the nearest-line
boarding). No record ever set `rideHeadMin`, so the states were never in the
space; with them go the per-minute mode prior's last reader and the harness's
two knobs. The 43 frozen decodes replay identically.
**Retired: the transition switches** (`noSelfMass`, `placeByEntry`, true in
every record). A segment never continues into itself, so the self-loop holds
no mass, and a transition into a stay gives the even split back, so the
entry prior alone chooses the place; the golden transition form is the
matrix alone. The 43 frozen decodes replay identically.
**Retired: the base minus what the segment scores.** Under the segment
emission a minute's base is composed of what it still carries (cadence, the
bed, a listed place's distance, a fitless mode's presence and heart rate, a
fixless minute's speed term) instead of the whole base with the segment's
terms subtracted again. The 43 frozen decodes replay identically.
**Retired: the decoder without a segment emission.** `flags.segEmission` is
required: a request without the record is refused by name, the context
carries the segment emission unconditionally, and the plain per-minute base
remains only as the parity reference the guards pin (a record with no fitted
mode composes to it). Both production workloads carry the record. The 43
frozen decodes replay identically.
**Retired: `SegmentEvidence`.** The duration term added it and the segment
emission took it back out for every mode, with the same weight over the same
window, and it is finite (clamped at −6), so it changed no decode. The
duration term is the prior alone, the `segEvidence` flag and its weight are
gone, and the module keeps only the window the displacement term reads.
`USE_SEGMENT_EVIDENCE` is read by nothing. The 43 frozen decodes replay
identically.

Left, each a model change measured as an arm: `LineProximity`'s constants,
the duration cap, and the fix's accuracy in a position model rather than a
speed term (the plumbing is in; as the speed's noise it is on). The listed place's per-minute
Gaussian and its floor stay hand-set: folding them into the placeless form
lost in all four arms (s49place to s51, above).
