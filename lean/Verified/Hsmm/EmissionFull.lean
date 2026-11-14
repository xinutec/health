import Verified.Hsmm.Emissions
import Verified.Hsmm.Observation
import Verified.Hsmm.Geometric
import Verified.Hsmm.RouteModel
import Verified.Hsmm.Continuity
import Verified.FloatConst
/-!
# Full HSMM emission composition

`emission = baseEmission + geometricFn + routeRailFn + lineProximityFn`, summed
in that order over the route-graph model and one `ObsRow`: the served decode's
parameterisation.

The two line factors stay on at minutes the generator covers: off, a covered
fixless ride earned nothing and lost to `stationary`, and a line the generator
stopped vouching mid-ride was never charged. Coverage still reaches the entry
and duration terms. Continuity (`continuityContext`) is an optional extra term.

UNPROVEN; pinned by the `#guard`s. Distances via `haversine`/`pointToPolyline`
make sums ULP-close (`approx`).
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
  /-- Learned by coordinate search on half the narrated days and confirmed on
      the other half: a small gain in leg modes, lines and stations, journeys
      and phantoms unchanged. -/
  lineProximity : Float := 0.75
  continuity : Float := 1.0
  entry : Float := 1.0
  chain : Float := 1.0
  duration : Float := 1.0
  deriving Inhabited

private def REST_ZERO : Float := 0

/-- Every term of `emissionLogProbFullWith` but the base: what a minute pays
    beside its base emission, whichever form that base takes. -/
def emissionRestWith
    (modeledLines : List String) (minute : RouteModel.MinuteLines) (railEv : Float)
    (placeCoords : Std.HashMap Int (Float × Float))
    (continuity : Option Continuity.ContinuityContext)
    (s : State) (o : ObsRow) (priors : Mode → Emissions.ModePrior := modePriors)
    (w : TermWeights := {}) : Float :=
  let placeCoord := match s.placeId with | some pid => placeCoords.get? pid | none => none
  -- A family weighed at zero is left out, not multiplied: the feasibility
  -- term is `−∞` for a teleport, and `0 · −∞` is NaN.
  (if w.geometric == REST_ZERO then REST_ZERO else
    w.geometric * Geometric.geometricFeasibility s (Verified.FloatConst.natToFloat o.ts.toNat)
        (o.prevGpsFix.map toGeoFix) (o.nextGpsFix.map toGeoFix) placeCoord priors)
    + (if w.gap == REST_ZERO then REST_ZERO else
      w.gap * Geometric.gapTerm s o.gps.isSome
        (o.prevGpsFix.map toGeoFix) (o.nextGpsFix.map toGeoFix) priors)
    -- The kernels' `isCovered` gate, held open (see above).
    + w.rail * railEv
    + w.lineProximity * RouteModel.lineProximityFactorWith modeledLines minute s o false
    + w.continuity * Continuity.continuityLogLikelihood s o.gps.isSome
        (o.prevGpsFix.map (fun f => (f.lat, f.lon))) continuity

/-- Full per-cell emission log-probability: the base emission plus the
    geometric, rail and line-proximity terms. `placeCoords` resolves
    `s.placeId`. `continuity` is always supplied in production; `none` is the
    chain start and the test shape (see `Continuity`). -/
def emissionLogProbFullWith
    (modeledLines : List String) (minute : RouteModel.MinuteLines) (railEv : Float)
    (placeCoords : Std.HashMap Int (Float × Float))
    (continuity : Option Continuity.ContinuityContext)
    (s : State) (o : ObsRow) (priors : Mode → Emissions.ModePrior := modePriors)
    (w : TermWeights := {}) : Float :=
  let placeCoord := match s.placeId with | some pid => placeCoords.get? pid | none => none
  w.base * emissionLogProb s (toThin o) placeCoord priors
    + emissionRestWith modeledLines minute railEv placeCoords continuity s o priors w

/-- The per-cell emission with its per-minute facts computed in place, what the
    reference guards pin. The model build computes `minuteLines` once per minute
    and the rail evidence once per bracketing pair, then calls
    `emissionLogProbFullWith`. -/
def emissionLogProbFull
    (model : RouteGraphModel) (connGraph : RouteConnectivity.Graph) (modeledLines : List String)
    (placeCoords : Std.HashMap Int (Float × Float))
    (continuity : Option Continuity.ContinuityContext)
    (s : State) (o : ObsRow) : Float :=
  emissionLogProbFullWith modeledLines (RouteModel.minuteLines model o)
    (routeRailEvidence model connGraph s o false) placeCoords continuity s o

-- The model's emission (base+geo+routeRail+lineProx), reference values.
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
