/-!
# Stay-split evidence scorer (port of the pure leaf of `src/geo/stay-split.ts`)

`stay-split.ts` is a suite of `<T extends TrackSegment>` array transforms that
split/reassign segments over an in-stay gap — record orchestration that stays
shell. Its one pure decision leaf is `scoreSplitEvidence`: the weighted
log-evidence (nats) that the user *left* during a gap, summed across step
density (the only direct movement signal), gap-anomaly ratio, HR, and
post-gap proximity. `> SPLIT_THRESHOLD_NATS` triggers a split.

All discrete branches + arithmetic, no transcendentals ⇒ EXACT (guarded at
≤1 ULP only because decimal literals like `5.3` are not the same double as the
summed `4.5 + 0.8`; the op sequence is replicated verbatim). UNPROVEN; pinned
by the `#guard`s against Node/V8.
-/

namespace Verified.Geo.StaySplit

def SPLIT_THRESHOLD_NATS : Float := 2.5
def GAP_ANOMALY_MIN_PRE_FIXES : Int := 5

/-- The gap signals the split scorer weighs. -/
structure GapEvidence where
  gapDurationS : Float
  medianPriorGapS : Float
  preGapFixCount : Int
  stepsInGap : Float
  hrMeanInGap : Option Float
  hrSamplesInGap : Int
  postGapDistFromCentroidM : Float
  deriving Inhabited

/-- Weighted log-evidence (nats) that the user left during the gap. Positive →
    departure; negative → continued stay. -/
def scoreSplitEvidence (ev : GapEvidence) : Float := Id.run do
  let gapMin := ev.gapDurationS / 60
  if decide (gapMin ≤ 0) then return 0
  let stepsPerMin := ev.stepsInGap / gapMin
  -- Primary signal: biometric step density (the only direct movement evidence).
  let mut score : Float :=
    if decide (stepsPerMin > 20) then 3.5
    else if decide (stepsPerMin > 8) then 2.0
    else if decide (stepsPerMin > 3) then 0.5
    else if decide (stepsPerMin > 1) then -0.5
    else -2.0
  -- Supporting: gap-anomaly ratio, only amplifying a positive step signal.
  if decide (ev.preGapFixCount ≥ GAP_ANOMALY_MIN_PRE_FIXES) && decide (ev.medianPriorGapS > 0)
      && decide (score > 0) then
    let ratio := ev.gapDurationS / ev.medianPriorGapS
    if decide (ratio > 50) then score := score + 1.0
    else if decide (ratio > 10) then score := score + 0.5
  -- Supporting: HR elevation during the gap.
  match ev.hrMeanInGap with
  | some hr =>
    if decide (ev.hrSamplesInGap ≥ 3) then
      if decide (hr > 110) then score := score + 0.8
      else if decide (hr > 95) then score := score + 0.3
      else if decide (hr < 75) then score := score - 0.5
  | none => pure ()
  -- Counter-evidence: post-gap fix landed back on the cluster.
  if decide (ev.postGapDistFromCentroidM < 20) then score := score - 0.5
  return score

/-! ## Parity with Node/V8 (`lean/experiments/staysplit-refs.mts`) -/

private def approxS (a b : Float) : Bool := Float.abs (a - b) < 1e-9
private def ev (gap med : Float) (pre : Int) (steps : Float) (hr : Option Float) (hrS : Int) (post : Float) : GapEvidence :=
  ⟨gap, med, pre, steps, hr, hrS, post⟩

#guard approxS (scoreSplitEvidence (ev 1800 30 10 900 (some 120) 5 500)) 5.3       -- walkStrong
#guard approxS (scoreSplitEvidence (ev 3600 30 10 0 (some 60) 5 5)) (-3)           -- sittingSilent
#guard approxS (scoreSplitEvidence (ev 1200 60 10 80 (some 100) 5 300)) 1.3        -- ambiguousMid
#guard approxS (scoreSplitEvidence (ev 1800 30 10 45 none 0 300)) (-0.5)           -- fidget
#guard approxS (scoreSplitEvidence (ev 1800 30 10 300 (some 96) 4 300)) 3.3        -- clearMove
#guard approxS (scoreSplitEvidence (ev 0 30 10 100 (some 120) 5 300)) 0            -- zeroGap
#guard approxS (scoreSplitEvidence (ev 1800 120 10 500 none 0 300)) 2.5            -- mildAnomaly
#guard approxS (scoreSplitEvidence (ev 1800 30 3 500 none 0 300)) 2                -- fewPreFix

end Verified.Geo.StaySplit
