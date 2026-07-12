---
created: 2026-07-12
updated: 2026-07-12
status: design (no code)
references:
  - 2026-07-venue-measurement-model.md
  - ../design/probabilistic-principles.md
---

# Soft venue attribution: stop throwing away the ambiguous stays

## Problem

The venue scorer's mined visit-shape prior — the term that is supposed to know
*what kind of place this person sits in for 77 minutes on a weekday morning* —
has learned almost nothing, and what it has learned is misleading.

From the 2026-06-28 fixture's `venuePriors` blob (the live prod prior):

| subtype | visits | dwell `[<10, 10–40, 40–150, 150+]` |
|---|---|---|
| hospital | 18 | `[0, 11, 7, 0]` |
| fast_food | 6 | `[0, 1, 0, **5**]` |
| restaurant | 3 | `[0, 0, 2, 1]` |
| **cafe** | **3** | `[0, 2, **0**, 1]` |
| pub | 2 | `[0, 1, 1, 0]` |
| *(7 more, 1 visit each)* | | |

**40 visits, total.** Cafés: three, with **zero** in the 40–150-minute bucket.
Fast food: six, five of them 150 minutes-plus.

So when the scorer meets a 77-minute mid-morning sit on Upper Street it ranks a
bookmaker (−1.02 nats) and a KFC (−1.08) above a café (−1.43). That is not a
bug in the scoring arithmetic. The model is faithfully reporting what it was
taught. The bug is what it was taught.

### The gate is what starves it

`attributeStayVenue` (`src/geo/venue-prior.ts`) admits a stay into the training
set only when **one venue is within 30 m AND the runner-up is ≥20 m further**
(`ATTRIBUTION_MAX_DIST_M`, `ATTRIBUTION_MARGIN_M`). Everything else contributes
**nothing**.

The reasoning is sound and is written in the code: the ambiguous stays are
exactly what the scorer must *predict*, so training on the picker's own guesses
there would launder its mistakes into the prior. That is the `focus_place
#6053` loop — the one that mined "The Library" from a bad label and now
self-confirms it — and the gate is what keeps it out.

**But the gate does not just exclude bad labels. It excludes an entire class of
venue.** On a dense high street no venue ever clears a 20 m margin: the
2026-06-28 Urban Social centroid has *five* venues within 14 m. Cafés, pubs,
bakeries, bookmakers and convenience shops live on dense high streets — that is
what a high street *is*. Isolated venues (a hospital campus, a lone fast-food
unit on a retail park) clear the margin easily.

So the training set is a **biased sample of the venue universe**: it sees the
isolated and is blind to the clustered. The prior cannot learn "he sits in
cafés for an hour" because *every such sit is ambiguous and is therefore
discarded*. The model is structurally prevented from learning the very thing
that would resolve the case it keeps failing.

Both of these are true at once, and neither can simply be dropped:

- Train on the argmax of ambiguous stays → self-confirmation (#6053).
- Train only on the unambiguous → selection bias, and a prior that is blind to
  exactly the venues it must discriminate.

**Reconciling those two is the whole problem.** This document is about the
third option.

## The idea

**Weight, don't filter.** The codebase already holds this rule for evidence
(`feedback_weight_dont_filter`, and Rule 3 in `../design/probabilistic-
principles.md`: *model impossibilities as constraints, everything else as
weighted evidence*). The training step is the one place it was never applied —
`attributeStayVenue` is a hard binary filter, and the only one left in the venue
path.

Replace it. An ambiguous stay should not contribute **one** count to the argmax,
and it should not contribute **nothing**. It should contribute **fractional
counts to every plausible candidate, in proportion to how plausible each is**:

> For each historical stay *s* with candidate venues *v₁…vₙ*, compute a
> responsibility *rᵢ = P(the stay was at vᵢ | the evidence)*, with *Σrᵢ ≤ 1*.
> Each candidate's subtype then receives *rᵢ* of a visit in the stay's dwell
> bucket and hour bucket — not 1, not 0.

The 06-28 Urban Social sit currently contributes nothing to anything. Under soft
attribution it contributes ~0.2 of a long-dwell visit to `cafe`, and also ~0.2
to `pub`, ~0.2 to `bookmaker`, and so on. **One such stay teaches nothing.**
Fifty of them, spread across different high streets with different neighbours,
teach a great deal — because the café is the one subtype that keeps recurring in
the candidate set of long mid-morning sits, while its co-tenants vary.

That is the mechanism, and it is worth being precise about it, because it is the
only reason this works at all.

### Where the signal actually comes from

Two sources of symmetry-breaking, and the design needs both:

**1. The easy stays anchor the parameters.** Isolated venues still produce
near-1.0 responsibilities. They are what the current gate already admits — we do
not lose them, we stop treating them as the *only* evidence. They pin down the
shape of `hospital`, `fast_food`, and anything else that stands alone.

**2. The ambiguous stays break ties by co-occurrence.** A subtype that is
*present in the candidate set but rarely the answer* (a convenience shop is on
every corner) accumulates thin mass across *all* dwell buckets, so its dwell
distribution converges to the marginal — uninformative, which is correct, and
which is exactly what "everywhere, therefore no evidence" should look like. A
subtype that is present specifically in the candidate sets of *long mid-morning
sits* accumulates mass concentrated in that bucket. The discrimination comes
from the **difference in conditional distributions**, not from any single stay.

This is a mixture model, and fitting it is expectation-maximisation:

- **E-step:** responsibilities from the current model.
- **M-step:** re-fit the per-subtype dwell/hour/base-rate distributions from the
  fractional counts.
- Iterate.

### Why this is not the #6053 loop

This is the objection that kills the idea if it is not answered, so it gets
answered first.

`focus_place #6053` was built by: take the scorer's **argmax**, write it down as
**a fact**, and thereafter **trust it more than present evidence**. Three
separate errors — commitment, forgetting the uncertainty, and precedence over
data.

Soft attribution does none of the three:

- It **never commits.** A 20%-likely café stays 20% likely. The count that
  enters the prior carries the doubt with it.
- It **never outranks evidence.** The output is a prior over *venue types*
  (`P(dwell | cafe)`), not a label on a *place*. It is one summand in
  `rankVenues`, clamped like every other (`SHAPE_CLAMP`), and it can be
  out-voted by distance or opening hours on any given stay.
- It is **re-derived from scratch every run** (`minePriors` is already a full
  recompute, never incremental), from the raw stays and the current geometry —
  so a bad intermediate cannot fossilise. Fix the scorer, re-mine, the prior
  moves.

The residual risk is real and must be *guarded*, not waved away: **EM can
collapse.** If the E-step uses the shape prior it is learning, a subtype that
gets slightly ahead can run away with the mass. The guards are in the phases
below (P2), and the honest position is that this is the thing most likely to
fail.

### The "none of the above" component

A stay's true venue is often **not in the candidate set at all** — an unmapped
café, a friend's flat, an office. The corpus already shows this: the referee
found 3 stays whose truth was not among the candidates.

Without an explicit escape hatch, every stay's responsibility mass is forced
onto whatever *is* nearby, and the prior learns from stays that have nothing to
teach it. So the mixture needs an **`other` component** with its own prior mass:
*Σᵢ rᵢ + r_other = 1*. A stay with no plausible candidate assigns most of its
mass to `other` and contributes almost nothing to any subtype — which is the
correct behaviour, and is what the current hard gate achieves by accident.

## Phases

**The referee (`scripts/score-venues.sh`) is the measurement.** Baseline today:
**25/36 (69%)** overall; the venue scorer **16/17 (94%)** when it runs. Every
phase reports it.

### P0 — an A/B harness that does not touch prod

The priors blob is a captured **input** to the golden fixtures
(`inputs.venuePriors`), so a re-mine in prod would not show up in a replay
without re-capturing all 27 days — and re-capture drags in unrelated OSM drift
(#342). That is not an acceptable measurement loop.

So, first: a mining CLI that writes a priors blob **to a file**, and a
`--priors <file>` flag on `score-venues` that injects it into the replay in
place of the fixture's captured blob. Deterministic, offline, prod untouched.

Without this, every later phase is unfalsifiable. It is the cheapest phase and
the one that makes the rest honest.

### P1 — soft attribution, one pass, no feedback

Replace `attributeStayVenue`'s hard gate with responsibilities computed from
evidence that is **independent of the thing being learned**: distance, the
venue-over-area term, opening hours — but **not** the shape prior. Add the
`other` component. Mine fractional counts. One pass, no iteration.

This is EM's first E-step with a neutral initialisation, and it cannot
self-confirm *at all*, because nothing it learns feeds back into what it learned
from. It is the safe half of the idea.

Expected effect: honest but weak. Long sits on a dense high street spread their
mass evenly over the block, so `cafe`, `pub` and `bookmaker` all gain long-dwell
mass. What it *does* fix is the starvation: `cafe` stops having **zero** visits
in the bucket where the user demonstrably sits. It will not, on its own, put
Urban Social top.

**If P1 alone moves the referee, take the win and stop.** It is strictly safer
than P2.

### P2 — iterate (EM), with collapse guards

Feed the learned shape back into the E-step and iterate. This is where the
discrimination comes from — and where the danger is.

Guards, all of which are non-negotiable:

- **Dirichlet smoothing stays.** The existing pseudo-counts
  (`DWELL_PSEUDO_VISITS`, `HOUR_PSEUDO_VISITS`, `BASE_RATE_PSEUDO`) already act
  as a prior on the parameters. They are what stops a 3-visit subtype from going
  to a delta function. Keep them; possibly raise them.
- **Bounded iterations**, and report the trajectory. A model that is still
  moving at iteration 20 is not converging, it is collapsing.
- **Watch the entropy of the responsibilities.** If mean responsibility entropy
  falls monotonically toward zero, the mixture is committing — which is the
  #6053 failure re-derived from first principles, and the run must be rejected.
- **Held-out likelihood picks the hyperparameters, not the referee.** Choosing
  the iteration count by "whichever scores best on the golden corpus" is fitting
  the test set. Split the stays; use predictive likelihood on the held-out half
  to choose. The referee is the *final report*, run once, not the objective.

### P3 — ship

Only if: the referee improves, **and no user-confirmed venue label regresses**
(the 05-18 Starbucks / 06-15 Pret canaries from #341 — the two labels the last
attempt silently broke). Then re-mine in prod, re-capture, re-bless golden,
deploy.

### Not in scope, but unblocked by this

`#344` — the focus-place `amenity_label` hard override. It bypasses `rankVenues`
entirely and is 0/4 on the corpus. It should become *evidence* (a prior term in
nats on that candidate) rather than a veto. It is a separate change and it does
not depend on this one, but both are the same disease: **a remembered answer
outranking present evidence.**

## Risks and landmines

- **EM collapse.** Named above. The single most likely failure. P1 exists partly
  so there is a safe fallback if P2 misbehaves.
- **The responsibilities are only as good as the geometry.** If the distance
  term is systematically wrong (which #341 suspected and could not prove), the
  responsibilities are systematically wrong, and soft attribution launders that
  into the prior — more quietly than the hard gate did, because it looks
  principled. Mitigation: the `other` component absorbs mass when nothing is
  plausible, and the referee's `truthRank` / `truthGapNats` columns make the
  laundering visible.
- **40 → how many?** The whole premise is that the training set grows a lot.
  If soft attribution only takes it from 40 to 60 effective visits, the prior is
  still too thin to matter and this was the wrong lever. **P0 must report the
  effective sample size** (Σ of all responsibilities) before P1 is written. If
  it is small, stop and reconsider.
- **Hospital dominance.** 18 of 40 current visits are hospital. The treatment
  days are a real and large part of this user's life, so that is not an error —
  but a base-rate term fitted on it will make `hospital` the default guess
  everywhere. Worth checking whether the base-rate term should be conditioned on
  something (locality? day type?) rather than global.
- **This does not obviously fix Urban Social.** Say it out loud. The candidate
  set there is `{convenience 1 m, bakery 3 m, pub 6 m, bookmaker 7 m, cafe 10 m,
  fast_food 14 m}`. For the café to win, the shape prior must overcome ~0.4 nats
  of distance+near-field advantage. A well-fitted prior plausibly can (a
  bookmaker and a convenience shop should be *strongly* penalised for a
  77-minute mid-morning dwell). But "plausibly can" is a hypothesis, and the
  referee is how it gets tested, not this paragraph.

## Open questions

- Should the responsibility be computed per-**stay** or per-**cluster**? The
  miner iterates over clusters (`refresh-focus-places.ts:167`), and a cluster
  pools repeat visits to the same place. Pooling first would sharpen the
  responsibilities (five visits to the same café is better evidence than one) —
  but it would also re-introduce a commitment step at the cluster level, which
  is where #6053 went wrong. Start per-stay.
- Does the `other` component need a *distance-dependent* prior? The chance the
  true venue is unmapped is surely higher in a residential street than on a
  mapped high street.
- The `hours` term is available for only 34% of POIs. Should a **missing**
  opening-hours tag itself be weak evidence (unmapped POIs are more likely to be
  small/independent — like Urban Social, and unlike The Library, which carries
  `operator=Stonegate` and a website)? This is a genuinely different signal from
  geometry and it is currently unused. It may be worth more than any of the
  above, and it is cheap. Probe it before P2.
