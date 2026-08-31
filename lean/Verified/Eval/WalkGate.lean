/-!
# Walk-geometry ratchet (port of `src/eval/walk-gate.ts`, #1048 Group B)

The gate asks one question: **did any drawn walk get WORSE than its blessed
floor?** The floor is `tests/golden/walk-baseline.json` — gitignored, beside the
fixtures it describes, because it carries real walk timestamps.

## Why this is a ratchet and not a comparison

`score-walk-match`'s own A/B exit (matcher vs smoother) carries standing
failures (#305), so it can never be a deploy gate as-is: it is red on a healthy
tree. The ratchet inverts that — a standing defect is RECORDED in the floor and
can only shrink. Improvements are surfaced for re-bless rather than failing.

## ⚠ THIS IS GROUP B: THE ORACLE IS A FILE, SO PORTING LOSES NOTHING

`#1048` splits the five dead replay gates by what the TypeScript *was*. For
`day-gate`/`focus-gate` the TS was the ORACLE, and porting the harness would
leave Lean compared against itself — a check that can only pass. Here the oracle
is `walk-baseline.json`, a frozen file, so replacing the code under it keeps the
question intact.

The metric PRODUCER (the referee that measures a drawn line) is not here; this
module is only the verdict, which is pure and total. The producer is Rust glue
over the fixture replay, per the standing Lean-logic/Rust-IO split.

## Exactness

Every decision in this file is EXACT. `startTs` pairing is `Int` arithmetic;
the metric comparisons are `Float` subtractions against literal epsilons, and
they are the SAME subtractions V8 performed, so a value that sat on an epsilon
boundary in the TS sits on it here. No transcendental function is reached.

⚠ Ordering matches JS in the two places it is observable: `mergeSort` is stable
and left-biased on `≤`, as `Array.prototype.sort` has been since ES2019, and the
date sort is lexicographic — identical to JS's UTF-16 comparison over ISO dates,
which are ASCII.
-/

namespace Verified.Eval.WalkGate

/-! ## Thresholds

Each is the tolerance for ONE metric, and none is a budget: they exist because
a metric moves slightly under an irrelevant upstream change, not because that
much regression is acceptable. -/

/-- Over-route may rise this much (m). -/
def STALL_EPS_M : Float := 15

/-- Step-budget excess (drawn length beyond budget×slack, m) may rise this
much. -/
def BUDGET_EPS_M : Float := 30

/-- The same slack the reconstruction grants before its step factor acts — the
gate must not flag what the model deliberately tolerates.

⚠ Mirrors `MapSmoothProfile.stepSlackRatio` in `Verified.Geo.WalkSmooth`
(1.4). It is restated rather than imported because this module is the referee
and must not silently follow the subject it judges: if the reconstruction
loosens its slack, the gate should go RED and be re-blessed deliberately, not
widen its own tolerance in the same commit. -/
def BUDGET_SLACK_RATIO : Float := 1.4

/-- Route-correctness may fall this much (fraction). -/
def ROUTE_EPS : Float := 0.1

/-- Off-path building-crossing may rise this much (m). -/
def OFFPATH_EPS_M : Float := 5

/-- A drawn walk above this mean speed (km/h) is implausible on foot. -/
def WALK_SPEED_CEIL_KMH : Float := 12

/-- A walk's `startTs` may shift this much (s) between runs and still be the
same walk — small upstream segmentation moves must not drop its floor. -/
def START_TS_TOLERANCE_S : Nat := 120

/-! ## Shapes -/

/-- Referee metrics recorded per walk.

`none` means HONESTLY UNMEASURED (no building data in the fixture, no
named-street truth over the leg) — never zero. The distinction is the whole
reason these are `Option`: a lost measurement must not read as a perfect score.
-/
structure WalkEntry where
  /-- Episode start (unix seconds) — the walk's identity within its day. -/
  startTs : Int
  /-- Off-walkable p90 of the drawn line (m). RECORDED BUT NOT GATED: the
  metric is snapper-biased — a phantom that hugs mapped ways scores well, and a
  reconstruction that rightly dissolves it scores worse. Kept as a display
  column and for history. -/
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
  deriving Inhabited, BEq, Repr

/-- The gated axes. `p90` is absent on purpose — see `WalkEntry.p90M`. -/
inductive Metric where
  | stall | speed | route | offPath | budget
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

/-- Walks for one date, or `#[]` when the date is absent — the TS `?? []`. -/
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

/-- Pair baseline walks with current walks of the same day, nearest `startTs`
first, one-to-one, within `START_TS_TOLERANCE_S`.

Greedy on a stably-sorted candidate list: nearest pair wins, both sides are
consumed, and the scan continues. That is not a minimum-cost matching and does
not try to be — the tolerance is 120 s and walks within 120 s of each other are
the segmentation move this exists to absorb, not a competition. -/
def pairWalks (base cur : Array WalkEntry) : Pairing := Id.run do
  let mut candidates : Array (Nat × Nat × Nat) := #[]
  for b in [0:base.size] do
    for c in [0:cur.size] do
      let d := (base[b]!.startTs - cur[c]!.startTs).natAbs
      if d ≤ START_TS_TOLERANCE_S then
        candidates := candidates.push (b, c, d)
  -- Stable ascending by distance: ties keep generation order (base-major),
  -- which is what V8's stable sort gave the TS.
  let sorted := (candidates.toList.mergeSort (fun a b => a.2.2 ≤ b.2.2)).toArray
  let mut usedB : Array Bool := Array.replicate base.size false
  let mut usedC : Array Bool := Array.replicate cur.size false
  let mut pairs : Array (WalkEntry × WalkEntry) := #[]
  for (b, c, _) in sorted do
    if usedB[b]! || usedC[c]! then continue
    usedB := usedB.set! b true
    usedC := usedC.set! c true
    pairs := pairs.push (base[b]!, cur[c]!)
  let lostBase := (base.zipIdx.filter (fun p => !usedB[p.2]!)).map Prod.fst
  let newCur := (cur.zipIdx.filter (fun p => !usedC[p.2]!)).map Prod.fst
  return { pairs, lostBase, newCur }

/-! ## The verdict -/

/-- How far the drawn length runs beyond what the pedometer allows, with the
reconstruction's own slack. `none` budget = no step data = honestly unmeasured.

This is the witness a coherent smear cannot fool: a reconstruction can draw a
plausible-looking line anywhere, but it cannot draw more metres than the steps
account for. -/
def excess (w : WalkEntry) : Option Float :=
  w.budgetM.map (fun bm => max 0 (w.lenM - bm * BUDGET_SLACK_RATIO))

/-- Compare a run against the recorded floor.

Only dates present in `current` are compared — a single-day invocation must not
read the other days' floors as vanished. Pass `onlyDates` to make that scope
explicit. -/
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
      -- Higher-is-worse metrics with an epsilon, except `route` where the
      -- fraction falling is the regression. `none` on either side never
      -- compares: newly measured is not a regression, and a lost measurement
      -- is surfaced separately rather than scored.
      let axes : Array (Metric × Option Float × Option Float × Float × Bool) := #[
        (.stall, some b.stallM, some c.stallM, STALL_EPS_M, true),
        (.route, b.routeCorr, c.routeCorr, ROUTE_EPS, false),
        (.offPath, b.offPathM, c.offPathM, OFFPATH_EPS_M, true),
        (.budget, excess b, excess c, BUDGET_EPS_M, true)]
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
      -- Speed gates only the CEILING CROSSING. A standing offender is already
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

Every `#guard` below was ABLATED — the thing it guards was broken and the guard
was watched to fail, then restored. A guard that has never failed is a guess
about what the code does.

The fixtures are synthetic: this is the referee's arithmetic, and it has no
opinion about real coordinates. The metric PRODUCER is where real days are
needed, and that is Rust glue over the gitignored fixtures (#860). -/

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

-- ⚠ The epsilon is EXCLUSIVE: a move of exactly `STALL_EPS_M` does not fire.
-- 10 → 25 is 15.0 exactly in binary floating point, so this pins the boundary
-- rather than approaching it.
#guard
  let r := gateWalks (day #[{mk 100 with stallM := 10}]) (day #[{mk 100 with stallM := 25}])
  r.regressed.isEmpty && r.improved.isEmpty

-- The same axis falling past its epsilon is an improvement, not a pass. The
-- ratchet only tightens when a human blesses it, so this has to be REPORTED.
#guard
  let r := gateWalks (day #[{mk 100 with stallM := 30}]) (day #[{mk 100 with stallM := 10}])
  r.regressed.isEmpty && r.improved.size == 1 && r.improved[0]!.metric == .stall

-- Route-correctness is the one axis where FALLING is the regression — a
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

`excess` is not the raw length: it is what the line draws BEYOND what the
pedometer allows, and it is clamped at zero so a walk comfortably inside its
budget cannot bank credit against a later regression. -/

-- Base draws 100 m against a 140 m allowance (excess 0); now draws 200 m
-- against the same allowance (excess 60). 60 > `BUDGET_EPS_M`.
#guard
  let r := gateWalks (day #[{mk 100 with lenM := 100, budgetM := some 100}])
                     (day #[{mk 100 with lenM := 200, budgetM := some 100}])
  r.regressed.size == 1 && r.regressed[0]!.metric == .budget

-- ⚠ The clamp is load-bearing. Both walks are INSIDE their budget — 50 m and
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

-- ⚠ A STANDING offender does not fire, however much worse it gets: 15 → 20
-- km/h is both sides above the ceiling. The baseline already records it, and
-- re-flagging it every run is how a gate becomes noise that gets skipped.
#guard
  let r := gateWalks (day #[{mk 100 with speedKmh := 15}]) (day #[{mk 100 with speedKmh := 20}])
  r.regressed.isEmpty && r.improved.isEmpty

/-! ### `none` is unmeasured, never zero -/

-- A metric measured NOW but not in the floor cannot regress — there is
-- nothing to compare against, and treating `none` as 0 would make every newly
-- measured axis a regression on the run that introduced it.
#guard
  let r := gateWalks (day #[{mk 100 with offPathM := none}])
                     (day #[{mk 100 with offPathM := some 500}])
  r.regressed.isEmpty && r.unmeasured.isEmpty

-- A metric that WAS measured and is not any more is surfaced loudly and does
-- not fail. The floor is intact; the referee stopped answering.
#guard
  let r := gateWalks (day #[{mk 100 with offPathM := some 10}])
                     (day #[{mk 100 with offPathM := none}])
  r.regressed.isEmpty && r.unmeasured.size == 1 && r.unmeasured[0]!.metric == .offPath

/-! ### Pairing -/

-- A walk whose start slid within tolerance is the SAME walk and keeps its
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

-- ⚠ Pairing is ONE-TO-ONE. Two baseline walks are both within tolerance of a
-- single current walk; only the nearest may claim it, and the other is orphaned
-- rather than scored twice against the same line.
#guard
  let r := gateWalks (day #[mk 1000, mk 1010]) (day #[mk 1008])
  r.unmatched.size == 1 && r.unmatched[0]!.startTs == 1000 && r.added.isEmpty

-- A delta is reported at the BASELINE's `startTs`, not the current one — the
-- floor's identity is what a re-bless has to find.
#guard
  let r := gateWalks (day #[{mk 1000 with stallM := 10}]) (day #[{mk 1100 with stallM := 30}])
  r.regressed[0]!.startTs == 1000

/-! ### Scope -/

-- ⚠ Only dates present in `current` are compared. A single-day invocation
-- must not read every other day's floor as vanished — which would report 41 false
-- `unmatched` walks and bury the one real finding.
#guard
  let base : WalkBaseline := #[("2026-05-15", #[mk 100]), ("2026-05-18", #[mk 200])]
  let cur : WalkBaseline := #[("2026-05-15", #[mk 100])]
  (gateWalks base cur).unmatched.isEmpty

-- `onlyDates` makes that scope explicit, and widening it to a date the run
-- did not produce DOES report the floor as unmatched.
#guard
  let base : WalkBaseline := #[("2026-05-15", #[mk 100]), ("2026-05-18", #[mk 200])]
  let cur : WalkBaseline := #[("2026-05-15", #[mk 100])]
  (gateWalks base cur (some #["2026-05-15", "2026-05-18"])).unmatched.size == 1

-- The gate's exit condition is `regressed` alone: a run with improvements and
-- orphans still PASSES, because every one of those needs a human to bless it and
-- none of them is a defect.
#guard
  let r := gateWalks (day #[{mk 1000 with stallM := 30}, mk 5000])
                     (day #[{mk 1000 with stallM := 10}, mk 9000])
  passes r && !r.improved.isEmpty && !r.unmatched.isEmpty && !r.added.isEmpty

end Witnesses

end Verified.Eval.WalkGate
