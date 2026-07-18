# Verified core: porting decision logic to Lean 4

Raise the static-correctness ceiling of the backend by moving its *decision
logic* into a total, theorem-proving language, leaving a thin effectful shell.
The long-run shape: a proved Lean core owning classification, geometry, and
decoding; glue (HTTP, cookies, SQL execution, OAuth, sync clocks) in a small
server-capable layer that only ferries bytes and executes plans the core
emits.

## Why this codebase, why now

- **The boundary already exists.** Of the ~44k-line backend (excluding CLI
  harnesses), ~36k lines (`geo/`, `hmm/`, `eval/`, `sleep/`, `infer/`) are
  domain logic, almost all of it already pure ("geometry in, geometry out, no
  DB or network"). The genuinely effectful shell (`routes/`, `db/`, OAuth,
  sync, middleware, server) is ~7k lines. The migration inverts which language
  owns which side; it does not need to restructure the system.
- **The informal proofs are already written — in comments.** The exactness
  lemma on `SegmentNearGrid.nearestDist`, the lazy-vs-eager Dijkstra
  refinement argument, `cellKey` collision-freedom, `nearAnyBucket`
  conservativeness (`src/geo/map-match-core.ts`). These arguments are
  load-bearing and unverified, and the historical defect record is exactly
  algorithm-vs-spec divergence (the 2026-07-01 `routeBetween` penalty bypass;
  the `scoreDay` lowercase-key silent 0/0). Verification targets the layer
  where the code must faithfully implement stated math. Model *quality*
  (tuned constants, emission weights) stays with the golden harnesses.
- **Everything is structurally terminating** (bounded trellis loops, Dijkstra
  settling, fixed-iteration CG), so a totality-checked language fits with
  zero redesign.

## Why Lean 4

- The deepest comment-lemmas are ε-budget arguments over ℝ (grid exactness,
  equirectangular cos drift) — Mathlib territory, unmatched elsewhere.
- The dominant proof pattern is spec ≡ optimised-impl refinement (brute-force
  nearest vs grid; eager vs lazy Dijkstra; mathematical recurrence vs flat
  rolling array). Lean states the naive spec and proves the fast version
  equal, compiling only the fast one.
- Compiles to C with unboxed arrays and in-place mutation; day-scale decode
  measured well under the TS runtime (see the pilot). A native binary or
  C-linked library slots in where the pure core sits today.
- Totality is the default; `partial` is opt-in and quarantined.

Runners-up: Dafny (best proof automation, but `real` compiles to arbitrary-
precision rationals and native floats via extern abandon the verified
arithmetic); Idris 2/Agda (purest totality, weak automation and analysis
libraries); Rocq+Flocq (true IEEE-754 proofs at a much higher proof cost than
this project needs — the margins are already explicit in the constants).

## What exists (V0 + the V1 spec layer, shipped 2026-07-18)

`lean/` is a Lake package pinned by the repo flake (`nix develop` provides
`lean`/`lake` 4.30.0; no elan, no `lean-toolchain` file). Sorry-free policy:
theorems are stated only when proved; goals live in docs.

- `Verified/Hsmm/Score.lean` — integer log-prob scores with `-∞`; the order
  and algebra lemmas (assoc/comm/identity, total order, fold-max bounds and
  attainment) are proved.
- `Verified/Hsmm/Spec.lean` — the meaning of `src/hmm/hsmm-viterbi.ts`,
  independent of any algorithm: segmentations, well-formedness, the score a
  segmentation earns (init/entry/emissions/duration/transition composition).
- `Verified/Hsmm/Oracle.lean` — exhaustive enumeration of well-formed
  segmentations; `enum_sound` and `enum_complete` are proved, so
  `enumAll` is *exactly* the well-formed segmentations (`enum_iff`) and
  `oracleBest` is a true, attained upper bound (`oracleBest_ge`,
  `oracleBest_attained`).
- `Verified/Hsmm/Bellman.lean` — the backward Bellman recurrence
  (`bestFrom`, choice-for-choice mirror of the enumerator) with
  `bestFrom_eq` / `oracleBest_eq_bestFrom` proved: because `Score.add`
  distributes over `Score.max`, "max over all segmentations" factors
  through the first segment's choice.
- `Verified/Hsmm/Forward.lean` — the **Viterbi principle**, proved: the
  forward DP `bestEnd P s m` (best over segmentations of `[0, m)` whose
  last segment has state exactly `s` — the parameterisation that lets
  transitions be paid at segment starts, as the trellis does) satisfies
  `forwardBest_eq_oracleBest`. The proof runs through a reversed-list
  representation (`scoreRev`, bridged to the spec score by the snoc
  lemma `scoreAux_append_single`) and reversal-closure of the
  enumeration (`adjDistinct_reverse` et al.).
- `Verified/Hsmm/Viterbi.lean` — the trellis, a faithful port of the TS loop
  order and strict-`>` tie-breaks. Two deliberate contract changes: degenerate
  input returns `none` (TS silently returns an all-`states[0]` path), and a
  broken backtrack chain returns `none` (TS leaves minutes unfilled).
- `Verified/Hsmm/Tests.lean` — `#guard` parity checks (trellis vs oracle,
  ~78 seeded instances with hard `-∞` zeros) that run inside `lake build`:
  the build fails if the trellis ever disagrees with the spec's oracle.
- `Main.lean` / `lean/experiments/compare.mjs` — a JSON stdin/stdout decode
  CLI and a TS↔Lean parity harness: 42 seeded problems decoded by both
  `dist/hmm/hsmm-viterbi.js` and the Lean binary, re-scored by an independent
  referee in the harness. All agree exactly — identical paths, identical best
  scores, including a day-scale problem (T=1440, S=8, maxD=120) and
  degenerate all-`-∞` cases.

Integer scores are the deliberate v0 substrate: integers are exact in IEEE
doubles, so TS and Lean agree bit-for-bit and every lemma is provable without
a float model. The float bridge is its own later phase.

## Phases

- **V1 — the equivalence theorem. PROVED at the spec level.** The full
  chain is theorem-backed: oracle completeness; the backward Bellman
  recurrence; the forward (Viterbi-principle) DP; the trellis's τ-indexed
  column recurrence (`Trellis.lean`: `col_eq_openVal`, `closeB_eq`,
  `trellisScore_eq_oracleBest` — no side conditions, degenerate shapes
  included); and **the pilot's goal theorem** (`Decode.lean`):
  `decode_correct` — any decoded path is the rendering of a well-formed
  segmentation achieving `oracleBest` — and `decode_none_iff` —
  `none` exactly when everything scores `-∞`. `decode` picks the final
  cell with `pickBest` (a first-best argmax with a proved attainment
  lemma) and reconstructs by re-searching each boundary argmax against
  the proved `col` recurrence, so no backpointer invariants were needed.
  Its first-best tie-breaks compose to the same selection order as the
  TypeScript loops — `#guard`s pin `decode == viterbi` *exactly* (paths
  included) on the test family. What remains of V1, now purely
  mechanical: **efficiency** — memoise `col` into per-`t` arrays (a
  pointwise refinement that cannot disturb the theorems; today `decode`
  recomputes `col` exponentially, so the proved decoder is exact only on
  small instances while `viterbi` remains the production path), then
  genericise `Score` so the theorems are parametric over any linearly
  ordered additive monoid with bottom.
- **V2 — real-data shadow.** Export integer-scaled (×2²⁰, exactly
  representable) emission/transition/duration tensors from the decode loader
  behind an env flag; A/B the Lean decoder against the TS trellis on the
  golden `decoded_days` corpus via `score-decoder`'s replay, then as a shadow
  in the decode-recent CronJob with an agreement metric. Rounding may
  legitimately flip near-ties, so the referee compares achieved scores, not
  paths. UI surfacing (a dev-footer agreement badge) comes only once the
  shadow is stable.
- **V3 — rail-snap.** Small, stable, pure; Dijkstra correctness and the
  "null over wrong path" contract as theorems.
- **V4 — map-match-core.** After the walk-geometry churn settles (#330): the
  two comment-proofs (grid exactness, lazy-Dijkstra refinement) become
  theorems; the honesty guards become verified postconditions.
- **V5 — the shell.** As the decoder-roadmap folds passes into the decoder,
  the Lean core absorbs them; when the TS remnant is small, choose the
  permanent shell (thin TS as-is, or Rust linking the Lean core in-process).

## Landmines

- **Proof cost is the budget item.** The pilot took one session; the V1
  equivalence theorem is the real test of the cost curve. If it runs long,
  the `#guard` oracle-parity gate is the honest fallback: executable
  spec-checking on every build, upgraded to theorems incrementally.
- **Floats.** Never port float arithmetic and "hope"; either integer-scale at
  the boundary (V2) or prove over exact structures with explicit error
  margins. "Byte-identical" refinement claims need only same-ops-same-order
  and survive floats; anything using arithmetic facts does not.
- **Toolchain drift.** `nix flake update` can bump Lean; Lean minor releases
  break proofs routinely. The flake pin makes this a deliberate, reviewable
  event — fix proofs in the same commit that bumps the pin.
- **`#guard` cost.** The oracle is exponential; keep guard instances tiny
  (they run on every `lake build`).
- The parity harness is not yet part of `npm run verify` — wiring it (and a
  `lake build` step) into the verify path is open, pending a decision on
  build-time cost in CI.
