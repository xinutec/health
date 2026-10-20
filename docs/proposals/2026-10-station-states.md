---
created: 2026-10-10
status: S1 measured and refuted; not built
references:
  - decoder-roadmap.md
  - 2026-07-continuity-c4.md
  - ../design/probabilistic-principles.md
---

# Stations as decoder states

The decoder roadmap's step 2 ("line and station are decoder state"), designed
against what the decoder misses today. S1 was built, measured on three arms
and reverted; read "What S1 measured" before building any of it again.

## What S1 measured (2026-10-10)

A platform as a synthetic place at the station (negative place id), in the
station-graph table for the lines that call there, candidates within 200 m of
a fix at stay speed, behind an arm knob. Scoreboard, 43 days:

| arm | journeys | legMode | legLine | stations | phantoms |
|---|---|---|---|---|---|
| baseline | 117 | 280 | 53 | 45 | 6 |
| one platform state per station | 114 | 279 | 52 | 48 | 7 |
| board and alight platforms (left only into, entered only from, a train); the wait folded into the ride | 113 | 280 | 54 | 50 | 8 |
| the same; the wait left a stay | 115 | 274 | 52 | 46 | 7 |

- **The premise was half wrong.** The narratives split a journey at any stay of
  `JOURNEY_PAUSE_MAX_S` or more, waits at stations included (Finchley Road 20
  min, Victoria 17, Hendaye 35 and 36, Montparnasse 38; Baker Street 5). The
  fourteen misses below are the decoder holding eight or nine minutes still
  where the narrative has a walk: a timing disagreement, which a platform
  state does not touch.
- **A platform without its own priors displaces what is near it.** It pays the
  visit-weight fallback and no hour profile, and the stay's 200-minute duration
  Gamma: a focus place beside a station lost to it (06-16, 05-22), an evening
  stay became a platform and a one-minute ride (10-04, a phantom). A platform
  state needs a measured entry rate and wait-length distribution; the eight
  narrated waits (5–38 min) are too few and too wide to fit one.
- **What the misses were instead: a reading convention.** The decode is right
  that he stood still (no steps, a fix a minute); the narratives fold a short
  wait into the walk or ride beside it. Of every decoded stay touching a
  train, 25 of 28 under ten minutes were narrated as movement and 7 of 8 of ten
  or more as a stay: `HsmmSegments.foldRideWaits` reads it so (one train
  neighbour only; between two rides the chain re-lined a joined ride). Shipped:
  scoreboard journeys 117 → 119, legMode 280 → 283, stations 45 → 47; on the
  served referee 121 → 122 of 150.
- **What it does buy is stations:** +5 with the wait folded, where the station
  the person stood at names the ride's end. That is evidence for the anchor
  half of S3, not for S1 as a decode change.

## What the short hop costs (2026-10-18)

Where the decoder still loses stations and journeys, measured on the 196
narrated train sides: 158 have a chain leg and the gates emit 150 of them, all
right (`2026-10-posterior-confidence.md`); 20 are rides on lines outside the
route model (`unknown_rail`: the Netherlands, the Eurostar, Paris, the Basque
coast); 8 are short hops decoded as a walk — Baker Street → Euston Square
after a change (05-18, 07-02) and Euston Square → King's Cross (07-07 drawn a
minute short; the history sweep finds that hop walked on 11 more days). The
same hops are the three physically impossible legs left under the flip
(05-18, 06-16, 07-02).

Why the decoder walks them, on 07-02's two-minute hop to Euston Square
(`path_debug`): the hop's own minutes favour the ride by 5.9 nats (no steps,
38 km/h, the train stopped at Great Portland Street), but walk + hop + walk
costs against one walk 6.5 of duration priors, 10.5 of segment-level emissions
(each segment draws its own heart-rate level and fix share) and 3.8 of
transitions: −12 net. That is the right Occam for almost every two-minute blip
inside a walk; what makes this one a ride is structure the model does not
carry: it starts where the change at Baker Street ends, on a line that calls at
both ends, at the line's run time between them. No per-minute term separates
it (the cadence forms, a ride-end penalty, a boarding credit at served stops:
all refuted, `decoder-roadmap.md` and the segment-emissions log). The same −12 by term
(`path_debug`'s `segParts`, 2026-10-18), hop minus walk: the fix pairs inside
the segments +19.2, minute emissions +6.0, the entry credit +3.0; against them
the pair across each new boundary −15.5 (two at −7.7), the short segments' net
displacement −8.6, duration priors −6.6, the extra segments' heart-rate and
fix-share levels −5.6, transitions −3.7. The largest is one pooled model: the
boundary span is an exponential fitted on every narrated boundary (mean 2.1
km/h, 14% outliers to 300 km/h), and it differs by the modes either side —
walk ↔ stay 214 spans, mean 1.8 km/h, none over 20; train ↔ walk 111, mean
18.2, 34% over 20 (the ride pulling away). A ride's boundary pays the outlier
price.

So the hop is not one missing structure but every per-segment model fitted
on typical segments, each charging a two-minute dark ride a little. In order
of size, each a fitted model and each measured alone: (1) the boundary span
per mode pair — a transition term over time (the per-pair rows the chain
context already uses), the vehicle side a mixture of the slow span and the
vehicle's moving speed; about +4.6 on 07-02; (2) a ride's displacement and
duration from the pair its ends imply (the line's run time between the
stations nearest the bracketing fixes), not one lognormal and one Gamma for
every ride — this is S2's second form, without the board station in the
state; (3) only then the per-segment heart-rate level, whose Occam is right
for most splits.

Measured the same day: (1) built and held out (golden fits
arm-boundaryclass-2026-10-18.patch) is neutral — 125/309/63/67/4, referee 143
against 125/309/63/68/4, 143 — and gains no hop; (2) is smaller than it looked:
the fitted ride duration is nearly exponential (shape 1.09), a two-minute ride
already costs what a twenty-minute one does, and the hop's displacement is 3.4
worse than a typical ride's. On 07-02 the hop's evidence is about +25 against
about −37 for two extra segments; (1) and (2) together recover about 8. The rest
is the per-segment levels and durations of the walk either side, scored as two
independent walks. The walk that resumes after a two-minute ride is the same
walk: a level shared across the journey (the heart-rate and fix-share levels
drawn once per journey, not per segment) is the model the hop needs, and it is
a change to the segment emission, not to the station chain.

## Where the decoder stands

Both graded by the served day's own referee (`journeyshape`: shape and
coverage) on the 150 narrated journeys of the corpus, 2026-10-10:

| | journeys matched |
|---|---|
| served day (the cascade) | 143 |
| the decoder alone | 121 |

The cutover (roadmap Phase 4, step 4) needs those 22. The decoder scoreboard's
own miss list (33 journeys under `decoderscore`, `SCOREBOARD_JOURNEYS=1`) says
what they are:

| shape of the miss | count |
|---|---|
| a stay of 20 minutes or less touching a train (the platform wait, or the walk off it) | 14 |
| an edge walk added or dropped otherwise | ~10 |
| a dark ride not decoded at all (walking only) | 5 |
| a bus decoded as cycling or driving | 3 |
| a phantom ride (a walk decoded as a train) | ~4 |

Eleven of the fourteen platform stays have no place: the decoder holds a
placeless `stationary` between the walk and the ride, and a stay ends a journey.
The ride's own timing is usually right (06-18: decoded 08:39–08:57, narrated
08:39–08:57); the journey breaks on the label of the wait.

Station emission is the scoreboard's weakest count apart from journeys: 45 of
90 asserted stations right.

## Why the wait and the station are one problem

#366 built the wait: a `train|head` state, a platform minute before any ride.
Measured twice and refuted twice (2026-09-30, and on the repaired input
2026-09-29 evening): it found the crawl it was built for and cost three
journeys, seven lines and six to nine stations, because the head could become
any line at one price, and the cheapest line won. Its own verdict: the line
must be decided where the head is, by the platform's lines.

A wait AT A STATION decides that. Which station the person stands at is the
board station; which lines call there bounds the ride that follows; the same
state at the other end is the alight station. So the platform wait, the line
choice and the station emission are one state, not three fixes.

## The state

A `platform σ` state per candidate station σ, beside today's states.

- **Candidates.** Stations (OSM station nodes, by name) within the footprint of
  a fix that is slow enough to stand at. Measured, all stations within 300 m of
  any fix: 19 on a mean day, 56 on 09-30 and 10-01, 85 on 10-08 (a TGV day,
  passing through). Stations the day only ran past at line speed are not
  candidates: the travel days are where the serving memory limit was hit
  (#1949), and the state count is the trellis's width.
- **Emission.** A stay at a known position: the place-distance term with the
  station's position and its footprint as the noise, and the stationary speed
  and cadence emissions. No new term.
- **Transitions, structurally.** `walking → platform σ`, `platform σ → train L`
  only for a line L that calls at σ (`ServedStations`, the route relations),
  `train L → platform σ'` likewise, `platform σ' → walking`. A ride may still
  start or end without a platform state: a zero-minute wait is real, and then
  the ride's station is not decided by the decode (the honest "don't know").
- **The journey reader.** A platform state is part of the journey, as the
  narratives have it (the wait is inside the walk or the ride by his
  convention); `decoderJourneys` and the served grouping read it so.

## What it scores, and the form of each

The 2026-10-10 slice (roadmap step 2, measured and reverted) fixed the rule:
a FEASIBILITY question takes a survival probability ("could the day have got
there"), a CHOICE among alternatives takes a density ("how likely is it
there"). The platform state's emission is the density of a stay at a known
position: nearer is likelier. The walk into it and out of it are feasibility,
and are the gap and place terms already shipped.

The ride between `platform σ` and `platform σ'` has a duration the pair implies
(along-line path, calls between; the fitted `RIDE_RUN_KMH` model). That is a
second-order dependency (two states apart), which a segmental HSMM does not
see. Phase S2 handles it.

## S1 inside the journey state (designed 2026-10-19, after S2's first slice)

The journey state (`2026-10-shared-levels.md`) carries legs as base states of
the outer model, and S2's first slice adds a leg per line and board station
within reach of the fixes, sharing the line's tables and beginning only within
reach (`Journey.Tables.reachStarts`). A platform wait is the same shape: a leg
per station within reach, on a base `wait` state — stationary emissions, no
place — that the outer trellis never holds, its duration from a fitted wait
prior (narrated waits: 07-01's 4 minutes at Euston Square, 09-06's 5 at
Stanmore, Arnhem's 9 between trains), beginning only within reach of σ.
What S2's slice lacks it supplies: a `wait σ` leg may be followed only by a
`train L from σ` with the SAME σ, and a `train L from σ` by a `wait σ'` only
where σ' is the ride's alight — so the change at a shared station is a wait
leg between two rides, and the board station of the ride after it is the
wait's. Leg pairs therefore need a per-pair rule beside the base matrix (an
`L × L` table of allowed pairs; the sweep's hoist already skips legs that
cannot begin at a minute). The decoded wait writes back as a stationary
segment at the station, which the narratives hold as a row ("stationary, at
Stanmore, waiting for the tube") and which `foldRideWaits` must then leave
alone under the journey state. Candidates: the stations within reach of the
day's fixes, as S2's. Cost: the wait legs are as many as S2's; the pair
table is the new part.

### S1 inside the journey state, first slice (2026-10-19 evening)

Built as above: a `wait` base state (stationary, `lineName` the marker,
never in the outer trellis), a leg per station within reach of the day's
fixes, the pair rule (`Journey.Tables.pairOk`: a wait at σ continues only
into a ride boarding at σ), the fold leaving a decoded wait alone
(`foldRideWaits`), the marker dropped after it; the wait's duration from
`durationFits.wait` (the arm's records carry Gamma(4, 0.8): the narrated waits'
4, 5, 5 and 9 minutes by moments — the fitter's number next). Measured under
the journey record against the S2 slice (125/313/61/66/6, rows 26/20):
**125/311/60/62/4, rows 31 lost, 17 gained.** Both narrated waits are found —
07-01's four minutes at Euston Square (11:32–11:36, the row healed) and
09-06's five at Stanmore (19:21–19:26 against the narrated 19:18–19:23, the
row's midpoint still in the walk before). Seven rows go to waits the
narratives do not have (06-15, 06-22 ×2, 06-28, 07-14 ×2, 07-16): a wait of
two or three minutes before a ride, which the convention folds into the
walk, and which a Gamma with mean 5 and the two-minute floor prices as
cheaply as the walk's minutes. And 07-01's ride comes out Victoria from
Euston, the S2 tie again, now with the wait at Euston rather than at Euston
Square. Kept behind the record's wait fit; off without it. Next: the wait's
duration fitted on the narrated waits (four of them: the fitter must say so),
and a wait's existence price — the narratives' rule that a wait under three
minutes is the walk's.

### The fitter's wait, and the pair rule (2026-10-19, late)

The fitter finds the narrated waits itself (a stationary row with no place
between two moving rows, `fit_emissions`'s `waits`) and fits their duration
when there are three or more: nine of them, mean 9.3 minutes, sd 4.9,
Gamma(3.56, 0.38) by moments. Under it: **126/313/61/65/6, rows 29 lost, 17
gained** (the arm's Gamma(4, 0.8): 125/311/60/62/4, 31/17). The mean-9 Gamma
prices a three-minute wait within a nat of a nine-minute one, so the
over-produced short waits stay, and the rows they cost show two things:

- the pair rule let a wait be followed by anything but a stationless ride,
  and let a wait end a journey — so a stepless pause inside a walk decodes
  as `walk, wait` (09-15 15:40–15:43Z, 07-16 08:20–08:22Z, 07-01 11:32–11:36Z
  before a two-minute Victoria ride, 07-14 08:23–08:26Z eating the Met hop's
  first three minutes);
- the served cascade folds a placeless stationary beside a stay into the
  stay, with the walk between them: 07-14's UCLH runs to 08:26Z and 09-15's
  Work to 15:43Z in `states`, where `segsEnriched` has the walk. A wait the
  decoder puts inside a walk costs the whole walk row, not three minutes.

The rule as the design states it: a wait at σ is followed by a ride boarding
at σ and by nothing else, and never ends a journey (`pairOk`, `last`):
**126/313/61/65/6, rows 28 lost, 18 gained** — 09-15's and 07-16's walks
whole again; against the S2 slice the wait still costs 07-14's hop (the
wait takes its first three minutes, the two left ride Victoria), 07-15
(a six-minute fixless `driving` after the stay, where the slice kept the
stay), 05-22's taxi (cut at 19:41Z, a walk after it) and 07-01's walk to
Euston Square, where the wait is the narrated one (11:32–11:36Z, its row
healed) and the cascade folds it and the walk before it into UCLH.

Three corrections to that reading, the same evening:

- **The records moved.** The wait arm's records are a fresh fitter run on the
  day's corpus (every fitted number shifted a little: `durationFits`,
  `speedStop`, `modePriors`, `disp`), so the S2 slice is not its control.
  The control is the same records with the wait fit removed, which switches
  the wait leg off: **125/313/61/66/7, rows 27 lost, 19 gained.** Against it
  the wait leg is +1 journey, −1 station, −1 phantom, and on the rows: 07-01's
  wait row healed, 07-01's walk before it lost to the cascade (above), 07-14's
  two rows lost. 07-15's `driving` and 05-22's cut taxi are the records, not
  the wait.
- **King's Cross is not on the Met, to the leg list.** The journey debugger
  prices 07-14's one-ride alternative (`train|Metropolitan Line@Euston Square`
  08:23–08:28Z) with no expected ride time: the alight is the nearest station
  on the line within 400 m of the fix after the ride, and `nodeOnLine` asks
  whether one of the station NODE's own edges carries the line — King's
  Cross's six nodes sit on Victoria, Piccadilly and untagged edges, while the
  Met's track runs through its 200 m footprint, which is what the along-line
  search seeds. `stationOnLine` (an edge carrying the line with an end inside
  the footprint, `nodeOnLine` or) replaces it for the leg list and the
  alights. With it the pair expects 2.76 minutes (the Victoria's Euston → KX
  2.42–2.69), and the decoded shape becomes `wait@Euston 08:23–08:26,
  Victoria@Euston 08:26–08:28`; the narrated shape (the walk to 08:26, a
  two-minute ride) prices 3.5 nats worse on either line: three stepless
  minutes cost the walk 5.7 nats each in emission and 9 in its cell, the wait
  pays 10.6 in its cell and 2.3 to exist.
- **The fitter's wait population is not the term's.** Its rule (a stationary
  row with no place between two moving rows) finds nine rows, of which three
  precede a ride — 07-01's 4 minutes and 09-06's 5 at a station, 09-06's 14
  before a bus; the six others are pauses between two walks (06-16 7, 09-06 5,
  10-02 7 and 18, 10-07 16, 10-08 8 minutes), the placeless stay's rows, not
  the platform's. The platform wait's duration is to be fitted on the rows
  before a ride, and its floor is the shortest of them (4 minutes), carried as
  the fit's third number: the narrator folds a shorter pause into the walk,
  and a Gamma by moments from three rows cannot say so by itself (at 3 and at
  5 minutes it prices within a tenth of a nat).

### The footprint test, measured (2026-10-19, late): the waits are real

`stationOnLine` for the leg list and the alights, the wait arm's records:
**122/314/62/65/8, rows 31 lost, 17 gained** (the wait arm 126/313/61/65/6,
28/18). The Baker Street splits heal — 06-29 08:25Z, 07-06 10:24Z, 07-07
15:48Z and 16:17Z are one ride again, as narrated — and 07-14's hop now
decodes `wait@Euston 08:23–08:26, Victoria@Euston 08:26–08:28` (the Met's
Euston Square ties it at 2.76 against 2.42 expected minutes). What it costs
is seven rows and four journeys, all one shape: a wait of five to eight
minutes at the end of the walk to the station, on days whose narratives
have none —

| day | decoded wait (UTC) | the signal in it | narrated |
|---|---|---|---|
| 09-15 | 08:18–08:26 | 0–6 steps a minute, HR 71–77, fixes at 0–6 km/h, then 60 km/h at 08:27 | walk 08:05–08:15, ride from 08:16 |
| 06-17 | 16:10–16:18 | 0–16 steps, HR 89–94 | walk 15:57–16:18 |
| 06-18 | 07:31–07:38 | 0 steps, HR 103 → 96 | walk 07:18–07:38 |
| 09-06 | 12:19–12:24 | 0–8 steps (one minute 25), HR 83–93 | walk 12:06–12:21, ride from 12:22 |
| 06-15 | 13:35–13:39 | 0 steps, HR 89–98 | walk 13:22–13:32, ride from 13:32 |

He stood on the platform; the narrator (me) wrote the walk up to the train,
or the ride from the station's door. These windows are measured ones, mine
to correct from the signal — the decoder is not the evidence, the steps and
the heart rate are. The journey referee is what turns the wait into a loss:
`JOURNEY_PAUSE_MAX_S` is five minutes on both sides (`Journeys.lean` rule 3,
`DecoderScore.decoderJourneys`), so a decoded wait of five or more splits the
decoder's journey where the narrative, without a wait row, has one — the
rule's own comment says a platform wait does not split a journey, and the
five minutes were the TypeScript's guess; the narrated waits are 4, 5 and 14
minutes, the decoded ones 5 to 8.

Three ways out, to decide before the corpus moves:

- **A, the referee.** A placeless stay before a ride is a pause whatever its
  length (the narrated wait's shape: a stationary row with no place, after a
  walk, before a train or bus); any other stay of five minutes or more ends
  the journey as now. The truth side changes only where such rows exist
  (09-06's fourteen minutes before the bus); the decoder side stops losing a
  journey to a wait it found. The served day names a decoded wait after its
  station (`boardingStayLabel`), so the decoder side must read a
  station-named stay as placeless for this rule — the referee has no station
  list; the fold's `wait` marker, kept on the segment, would say it.
- **B, the narratives.** Wait rows from the signal on the five days; the
  referee unchanged. Both sides then split at every wait of five minutes or
  more, and "the walk to the station" becomes a journey of its own — the
  letter of rule 3 against its intent.
- **C, the fold.** `foldRideWaits` folds a decoded wait into the ride again,
  as before S1; the wait row (07-01, 09-06) is lost and the decoder's own
  finding is thrown away at the fold.

A, by his standing direction (2026-10-20: "it can be as long as it is; five
minutes hardcoded is one of those rigid numbers"), which the asking should
not have needed — priors and physics as likelihood terms, never thresholds,
is the project's design principle (`2026-07-continuity-c4.md`).

### The decoded wait carries its station (the fold's first yield, #1947)

How the head loses a walk row to a wait it found (07-01, 07-14, 09-15): the
wait leaves the decoder as a placeless `stationary`; under the head the
stays take the enrichment stage's naming (`nameStays`), which names a
placeless stay beside UCLH as UCLH; `finalMerge`'s intra-place absorption
then sees two stays at one place with a short walk between and demotes the
walk — the served stay runs to the ride. The fix is identity, not a pass
gate: the wait's leg knows its station (`legStation` beside `legName` in the
journey tables), the expansion keeps the leg per minute (`expandLegs`), the
wait segment leaves the assembler with `boardStation` set, the decoder-segment
bridge (`decoderSegs`) makes it a stay AT that station, and the head's stay
namer leaves a stay that already has a place alone. A stay named after its
station is what the served day already draws for a chain-found wait, and
`absorbIntraPlaceWalk` cannot fold UCLH into Euston Square. Measured on the
flip rows against the baseline re-made after the day's sweep (`s61base`).

Measured (the journey record `fit_wf_j`, the referee without its pause): the
base decoder 21 lost / 17 gained; the journey record on the tree before the
slice 28/22 — its gains hold four of the five new wait rows (06-15, 06-17,
06-18, 09-15) and 06-12's forecourt journey; with the slice **29/22**. The
one row it moves is 07-07 08:54Z: the decoder reads the eight stepless
minutes at UCLH as a wait at Warren Street before a one-minute hop it places
six minutes early, and the fold's venue name used to cover that; served as a
stay at Warren Street the row fails, which is the truth of the decode. Where
a wait is decoded the fold now serves it at its station (09-15: Wembley Park
08:18–08:26Z, King's Cross 15:46–15:50Z; Work ends at 15:35Z, not 15:43). On
07-01 and 07-14 no wait is decoded under this record (the four-minute one
sits on the floor, the three-minute one is impossible), so the absorption
has nothing to absorb there today. Phantoms under the journey record are 11
against the base's 5: one-minute rides inside walks (09-15 15:41Z, 07-07
09:01Z), S2's remaining cost.

The one-minute rides, priced (journey debugger, 09-15 15:41Z): a
`Metropolitan Line@King's Cross` leg of one minute with an expected ride
time of 0.8 minutes — the alight is the station nearest the next fix on the
line, King's Cross has six nodes, and a node of the board station itself
passed the "not the board station" test by id, so a ride to itself expected
only the stop overhead and a minute of train paid 0.36 nats of emission
against the walk's 6. The alight is now another STATION by name; the leg
then has no pair time and the two-minute duration floor makes a one-minute
ride impossible. **Phantoms 11 → 7, rows 27/22** (09-15's walk, 07-07's
UCLH stay and 09-06's Stanmore ride return; 06-12's forecourt journey gain
is lost). Against the base's 21/17 the journey record now stands at −5 net
with lines 62 against 63 and stations 67 against 68: S2's alight naming on
06-16 and 07-02 (the decoded alight one station short) is the next class.

### The alight one station short, priced (2026-10-20, evening)

Two mechanisms, neither the pair term:

- **06-16 (Met Wembley Park → Baker Street, decoded Jubilee to St John's
  Wood).** The per-minute line terms are the same for both lines every minute
  of the corridor; the narrated Met leg to 11:06Z loses 73 nats on one minute,
  11:05Z, where the watch counted 116 steps inside a train doing 37 km/h —
  the train cadence term at −69. The decoder ends the ride at 11:05 to dodge
  that minute, and the Jubilee is the line with a station (St John's Wood)
  111 m from the fix it ends at. The train-cadence class, refuted twice
  (`2026-10-segment-emissions.md`); the alight is downstream of it.
- **07-02 (Met Finchley Road → Baker Street, decoded as one ride and a walk).**
  The fixes sit at Finchley Road with accuracies of 20–200 m until 08:15:20Z
  and then jump to Baker Street at 187 km/h at 08:16:47Z: the phone repeating
  its last position underground. A leg ending at 08:15 alights where it
  boarded, so the pair has no ride time. The alight is now the station by the
  first fix beyond the board station's reach within the stale window ("where
  the fixes resume away from where he got on"), the same minute as before
  when that minute's fix is already away. Measured: neutral to the row —
  127/314/62/67/6, rows 27/22 unchanged; the one ride without a station still
  prices under the split (its 18 minutes on the base duration, −67, against
  the Jubilee pair's −60 and the Met pair after it). Kept as the right
  reading of a stale track.

### The margin on one set of records (2026-10-20, 19:00)

Both arms on the fresh fitter records (`fit_wf`), the referee without its
pause, today's narratives:

| arm | scoreboard | flip rows |
|---|---|---|
| base decoder | 127/311/63/69/5 | 21 lost / 17 gained |
| journey state (S2 legs, S1 wait, footprint stations, wait at its station, alight by station and by the first fix away) | 127/314/62/67/6 | 27 / 22 |

Journey against base, same records: +7 gained (05-18's hop, the four platform
waits 06-15, 06-17, 06-18, 09-15, 07-02's walk, 10-08's walk), −2 gains
(05-22 19:38Z, 06-23 07:42Z), +6 lost (05-22's Finchley Road wait, 06-16's
cadence minute, 07-02's fused ride, 07-06 10:33Z, 10-08 14:59Z twice): one
row behind, three leg modes ahead, a line and two stations behind, a phantom
more. Against the served day neither arm is net better (−4 and −5), so no
flip. The base decoder's four new journey losses under the referee: 10-08
07:18Z (the Hendaye stay swallows the walk to the platform — the head has
no walk at all), 10-08 12:43Z (the walk to Parcelle ends three minutes
early), 10-07 10:39Z (a two-minute placed stop the decoder draws inside the
narrated walk, which the day walks away from), 07-16 07:13Z (below).

The two 10-08 keys and 07-16's are three findings, not one:

- **Hendaye is the fold.** The base decoder's own segments match the
  narrative row for row (the station stay, the walk to the platform
  07:13–07:21Z, the platform stay, the TGV); the head's tail runs
  `finalMerge`, whose intra-place absorption sees two stays named after the
  station with an eight-minute walk between and demotes the walk. Under the
  head the decoder's boundaries stand and the tail names; it does not
  re-draw. `finalMerge` leaves `DECODER_TAIL` (measured below).
- **The café and the hospital are the narratives.** Of the fifteen placed
  stays the corpus writes directly before a ride, fourteen are stations —
  waits and changes, as the rule reads them. The two that are visits had their
  walk to the train folded into the stay: 10-08's Parcelle (steps in bursts
  from 15:17 London time, the Métro at 15:26) and 07-16's UCLH (75–114 steps
  a minute 09:05–09:11, none 09:12–09:15, walking beside King's Cross from
  09:16 — a visit to 09:14 cannot reach King's Cross by 09:16). Both rows now
  end where the steps begin and carry the walk, his words on 07-16 kept
  verbatim beside the signal that re-times them; the two tail rows the head
  "lost" there were walking all along.
- **10-07 is the decoder's:** a two-minute placed stop inside a walk (2 and 6
  steps at 11:06–11:07Z on the beach), which the narrator folds into the walk
  and the rule reads as a stay the day walks away from. A pause's own
  duration, fitted on the narrated stops between walks (5, 7, 7, 8, 16, 18
  minutes), is the term it lacks.

Measured, the base decoder's head on the fresh records: without `finalMerge`
in the tail and with the two narratives re-windowed, **19 lost / 20 gained**
(07-16's and 10-08's keys back, one label row lost on 07-07 whose walk out
of Work now starts five minutes earlier and names other roads); Hendaye still
folded — by `boardingStayLabels`, which names both stays after the station
and folds the walk between two waits at one station into the wait. The fold
is off under the head (`foldInside`): **18 lost / 21 gained, scoreboard
129/313/63/69/5** — the first net-positive reading of the base decoder
against the served day under the numberless referee. The served day keeps
both folds; under the head the tail names and does not re-draw.

Floors moved by the two re-windowed narratives: the frozen scoreboard (07-16
and 10-08 each gain a journey and a leg), the truth floor (07-16's 08:05Z key
now carries the walk the served day cannot hold — cut by hand, the narrative
changed under it; the ride rows re-keyed by the gate's bless), the
name-confidence ledger (07-16's three "enclosing" rows became one: `COUNTS`
enclosing 28/29 → 26/27, its witness 29/31 → 27/29), and through that one
served number, `placeConfidence` 0.9355 → 0.9310 on every stay named by an
enclosing building, the day gate's blessed timelines (`DAY_BLESS`).

**The journey state on the new tail** (same records, same narratives):
**129/316/62/67/6, rows 22 lost / 27 gained** — net +5 against the served
day, the base head +3. Journey against base head: +6 gained (05-18's hop,
the four platform waits, 07-02's walk, 10-08's walk, 07-16's re-timed walk),
−2 gains (05-22 19:38Z, 06-23 07:42Z), +4 lost (05-22's Finchley Road wait,
06-16's cadence minute, 07-02's fused ride, 07-06's hop walked through) and
07-16 08:12Z in place of 08:10Z; three leg modes ahead, a line and two
stations behind, a phantom more. The losses that are a whole leg kind on
their day: 07-06's one-stop hop (both arms) and 06-09's bus (every arm, no
bus state). The flip is his call by his own rule (several rows, no day losing
a whole leg kind): the margin is there, the two leg kinds are named.

### The journey rule without a number (2026-10-20)

On the narrative side, the decoder side and the drawn-timeline shape referee
alike (`Journeys`, `DecoderScore`, `JourneyShape`): **a stay — or unaudited
time — the day boards a ride from is the wait for it, a pause however long
and whatever it is called; a stay the day walks or drives away from bounds
the journey; a sleep bounds it; unaudited time straight after a ride is the
platform it alights onto.** The only number left is the rows' own minute,
inside which a gap is rounding. No place name is read.

Two rules tried and refuted the same day, both measured on the frozen
scoreboard and the served-day floors:

- *A placed stay bounds, a placeless one pauses.* The narrator names every
  visit; the decoder does not (a venue not in the places table is a placeless
  stay), so the decoder's journeys merged across unnamed visits where the
  narrator's split: 04-29, 06-15 and 10-08 lost every match. And 05-18's one
  minute "@ Baker Street" between two trains is a change, not a visit.
- *A stay is a pause if a ride follows before the next stay* (for 06-12,
  where he waited on Victoria's forecourt, walked down to the platform and
  boarded). A visit, the walk to the station and the train is how most trips
  begin, so this read every such visit as a wait and merged trips across the
  corpus (05-15 3 → 1, 06-22 3 → 1 journeys expected). Without geometry the
  referee cannot tell a forecourt from Home; 06-12's journey is the rule's
  blind spot, one key.

Under the rule the frozen scoreboard reads 141 journeys expected (was 152:
waits before rides join their trips on 06-29, 07-01, 07-16, 09-06, 10-01,
10-08 and the TGV day), 127 matched (was 125), legs, lines, stations and
phantoms unchanged. The served-day journey floor loses two keys to the
definition: 06-12 14:16Z (the forecourt wait above) and 10-03 11:30Z, where
the served day draws a four-minute stop inside a walk the signal shows as a
slowing (16–17 steps a minute for two minutes), which the five-minute
tolerance used to absorb; both are the decoder's to win. The five narratives
carry their platform waits from the signal, each ride row re-windowed to its
first fast minute (06-15's boarding by the ride's length, unseen
underground).

With the fitter's population corrected (three waits before a ride: 4, 5, 14
minutes; Gamma(2.91, 0.38) by moments, floor 4) and the floor in the decoder:
**121/314/62/66/9, rows 29 lost, 18 gained.** 07-14's three-minute wait is
impossible and its two rows hold again (the narrated shape); 09-06's 12:06Z
journey holds; 07-01's four-minute wait at the floor is lost to the walk and
its walk row returns. The four journeys above stay lost under the referee's
rule. The arms, all on the fresh records: wait off 125/313/61/66/7 (27/19);
wait 126/313/61/65/6 (28/18); footprint test 122/314/62/65/8 (31/17);
footprint test with the fitted floor 121/314/62/66/9 (29/18).

## Phases, each measured on the scoreboard, the journey referee above and the corpus floors

- **S1: platform states, transitions, journey reader.** Gate: journeys up (the
  fourteen), lines not down (the #366 failure), no phantom rise, the travel-day
  memory smoke under the limit. Station emission from the platform state's σ
  where one is decoded; the chain keeps the rest.
- **S2: the ride's duration against its pair.** Either the train state carries
  its board station (`train L from σ`: lines × calling stations near the day,
  ~10 per line) so the alight transition can score the path, or the segment
  evidence maximises over the alight inside the segment. Choose by cost, both
  measured; the route-aware decoder (a discrete position at every minute) is
  the precedent against anything wider.
- **S3: confidence as a posterior.** Forward–backward over the same trellis
  gives each segment's posterior; a station or line is emitted when its
  posterior clears a level read off a reliability curve on the narrated days,
  not when it beats the runner-up by `MARGIN_NATS`. The station chain's gates
  (`MARGIN_NATS`, `ABS_ANCHOR_FLOOR`) and its anchor and transfer terms then
  go together, which is the only way the 2026-10-10 slice says they can.

## What retires

- After S1: the cascade's wait and boarding passes the decode now owns
  (`boardAtWait`, `boardingStayLabel`, `interchangeStayLabel`), each deleted
  only when the served day with it gone holds every floor.
- After S3: the post-decode station chain's anchor, transfer and margin
  machinery (the constants under `StationChain.lean`'s "Scoring terms").
- Not by this: the dark rides decoded as walking (5) and buses (3) are other
  work (the gap term reached the first; the second needs a bus state).

## Risks, named

- **Phantoms.** A stay-priced state any stationary stretch near a station can
  enter. #366's head doubled the phantom exposure for exactly this reason. The
  platform state is anchored to a station's position and leaves only into a
  line that calls there; S1's gate watches phantoms.
- **Width.** The candidates bound it; the travel-day smoke is in the gate.
- **The verified envelope.** New states change no tensor magnitude bound; the
  emission of a platform state is a stay's.
