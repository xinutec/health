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
  `Verified/Rail/Tests.lean`. Theorems next.
- `Main.lean` — `verified_cli`, the JSON bridge.
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
