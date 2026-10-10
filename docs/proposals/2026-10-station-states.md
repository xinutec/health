---
created: 2026-10-10
status: design, not started
references:
  - decoder-roadmap.md
  - 2026-07-continuity-c4.md
  - ../design/probabilistic-principles.md
---

# Stations as decoder states

The decoder roadmap's step 2 ("line and station are decoder state"), designed
against what the decoder misses today. Nothing here is built.

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
