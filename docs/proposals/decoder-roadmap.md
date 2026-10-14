---
created: 2026-06-24
status: active
references:
  - ../design/probabilistic-principles.md
  - ../design/overview.md
---

# Decoder roadmap — one joint model owns the day

⚠ **Its `*.ts` names are HISTORICAL** — the TypeScript backend was deleted whole
(#975), recoverable at `06346bd^:<path>`. `worldline-feasibility.ts` is now
`lean/Verified/Eval/Feasibility.lean`, graded by `corpus_gate`'s feasibility grader;
the journey/leg shapes and scoreboard are `lean/Verified/Eval/Journeys.lean` and
`DecoderScore.lean`, gated by `journey_corpus` and `decoder_scoreboard`.


This is the single forward plan for the classification line of work. It
replaces seven separate proposals that each described one slice of the same
arc (physical-plausibility, journey-worldline, constraint-first-decoder,
decoder-owns-mode, phase1-train-softprior, tube-journey-segment,
truth-engine), plus the 2026-05 scored-classification roadmap — whose
"escalate to a joint model or keep iterating factors in the cascade?"
decision point this document resolves: escalate. The factor library it
shipped lives on as the decoder's per-minute scoring layer
(`../design/probabilistic-principles.md`); its unfinished cascade-side
phases (activating the factor scorer inside `refineMode`, the
commute-history prior as a cascade feature) are abandoned — that
investment belongs in the decoder, not in a second scoring path inside
the incumbent. Full text of all replaced proposals is in git history;
the durable parts are here.

The shipped machinery these phases build on — the HSMM Viterbi decoder, the
factor library, the generator/scorer split — is documented as current
behaviour in `../design/probabilistic-principles.md` and
`../design/overview.md`. This doc is only the *plan*: where the decoder is
going and in what order.

## Thesis

Move the day's reconstruction out of the ~38-pass heuristic cascade — each
pass making a local decision and handing off — into one joint probabilistic
decoder that owns the day end to end. The latent object becomes **one
continuous map-matched worldline**: a connected path through a unified
multimodal transport graph, observed noisily. Physical feasibility (no
teleports; board = previous alight; a line connects its endpoints) is then a
**property of the hypothesis space**, not a post-hoc pass. Every continuity
rule we hand-wrote reactively (#175, #176, #181, #234) stops being code and
becomes a structural consequence. Impossible journeys become
*unrepresentable* rather than *pruned*.

Measured evidence the cascade cannot be patched into correctness
(2026-07-14, #354): the passes don't just leak at their seams — some
**depend on other passes' errors**. Short mid-ride "stationary" fragments
(sparse tunnel fixes clustered as a stop) are mis-flipped to *walking* by
the stationary-coherence pass, and the rail absorbers rely on that wrong
label to assemble the ride; making the flip more honest broke reconstructed
journeys and moved an alight to the wrong station. In a cascade, fixing one
pass's lie can regress its consumers; in a joint decode there is no
intermediate label to lie about.

## The bar (what "good" means)

- A "your day" output a human reads and immediately accepts as *plausible*.
  Wrong-in-details is acceptable; absurd-on-its-face is not. The shared shape
  of every bug: the pipeline manufactures false structure to fill gaps and
  never checks whether that structure is physically possible.
- Type coherence: sleep snaps to lodging/residence, meals to food POIs,
  medical time to medical POIs; name-bearing places outrank nearest-address;
  physical bounds hold (a train leg ≥ expected_travel_time/2; >200 km/h is a
  plane, not a train; cycling needs HR + cadence).
- Honest "don't know": when signals conflict or are sparse, say so. "Sleeping
  somewhere near X (low confidence)" beats fabricated precision.

## Architecture

- **Latent object = a worldline.** A continuous trajectory through space-time
  that alternates *dwell at a place* and *travel between places via a mode*.
  Its support is exactly the set of physically-realisable journeys. State =
  a point on the graph + mode; the latent journey is a *path* (each state
  graph-adjacent to the next).
- **One unified multimodal graph** carrying walk / drive / rail edges. The
  substrate mostly exists unintegrated (`RouteGraph`, `osm.drivableRoads()`,
  the pedestrian walkable prior); it must be unified and given **interchange
  edges** — the only places mode may change.
- **Feasibility by construction.** The path choice makes "no teleport, board =
  prior alight, no line that skips its endpoints" true unbreakably, because
  adjacent states share a graph node.
- **Emission = map-matching likelihood** (Newson–Krumm: accuracy-weighted,
  heavy-tailed fix→edge distance) + biometric emission per mode. A bad fix
  self-attenuates under *every* hypothesis — weight evidence, don't
  hard-filter.
- **GPS gaps are inferred, not reconstructed.** The transition model
  marginalises over connected paths between the last surface fix and
  reacquisition, so there is no seam between "observed" and "reconstructed"
  for an impossibility to hide in. Confidence = forward–backward posterior
  marginals.
- **The mechanism: generator/scorer split.** The generator emits only
  physically-possible state sequences via hard constraints; the existing
  per-minute factor library (HR / speed / cadence / place-distance / duration
  / hour-of-day) scores the survivors. Factors are for tie-breaking *inside*
  the valid set, not for filtering the invalid set out of it — so the factor
  library shrinks. The hard constraints:
  - **C1** train leg is a valid `(board, line, alight)` triple
  - **C2** walking-speed bounds
  - **C3** stationary place-coherence
  - **C4** cross-segment continuity (adjacent legs share a node)
  - **C5** sleep-window coherence

Everything else is an *arm* of this one estimator, not a separate direction:
map-constrained positioning is the position arm; the generator is the
rail-edge transition support; the HSMM is the inference shell; the decoder
owns mode *because* it owns the worldline; a tube journey is a contiguous run
of the worldline (grouping is a read, not a reconstruction); the truth engine
is the measurement substrate.

**Cautionary precedent:** the superseded route-aware decoder blew position up
into a discrete `(mode, route, position, edge)` state and regressed mode by
0.6 pp with line stuck at 0/6. This plan avoids that by treating position as
a *continuous emission*, not a discrete state explosion — and by putting hard
structure in the generator, never in a per-minute scorer.

## Standing decision: the cascade does not grow

A journey-structure error on a confirmed day — where a ride boards or
alights, how a dark ride is split, a walk that was a ride — is a case for
the decoder (C4.4 and on), not a new cascade pass. Each such pass is a
local rule with hand-picked cutoffs that the cutover then has to retire,
and the cascade grew from 51 to 53 passes in one day of fixing them. The
case goes into the corpus as a `wrong` row naming the decoder work that
clears it; the served error stays visible until then. The cascade still
takes fixes outside journey structure (naming, display).

## Order from here: generic models in, cutoffs out

The cascade is most of the code (the `Geo` tree is about five times the
decoder) and most of its tuned constants. About thirty of its passes decide
one thing: where a segment starts or ends and which leg owns the edge
minutes (`rideTailTrim`, `vehicleEdgeShed`, `rideHeadClaim`,
`stayArrivalClaim`, `boardingAnchor`, `alightAnchor`, `gapRide`, `tubeHop`,
`rideThroughHold`, `alightAtLastFix`, …). A segmental decoder places every
boundary in one optimisation. Each step below replaces hand-picked
thresholds with one model, and is measured on the scoreboard and the
corpus floors before it ships.

1. **Distances are likelihoods.** A "within X m" or "faster than Y" test
   becomes the probability of the observation under the state: the mode's
   own speed distribution (the fitted `ModePrior`), fix noise, an outlier
   rate. First the gap term (`Hsmm.Geometric.gapTerm`); then the place
   terms. Per-fix accuracy needs a fixture format that carries it; until
   then the noise is the measured median.
2. **Line and station are decoder state.** On rail the state carries the
   line and the last station and moves only along that line's edges;
   boarding and alighting happen at a node the adjacent walk shares. Board
   = previous alight and "the line serves both ends" are then unbreakable,
   and the post-decode station chain and the anchors retire. Position stays
   a continuous emission; candidates are the stations and lines near the
   fixes, which bounds the state (the route-aware decoder's discrete
   position state is the precedent against).
   The station chain's terms do not move one at a time: its margin and
   floor gates are tuned to their scale, so swapping a term for a
   likelihood trades right stations for wrong ones (measured 2026-10-10:
   the anchor as a reach probability, 5 new wrong emissions and 2 right
   ones lost; the transfer alone, 1 right one lost). And a reach
   probability is the wrong form for choosing a station: it is flat for
   everything in reach, where the anchor needs the nearer one to be
   likelier. The terms and the gates change together, the gates becoming
   posterior probabilities (step 3). Designed in `2026-10-station-states.md`.
3. **Parameters are fitted.** Forward–backward EM over every captured day,
   judged on the narrated days held out. The same marginals are the
   calibrated confidence Phase 4 needs. Designed first as confidence, with
   `unknown` leaving the state space for the output:
   `2026-10-posterior-confidence.md`.
4. **The decoder's segments are the served segments** (Phase 4), then the
   cascade's journey-structure passes go one at a time (Phase 5). Naming,
   display and enrichment stay.

## Phase 0 — measurement first (the prerequisite, #250)

The evaluation apparatus the whole plan rests on does not fully exist, so
every phase's "ships only when the score rises" gate is currently a phantom.
Build the measurement before the modes — you cannot build "much smarter"
against a metric that can't move.

- **Make `bus` scorable.** `canonicalMode`/`DecoderMode` cannot relate a
  blessed `bus` row to the decoder's road-vehicle output, so the flagship
  metric literally cannot move. Surface `vehicleKind=bus`.
- **Journey-level scorer.** Score whole journeys (home → tube → bus → clinic)
  against ground-truth narratives, not just per-minute — the cutover gate is
  *defined* as journey-level no-regression but no journey metric exists.
- **Corpus invariant checker.** Run no-teleport / board = prior-alight /
  every-triple-connected over current output. It would have caught the
  2026-06-22 two-alights-at-one-station bug. Status: board = prior-alight and
  no-self-ride are the standing hard-zero gate; the labelled-line half of
  every-triple-connected shipped 2026-07-16 as the `invalid-rail-triple`
  invariant (line membership from `stationsOnLine`, ratcheted per-day ceiling
  in `tests/golden/rail-triple-baseline.json`, standing debt: the 2026-07-12
  erased-interchange leg, #351). Membership is proximity-inferred and
  over-inclusive, so it can only under-report — a *served-station /
  stop-pattern* check needs real route-relation membership (see the
  route-membership mirror task).
- **Position-teleport check.** Extend `worldline-feasibility.ts` (today only
  `rail-discontinuity` / `degenerate-train-leg`) with a `position-teleport`
  kind: a stay/sleep place must be reachable from the adjacent observed
  position. The 2026-06-24 sleep-10km-from-prior-fix bug proves the invariant
  must cover *place*, not just rail. The "prefer Home" patch was tried and
  reverted (it broke inpatient nights) — the fix is continuity, not a
  residential bias. Status: shipped as `teleport` in
  `Verified.Eval.Feasibility` — two stays at different places with nothing
  relocating between, judged at the position each name was asked for
  (`DayState.placeAt`), noise from the fixes' reported accuracy; ratcheted
  per-day ceiling in `tests/golden/teleport-baseline.json`. Sleep windows with
  no fixes are not yet judged.
- **Confidence calibration.** Emit a per-segment confidence plus a
  reliability/Brier/ECE metric so "calibrated honesty" is measured, not
  asserted. Phase 4's gate depends on this.
- Grow the ~11-day confirmed ground-truth corpus — the single
  highest-leverage input.

## Phase 1 — wire the train generator (C1) as a soft prior

Line attribution should come from structural `(board, line, alight)` validity
instead of soft proximity factors that left the line score at 0/6. The
generator `enumerateTrainCandidates` is written and tested but unused in the
decode. **Soft prior, not a hard −∞ filter** — a hard filter zeroed real
rides when sparse post-alight GPS fell >250 m from the station. Status:
in progress (#249, #181). Measured: 05-22 line 0/6 → 3/6.

## Phase 2 — buses (C-bus)

Turn "driving" into a named "bus N" via a stop-anchored route layer (mirror
OSM `route=bus` relations into `bus_route_cache` via throttled cron; match by
stops, not fixes; a personal route prior breaks parallel-route ties). The
matcher shipped on the **heuristic path** 2026-06-15/16 (#256); the
decoder-side `bus` mode does not exist yet (today bus is a display mode
derived from `driving` + `vehicleKind:"bus"`). Sequenced early because the
named-bus win depends on nothing downstream. Bus stays ambiguous-by-design on
shared corridors until the personal-route model lands.

## Phase 3 — physical generator constraints (C2–C5)

Walking veto, stationary coherence, cross-segment continuity, sleep-window
coherence. **C4 (continuity) is the long pole** — highest value, most
slip-prone, subsumes the most heuristics. The 2026-06-16 re-measure confirmed
the decoder's real weakness is **under-reconstruction** (abandoning legs to
`unknown`; trips 48%) — that is C4, *not* #238 rail-over-crediting, which is
demoted to a lower-priority guard already pinned by the 05-25 taxi fixture.
Status: C4.0–C4.2 DONE and LIVE in prod (the four continuity flags flipped
2026-07-17, scoreboard blessed); C4.3 v1 shipped 2026-07-18 (chained-triple
station resolver — the decoder emits confidence-gated board/alight,
CLASSIFIER_VERSION 5, full `decoded_days` backfill re-decoded); C4.3 v2
shipped 2026-07-18 (trajectory coherence — in-leg on-track fixes admit and
vote on boundary stations via a robust Theil–Sen fit, out-voting corrupted
reacquire anchors; dwell-disqualify emission gate; CLASSIFIER_VERSION 6;
corpus stations 2 matched / 0 wrong, the 07-16 morning pair recovered).
#364 served-station membership shipped 2026-07-19
(rail_stops_cache mirror + station-chain not-served penalty,
CLASSIFIER_VERSION 7; corpus A/B: +6 station emissions, one
wrong-in-waiting corrected, 0 wrong, scoreboard aggregate unchanged).
Next: C4.4 (journey authority flip). Details + measured numbers in
`2026-07-continuity-c4.md` (#224, #225).

## Tube-journey composition (prerequisite of the cutover)

Group consecutive train + intra-station-walk + platform-wait minutes into one
journey segment, so eval and UI read at journey level while the per-minute
physics stay honest. Post-decode, pure, deterministic
(`tube-journey-assembler.ts`); persistence is a light `tube_journeys` table
pointing into minute runs, not a tree rewrite. This is a hard dependency of
Phase 4 — the cutover gate is journey-level precisely because the decoder is
deliberately honest about interchange walks the narrative folds into the
journey. Status: assembler shipped (#228), eval/persistence/UI pending (#227,
#229, #230).

## The cutover plan (2026-10-13)

**Where it stands.** The served day is the Lean cascade (`Verified.Geo.PassFold`)
over the raw inputs. The decoder reaches it through one pass, `hsmmOverride`
(`PlaceOverride.applyHsmmPlaceOverride`): which place a stay is at. Its train
legs, boundaries and stations do not reach the served day — C4.4 below was
planned and never built. The decoder itself is the fitted one
(`2026-10-segment-emissions.md`; the s43c record at `CLASSIFIER_VERSION` 10).

**The gate is the served day, not the old decoder.** On the journey referee
(the served day's journey floor, `tests/golden/journey-baseline.json`), the
served day reconstructs 140 narrated journeys and the held-out decoder 130.
Flipping now loses ten. Per day: the decoder leads on six days (+6) and trails
on ten (−16), the trailing mostly 10-08 (−4: Paris, the TGV, the Métro),
06-12 (−2) and 06-16 (−2). Re-count with the referee before acting on these.

**Steps, each measured on the floors and the scoreboard before the next:**

1. **Close the gap from the decoder's side.** The sixteen journeys the served
   day gets and the decoder misses are the work queue, read one by one as the
   scoreboard misses were (`2026-10-segment-emissions.md`, Next). No cascade
   pass is copied into the decoder; each miss names the model term it lacks.
   Listed journey by journey against the same narratives, fifteen are the
   served day's alone and five the decoder's: five train journeys with an
   interchange (06-12, 06-16 twice, 07-07, 10-08 — the decoder breaks a
   change of trains), three with a bus leg (06-12, 06-16, 09-06 — there is
   no bus state, roadmap Phase 2), three short rides (04-29, 07-06's one-stop
   hop, 07-16), the rest of 10-08 (Paris), 10-07's walk and 05-25's drive.
   The interchange is the largest and the one the decoder's own structure
   should carry (line and station as state, step 2 of "Order from here").
   Read on 06-16 (16:45, King's Cross onto the Metropolitan line): the
   narrative's reading loses by 2.6 nats. The five minutes standing at the
   platform cost the train 8.9 more than `driving` (a Tube train is at a
   standstill on 4% of its minutes), and the train generator's +3 entry
   credit appears only once the train is seen moving between stations, so
   the boarding at King's Cross earns nothing and the decoder boards at Great
   Portland Street instead. Read as the decoder's own structure would carry
   it — a five-minute placeless stay on the platform, then the ride, which
   `foldRideWaits` folds into the journey — it loses by 2.1: better on the
   evidence by 3.8, worse on the stay's 5% entry (−2.5), the generator's +3
   going to the moving boarding (−3.0) and two short durations (−3.6). The
   lever is the generator's boarding credit (`TrainGenerator.VALID_LINE_BOOST`,
   a hand constant, granted only inside a window the generator saw moving):
   a ride from station A is evidence for the platform wait at A too.
   **Measured (s40bw, held out):** each generator window reaches back over
   the visit to its boarding station (`TrainCandidates.boardingWait`: fixes
   within the station radius, or dark, back to the first fix elsewhere); the
   credit only lets a train segment begin there, and the minutes' evidence
   picks where. Scoreboard 123 / 300 / 61 / 54 / 6 against 120 / 299 / 60 /
   50 / 6, referee 135 against 130; 06-16's King's Cross change, 07-06's
   one-stop hop and 10-08's evening boarding found, nothing lost. The fitted
   Tube standstill rises from 4% to 13% of minutes: the platform waits inside
   narrated train rows were the standstills the coverage had been hiding.
   Against the served day: ten journeys its alone (from fifteen), five the
   decoder's. Then 10-08's three were the narrative's: derived rows the
   steps contradict (the walk to Loiola ended at 06:53, the Hendaye walk was
   08:18–08:21 with no steps after, a stop 15:51–15:59 on the way to Paul),
   corrected from the signal and every floor re-blessed on them (f8c6154).
   Then 10-07 (a 17-minute stop inside the beach walk, about 10 steps a
   minute; he said he might have stopped) and 04-29 (4 steps in nine minutes
   at Arnhem: no transfer walk) were corrected the same way; 05-25 was not —
   its note records a 293 m crawl in the car, so the decoder's stay there is
   the miss. **The decoder ties the served day: six journeys each side, 141
   apiece.** The served day's six: three bus legs (no bus state), 07-07's
   above-ground Metropolitan tail (read as `cycling`; pooled chains for the
   unobserved modes, `poolUnobservedModes`, measured neutral, s41c), 04-29's
   short ride, 05-25's crawl. Step 1 is met; the cutover's journey gate holds
   at parity. A train boarded while it stands at the platform
   is the station-as-state case; no number in the current form fixes it
   without moving every other boarding. Measured on the way: exact
   coordinate repeats (the phone re-reporting its last position
   underground) are 15% of narrated train fixes and 1% of stays'; dropping
   them as non-measurements (`dropRepeatedFixes`) is neutral on every count
   (s39rep in the segment-emissions table) and stays off.
2. **C4.4a — station authority per side.** Where the decoder emitted a
   leg's board (alight) station, the served day's train leg takes it and the
   anchor passes stand down on that side. The decoder's segments reach the
   fold without stations today (`fold_payload::encode_caches`, `HmmSeg`); they
   gain `boardStation`/`alightStation`. Smallest flip with the existing seam.
   **Measured before building it:** on the 90 narrated train legs with
   stations, the served day names 84 boards and 86 alights, the decoder's
   own chain (s43c) 66 and 72 — authority per side would lose stations. Its
   misses are legs it names nothing on (`unknown_rail`: the mainline and
   foreign trains) and wrong underground ends (Farringdon for King's Cross,
   Great Portland Street for Euston Square). Its "Baker Street" ends on
   05-18, 06-23, 06-24 and 07-02 match the signal: steps at Baker Street,
   the fixes dwelling there one to six minutes, then Great Portland Street
   and Euston Square, and outbound rides 6–12 minutes longer than the
   returns. The narratives had through rides (on 06-23 his own account on
   the day); asked again he thinks he changed but does not remember clearly,
   so the change rows are `{derived}`. The served day still serves through
   rides. The cascade's station passes run over the decoder's segments
   (`railRuns` to `alightAtLastFix` added to `DECODER_TAIL`, reverted) name
   70 and 76: they fill the unnamed legs but merge the decoder's correct
   changes of trains (05-20 and 07-16 at Baker Street, 06-09 and 06-12 at
   King's Cross). The decoder's stations where it names one and the
   cascade's elsewhere: 80 and 84. Then the chain learned the wait at a
   station (`StationChain.waitBound`): where the in-leg fixes stand at a
   candidate station from the leg's start (to its end) — at least two
   distinct positions, so a fix held underground is no wait — the ride
   leaves (reaches) it at the wait's last (first) fix, and the dwell,
   trajectory and duration terms read from there. 06-12's Metropolitan leg
   started dark at 14:59 with the fixes standing at King's Cross until
   15:03, and the chain had boarded it at Farringdon. The decoder's own
   stations: 72 and 74 of 90; scoreboard stations 59 → 67 held out, lines
   +1, nothing else moves.
   **Stations reach the fold** (`HmmSeg.boardStation`/`alightStation`,
   carried onto the decode in `build_day_request`): under the decoder head a
   train leg the chain named reads `board → alight · line`, and only a leg it
   named nothing on takes the cascade's rail-run label, one leg at a time
   (`RailRunAnnotate.labelUnnamedTrains`), so no change of trains is merged.
   The headed day names 82 boards and 84 alights of 90 against the served
   day's 84 and 86, and reconstructs 143 journeys against 142. It wins the
   Baker Street changes the served day rides through (05-18, 06-23, 06-24);
   it loses where the decoder has no leg (05-22's Jubilee from Baker Street,
   05-18's last leg, 07-02's Metropolitan from Finchley Road), 06-18's board
   (Great Portland Street for Euston Square), and three names the fill-in
   labeller spells apart from the narrative ("Centraal Station" for Arnhem
   Centraal, "Gare du Nord (Métro)", Vavin for Montparnasse-Bienvenüe).
   Those three are segmentation, not spelling, but for "Gare du Nord
   (Métro)": the decoder rides 04-29 from 47 minutes before Arnhem through
   the nine-minute stop there, and ends 10-01's Métro leg a stop early.
   **Stays under the head.** The enrichment stage in the head costs
   journeys (132) and stations (64 and 71): it rewrites modes and labels as
   well as naming. Its stay branch alone (`nameStay`, a head-only pass
   before the decoder's places) keeps journeys at 143. The name-confidence
   grader then moves on 33 days: the headed day names 170 of 190 graded
   stays right there, the served day 188 of 199 — a night fewer graded on
   most of them (the decoder's home place where the served day's sleep rule
   names it), one more wrong on several, 10-08 4 of 8 against 8 of 8. The
   flip waits on the stays: the decoder's authority over them (step 4,
   #1947), not their names. Two of the gap's causes were naming after all: the waits at a
   station (`boardingStayLabel`, `interchangeStayLabel` in the head's tail:
   Loiola and Hendaye on 10-08 had taken a school and a bar), and the dark
   night. The cascade leaves no segment over a night without fixes and the
   sleep window draws the sleeping state at its place; the decoder covers
   that night with a stay at no place, which no sleep window could name. A
   stay nobody placed under a window that has a place is now asleep there
   (`DayState.stateForInterval`; the served day unmoved). Headed: 176 of 192
   right against 188 of 199 on the days that move; what is left is a stay
   the headed day does not have (a short stop inside a walk, a wait at a
   station), on eleven days one each, 07-16 two.
   **What a re-decode would change today: nothing graded.** The served day
   fed the live decode (s43c) or the next (the chain's wait, a stay's fitted
   spread) in place of each fixture's stored one (`FOLD_DECODE_FROM`): every
   gate passes, no journey and no graded stay name moves on any narrated day.
   The served day takes only stay places from the decoder (`hsmmOverride`),
   and those agree. So the decoder's improvements reach him at the flip, and
   their re-decode waits for it.
   **A change of trains, as the narratives write it.** His rows write an
   in-station change as a stay at the station (06-29, 07-01: "stationary @
   Baker Street"); the five derived Baker Street changes now do too. Two
   head-side readings measured and kept out: a walk of at most a journey's
   pause between two train legs drawn as the stay (stays gap 11 → 8 named
   right, but 06-29, where his rows walk to the platform and then stay, loses
   its journey: 141 against the served 142); and a ride's standing start or
   end at its station split off as the stay (the chain's wait, measured with
   the station lookup), which breaks journeys wherever the wait outlasts the
   pause (134). Step 2 therefore waits on the chain's
   underground ends (#238) and on names for the legs it calls `unknown_rail`.
3. **Each mode's longest segment.** Only stays need the whole-day cap; the
   trellis's single `maxD` makes every mode pay for it (a heavy day decodes in
   45–60 s against 5–6 at 240). Per class, cut where the fitted duration's tail
   is negligible. Touches the verified trellis, so it goes with step 4's work.
4. **Window authority (C4.4b, then stays: #1947).** Where the decoder's
   posterior clears a bar (`2026-10-posterior-confidence.md`), the served day
   takes its segments for that window; the cascade keeps the rest. Extended
   from train journeys to stays, it is #1947.
5. **The flip.** When the decoder reconstructs at least what the served day
   does, its segments are the served day; the cascade's journey passes retire
   one at a time (Phase 5), each with a version bump and a re-decode.
   **Measured as a harness seam (`FOLD_DECODER_HEAD`):** the decoder's
   segments head the day fold, the split, enrichment and correction stages
   stand down, and only the naming tail runs (`DayEntry.DECODER_TAIL`: track
   and road geometry, bus evidence and routes, zone, biometrics, the decoder's
   places). On the s41c held-out decode: 141 narrated journeys against the
   served day's 142, six the served day's alone and five the fold's. The
   naming tail does label a decoder ride a bus (06-09). On 06-12 and 09-06 the
   bus labellers found no wait at first: they look for the stop wait strictly
   before the leg, and the decoder's minute boundaries put it inside the 06-12
   ride and a minute before the 09-06 one. With the head, the bus passes take
   the wait within a minute of the start either side
   (`Bus.detectBoardingWaitNear`, `Env.boundarySlackS`; the cascade's walk-back
   is unchanged at 0), and both rides read `bus`. Neither journey turns: on
   06-12 the decoder's alight is 09:28, where the steps put it (61 a minute),
   against his narrated 09:29; on 09-06 the decoder reads 18:53, the pull-away
   at 19–40 km/h, as walking, because the 48 boarding steps at 18:52 make a
   walk and the walking duration prior costs one minute −10 against two
   minutes' −3 (the evidence prefers the ride from 18:53 by 3.5, the path
   loses by 2.1). With speed on the minute pairs inside a segment (s43c in
   the segment-emissions table) the 09-06 boarding decodes as narrated and
   06-16's bus becomes a vehicle segment; under the head the decoder
   reconstructs 143 narrated journeys against the served day's 142. Shipped
   as `CLASSIFIER_VERSION` 10.

## Phase 4 — the cutover

Take the user-facing mode from the decoder's per-minute sequence (composed via
the tube wrapper) instead of `refinedMode ?? mode`, gated where a per-segment
decoder confidence clears a bar — that calibrated confidence is itself a
deliverable of this phase. Gate = journey-level truth-check parity: no
ground-truth narrative regresses. A premature flip (2026-06-13:
support-fraction ≥ 0.6, no composition, no calibrated confidence) measured
0 wins, 2 regressions — which is the empirical case for doing Phase 0 + C-bus
+ C2–C5 + calibration first. Status and the current plan: "The cutover plan (2026-10-13)" above, which
supersedes this section's figures.

## Phase 5 — retire the heuristic mode passes

Delete the ~16 hand-coded mode passes one at a time, each behind a
no-regression check + `CLASSIFIER_VERSION` bump + full re-decode. **Not pure
subtraction:** structural passes (reconcile / absorb / splits) map onto C1–C4
and are safe to drop; scorer-side passes (`revertIsolatedCadenceDrives`,
`demoteJitterWalkToStationary`) encode emission knowledge the decoder must be
*shown* to reproduce before deletion. Requires the classification-snapshot CI
gate (#103) because real fixtures are gitignored. Status: pending (#226).

## The shape of the code at the cutover

The arm phase adds a flag beside every old path, so the tree grows while the
model shrinks; the layout is rewritten once, when the flags become defaults
and the old paths go, not per arm. Counted in `lean/` by `wc -l` at the time
of writing, the cascade is five times the decoder, the decoder's one directory
holds three kinds of file, and the two seam files (`ServeEntry.lean`,
`rust/backend/src/lean.rs`) grow by a match arm per mode.

1. **`Verified/Hsmm/` into three directories.** `Model/`: what a signal looks
   like under a state (emissions, segment emissions, transitions, durations,
   entry). `Trellis/`: the verified machine (spec, packed proofs, forward and
   Viterbi, posterior, checkpoints, quantisation); its proofs and `#guard`s
   stay as they are. `Rail/`: lines and stations (the route model and graph,
   train candidates, served stations, the station chain while it exists).
   Rule: a file in `Model/` does not import `Trellis/`.
2. **One parameter record, one artefact.** A `DecoderParams` record in
   `Model/`, loaded from one fit file with its provenance (which days, held
   out how). `Emissions.modePriors` and the per-mode gammas move out of source
   into it; `flags.segEmission`, `flags.transFit`, the per-day fitted priors
   and the term weights fold into it as their forms become the default. The
   code holds the form; the artefact holds the numbers
   (`../design/probabilistic-principles.md`, Rule 8).
3. **The seam by surface.** `ServeEntry` becomes one file per mode family —
   decode, instruments (`emissionDebug`, `pathDebug`, `decodetrace`,
   `decodeprof`), the geometry ops, the parsers — and `lean.rs` the same way,
   each wire type beside the mode that uses it. Rule: a new mode is a new
   file, not a new arm in the big match.
4. **`Verified/Geo/`: delete, do not arrange.** The journey-structure passes
   go one at a time (Phase 5); what remains — naming, display, enrichment —
   is laid out once it is known what remains.

## Dependencies

- **Phase 0 gates everything** — no phase can claim no-regression until the
  journey scorer, bus-scorable mode, calibrated confidence, and the
  invariant/teleport checks exist.
- **Phase 1 → Phase 4** — line attribution must improve before the cutover
  can rest on decoder mode.
- **C-bus depends on nothing downstream** — shippable early on the heuristic
  path; decoder-side bus needs a new state + route mirroring + L4 personal
  prior.
- **C4 continuity is the long pole** for both the structure work and the
  cutover.
- **Tube composition is a hard prerequisite of Phase 4.**
- **Phase 5 depends on Phases 1–4 being in prod and stable**, plus the
  decoder proven (not assumed) to reproduce scorer-side emission knowledge.

The whole program runs **shadow** behind the existing output and is compared
before it takes authority. Both wholesale swaps tried this cycle measured to
regress (`USE_FACTOR_SCORER=1` cost +15 truth regressions; a symmetric
train-demotion cost +4) — the empirical case for incremental gating over a
big-bang flip. The hard bar on every phase: golden truth clears ≥ regressions,
impossibility count = 0, judged against ground-truth narratives, never
pipeline output.
