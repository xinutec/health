import Verified.Hsmm.Emissions
import Verified.Hsmm.Observation
import Verified.Hsmm.Geometric
import Verified.Hsmm.RouteModel
import Verified.Hsmm.Continuity
import Verified.FloatConst
/-!
# Full HSMM emission composition (implementation-first port of `buildHsmmModel`'s emission)

`emission = baseEmission + geometricFn + routeRailFn + lineProximityFn`, summed
in `buildHsmmModel` order, over the unified route-graph model and the real
observation tensor (`ObsRow`). This is the keystone that proves the ported factors
compose end-to-end: base emission (+ the reacquire-robust speed correction),
geometric feasibility, and the two route-graph factors all consume one `ObsRow`
and the shared model.

Mirrors `buildHsmmModel`'s parameterisation, so it is faithful to the served
decode. The
TypeScript also passed the generator's per-minute `isCovered` here and switched
the two line factors OFF on a covered minute, leaving the entry prior as the
only line signal. Since 2026-09-29 (#238) the factors stay live there: measured
on the eleven decoder days, a covered fix-less ride earned nothing per minute
and lost to `stationary` on the mode prior (06-12's Victoria ride shrank to one
minute), and every line the generator vouched at entry scored identically
afterwards, so a line it stopped vouching mid-ride was never charged (05-18,
07-14: the Metropolitan leg came out Hammersmith & City on a tie). Coverage
still reaches the entry and duration terms. Continuity (`continuityContext`) is a further optional additive
term, ported only if the served path enables it. UNPROVEN; pinned by the `#guard`s
(values from Node/V8's factor builders, summed as `buildHsmmModel` does). Route-
graph/geometric factors flow through `haversine`/`pointToPolyline`, so sums are
ULP-close (`approx`), the accepted near-tie class.
-/

namespace Verified.Hsmm.EmissionFull

open Verified.Hsmm.Emissions (Mode State modePriors emissionLogProb Observation)
open Verified.Hsmm.Observation (ObsRow Fix)
open Verified.Hsmm.RouteModel (RouteGraphModel routeRailEvidence lineProximityFactor buildRouteGraphModel
  toConnGraph linesInGraph RouteEdge)
open Verified.Hsmm.FloatScore (logNormalPdf)

/-- Adapt an `ObsRow` fix to `Geometric.GpsFix` (ts Int→Float; unix seconds fit
    a Float exactly, and both obs/fix ts convert the same way so deltas hold). -/
private def toGeoFix (f : Fix) : Geometric.GpsFix := ⟨f.ts.toNat.toFloat, f.lat, f.lon⟩

/-- `ObsRow` → the thin `Observation` the base emission consumes. -/
def toThin (o : ObsRow) : Observation :=
  ⟨o.gps.map (fun g => ⟨g.lat, g.lon, g.speedKmh⟩), o.hr, o.cadence, o.inBed⟩

/-- One weight per family of decoder terms (`flags.termWeights` sets them for
    the harness, `examples/tune_weights` learns them). A product by `1.0` is
    exact, so a family at `1` sums exactly as before it had a weight. -/
structure TermWeights where
  base : Float := 1.0
  geometric : Float := 1.0
  gap : Float := 1.0
  rail : Float := 1.0
  /-- Learned: a coordinate search on half the 43 narrated days moved it to
      0.75 and nothing else, and on the other half it scored leg modes +2,
      lines +1, stations +1, phantoms unchanged; on all 43, leg modes 278 → 280,
      lines 52 → 53, stations 43 → 45, journeys and phantoms unchanged. The
      search on the first half also went down (0.375, with the duration prior
      at 0.75) and gained nothing on the second. -/
  lineProximity : Float := 0.75
  continuity : Float := 1.0
  entry : Float := 1.0
  chain : Float := 1.0
  duration : Float := 1.0
  deriving Inhabited

/-- Every term of `emissionLogProbFullWith` but the base: what a minute pays
    beside its base emission, whichever form that base takes. -/
def emissionRestWith
    (modeledLines : List String) (minute : RouteModel.MinuteLines) (railEv : Float)
    (placeCoords : Std.HashMap Int (Float × Float))
    (continuity : Option Continuity.ContinuityContext)
    (s : State) (o : ObsRow) (priors : Mode → Emissions.ModePrior := modePriors)
    (w : TermWeights := {}) : Float :=
  let placeCoord := match s.placeId with | some pid => placeCoords.get? pid | none => none
  w.geometric * Geometric.geometricFeasibility s (Verified.FloatConst.natToFloat o.ts.toNat)
        (o.prevGpsFix.map toGeoFix) (o.nextGpsFix.map toGeoFix) placeCoord priors
    + w.gap * Geometric.gapTerm s o.gps.isSome
        (o.prevGpsFix.map toGeoFix) (o.nextGpsFix.map toGeoFix) priors
    -- The kernels' `isCovered` is the TypeScript gate, held open (see above).
    + w.rail * railEv
    + w.lineProximity * RouteModel.lineProximityFactorWith modeledLines minute s o false
    + w.continuity * Continuity.continuityLogLikelihood s o.gps.isSome
        (o.prevGpsFix.map (fun f => (f.lat, f.lon))) continuity

/-- Full per-cell emission log-probability over the model — the TS
    `buildEmissionFn` closure plus the geometric/rail/line-proximity terms the
    model sums onto it. `placeCoords` resolves `s.placeId`. `continuity` is
    the presence-continuity seed; the
    production caller always supplies it, and the `none` arm is the chain-start
    and test shape rather than a flag being off (see `Continuity`). -/
def emissionLogProbFullWith
    (modeledLines : List String) (minute : RouteModel.MinuteLines) (railEv : Float)
    (placeCoords : Std.HashMap Int (Float × Float))
    (continuity : Option Continuity.ContinuityContext)
    (s : State) (o : ObsRow) (priors : Mode → Emissions.ModePrior := modePriors)
    (w : TermWeights := {}) : Float :=
  let placeCoord := match s.placeId with | some pid => placeCoords.get? pid | none => none
  w.base * emissionLogProb s (toThin o) placeCoord priors
    + emissionRestWith modeledLines minute railEv placeCoords continuity s o priors w

/-- The per-cell emission with its per-minute facts computed in place — what
    every caller read before #1774 hoisted them, and what the parity guards pin.
    The model build computes `minuteLines` once per minute and the rail
    evidence once per bracketing pair, then calls `emissionLogProbFullWith`. -/
def emissionLogProbFull
    (model : RouteGraphModel) (connGraph : RouteConnectivity.Graph) (modeledLines : List String)
    (placeCoords : Std.HashMap Int (Float × Float))
    (continuity : Option Continuity.ContinuityContext)
    (s : State) (o : ObsRow) : Float :=
  emissionLogProbFullWith modeledLines (RouteModel.minuteLines model o)
    (routeRailEvidence model connGraph s o false) placeCoords continuity s o

-- Parity with `buildHsmmModel`'s emission (base+geo+routeRail+lineProx; Node/V8).
private def m : RouteGraphModel := buildRouteGraphModel #[
  (⟨"way:1", [⟨51.50, -0.10⟩, ⟨51.525, -0.075⟩], ["Test Line"], true, "nA", "nMid"⟩ : RouteEdge),
  (⟨"way:2", [⟨51.525, -0.075⟩, ⟨51.55, -0.05⟩], ["Test Line"], true, "nMid", "nB"⟩ : RouteEdge)]
private def cg : RouteConnectivity.Graph := toConnGraph m
private def ml : List String := linesInGraph m
private def pc : Std.HashMap Int (Float × Float) := ({} : Std.HashMap Int (Float × Float)).insert 5 (51.52, -0.13)
private def approxF (a b : Float) : Bool := Float.abs (a - b) < 1e-6

private def obsTrain : ObsRow :=
  { ts := 1600, gps := none, hr := none, cadence := none, hourLocal := 0, dayOfWeekLocal := 0,
    inBed := false, roadDistM := none, railDistM := none, prevGpsFix := some ⟨1000, 51.50, -0.10⟩, nextGpsFix := some ⟨1600, 51.55, -0.05⟩ }
private def obsStat : ObsRow :=
  { ts := 1000, gps := some ⟨51.5201, -0.1301, 0, none⟩, hr := some 70, cadence := some 0, hourLocal := 0,
    dayOfWeekLocal := 0, inBed := false, roadDistM := none, railDistM := none, prevGpsFix := some ⟨940, 51.60, -0.30⟩, nextGpsFix := some ⟨1000, 51.5201, -0.1301⟩ }
private def obsWalk : ObsRow :=
  { ts := 1000, gps := some ⟨51.53, -0.12, 5, none⟩, hr := some 100, cadence := some 100, hourLocal := 0,
    dayOfWeekLocal := 0, inBed := false, roadDistM := none, railDistM := none, prevGpsFix := none, nextGpsFix := none }
-- Stationary no-fix minute whose most-recent fix is near the prior place → continuity fires.
private def contCtx : Continuity.ContinuityContext := ⟨some 5, some (51.52, -0.13), 3, 0.95⟩
private def obsCont : ObsRow :=
  { ts := 1000, gps := none, hr := none, cadence := none, hourLocal := 0, dayOfWeekLocal := 0,
    inBed := false, roadDistM := none, railDistM := none, prevGpsFix := some ⟨900, 51.521, -0.131⟩, nextGpsFix := some ⟨900, 51.521, -0.131⟩ }

-- The train pays its share of a 40 km/h gap, which its speed prior almost always covers.
#guard approxF (emissionLogProbFull m cg ml pc none ⟨.train, none, some "Test Line"⟩ obsTrain)
  (1.6028800151141191 + Geometric.gapTerm ⟨.train, none, some "Test Line"⟩ false
    (obsTrain.prevGpsFix.map toGeoFix) (obsTrain.nextGpsFix.map toGeoFix))
#guard Geometric.gapTerm ⟨.train, none, some "Test Line"⟩ false
    (obsTrain.prevGpsFix.map toGeoFix) (obsTrain.nextGpsFix.map toGeoFix) > -0.05
-- 14 km in the minute before (840 km/h): beyond every ground mode, the
-- mainline's tail included, and no outlier explains 14 km.
#guard approxF (emissionLogProbFull m cg ml pc none ⟨.stationary, some 5, none⟩ obsStat) (-73.73917387697927)
#guard approxF (emissionLogProbFull m cg ml pc none ⟨.walking, none, none⟩ obsWalk) (-9.87838310248148)
#guard approxF (emissionLogProbFull m cg ml pc (some contCtx) ⟨.stationary, some 5, none⟩ obsCont) (-1.8289768771642674)

end Verified.Hsmm.EmissionFull
