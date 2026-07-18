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

## What exists

`lean/` is a Lake package pinned by the repo flake (`nix develop` provides
`lean`/`lake` 4.30.0; no elan, no `lean-toolchain` file). Sorry-free policy:
theorems are stated only when proved; goals live in docs. The
module-by-module inventory lives in `lean/README.md` (kept current there,
not duplicated here); the phase status below is the roadmap view.

Integer scores are the deliberate substrate: integers are exact in IEEE
doubles, so TS and Lean agree bit-for-bit and every lemma is provable
without a float model. Floats are bridged by quantising at the tensor
boundary (×2²⁰ — measured lossless on every real day so far), never by
porting float arithmetic.

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
  included) on the test family. **The memoisation is also done**
  (`Memo.lean`): `buildCols` computes the columns once as flat arrays in
  the imperative trellis's exact layout, `buildCols_get` proves every
  cell pointwise equal to `col`, and `decodeFast_eq` (via a `pickBest`
  congruence) transfers `decode`'s theorems verbatim to the
  `O(T·S·(S+maxD))` decoder — `decodeFast_correct`,
  `decodeFast_none_iff`. `verified_cli` now runs `decodeFast`; the
  42-case TS harness agrees exactly at day scale (T=1440 ≈ 180ms of
  compute vs ~13ms for the TS trellis — Score-list allocations per cell;
  optimisable later without touching the theorems). Remaining V1 nicety:
  genericise `Score` so the theorems are parametric over any linearly
  ordered additive monoid with bottom.
- **V2 — real-data shadow. First slice SHIPPED.** `npm run lean-shadow`
  (`src/cli/lean-shadow.ts`): for every golden `decoded_days` fixture,
  `buildHsmmModel` (extracted from `decodeHsmm` so the shadow quantises
  the *very* model production runs) is quantised to ×2²⁰ integer tensors
  — `emit`/`entry` per minute, time-constant `trans` (the tool refuses
  chain-context days rather than shadowing a different model), `dur` as
  an `S×maxD` baseline plus sparse per-`segEnd` overrides (the train-hop
  relaxation; `verified_cli` grew a `durOverrides` input) — and decoded
  by both the TS trellis and the verified Lean decoder, with an
  independent referee. **Result: 12/12 corpus days EXACT** (identical
  paths and best scores, S≈155 × T=1440 × maxD=240), and quantisation is
  lossless on this corpus (float↔quant 100.00% minute agreement, zero
  float-score delta — the near-tie flips the referee design anticipated
  haven't occurred yet). `npm run verify` now runs `lean-check` (lake
  build with its `#guard`s + the seeded parity harness); the shadow tool
  itself needs the local (gitignored) corpus, so it stays a tool like
  `golden-hsmm`. **The day-scale cost is fixed** (was ~23s/3.6GB per
  day): `Ckpt.lean` retains only every `K`-th trellis column and
  re-derives walk-queried columns from the nearest checkpoint
  (`decodeCk_eq` — correct for every stride), and `Packed.lean`
  offset-encodes scores as `Nat` scalars (`v ↦ v + 2^61`, `-∞ ↦ 0`) so
  the forward pass never touches GMP — Lean boxes any `Int` outside
  32 bits, and the model's soft-`-∞` emission penalties (~2^48) made
  nearly every score op a bignum allocation. The packing is *exact*:
  `enc_add`/`enc_max` are proved homomorphisms under a magnitude
  envelope established cell-by-cell (`col_bounded`), and the CLI
  *refuses* inputs outside the envelope (emissions `|v| ≤ 2^49`, other
  tensors `≤ 2^45`, `T ≤ 2048`) rather than decode where the theorem
  doesn't apply. `pDecode` inherits the goal theorems via `pDecode_eq`;
  measured on the heaviest corpus day: **4.4s decode, 87MB peak,
  byte-identical output** (a GMP footnote: Lean re-parses inlined big
  literals from *strings* per call — `@[noinline]` on the offset
  constant was worth 8s/day). **The cron shadow is wired**: the image
  carries `verified_cli` (Dockerfile `lean-build` stage — `nix build
  .#verified-cli` with the flake-pinned toolchain, so the image build
  re-checks every `#guard`; the `/nix/store` runtime closure is copied
  into the alpine stage and `LEAN_CLI` names the binary), and
  `decode-day.js` A/Bs every decoded day through the shared core
  (`src/hmm/lean-shadow-core.ts`), logging a `lean-shadow <date>
  EXACT|MISMATCH|SKIPPED` line with the fidelity metric — purely
  observational, never failing the decode. The cron's C4 flags forced
  two export extensions (probed on the corpus first): chain-context
  transitions deviate on a clean pairs×minutes product (~2.1k of 25k
  pairs), exported as per-pair rows (`transOv`); segment evidence makes
  ~98% of duration cells `segEnd`-dependent, but the delta factorises
  by state class (8 classes measured; partition refined AND verified
  cell-by-cell during export, refusing if it doesn't hold) as
  `durClass`/`durDelta`. With both, the corpus is EXACT under the C4
  flag set too, quantisation still lossless. CI got nix so `verify`'s
  lean-check runs there as well. **Deployed 2026-07-18 and
  soak-verified in production**: a manual decode-recent run on live
  prod data (C4 flags on) logged `lean-shadow <date> EXACT
  float↔quant 100.00% scoreΔ 0` for all 7 window days — including
  days never captured in any fixture. ~50 s/day on the pod, ~6 min per
  nightly window (deadline 1800 s). Remaining V2: UI surfacing (a
  dev-footer badge) once the nightly metric has soaked ~a week.
- **V3 — rail-snap. Boundary probed; pilot in progress.** The measured
  shape (railsnap fixture, real corridor): the built graph is ~22k
  vertices / 55k edges (1–2MB exported, TS Dijkstra 5ms), edge weights
  are nonnegative and ≤ ~2^35 after ×2²⁰ quantisation — they fit Lean's
  unboxed `Nat` scalars natively, so V3 needs no packed encoding — and
  the quantised Dijkstra already returns the *identical* path to the
  float one on every fixture segment. Boundary: TS keeps the float
  heuristics (fix-cloud penalties, gap bridging, vertex dedup, station
  resolution) and exports the finished weighted graph + endpoint
  vertices; Lean owns shortest-path: a faithful port of the TS binary
  heap and Dijkstra loop (for tie parity, same playbook as the trellis
  port) with the goal theorems "the returned path is a valid
  `from`→`to` path attaining the true minimum weight" and "`none` ⟺
  disconnected" — the null-over-wrong contract. Pilot = spec + oracle
  (exhaustive simple-path enumeration) + the port, `#guard`-pinned;
  theorems upgraded incrementally as V1 was.
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
- ~~The parity harness is not yet part of `npm run verify`~~ — wired:
  `npm run lean-check` (lake build + harness) is the last step of
  `verify`. Cost ≈ seconds warm; a cold `lean/.lake` rebuild is ~1–2 min.
