import Verified.Hsmm.Ckpt
import Verified.ArrayLoop
import Std.Data.HashMap

/-!
# Packed scores: trellis cells as unboxed `Nat` scalars

`decodeCk` fixed the memory profile but not the arithmetic: Lean's runtime
boxes any `Int` outside 32-bit, and this model's quantised scores live far
outside it (soft `-∞` penalty cells reach ~-8·10¹³; even ordinary path sums
pass -10¹⁰), so nearly every `Score.add`/`max` in the `O(T·S·(S+maxD))`
forward pass is a GMP allocation.

The fix is a second, *exact* representation: a score `v` is stored as the
`Nat` `v + pOff` (and `-∞` as `0`), which stays below `2^63` — Lean `Nat`
scalars — for every value this decoder can produce, provided the inputs are
bounded (`|v| ≤ pEB` for emissions, `≤ pOB` for the other tensors) and the
day is bounded (`T ≤ pTMax`). Both are checked
by the CLI, which refuses rather than decode outside the proven envelope.
There is **no approximation**: `pAdd`/`Nat.max` are proved to *be* score
addition and maximum through the encoding (`enc_add`, `enc_max`), given the
magnitude bound that `col_bounded` establishes for every trellis cell by
induction on the recurrence.

The decoder over this encoding is `ByStart.sDecode`, proved equal to `decode`
under the envelope hypotheses (`sDecode_eq`), so `decode_correct` transfers
as `sDecode_correct`.
-/

namespace Verified.Hsmm

/-- The encoding offset, `2^61`. A numeral so `omega` can compute with it.
`@[noinline]` keeps the compiler from inlining the literal into `pAdd`/`dec`,
where its per-call rematerialisation (`lean_cstr_to_nat` — a GMP *string
parse*) would dominate the whole decode. -/
@[noinline] def pOff : Nat := 2305843009213693952
#guard pOff = 2 ^ 61

/-- Emission magnitude bound, `2^49`. Emissions carry the model's soft-`-∞`
penalty cells (measured ≈2^48.3 on real days ×2²⁰-quantised) and are the one
tensor a path pays every minute. -/
@[noinline] def pEB : Nat := 562949953421312
#guard pEB = 2 ^ 49

/-- Magnitude bound for every other tensor (trans/dur/init/entry), `2^45`
(measured ≈2^24 on real days). -/
@[noinline] def pOB : Nat := 35184372088832
#guard pOB = 2 ^ 45

/-- Day-length bound: `T ≤ pTMax` keeps every accumulated cell below
`pTMax·pEB + (3·pTMax+4)·pOB < 2^61 = pOff`, so encodings stay `Nat`
scalars and never collide with the `-∞` encoding. -/
def pTMax : Nat := 2048
#guard pTMax = 2 ^ 11

/-- `|v| ≤ M` (with `-∞` unconditionally in bounds). -/
def Bounded (M : Nat) : Score → Prop
  | .negInf => True
  | .val v => v.natAbs ≤ M

theorem Bounded.mono {M M' : Nat} (h : M ≤ M') : ∀ {x}, Bounded M x → Bounded M' x
  | .negInf, _ => trivial
  | .val v, hx => by simp only [Bounded] at hx ⊢; omega

theorem Bounded.add {M1 M2 : Nat} :
    ∀ {x y}, Bounded M1 x → Bounded M2 y → Bounded (M1 + M2) (x + y)
  | .negInf, _, _, _ => trivial
  | .val _, .negInf, _, _ => trivial
  | .val a, .val b, hx, hy => by
    simp only [Score.val_add_val, Bounded] at hx hy ⊢
    omega

theorem Bounded.max {M : Nat} {x y : Score} (hx : Bounded M x) (hy : Bounded M y) :
    Bounded M (Score.max x y) := by
  rcases Score.max_eq_or x y with h | h <;> rw [h] <;> assumption

theorem Bounded.listMax {M : Nat} :
    ∀ {l : List Score}, (∀ x ∈ l, Bounded M x) → Bounded M (Score.listMax l)
  | [], _ => trivial
  | y :: ys, h => by
    rw [Score.listMax_cons]
    exact Bounded.max (h y (List.mem_cons_self ..))
      (Bounded.listMax fun x hx => h x (List.mem_cons_of_mem _ hx))

theorem Bounded.rangeMax {M : Nat} {f : Nat → Score} :
    ∀ {n}, (∀ i, i < n → Bounded M (f i)) → Bounded M (rangeMax f n)
  | 0, _ => trivial
  | n + 1, h => by
    rw [Verified.Hsmm.rangeMax]
    exact Bounded.max (Bounded.rangeMax fun i hi => h i (by omega)) (h n (by omega))

/-- Every model tensor value is within its envelope bound (or `-∞`). -/
structure InBounds (P : Problem) : Prop where
  emit : ∀ t s, Bounded pEB (P.emit t s)
  trans : ∀ sp s t, Bounded pOB (P.trans sp s t)
  dur : ∀ s d e, Bounded pOB (P.dur s d e)
  init : ∀ s, Bounded pOB (P.init s)
  entry : ∀ s t, Bounded pOB (P.entry s t)

/-- Cell growth: a cell at time `t` sums at most `t+1` emissions and `3t+4`
other-tensor values. -/
def colB (t : Nat) : Nat := (t + 1) * pEB + (3 * t + 4) * pOB

theorem col_bounded {P : Problem} (hin : InBounds P) :
    ∀ t s τ, Bounded (colB t) (col P t s τ)
  | 0, s, τ => by
    rw [col]
    by_cases h1 : τ = 1
    · rw [if_pos h1]
      exact (((hin.init s).add (hin.entry s 0)).add (hin.emit 0 s)).mono
        (by simp only [colB, pEB, pOB]; omega)
    · rw [if_neg h1]; trivial
  | t + 1, s, τ => by
    rw [col]
    by_cases h1 : τ = 1
    · rw [if_pos h1]
      have houter : Bounded (colB t + pOB + pOB)
          (Score.listMax ((List.range P.S).flatMap fun sp =>
            if sp == s then []
            else
              [Score.listMax ((List.range P.maxD).map fun t0 =>
                  col P t sp (t0 + 1) + P.dur sp (t0 + 1) t)
                + P.trans sp s (t + 1)])) := by
        apply Bounded.listMax
        intro x hx
        simp only [List.mem_flatMap, List.mem_range] at hx
        obtain ⟨sp, _, hx2⟩ := hx
        cases hb : sp == s <;> rw [hb] at hx2
        · simp only [Bool.false_eq_true, if_false, List.mem_singleton] at hx2
          subst hx2
          refine Bounded.add (Bounded.listMax ?_) (hin.trans sp s (t + 1))
          intro y hy
          simp only [List.mem_map, List.mem_range] at hy
          obtain ⟨τ0, _, rfl⟩ := hy
          exact (col_bounded hin t sp (τ0 + 1)).add (hin.dur sp (τ0 + 1) t)
        · simp at hx2
      exact ((houter.add (hin.entry s (t + 1))).add (hin.emit (t + 1) s)).mono
        (by simp only [colB, pEB, pOB]; omega)
    · rw [if_neg h1]
      by_cases h2 : 2 ≤ τ ∧ τ ≤ P.maxD
      · rw [if_pos h2]
        exact ((col_bounded hin t s (τ - 1)).add (hin.emit (t + 1) s)).mono
          (by simp only [colB, pEB, pOB]; omega)
      · rw [if_neg h2]; trivial

/-! ## The encoding -/

/-- Encode: `-∞ ↦ 0`, `v ↦ v + pOff`. Bounded scores land in
`[pOff - M, pOff + M]` — well inside `Nat` scalar range. -/
def enc : Score → Nat
  | .negInf => 0
  | .val v => (v + (pOff : Int)).toNat

/-- Decode. Total inverse of `enc` on valid encodings. -/
def dec (n : Nat) : Score := if n = 0 then .negInf else .val ((n : Int) - (pOff : Int))

theorem enc_dec (n : Nat) : enc (dec n) = n := by
  by_cases h : n = 0
  · subst h; rfl
  · simp only [dec, if_neg h, enc]
    omega

theorem dec_enc {M : Nat} (hM : M < pOff) : ∀ {x}, Bounded M x → dec (enc x) = x
  | .negInf, _ => rfl
  | .val v, hx => by
    simp only [Bounded] at hx
    simp only [enc, dec]
    rw [if_neg (by omega)]
    congr 1
    omega

/-- Packed addition: `0` absorbs; otherwise shift one offset back out. -/
@[inline] def pAdd (a b : Nat) : Nat := if a = 0 ∨ b = 0 then 0 else a + b - pOff

theorem enc_add {M1 M2 : Nat} (hM : M1 + M2 < pOff) :
    ∀ {x y}, Bounded M1 x → Bounded M2 y → enc (x + y) = pAdd (enc x) (enc y)
  | .negInf, _, _, _ => by simp [enc, pAdd, Score.negInf_add]
  | .val a, .negInf, _, _ => by simp [enc, pAdd, Score.add_negInf]
  | .val a, .val b, hx, hy => by
    simp only [Bounded] at hx hy
    simp only [Score.val_add_val, enc, pAdd]
    rw [if_neg (by omega)]
    omega

/-- The encoding is a `max`-homomorphism *unconditionally*: `enc` is monotone
even where it clamps (`v < -pOff` collides with `-∞`, but monotonely so). -/
theorem enc_max : ∀ (x y : Score), enc (Score.max x y) = max (enc x) (enc y)
  | .negInf, y => by
    have h : Score.max .negInf y = y := Score.negInf_max y
    rw [h]
    cases y with
    | negInf => rfl
    | val v => simp only [enc, Nat.zero_max]
  | .val a, .negInf => by
    have h : Score.max (.val a) .negInf = .val a := Score.max_negInf _
    rw [h]
    simp only [enc, Nat.max_zero]
  | .val a, .val b => by
    simp only [Score.max, Score.ble]
    by_cases hab : a ≤ b
    · rw [if_pos (by simpa using hab)]
      simp only [enc]
      rw [Nat.max_def]
      split <;> omega
    · rw [if_neg (by simpa using hab)]
      simp only [enc]
      rw [Nat.max_def]
      split <;> omega

/-- Packed `rangeMax`: `Nat` maximum with base `0 = enc -∞`. `@[specialize]`
compiles a per-call-site copy with the element function inlined — the fold
runs 50M+ times per day-scale decode. -/
@[specialize] def pRangeMax (f : Nat → Nat) : Nat → Nat
  | 0 => 0
  | n + 1 => max (pRangeMax f n) (f n)

/-- `pRangeMax` as a loop: the maximum so far travels in the accumulator, so
the fold is one tail call per element where `pRangeMax` is one stack frame per
element, `maxD` deep, for every state at every minute (the decode phase's
hottest symbol). `pRangeMaxL_eq` is the exactness: the same maximum. -/
@[specialize] def pRangeMaxGo (f : Nat → Nat) (n : Nat) (i acc : Nat) : Nat :=
  if h : i < n then pRangeMaxGo f n (i + 1) (max acc (f i)) else acc
termination_by n - i

theorem pRangeMaxGo_eq (f : Nat → Nat) (n : Nat) :
    ∀ k i, n - i = k → i ≤ n → pRangeMaxGo f n i (pRangeMax f i) = pRangeMax f n
  | 0, i, hk, hi => by
    have hin : i = n := by omega
    subst hin
    unfold pRangeMaxGo
    simp
  | k + 1, i, hk, hi => by
    have hlt : i < n := by omega
    unfold pRangeMaxGo
    rw [dif_pos hlt]
    exact pRangeMaxGo_eq f n k (i + 1) (by omega) (by omega)

/-- The loop form of `pRangeMax`, for the decoder's hot loops. -/
@[inline] def pRangeMaxL (f : Nat → Nat) (n : Nat) : Nat := pRangeMaxGo f n 0 0

theorem pRangeMaxL_eq (f : Nat → Nat) (n : Nat) : pRangeMaxL f n = pRangeMax f n :=
  pRangeMaxGo_eq f n n 0 (by omega) (by omega)

theorem enc_rangeMax {f : Nat → Score} {g : Nat → Nat} :
    ∀ {n}, (∀ i, i < n → g i = enc (f i)) → pRangeMax g n = enc (rangeMax f n)
  | 0, _ => rfl
  | n + 1, h => by
    rw [pRangeMax, Verified.Hsmm.rangeMax, enc_max,
      enc_rangeMax (fun i hi => h i (by omega)), h n (by omega)]

/-! ## The packed model -/

/-- The packed model: dimensions plus `enc`-valued tensors. At runtime these
closures read pre-encoded `Array Nat`s — every score op from here on is `Nat`
scalar arithmetic. -/
structure PModel where
  T : Nat
  S : Nat
  maxD : Nat
  emit : Nat → Nat → Nat        -- t s
  trans : Nat → Nat → Nat → Nat -- sp s t
  dur : Nat → Nat → Nat → Nat   -- s d e
  init : Nat → Nat
  entry : Nat → Nat → Nat       -- s t

/-- `m` is the `enc`-image of `P`. -/
structure Agrees (m : PModel) (P : Problem) : Prop where
  T : m.T = P.T
  S : m.S = P.S
  maxD : m.maxD = P.maxD
  emit : ∀ t s, m.emit t s = enc (P.emit t s)
  trans : ∀ sp s t, m.trans sp s t = enc (P.trans sp s t)
  dur : ∀ s d e, m.dur s d e = enc (P.dur s d e)
  init : ∀ s, m.init s = enc (P.init s)
  entry : ∀ s t, m.entry s t = enc (P.entry s t)

/-! ## Two models that agree up to a minute

The decoder's rows up to minute `f` read the emissions, entries and transitions
at `f` or before and the duration cells ending before `f`, and nothing later.
So two models that agree up to `f` build the same rows up to `f`
(`ByStart.sBuild_agree`): what an incremental decode of a day whose inputs
changed from `f` on reuses (docs/proposals/2026-11-incremental-today.md). -/

/-- `m₁` and `m₂` agree on everything the rows up to `f` read. -/
structure AgreeTo (m₁ m₂ : PModel) (f : Nat) : Prop where
  S : m₁.S = m₂.S
  maxD : m₁.maxD = m₂.maxD
  init : ∀ s, m₁.init s = m₂.init s
  emit : ∀ t s, t ≤ f → m₁.emit t s = m₂.emit t s
  entry : ∀ s t, t ≤ f → m₁.entry s t = m₂.entry s t
  trans : ∀ sp s t, t ≤ f → m₁.trans sp s t = m₂.trans sp s t
  dur : ∀ s d e, e < f → m₁.dur s d e = m₂.dur s d e

theorem pRangeMax_congr {f g : Nat → Nat} : ∀ n, (∀ i, i < n → f i = g i) →
    pRangeMax f n = pRangeMax g n
  | 0 => fun _ => rfl
  | n + 1 => fun h => by
    simp only [pRangeMax, pRangeMax_congr n (fun i hi => h i (by omega)), h n (by omega)]

/-! ## Fast path: flat-array data model

`PModel` stores its tensors as `Nat → … → Nat` *closure fields*, which the
compiler cannot inline. `PData` stores the same pre-encoded tensors as flat
`Array Nat`s read through monomorphic top-level accessors — so the hot loop is
direct, inlinable calls. `toModel` is the `PModel` a `PData` denotes (its
accessors wrapped as fields), which the theorems are stated about. -/

structure PData where
  T : Nat
  S : Nat
  maxD : Nat
  halfOB : Nat
  emit : Array Nat
  entry : Array Nat
  init : Array Nat
  transBase : Array Nat
  nTB : Nat
  transIdx : Array Nat
  transFlat : Array Nat
  nRows : Nat
  durBase : Array Nat
  durClass : Array Nat
  durDelta : Array Nat
  hasOv : Array Bool
  durOv : Std.HashMap Nat Nat

@[inline] def PData.emitAt (d : PData) (t s : Nat) : Nat := d.emit.getD (t * d.S + s) 0
@[inline] def PData.entryAt (d : PData) (s t : Nat) : Nat :=
  if d.entry.isEmpty then pOff else d.entry.getD (t * d.S + s) pOff
@[inline] def PData.initAt (d : PData) (s : Nat) : Nat :=
  if d.init.isEmpty then pOff else d.init.getD s pOff
@[inline] def PData.transAt (d : PData) (sp s t : Nat) : Nat :=
  let i := d.transIdx.getD (sp * d.S + s) d.nRows
  if i < d.nRows then d.transFlat.getD (i * d.T + t) 0
  else d.transBase.getD ((if d.nTB == 1 then 0 else t) * (d.S * d.S) + sp * d.S + s) 0
/-- The cells before end minute `e` in one class's `durDelta`: a segment ending
    at `e'` has `min maxD (e' + 1)` lengths, since none starts before the day. -/
@[inline] def triOff (maxD e : Nat) : Nat :=
  if e ≤ maxD then e * (e + 1) / 2 else maxD * (maxD + 1) / 2 + (e - maxD) * maxD

@[inline] def PData.durAt (d : PData) (s dd e : Nat) : Nat :=
  if dd == 0 then 0
  else if !d.durClass.isEmpty then
    let b := d.durBase.getD (s * d.maxD + (dd - 1)) 0
    if b == 0 then 0
    -- A segment that would start before the day: no run reaches it, so it
    -- is not stored.
    else if dd > e + 1 then b
    -- `durDelta` by class, end minute, then length: the close loop walks
    -- consecutive lengths at one end, so they sit side by side.
    else b + d.durDelta.getD (d.durClass.getD s 0 * triOff d.maxD d.T + triOff d.maxD e + (dd - 1)) d.halfOB - d.halfOB
  else if d.hasOv.getD (s * d.maxD + (dd - 1)) false then
    d.durOv.getD ((s * d.maxD + (dd - 1)) * d.T + e) (d.durBase.getD (s * d.maxD + (dd - 1)) 0)
  else d.durBase.getD (s * d.maxD + (dd - 1)) 0

/-- The `PModel` a `PData` denotes: each accessor as a field closure that
β-reduces to it, so a hypothesis about the model is one about the accessors. -/
def toModel (d : PData) : PModel where
  T := d.T
  S := d.S
  maxD := d.maxD
  emit := fun t s => d.emitAt t s
  trans := fun sp s t => d.transAt sp s t
  dur := fun s dd e => d.durAt s dd e
  init := fun s => d.initAt s
  entry := fun s t => d.entryAt s t

end Verified.Hsmm
