/-!
# Walk-geometry ratchet

Did any drawn walk get worse than its blessed floor,
`tests/golden/walk-baseline.json` (gitignored beside its fixtures: it carries
real walk timestamps)? A standing defect is recorded in the floor and can only
shrink, so the gate is green on a healthy tree; improvements are surfaced for
re-bless. The oracle is a frozen file, so the code under it can change.

This module is the verdict, pure and total; the metric producer is Rust glue
over the fixture replay. Every decision is exact: `startTs` pairing is `Int`,
and metric comparisons are the same `Float` subtractions the baseline was
blessed with. Sorting is stable (`mergeSort`, left-biased on `≤`) and dates
compare as ASCII.
-/

namespace Verified.Eval.WalkGate

/-! ## Thresholds

Tolerances, not budgets: a metric moves slightly under an irrelevant upstream
change. -/

/-- Over-route may rise this much (m). -/
def STALL_EPS_M : Float := 15

/-- Step-budget excess (drawn length beyond budget×slack, m) may rise this
much. -/
def BUDGET_EPS_M : Float := 30

/-- The slack the reconstruction grants before its step factor acts
(`MapSmoothProfile.stepSlackRatio`, 1.4), restated rather than imported so the
referee does not silently follow its subject: if the reconstruction loosens,
the gate goes red and is re-blessed deliberately. -/
def BUDGET_SLACK_RATIO : Float := 1.4

/-- Route-correctness may fall this much (fraction). -/
def ROUTE_EPS : Float := 0.1

/-- Off-path building-crossing may rise this much (m). -/
def OFFPATH_EPS_M : Float := 5

/-- The length drawn dashed, as unbacked by map or track, may rise this much
(m): of the order of one edge between two fixes. -/
def INFERRED_EPS_M : Float := 15

/-- A drawn walk above this mean speed (km/h) is implausible on foot. -/
def WALK_SPEED_CEIL_KMH : Float := 12

/-- A walk's `startTs` may shift this much (s) between runs and still be the
same walk — small upstream segmentation moves must not drop its floor. -/
def START_TS_TOLERANCE_S : Nat := 120

/-! ## Shapes -/

/-- Referee metrics recorded per walk. `none` is unmeasured (no building data,
no named-street truth), never zero. -/
structure WalkEntry where
  /-- Episode start (unix seconds) — the walk's identity within its day. -/
  startTs : Int
  /-- Off-walkable p90 of the drawn line (m), recorded but not gated: it favours
  a phantom hugging mapped ways. -/
  p90M : Option Float
  /-- Corridor over-route (m). -/
  stallM : Float
  /-- Mean drawn speed (km/h). -/
  speedKmh : Float
  /-- Fraction of the line on the ground-truth-confirmed street. -/
  routeCorr : Option Float
  /-- Building-crossing while off every walkable way (m) — the true defect. -/
  offPathM : Option Float
  /-- Drawn length of the leg (m). -/
  lenM : Float
  /-- Pedometer displacement budget (steps × stride, m); `none` = no step data. -/
  budgetM : Option Float
  /-- Metres of the drawn line the fold shipped dashed: backed by neither a
  mapped way nor a sharp fix (`Geo.WalkBacked`). `none`: the floor predates
  it, or the harness sent no marks. -/
  inferredM : Option Float := none
  /-- A diagnostic column, not an axis: the matcher's identity report (named
  ways and metres, longest first) for `WALK_GATE_DUMP`. Gating it would bless an
  unadjudicated route shape. Defaulted, as the blessed floor predates it. -/
  wayUm : Array (String × Nat) := #[]
  /-- Coverage, diagnostic only: the raw track's length, the farthest raw fix
  from the drawn line, and the gaps between the tracks' ends. Not a bar: four
  candidate discriminators found no band separating a disputed walk from the
  blessed ones, and a bar must come from that distribution. Defaulted, as the
  floor predates them. -/
  rawLenM : Float := 0
  coverMaxM : Float := 0
  headGapM : Float := 0
  tailGapM : Float := 0
  /-- p90 of the fixes' distance to the drawn line, and the share beyond 30 m:
  the maximum alone scores one spike like an abandoned half (see
  `Eval.WalkMetrics.fixCoverage`). -/
  cover90M : Float := 0
  uncoveredFrac : Float := 0
  deriving Inhabited, BEq, Repr

/-- The gated axes. `p90` is absent on purpose — see `WalkEntry.p90M`. -/
inductive Metric where
  | stall | speed | route | offPath | budget | inferred
  deriving BEq, Repr, Inhabited

/-- A walk identified within the corpus. -/
structure At where
  date : String
  startTs : Int
  deriving BEq, Repr, Inhabited

/-- One axis of one walk, and the two values that moved it. -/
structure Delta where
  date : String
  startTs : Int
  metric : Metric
  base : Float
  now : Float
  deriving BEq, Repr, Inhabited

/-- One axis of one walk that lost its measurement. -/
structure MetricAt where
  date : String
  startTs : Int
  metric : Metric
  deriving BEq, Repr, Inhabited

/-- The verdict. Only `regressed` fails the gate; the rest are for the human
deciding whether to re-bless. -/
structure GateResult where
  /-- Walks worse than their recorded floor — these fail the gate. -/
  regressed : Array Delta := #[]
  /-- Walks better than their floor — re-bless to ratchet it down. -/
  improved : Array Delta := #[]
  /-- Baseline walks with no current counterpart. States are golden-gated, so a
  vanished/merged walk is not a geometry failure — surfaced for re-bless. -/
  unmatched : Array At := #[]
  /-- Current walks the baseline has no floor for — record via bless. -/
  added : Array At := #[]
  /-- A metric measured in the baseline but `none` now (lost measurement, e.g.
  a scorer change) — surfaced loudly, does not fail. -/
  unmeasured : Array MetricAt := #[]
  deriving Inhabited, Repr

/-- The committed floor: date → walks. An array of pairs rather than a map, so
the traversal order is the sorted date order and nothing depends on hash
iteration. -/
abbrev WalkBaseline := Array (String × Array WalkEntry)

/-- Walks for one date, or `#[]` when the date is absent. -/
def lookupDate (b : WalkBaseline) (date : String) : Array WalkEntry :=
  match b.find? (fun p => p.1 == date) with
  | some p => p.2
  | none => #[]

/-! ## Pairing -/

/-- The outcome of matching a day's baseline walks to its current ones. -/
structure Pairing where
  pairs : Array (WalkEntry × WalkEntry)
  lostBase : Array WalkEntry
  newCur : Array WalkEntry
  deriving Inhabited

/-- Pair baseline and current walks of one day one-to-one, nearest `startTs`
first, within `START_TS_TOLERANCE_S`: greedy on a stable sort, which suffices
since walks that close are the segmentation move this absorbs. -/
def pairWalks (base cur : Array WalkEntry) : Pairing := Id.run do
  let mut candidates : Array (Nat × Nat × Nat) := #[]
  for hm_b : b in [0:base.size] do
    for hm_c : c in [0:cur.size] do
      let d := (base[b].startTs - cur[c].startTs).natAbs
      if d ≤ START_TS_TOLERANCE_S then
        candidates := candidates.push (b, c, d)
  -- Stable ascending by distance: ties keep generation order (base-major).
  let sorted := (candidates.toList.mergeSort (fun a b => a.2.2 ≤ b.2.2)).toArray
  let mut usedB : Array Bool := Array.replicate base.size false
  let mut usedC : Array Bool := Array.replicate cur.size false
  let mut pairs : Array (WalkEntry × WalkEntry) := #[]
  -- Every `b`/`c` came from the candidate scan over both arrays, so the masks
  -- and the entries are there; an index off them reads as unused / absent.
  for (b, c, _) in sorted do
    if usedB[b]?.getD false || usedC[c]?.getD false then continue
    let some eb := base[b]? | continue
    let some ec := cur[c]? | continue
    usedB := usedB.set! b true
    usedC := usedC.set! c true
    pairs := pairs.push (eb, ec)
  let lostBase := (base.zipIdx.filter (fun p => !(usedB[p.2]?.getD false))).map Prod.fst
  let newCur := (cur.zipIdx.filter (fun p => !(usedC[p.2]?.getD false))).map Prod.fst
  return { pairs, lostBase, newCur }

/-! ## The verdict -/

/-- How far the drawn length exceeds what the pedometer allows, with the
reconstruction's slack; `none` without step data. A smear can draw a plausible
line anywhere but not more metres than the steps account for. -/
def excess (w : WalkEntry) : Option Float :=
  w.budgetM.map (fun bm => max 0 (w.lenM - bm * BUDGET_SLACK_RATIO))

/-- Compare a run against the floor, for the dates in `current` only (a
single-day run must not read the other days as vanished); `onlyDates` makes
that explicit. -/
def gateWalks (baseline current : WalkBaseline)
    (onlyDates : Option (Array String) := none) : GateResult := Id.run do
  let dates := onlyDates.getD (current.map Prod.fst)
  let dates := (dates.toList.mergeSort (· ≤ ·)).toArray
  let mut out : GateResult := {}
  for date in dates do
    let p := pairWalks (lookupDate baseline date) (lookupDate current date)
    for w in p.lostBase do
      out := { out with unmatched := out.unmatched.push ⟨date, w.startTs⟩ }
    for w in p.newCur do
      out := { out with added := out.added.push ⟨date, w.startTs⟩ }
    for (b, c) in p.pairs do
      -- Higher is worse with an epsilon, except `route`, where falling is the
      -- regression. `none` on either side never compares; a lost measurement
      -- is surfaced separately.
      let axes : Array (Metric × Option Float × Option Float × Float × Bool) := #[
        (.stall, some b.stallM, some c.stallM, STALL_EPS_M, true),
        (.route, b.routeCorr, c.routeCorr, ROUTE_EPS, false),
        (.offPath, b.offPathM, c.offPathM, OFFPATH_EPS_M, true),
        (.budget, excess b, excess c, BUDGET_EPS_M, true),
        (.inferred, b.inferredM, c.inferredM, INFERRED_EPS_M, true)]
      for (metric, bv, nv, eps, up) in axes do
        match bv, nv with
        | none, _ => pure ()
        | some _, none =>
          out := { out with unmeasured := out.unmeasured.push ⟨date, b.startTs, metric⟩ }
        | some bb, some nn =>
          let worse := if up then nn - bb else bb - nn
          let delta : Delta := ⟨date, b.startTs, metric, bb, nn⟩
          if worse > eps then out := { out with regressed := out.regressed.push delta }
          else if worse < -eps then out := { out with improved := out.improved.push delta }
      -- Speed gates only the ceiling crossing. A standing offender is already
      -- recorded in the baseline and can only be fixed, not re-flagged.
      let wasOk := b.speedKmh ≤ WALK_SPEED_CEIL_KMH
      let isOk := c.speedKmh ≤ WALK_SPEED_CEIL_KMH
      let delta : Delta := ⟨date, b.startTs, .speed, b.speedKmh, c.speedKmh⟩
      if wasOk && !isOk then out := { out with regressed := out.regressed.push delta }
      else if !wasOk && isOk then out := { out with improved := out.improved.push delta }
  return out

/-- The gate's exit condition: a run passes when nothing regressed. -/
def passes (r : GateResult) : Bool := r.regressed.isEmpty


/-! ## Witnesses

Every `#guard` was ablated: the guarded thing broken and the guard seen to
fail. Synthetic fixtures; real days are the Rust producer's. -/

section Witnesses

/-- A walk that fires no axis: every gated metric is either unmeasured or
sitting still. Each witness perturbs exactly one field of it, so a fire names
the axis under test and nothing else. -/
private def mk (startTs : Int) : WalkEntry :=
  { startTs, p90M := none, stallM := 0, speedKmh := 4, routeCorr := none,
    offPathM := none, lenM := 100, budgetM := none }

private def day (ws : Array WalkEntry) : WalkBaseline := #[("2026-05-15", ws)]

-- The neutral pair moves nothing at all — the control. Without this a witness
-- below could fire for a reason the perturbation did not introduce.
#guard
  let r := gateWalks (day #[mk 100]) (day #[mk 100])
  r.regressed.isEmpty && r.improved.isEmpty && r.unmatched.isEmpty
    && r.added.isEmpty && r.unmeasured.isEmpty

/-! ### Each axis fires, and on the correct side -/

-- Over-route rising past its epsilon is a regression.
#guard
  let r := gateWalks (day #[{mk 100 with stallM := 10}]) (day #[{mk 100 with stallM := 30}])
  r.regressed.size == 1 && r.regressed[0]!.metric == .stall

-- The epsilon is exclusive: a move of exactly `STALL_EPS_M` does not fire.
-- 10 → 25 is 15.0 exactly in binary floating point, so this pins the boundary
-- rather than approaching it.
#guard
  let r := gateWalks (day #[{mk 100 with stallM := 10}]) (day #[{mk 100 with stallM := 25}])
  r.regressed.isEmpty && r.improved.isEmpty

-- The same axis falling past its epsilon is an improvement, not a pass. The
-- ratchet only tightens when a human blesses it, so this has to be reported.
#guard
  let r := gateWalks (day #[{mk 100 with stallM := 30}]) (day #[{mk 100 with stallM := 10}])
  r.regressed.isEmpty && r.improved.size == 1 && r.improved[0]!.metric == .stall

-- Route-correctness is the one axis where falling is the regression — a
-- smaller fraction of the line on the confirmed street.
#guard
  let r := gateWalks (day #[{mk 100 with routeCorr := some 0.9}])
                     (day #[{mk 100 with routeCorr := some 0.5}])
  r.regressed.size == 1 && r.regressed[0]!.metric == .route

-- ...and rising is the improvement. Guards the `up := false` flag, which a
-- copy-paste of the neighbouring axes would silently get wrong.
#guard
  let r := gateWalks (day #[{mk 100 with routeCorr := some 0.5}])
                     (day #[{mk 100 with routeCorr := some 0.9}])
  r.improved.size == 1 && r.improved[0]!.metric == .route

-- Building-crossing while off every walkable way — the true defect.
#guard
  let r := gateWalks (day #[{mk 100 with offPathM := some 10}])
                     (day #[{mk 100 with offPathM := some 20}])
  r.regressed.size == 1 && r.regressed[0]!.metric == .offPath

/-! ### The step budget

`excess` is the length beyond the allowance, clamped at zero, so a walk inside
its budget cannot bank credit against a later regression. -/

-- Base draws 100 m against a 140 m allowance (excess 0); now draws 200 m
-- against the same allowance (excess 60). 60 > `BUDGET_EPS_M`.
#guard
  let r := gateWalks (day #[{mk 100 with lenM := 100, budgetM := some 100}])
                     (day #[{mk 100 with lenM := 200, budgetM := some 100}])
  r.regressed.size == 1 && r.regressed[0]!.metric == .budget

-- The clamp is load-bearing. Both walks are inside their budget — 50 m and
-- 100 m against a 140 m allowance — so without `max 0` the excesses would be −90
-- and −40, a 50 m "regression" on a walk that never exceeded its steps at all.
#guard
  let r := gateWalks (day #[{mk 100 with lenM := 50, budgetM := some 100}])
                     (day #[{mk 100 with lenM := 100, budgetM := some 100}])
  r.regressed.isEmpty && r.improved.isEmpty

/-! ### Speed gates the crossing, not the level -/

-- Newly implausible on foot.
#guard
  let r := gateWalks (day #[{mk 100 with speedKmh := 5}]) (day #[{mk 100 with speedKmh := 15}])
  r.regressed.size == 1 && r.regressed[0]!.metric == .speed

-- Back under the ceiling.
#guard
  let r := gateWalks (day #[{mk 100 with speedKmh := 15}]) (day #[{mk 100 with speedKmh := 5}])
  r.improved.size == 1 && r.improved[0]!.metric == .speed

-- A standing offender does not fire, however much worse it gets: 15 → 20
-- km/h is both sides above the ceiling. The baseline already records it, and
-- re-flagging it every run is how a gate becomes noise that gets skipped.
#guard
  let r := gateWalks (day #[{mk 100 with speedKmh := 15}]) (day #[{mk 100 with speedKmh := 20}])
  r.regressed.isEmpty && r.improved.isEmpty

/-! ### `none` is unmeasured, never zero -/

-- A metric measured now but not in the floor cannot regress — there is
-- nothing to compare against, and treating `none` as 0 would make every newly
-- measured axis a regression on the run that introduced it.
-- More of a walk drawn dashed is a regression; a floor without the column
-- compares nothing.
#guard
  let r := gateWalks (day #[{mk 100 with inferredM := some 0}])
                     (day #[{mk 100 with inferredM := some 40}])
  r.regressed.size == 1 && r.regressed[0]!.metric == .inferred
#guard
  let r := gateWalks (day #[{mk 100 with inferredM := some 40}])
                     (day #[{mk 100 with inferredM := some 50}])
  r.regressed.isEmpty && r.improved.isEmpty
#guard
  let r := gateWalks (day #[mk 100]) (day #[{mk 100 with inferredM := some 500}])
  r.regressed.isEmpty && r.unmeasured.isEmpty

#guard
  let r := gateWalks (day #[{mk 100 with offPathM := none}])
                     (day #[{mk 100 with offPathM := some 500}])
  r.regressed.isEmpty && r.unmeasured.isEmpty

-- A metric that was measured and is not any more is surfaced loudly and does
-- not fail. The floor is intact; the referee stopped answering.
#guard
  let r := gateWalks (day #[{mk 100 with offPathM := some 10}])
                     (day #[{mk 100 with offPathM := none}])
  r.regressed.isEmpty && r.unmeasured.size == 1 && r.unmeasured[0]!.metric == .offPath

/-! ### Pairing -/

-- A walk whose start slid within tolerance is the same walk and keeps its
-- floor. 100 s < 120 s.
#guard
  let r := gateWalks (day #[{mk 1000 with stallM := 10}]) (day #[{mk 1100 with stallM := 30}])
  r.regressed.size == 1 && r.unmatched.isEmpty && r.added.isEmpty

-- Beyond tolerance they are two different walks: the floor is orphaned and
-- the current walk is unfloored. Neither is a failure — states are golden-gated
-- elsewhere, so a re-segmented day is a re-bless, not a geometry defect.
#guard
  let r := gateWalks (day #[mk 1000]) (day #[mk 1200])
  r.regressed.isEmpty && r.unmatched.size == 1 && r.added.size == 1

-- Pairing is one-to-one. Two baseline walks are both within tolerance of a
-- single current walk; only the nearest may claim it, and the other is orphaned
-- rather than scored twice against the same line.
#guard
  let r := gateWalks (day #[mk 1000, mk 1010]) (day #[mk 1008])
  r.unmatched.size == 1 && r.unmatched[0]!.startTs == 1000 && r.added.isEmpty

-- A delta is reported at the baseline's `startTs`, not the current one — the
-- floor's identity is what a re-bless has to find.
#guard
  let r := gateWalks (day #[{mk 1000 with stallM := 10}]) (day #[{mk 1100 with stallM := 30}])
  r.regressed[0]!.startTs == 1000

/-! ### Scope -/

-- Only dates present in `current` are compared. A single-day invocation
-- must not read every other day's floor as vanished — which would report 41 false
-- `unmatched` walks and bury the one real finding.
#guard
  let base : WalkBaseline := #[("2026-05-15", #[mk 100]), ("2026-05-18", #[mk 200])]
  let cur : WalkBaseline := #[("2026-05-15", #[mk 100])]
  (gateWalks base cur).unmatched.isEmpty

-- `onlyDates` makes that scope explicit, and widening it to a date the run
-- did not produce does report the floor as unmatched.
#guard
  let base : WalkBaseline := #[("2026-05-15", #[mk 100]), ("2026-05-18", #[mk 200])]
  let cur : WalkBaseline := #[("2026-05-15", #[mk 100])]
  (gateWalks base cur (some #["2026-05-15", "2026-05-18"])).unmatched.size == 1

-- The gate's exit condition is `regressed` alone: a run with improvements and
-- orphans still passes, because every one of those needs a human to bless it and
-- none of them is a defect.
#guard
  let r := gateWalks (day #[{mk 1000 with stallM := 30}, mk 5000])
                     (day #[{mk 1000 with stallM := 10}, mk 9000])
  passes r && !r.improved.isEmpty && !r.unmatched.isEmpty && !r.added.isEmpty

end Witnesses

end Verified.Eval.WalkGate
