---
created: 2026-10-18
status: design; stage 1 measured; the recommendation moved to interruptions inside a segment (B, exact)
references:
  - decoder-roadmap.md
  - 2026-10-station-states.md
  - 2026-10-segment-emissions.md
  - ../design/probabilistic-principles.md
---

# Levels shared across segments: the walk that resumes, the stay that potters

The two classes that keep the flip net worse (36 narrated rows lost, 16
gained, 3 impossible legs, 2026-10-18) have one root. Every decoded segment
draws its own heart-rate level, its own fix share and its own duration, and
the decoder sees one segment back. So a short interruption costs as much as
two new segments, whatever the evidence for it.

## Decisions this is built to (his, 2026-10-18)

- Walking around inside a building is part of the stay and is not shown.
- The decoder replaces the served day once it gets more of his days right,
  even if it gets some things wrong that the served day gets right.
- Rewriting the decoder's core is worth it for a better solution.

## The two classes, in numbers

**A short ride inside a walk** (05-18, 06-16, 07-02 at Baker Street; 07-07,
and 11 history days, Euston Square ↔ King's Cross). 07-02's two-minute hop
against the decoded walk, by term (`path_debug` `segParts`): the hop's fix
pairs +19.2, its minute emissions +6.0, the entry credit +3.0; against them the
pair across each new boundary −15.5, the short segments' displacement −8.6,
duration priors −6.6, the two extra segments' heart-rate and fix-share levels
−5.6, transitions −3.7. Net −12: about +25 of evidence against −37 of
structure. The boundary span fitted by mode pair recovers about 4.6 and a
ride's duration from its pair at most 3.4 (both measured, the first built
and neutral). The rest is the walk on each side being scored as two
unrelated walks.

**Moving about inside a place** (09-15 16:35–16:39 at the office, 07-07 King's
Cross, 07-16 UCH, 09-14 Home). 48–106 steps a minute with the fixes within
70 m. The hand-set stay cadence (99% step-free, 10 ± 20) charges such a minute
about 20 nats more as a stay than as a walk, so the walk takes it. Every looser
stay cadence (five forms, 2026-10-17/18) then lets the stay absorb short real
walks — to a car, to a bus, between buildings — because a two-minute walk's
own segment costs about as much as the stepped minutes it would explain.
Displacement per step separates them on long windows (walks 0.79 m a step,
stepped stays 0.30) but a two-minute walk has too few steps to defend itself
(measured, `arm-walkperstep-2026-10-18.patch`).

The same arithmetic both times: an interruption's evidence is a few nats a
minute, and the structure charges it as if it started a new episode.

## What "shared" means

A journey is one episode: home to the hospital is one trip with legs. A stay
is one episode: the morning at the office, however many rooms. What a person
carries through an episode — their heart-rate level, whether the phone is in
a pocket with fixes or a bag without — belongs to the episode, and the legs or
rooms inside it are drawn around it. Under that model a two-minute ride
inside a walk pays for the ride's own minutes, not for a new walk after it,
and minutes of stepping inside a stay are the stay's minutes with steps, not
a walk's.

## Three structures, costed

The decoder today: a segmental HSMM, S states (about 25–40 a day), segments
up to `maxD` = 1440 minutes, decoded exactly by the verified trellis in
O(T · S · maxD) with the segment terms precomputed per (class, length, end).

**A. Two levels: episodes outside, modes inside.** The outer segmentation is
episodes — a stay at a place, or a journey — and a journey's inside is a
sequence of legs (walk, ride, wait). The episode carries the shared levels;
a leg's terms are conditional on them. Exact decoding is a nested search: the
best journey over a window is itself a segmentation of that window. Bounding a
journey's length (narrated journeys are under three hours; `maxJ` 180) keeps
it O(T · maxJ · (inner decode of maxJ minutes)): roughly maxJ times today's
cost for the journey part. That's too slow as is. Tractable with the inner decode
shared across windows ending at the same minute (a forward pass over legs that
restarts at each journey start), which brings it to O(T · maxJ · L) for L leg
states (≈ 15). A stay episode gets an inside too — still, and moving
within the place — with the place and the levels shared: sharing the levels
alone does not change what a stay charges for a stepped minute, so the indoor
class needs the second sub-state, its position held to the place. This is the
principled form and the largest rewrite: the trellis, its proofs and the
packed tables change.

**B. Within-segment refinement.** Decode as today; then inside each decoded
walk run a small minute-level model (walk, ride, stand) with the walk's own
levels, and inside each stay one with (stay, moving-within). A hop is carved
out when its minutes' evidence beats walking under the SHARED level and its
ends sit at stations its line calls at; moving within a stay folds in. Cost is
small, O(segment length · 3). It cannot fix a boundary the outer decode put in
the wrong place (the walk that already swallowed a stay's last minutes), and it
re-introduces a pass after the decoder, the shape the roadmap retires.

**C. Levels chained between adjacent segments.** Score each segment's
heart-rate level given the previous segment's (a Markov chain on levels). First
order, so cheap, but the walk after a hop is conditioned on the hop, not on the
walk before it: it buys nothing for the hop, and for the stay it only softens
the walk next to it. Ruled out by its own structure, not measured.

## Recommendation

A, built in stages each measured against the held-out baseline (125/309/63/68/4,
referee 143) and the flip check:

1. **Measure the prize first, offline.** For the narrated hops and indoor stays,
   score the narrated reading against the decoded one with the shared levels
   (path_debug's parts give every term; the heart-rate and fix-share levels are
   re-scored with the episode's statistics pooled). If the narrated reading
   does not win under sharing, A is not the fix and nothing is built.
2. **The journey state over today's trellis.** A journey is a state whose
   segment score is the inner forward pass over legs; stays and the rest
   unchanged. Behind the record, like every arm.
3. **Move the stations into the journey's legs.** The chain's board and alight
   become the inner model's leg boundaries, so a change is a transition inside
   a journey at a station both lines serve: S2 of `2026-10-station-states.md`,
   now with a place to live.

## Stage 1, measured (2026-10-18)

`path_debug` reports, for every state that resumes after a segment of ten
minutes or less, its heart-rate/fix-share term and duration prior scored once
over both parts against once per part (`decodedShares` / `altShares`). On the
narrated hops, the narrated reading's deficit against what sharing gives back:

| day | narrated reading behind by | the walk resuming | the two rides of the journey |
|---|---|---|---|
| 05-18 | 5.8 | +13.0 | +6.5 |
| 07-02 | 12.0 | +5.2 | +6.9 |

05-18's narrated reading wins on the shared walk alone; 07-02 ties with the walk
and the rides shared and wins with the boundary span by mode pair
(`arm-boundaryclass-2026-10-18.patch`, +4.6). The prize is there. So is the
risk: the same pooling makes any resumed state cheaper.

## Stage 1, read again: what each structure can collect (2026-10-18)

Stage 1 pooled the resumed state's duration as well as its levels. A journey
of legs (A) does not do that: the walk before a hop and the walk after it are
two legs with two durations. Its share of the measured gain is the levels
alone — about +4 on 05-18 (5.8 needed) and +5 on 07-02 (12 needed); most of
05-18's +13 is the change walk escaping the two-minute duration floor. A
interruption INSIDE a segment collects all of it: the walk keeps one duration
and one level, and the ride inside it pays only its own minutes and a fitted
interruption rate.

So the recommendation moves to B, made exact rather than a pass after the
decoder: **a segment may contain interruptions.** A walk's minutes are walking
or a short ride; a stay's are still or moving within the place. The segment's
score over `[s, e]` is a two-state pass over its own minutes — the segment's
mode against the interruption, a fitted switching rate between them, the
segment's heart-rate and fix-share level shared by both — and it is
computed for every start in one sweep forward, O(T · maxD) per class, the same
order as the segment tables today. Nothing in the trellis changes: only what a
segment's cell holds. The output carves an interruption out as its own leg
where it is a ride (a hop, with its stations from the chain) and folds it in
where it is moving within a stay (his rule: walking inside a building is the
stay). A's journey state stays the place for the stations' structure later
(S2).

Stages, each against the held-out baseline (125/309/63/68/4, referee 143) and
the flip check (36 lost, 16 gained): (1) the stay's interruption (moving
within: walking-pace minutes held to the place) — the larger class of the
flip's losses; (2) the walk's interruption (a ride between stations its line
connects); (3) the fitted rates from the narrated rows (indoor movement inside
stays, hops inside walks).

## Risks

- **Width and memory.** The inner pass multiplies the journey part of the
  trellis by the leg count; the travel-day memory smoke is in every stage's gate.
- **The verified envelope.** The trellis's proofs are about one segmentation
  level; the journey state's inner pass is a new, unproved computation feeding
  a cell, like the segment emissions are today.
- **Phantoms.** A cheaper interruption makes phantom hops cheaper too; 06-16's
  St John's Wood "hop" inside a moving Met train appeared under the boundary
  arm. Stage 3's station rule is what stops it, so stage 2 alone may not ship.

## The stay's inside, measured (2026-10-18; on the flip rows 2026-10-19)

Built as `stayMove` (`fits/arm-staymove-2026-10-18.patch`): a stay's minutes
still or moving within the place, a two-state pass per segment; fitted, 3.3% of
still minutes start a spell and 36% of moving minutes continue one; a moving
minute's steps are scored as a walk's; place, position and levels stay the
stay's. Held out 125/307/63/69/4, referee 137 against 125/309/63/68/4, 143:
gains 05-22's drive and 06-12's phantom train, loses the walks out of a stay
(05-20's four minutes to the taxi, 09-30's to St Pancras). With the moving
minute's fix held to the segment's running centre (2-D Gaussian, 35 m, from
the narrated stepped stay minutes: median 19 m out, q90 74): unchanged. The
lost walks are 30 m out of the door, which position cannot tell from 30 m
inside (`arm-staymove-footprint-2026-10-18.patch`).

On the flip rows, each arm's own decodes heading the fold (`FOLD_DECODER_HEAD`
on the scoreboard's dump; the baseline's decodes are the control, not the
stored record): baseline lost 35, gained 16; stay-move lost 45, gained 15.
It heals two of its target class (07-06's Work stay, 07-16's hop) and loses
eleven: every short walk that ends near where it began is a stay's spell —
05-20's four minutes to the taxi, 10-08's three on to Paul, 06-24's 49 m from
Currys to Lidl (the two shops become one stay), 10-07's eighteen up and down
the beach, 04-29's walk in Den Haag — and 09-30's walk to the platform, a gain,
goes back. The footprint form: 42 lost, 15 gained. The other arms of the same
day on the same instrument: walk displacement per step 39/17, the stays-only
lognormal cadence 55/15, both 56/17 — each neutral or near it on the held-out
scoreboard, which grades legs and cannot see a boundary moving three minutes;
the narrated rows can.

Why the walk out is thin (05-20 22:12–22:16Z, `path_debug`, base): the four
stepped minutes favour the walk by 12 (−25.4 against −37.3 as the stay's);
the walk's own structure costs 5 (duration prior −2.8, its level and
displacement); net +6.9. A spell over the four minutes at the fitted rates
costs 6.5 and gives the 12 back: the stay wins by about 1.5. The margin is the
price of a spell, not the evidence.

What the narrated stays hold (45 days, the fixtures' steps, each narrative
read in its own zone; runs of minutes at 60 steps or more inside stay rows of
ten minutes or longer): run lengths 1: 177, 2: 37, 3: 10, 4: 3, none longer —
one geometric, 0.225 to continue (at 30 steps or more: 1: 485, 2: 146, 3: 49,
4: 16, 5: 10, 6–7: 5). A first reading of the same data the same morning
found runs of eight and more at hospitals and hotels; those were the days
abroad read in London time, and are withdrawn. A stepped run of four minutes
or more is not inside a narrated stay. A stay ends still before a vehicle in
8 of 9, before a walk in 92 of 126 (the minutes to the door are the stay's,
his rule).

Walks to a vehicle (narrated): median 10 min, quartiles 8–15, 1 of 64 at three
minutes or less; from a vehicle to a stay median 10; between two vehicles (a
change) median 5.5 (n 10); stay to stay 13.5. The walk out of a stay is not a
short leg, so a duration fitted per leg kind would not buy 05-20.

## The flip's largest class was a label, not a boundary (2026-10-19)

Every lost row printed beside the head's state at its midpoint and the signal
at its edges (`/tmp/sas/rowaudit.py`, kept with the instruments): 16 of the 34
are walks whose head window matches the served one to the minute — 09-14
08:44–08:51 identically — with another road in the label. The served label
comes from the enrichment stage's five-sample way pick over the SPLIT stage's
window (42 fixes from 08:42, through the station exit: "Euston Underpass");
the head's `nameMoves` ran the same pick over the decoder's 35 fixes from
08:44 ("Euston Road"). The "walks overrunning stays" reading of this class
(2026-10-18) was from one day and wrong; the stepped minutes it cited are
outside the building by the second minute (09-15 16:36: 39–58 m, 16:37:
74–100 m).

Done: a walk under the head is labelled by the roads it was on longest
(`Enrich.roadsByTime`: the nearest named highway at every fix, weighted by the
seconds to the next, composed by `composeWayName`, the matcher's rule), and
carries every road as `roads`; the truth check holds a "walking on X" row when
X is in the label or among the leg's roads (its own rule, "extra attribution
on the live side is not a contradiction", applied to all the attribution the
leg has). Flip rows, baseline decodes: 35 lost → 23, 15 gained both times
(the earlier "16" counted the gate's echo of an exemption that held again).
Of the 56 narrated walk rows whose midpoint is a headed walk, 39 have the road
in the label, 45 among the roads; those left name a road the decoder's fix set
never reaches (the underpass before the walk's first fix, 09-14 and 09-15; a
close the five-sample pick landed in, Hannah Close, Eversley Avenue) — the
served label's lottery, to re-audit from each row's own fixes.

The rest of the 34: stations on `unknown_rail` 4 (Eurostar, Métro 4 ×2,
06-18's board station); platform waits folded into a neighbour 2 (07-01 Euston
Square, 09-06 Stanmore); hops 2 (07-07, 07-16); movement inside a visit 3
(07-06 Work's two walks, 07-16 UCH's two buildings); a bus; 05-25's slow drive
start; 09-30's stop inside the Paris walk; 10-08's Paul by name; 09-15
15:43–15:50's window, which the signal contradicts (he left the office at
16:35 local, not 16:43); two rows on days abroad not yet mapped.

## The night's level (2026-10-19, from the day's own decode)

The decoder's reading of 2026-10-19 held a one-minute plane at 06:00, in
bed. The path debugger: one stay 00:00–13:37 pays −451 for its level terms,
two stays with their own levels −372, and a one-minute plane at the duration
hard floor (−10, with a −5 transition) is the cheapest separator the model
allows between two stays at the same place — the 06-11/06-20 "phantom train
Home → Home" class of the history sweep. The term that splits is the ASLEEP
level, one constant per night (`sleepScore`), where the night drifts. Done
the same afternoon: the AWAKE level is one per awake run a segment spans
(`Stats.runs`; a sleep resets it) — held out 125/310/63/68/4, rows unchanged,
and not this case. Narrated nights (24, the fixtures' heart rate): lag-1
autocorrelation about the night's mean 0.735 (the record's ρ 0.67),
within-night sd 5.1 bpm (σ 4.4), last quarter against first quarter median
+3.2 bpm, q10 −9.4, q90 +7. So the form, not the numbers: a sleep level that
drifts (a random walk, its step fitted on narrated nights), whose statistic
is the sum of squared lag-1 differences — prefix-summable like the rest.
Through the fitter, not a parameter change; the next model step on the
stays' side.

## The journey layer, designed and costed (2026-10-19)

**Shape.** The outer trellis holds the stays (one state per place, one
unnamed) and one journey state. A journey segment's cell is the best leg path
over its window — an inner decode over the leg states L (walking, cycling,
driving, plane, each line in the day's graph, `unknown_rail`: 16 on a London
day; S2's `train L from σ` later) — plus the journey's own terms, charged once:
the heart-rate and fix-presence level over the whole window (`scorePrepared`,
O(1) from the prefix sums), a journey duration prior (narrated journeys:
median 24.5 min, q90 56, 159 of 162 within 240), the first-leg and last-leg
priors (first leg a walk 139 of 162, a train 18 — the platform stay before it
—, a drive 2; last leg a walk 142). Stay ↔ journey replaces stay ↔ movement:
a stay's cross mass has one destination, and the place choice stays with
`stayEntry`. A leg keeps every term it has today except the level: per-minute
emissions, the pairs inside and the pair across its end, displacement, its
mode's duration prior; leg → leg is a fitted matrix (narrated pairs: train →
walk 81, walk → train 75, train → train 9, walk → drive 3).

**The inner pass is the existing specification on a sub-problem.** For a
start `s0`, the best leg path over `[s0, e]` is `Spec.bestEnd` of the problem
with `T' = maxJ`, `S' = L`, `init` the first-leg prior, `trans` the leg
matrix, `dur` the leg's duration and level-free segment terms. One forward
sweep from `s0` yields the value for every end before `s0 + maxJ`; the table
`IN[s0][e]` (T × maxJ) becomes the journey class's per-end delta (`durDelta`),
−∞ beyond `maxJ`. The packed trellis and its proofs are untouched: the journey
is a state whose duration cell holds a number, as a stay's holds its segment
emission. A decoded journey's legs come from re-running its window's sweep
with back-pointers, once per decoded journey. The sweep is unproved as code;
its specification is `bestEnd`, so the proof, when wanted, is the existing one
restated.

**Cost, against today's** (`verified_cli decodeprof`, 09-30: T 1440, S 123,
maxD 1440; build 17.7 s — durations 7.2, emissions and entry 9.8 —, decode
12.4 s over 2.55 × 10⁸ cells, 49 ns a cell). The sweeps cost T · L · maxJ²/2
cells: 3.7 × 10⁸ at maxJ 180 (about 18 s a day; 155 of 162 narrated journeys
fit), 6.6 × 10⁸ at 240 (32 s; 159 fit). A journey longer than `maxJ` decodes
as two, journey → journey at a fitted rate. The outer trellis is 17 states
narrower. Memory: the leg tables are leg class × maxJ × T (six classes,
1.6 × 10⁶ floats) and `IN` is T × maxJ; nothing of the outer's T × maxD × S
order is added, which is what the travel-day limit (#1949) watches.

**What it collects, by the numbers already measured.** The levels: +4 on
05-18 (5.8 needed), +5 on 07-02 (12 needed); one level instead of two for a
walk out and a drive (+2.8 against 05-20's 1.5 margin). The change: a walk
between two rides, or a 0-minute change, is a leg transition at its fitted
rate, not a movement → movement step from the uniform split. The home for S2:
a leg `train L from σ` whose alight transition scores the pair's path, which
the flat trellis cannot carry (`2026-10-station-states.md`). What it does not
collect: durations (the walk out is 10 min; a hop's length is its station
pair's), the displacement and boundary-pair pricing of short legs (the
boundary class, +4.6, is its own arm), and the stay's inside.

## The journey state, built and measured (2026-10-19)

Built as designed, behind the record (`segEmission.journey`: `maxJ` 240,
narrated first- and last-leg shares; the journey's heart-rate level as the
`unknown` mode's table, fitted on narrated journeys: mean 98.5, 9.9 between);
`Verified/Hsmm/Journey.lean` is the inner sweep, `ServeEntry` builds the leg
tables and the journey class's cell, `Journey.expand` writes the decoded
journey's legs back into the path. Eight runs, each held out (base
125/309/63/68/4, referee 143) and on the flip rows (base 17 lost, 18 gained):

1. Shared level, legs without any level term: 120/300/60/64/8, rows 38/17.
2. Legs keep their fix-presence term (a ride is dark, a walk lit — the leg's
   fact; `scorePreparedParts`), journey duration prior dropped (its legs'
   lengths are priced already): unchanged. The cause was elsewhere.
3. No shared level at all (control): 117/298/60/62/9, rows 41/17 — so not
   the level either. The path debugger, taught the journey's cell, priced a
   12-minute walk journey on 10-08 at −644: the legs' emission PREFIX SUMS
   carried −∞ from the first minute a leg cannot emit (a walk at the TGV's
   300 km/h) over every later minute of the day — every walk after the TGV
   on 10-08 and after the Eurostar on 09-30 vanished, 09-14 was untouched.
4. Floored (−10⁴ a minute), still no shared level: 122/309/60/62/5, rows
   23/18; 10-08 decodes as the baseline does. Lines and stations down: a leg
   inside a journey carried no entry prior (the train generator's vouching).
5. Shared level on: 125/310/60/64/4, rows 21/19 — heals 07-16's two-minute
   hop and 10-08's stop, loses 06-16's change and 10-08's walk to Paul.
6. Legs with their entry prior: lines 63, stations 66, legMode 312 — and 20
   phantoms: alternating one-minute Met/Victoria legs at King's Cross. A leg
   under a shared level pays no level, which in the flat model was a
   segment's existence price, and a covered train's floor is relaxed.
7. The first leg's fix-anchored boarding context: unchanged (covered minutes
   carry no boarding term in either model).
8. The covered floor withheld inside legs: **125/311/63/70/5, referee 142;
   rows 21 lost, 19 gained.** Against the baseline: legs +2, stations +2, one
   phantom more (06-16's Met "hop" inside the Jubilee change, the risk named
   above), referee −1; rows −3 net (07-16's hop and 10-08's stop healed;
   06-16's change, 07-06's two morning rows and 10-08's walk to Paul lost).
   Decode 48 s against 30 s on 09-14.

Parity, not a gain: the shared level's own prize on the hops is real (07-16),
and its cost is that a leg has no existence price, which the leg floors now
carry instead. Kept behind the record key as the home for S2 (`train L from
σ` as leg states, the change at a shared station), not shipped. A journey
longer than `maxJ` (10-08's 293-minute TGV) decodes as two with a stay
between — the bound needs lifting or a journey → journey continuation before
any default.

### S2 inside the journey state, first slice (2026-10-19 afternoon)

Built: a leg per named line and board station within 400 m of any fix of
the day (`Journey.Tables.reachStarts`), sharing its line's tables, allowed to
begin only at a minute the fixes put within reach of its station, its length
priced by the along-line path from the board station to the line's station
the fixes put the ride's end at (`expectedMin`, the chain's `lineSssp`), in
place of the line's generic duration prior. Two runs, same gates:

- Stations by the line's track: **125/313/62/66/5, referee 142; rows 23
  lost, 20 gained.** All three Baker Street hops decode (05-18, 07-02, 07-16:
  the three impossible legs of the flip), 10-08's stop too; 06-29 and 07-02's
  neighbouring rows go, lines −1, stations −2. 07-16's Euston Square → King's
  Cross ride comes out Victoria Line.
- Stations by the line's served calls (the relations), ride time in the
  chain's fitted form with the calls between the pair: 125/313/61/66/6, rows
  26/20 — no better; the Victoria stays, since Euston (which it serves) is
  within 400 m of the same fixes as Euston Square.

So the structure carries the hops and the line choice inside a leg is the
gap: the board and alight stations are a hard 400 m gate with no density.
Decode 69 s a day on 07-16 against 30.

The chain's anchors on the leg's ends, tried the same afternoon, refuted
twice: as absolute terms (the chain's clamped `−z²/2`, σ 200 m widened by the
fix's age; a base leg anchored to its line's nearest served station, the
clamp beyond reach) 118/311/57/55/5, rows 48 lost, 20 gained — a train paying
for ends the fixes did not see, against every other state, the RideEnds
refutation again; relative to the best station of any line at that minute
(the comparison form, a train never paying against a walk) 120/311/57/58/6,
rows 46/20 — still worse, and the Victoria stays. The ride's end fixes are
where he walked to, not where he alighted, and the line whose station is
nearest to them is not the line he rode; the chain's anchors work only
inside the line the decoder already chose, with the pace and the walk between.
Reverted. What a board-station leg contributes is its ride time; which line
boarded is the per-minute rail evidence's, which an underground ride between
Euston Square and King's Cross cannot settle for either side. The instrument
for the next step is a journey debugger: the legs of a decoded journey with
their cell, emission, entry and transition terms against a forced alternative,
which `path_debug` cannot see inside a journey. Built the same afternoon
(`"journeyDebug": {"alt": [{startTs, endTs, leg}]}` on an `assemblesegments`
request; a leg is named `train|Metropolitan Line@Euston Square`). It shows
07-16's 08:12 ride as `Victoria Line@Warren Street`: Warren Street is within
400 m of UCLH's fixes as Euston Square is, and its ride to King's Cross
expects 4.07 minutes for the 4 observed, where the Met's one stop expects
2.7 — the pair's ride time decides, and the fixes underground say nothing.
A genuine tie at the two-nat level; the narrated line (Met/Circle/H&C) is
the chain's post-hoc pick on the served day, with the same fixes.

### S2 inside the journey state, costed before building

A `train L from σ` leg per line and candidate board station: the candidates
the station-states design measured are stations within reach of the day's
fixes (19 on a mean day, 56 on 09-30, 85 on 10-08), each on one or two lines,
so L grows from 16 to about 40 on a commute day and 100 on a travel day. The
sweep's duration loop is linear in L and its hoisted transition quadratic:
3.7 × 10⁸ cells become 1–2 × 10⁹ on a London day and 4 × 10⁹ abroad — minutes
a day. Two bounds bring it back: a station-carrying leg may begin only at a
minute its station is within reach of the fixes (its `first` and its
transition rows are −∞ elsewhere, so most `(t, leg)` cells are skipped before
the duration loop), and `train L from σ` may follow only a walk, a platform
wait, or a `train L' from σ'` whose line calls at σ — the leg matrix becomes
sparse (tens of pairs a minute, not L²). With both, the inner pass stays near
today's 6.6 × 10⁸. `decodeprof` on 09-30 and 10-08 is the gate.

## Order (2026-10-19)

By the flip's loss classes after the label fix, largest first; every arm is
judged on the flip rows under its own decodes (`flipcheck.sh <tag> <dump>`, a
minute) as well as the scoreboard, which cannot see a boundary move. Done the
same day, 23/15 → 17 lost, 18 gained: served walks carry `roads` too (and the roads of the matcher's route where it is the one drawn); three
walk rows re-audited to the road their own fixes show (07-16 Hannah Close,
09-14 Eversley Avenue and Hastings Street — the served pick's road lay outside
the row's fixes); the Eurostar and Métro 4 rows name their stations under both
map names, the comparator dropping the live station's "(qualifier)"; 09-15's
office end (16:35, not 16:43) and 10-03's dinner walk (ends 16:44) from the
signal — 09-15's walk row leaves the served floors, the served day holding the office to 16:43; `alightAfterHold` and `alightAtLastFix` in `DECODER_TAIL` (10-01's
alight was the rail-run labeller's Vavin, which the served day corrects with
those two passes). Left: the underpass labels (09-14, 09-15: a passage the
fixes do not see), 06-18's board station, and the classes below.

1. **Movement inside a visit** (3): stepped spells inside narrated stays are
   short and geometric (above), so a run-length law separates nothing — the
   stay-move arm already had the right shape and still absorbed the short
   walks that return. 07-06's Work holds a fixless 15-minute stepped stretch
   the decoder reads as a walk (`darkMoveAtPlace`'s case, unabsorbed) and a
   real ten-minute excursion 100 m out and back, which the narrative counts
   as the stay; 07-16's UCH is two buildings. What separates a walk out from
   a spell is what follows it: the journey's single level (stage 2) and the
   stay's ending, not the spell itself.
2. **The journey state**: built, at parity (above), behind its key. **S2
   inside it**: the first slice is built (board-station legs, the ride time
   of the pair) and decodes the three Baker Street hops; its end anchors are
   refuted; what it lacks for the stations is still open, and the journey
   debugger is the instrument. 07-07's Euston Square → King's Cross hop and
   the `unknown_rail` stations are its remaining rows.
3. **Platform waits** (2) are S1's state.
