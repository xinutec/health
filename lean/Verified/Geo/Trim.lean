/-!
# `trimOverRouteExcursions` — the over-route detour excision

The most intricate display pass of `map-match-core.ts`, ported in the
metric-parametric style. Two excision passes over a matched path against
the GPS corridor, then a rebuild:

1. *Spatial*: an off-corridor run (every vertex further than
   `offM` from every fix) bracketed by on-corridor anchors is excised
   when it travels ≥ `minStall` while the corridor position advances by
   less than `detour` of that — the matcher invented a loop the walker
   barely moved past. Gap-fills survive (their corridor advances in
   step); real there-and-backs survive (the fixes polyline contains the
   excursion, so corridor arc advances too).
2. *Temporal* (#362): a doubling-back over just-walked street is
   spatially supported but its corridor position is frozen — any
   stretch travelling ≥ `minStall` with corridor advance below `stall`
   of it that returns near its start (net displacement < `return` of
   the span) is excised; the *last* qualifying end wins, exactly as the
   TS scan overwrites `found`.

Corridor positions (`corridorPositions`) are the monotone-floor
projections of path vertices onto the fixes polyline: per vertex, the
strict-first-minimum projection among chords whose interpolated arc
position is not more than `slack` behind the running floor.

Ratio thresholds arrive as exact rationals (`num`/`den`, compared by
cross-multiplication — no rounding at all); the projection's arc
interpolation is the parametric `arcPos` (the metric instantiation
rounds it); the rebuild's `> 0.5 m` dedupe is `nearLe` (note *≤*
semantics — `dedupeConsecutive` uses strict `<`, mirrored separately).

Theorem: the pass is drop-only (`trim_sublist`) — it excises and
dedupes, never invents or reorders. The deeper "only GPS-unsupported
stretches are excised" statement is the guard structure of `pass1`/
`pass2` itself, visible in the definitions.
-/

namespace Verified.Geo

variable {π : Type}

/-- Trim thresholds: µm distances, ratios as exact rationals, and the
corridor-position slack (the TS `minS - 1` metre). -/
structure TrimP where
  offM : Nat
  detourNum : Nat
  detourDen : Nat
  minStall : Nat
  returnNum : Nat
  returnDen : Nat
  stallNum : Nat
  stallDen : Nat
  slack : Int

/-- Cumulative arc length along indexed points. -/
def cumArc (pd : π → π → Nat) (pts : Nat → π) : Nat → Nat
  | 0 => 0
  | i + 1 => cumArc pd pts i + pd (pts i) (pts (i + 1))

/-- `cumArc` materialised as an array (`arcArr[i] = cumArc i` for
`i < n`) — the passes query positions many times, and recomputing the
prefix per query is quadratic. -/
def arcArrGo (pd : π → π → Nat) (pts : Nat → π) (n i last : Nat)
    (acc : Array Nat) : Array Nat :=
  if _h : i < n then
    arcArrGo pd pts n (i + 1) (last + pd (pts (i - 1)) (pts i))
      (acc.push (last + pd (pts (i - 1)) (pts i)))
  else acc
termination_by n - i

def arcArr (pd : π → π → Nat) (pts : Nat → π) (n : Nat) : Array Nat :=
  arcArrGo pd pts n 1 0 #[0]

/-- Is some fix within `offM` of `v` (the TS min-over-fixes test)? -/
def anyFix (pd : π → π → Nat) (fx : Nat → π) (nf offM : Nat) (v : π)
    (i : Nat) : Bool :=
  if _h : i < nf then
    if pd v (fx i) ≤ offM then true else anyFix pd fx nf offM v (i + 1)
  else false
termination_by nf - i

/-- One vertex's corridor position: strict-first-minimum projection over
the fixes chords, subject to the monotone floor (`minS - slack ≤ s`);
`bestS` starts at the floor. -/
def cpScan (projD : π → π → π → Nat) (arcPos : π → π → π → Int → Int → Int)
    (fx : Nat → π) (arc : Nat → Int) (nf : Nat) (v : π) (minS slack : Int)
    (i : Nat) (best : Option Nat) (bestS : Int) : Int :=
  if _h : i + 1 < nf then
    if (match best with
        | none => true
        | some bv => decide (projD v (fx i) (fx (i + 1)) < bv)) &&
        decide (minS - slack ≤ arcPos v (fx i) (fx (i + 1)) (arc i) (arc (i + 1))) then
      cpScan projD arcPos fx arc nf v minS slack (i + 1)
        (some (projD v (fx i) (fx (i + 1))))
        (arcPos v (fx i) (fx (i + 1)) (arc i) (arc (i + 1)))
    else cpScan projD arcPos fx arc nf v minS slack (i + 1) best bestS
  else bestS
termination_by nf - i

/-- All corridor positions, threading the monotone floor. -/
def cpGo (projD : π → π → π → Nat) (arcPos : π → π → π → Int → Int → Int)
    (fx : Nat → π) (arc : Nat → Int) (nf : Nat) (path : Nat → π) (n : Nat)
    (j : Nat) (minS : Int) (slack : Int) (acc : Array Int) : Array Int :=
  if _h : j < n then
    cpGo projD arcPos fx arc nf path n (j + 1)
      (cpScan projD arcPos fx arc nf (path j) minS slack 0 none minS)
      slack
      (acc.push (cpScan projD arcPos fx arc nf (path j) minS slack 0 none minS))
  else acc
termination_by n - j

/-- Set `[i, j)` removed. -/
def markRange (rm : Array Bool) (i j : Nat) : Array Bool :=
  if _h : i < j then markRange (rm.setIfInBounds i true) (i + 1) j else rm
termination_by j - i

/-- First on-corridor index `≥ k` (`n` if none). -/
def nextOn (onc : Nat → Bool) (n k : Nat) : Nat :=
  if _h : k < n then (if onc k then k else nextOn onc n (k + 1)) else n
termination_by n - k

/-- Pass 1 (spatial): excise off-corridor runs whose corridor advance
falls below `detour` of their travelled span. -/
def pass1 (P : TrimP) (n : Nat) (onc : Nat → Bool) (cum : Nat → Nat)
    (cp : Nat → Int) : Nat → Nat → Array Bool → Array Bool
  | 0, _, rm => rm
  | fuel + 1, k, rm =>
    if k < n then
      if onc k then pass1 P n onc cum cp fuel (k + 1) rm
      else
        pass1 P n onc cum cp fuel (nextOn onc n k)
          (if 1 ≤ k ∧ nextOn onc n k < n ∧
              P.minStall ≤ cum (nextOn onc n k) - cum (k - 1) ∧
              (cp (nextOn onc n k) - cp (k - 1)) * P.detourDen <
                ((cum (nextOn onc n k) - cum (k - 1) : Nat) : Int) * P.detourNum
           then markRange rm k (nextOn onc n k) else rm)
    else rm

/-- Pass 2's inner scan: the *last* `b` in the unremoved stretch from
`a` qualifying as a temporal stall (the TS `found` overwrite). -/
def stallScan (P : TrimP) (pd : π → π → Nat) (path : Nat → π) (n : Nat)
    (rm : Array Bool) (cum : Nat → Nat) (cp : Nat → Int) (a : Nat)
    (b : Nat) (found : Option Nat) : Option Nat :=
  if _h : b < n then
    if rm.getD b false then found
    else
      stallScan P pd path n rm cum cp a (b + 1)
        (if P.minStall ≤ cum b - cum a ∧
            (cp b - cp a) * P.stallDen <
              ((cum b - cum a : Nat) : Int) * P.stallNum ∧
            ((pd (path a) (path b) : Nat) : Int) * P.returnDen <
              ((cum b - cum a : Nat) : Int) * P.returnNum
         then some b else found)
  else found
termination_by n - b

/-- Pass 2 (temporal, #362). -/
def pass2 (P : TrimP) (pd : π → π → Nat) (path : Nat → π) (n : Nat)
    (cum : Nat → Nat) (cp : Nat → Int) : Nat → Nat → Array Bool → Array Bool
  | 0, _, rm => rm
  | fuel + 1, a, rm =>
    if a < n - 2 then
      if rm.getD a false then pass2 P pd path n cum cp fuel (a + 1) rm
      else
        match stallScan P pd path n rm cum cp a (a + 2) none with
        | some b => pass2 P pd path n cum cp fuel b (markRange rm (a + 1) b)
        | none => pass2 P pd path n cum cp fuel (a + 1) rm
    else rm

/-- The rebuild: drop excised vertices, then any now-coincident
neighbours (`nearLe` — the TS `> 0.5 m` push guard). -/
def trimRebuild (nearLe : π → π → Bool) (path : Nat → π) (n : Nat)
    (rm : Array Bool) (i : Nat) (hasPrev : Bool) (prev : π) (acc : List π) :
    List π :=
  if _h : i < n then
    if rm.getD i false then
      trimRebuild nearLe path n rm (i + 1) hasPrev prev acc
    else
      if hasPrev && nearLe prev (path i) then
        trimRebuild nearLe path n rm (i + 1) hasPrev prev acc
      else trimRebuild nearLe path n rm (i + 1) true (path i) (acc ++ [path i])
  else acc
termination_by n - i

/-- The removal flags after both passes (positions materialised once —
value-identical to querying `cumArc`/`cpGo` directly, which
`arcArr`/`cpArr` compute). -/
def trimFlags (P : TrimP) (pd : π → π → Nat) (projD : π → π → π → Nat)
    (arcPos : π → π → π → Int → Int → Int) (fx : Nat → π) (nf : Nat)
    (path : Nat → π) (n : Nat) : Array Bool :=
  let fa := arcArr pd fx nf
  let cu := arcArr pd path n
  let cp := cpGo projD arcPos fx (fun i => (fa.getD i 0 : Int)) nf path n 0 0
    P.slack #[]
  pass2 P pd path n (fun j => cu.getD j 0) (fun j => cp.getD j 0)
    (n + 1) 0
    (pass1 P n (fun k => anyFix pd fx nf P.offM (path k) 0)
      (fun j => cu.getD j 0) (fun j => cp.getD j 0)
      (n + 1) 0 (Array.replicate n false))

/-- The TS `trimOverRouteExcursions` over `n` path vertices and `nf`
fixes (short inputs unchanged). -/
def trim (P : TrimP) (pd : π → π → Nat) (projD : π → π → π → Nat)
    (arcPos : π → π → π → Int → Int → Int) (nearLe : π → π → Bool)
    (fx : Nat → π) (nf : Nat) (path : Nat → π) (n : Nat) : List π :=
  if n < 3 ∨ nf < 2 then (List.range n).map path
  else
    trimRebuild nearLe path n (trimFlags P pd projD arcPos fx nf path n)
      0 false (path 0) []

/-- The rebuild only keeps input vertices, in order. -/
theorem trimRebuild_sublist (nearLe : π → π → Bool) (path : Nat → π)
    (n : Nat) (rm : Array Bool) :
    ∀ (i : Nat) (hasPrev : Bool) (prev : π) (acc : List π), i ≤ n →
      acc.Sublist ((List.range i).map path) →
      (trimRebuild nearLe path n rm i hasPrev prev acc).Sublist
        ((List.range n).map path)
  | i, hasPrev, prev, acc, hin, hsub => by
    have hstep : ((List.range i).map path).Sublist
        ((List.range (i + 1)).map path) := by
      rw [List.range_succ, List.map_append]
      exact List.sublist_append_left _ _
    have hpush : (acc ++ [path i]).Sublist ((List.range (i + 1)).map path) := by
      rw [List.range_succ, List.map_append]
      exact List.Sublist.append hsub (List.Sublist.refl _)
    unfold trimRebuild
    split
    next _h =>
      split
      next =>
        exact trimRebuild_sublist nearLe path n rm (i + 1) _ _ _ (by omega)
          (hsub.trans hstep)
      next =>
        split
        next =>
          exact trimRebuild_sublist nearLe path n rm (i + 1) _ _ _ (by omega)
            (hsub.trans hstep)
        next =>
          exact trimRebuild_sublist nearLe path n rm (i + 1) _ _ _ (by omega)
            hpush
    next =>
      have : i = n := by omega
      subst this
      exact hsub
  termination_by i _ _ _ _ _ => n - i
  decreasing_by all_goals omega

/-- **Trim is drop-only**: the output is a subsequence of the path. -/
theorem trim_sublist (P : TrimP) (pd : π → π → Nat)
    (projD : π → π → π → Nat) (arcPos : π → π → π → Int → Int → Int)
    (nearLe : π → π → Bool) (fx : Nat → π) (nf : Nat) (path : Nat → π)
    (n : Nat) :
    (trim P pd projD arcPos nearLe fx nf path n).Sublist
      ((List.range n).map path) := by
  unfold trim
  split
  next => exact List.Sublist.refl _
  next =>
    exact trimRebuild_sublist nearLe path n _ 0 false (path 0) [] (by omega)
      (List.nil_sublist _)

-- Smoke test: an off-corridor loop the fixes never traced is excised.
-- Toy metric: taxicab distance; projection = distance to chord start;
-- arc position = chord-start arc.
private def trimPd (a b : Int × Int) : Nat :=
  (a.1 - b.1).natAbs + (a.2 - b.2).natAbs

private def trimProjD (v a _b : Int × Int) : Nat := trimPd v a

private def trimArcPos (v a b : Int × Int) (arcA arcB : Int) : Int :=
  if trimPd v b < trimPd v a then arcB else arcA

private def trimFx (i : Nat) : Int × Int :=
  match i with
  | 0 => (0, 0)
  | 1 => (10, 0)
  | 2 => (20, 0)
  | _ => (30, 0)

private def trimPath (i : Nat) : Int × Int :=
  match i with
  | 0 => (0, 0)
  | 1 => (10, 0)
  | 2 => (15, 40)
  | 3 => (20, 0)
  | _ => (30, 0)

private def trimToyP : TrimP :=
  { offM := 5, detourNum := 1, detourDen := 2, minStall := 50
    returnNum := 7, returnDen := 20, stallNum := 3, stallDen := 20
    slack := 1 }

#guard trim trimToyP trimPd trimProjD trimArcPos (fun a b => trimPd a b ≤ 0)
    trimFx 4 trimPath 5 == [(0, 0), (10, 0), (20, 0), (30, 0)]
-- A generous corridor plus an out-of-reach stall floor keeps everything
-- (the temporal pass never reads `offM`, so `minStall` is what spares it).
#guard trim { trimToyP with offM := 100, minStall := 200 } trimPd trimProjD
    trimArcPos (fun a b => trimPd a b ≤ 0) trimFx 4 trimPath 5
  == [(0, 0), (10, 0), (15, 40), (20, 0), (30, 0)]

end Verified.Geo
