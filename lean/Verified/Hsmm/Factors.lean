import Verified.Hsmm.FloatScore
import Verified.Hsmm.Emissions
import Verified.Hsmm.Transitions
import Verified.Hsmm.Duration
import Verified.Hsmm.Quantize
import Verified.Hsmm.Entry
import Verified.Hsmm.Geometric
import Verified.Hsmm.LineProximity
import Verified.Hsmm.RouteRail
import Verified.Hsmm.ChainContext
import Verified.Hsmm.SegmentEvidence
import Verified.Hsmm.TrainGenerator
import Verified.Hsmm.TrainHopDuration
/-!
# HSMM scoring-factor ports (aggregator)

The Lean-Float re-implementations of the TypeScript HSMM scoring factors, each
pinned to V8 by `#guard` parity checks. Importing them here pulls every module
(and therefore every guard) into the default `Verified` library build, so
`npm run verify` (`lake build`) fails on any TS↔Lean scoring divergence — the
guards are worthless if they never run.

Implementation-first: these compute in Lean `Float` to match TS bit-for-bit
(exactly, for `sqrt`/arithmetic/discrete factors; ≤1-ULP where a factor uses
`sin`/`cos`/`atan2`/`log`). The fixed-point / theorem layer lands later; see
`docs/proposals/2026-07-verified-core-lean.md`.
-/
