import Verified.Geo.CellKey

/-!
# Expanding-ring search exactness — `SegmentNearGrid`'s comment-proof

`src/geo/map-match-core.ts`'s `SegmentNearGrid.nearestDist` claims to be
EXACT, not approximate: it scans grid rings outward and stops as soon as
`(k − 1.5)·cell ≥ min(best, clamp)`, arguing that an unscanned chord's
rasterised samples are all ≥ `(k−1)·cell` away, its true distance is
within `cell/4` of a sample, and the remaining `0.25·cell` margin absorbs
the equirectangular cos drift. That compound inequality is load-bearing —
if the margin were wrong, the matcher would silently return a
farther-than-nearest chord — and this file makes the *argument* a
theorem.

The model abstracts exactly the parts the argument doesn't depend on:

* distances are `Int` (the substrate convention — quantised integers,
  like V2 scores and V3 edge weights);
* the stop-margin curve is an abstract `bound : Nat → Int` (TS:
  `(k − 3/2)·cellM`), and the whole geometric chain above is condensed
  into one named hypothesis `hgeom`: *a chord all of whose registered
  cells sit at Chebyshev ≥ k from the query cell is at least `bound k`
  away*. Discharging `hgeom` (rasterisation spacing, in-cell offset, cos
  drift) is the future analytic substrate's job; the search logic is
  proved correct against it today;
* per-ring bucket order, the bucket lists, and the seen-set dedup are
  dropped: `min` is associative/commutative/idempotent, so probing each
  ring's chords in any order (or repeatedly) computes the same value.
  `best` carries `min(best, clamp)` from the start, which is how the TS
  stop condition and return value read it.

`ringSearch_exact`: under `hgeom`, every-chord-registers-a-cell
(`hcover`, the TS rasteriser emits ≥ 1 sample per chord), and
every-cell-within-`maxK` (`hmaxK`, TS derives `maxK` from the occupied
bounding box), the staged early-stopping search equals the clamped
minimum over **all** chords.
-/

namespace Verified.Geo

/-- Chebyshev distance between grid cells — ring `k` is the cells at
exactly this distance from the query cell. -/
def cheby (a b : Int × Int) : Nat :=
  Nat.max (a.1 - b.1).natAbs (a.2 - b.2).natAbs

/-- The ring-search instance: `n` chords, each with its registered grid
cells; abstract exact distances; the stop-margin curve; the clamp. -/
structure RingProblem where
  n : Nat
  cells : Nat → List (Int × Int)
  qcell : Int × Int
  dist : Nat → Int
  bound : Nat → Int
  clamp : Int
  maxK : Nat

/-- Chord `i` has a registered cell on ring `k`. -/
def onRing (P : RingProblem) (i k : Nat) : Bool :=
  (P.cells i).any fun c => cheby c P.qcell == k

/-- Probe every chord on ring `k`. -/
def ringStep (P : RingProblem) (k : Nat) (b : Int) : Int :=
  (List.range P.n).foldl (fun b i => if onRing P i k then min b (P.dist i) else b) b

/-- The staged search: stop past the bounding box, or as soon as the
ring floor reaches the current best (the TS `(k − 1.5)·cell ≥
min(best, clamp)` break, with `b` carrying the min). -/
def scan (P : RingProblem) : Nat → Nat → Int → Int
  | 0, _, b => b
  | fuel + 1, k, b =>
    if k > P.maxK then b
    else if b ≤ P.bound k then b
    else scan P fuel (k + 1) (ringStep P k b)

def ringSearch (P : RingProblem) : Int := scan P (P.maxK + 2) 0 P.clamp

/-- What exactness means: the clamped minimum over every chord. -/
def clampedMin (P : RingProblem) : Int :=
  (List.range P.n).foldl (fun b i => min b (P.dist i)) P.clamp

/-! ## Fold bounds -/

private theorem foldl_min_le_init (f : Nat → Int) :
    ∀ (l : List Nat) (b : Int), l.foldl (fun b i => min b (f i)) b ≤ b := by
  intro l
  induction l with
  | nil => exact fun b => Int.le_refl b
  | cons x l ih =>
    intro b
    rw [List.foldl_cons]
    exact Int.le_trans (ih _) (Int.min_le_left _ _)

private theorem foldl_min_le_mem (f : Nat → Int) :
    ∀ (l : List Nat) (b : Int) (i : Nat), i ∈ l → l.foldl (fun b i => min b (f i)) b ≤ f i := by
  intro l
  induction l with
  | nil => intro _ _ h; cases h
  | cons x l ih =>
    intro b i hmem
    rw [List.foldl_cons]
    rcases List.mem_cons.mp hmem with rfl | ht
    · exact Int.le_trans (foldl_min_le_init f l _) (Int.min_le_right _ _)
    · exact ih _ i ht

private theorem le_foldl_min (f : Nat → Int) :
    ∀ (l : List Nat) (b c : Int), c ≤ b → (∀ i ∈ l, c ≤ f i) →
      c ≤ l.foldl (fun b i => min b (f i)) b := by
  intro l
  induction l with
  | nil => exact fun _ _ h _ => h
  | cons x l ih =>
    intro b c hb hall
    rw [List.foldl_cons]
    exact ih _ c (by have := hall x (.head _); omega) fun i hi => hall i (.tail _ hi)

/- The same three bounds for the conditional (per-ring) fold. -/

private theorem cfoldl_le_init (f : Nat → Int) (p : Nat → Bool) :
    ∀ (l : List Nat) (b : Int),
      l.foldl (fun b i => if p i then min b (f i) else b) b ≤ b := by
  intro l
  induction l with
  | nil => exact fun b => Int.le_refl b
  | cons x l ih =>
    intro b
    rw [List.foldl_cons]
    by_cases hp : p x = true
    · rw [if_pos hp]
      exact Int.le_trans (ih _) (Int.min_le_left _ _)
    · rw [if_neg hp]
      exact ih _

private theorem cfoldl_le_mem (f : Nat → Int) (p : Nat → Bool) :
    ∀ (l : List Nat) (b : Int) (i : Nat), i ∈ l → p i = true →
      l.foldl (fun b i => if p i then min b (f i) else b) b ≤ f i := by
  intro l
  induction l with
  | nil => intro _ _ h; cases h
  | cons x l ih =>
    intro b i hmem hp
    rw [List.foldl_cons]
    rcases List.mem_cons.mp hmem with rfl | ht
    · rw [if_pos hp]
      exact Int.le_trans (cfoldl_le_init f p l _) (Int.min_le_right _ _)
    · exact ih _ i ht hp

private theorem le_cfoldl (f : Nat → Int) (p : Nat → Bool) :
    ∀ (l : List Nat) (b c : Int), c ≤ b → (∀ i ∈ l, c ≤ f i) →
      c ≤ l.foldl (fun b i => if p i then min b (f i) else b) b := by
  intro l
  induction l with
  | nil => exact fun _ _ h _ => h
  | cons x l ih =>
    intro b c hb hall
    rw [List.foldl_cons]
    by_cases hp : p x = true
    · rw [if_pos hp]
      exact ih _ c (by have := hall x (.head _); omega) fun i hi => hall i (.tail _ hi)
    · rw [if_neg hp]
      exact ih _ c hb fun i hi => hall i (.tail _ hi)

/-! ## The exactness theorem -/

/-- Loop invariant, run to completion. `b` is squeezed between the goal
(`clampedMin ≤ b`) and the certificates that everything relevant is
already inside it: `b ≤ clamp`, and every chord that has shown a cell on
a scanned ring is `≥ b`. At either exit the two directions meet. -/
private theorem scan_exact (P : RingProblem)
    (hgeom : ∀ i < P.n, ∀ k : Nat,
      (∀ c ∈ P.cells i, k ≤ cheby c P.qcell) → P.bound k ≤ P.dist i)
    (hcover : ∀ i < P.n, P.cells i ≠ [])
    (hmaxK : ∀ i < P.n, ∀ c ∈ P.cells i, cheby c P.qcell ≤ P.maxK) :
    ∀ (fuel k : Nat) (b : Int), P.maxK + 2 ≤ fuel + k →
      clampedMin P ≤ b → b ≤ P.clamp →
      (∀ i < P.n, (∃ c ∈ P.cells i, cheby c P.qcell < k) → b ≤ P.dist i) →
      scan P fuel k b = clampedMin P := by
  intro fuel
  induction fuel with
  | zero =>
    -- Fuel can only run out past the bounding box: every chord has been
    -- probed, so `b` already is the clamped minimum.
    intro k b hfuel hlow hclamp hdone
    have hball : ∀ i < P.n, b ≤ P.dist i := by
      intro i hi
      cases hc : P.cells i with
      | nil => exact absurd hc (hcover i hi)
      | cons c cs =>
        refine hdone i hi ⟨c, by rw [hc]; exact .head _, ?_⟩
        have := hmaxK i hi c (by rw [hc]; exact .head _)
        omega
    exact Int.le_antisymm
      (le_foldl_min P.dist (List.range P.n) P.clamp b hclamp
        (fun i hi => hball i (List.mem_range.mp hi)))
      hlow
  | succ fuel ih =>
    intro k b hfuel hlow hclamp hdone
    simp only [scan]
    by_cases hk : k > P.maxK
    · -- Past the bounding box: as in the fuel-out case.
      rw [if_pos hk]
      have hball : ∀ i < P.n, b ≤ P.dist i := by
        intro i hi
        cases hc : P.cells i with
        | nil => exact absurd hc (hcover i hi)
        | cons c cs =>
          refine hdone i hi ⟨c, by rw [hc]; exact .head _, ?_⟩
          have := hmaxK i hi c (by rw [hc]; exact .head _)
          omega
      exact Int.le_antisymm
        (le_foldl_min P.dist (List.range P.n) P.clamp b hclamp
          (fun i hi => hball i (List.mem_range.mp hi)))
        hlow
    · rw [if_neg hk]
      by_cases hstop : b ≤ P.bound k
      · -- Early stop: scanned chords are ≥ b by the invariant; unscanned
        -- chords are ≥ bound k ≥ b by the geometric hypothesis. Exact.
        rw [if_pos hstop]
        have hball : ∀ i < P.n, b ≤ P.dist i := by
          intro i hi
          by_cases hp : ∃ c ∈ P.cells i, cheby c P.qcell < k
          · exact hdone i hi hp
          · have hfar : ∀ c ∈ P.cells i, k ≤ cheby c P.qcell := fun c hc =>
              Nat.le_of_not_lt fun hlt => hp ⟨c, hc, hlt⟩
            have := hgeom i hi k hfar
            omega
        exact Int.le_antisymm
          (le_foldl_min P.dist (List.range P.n) P.clamp b hclamp
            (fun i hi => hball i (List.mem_range.mp hi)))
          hlow
      · -- Scan ring k and continue; re-establish every invariant.
        rw [if_neg hstop]
        refine ih (k + 1) (ringStep P k b) (by omega) ?_ ?_ ?_
        · -- clampedMin still below: it is below b and every distance.
          exact le_cfoldl P.dist (onRing P · k) (List.range P.n) b _ hlow
            fun i hi => foldl_min_le_mem P.dist (List.range P.n) P.clamp i hi
        · exact Int.le_trans (cfoldl_le_init P.dist (onRing P · k) (List.range P.n) b) hclamp
        · -- Chords seen on rings < k+1: previously seen ones stay ≥ the
          -- (only smaller) new b; ring-k ones were just probed.
          intro i hi hex
          by_cases hp : ∃ c ∈ P.cells i, cheby c P.qcell < k
          · exact Int.le_trans
              (cfoldl_le_init P.dist (onRing P · k) (List.range P.n) b)
              (hdone i hi hp)
          · obtain ⟨c, hc, hck⟩ := hex
            have hfar : ∀ c' ∈ P.cells i, k ≤ cheby c' P.qcell := fun c' hc' =>
              Nat.le_of_not_lt fun hlt => hp ⟨c', hc', hlt⟩
            have heq : cheby c P.qcell = k := by
              have := hfar c hc
              omega
            have hon : onRing P i k = true := by
              rw [onRing, List.any_eq_true]
              exact ⟨c, hc, by rw [heq]; simp⟩
            exact cfoldl_le_mem P.dist (onRing P · k) (List.range P.n) b i
              (List.mem_range.mpr hi) hon

/-- **The `SegmentNearGrid` comment-proof, as a theorem.** Under the
geometric floor (`hgeom`), full rasterisation coverage (`hcover`), and a
bounding-box `maxK` (`hmaxK`), the early-stopping ring search returns
exactly the clamped minimum distance over all chords — the stop margin
loses nothing. -/
theorem ringSearch_exact (P : RingProblem)
    (hgeom : ∀ i < P.n, ∀ k : Nat,
      (∀ c ∈ P.cells i, k ≤ cheby c P.qcell) → P.bound k ≤ P.dist i)
    (hcover : ∀ i < P.n, P.cells i ≠ [])
    (hmaxK : ∀ i < P.n, ∀ c ∈ P.cells i, cheby c P.qcell ≤ P.maxK) :
    ringSearch P = clampedMin P := by
  refine scan_exact P hgeom hcover hmaxK (P.maxK + 2) 0 P.clamp (by omega)
    (foldl_min_le_init P.dist (List.range P.n) P.clamp) (Int.le_refl _) ?_
  intro i _ hex
  obtain ⟨c, _, hck⟩ := hex
  omega

/-! ## Executable sanity: a concrete instance where the early stop fires -/

/-- Three chords around the origin cell: one adjacent (ring 1, dist 3),
one at ring 2 (dist 9), one far out at ring 5 (dist 21). With
`bound k = 4k − 6` (a toy `(k − 1.5)·cell` at cell = 4), the search
stops at ring 3 (`bound 3 = 6 ≥ 3`) without ever probing the far chord —
and still returns the exact minimum. -/
private def toy : RingProblem where
  n := 3
  cells := fun i =>
    if i == 0 then [(1, 0), (1, 1)]
    else if i == 1 then [(0, 2), (1, 2)]
    else [(5, 3), (4, 3)]
  qcell := (0, 0)
  dist := fun i => if i == 0 then 3 else if i == 1 then 9 else 21
  bound := fun k => 4 * (k : Int) - 6
  clamp := 100
  maxK := 6

#guard ringSearch toy == 3
#guard ringSearch toy == clampedMin toy
-- The stop really does fire early: with fuel for rings 0–3 only, the
-- result is already final (ring 4+ never runs)…
#guard scan toy 4 0 toy.clamp == 3
-- …and the clamp path is exact too.
#guard ringSearch { toy with clamp := 2 } == 2

end Verified.Geo
