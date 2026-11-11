import Verified.Hsmm.FloatScore
import Verified.Hsmm.Emissions
import Verified.Hsmm.Transitions
import Verified.Hsmm.Duration
import Verified.Hsmm.Quantize
import Verified.Hsmm.Entry
import Verified.Hsmm.Geometric
import Verified.Hsmm.LineProximity
import Verified.Hsmm.ChainContext
import Verified.Hsmm.SegmentEvidence
import Verified.Hsmm.TrainHopDuration
import Verified.Hsmm.StateSpace
import Verified.Hsmm.Observation
import Verified.Hsmm.GpsOutliers
import Verified.Hsmm.RouteGraph
import Verified.Hsmm.RouteConnectivity
import Verified.Hsmm.RouteModel
import Verified.Hsmm.Continuity
import Verified.Hsmm.EmissionFull
import Verified.Hsmm.TrainWindows
import Verified.Hsmm.TrainCandidates
import Verified.Hsmm.Assembly
import Verified.Hsmm.Assemble
/-!
# HSMM port aggregator (scoring factors + structural resolvers)

The HSMM's scoring-factor kernels and structural resolvers (state-space
enumeration, …), each pinned by `#guard`s. Importing them here pulls every
module, and so every guard, into the default `Verified` library build, so
`lake build` fails on any divergence; the guards are worthless if they never
run.

This file itself defines nothing and asserts nothing — it is an import surface,
and `lean-coverage` reports it as one. A checker that credited it would be
crediting the imports below, which are counted in their own right.

These compute in Lean `Float` (exactly for `sqrt`/arithmetic/discrete factors;
≤1 ULP where a factor uses `sin`/`cos`/`atan2`/`log`).
-/
