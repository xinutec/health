# Verified core (Lean 4)

The provable half of the backend's decision logic, being ported from
TypeScript one component at a time. Design, rationale, and roadmap:
[`docs/proposals/2026-07-verified-core-lean.md`](../docs/proposals/2026-07-verified-core-lean.md).

## Build

The toolchain comes from the repo flake (no elan, no `lean-toolchain` file —
`nix flake update` bumps Lean deliberately):

```sh
nix develop -c lake build        # from lean/; also runs every #guard check
nix develop -c lake exe verified_cli   # JSON decode CLI (stdin → stdout)
```

## Layout

- `Verified/Hsmm/Score.lean` — integer log-prob scores with `-∞`; order and
  algebra lemmas (proved).
- `Verified/Hsmm/Spec.lean` — what the HSMM decoder *means*: segmentations,
  well-formedness, their score. The algorithm-independent contract.
- `Verified/Hsmm/Oracle.lean` — exhaustive enumeration + best score;
  `enum_sound` and `enum_complete` proved (`enum_iff`: the enumeration is
  exactly the well-formed segmentations).
- `Verified/Hsmm/Bellman.lean` — the backward Bellman recurrence, proved
  equal to the oracle (`oracleBest_eq_bestFrom`).
- `Verified/Hsmm/Forward.lean` — the forward DP over exact last states (the
  Viterbi principle), proved equal to the oracle
  (`forwardBest_eq_oracleBest`); reversed-list scoring + the `scoreAux` snoc
  lemma bridge the two directions.
- `Verified/Hsmm/Trellis.lean` — the trellis's τ-indexed column recurrence as
  a pure function, proved correct: the column invariant (`col_eq_openVal`),
  segment closure (`closeB_eq`), and `trellisScore_eq_oracleBest` for every
  problem shape, degenerate ones included.
- `Verified/Hsmm/Decode.lean` — the verified decoder: `decode_correct` (any
  returned path renders a well-formed segmentation achieving `oracleBest`)
  and `decode_none_iff` (`none` ⟺ everything is `-∞`). Unmemoised
  specification form; `#guard`s pin it against `viterbi` exactly, paths
  included.
- `Verified/Hsmm/Memo.lean` — the memoised form: columns built once as
  arrays (`buildCols`, pointwise-proved equal to `col`), and `decodeFast`
  inheriting `decode`'s theorems through `decodeFast_eq`.
- `Verified/Hsmm/Ckpt.lean` — checkpointed storage: `buildCkpt` retains only
  every `K`-th column plus the last; the walk recomputes queried columns
  from the nearest checkpoint (`colAt`). `decodeCk_eq` holds for *every*
  stride, so `K` is purely a space/time knob. Also the fold-form column
  functions (`rangeMax`/`closeRowF`/`colStepF`, proved equal to the
  list-form ones).
- `Verified/Hsmm/Packed.lean` — the production form: scores offset-encoded
  as `Nat` scalars (`enc`: `-∞ ↦ 0`, `v ↦ v + 2^61`) so the forward pass
  never touches GMP. Exact, not approximate: `enc_add`/`enc_max` are proved
  homomorphisms under the magnitude envelope that `col_bounded` establishes
  for every cell (inputs `|v| ≤ 2^49` emissions / `2^45` others, `T ≤ 2048`
  — the CLI refuses inputs outside it). `pDecode` inherits everything
  through `pDecode_eq`. This is what `verified_cli` runs.
- `Verified/Hsmm/Viterbi.lean` — the trellis (faithful port of
  `src/hmm/hsmm-viterbi.ts`, same loop order and tie-breaks; degenerate cases
  return `none` instead of the TS silent fallbacks).
- `Verified/Hsmm/Tests.lean` — `#guard` trellis-vs-oracle parity; **the build
  fails if the implementation ever disagrees with the spec** on these
  instances.
- `Verified/Rail/Graph.lean` — V3 (rail-snap) spec substrate: weighted
  graphs with `Nat` weights, path cost, and the exhaustive simple-path
  oracle (`oracleDist`).
- `Verified/Rail/Dijkstra.lean` — faithful port of `rail-snap.ts`'s
  `shortestPath` (binary heap tie behaviour included) with honest-`none`
  contract deltas; `#guard`-pinned against the oracle in
  `Verified/Rail/Tests.lean`, and pinned against production on real
  corridors by `npm run compare-rail` (via `verified_cli rail`).
- `Verified/Rail/HeapInv.lean` — binary-heap invariants, both halves:
  `IsHeapA`, `root_le` (the root is a minimum), sift-up repair
  (`siftUp_isHeap` via `UpOK`) with the `push` theorems, and sift-down
  repair (`siftDown_isHeap` via `DownOK`) with the `pop` theorems —
  the popped entry is a minimum and was present (`pop_min`,
  `pop_top_mem`), the remainder is a heap whose entries come from the
  old one and cover everything but the popped entry (`pop_isHeap`,
  `pop_mem`, `pop_cover`, `pop_size`), and `pop` fails exactly on empty
  (`pop_none_iff`).
- `Verified/Rail/LoopInv.lean` — the Dijkstra loop invariants on top of
  the heap theorems: lazy deletion, the monotone pop floor, the
  unsettled-finite/heap correspondence, a ghost prev-tree ranked by
  settle order, and a potential proving the TS fuel sufficient. Together
  they retire the rail `#guard` pin: `dijkstraC_eq_dijkstra` (the
  checker never fires on a real run), `dijkstra_complete`, and
  `dijkstra_none_iff` (`none ⟺ disconnected`) — all under `WFEdges`
  (in-range adjacency, true of production graphs by construction). The
  lazy-Dijkstra "settled = final" pin in `Verified/Geo` still stands.
- `Verified/Rail/Certify.lean` — the V3 goal theorems, by certification
  rather than algorithm invariants: the untrusted search's result is
  validated by a proved O(E) checker (valid simple path costing exactly
  the settled distance + a feasible-cut condition over the final arrays),
  and `cut_bound` shows a passing certificate *forces* the true minimum.
  `dijkstraC` (what `verified_cli rail` runs) carries `dijkstraC_correct`
  — any returned path is valid and attains `oracleDist` — and
  `dijkstraC_disconnected`; a certification failure degrades to `none`
  (never a wrong path). The converse ("the checker never fires on a real
  run") is proved in `LoopInv.lean`.
- `Verified/Geo/CellKey.lean` — V4 opener: `map-match-core.ts`'s grid
  cell-pair key proved collision-free (`cellKey_inj`) and double-exact
  (`cellKey_magnitude`), with the `2^21` cell-bound premise pinned.
- `Verified/Geo/RingSearch.lean` — `SegmentNearGrid`'s exactness
  comment-proof as a theorem (`ringSearch_exact`): the early-stopping
  expanding-ring search equals the clamped minimum over **all** chords.
  Order-theoretic — the stop-margin curve and the geometric chain
  (rasterisation spacing, in-cell offset, cos drift) are abstracted into
  the named hypothesis `hgeom`, which the future analytic substrate
  discharges; the search logic itself is proved today. `#guard`s include
  a toy instance where the early stop demonstrably fires.
- `Verified/Geo/Simplify.lean` — V4 display-pass layer, part 1:
  `simplifyPath`'s Douglas-Peucker recursion, *parametric over the
  metric* (the pass layer is purely combinatorial over point↔chord
  distance, so the theorems need no arithmetic substrate and no metric
  axioms). `simplifyIdx_dropped_le` is the goal: every dropped vertex
  lies within the tolerance of the retained chord spanning it — the
  load-bearing bound behind `spliceRouteDetail` (#369). Plus range,
  endpoint-survival, and ascending-chain lemmas.
- `Verified/Geo/Splice.lean` — part 2, `spliceRouteDetail` itself (the
  #369 fix), same metric-parametric treatment: `splice_sound` (every
  output vertex is a coarse vertex or a timestamp-clamped route vertex
  within `dropM` of its chord — so an excision window past `dropM`
  inserts nothing) and `splice_coarse_sublist` (the coarse line
  survives in order; the pass only inserts, so the decision layers keep
  consuming exactly the tuned coarse geometry).
- `Verified/Geo/Metric.lean` — the pinned V4 arithmetic substrate:
  1e-7° integer coordinates, µm distances via a Newton floor sqrt,
  equirectangular projection with a Q20 fixed-point degree-6 minimax
  cos (integer Horner) — no float transcendental anywhere; division
  semantics (`Int.fdiv` ↔ BigInt `>>`, `Int.tdiv` ↔ BigInt `/`) are
  part of the contract with the TS twin (`src/geo/quant-twin.ts`), and
  `#guard` vectors computed by the twin arithmetic pin the two sides.
  Instantiates the whole pass layer (`qSimplify`/`qSplice`/
  `qHoldSpeed`/`qRejectSpikes`/`qDedupe`/`qRemoveSpurs`/`qDespike`/
  `qTrim` — the last three via `qPerp`, the ≥140° turn test as an exact
  squared comparison, and `qArcPos`), so the pass theorems specialise
  for free. Representation chosen by corpus probe
  (`experiments/quant-probe.mjs`), and pinned at scale by
  `npm run compare-geo`: every golden walking leg through
  `verified_cli geo` vs the twin — 173/173 legs bit-EXACT, float↔quant
  flips zero everywhere except one near-threshold tie at the 1.5 m
  display tolerance.
- `Verified/Geo/Clean.lean` — part 4, the small cleaning passes:
  `dedupeConsecutive` (with the no-adjacent-near chain theorem),
  `removeSpurs` (the splice loop as recursion over the mutated suffix;
  farthest return wins), and `despikeUnsupportedApexes` (a pure indexed
  filter against original neighbours; apex/turn/raw-excess tests are
  parametric primitives). All proved drop-only; despike keeps its
  endpoints.
- `Verified/Geo/Trim.lean` — part 5, `trimOverRouteExcursions`: the
  spatial and temporal (#362) excision passes over the GPS corridor,
  with `corridorPositions`' monotone-floor projections, ratio
  thresholds as exact cross-multiplied rationals, and the rebuild's
  `≤ 0.5 m` dedupe. Proved drop-only (`trim_sublist`).
- `Verified/Geo/Prefilter.lean` — part 3, the GPS pre-filters
  (`episode-geometry.ts`): `holdImplausibleSpeed` with the kinematic
  honesty invariant as a theorem (`holdSpeed_chain`: every consecutive
  output pair satisfies the plausibility predicate — the drawn leg
  never contains an impossible hop) and `rejectSpikes`; both proved
  subsequences of their input (drop-only, never invent), spike
  rejection keeps its endpoints.
- `Verified/Geo/LazyDijkstra.lean` — `LazyDijkstra`'s refinement
  comment-proof: the search is a deterministic, target-free step
  sequence, so `settle(t)` is exactly the eager run-to-break prefix
  (`lsettle_eq_iter`), stops are monotone along the trajectory, and
  settles commute and are idempotent (`lsettle_comm`, `lsettle_idem`) —
  pause/resume with per-source memoisation is sound. The "settled
  `dist`/`prev` are final" fact (heap-min invariants) and fuel
  sufficiency stay `#guard`-pinned on seeded graphs, radius cutoffs
  included.
- `Main.lean` — `verified_cli`, the JSON bridge (HSMM decode on stdin by
  default; `verified_cli rail` for the V3 shortest path;
  `verified_cli geo` for the V4 display passes over quantised points).
- `experiments/compare.mjs` — TS↔Lean parity harness over seeded random
  problems (run `npm run build` first, then
  `nix develop -c node lean/experiments/compare.mjs` from the repo root).

## Conventions

- **Sorry-free.** A theorem is stated only when its proof is complete;
  unproved goals live in the proposal doc, not as `sorry`.
- Executable `#guard` checks are the stand-in for not-yet-proved equivalences
  — spec-checking on every build, upgraded to theorems incrementally.
- Integer scores only for now: exact in IEEE doubles, so the TS decoder and
  this one agree bit-for-bit. No float arithmetic gets ported on hope.
