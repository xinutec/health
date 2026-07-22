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
- **V3 — rail-snap. Shortest path PROVED (certified); parity SHIPPED.**
  The measured
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
  disconnected" — the null-over-wrong contract. The pilot (spec + oracle
  (exhaustive simple-path enumeration) + the port, `#guard`-pinned over
  seeded random multigraphs and degenerate shapes) is done, and so is
  the real-data harness: `npm run compare-rail` rebuilds each fixture
  train segment's production graph, quantises, and runs TS-float,
  TS-quantised, and `verified_cli rail` on it — **every fixture
  comparison EXACT (both directions per segment), float↔quant
  path-identical throughout**. **The goal theorems are proved** — by
  *certification* rather than heap/fuel algorithm invariants
  (`Certify.lean`): the untrusted search's final `done`/`dist` arrays
  plus its rebuilt path form a certificate a proved O(E) checker
  validates (valid simple path costing exactly the settled distance,
  and a feasible-cut condition: every edge out of a settled vertex
  either doesn't shortcut the settled set or crosses out at cost ≥ D),
  and `cut_bound` shows a passing certificate forces D to be the true
  minimum — no reasoning about the search at all. `dijkstraC` (which
  `verified_cli rail` now runs, and `compare-rail` re-verified EXACT
  through) carries `dijkstraC_correct` — any returned path is a valid
  `src → dst` path attaining `oracleDist` — and
  `dijkstraC_disconnected`; a certification failure degrades to `none`
  (draw raw GPS), never a wrong line, which is exactly rail-snap's
  swallow-over-wrong contract. **The completeness direction is now
  proved too** (`HeapInv.lean` + `LoopInv.lean`): the ported binary
  heap's invariants (sift-up/sift-down repair, pop-min), the classical
  loop invariants (lazy deletion, monotone pop floor, unsettled-finite
  vertices hold live heap entries, a ghost prev-tree ranked by settle
  order), and a potential argument showing the TS fuel `E + n + 2`
  never exhausts, give `dijkstraC_eq_dijkstra` (the checker never
  fires on a real run), `dijkstra_complete`, and `dijkstra_none_iff`
  (`none ⟺ disconnected`) — under `WFEdges` (in-range adjacency
  targets, true of production graphs by construction; `relaxAll`
  silently drops out-of-range targets, so it is a real hypothesis).
  The `Tests.lean` guard and `compare-rail` stay as smoke tests. The
  snap contract layer
  above the search (label parsing, station resolution, refusal gates,
  time interpolation) **stays in TS for now — deferred, not exempted**.
  The principle: port a component when Lean can own its *meaning*, not
  just mimic its bytes. The float geometry (centroids, nearest-vertex,
  interpolation, gate thresholds) waits for the V4 arithmetic substrate
  — integer micro-degree coordinates or Mathlib ℝ with explicit
  ε-budgets — at which point the gates become verified postconditions
  for free. Label parsing waits for an *authority flip*: porting
  `parseRailWayName` today would mean bit-matching JS UTF-16 string
  semantics on unicode-bearing labels (the ` → ` separator itself) —
  verifying against the wrong spec. Instead the Lean core will
  eventually define the label grammar and both generate and parse it,
  making TS the conforming side. Everything here graduates into the
  core on the V4/V5 arc; nothing is permanently TS except effects.
- **V4 — map-match-core + geometry substrate. UNBLOCKED 2026-07-18;
  matcher confirmed the PERMANENT draw 2026-07-20.**
  The #330 gate rendered the same verdict a third time (07-08, 07-15,
  07-20) and #330 was RESCOPED (geometry-roadmap G2): recon-primary loses
  the ordinary-leg class corpus-wide on a routing gap, so matcher-primary +
  recon-on-confirmed-smears is the intended architecture, not a way-station.
  trim/despike/correctWalkPath + the Viterbi matcher + `map-match-core` are
  therefore the PERMANENT walk draw — a stable port target whose ownership by
  the verified core is now doubly motivated (it ships indefinitely AND its
  semantics are theorem-pinned). Agreed sequencing (2026-07-18, coordinated
  with the decoder session):
  - *Portable now*: the geometry substrate (haversine/projection/
    polyline/grid primitives, rail-snap internals) and the GPS
    pre-filters (outlier drop, spike rejection, speed caps — stable,
    pure, small). Substrate first — it is where the ε-budget/quantised
    arithmetic decision gets made, and everything else consumes it.
  - *Walk/road matcher*: **green as of 2026-07-19** — #369 (matched
    polyline too sparse) fixed by `spliceRouteDetail` (38001cf: decisions
    stay on the tuned coarse line, only the drawn line re-inserts route
    vertices where the route deviates 1.5–5 m from a chord — the bounds
    come from the Douglas-Peucker guarantee, not tuning) and #347
    (correctWalkPath invents distance) fixed by the whole-leg step-budget
    invariant (a844d2f: a correction may not push a leg from within the
    pedometer bar to beyond it, else the leg's corrections revert
    wholesale, mirroring the badness invariant-revert). The port target
    is settled intended behaviour: `matchTrajectory` + `matchWalkSegment`
    with the path/coarsePath contract, `spliceRouteDetail` as the
    display-fidelity pass, and the corrector carrying both honesty
    invariants. The `velocity.ts` cascade stays non-port on its own merits
    (Phase 5 deletes it as the decoder absorbs it), and `correctWalkPath`
    is simply not yet a port priority — neither now leans on #330, which is
    RESCOPED: the matcher draw (corrector included) is permanent, so the
    corrector only becomes MORE port-worthy over time, not less. What stays
    in TS no longer lies about distance.
  - *Shadow only (moving target)*: the HSMM decoder — C4.4/#364/#366/
    Phase 4-5 keep reshaping it; the cron shadow tracks it instead of
    freezing it. Full ownership waits for the C4 program to settle.
  - *Don't port (scheduled to die)*: the ~38-pass `velocity.ts` cascade
    and the boarding/alight anchors (Phase 5 deletes them as the decoder
    absorbs their wins); the bus matcher (#254/#255/#328) and the
    venue/place scorer cluster (#341/#343/#344/#345) — actively
    contested, verdicts pending.
  **The three load-bearing comment-proofs are theorems**
  (`lean/Verified/Geo/`): `cellKey` collision-freedom + double-exactness
  (`CellKey.lean`); `SegmentNearGrid` ring-search exactness
  (`RingSearch.lean` — order-theoretic: the geometric chain
  (rasterisation ≤ cell/2, in-cell offset, cos drift) is the named
  hypothesis `hgeom` for the future analytic substrate to discharge,
  the early-stop search logic is proved exact against it); and the
  lazy-Dijkstra refinement (`LazyDijkstra.lean` — the search is a
  deterministic target-free step sequence, so `settle` is exactly the
  eager run-to-break prefix, and settles commute/idempote, making the
  per-source memoised cache sound). **Both former `#guard` pins are now
  theorems** (2026-07-19): the classic "settled = final" fact
  (`LazyInv.lean` — a slim cut of the rail `LoopInv` bundle: lazy
  deletion, monotone pop floor, settled-prices-below-the-floor; a done
  vertex's price is `≤` every later popped price, so no relaxation can
  beat it — `settled_final`/`settled_final_settle` under `WFEdges`),
  and fuel sufficiency (`LazyFuel.lean` — the rail potential argument
  ported: `heap size + Σ undone out-degrees` strictly decreases at
  every live step, so any fuel ≥ `E + 1` stops, from the initial state
  and through any interleaving of memoised settles —
  `lsettle_stops`/`all_settles_stop`). No hypothesis about the lazy
  search remains unproved; the `#guard`s stay as smoke tests.
  **The display-pass layer is PROVED, metric-parametrically**
  (2026-07-19, `lean/Verified/Geo/{Simplify,Splice,Prefilter}.lean`).
  The probe found the clean seam: every display pass is purely
  combinatorial over two primitives (point↔point and point↔chord
  distance), so the pass logic ports with the metric as a parameter and
  its theorems need no arithmetic substrate and no metric axioms at
  all. Landed: `simplifyPath`'s Douglas-Peucker recursion with
  `simplifyIdx_dropped_le` (every dropped vertex within tolerance of
  the retained chord spanning it — the exact bound #369's fix cites);
  `spliceRouteDetail` with `splice_sound` (every output vertex is a
  coarse vertex or a timestamp-clamped route vertex within `dropM` of
  its chord, so `> dropM` excision windows insert nothing) and
  `splice_coarse_sublist` (the decision layers keep consuming exactly
  the tuned coarse geometry); the pre-filters `holdImplausibleSpeed`
  (with the kinematic honesty invariant as a theorem: no adjacent
  output pair violates the plausibility predicate) and `rejectSpikes`
  (both drop-only subsequences, endpoints kept).
  **The arithmetic representation is PINNED by corpus probe**
  (2026-07-19, `lean/experiments/quant-probe.mjs` — 173 walking legs
  across all 31 golden days, integer twin vs float per candidate
  scale/cos): coordinates as **1e-7° integers** (OSM-native, ~11 mm),
  distances in **µm via integer floor-sqrt**, equirectangular with a
  **Q20 fixed-point degree-6 minimax cos** evaluated by integer
  Horner, round-to-nearest foot projection; ratio thresholds and the
  `acos` turn test become exact cross-multiplied integer comparisons.
  Measured against float: max |Δdist| 38 mm / mean 0.24 mm (1.65 mm
  max under an ideally-rounded cos — the Q20 poly is not the binding
  constraint), and **zero keep-set flips** on simplify-5 m, the
  12 km/h speed hold, and spike rejection; exactly 1/173 legs flips
  simplify-1.5 m — a near-threshold tie on the display-only detail
  tolerance, the documented tie class the harness referee reports
  rather than fails on (the lean-shadow near-tie design). Coarser
  scales lose: µ-degrees flips 35/173 legs at 1.5 m.
  **The substrate is SHIPPED end-to-end** (2026-07-19):
  `Verified/Geo/Metric.lean` implements the pinned primitives (with
  division semantics — `Int.fdiv` ↔ BigInt `>>`, `Int.tdiv` ↔ BigInt
  `/` — as an explicit part of the twin contract) and instantiates the
  pass layer, so the pass theorems specialise to the real metric for
  free; `verified_cli geo` exposes the passes over quantised points;
  `src/geo/quant-twin.ts` is the BigInt twin; and `npm run
  compare-geo` replays every golden walking leg through all three
  arms — **173/173 legs bit-EXACT quant↔Lean on every pass, float↔
  quant flips zero except the one probed near-tie** (simplify-1.5 m,
  display-only).
  **The display-pass layer is COMPLETE** (same day): `Clean.lean`
  (dedupe with the no-adjacent-near chain theorem; `removeSpurs` as
  recursion over the mutated suffix, farthest return winning; despike
  as a pure indexed filter against original neighbours) and
  `Trim.lean` (`trimOverRouteExcursions` — `corridorPositions`'
  monotone-floor projections, both excision passes, ratio thresholds
  as exact cross-multiplied rationals) — all proved drop-only,
  instantiated over the metric (`qPerp`; the ≥140° turn test as an
  exact squared comparison, `round(cos²140°·10⁹)` pinned; `qArcPos`),
  exposed via `verified_cli geo`, twinned, and harnessed: **all 8
  passes 173/173 legs bit-EXACT quant↔Lean**; float↔quant flips are
  the simplify-1.5 near-tie plus two trim divergences (2/173 —
  trim's threshold count widens the tie class; display-only, gate
  unaffected).
  **The MATCHER twin is BUILT and MEASURED** (2026-07-19,
  `src/geo/match-twin.ts` + `npm run compare-match`): the full
  `matchTrajectory`/`matchWalkSegment` pipeline in the pinned integer
  semantics — graph build with 1e-7° vertex keys (`vertexDp: 7` makes
  the float `toFixed(7)` key the same grid), gap bridging, corridor
  ramp weights scaled exactly by `S = far − near`, building penalty
  with grid-quantised 3 m samples and cross-multiplied ray casts,
  candidates by spec-form scan (the float grids are exact-conservative
  by their own arguments), BigInt lazy Dijkstra, and the Viterbi with
  scores scaled exactly by `2σ²β` (emission `−d²β`, transition
  `−|Δ|·2σ²`). Measured over the same 173 golden walking legs:
  **decision layer (`coarsePath`) 165 EXACT / 5 NEAR (≤30 cm drift,
  same decisions) / 3 DIFF; null-gate 100% agreement** (7 both-null,
  0 flips). The 3 decision flips are route-choice near-ties — the
  diagnosed one flips a single 25× building-penalty edge sample
  in/out of a ring, a discrete class inherent to sampling quantised
  positions; the 11 path-level DIFFs are dominated by sub-tolerance
  route variation the 5 m simplify hides from `coarsePath` and the
  detail splice re-surfaces. `qSpliceRouteDetail` (the splice twin)
  rode in as planned.
  **The matcher Lean port is LANDED and bit-exact-gated** (2026-07-20):
  `Match.lean` implements `qMatchTrajectory`/`qMatchWalkSegment` (the
  Lean twin of `match-twin.ts`), reusing the fully-proved `LazyDijkstra`
  machinery for routing and running the proved `MatchViterbi.decodeFast`
  for the trellis; `verified_cli match` A/Bs every golden walking leg
  against the BigInt twin and `npm run compare-match` **gates at
  173/173 quant↔Lean EXACT**, with the same per-leg A/B wired as a live
  nightly prod shadow (`decode-day` walk-shadow, LEAN_CLI-gated). So the
  matcher now *ships* Lean-decoded results bit-for-bit and is
  theorem-backed at its two hardest stages (route purity
  `qRouteBetween_route_pure`; Viterbi argmax `decode_argmax` /
  `decode_none_iff`).
  **Routing-optimality — the meaning layer — is now in progress.** The
  matcher's routing is proved *pure* and *resume-stable*, but not yet
  *optimal* (the rail analogue is `dijkstraC_correct`). Two bricks:
  - *Valid-path half — LANDED* (`Verified/Geo/LazyEdge.lean` +
    `Match.lean`, 2026-07-20): `EInv` — the prev-**edge provenance**
    invariant `LazyInv`/`LazyPrev` deliberately cut — proves every `prev`
    link is a real graph edge (`prev[v]=u≠sentinel → (v,w) ∈ g.adj[u]`),
    carried along the whole search trajectory (`iter_einv`, from
    `linit_einv`; needs no `LInv`/`done`/`WFEdges`). This lifts to the
    whole route over the **shared `Verified.Rail.Graph` spec**
    (`pathCost`/`isValidPath`/`oracleDist`, the same one
    `dijkstraC_correct` uses): `chainList_reverse_pathCost_isSome` +
    the `reconGo = chainList` bridge give **`qReconstruct_pathCost_isSome`
    / `_iter`** — under `EInv`, from any seed below the sentinel, the
    reconstructed route has a *defined* `pathCost`, i.e. every step is a
    genuine edge and the matcher's route is a real costed walk of `g`
    (the `isValidPath` positive half of null-over-wrong). Proof is
    reverse-free (accumulator-free `chainList` + a `pathCost` snoc lemma),
    Mathlib-free.
  - *Weight-optimality half — keystone LANDED* (`Verified/Geo/LazyLive.lean`,
    2026-07-20): `HInv`, the **live-heap-entry** invariant `LazyInv` omits —
    every unsettled vertex with a defined `dist` holds a heap entry *at* that
    `dist` (`push` maintains it, `pop_cover` shows only the popped top leaves).
    Carried along the trajectory (`iter_hinv` from `linit_hinv`). Payoff
    `settle_price`: when `lstep` settles `u`, it pops it at price = `dist[u]`
    (a smaller live entry would have popped first — `HInv` + `pop_min`; bounded
    below by `LazyInv.wf`). This is the fact the whole value theorem rests on —
    the search settles each vertex at exactly the distance the relaxations
    recorded. Native to the lazy machine (the rail `dijkstra_complete` is on the
    rail `DState`) but reuses the shared `HeapInv` lemmas over the shared
    `Heap`. Native to the lazy machine (the rail `dijkstra_complete` is on the
    rail `DState`) but reuses the shared `HeapInv` lemmas over the shared `Heap`.
  - *Weight-optimality value half — LANDED* (`Verified/Geo/LazyUpper.lean` +
    `LazyWeight.lean`, 2026-07-20): `pathCost(route) = dist[tgt]`. Two coupled
    invariants bound each settled step from both sides. `UInv` (upper): every
    edge `(v,w)` out of a done, within-radius `u` has `dist[v] ≤ dist[u]+w` —
    "relaxation reached everyone"; the `dist[u] ≤ maxR` gate excludes the single
    radius-exhausted vertex (settled unrelaxed, never a `prev`). `WInv` (lower):
    the recorded provenance `dist[v] = dist[prev[v]]+w` with `w` a real edge
    (`settle_price` makes the written `p` equal `dist[prev[v]]`). Combined —
    `edgeMinW ≤ w` (`WInv`) and `dist[v] ≤ dist[u]+edgeMinW` (`UInv` at the
    min-realising edge) — pin each step to its cheapest edge: `done_dist_step`,
    `dist[v] = dist[prev[v]]+edgeMinW(prev[v],v)`. Telescoped over `chainList`
    (`PInv` keeps the chain inside done vertices; `SInv` anchors `dist[src]=0`)
    → `chainList_pathCost_eq` / `iter_route_pathCost_eq` /
    `qReconstruct_pathCost_eq_iter`: the matcher's reconstructed route costs
    *exactly* the search's own `dist[tgt]`, in the shared `Rail.Graph` spec.
  - *Weight-optimality lower bound — LANDED* (`Verified/Geo/LazyLower.lean`,
    2026-07-20): `dist[tgt] ≤ pathCost(p)` for every valid `src → tgt` path. The
    feasible-cut walk (rail `Certify.cut_bound`), made radius-honest: rail reuses
    `feasibleCut` over the bare `done`/`dist` arrays, but the lazy machine has
    settled-*unrelaxed* exhaust vertices (`dist > maxR`) that falsify it.
    `cut_walk` instead threads `du ≤ prefix-cost` and branches on `du ≤ maxR` —
    within the radius `UInv` supplies the no-shortcut step; a settled vertex
    *beyond* it short-circuits (`D ≤ maxR < du ≤ du+C`). Honest precondition:
    `D ≤ maxR` (the bound is claimed only inside the searched radius). The
    "nothing cheaper still unsettled" fact is not an assumption — `nocheap_of_inv`
    reads it off the existing invariants (unsettled finite ⇒ live heap entry
    (`HInv`) priced `≥ L` (`LInv.ge`); settled target priced `≤ L` (`LInv.dle`);
    so `D ≤ L ≤ dv`). `iter_route_optimal` ties both halves: the reconstructed
    route is a *minimum-cost* path.
    *Remaining:* discharge `done[src]` (source settled) and bridge the bound to
    `= oracleDist` via the enumeration lemmas (`enum_sound`/`enum_complete`,
    reusable as-is over the bare graph) — the search's answer is *the* shortest.
  Then `RingSearch.lean`'s `hgeom` discharge — reclassified, honestly, as
  its own project: it needs the **analytic (error-bound) substrate** the
  shipped *integer* substrate does NOT provide — a proved Lipschitz/error
  bound on `cosQ` (today only `#guard`-pinned pointwise), a
  segment-sampling-density lemma (rasteriser step ≤ cell/2), and the
  equirectangular cos-drift bound (the "0.25·cell margin" in the
  `SegmentNearGrid` comment). That is real ε-budget analysis (Mathlib ℝ
  or a heavy integer interval-arithmetic build), the port's long pole,
  not a near-term slice.
- **V5 — the shell.** As the decoder-roadmap folds passes into the decoder,
  the Lean core absorbs them; when the TS remnant is small, choose the
  permanent shell (thin TS as-is, or Rust linking the Lean core in-process).

  **Request-path execution substrate — LANDED (2026-07-20).** The prerequisite
  for the Lean core to *execute* (not just check) on the request path: an
  in-process synchronous bridge. `verified_cli serve` is a persistent NDJSON
  request loop (geo/match/rail/hsmm handlers refactored to pure `Json → Json`).
  `src/lean/lean-core.ts` drives it — a `worker_thread` owns the long-lived
  child and does async pipe I/O; the caller blocks on `Atomics.wait` over a
  `SharedArrayBuffer` and reads the response out, so the synchronous pass call
  sites stay synchronous. **0.28 ms/call** (500 sequential), any failure →
  `LeanBridgeError` → TS fallback. Inputs are the pinned 1e-7° integers, so the
  bridge output is exactly the `compare-geo` referee's: `compare-geo --bridge`
  runs all 173 golden legs through the worker, **173/173 EXACT**.

  **Serving tenants — FIVE proved geometry passes (2026-07-20).**
  `src/lean/lean-passes.ts` runs the verified passes behind `LEAN_PASSES`
  (off/shadow/on): `rejectSpikes` (episode-geometry), and — via a
  dependency-injection hook that keeps the import-free `map-match-core.ts`
  clean — `simplify` + `removeSpurs` (matched-path assembly) and `trim` +
  `despike` (pedestrian-match). One corpus replay drives **739 verified Lean
  calls** (simplify 185 / spurs 183 / trim 166 / despike 166 / spikes 39).
  **Golden is 31/31 byte-identical both flag-off AND under `LEAN_PASSES=on`** —
  serving the verified geometry changes no final output. The only divergences
  the corpus measures are 2 accepted Douglas-Peucker single-vertex near-ties on
  simplify (`src/lean/accepted-deltas.ts`), which wash out downstream. The
  manifest carries a third entry observed by the production ledger on a day the
  corpus does not cover — see the soak note below.

  **Honest flip gate.** `shadow` and `on` take the SAME measurements
  (calls / bridge-failures / divergences); a green `on` run therefore *proves*
  the bridge served every call rather than silently falling back to TS. The
  gate (`npm run shadow-passes [--on]`) is RED unless coverage > 0 AND
  failures == 0 AND every divergence is in the accepted manifest — closing the
  earlier false-CLEAN bug where a dead bridge read as ready-to-flip.

  **Flipped and soaking (2026-07-22).** `LEAN_PASSES=on` is live on both
  workloads, so the gate is no longer the only adjudicator — and it never could
  be for the days that matter, since it replays `tests/golden/days` (corpus
  ending 2026-07-16) while the decode cron runs the trailing 7 days. Two gaps
  that opened once production started serving, both now closed:

  - The production ledger printed divergences without checking them against the
    manifest, so a signed-off near-tie and a real behaviour change read alike.
    It now adjudicates through the same `unexplainedDeltas` the gate uses.
  - The per-day tally summed every velocity run, including the extra one
    `runWalkShadow` makes purely to extract legs. Calls now carry a scope
    (`decode` = persisted/served, `shadow` = observational), so the line reads
    `[all ops by run: decode … · shadow …]` and flags `IN SERVED OUTPUT` only
    when the decode itself diverged.

  The one divergence the soak has produced (2026-07-17, simplify n=115) is a DP
  argmax tie: float separates the candidate vertices by 3.77 mm, both quantise
  to exactly 7063019 µm — under the 1e-7° representation's resolving power, so
  the served metric cannot order them. It arises in the `shadow` scope, not in
  served output. Still open: nothing *alerts* on an unexplained divergence; it
  is labelled in the log and depends on someone reading it.

  **The matcher gate judges a different leg population than production serves
  (measured 2026-07-22, OPEN).** The same scope split applied to the matcher
  ledger — `lean-match[on] 2026-07-17 18/0f [by run: decode 9/… · shadow 9/…]`
  — but adjudication could NOT follow the passes' fix, and the reason is
  structural rather than mechanical. `accepted-match-deltas.ts` is keyed by
  golden day + leg start `hh:mm`, and that key does not exist at the matcher
  call site: episode `startTs` comes from HSMM *states*, and `buildEpisodes`
  runs *after* `annotateWalkMatches`. Re-keying on an intrinsic leg fingerprint
  would fix the key but not the premise, because the two sides do not window
  the same legs. `extractWalkLegs` (the gate and `walk-shadow`) differs from
  `annotateWalkMatches` (production) in four ways:

  1. it iterates HSMM **episodes**, production iterates **enriched segments**;
  2. it reads the **raw** `phonetrack.today` track, production reads the
     GPS-quality-cleaned `displayFixes`;
  3. production drops fixes above `WALK_SPEED_CAP_KMH`, the gate does not;
  4. the minimum leg size is **3** in the gate, `MIN_LEG_FIXES = 4` in
     production.

  Measured in one process on 2026-07-17: `walk-shadow` extracted **8** legs
  (float↔quant coarse 8/0/0 — a clean day) while the production matcher ran
  **9**, of which 2 diverged on the display path and reached served output.
  So a clean gate does not imply a clean production run, and the 173-leg
  corpus figure is a count over the gate's population, not the served one.
  This is the `feedback_parity_tools_must_mirror_env` failure mode in the
  matcher's verification layer.

  The divergences themselves remain display-only — `walkMatchedPath` feeds no
  decision — so this is a gap in the *evidence*, not a known wrong output. The
  fix is to make `extractWalkLegs` mirror `annotateWalkMatches`, which changes
  the corpus leg population and therefore re-derives both the 173-leg figure
  and the accepted manifest: a deliberate re-opening of the flip's evidence
  base, not a mechanical edit. Until then the matcher ledger reports counts and
  scope but deliberately renders **no accepted/UNEXPLAINED verdict**, because a
  verdict from a manifest that cannot cover the served population would read as
  authority it does not have.

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
