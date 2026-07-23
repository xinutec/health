import Verified.Hsmm.Ckpt
import Std.Data.HashMap

/-!
# Packed scores: trellis columns as unboxed `Nat` scalars

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

The decoder `decodeP` mirrors `decodeCk` cell-for-cell on packed columns;
`decodeP_eq` proves it equal to `decode` (hence `decodeFast`, `decodeCk`)
under the envelope hypotheses, so `decode_correct`/`decode_none_iff`
transfer as `decodeP_correct`/`decodeP_none_iff`.
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
def pEB : Nat := 562949953421312
#guard pEB = 2 ^ 49

/-- Magnitude bound for every other tensor (trans/dur/init/entry), `2^45`
(measured ≈2^24 on real days). -/
def pOB : Nat := 35184372088832
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

theorem enc_rangeMax {f : Nat → Score} {g : Nat → Nat} :
    ∀ {n}, (∀ i, i < n → g i = enc (f i)) → pRangeMax g n = enc (rangeMax f n)
  | 0, _ => rfl
  | n + 1, h => by
    rw [pRangeMax, Verified.Hsmm.rangeMax, enc_max,
      enc_rangeMax (fun i hi => h i (by omega)), h n (by omega)]

/-! ## The packed model and columns -/

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

/-- Packed `col0`. -/
def pCol0 (m : PModel) : Array Nat :=
  Array.ofFn (n := m.S * m.maxD) fun i =>
    if i.val % m.maxD = 0 then
      pAdd (pAdd (m.init (i.val / m.maxD)) (m.entry (i.val / m.maxD) 0))
        (m.emit 0 (i.val / m.maxD))
    else 0

/-- Packed `closeRowF`. -/
def pCloseRow (m : PModel) (t : Nat) (prev : Array Nat) : Array Nat :=
  Array.ofFn (n := m.S) fun sp =>
    pRangeMax (fun τ0 => pAdd prev[sp.val * m.maxD + τ0]! (m.dur sp.val (τ0 + 1) t)) m.maxD

/-- Packed `colStepF`. -/
def pColStep (m : PModel) (t : Nat) (prev : Array Nat) : Array Nat :=
  let emitR : Array Nat := Array.ofFn (n := m.S) fun s => m.emit (t + 1) s.val
  let entryR : Array Nat := Array.ofFn (n := m.S) fun s => m.entry s.val (t + 1)
  let closeA := pCloseRow m t prev
  Array.ofFn (n := m.S * m.maxD) fun i =>
    let s := i.val / m.maxD
    if i.val % m.maxD = 0 then
      pAdd (pAdd
        (pRangeMax (fun sp => if sp == s then 0 else pAdd closeA[sp]! (m.trans sp s (t + 1)))
          m.S)
        entryR[s]!) emitR[s]!
    else pAdd prev[i.val - 1]! emitR[s]!

theorem pCol0_get {m : PModel} {P : Problem} (hag : Agrees m P) (hin : InBounds P)
    {s τ : Nat} (hs : s < P.S) (hτ1 : 1 ≤ τ) (hτm : τ ≤ P.maxD) :
    (pCol0 m)[s * P.maxD + (τ - 1)]! = enc (col P 0 s τ) := by
  have hτ0 : τ - 1 < P.maxD := by omega
  have hi : s * P.maxD + (τ - 1) < m.S * m.maxD := by
    rw [hag.S, hag.maxD]; exact idx_lt hs hτ0
  rw [pCol0, getElem!_pos (Array.ofFn _) _ (by simpa using hi), Array.getElem_ofFn]
  simp only [hag.maxD, idx_div hτ0, idx_mod hτ0, col]
  by_cases h1 : τ = 1
  · subst h1
    rw [if_pos rfl, if_pos rfl, hag.init, hag.entry, hag.emit,
      enc_add (M1 := pOB + pOB) (M2 := pEB) (by simp only [pEB, pOB, pOff]; omega)
        ((hin.init s).add (hin.entry s 0)) (hin.emit 0 s),
      enc_add (M1 := pOB) (M2 := pOB) (by simp only [pOB, pOff]; omega)
        (hin.init s) (hin.entry s 0)]
  · rw [if_neg (by omega), if_neg h1]
    rfl

theorem pCloseRow_get {m : PModel} {P : Problem} (hag : Agrees m P) (hin : InBounds P)
    (t : Nat) (ht : t < pTMax) (pprev : Array Nat)
    (hprev : ∀ s' τ', s' < P.S → 1 ≤ τ' → τ' ≤ P.maxD →
      pprev[s' * P.maxD + (τ' - 1)]! = enc (col P t s' τ'))
    {sp : Nat} (hsp : sp < P.S) :
    (pCloseRow m t pprev)[sp]!
      = enc (Score.listMax ((List.range P.maxD).map fun τ0 =>
          col P t sp (τ0 + 1) + P.dur sp (τ0 + 1) t)) := by
  rw [pCloseRow, getElem!_pos (Array.ofFn _) _ (by rw [← hag.S] at hsp; simpa using hsp),
    Array.getElem_ofFn]
  simp only [hag.maxD]
  rw [← rangeMax_eq]
  apply enc_rangeMax
  intro i hi
  rw [hag.dur]
  have hp := hprev sp (i + 1) hsp (by omega) (by omega)
  rw [show i + 1 - 1 = i from rfl] at hp
  rw [hp, ← enc_add (M1 := colB t) (M2 := pOB)
    (by simp only [colB, pEB, pOB, pOff, pTMax] at ht ⊢; omega)
    (col_bounded hin t sp (i + 1)) (hin.dur sp (i + 1) t)]

theorem pColStep_get {m : PModel} {P : Problem} (hag : Agrees m P) (hin : InBounds P)
    (t : Nat) (ht : t + 1 < pTMax) (pprev : Array Nat)
    (hprev : ∀ s' τ', s' < P.S → 1 ≤ τ' → τ' ≤ P.maxD →
      pprev[s' * P.maxD + (τ' - 1)]! = enc (col P t s' τ'))
    {s τ : Nat} (hs : s < P.S) (hτ1 : 1 ≤ τ) (hτm : τ ≤ P.maxD) :
    (pColStep m t pprev)[s * P.maxD + (τ - 1)]! = enc (col P (t + 1) s τ) := by
  have hτ0 : τ - 1 < P.maxD := by omega
  have hi : s * P.maxD + (τ - 1) < m.S * m.maxD := by
    rw [hag.S, hag.maxD]; exact idx_lt hs hτ0
  rw [pColStep, getElem!_pos (Array.ofFn _) _ (by simpa using hi), Array.getElem_ofFn]
  simp only [hag.maxD, idx_div hτ0, idx_mod hτ0]
  have hemitR : (Array.ofFn (n := m.S) fun s' => m.emit (t + 1) s'.val)[s]!
      = enc (P.emit (t + 1) s) := by
    rw [getElem!_pos _ _ (by rw [← hag.S] at hs; simpa using hs), Array.getElem_ofFn, hag.emit]
  have hentryR : (Array.ofFn (n := m.S) fun s' => m.entry s'.val (t + 1))[s]!
      = enc (P.entry s (t + 1)) := by
    rw [getElem!_pos _ _ (by rw [← hag.S] at hs; simpa using hs), Array.getElem_ofFn, hag.entry]
  -- bound for the inner close-of-run maximum
  have hcb : ∀ sp, Bounded (colB t + pOB)
      (Score.listMax ((List.range P.maxD).map fun τ0 =>
        col P t sp (τ0 + 1) + P.dur sp (τ0 + 1) t)) := by
    intro sp
    apply Bounded.listMax
    intro y hy
    simp only [List.mem_map, List.mem_range] at hy
    obtain ⟨τ0, _, rfl⟩ := hy
    exact (col_bounded hin t sp (τ0 + 1)).add (hin.dur sp (τ0 + 1) t)
  by_cases h1 : τ = 1
  · subst h1
    rw [if_pos rfl, hemitR, hentryR, col, if_pos rfl,
      Score.listMax_flatMap_ite, ← rangeMax_eq]
    have hFb : ∀ i, i < P.S → Bounded (colB t + pOB + pOB)
        (if (i == s) = true then Score.negInf
         else Score.listMax ((List.range P.maxD).map fun t0 =>
             col P t i (t0 + 1) + P.dur i (t0 + 1) t)
           + P.trans i s (t + 1)) := by
      intro i _
      cases hb : i == s
      · simp only [Bool.false_eq_true, if_false]
        exact (hcb i).add (hin.trans i s (t + 1))
      · simp only [if_true]
        trivial
    rw [enc_add (M1 := (colB t + pOB + pOB) + pOB) (M2 := pEB)
        (by simp only [colB, pEB, pOB, pOff, pTMax] at ht ⊢; omega)
        ((Bounded.rangeMax fun i hi => hFb i hi).add (hin.entry s (t + 1)))
        (hin.emit (t + 1) s),
      enc_add (M1 := colB t + pOB + pOB) (M2 := pOB)
        (by simp only [colB, pEB, pOB, pOff, pTMax] at ht ⊢; omega)
        (Bounded.rangeMax fun i hi => hFb i hi) (hin.entry s (t + 1))]
    congr 1
    congr 1
    rw [hag.S]
    apply enc_rangeMax
    intro i hiS
    cases hb : i == s
    · simp only [Bool.false_eq_true, if_false]
      rw [hag.trans, pCloseRow_get hag hin t (by omega) pprev hprev hiS,
        ← enc_add (M1 := colB t + pOB) (M2 := pOB)
          (by simp only [colB, pEB, pOB, pOff, pTMax] at ht ⊢; omega)
          (hcb i) (hin.trans i s (t + 1))]
    · simp only [if_true]
      rfl
  · rw [if_neg (by omega)]
    have hidx : s * P.maxD + (τ - 1) - 1 = s * P.maxD + (τ - 1 - 1) := by omega
    rw [hidx]
    have hp := hprev s (τ - 1) hs (by omega) (by omega)
    rw [hp, hemitR, col, if_neg h1, if_pos ⟨by omega, hτm⟩]
    rw [← enc_add (M1 := colB t) (M2 := pEB)
      (by simp only [colB, pEB, pOB, pOff, pTMax] at ht ⊢; omega)
      (col_bounded hin t s (τ - 1)) (hin.emit (t + 1) s)]

/-! ## Packed checkpointed build, walk, decode -/

/-- Packed `buildCkpt`. -/
def pBuildCkpt (m : PModel) (K : Nat) : Nat → Array (Nat × Array Nat) × Array Nat
  | 0 =>
    let c0 := pCol0 m
    (#[(0, c0)], c0)
  | t + 1 =>
    let prev := pBuildCkpt m K t
    let next := pColStep m t prev.2
    (if (t + 1) % K = 0 then prev.1.push (t + 1, next) else prev.1, next)

theorem pBuildCkpt_snd {m : PModel} {P : Problem} (hag : Agrees m P) (hin : InBounds P)
    (K : Nat) :
    ∀ t, t < pTMax → ∀ s τ, s < P.S → 1 ≤ τ → τ ≤ P.maxD →
      ((pBuildCkpt m K t).2)[s * P.maxD + (τ - 1)]! = enc (col P t s τ)
  | 0 => by
    intro _ s τ hs h1 hm
    have h0 : (pBuildCkpt m K 0).2 = pCol0 m := rfl
    rw [h0]
    exact pCol0_get hag hin hs h1 hm
  | t + 1 => by
    intro ht s τ hs h1 hm
    have h2 : (pBuildCkpt m K (t + 1)).2 = pColStep m t (pBuildCkpt m K t).2 := by
      simp only [pBuildCkpt]
    rw [h2]
    exact pColStep_get hag hin t ht _
      (fun s' τ' hs' h1' hm' =>
        pBuildCkpt_snd hag hin K t (by omega) s' τ' hs' h1' hm') hs h1 hm

theorem pBuildCkpt_fst {m : PModel} {P : Problem} (hag : Agrees m P) (hin : InBounds P)
    (K : Nat) :
    ∀ t, t < pTMax → ∀ i, i < ((pBuildCkpt m K t).1).size →
      (((pBuildCkpt m K t).1)[i]!).1 < pTMax ∧
      ∀ s τ, s < P.S → 1 ≤ τ → τ ≤ P.maxD →
        ((((pBuildCkpt m K t).1)[i]!).2)[s * P.maxD + (τ - 1)]!
          = enc (col P (((pBuildCkpt m K t).1)[i]!).1 s τ)
  | 0 => by
    intro ht i hi
    have hsz : ((pBuildCkpt m K 0).1).size = 1 := rfl
    have hi0 : i = 0 := by omega
    subst hi0
    have hread : ((pBuildCkpt m K 0).1)[0]! = (0, pCol0 m) := rfl
    rw [hread]
    exact ⟨ht, fun s τ hs h1 hm => pCol0_get hag hin hs h1 hm⟩
  | t + 1 => by
    intro ht i hi
    have hsnd : ∀ s' τ', s' < P.S → 1 ≤ τ' → τ' ≤ P.maxD →
        ((pBuildCkpt m K (t + 1)).2)[s' * P.maxD + (τ' - 1)]! = enc (col P (t + 1) s' τ') :=
      fun s' τ' hs' h1' hm' => pBuildCkpt_snd hag hin K (t + 1) ht s' τ' hs' h1' hm'
    have hfst : (pBuildCkpt m K (t + 1)).1
        = if (t + 1) % K = 0
          then ((pBuildCkpt m K t).1).push (t + 1, (pBuildCkpt m K (t + 1)).2)
          else (pBuildCkpt m K t).1 := by
      simp only [pBuildCkpt]
    rw [hfst] at hi ⊢
    by_cases hc : (t + 1) % K = 0
    case neg =>
      rw [if_neg hc] at hi ⊢
      exact pBuildCkpt_fst hag hin K t (by omega) i hi
    case pos =>
      rw [if_pos hc] at hi ⊢
      rw [Array.size_push] at hi
      by_cases hlt : i < ((pBuildCkpt m K t).1).size
      · have hread : (((pBuildCkpt m K t).1).push (t + 1, (pBuildCkpt m K (t + 1)).2))[i]!
            = ((pBuildCkpt m K t).1)[i]! := by
          rw [getElem!_pos _ _ (by rw [Array.size_push]; omega), Array.getElem_push,
            dif_pos hlt]
          exact (getElem!_pos _ _ (by omega)).symm
        rw [hread]
        exact pBuildCkpt_fst hag hin K t (by omega) i hlt
      · have hread : (((pBuildCkpt m K t).1).push (t + 1, (pBuildCkpt m K (t + 1)).2))[i]!
            = (t + 1, (pBuildCkpt m K (t + 1)).2) := by
          rw [getElem!_pos _ _ (by rw [Array.size_push]; omega), Array.getElem_push,
            dif_neg (by omega)]
        rw [hread]
        exact ⟨ht, fun s τ hs h1 hm => hsnd s τ hs h1 hm⟩

/-- Packed `colFrom`. -/
def pColFrom (m : PModel) (b : Nat) (c : Array Nat) : Nat → Array Nat
  | 0 => c
  | k + 1 => pColStep m (b + k) (pColFrom m b c k)

theorem pColFrom_get {m : PModel} {P : Problem} (hag : Agrees m P) (hin : InBounds P)
    (b : Nat) (c : Array Nat)
    (hc : ∀ s τ, s < P.S → 1 ≤ τ → τ ≤ P.maxD →
      c[s * P.maxD + (τ - 1)]! = enc (col P b s τ)) :
    ∀ k, b + k < pTMax → ∀ s τ, s < P.S → 1 ≤ τ → τ ≤ P.maxD →
      (pColFrom m b c k)[s * P.maxD + (τ - 1)]! = enc (col P (b + k) s τ)
  | 0 => fun _ => hc
  | k + 1 => by
    intro hbk s τ hs h1 hm
    rw [pColFrom]
    exact pColStep_get hag hin (b + k) hbk _
      (fun s' τ' hs' h1' hm' =>
        pColFrom_get hag hin b c hc k (by omega) s' τ' hs' h1' hm') hs h1 hm

/-- Packed `colAt`. -/
def pColAt (m : PModel) (cks : Array (Nat × Array Nat)) (t : Nat) : Array Nat :=
  match findCk cks t cks.size with
  | some (b, c) => pColFrom m b c (t - b)
  | none => pColFrom m 0 (pCol0 m) t

theorem pColAt_get {m : PModel} {P : Problem} (hag : Agrees m P) (hin : InBounds P)
    (cks : Array (Nat × Array Nat))
    (hcks : ∀ i, i < cks.size →
      (cks[i]!).1 < pTMax ∧
      ∀ s τ, s < P.S → 1 ≤ τ → τ ≤ P.maxD →
        ((cks[i]!).2)[s * P.maxD + (τ - 1)]! = enc (col P ((cks[i]!).1) s τ))
    (t : Nat) (ht : t < pTMax) : ∀ s τ, s < P.S → 1 ≤ τ → τ ≤ P.maxD →
      (pColAt m cks t)[s * P.maxD + (τ - 1)]! = enc (col P t s τ) := by
  intro s τ hs h1 hm
  rw [pColAt]
  cases hf : findCk cks t cks.size with
  | none =>
    have := pColFrom_get hag hin 0 (pCol0 m)
      (fun s' τ' hs' h1' hm' => pCol0_get hag hin hs' h1' hm') t
      (by omega) s τ hs h1 hm
    rwa [Nat.zero_add] at this
  | some e =>
    obtain ⟨b, c⟩ := e
    obtain ⟨⟨i, hi, hie⟩, hbt⟩ := findCk_spec cks t cks.size (Nat.le_refl _) (b, c) hf
    have hc : ∀ s' τ', s' < P.S → 1 ≤ τ' → τ' ≤ P.maxD →
        c[s' * P.maxD + (τ' - 1)]! = enc (col P b s' τ') := by
      intro s' τ' hs' h1' hm'
      have := (hcks i hi).2 s' τ' hs' h1' hm'
      rw [hie] at this
      exact this
    have := pColFrom_get hag hin b c hc (t - b)
      (by omega) s τ hs h1 hm
    rwa [Nat.add_sub_cancel' hbt] at this

/-- Packed walk: identical shape to `walkCk`, cells and tensors decoded with
`dec` (walk-scale work only — a handful of columns per day). -/
def pWalk (m : PModel) (cks : Array (Nat × Array Nat)) : (t s τ : Nat) → Option (List Seg)
  | t, s, τ =>
    if _hτ : τ = 0 then none
    else if _hs0 : t + 1 - τ = 0 then some [⟨s, τ⟩]
    else
      let c := pColAt m cks (t + 1 - τ - 1)
      match pickBest
          (fun p : Nat × Nat =>
            dec c[p.1 * m.maxD + (p.2 - 1)]! + dec (m.dur p.1 p.2 (t + 1 - τ - 1))
              + dec (m.trans p.1 s (t + 1 - τ - 1 + 1)))
          ((List.range m.S).flatMap fun sp =>
            if sp == s then []
            else (List.range m.maxD).map fun τ0 => (sp, τ0 + 1)) with
      | none => none
      | some ((sp, τ'), _) => (pWalk m cks (t + 1 - τ - 1) sp τ').map (⟨s, τ⟩ :: ·)
  termination_by t _ _ => t
  decreasing_by omega

theorem pWalk_eq {m : PModel} {P : Problem} (hag : Agrees m P) (hin : InBounds P)
    (cks : Array (Nat × Array Nat))
    (hcols : ∀ t s τ, t < pTMax → s < P.S → 1 ≤ τ → τ ≤ P.maxD →
      (pColAt m cks t)[s * P.maxD + (τ - 1)]! = enc (col P t s τ)) :
    ∀ (t s τ : Nat), t < pTMax → pWalk m cks t s τ = walk P t s τ
  | t, s, τ => by
    intro ht
    rw [pWalk, walk]
    by_cases hτ : τ = 0
    · rw [dif_pos hτ, dif_pos hτ]
    · rw [dif_neg hτ, dif_neg hτ]
      by_cases hs0 : t + 1 - τ = 0
      · rw [dif_pos hs0, dif_pos hs0]
      · rw [dif_neg hs0, dif_neg hs0]
        dsimp only
        rw [hag.S, hag.maxD]
        have hpick :
            pickBest
                (fun p : Nat × Nat =>
                  dec (pColAt m cks (t + 1 - τ - 1))[p.1 * P.maxD + (p.2 - 1)]!
                    + dec (m.dur p.1 p.2 (t + 1 - τ - 1))
                    + dec (m.trans p.1 s (t + 1 - τ - 1 + 1)))
                ((List.range P.S).flatMap fun sp =>
                  if sp == s then []
                  else (List.range P.maxD).map fun τ0 => (sp, τ0 + 1))
              = pickBest
                  (fun p : Nat × Nat =>
                    col P (t + 1 - τ - 1) p.1 p.2
                      + P.dur p.1 p.2 (t + 1 - τ - 1)
                      + P.trans p.1 s (t + 1 - τ - 1 + 1))
                  ((List.range P.S).flatMap fun sp =>
                    if sp == s then []
                    else (List.range P.maxD).map fun τ0 => (sp, τ0 + 1)) := by
          apply pickBest_congr
          intro p hp
          simp only [List.mem_flatMap, List.mem_range] at hp
          obtain ⟨sp, hspS, hp2⟩ := hp
          cases hb : sp == s with
          | true => rw [hb] at hp2; simp at hp2
          | false =>
            rw [hb] at hp2
            simp only [Bool.false_eq_true, if_false, List.mem_map, List.mem_range] at hp2
            obtain ⟨τ0, hτ0, hEq⟩ := hp2
            subst hEq
            dsimp only
            rw [hcols (t + 1 - τ - 1) sp (τ0 + 1) (by omega) hspS (by omega) (by omega),
              hag.dur, hag.trans,
              dec_enc (by simp only [pOB, pOff]; omega) (hin.dur sp (τ0 + 1) (t + 1 - τ - 1)),
              dec_enc (by simp only [pOB, pOff]; omega)
                (hin.trans sp s (t + 1 - τ - 1 + 1)),
              dec_enc (M := colB (t + 1 - τ - 1))
                (by simp only [colB, pEB, pOB, pOff, pTMax] at ht ⊢; omega)
                (col_bounded hin (t + 1 - τ - 1) sp (τ0 + 1))]
        rw [hpick]
        cases hq : pickBest
            (fun p : Nat × Nat =>
              col P (t + 1 - τ - 1) p.1 p.2 + P.dur p.1 p.2 (t + 1 - τ - 1)
                + P.trans p.1 s (t + 1 - τ - 1 + 1))
            ((List.range P.S).flatMap fun sp =>
              if sp == s then []
              else (List.range P.maxD).map fun τ0 => (sp, τ0 + 1)) with
        | none => rfl
        | some q =>
          obtain ⟨⟨sp, τ'⟩, sc⟩ := q
          dsimp only
          rw [pWalk_eq hag hin cks hcols (t + 1 - τ - 1) sp τ' (by omega)]
  termination_by t _ _ => t
  decreasing_by omega

/-- The packed verified decoder: `decodeCk`'s structure, `Nat`-scalar
arithmetic throughout the forward pass. -/
def pDecode (m : PModel) (K : Nat) : Option DecodeResult :=
  if m.T = 0 then some ⟨#[], Score.zero⟩
  else
    let bc := pBuildCkpt m K (m.T - 1)
    match pickBest
        (fun p : Nat × Nat =>
          dec (bc.2)[p.1 * m.maxD + (p.2 - 1)]! + dec (m.dur p.1 p.2 (m.T - 1)))
        ((List.range m.S).flatMap fun s =>
          (List.range m.maxD).map fun τ0 => (s, τ0 + 1)) with
    | none => none
    | some ((s, τ), best) =>
      match pWalk m bc.1 (m.T - 1) s τ with
      | none => none
      | some rsegs => some ⟨(toPath rsegs.reverse).toArray, best⟩

theorem pDecode_eq {m : PModel} {P : Problem} (hag : Agrees m P) (hin : InBounds P)
    (K : Nat) (hT : P.T ≤ pTMax) : pDecode m K = decode P := by
  simp only [pDecode, decode, hag.T, hag.S, hag.maxD]
  by_cases hTz : P.T = 0
  · rw [if_pos hTz, if_pos hTz]
  · rw [if_neg hTz, if_neg hTz]
    have hT1 : P.T - 1 < pTMax := by
      simp only [pTMax] at hT ⊢; omega
    have hcks := fun i hi => pBuildCkpt_fst hag hin K (P.T - 1) hT1 i hi
    have hcols : ∀ t s τ, t < pTMax → s < P.S → 1 ≤ τ → τ ≤ P.maxD →
        (pColAt m (pBuildCkpt m K (P.T - 1)).1 t)[s * P.maxD + (τ - 1)]!
          = enc (col P t s τ) :=
      fun t s τ ht hs h1 hm =>
        pColAt_get hag hin (pBuildCkpt m K (P.T - 1)).1 hcks t ht s τ hs h1 hm
    have hpick :
        pickBest
            (fun p : Nat × Nat =>
              dec ((pBuildCkpt m K (P.T - 1)).2)[p.1 * P.maxD + (p.2 - 1)]!
                + dec (m.dur p.1 p.2 (P.T - 1)))
            ((List.range P.S).flatMap fun s =>
              (List.range P.maxD).map fun τ0 => (s, τ0 + 1))
          = pickBest
              (fun p : Nat × Nat =>
                col P (P.T - 1) p.1 p.2 + P.dur p.1 p.2 (P.T - 1))
              ((List.range P.S).flatMap fun s =>
                (List.range P.maxD).map fun τ0 => (s, τ0 + 1)) := by
      apply pickBest_congr
      intro p hp
      simp only [List.mem_flatMap, List.mem_range, List.mem_map] at hp
      obtain ⟨s2, hs2, τ0, hτ0, hEq⟩ := hp
      subst hEq
      dsimp only
      rw [pBuildCkpt_snd hag hin K (P.T - 1) hT1 s2 (τ0 + 1) hs2 (by omega) (by omega),
        hag.dur,
        dec_enc (by simp only [pOB, pOff]; omega) (hin.dur s2 (τ0 + 1) (P.T - 1)),
        dec_enc (M := colB (P.T - 1))
          (by simp only [colB, pEB, pOB, pOff, pTMax] at hT1 ⊢; omega)
          (col_bounded hin (P.T - 1) s2 (τ0 + 1))]
    rw [hpick]
    cases hq : pickBest
        (fun p : Nat × Nat => col P (P.T - 1) p.1 p.2 + P.dur p.1 p.2 (P.T - 1))
        ((List.range P.S).flatMap fun s =>
          (List.range P.maxD).map fun τ0 => (s, τ0 + 1)) with
    | none => rfl
    | some q =>
      obtain ⟨⟨s, τ⟩, best⟩ := q
      dsimp only
      rw [pWalk_eq hag hin (pBuildCkpt m K (P.T - 1)).1 hcols (P.T - 1) s τ hT1]
      rfl

theorem pDecode_eq_decodeCk {m : PModel} {P : Problem} (hag : Agrees m P)
    (hin : InBounds P) (K K' : Nat) (hT : P.T ≤ pTMax) :
    pDecode m K = decodeCk P K' := by
  rw [pDecode_eq hag hin K hT, decodeCk_eq]

/-- `decode_correct`, inherited by the packed decoder. -/
theorem pDecode_correct {m : PModel} {P : Problem} (hag : Agrees m P) (hin : InBounds P)
    (K : Nat) (hT : P.T ≤ pTMax) {r : DecodeResult} (h : pDecode m K = some r) :
    ∃ segs, wellFormed P segs = true
      ∧ score P segs = r.best
      ∧ r.best = oracleBest P
      ∧ r.path = (toPath segs).toArray :=
  decode_correct P (pDecode_eq hag hin K hT ▸ h)

/-- `decode_none_iff`, inherited by the packed decoder. -/
theorem pDecode_none_iff {m : PModel} {P : Problem} (hag : Agrees m P) (hin : InBounds P)
    (K : Nat) (hT : P.T ≤ pTMax) (hTz : P.T ≠ 0) :
    pDecode m K = none ↔ oracleBest P = Score.negInf := by
  rw [pDecode_eq hag hin K hT]
  exact decode_none_iff P hTz

/-- Pack a `Problem` through `enc` — the test-harness bridge (`packM_agrees`
is definitional). The CLI instead builds its `PModel` from pre-encoded
arrays and never materialises a `Problem`. -/
def packM (P : Problem) : PModel where
  T := P.T
  S := P.S
  maxD := P.maxD
  emit := fun t s => enc (P.emit t s)
  trans := fun sp s t => enc (P.trans sp s t)
  dur := fun s d e => enc (P.dur s d e)
  init := fun s => enc (P.init s)
  entry := fun s t => enc (P.entry s t)

theorem packM_agrees (P : Problem) : Agrees (packM P) P :=
  ⟨rfl, rfl, rfl, fun _ _ => rfl, fun _ _ _ => rfl, fun _ _ _ => rfl,
    fun _ => rfl, fun _ _ => rfl⟩

/-! ## Fast path: flat-array data model

`PModel` stores its tensors as `Nat → … → Nat` *closure fields*; the forward
pass reads them through indirect struct-field calls, which the compiler cannot
inline (measured ~1.8× slower on the 55M-cell hot loop than a direct read).
`PData` stores the same pre-encoded tensors as flat `Array Nat`s read through
monomorphic top-level accessors — so the hot loop is direct, inlinable calls.

`toModel` is the `PModel` a `PData` denotes (its accessors wrapped as fields);
each fast forward def is *definitionally* the `PModel` one under `toModel`
(pure β), so the equivalence is `rfl` for the columns and a one-step induction
for the checkpoint builder. `pDecodeFast` runs the fast forward pass and reuses
the shared (slow, but small) backtrace, and `pDecodeFast_eq` proves it equal to
`pDecode (toModel d)` — so `decode_correct` transfers verbatim. -/

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
@[inline] def PData.durAt (d : PData) (s dd e : Nat) : Nat :=
  if dd == 0 then 0
  else if !d.durClass.isEmpty then
    let b := d.durBase.getD (s * d.maxD + (dd - 1)) 0
    if b == 0 then 0
    else b + d.durDelta.getD ((d.durClass.getD s 0 * d.maxD + (dd - 1)) * d.T + e) d.halfOB - d.halfOB
  else if d.hasOv.getD (s * d.maxD + (dd - 1)) false then
    d.durOv.getD ((s * d.maxD + (dd - 1)) * d.T + e) (d.durBase.getD (s * d.maxD + (dd - 1)) 0)
  else d.durBase.getD (s * d.maxD + (dd - 1)) 0

/-- The `PModel` a `PData` denotes. Each accessor becomes a field closure that
β-reduces to the accessor, making the fast defs definitionally the slow ones. -/
def toModel (d : PData) : PModel where
  T := d.T
  S := d.S
  maxD := d.maxD
  emit := fun t s => d.emitAt t s
  trans := fun sp s t => d.transAt sp s t
  dur := fun s dd e => d.durAt s dd e
  init := fun s => d.initAt s
  entry := fun s t => d.entryAt s t

/-- Fast `pCol0`. -/
def pCol0D (d : PData) : Array Nat :=
  Array.ofFn (n := d.S * d.maxD) fun i =>
    if i.val % d.maxD = 0 then
      pAdd (pAdd (d.initAt (i.val / d.maxD)) (d.entryAt (i.val / d.maxD) 0))
        (d.emitAt 0 (i.val / d.maxD))
    else 0

/-- Fast `pCloseRow`. -/
def pCloseRowD (d : PData) (t : Nat) (prev : Array Nat) : Array Nat :=
  Array.ofFn (n := d.S) fun sp =>
    pRangeMax (fun τ0 => pAdd prev[sp.val * d.maxD + τ0]! (d.durAt sp.val (τ0 + 1) t)) d.maxD

/-- Fast `pColStep`. -/
def pColStepD (d : PData) (t : Nat) (prev : Array Nat) : Array Nat :=
  let emitR : Array Nat := Array.ofFn (n := d.S) fun s => d.emitAt (t + 1) s.val
  let entryR : Array Nat := Array.ofFn (n := d.S) fun s => d.entryAt s.val (t + 1)
  let closeA := pCloseRowD d t prev
  Array.ofFn (n := d.S * d.maxD) fun i =>
    let s := i.val / d.maxD
    if i.val % d.maxD = 0 then
      pAdd (pAdd
        (pRangeMax (fun sp => if sp == s then 0 else pAdd closeA[sp]! (d.transAt sp s (t + 1)))
          d.S)
        entryR[s]!) emitR[s]!
    else pAdd prev[i.val - 1]! emitR[s]!

/-- Fast `pBuildCkpt`. -/
def pBuildCkptD (d : PData) (K : Nat) : Nat → Array (Nat × Array Nat) × Array Nat
  | 0 =>
    let c0 := pCol0D d
    (#[(0, c0)], c0)
  | t + 1 =>
    let prev := pBuildCkptD d K t
    let next := pColStepD d t prev.2
    (if (t + 1) % K = 0 then prev.1.push (t + 1, next) else prev.1, next)

theorem pCol0D_eq (d : PData) : pCol0D d = pCol0 (toModel d) := rfl
theorem pCloseRowD_eq (d : PData) (t : Nat) (prev : Array Nat) :
    pCloseRowD d t prev = pCloseRow (toModel d) t prev := rfl
theorem pColStepD_eq (d : PData) (t : Nat) (prev : Array Nat) :
    pColStepD d t prev = pColStep (toModel d) t prev := rfl

theorem pBuildCkptD_eq (d : PData) (K : Nat) :
    ∀ t, pBuildCkptD d K t = pBuildCkpt (toModel d) K t
  | 0 => rfl
  | t + 1 => by
    simp only [pBuildCkptD, pBuildCkpt, pBuildCkptD_eq d K t, pColStepD_eq]

/-- The CLI decoder: fast forward pass, shared backtrace. -/
def pDecodeFast (d : PData) (K : Nat) : Option DecodeResult :=
  if d.T = 0 then some ⟨#[], Score.zero⟩
  else
    let bc := pBuildCkptD d K (d.T - 1)
    match pickBest
        (fun p : Nat × Nat =>
          dec (bc.2)[p.1 * d.maxD + (p.2 - 1)]! + dec (d.durAt p.1 p.2 (d.T - 1)))
        ((List.range d.S).flatMap fun s =>
          (List.range d.maxD).map fun τ0 => (s, τ0 + 1)) with
    | none => none
    | some ((s, τ), best) =>
      match pWalk (toModel d) bc.1 (d.T - 1) s τ with
      | none => none
      | some rsegs => some ⟨(toPath rsegs.reverse).toArray, best⟩

theorem pDecodeFast_eq (d : PData) (K : Nat) : pDecodeFast d K = pDecode (toModel d) K := by
  simp only [pDecodeFast, pDecode, toModel, pBuildCkptD_eq]

/-- `decode_correct`, inherited by the fast decoder. -/
theorem pDecodeFast_correct {d : PData} {P : Problem} (hag : Agrees (toModel d) P)
    (hin : InBounds P) (K : Nat) (hT : P.T ≤ pTMax) {r : DecodeResult}
    (h : pDecodeFast d K = some r) :
    ∃ segs, wellFormed P segs = true
      ∧ score P segs = r.best
      ∧ r.best = oracleBest P
      ∧ r.path = (toPath segs).toArray :=
  pDecode_correct hag hin K hT (pDecodeFast_eq d K ▸ h)

end Verified.Hsmm
