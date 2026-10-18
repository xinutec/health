---
created: 2026-10-18
status: design; nothing built
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

## Risks

- **Width and memory.** The inner pass multiplies the journey part of the
  trellis by the leg count; the travel-day memory smoke is in every stage's gate.
- **The verified envelope.** The trellis's proofs are about one segmentation
  level; the journey state's inner pass is a new, unproved computation feeding
  a cell, like the segment emissions are today.
- **Phantoms.** A cheaper interruption makes phantom hops cheaper too; 06-16's
  St John's Wood "hop" inside a moving Met train appeared under the boundary
  arm. Stage 3's station rule is what stops it, so stage 2 alone may not ship.
