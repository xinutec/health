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
# HSMM scoring factors and structural resolvers

An import surface: it pulls every factor module, and so every `#guard`, into
the default `Verified` build, so `lake build` fails on any divergence. It
defines and asserts nothing (`lean-coverage` reports it so). Factors are exact,
or ≤1 ULP where they use `sin`/`cos`/`atan2`/`log`.
-/
