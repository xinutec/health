---
created: 2026-07-02
status: proposed
references:
  - 2026-06-map-constrained-positioning.md
  - 2026-07-true-path-reconstruction.md
  - 2026-07-robust-outlier-smoother.md
  - ../design/episode-geometry.md
  - ../design/probabilistic-principles.md
---

# Continuous-field walk reconstruction — the map as a soft potential, not a graph to snap to

> One-line: draw a walk as the single most probable **continuous curve** under one
> energy that fuses accuracy-weighted GPS, walking physics, and the map as a
> **soft scalar field** (buildings repel, pavements gently channel) — solved by
> the conjugate-gradient machinery already in `walk-smooth-map.ts`. No graph
> snapping, no confidence gate arbitrating between competing outputs, no post-hoc
> building-crossing / over-route / apex repairs. Those artifacts stop existing
> because they are high-energy under the model.

## The failure this fixes (2026-07-02, observed)

Yesterday's walk around a residential junction near home had **near-perfect
raw GPS** — the track sat in the road corridor the whole length, the out-and-back
showing as two near-parallel traces a few metres apart, nothing across a building.

With "snap walks to paths" **on**, the drawn line was *worse*: it cut a **diagonal
chord across a building block** between two parallel residential streets, and shortcut the
corner by the station. The Viterbi matcher routed between two graph vertices, and
the only on-graph way to connect them sliced the block. The confidence gate
(off-walkable p90) then *rewarded* that diagonal, because a chord that lies along a
way's centreline scores well on "distance to nearest walkable way" — **the gate is
blind to buildings.**

This is not a tuning bug. It is the representation.

## Why every prior direction still has this hole

The map-matching lineage — `pedestrian-match.ts` (Newson-Krumm Viterbi),
`2026-06-map-constrained-positioning.md`, and even the factor-graph in
`2026-07-true-path-reconstruction.md` — all share one premise: **the OSM walkable
graph is the truth, and the job is to place the path on it** (snap, route, or "a
trajectory *on* the pedestrian network"). That premise is wrong at the root for a
concrete reason:

**The graph is not the walkable surface.** London pavements are mostly not mapped
as separate ways — only road centrelines exist. Connecting two centreline vertices
*on the graph* forces a chord, and the chord crosses whatever block lies between
them. Any estimator constrained to the graph will manufacture corner-cuts and
building-crossings, and everything downstream (the gate, `trimOverRouteExcursions`,
`despikeUnsupportedApexes`, the building-crossing repair) can then only choose
between **"cross the building"** and **"revert to raw."** It can never produce the
thing that is actually true: *the raw line, nudged a metre off the building corner.*
That in-between is where truth lives, and the graph representation cannot express
it.

`walk-smooth-map.ts` already broke halfway out of this — it is continuous and only
*softly* map-attracted. But its map term is **nearest-walkable-way, winner-take-all
per vertex** (`nearestWalkablePoint`), which is bistable (this is why the
from-scratch profile flipped onto wrong parallel pavements), and it has **no
building term at all** (`DEFAULT_MAP_SMOOTH_PROFILE` knows only ways). It is the
right machine pointed at an incomplete world model.

## The principle

Represent the walkable world as a **continuous cost field over the plane**, and
solve for the continuous trajectory that minimises one energy. Per
`../design/probabilistic-principles.md`, the map is a **soft prior on where a
person can be**, never a hard rail: buildings are *improbable* (not impassable —
OSM footprints are sometimes wrong), pavements are *probable*, open ground is
neutral. One energy, one estimate — no stage fighting another.

### The energy

Trajectory `x = (x₁ … x_F)`, one point per fix in a local metric (ENU) frame. No
graph, no vertices, no snapping.

```
E(x) =  Σ_i  ρ(|xᵢ − zᵢ| ; σᵢ)                 (1) GPS emission, accuracy-weighted + robust
      + λ Σ_i |xᵢ₋₁ − 2xᵢ + xᵢ₊₁|²             (2) walking physics (bounded curvature/accel)
      + Σ_i  U(xᵢ)                              (3) map potential (soft field)
      + Σ_m  w · softplus(len_m(x) − budget_m)  (4) per-minute step-length (optional)
```

**(1) GPS emission** — `σᵢ = clamp(σ_floor, accuracyᵢ, σ_ceil)`, weight `1/σᵢ²`; a
precise fix anchors hard, a smeared indoor fix barely tugs. `ρ` is a **robust**
kernel (Student-t, `ν≈4`, or Huber) so a tight *cluster* of consistent bad fixes
can't dominate — this folds in `2026-07-robust-outlier-smoother.md` Slices A/B as
terms of the same energy rather than a separate matcher change.

**(2) Walking physics** — the biharmonic second-difference already in
`walk-smooth-map.ts` (`applyA`/`diagOfA`). Penalising curvature *is* the
bounded-acceleration prior; it absorbs jitter and turns right-angle staircases into
the natural diagonals a person actually walks. This is the beauty term.

**(3) Map potential** — the new heart. `U : ℝ² → ℝ` is a scalar field over the
local tile:

```
U(p) = w_b · B(p)  −  w_w · W(p)
```

- `B(p)` — **building repulsion** from a signed distance transform to building
  interiors: high inside a footprint, decaying to zero over a ~6 m margin outside,
  zero beyond. Soft, so it pushes the line off a wall or a mis-mapped corner
  without forbidding it. This is what makes yesterday's chord high-energy —
  crossing the block now *costs*.
- `W(p)` — **walkable attraction**, a wide shallow trough (distance transform to
  the nearest footway / pavement / residential centreline), `w_w` small. It gently
  channels *ambiguous* GPS onto the pavement; against a confident fix (term 1) it
  is overwhelmed, so good data stays put.

The decisive difference from `nearestWalkablePoint`: `U` is a **global field over
the tile**, not a per-vertex winner-take-all target. The whole trajectory sees one
continuous landscape, and the smoothness term (2) couples neighbours, so **no
single vertex can bistably jump to a wrong parallel way** — the flip that sank the
from-scratch profile cannot occur, because the field between the two ways is
continuous and crossing the trough wall costs.

**(4) Step-length** (optional) — `2026-07-robust-outlier-smoother.md` Slice C
verbatim: per-minute drawn length bounded by `steps · stride + slack`, one-sided
soft penalty. A 0-step minute collapses to near-stationary, killing GPS-null
teleport bursts. A term, not a gate.

### The solve — the machine already exists

Exactly the structure of `smoothWalkMap` today: Gauss-Newton / IRLS outer loop.

- Terms (1)+(2) are quadratic (term 1 after per-iteration robust reweighting), so
  per coordinate the normal matrix is **SPD pentadiagonal** → `solvePCG` unchanged.
- Term (3) is linearised around the current estimate via `∇U` (and a Gauss-Newton
  diagonal from the local field curvature) — an **ICP-style re-linearisation
  identical in shape to today's per-iteration attractor re-target**, but against a
  smooth field instead of a nearest-point. `∇U` is a bilinear lookup into the
  precomputed field.
- Term (4) linearises to a per-minute one-sided penalty on consecutive-vertex
  spacing.

The field is built **once per leg**: rasterise the local tile at ~1–2 m, run a
two-pass (Felzenszwalb / chamfer) distance transform over building-rasterised cells
for `B` and over walkable-rasterised cells for `W` — O(cells), sub-millisecond.
Five to eight outer PCG solves. Milliseconds per walk, *cheaper* than the Viterbi's
per-transition Dijkstra routing it replaces.

Set `w_b = w_w = 0` and this **is** today's `smoothWalkMap`. The proposal is that
one field, honestly built, plus the robust kernel — not a new subsystem.

## What this retires

Because a feasible path is feasible **by construction**, the reactive cleanups
become unnecessary — they chase artifacts the energy no longer produces:

- **building-crossing repair** → `B(p)` makes a crossing high-energy up front.
- `trimOverRouteExcursions`, `despikeUnsupportedApexes` (#293/#295) → an apex or
  out-and-back spur is high-curvature (term 2) and unsupported by GPS (term 1); it
  never forms.
- the **off-walkable confidence gate** as arbiter → there is one output, not two to
  choose between. (A *sanity* fallback to raw remains for degenerate legs.)

This is the unification `2026-07-true-path-reconstruction.md` Phase 4 asked for,
reached without its Phase 2 (PDR / heading) — i.e. **within existing data**.

## Measurement first — the referee must see buildings (non-negotiable)

The yesterday defect is **invisible to off-walkable p90** (a chord on a centreline
scores well). We cannot tune what we cannot see, so the metric comes first — this
is the piece #271 scoped but the shipped referee (route-correctness + sharp-turns)
does not yet carry.

Add to `src/eval/` and surface in `score-walk-match.ts`:

- **`buildingCrossingM`** — total length of the drawn line lying inside any
  building footprint (point-in-ring sampling against `buildingsNear`). Yesterday's
  snapped line reads high; a faithful line reads **0**. This is the headline gate.
- Keep **route-correctness** (truth-anchored, `walk-route-correctness.ts`) and
  **off-walkable p90** + **corridor-stall** as non-regression guards.
- Keep **`maxDrawnSpeedKmh`** from the robust-outlier doc as the teleport guard.

Arms: baseline = the currently shipped draw (Viterbi + `refineMatchedPath`) vs
candidate = the field smoother. **Ship gate, per golden day:** `buildingCrossingM`
→ 0, route-correctness and off-walkable non-regressing, and — the yesterday
invariant — **a near-perfect input leg is a near-no-op** (drawn ≈ raw within a few
metres).

## Phasing (each an independent, measured stop)

- **Phase 0 — referee sees buildings.** Add `buildingCrossingM` (+ unit tests: a
  chord through a synthetic block reads its crossed length; an on-street line reads
  0). Record the baseline across 22 golden days: how many shipped walks cross a
  building today. Ships nothing; ends the guessing.
- **Phase 1 — the field, behind a flag, not wired to the draw.** Add `B`/`W`
  distance-transform fields and the robust kernel to `walk-smooth-map.ts`; extend
  `MapSmoothProfile` with `buildingSigmaM` / `buildingMarginM` / way-field σ and a
  robust dof. TDD: yesterday's Wembley leg (real-data fixture) draws on-street with
  `buildingCrossingM = 0`; a near-perfect leg is a no-op; a smeared-cluster leg
  does not chase the cluster. Tune against Phase 0's referee. Zero production risk
  (nothing wired).
- **Phase 2 — promote to the draw.** For a walk where the field beats the shipped
  line on the referee, `episode-geometry.ts` draws the field path (`kind:"matched"`
  — no frontend change); the matched line stays as fallback where the graph route
  genuinely wins. Re-run `npm run golden`; display-only so snapshot-neutral, but
  re-verify the 37-journey gate. Deploy via push → CI → `kubectl rollout restart`.

## Data honesty / non-goals

- **No new sensors.** Uses only `accuracy` (stored), `steps_intraday` (loaded), and
  OSM `walkableRoads` + `buildingsNear` (already recorded in the golden `osmTrace`;
  no re-capture — `buildingsNear` is the smoother's existing query key). Aligned
  with the standing directive: smarter algorithm, same data.
- **Not** PDR / heading — that independent motion witness
  (`2026-07-true-path-reconstruction.md` §1) is a separate, larger lever, parked.
  This proposal makes the *map + physics + GPS* fusion as strong as it can be
  without it.
- **Not** mode misclassification (a tube tail drawn as a walk) — joint mode+position,
  #257 / `2026-06-map-constrained-positioning.md` Phase 3. This guarantees only that
  *whatever* the leg is, its drawn geometry is feasible and building-free.
- The "snap walks to paths" toggle becomes "reconstruct," which by the ship gate is
  never worse than raw — so the raw fallback the toggle currently exposes is a
  diagnostic, not a quality escape hatch.

## Risks & containment

1. **Field cost on long legs** → tile raster is O(area), bounded by the leg bbox +
   margin; distance transform is linear; cache per leg. Measure in Phase 1.
2. **Over-repulsion clips a real through-building path** (arcade, station concourse)
   → `B` is soft with a bounded margin, and such surfaces are walkable ways, so `W`
   offsets `B` there; the referee's route-correctness catches a wrongly-avoided
   corridor.
3. **Way trough still channels onto a wrong parallel pavement** → `w_w` small,
   `σᵢ` from real accuracy keeps confident GPS in charge, and off-walkable p90 in
   the referee would show the worsening. The global field + smoothness coupling is
   the structural guard the winner-take-all target lacked.
4. **Re-bless masks a regression** → the referee gates the re-bless (building-crossing
   → 0, route-correctness non-regressing), not eyeballing.
