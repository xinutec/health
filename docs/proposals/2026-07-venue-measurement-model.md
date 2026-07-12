---
created: 2026-07-12
updated: 2026-07-12
status: design (no code)
references:
  - ../design/probabilistic-principles.md
  - 2026-06-magnetic-focus-places.md
  - geometry-roadmap.md
---

# A calibrated measurement model for venue attribution

## Problem

The venue picker cannot name a café you are sitting in, and the reason
is not the GPS.

**2026-07-12, Urban Social, Upper Street, Islington.** Three visits
(06-28, 07-05, 07-12). Median fix accuracy **3–8 m**, ~30 m spread over
an 80-minute sit. All three dwell centroids land **9 / 16 / 16 m** from
the `Urban Social Coffee` node — the nearest named venue by 3× (next is
46 m). The system says **"The Library"** — the pub next door — on all
three, and has mined that name into `focus_place #6053`, which now
reinforces it every visit.

Two mechanisms, and they compound:

1. **`NEAR_FIELD_DECISIVE_M` (12 m) is a short-circuit.** The nearest
   venue wins *outright*: the mined visit-shape prior, the opening
   hours, and the whole score are never consulted.

2. **It fires on incomparable quantities.** `NearbyLandmark.distanceM`
   means different things for the two OSM mappings:
   - `The Library` is `way/31293177`, a building **polygon**
     (`amenity=pub`, 235 Upper Street) → distance to its **wall**: 3.6 m.
   - `Urban Social Coffee` is `node/331880909`, a **pin**
     (`amenity=cafe`, 236 Upper Street) → distance to a **marker**: 16 m.

   A wall at 3.6 m beats the café you are sitting in at 16 m. These are
   not the same measurement, and nothing in the scorer knows that.

### What the geometry can and cannot do

The indoor error is **not isotropic**. Measured over 492 dwell fixes on
07-12, in the local street frame (Upper Street runs at bearing 6°):

| axis | median error |
|---|---|
| **along**-street | **3.5 m** |
| **across**-street | **16.0 m** |

Same direction on all three visits. This is physical, not noise: the
smear is *caused by the building* — multipath off the facade and wifi
trilateration anchored to routers inside it — so it pushes you **across**
the street, deeper into the block.

Casting a street-perpendicular ray from the centroid passes a median
**3.5 m** from the Urban Social pin (p10 1.1, p90 7.9) — the ray really
does go through the café. But it *also* passes through The Library
(2.9 m in), Green Shop (9.9 m) and Benita Bakery (10.4 m), stacked along
the same line. **The ray resolves which slice of the block you are in; it
cannot resolve how deep into that slice — and depth is exactly the axis
the error destroys.**

That is the honest limit of *raw* geometry. It is **not** the limit of
what is knowable, because the error itself is measurable.

### Do not retry (both refuted, 2026-07-12, #341)

- **Anisotropic distance** — replace the isotropic σ=40 m Gaussian with an
  elliptical one keyed to the street axis (σ_along 15 m, σ_across 35 m).
  It *does* rule out KFC, which currently out-scores Urban Social on the
  mined fast-food prior from 24 m up the street. But it cost two
  user-confirmed café stays (**05-18 Starbucks**, **06-15 Pret A
  Manger**), each handed to a neighbour.
- **Measure a way to its centroid instead of its wall.** Exactly
  symmetrical to the bug it fixes: Starbucks is mapped as a *building*
  and Truedan next door as a *node*, so the centroid substitution pushed
  the true venue out of near-field and handed the stay to the node.

Both were **assumed** and hand-tuned. Rule 4 says calibration comes from
data. That is the whole difference between what failed and what follows.

### Not an option

A user-facing venue picker was built and reverted the same day. See
**Rule 6** in `../design/probabilistic-principles.md`. A venue the model
cannot name is a bug, and it stays open as a bug.

## The idea

Stop scoring venues on **distance**. Score them on **likelihood**:

> *How probable is the observation I actually have, given that the stay
> happened inside venue X — knowing how this sensor lies?*

Two things follow immediately, and they are the whole design:

**1. A venue is an EXTENT, not a point.** The likelihood is "you were
somewhere in this venue, then the sensor moved you". Integrate over the
venue's footprint for a way; over a *typical-premises footprint prior*
for a node (OSM simply hasn't drawn the building — that is our
uncertainty about the venue, not evidence about where you sat). Node and
polygon become commensurable **by construction**. The wall-vs-pin problem
does not get patched; it ceases to exist.

**2. The sensor's lie is LEARNED, not assumed.** The residual between
where the fix lands and where the venue is has structure — measured
above. Fit it. `p(observed | venue, frame)` becomes a calibrated
distribution instead of a made-up circle.

### Where the training labels come from — the crux

**Not from the user** (Rule 6). Not from the algorithm's own answers on
hard cases either — *that is the current bug*: `focus_place #6053` mined
"The Library" from the picker's own mistake and now self-confirms it four
visits deep. **Self-training on your own errors is what made this
sticky.**

Train **only on unambiguous stays**, where the model is right by
construction:

- exactly one label-worthy venue within the candidate radius
  (no competitor within ~50 m), AND
- tight fixes (low spread, good accuracy), AND
- a clean dwell (long enough to be a real visit, not a pass-by).

On those, the venue is not in doubt, so the residual vector
`(centroid − venue)` is a *measurement* of the sensor's bias, not a guess.
Fit the residual model on that set; apply it everywhere.

**Bootstrapping from the easy cases to fix the hard ones is legitimate.
Bootstrapping from the hard ones is self-confirmation.** This distinction
is the single most important line in this document.

### Why it can actually separate Urban Social from The Library

Checked 2026-07-12: the Urban Social node is **NOT** inside The Library's
polygon — it sits **3 m outside its wall**. They are genuinely adjacent
premises (235 and 236 Upper Street), side by side, not overlapping.

So a *corrected* position estimate can distinguish them. De-biased by the
learned across-street residual, the estimate lands on the Urban Social pin
— and **outside** The Library's footprint, which is then evidence
*against* the pub rather than for it. That is only true because the two
extents don't overlap; had the node been inside the polygon, no positional
model could have separated them and the answer would have had to come from
elsewhere (dwell shape, hours, biometrics).

## Phases

Each phase is independently checkable against the golden corpus + the
ground-truth narratives. **Starbucks (05-18) and Pret A Manger (06-15) are
the canaries** — they are the polygon-vs-node cases that killed the last
attempt. Any phase that regresses a confirmed venue label does not land.

### V0 — measurement: a venue-attribution referee

Before changing any ranking, be able to *score* it. Extend the existing
truth harness to report, over the corpus:

- venue-label accuracy against the ground-truth narratives,
- the **residual distribution** (centroid → chosen venue) in the local
  street frame, split by indoor/outdoor and by node/way mapping,
- how often `nearField` fires, and how often it fires on a *polygon wall*.

This is the number every later phase moves. Without it we are tuning
against anecdotes — which is how #341 happened.

### V1 — un-short-circuit near-field

The cheapest real win, and it stands alone.

Near-field is *sound on a clean stay* (retiring it outright cost Starbucks
and Pret) and *unsound on a smeared one* — and it cannot tell the
difference, because the scorer cannot see the stay's own GPS quality.

Plumb the stay's **fix spread + median accuracy** into `rankVenues`, and
gate the short-circuit on it: proximity is decisive only when the fix is
tight enough for proximity to *mean* something. On a smeared indoor sit it
does not fire, and the score — which already knows Green Shop (−2.63) and
Benita Bakery (−1.76) are implausible for an 80-minute midday dwell — gets
to run at all.

This does not name Urban Social. It stops the pub *winning by default*.

### V2 — venues as extents

Replace `distanceM` in the scorer with an **extent likelihood**:

- **way** → integrate the measurement kernel over the polygon.
- **node** → integrate over a typical-premises footprint prior, centred on
  the node. (Size prior can itself be mined per `amenity` subtype from the
  ways we *do* have — a café footprint is not a hospital footprint.)
- `encloses` stops being a special case: it falls out as "the observation
  is inside the extent".

Kills the wall-vs-pin incommensurability at the root. `NearbyLandmark`
grows the geometry it needs (`isPoint`, representative point, footprint);
`osm_local` already has it — see the reverted diff in `git show 49876af`
for the query shape, which was the one sound part of that commit.

### V3 — fit the residual model

Mine the residual on the unambiguous-stay set (gate above). Fit
`p(residual | street-relative frame, indoor-ness)`:

- express the residual in the **street frame** (along / across), signed so
  "across" means *away from the street, into the block* — the physically
  motivated direction.
- condition on **indoor-ness** (fix spread, accuracy, building
  containment). An outdoor park stay has no facade to bounce off and must
  not inherit an urban-canyon bias.
- start deliberately simple: a per-frame 2-D Gaussian with a learned mean
  offset. Do not reach for a mixture until the referee says the residual
  is multi-modal.

Persist like the other mined priors (`venue_type_priors` is the
precedent). Refit on the same cron.

### V4 — fold it in, and re-check the canaries

Swap the extent likelihood's kernel from "assumed circle" to "fitted
residual model". Re-run V0. Expect: KFC/Morr/Starbucks-far ruled out
decisively; Green Shop and Benita killed by the dwell prior; Urban Social
and The Library separated by the corrected position landing outside the
pub's footprint.

If Urban Social still loses, **that is a result, not a failure** — it means
the residual model is not yet the discriminating signal, and the next
evidence to reach for is listed below.

## Risks and landmines

- **The bias is not global.** It depends on which side of the street you
  are on and on the building. A single global offset would corrupt outdoor
  and park stays. Everything is conditioned on the street-relative frame
  and on indoor-ness, or it is wrong.
- **The training gate defines the model.** Too loose and ambiguous stays
  leak in and the model self-confirms. Too tight and there is no training
  set. The gate is the part to get right; V0 should report its size.
- **Venue labels will move across the corpus.** The ground-truth narratives
  are the gate, not the baselines. Re-blessing past a confirmed-label
  regression is forbidden (that is what #341 caught).
- **OSM footprints are not premises.** A `building=yes` way is often the
  whole terrace, not one unit. The extent likelihood must not treat a
  terrace-wide polygon as a confident 15 m-wide shop. Mining the footprint
  *size* prior per subtype partly guards this; a sanity cap on extent area
  is cheap insurance.
- **This is a bigger change than it looks.** It replaces the distance term
  in the venue scorer with a generative measurement model. That is Rule 4
  ("do it right"), but it is not a one-sitting job. V1 alone is worth
  shipping and is nearly free.

## If geometry still isn't enough

The remaining evidence, none of which is currently used, in rough order of
expected value:

- **Entry/approach anchor (#244).** The walk-in track is *good* GPS and
  shows which door was used and from which street. A doorstep anchor is a
  genuinely different measurement from the smeared centroid — and it is
  the thing the user's own eye reads off the map instantly.
- **Opening hours.** Unused here. A pub vs a café at 12:00 is real evidence
  and the tag is already mirrored.
- **Per-amenity biometric signature.** A café sit and a pub sit differ (HR,
  micro-movement, duration shape). `mode_biometrics` is the precedent; a
  per-amenity-class analogue does not exist.
- **Sequence context.** Tube in from King's Cross, walk out to Highbury —
  what kind of stop is bracketed like that?
- **OSM feature freshness / co-location dedup.** The Library carries
  `operator=Stonegate` + a website; Urban Social's node is sparse. When two
  venue features are co-located and one is stale, that is signal — but we
  mirror neither `version` nor `timestamp`. Cheap to add, and worth a probe
  before assuming it helps.

## Open questions

- Is the residual better modelled per-**place** (this building lies this
  way) or per-**frame** (any urban canyon lies this way)? Per-place is
  sharper but needs repeat visits, and risks becoming a lookup table — i.e.
  sliding back toward "remember the answer" rather than "model the sensor".
  Start per-frame.
- Does the residual depend on **phone orientation / which pocket**? We have
  `motion_log` now. Probably second-order; worth checking once V0 can
  measure it.
- What is the honest output when the extent likelihood genuinely ties? Rule
  5 says expose the uncertainty. The timeline currently has no way to say
  "Urban Social **or** The Library" — and that, not a picker, is the correct
  UI for a real tie.
