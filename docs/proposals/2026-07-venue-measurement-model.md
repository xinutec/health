---
created: 2026-07-12
updated: 2026-07-12
status: V0 shipped; V1 refuted by V0 — see "What V0 measured"
references:
  - ../design/probabilistic-principles.md
  - 2026-06-magnetic-focus-places.md
  - geometry-roadmap.md
---

# A calibrated measurement model for venue attribution

> **Superseded in part by "What V0 measured" (below), 2026-07-12.** V0 was
> built and it refuted V1 and undercut V2. The sections between here and
> there are the *original* reasoning, kept because the measurements in them
> are real and the failed attempts must stay on record — but do not act on
> them without reading the findings first.
>
> One number below is also inconsistent with what V0 found: this section says
> the next-nearest venue to Urban Social is 46 m, measured at the **07-12**
> dwell centroid. At the **06-28** centroid — the one in the golden corpus —
> *five* venues sit within 14 m. Both measurements are real; they are
> different centroids on different days, and the difference is itself a
> finding: the venue neighbourhood the scorer sees depends on where the smear
> lands, so a conclusion drawn from one visit does not transfer to another.

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

## What V0 measured — and what it refuted (2026-07-12)

V0 (the referee, `scripts/score-venues.sh`) is built and green. It replays
the corpus, adjudicates every narrative-named stay against the label the
**timeline** shows, and reports which layer produced it. **Read this section
before acting on the phases below: it refutes V1 and undercuts V2.**

Corpus: **25/36 correct (69%)** on stays the narratives name, over 26 days.

| finding | number |
|---|---|
| venue scorer, when it decides | **16/17 (94%)** |
| **focus-place layer** | **0/4 (0%)** |
| area/address/other | 9/15 (60%) |
| near-field short-circuits | 12 — **wrong 0 times** |
| stays V1 (gating near-field) would fix | **0** |

**V1 is refuted. Do not build it.** The near-field short-circuit fires on 12
stays and is wrong on none of them. Not one stay in the corpus has the truth
outscoring a near-field winner. The premise — "near-field is unsound on a
smeared sit" — is not what the data says.

**The scorer is not the weak layer.** It is right 94% of the time it runs.

**The focus-place layer is 0/4**, and it is a *hard override*: when a mined
focus place carries an `amenity_label`, `velocity.ts` returns that label and
`rankVenues` is never called (`src/geo/velocity.ts:975`). The label itself was
mined by an earlier run of `rankVenues`. So it is the scorer's own historical
answer, frozen into a cluster, and now unfalsifiable by present evidence. That
is the self-confirmation loop, and it is structural — not a scoring bug.
Urban Social (`focus_place #6053` → "The Library") is one of the four; so are
Olivomare → "Keencare Pharmacy" and Pizza Union → "Bell & Viv".

### But removing the override does NOT fix Urban Social

The counterfactual, run against the live mirror at the 06-28 stay centroid:

| total | dist | venue | shape | dist(m) | subtype | name |
|---|---|---|---|---|---|---|
| −1.13 | −0.00 | 1.50 | −2.63 | **1 m** | convenience | Green Shop |
| −1.53 | −0.00 | 1.50 | −3.03 | 3 m | bakery | Benita Bakery |
| 0.07 | −0.01 | 1.50 | −1.42 | 6 m | pub | The Library |
| **0.47** | −0.01 | 1.50 | −1.02 | 7 m | bookmaker | **William Hill** |
| 0.04 | −0.03 | 1.50 | −1.43 | 10 m | cafe | *Urban Social Coffee* |
| 0.36 | −0.06 | 1.50 | −1.08 | 14 m | fast_food | KFC |

Near-field would hand this to **Green Shop** (nearest, 1 m). On score alone it
goes to **William Hill** — a bookmaker. The truth is **4th**.

**Five venues sit within 14 m.** Distance cannot discriminate here, at any
sigma, with any kernel. That is not a measurement-model problem — it is a
*resolution* problem, and V2 (venues as extents) is aimed at the wrong axis for
this case. The premise of this document — "the geometry can be fixed" — is
**wrong for the motivating stay**. It may still be right for others; it is no
longer the priority.

Opening hours would settle it (a pub at 10:17 vs a café) — but **neither node
carries the tag**. Corpus-wide coverage is 33.6% (cafés 45%, pubs 46%). Real
evidence, absent exactly here.

### The actual bottleneck: the shape prior is starved, and the gate starves it

The mined visit-shape prior is the only instrument left that *can* separate a
café from a bookmaker. Here is what it has learned, from the 06-28 fixture:

- **40 visits, total.** 12 subtypes.
- **cafe: 3 visits**, dwell histogram `[0, 2, 0, 1]` — **zero** in the 40–150
  minute bucket.
- **fast_food: 6 visits**, five of them in the **150 min+** bucket.
- hospital: 18 (the treatment days — legitimately the bulk of the corpus).

The model has never seen this user sit in a café for an hour. So it scores a
77-minute mid-morning sit as *more* plausible at a bookmaker (−1.02) or a KFC
(−1.08) than at a café (−1.43). That is not noise; it is the model faithfully
reporting what it was taught.

**And the teaching channel is gated shut exactly where it matters.**
`attributeStayVenue` trains the prior only on stays where one venue is within
30 m AND the runner-up is ≥20 m further (`ATTRIBUTION_MAX_DIST_M`,
`ATTRIBUTION_MARGIN_M`). On a dense high street *no venue ever passes that
gate* — and dense high streets are where cafés live. The prior is therefore
trained almost exclusively on **isolated** venues, and is structurally blind to
the venue class it most needs to learn.

The gate was written to prevent self-confirmation (train only on the
unambiguous). It succeeds — and in doing so it starves the model. Both halves
of that sentence are true, and reconciling them is the real problem.

**This supersedes the phasing below.** V1 is dead. V2/V3 are not refuted but
are no longer the lead. The lead is: *the model does not know what kind of
places this user sits in, and its only channel for learning that is closed on
precisely the hard cases.* The natural fix is the codebase's own rule —
**weight, don't filter** (`feedback_weight_dont_filter`): replace the hard
training gate with **soft, posterior-weighted attribution**, so an ambiguous
stay contributes fractional counts to every plausible candidate instead of
contributing nothing at all. That is EM, and it is a design that needs writing
up properly — with the self-confirmation guard argued, not assumed — before any
code.

## The idea (as originally proposed — read the V0 findings above first)

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
