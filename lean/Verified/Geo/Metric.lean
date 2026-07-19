import Verified.Geo.Simplify
import Verified.Geo.Splice
import Verified.Geo.Prefilter
import Verified.Geo.Clean
import Verified.Geo.Trim

/-!
# The pinned integer metric — V4's arithmetic substrate

The corpus-probed representation (`lean/experiments/quant-probe.mjs`,
173 walking legs / 31 golden days — see the proposal doc):

- coordinates as **1e-7° integers** (OSM-native, ~11 mm; one unit of
  latitude is exactly 11 132 µm, so the degree→metre factor is an
  integer multiply with no division);
- distances in **µm** via `isqrt` (Newton floor square root, mirroring
  the twin's BigInt loop) of the exact squared sum;
- equirectangular projection with a **Q20 fixed-point degree-6 minimax
  cos** evaluated by integer Horner — no float transcendental anywhere;
- the foot of the chord projection rounded half-away-from-zero
  (`roundDiv`), the clamp exact.

Probe verdict vs the float pipeline: max |Δdist| 38 mm, mean 0.24 mm,
zero keep-set flips on simplify-5 m / the 12 km/h speed hold / spike
rejection, and one near-threshold tie in 173 legs on the display-only
1.5 m detail tolerance.

Division semantics are part of the contract with the TS BigInt twin:
`Int.fdiv` (floor) mirrors BigInt `>>`, `Int.tdiv` (truncation toward
zero) mirrors BigInt `/` — every division below is one of the two,
chosen to match the twin expression by expression. The `#guard` vectors
at the bottom were computed by the twin arithmetic in node and pin the
two sides together until the `compare-geometry` harness lands.

This file also instantiates the metric-parametric pass layer
(`Simplify`/`Splice`/`Prefilter`) with the pinned metric, so the pass
theorems specialise for free: `qSimplify_dropped_le`,
`qSplice_sound`/`qSplice_coarse_sublist`, `qHoldSpeed_chain`.
-/

namespace Verified.Geo

/-- A quantised point: latitude/longitude in 1e-7° units, timestamp in
epoch seconds. -/
structure QPt where
  la : Int
  lo : Int
  ts : Int
  deriving BEq, Repr, Inhabited

/-- Newton floor square root, mirroring the twin's BigInt loop exactly
(`x = n; y = (n+1)/2; while (y < x) { x = y; y = (x + n/x)/2 }`). The
iterate strictly decreases, and the fixed point of the loop is
`⌊√n⌋`. -/
def isqrtGo (n x y : Nat) : Nat :=
  if _h : y < x then isqrtGo n y ((y + n / y) / 2) else x
termination_by x

/-- Integer floor square root (twin-identical). -/
def isqrt (n : Nat) : Nat :=
  if n < 2 then n else isqrtGo n n ((n + 1) / 2)

/-- Q20 fixed-point cosine of a 1e-7°-unit latitude, by integer Horner
over a degree-6 minimax polynomial (|poly err| ≈ 1e-7; the Q20 width,
not the polynomial, is the binding precision). Constants:
`19190098069 = round(π/180 · 2^40)`, coefficients `round(cᵢ · 2^20)` of
the Hastings minimax for `cos` on `[0, π/2]`;
`10485760000000 = 1e7 · 2^20`. -/
def cosQ (la : Int) : Int :=
  let x : Nat := la.natAbs * 19190098069 / 10485760000000
  let x2 : Nat := x * x / 1048576
  let s1 : Int := (-1453 * (x2 : Int)).fdiv 1048576 + 43687
  let s2 : Int := (s1 * (x2 : Int)).fdiv 1048576 + -524287
  (s2 * (x2 : Int)).fdiv 1048576 + 1048576

/-- µm between two points, cos at the mid-latitude — mirrors
`metersBetween` (`map-match-core.ts`). One latitude unit = 11 132 µm
exactly. -/
def qDist (a b : QPt) : Nat :=
  let dla : Int := (b.la - a.la) * 11132
  let c : Int := cosQ ((a.la + b.la).tdiv 2)
  let dlo : Int := ((b.lo - a.lo) * 11132 * c).fdiv 1048576
  isqrt (dla * dla + dlo * dlo).toNat

/-- µm between two points, cos at the first point — mirrors
`equirectMeters` (`episode-geometry.ts`'s variant). -/
def qDistA (a b : QPt) : Nat :=
  let dla : Int := (b.la - a.la) * 11132
  let c : Int := cosQ a.la
  let dlo : Int := ((b.lo - a.lo) * 11132 * c).fdiv 1048576
  isqrt (dla * dla + dlo * dlo).toNat

/-- `round(p/q)` half-away-from-zero for `q > 0` — the twin's
`roundDiv`. -/
def roundDiv (p q : Int) : Int :=
  if p ≥ 0 then (p + q.tdiv 2).tdiv q
  else -((-p + q.tdiv 2).tdiv q)

/-- µm from `p` to the segment `a`–`b` — mirrors `segmentDistM`:
project onto the chord in the local equirectangular frame (cos at the
chord's mid-latitude), clamp to `[0, len²]`, round the foot back to
coordinate units, and measure `qDist` to it. -/
def qChordDist (p a b : QPt) : Nat :=
  let c : Int := cosQ ((a.la + b.la).tdiv 2)
  let bx : Int := ((b.lo - a.lo) * 11132 * c).fdiv 1048576
  let vy : Int := (b.la - a.la) * 11132
  let px : Int := ((p.lo - a.lo) * 11132 * c).fdiv 1048576
  let py : Int := (p.la - a.la) * 11132
  let len2 : Int := bx * bx + vy * vy
  if len2 = 0 then qDist p a
  else
    let dot : Int := max 0 (min (px * bx + py * vy) len2)
    qDist p
      { la := a.la + roundDiv (dot * (b.la - a.la)) len2
        lo := a.lo + roundDiv (dot * (b.lo - a.lo)) len2
        ts := 0 }

/-- µm from `p` to the infinite line `a`–`b` — mirrors `perpDistM`
(`|cross| / len` with the chord-frame degenerate fallback; both the
cross and the length live in the chord's equirectangular frame). -/
def qPerp (p a b : QPt) : Nat :=
  let c : Int := cosQ ((a.la + b.la).tdiv 2)
  let bx : Int := ((b.lo - a.lo) * 11132 * c).fdiv 1048576
  let vy : Int := (b.la - a.la) * 11132
  let px : Int := ((p.lo - a.lo) * 11132 * c).fdiv 1048576
  let py : Int := (p.la - a.la) * 11132
  if bx * bx + vy * vy = 0 then isqrt (px * px + py * py).toNat
  else (px * vy - py * bx).natAbs / isqrt (bx * bx + vy * vy).toNat

/-- The TS ≥140° turn test (`acos(dot/(|u|·|v|)) ≥ 140`) as an exact
squared comparison: `dot ≤ 0 ∧ dot²·10⁹ ≥ round(cos²140°·10⁹)·|u|²·|v|²`
(`586824089 = round(cos²140° · 10⁹)`). Vectors in the TS frame — Δlon
scaled by the apex-latitude cos (Q20), Δlat by `2^20` to match.
Degenerate legs keep the vertex, like the TS `1e-12` guard. -/
def qTurnOk (a c b : QPt) : Bool :=
  let cl : Int := cosQ c.la
  let ux : Int := (c.lo - a.lo) * cl
  let uy : Int := (c.la - a.la) * 1048576
  let vx : Int := (b.lo - c.lo) * cl
  let vy : Int := (b.la - c.la) * 1048576
  let un2 : Int := ux * ux + uy * uy
  let vn2 : Int := vx * vx + vy * vy
  if un2 = 0 || vn2 = 0 then false
  else
    let dot : Int := ux * vx + uy * vy
    dot ≤ 0 && dot * dot * 1000000000 ≥ 586824089 * un2 * vn2

/-- The corridor-position arc interpolation — mirrors
`fArc[i] + proj.t · (fArc[i+1] − fArc[i])` with the clamped rational
`t = dot/len²` applied by rounded division. -/
def qArcPos (v a b : QPt) (arcA arcB : Int) : Int :=
  let c : Int := cosQ ((a.la + b.la).tdiv 2)
  let bx : Int := ((b.lo - a.lo) * 11132 * c).fdiv 1048576
  let vy : Int := (b.la - a.la) * 11132
  let px : Int := ((v.lo - a.lo) * 11132 * c).fdiv 1048576
  let py : Int := (v.la - a.la) * 11132
  let len2 : Int := bx * bx + vy * vy
  if len2 = 0 then arcA
  else arcA + roundDiv (max 0 (min (px * bx + py * vy) len2) * (arcB - arcA)) len2

-- ---------------------------------------------------------------
-- Pass instantiations: the metric-parametric layer over this metric.
-- ---------------------------------------------------------------

/-- `simplifyPath` over the pinned metric (tolerance in µm). -/
def qSimplify (pts : Nat → QPt) (n tol : Nat) : List Nat :=
  simplifyIdx qChordDist pts n tol

/-- The TS `1e-9`-degree coordinate match is exact equality at 1e-7°
resolution. -/
def qSame (a b : QPt) : Bool := a.la == b.la && a.lo == b.lo

/-- The TS `< 0.5 m` dedupe check: 500 000 µm. -/
def qNear (a b : QPt) : Bool := qDist a b < 500000

/-- The TS timestamp clamp `min(max(ts, a.ts), b.ts)`. -/
def qClampTs (a b v : QPt) : QPt := { v with ts := min (max v.ts a.ts) b.ts }

/-- `spliceRouteDetail` over the pinned metric (tolerances in µm). -/
def qSplice (route : Nat → QPt) (m : Nat) (tol dropUm : Nat)
    (coarse : Nat → QPt) (n : Nat) : List QPt :=
  splice qChordDist qSame qNear qClampTs route m tol dropUm coarse n

/-- Speed plausibility at `cap` km/h, as the exact cross-multiplied
integer form of `(d/dt)·3.6 ≤ cap`: `dt > 0 ∧ 36·d_µm ≤ cap·dt·10⁷`
(`qDistA`, because the TS predicate uses `equirectMeters`). -/
def qSpeedOk (cap : Nat) (a b : QPt) : Bool :=
  b.ts - a.ts > 0 && 36 * (qDistA a b : Int) ≤ (cap : Int) * (b.ts - a.ts) * 10000000

/-- `holdImplausibleSpeed` over the pinned metric. -/
def qHoldSpeed (cap : Nat) (fixes : Nat → QPt) (n : Nat) : List QPt :=
  holdSpeed (qSpeedOk cap) fixes n

/-- The TS spike test: `through > 3·direct ∧ through − direct > 500 m`
(5·10⁸ µm; `Nat` truncation on the difference agrees with the TS since
the first conjunct forces `through > direct`). -/
def qSpike (prev cur next : QPt) : Bool :=
  let direct := qDistA prev next
  let through := qDistA prev cur + qDistA cur next
  through > 3 * direct && through - direct > 500000000

/-- `rejectSpikes` over the pinned metric. -/
def qRejectSpikes (pts : Nat → QPt) (n : Nat) : List QPt :=
  rejectSpikes qSpike pts n

/-- `dedupeConsecutive` over the pinned metric (strict `< 0.5 m`). -/
def qDedupe (pts : Nat → QPt) (n : Nat) : List QPt :=
  dedupe (fun a b => qDist a b < 500000) pts n

/-- `removeSpurs` over the pinned metric (thresholds in µm / steps). -/
def qRemoveSpurs (retUm maxSpan : Nat) (l : List QPt) : List QPt :=
  spurGo qDist retUm maxSpan l

/-- `despikeUnsupportedApexes` over the pinned metric (µm thresholds;
the 140° turn is baked into `qTurnOk`). -/
def qDespike (minApexUm excessUm : Nat) (raw : List QPt) (path : Nat → QPt)
    (n : Nat) : List QPt :=
  despike qPerp qTurnOk (·.ts) minApexUm excessUm raw path n

/-- The TS `trimOverRouteExcursions` default thresholds, in µm. -/
def qTrimP : TrimP :=
  { offM := 30000000, detourNum := 1, detourDen := 2, minStall := 80000000
    returnNum := 7, returnDen := 20, stallNum := 3, stallDen := 20
    slack := 1000000 }

/-- The trim rebuild's `> 0.5 m` push guard (`≤` skip semantics). -/
def qNearLe (a b : QPt) : Bool := qDist a b ≤ 500000

/-- `trimOverRouteExcursions` over the pinned metric. -/
def qTrim (fx : Nat → QPt) (nf : Nat) (path : Nat → QPt) (n : Nat) :
    List QPt :=
  trim qTrimP qDist qChordDist qArcPos qNearLe fx nf path n

-- ---------------------------------------------------------------
-- The pass theorems, specialised for free.
-- ---------------------------------------------------------------

/-- The Douglas-Peucker guarantee over the pinned metric: every dropped
vertex lies within `tol` µm of the retained chord spanning it. -/
theorem qSimplify_dropped_le (pts : Nat → QPt) {n tol j : Nat} (hj : j < n)
    (hdrop : j ∉ qSimplify pts n tol) :
    ∃ p ∈ adjPairs (qSimplify pts n tol),
      p.1 < j ∧ j < p.2 ∧ qChordDist (pts j) (pts p.1) (pts p.2) ≤ tol :=
  simplifyIdx_dropped_le qChordDist pts hj hdrop

/-- Splice soundness over the pinned metric. -/
theorem qSplice_sound (route : Nat → QPt) (m : Nat) (tol dropUm : Nat)
    (coarse : Nat → QPt) (n : Nat) :
    ∀ v ∈ qSplice route m tol dropUm coarse n,
      (∃ i, i < n ∧ v = coarse i) ∨
      ∃ i j, 1 ≤ i ∧ i < n ∧ j < m ∧
        v = qClampTs (coarse (i - 1)) (coarse i) (route j) ∧
        qChordDist (route j) (coarse (i - 1)) (coarse i) ≤ dropUm :=
  splice_sound qChordDist qSame qNear qClampTs route m tol dropUm coarse n

/-- The coarse line survives splicing, in order. -/
theorem qSplice_coarse_sublist (route : Nat → QPt) (m : Nat)
    (tol dropUm : Nat) (coarse : Nat → QPt) (n : Nat) :
    ((List.range n).map coarse).Sublist (qSplice route m tol dropUm coarse n) :=
  splice_coarse_sublist qChordDist qSame qNear qClampTs route m tol dropUm
    coarse n

/-- The kinematic honesty invariant over the pinned metric: no adjacent
pair of the held output exceeds `cap` km/h in the exact integer sense. -/
theorem qHoldSpeed_chain (cap : Nat) (fixes : Nat → QPt) (n : Nat) :
    ∀ p ∈ adjPairs (qHoldSpeed cap fixes n), qSpeedOk cap p.1 p.2 = true :=
  holdSpeed_chain (qSpeedOk cap) fixes n

/-- The held output is a subsequence of the input. -/
theorem qHoldSpeed_sublist (cap : Nat) (fixes : Nat → QPt) (n : Nat) :
    (qHoldSpeed cap fixes n).Sublist ((List.range n).map fixes) :=
  holdSpeed_sublist (qSpeedOk cap) fixes n

/-- No adjacent deduped pair is within 0.5 m. -/
theorem qDedupe_chain (pts : Nat → QPt) (n : Nat) :
    ∀ p ∈ adjPairs (qDedupe pts n), (qDist p.1 p.2 < 500000 : Bool) = false :=
  dedupe_chain _ pts n

/-- The cleaning passes are drop-only over the pinned metric. -/
theorem qDedupe_sublist (pts : Nat → QPt) (n : Nat) :
    (qDedupe pts n).Sublist ((List.range n).map pts) :=
  dedupe_sublist _ pts n

theorem qRemoveSpurs_sublist (retUm maxSpan : Nat) (l : List QPt) :
    (qRemoveSpurs retUm maxSpan l).Sublist l :=
  spurGo_sublist qDist retUm maxSpan l

theorem qDespike_sublist (minApexUm excessUm : Nat) (raw : List QPt)
    (path : Nat → QPt) (n : Nat) :
    (qDespike minApexUm excessUm raw path n).Sublist
      ((List.range n).map path) :=
  despike_sublist qPerp qTurnOk (·.ts) minApexUm excessUm raw path n

theorem qTrim_sublist (fx : Nat → QPt) (nf : Nat) (path : Nat → QPt)
    (n : Nat) :
    (qTrim fx nf path n).Sublist ((List.range n).map path) :=
  trim_sublist qTrimP qDist qChordDist qArcPos qNearLe fx nf path n

-- ---------------------------------------------------------------
-- Cross-language pin: values computed by the BigInt twin arithmetic
-- (node; see the module docstring). London test points.
-- ---------------------------------------------------------------

#guard cosQ 515074000 == 652636
#guard cosQ (-515074000) == 652636
#guard cosQ 0 == 1048576
#guard cosQ 600000000 == 524251

private def qTestA : QPt := ⟨515074000, -1278000, 0⟩
private def qTestB : QPt := ⟨515150000, -1300000, 60⟩
private def qTestP : QPt := ⟨515120000, -1400000, 30⟩

#guard qDist qTestA qTestB == 859651577
#guard qDistA qTestA qTestB == 859653814
#guard qChordDist qTestP qTestA qTestB == 741016794
#guard qChordDist qTestP qTestA qTestA == 988259894

-- A straight three-point line simplifies to its endpoints; a genuinely
-- bent one keeps its apex (5 m tolerance, i.e. 5·10⁶ µm).
private def qLine (i : Nat) : QPt :=
  match i with
  | 0 => ⟨515074000, -1278000, 0⟩
  | 1 => ⟨515074500, -1278000, 10⟩
  | _ => ⟨515075000, -1278000, 20⟩

private def qBent (i : Nat) : QPt :=
  match i with
  | 0 => ⟨515074000, -1278000, 0⟩
  | 1 => ⟨515074500, -1279500, 10⟩
  | _ => ⟨515075000, -1278000, 20⟩

#guard qSimplify qLine 3 5000000 == [0, 2]
#guard qSimplify qBent 3 5000000 == [0, 1, 2]

end Verified.Geo
