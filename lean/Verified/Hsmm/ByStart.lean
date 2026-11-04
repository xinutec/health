import Verified.Hsmm.Packed

/-!
# The trellis by segment start

A trellis cell is the score of entering its state at the run's first minute
plus the run's emissions (`col_eq_openVal`), and closing a run is `bestEnd`
(`closeB_eq`). So the decoder keeps, per minute and state, the entering score
(`entSpec`) and the best close (`bestEnd`), both encoded (`Packed`), and reads
any cell as an entering score plus a difference of emission prefix sums
(`sCell`). Nothing is shifted minute to minute and no column is stored: a day
is two `T × S` rows of `Nat`s, which the walk reads directly.

`sDecode_eq` proves the decoder equal to `decode` under the envelope
hypotheses; every argmax is `pickBest`'s, in `Nat` (`sPick_eq`), so the path is
the specification's own, ties included. `sDecodeInc_eq` proves today's
incremental decode, an earlier run's rows cut at its frontier and built on,
equal to the full one.
-/

namespace Verified.Hsmm

/-! ## Emission prefix sums -/

/-- An encoded emission shifted by `pOff - pEB`: a bounded finite one lands in
    `[0, 2 pEB]`, so a day's sum stays a scalar. -/
@[inline] def sShift (e : Nat) : Nat := e - (pOff - pEB)

/-- State `s`'s shifted finite emissions summed over its first `u` minutes. -/
def zSum (d : PData) (s : Nat) : Nat → Nat
  | 0 => 0
  | u + 1 => zSum d s u + (if d.emitAt u s == 0 then 0 else sShift (d.emitAt u s))

/-- State `s`'s `-∞` emissions counted over its first `u` minutes. -/
def kSum (d : PData) (s : Nat) : Nat → Nat
  | 0 => 0
  | u + 1 => kSum d s u + (if d.emitAt u s == 0 then 1 else 0)

/-- `zSum` and `kSum` for minutes `0 … u`, as two rows. -/
def sPrefRow (d : PData) (s : Nat) : Nat → Array Nat × Array Nat
  | 0 => (#[0], #[0])
  | u + 1 =>
    match sPrefRow d s u with
    | (zs, ks) =>
      let e := d.emitAt u s
      let z := zs.getD u 0
      let k := ks.getD u 0
      if e == 0 then (zs.push z, ks.push (k + 1)) else (zs.push (z + sShift e), ks.push k)

theorem getD_push_lt (a : Array Nat) (x : Nat) {i : Nat} (h : i < a.size) :
    (a.push x).getD i 0 = a.getD i 0 := by
  rw [getD_of_lt _ _ (by rw [Array.size_push]; omega), getD_of_lt _ _ h, Array.getElem_push_lt]

theorem getD_push_eq (a : Array Nat) (x : Nat) : (a.push x).getD a.size 0 = x := by
  rw [getD_of_lt _ _ (by rw [Array.size_push]; omega), Array.getElem_push_eq]

theorem sPrefRow_spec (d : PData) (s : Nat) : ∀ u,
    (sPrefRow d s u).1.size = u + 1 ∧ (sPrefRow d s u).2.size = u + 1 ∧
    ∀ a, a ≤ u → (sPrefRow d s u).1.getD a 0 = zSum d s a ∧ (sPrefRow d s u).2.getD a 0 = kSum d s a
  | 0 => by
    refine ⟨rfl, rfl, ?_⟩
    intro a ha
    have : a = 0 := by omega
    subst this
    exact ⟨rfl, rfl⟩
  | u + 1 => by
    obtain ⟨hz, hk, hget⟩ := sPrefRow_spec d s u
    rw [sPrefRow]
    generalize sPrefRow d s u = r at hz hk hget ⊢
    obtain ⟨zs, ks⟩ := r
    simp only at hz hk hget ⊢
    · have hzu := (hget u (Nat.le_refl _)).1
      have hku := (hget u (Nat.le_refl _)).2
      by_cases he : d.emitAt u s == 0
      · rw [if_pos he]
        refine ⟨by simp [hz], by simp [hk], ?_⟩
        intro a ha
        by_cases hau : a ≤ u
        · rw [getD_push_lt _ _ (by omega), getD_push_lt _ _ (by omega)]
          exact hget a hau
        · have : a = u + 1 := by omega
          subst this
          have e1 := getD_push_eq zs (zs.getD u 0)
          have e2 := getD_push_eq ks (ks.getD u 0 + 1)
          rw [hz] at e1; rw [hk] at e2
          rw [e1, e2, hzu, hku]
          simp [zSum, kSum, he]
      · rw [if_neg he]
        refine ⟨by simp [hz], by simp [hk], ?_⟩
        intro a ha
        by_cases hau : a ≤ u
        · rw [getD_push_lt _ _ (by omega), getD_push_lt _ _ (by omega)]
          exact hget a hau
        · have : a = u + 1 := by omega
          subst this
          have e1 := getD_push_eq zs (zs.getD u 0 + sShift (d.emitAt u s))
          have e2 := getD_push_eq ks (ks.getD u 0)
          rw [hz] at e1; rw [hk] at e2
          rw [e1, e2, hzu, hku]
          simp [zSum, kSum, he]

/-- `enc (emitRun P s a len)` from a state's prefix rows. -/
@[inline] def sRun (zr kr : Array Nat) (a len : Nat) : Nat :=
  if len == 0 then pOff else
  if kr.getD (a + len) 0 != kr.getD a 0 then 0
  else zr.getD (a + len) 0 - zr.getD a 0 + pOff - len * pEB

theorem emit_cases {d : PData} {P : Problem} (hag : Agrees (toModel d) P) (hin : InBounds P)
    (u s : Nat) :
    (d.emitAt u s = 0 ∧ P.emit u s = Score.negInf) ∨
    (∃ v : Int, P.emit u s = Score.val v ∧ v.natAbs ≤ pEB ∧ (d.emitAt u s : Int) = v + pOff) := by
  have h := hag.emit u s
  simp only [toModel] at h
  have hb := hin.emit u s
  cases hP : P.emit u s with
  | negInf => left; rw [hP] at h; exact ⟨h, rfl⟩
  | val v =>
    right
    rw [hP] at h hb
    simp only [Bounded] at hb
    refine ⟨v, rfl, hb, ?_⟩
    rw [h]; simp only [enc, pEB, pOff] at hb ⊢; omega

theorem pEB_lt_pOff : 2 * pEB < pOff := by simp only [pEB, pOff]; omega

theorem kSum_mono (d : PData) (s a : Nat) : ∀ len, kSum d s a ≤ kSum d s (a + len)
  | 0 => Nat.le_refl _
  | len + 1 => by
    have := kSum_mono d s a len
    show kSum d s a ≤ kSum d s (a + len) + _
    omega

theorem emitRun_prefix {d : PData} {P : Problem} (hag : Agrees (toModel d) P) (hin : InBounds P)
    (s a : Nat) : ∀ len,
    (kSum d s (a + len) = kSum d s a →
      ∃ v : Int, emitRun P s a len = Score.val v ∧ v.natAbs ≤ len * pEB ∧
        ((zSum d s (a + len) : Int) - zSum d s a) = v + len * pEB ∧ zSum d s a ≤ zSum d s (a + len)) ∧
    (kSum d s (a + len) ≠ kSum d s a → emitRun P s a len = Score.negInf)
  | 0 => by
    refine ⟨fun _ => ⟨0, rfl, by simp, by simp, by simp⟩, fun h => absurd rfl h⟩
  | len + 1 => by
    obtain ⟨ih1, ih2⟩ := emitRun_prefix hag hin s a len
    rw [emitRun_succ]
    have hz : zSum d s (a + (len + 1)) = zSum d s (a + len)
        + (if d.emitAt (a + len) s == 0 then 0 else sShift (d.emitAt (a + len) s)) := rfl
    have hk : kSum d s (a + (len + 1)) = kSum d s (a + len)
        + (if d.emitAt (a + len) s == 0 then 1 else 0) := rfl
    have hmono := kSum_mono d s a len
    rcases emit_cases hag hin (a + len) s with ⟨he0, hP⟩ | ⟨v, hP, hv, he⟩
    · rw [hP, Score.add_negInf]
      have hbeq : (d.emitAt (a + len) s == 0) = true := by simp [he0]
      rw [hbeq, if_pos rfl] at hk
      exact ⟨fun h => by omega, fun _ => rfl⟩
    · have hEO : 2 * pEB < pOff := by simp only [pEB, pOff]; omega
      have hne : (d.emitAt (a + len) s == 0) = false := by
        simp only [beq_eq_false_iff_ne]; omega
      rw [hne] at hz hk
      simp only [Bool.false_eq_true, if_false, Nat.add_zero] at hz hk
      rw [hk]
      refine ⟨fun h => ?_, fun h => ?_⟩
      · obtain ⟨w, hw, hwb, hwz, hle⟩ := ih1 h
        rw [hw, hP, Score.val_add_val]
        refine ⟨w + v, rfl, ?_, ?_, ?_⟩
        · have : (len + 1) * pEB = len * pEB + pEB := by rw [Nat.add_mul, Nat.one_mul]
          omega
        · rw [hz]
          have hc : ((len + 1 : Nat) : Int) * (pEB : Int) = (len : Int) * (pEB : Int) + pEB := by
            rw [Int.natCast_add, Int.add_mul, Int.natCast_one, Int.one_mul]
          rw [hc]; simp only [sShift]; omega
        · rw [hz]; omega
      · rw [ih2 h, Score.negInf_add]

theorem sRun_eq {d : PData} {P : Problem} (hag : Agrees (toModel d) P) (hin : InBounds P)
    {s a len : Nat} {zr kr : Array Nat} (hlen : 1 ≤ len) (hlenB : len ≤ pTMax)
    (hz : ∀ b, b ≤ a + len → zr.getD b 0 = zSum d s b)
    (hk : ∀ b, b ≤ a + len → kr.getD b 0 = kSum d s b) :
    sRun zr kr a len = enc (emitRun P s a len) := by
  obtain ⟨h1, h2⟩ := emitRun_prefix hag hin s a len
  unfold sRun
  rw [if_neg (by simp; omega), hz _ (Nat.le_refl _), hz a (by omega), hk _ (Nat.le_refl _),
    hk a (by omega)]
  by_cases hkk : kSum d s (a + len) = kSum d s a
  · rw [if_neg (by simp [hkk])]
    obtain ⟨v, hv, hvb, hvz, hle⟩ := h1 hkk
    rw [hv]
    simp only [enc]
    have hpe : len * pEB ≤ pTMax * pEB := Nat.mul_le_mul_right _ hlenB
    simp only [pTMax, pEB, pOff] at hpe hvb hvz ⊢
    omega
  · rw [if_pos (by simp [hkk]), h2 hkk]
    rfl

/-! ## Entering and closing, minute by minute -/

/-- What `openVal` adds a run's emissions to: entering `s` at `u`. -/
def entSpec (P : Problem) (u s : Nat) : Score :=
  (if u = 0 then P.init s
   else Score.listMax ((List.range P.S).flatMap fun sp =>
     if sp == s then [] else [bestEnd P sp u + P.trans sp s u]))
  + P.entry s u

theorem openVal_ent (P : Problem) (u s τ : Nat) :
    openVal P u s τ = entSpec P u s + emitRun P s u τ := rfl

/-- Every state's prefix rows over the day. -/
abbrev Pref := Array (Array Nat × Array Nat)

def sPrefix (d : PData) : Pref := Array.ofFn (n := d.S) fun s => sPrefRow d s d.T

/-- Entering `s` at `u`, from the closes at `u` (`bst` row `u`). -/
def sEnt (d : PData) (bst : Array Nat) (u s : Nat) : Nat :=
  pAdd (if u == 0 then d.initAt s else
      pRangeMaxL (fun sp => if sp == s then 0 else pAdd (bst.getD (u * d.S + sp) 0) (d.transAt sp s u)) d.S)
    (d.entryAt s u)

/-- The best close of `s` at minute `u` (`bestEnd` at `u + 1`): a run of
    `τ0 + 1 ≤ u + 1` minutes entered at `u - τ0`. -/
def sCloseRef (d : PData) (pref : Pref) (ent : Array Nat) (s u : Nat) : Nat :=
  pRangeMaxL (fun τ0 => pAdd (pAdd (ent.getD ((u - τ0) * d.S + s) 0)
      (sRun (pref.getD s (#[], #[])).1 (pref.getD s (#[], #[])).2 (u - τ0) (τ0 + 1)))
    (d.durAt s (τ0 + 1) u)) (min d.maxD (u + 1))

/-! ## The close loop, fast -/

/-- One length of `sCloseRef`'s maximum with the class-factored `durAt` and
    the run's prefix sums read in place: `zE`, `kE` the run's end, `cOff` the
    class's cells at `u`. -/
@[inline] def sCloseTerm (d : PData) (ent zr kr : Array Nat) (s u zE kE cOff τ0 : Nat) : Nat :=
  let a := u - τ0
  if kE != kr.getD a 0 then 0 else
  let e := ent.getD (a * d.S + s) 0
  if e == 0 then 0 else
  let b := d.durBase.getD (s * d.maxD + τ0) 0
  if b == 0 then 0 else
  pAdd (pAdd e (zE - zr.getD a 0 + pOff - (τ0 + 1) * pEB))
    (b + d.durDelta.getD (cOff + τ0) d.halfOB - d.halfOB)

def sCloseGo (d : PData) (ent zr kr : Array Nat) (s u zE kE cOff n : Nat) (τ0 acc : Nat) : Nat :=
  if h : τ0 < n then
    sCloseGo d ent zr kr s u zE kE cOff n (τ0 + 1) (max acc (sCloseTerm d ent zr kr s u zE kE cOff τ0))
  else acc
termination_by n - τ0

/-- `sCloseGo` with its indices carried instead of multiplied out: `r` lengths
    left, `a` the run's first minute, `ei`, `bi`, `ci` its cells in `ent`,
    `durBase` and `durDelta`, `lenEB` its length times `pEB`. -/
def sCloseRun (ent zr kr db dl : Array Nat) (S halfOB zE kE : Nat) :
    (r a ei bi ci lenEB acc : Nat) → Nat
  | 0, _, _, _, _, _, acc => acc
  | r + 1, a, ei, bi, ci, lenEB, acc =>
    let c :=
      if kE != kr.getD a 0 then 0 else
      let e := ent.getD ei 0
      if e == 0 then 0 else
      let b := db.getD bi 0
      if b == 0 then 0 else
      pAdd (pAdd e (zE - zr.getD a 0 + pOff - lenEB)) (b + dl.getD ci halfOB - halfOB)
    sCloseRun ent zr kr db dl S halfOB zE kE r (a - 1) (ei - S) (bi + 1) (ci + 1) (lenEB + pEB) (max acc c)

theorem sCloseRun_eq (d : PData) (ent zr kr : Array Nat) (s u zE kE cOff n : Nat) (hn : n ≤ u + 1) :
    ∀ r τ0 acc a ei bi ci lenEB, n - τ0 = r → τ0 ≤ n →
      (τ0 < n → a = u - τ0 ∧ ei = (u - τ0) * d.S + s ∧ bi = s * d.maxD + τ0 ∧ ci = cOff + τ0 ∧
        lenEB = (τ0 + 1) * pEB) →
      sCloseRun ent zr kr d.durBase d.durDelta d.S d.halfOB zE kE r a ei bi ci lenEB acc
        = sCloseGo d ent zr kr s u zE kE cOff n τ0 acc
  | 0, τ0, acc, a, ei, bi, ci, lenEB, hr, _, _ => by
    rw [sCloseRun, sCloseGo, dif_neg (by omega)]
  | r + 1, τ0, acc, a, ei, bi, ci, lenEB, hr, hle, hinv => by
    obtain ⟨ha, he, hb, hc, hl⟩ := hinv (by omega)
    rw [sCloseRun, sCloseGo, dif_pos (by omega)]
    have hterm : (if kE != kr.getD a 0 then 0 else
        if ent.getD ei 0 == 0 then 0 else
        if d.durBase.getD bi 0 == 0 then 0 else
        pAdd (pAdd (ent.getD ei 0) (zE - zr.getD a 0 + pOff - lenEB))
          (d.durBase.getD bi 0 + d.durDelta.getD ci d.halfOB - d.halfOB))
        = sCloseTerm d ent zr kr s u zE kE cOff τ0 := by
      subst ha he hb hc hl
      rfl
    simp only at hterm ⊢
    rw [hterm]
    apply sCloseRun_eq d ent zr kr s u zE kE cOff n hn r (τ0 + 1) _ _ _ _ _ _ (by omega) (by omega)
    intro hlt
    have hpos : 1 ≤ u - τ0 := by omega
    refine ⟨by omega, ?_, by omega, by omega, ?_⟩
    · rw [he, show u - (τ0 + 1) = (u - τ0) - 1 by omega, Nat.sub_one_mul]
      have : d.S ≤ (u - τ0) * d.S := Nat.le_mul_of_pos_left _ hpos
      omega
    · rw [hl, Nat.add_mul (τ0 + 1) 1, Nat.one_mul]

/-- `sCloseRef`, with the reads that do not change along the loop hoisted. -/
def sClose (d : PData) (pref : Pref) (ent : Array Nat) (s u : Nat) : Nat :=
  if d.durClass.isEmpty then sCloseRef d pref ent s u else
  let r := pref.getD s (#[], #[])
  let n := min d.maxD (u + 1)
  sCloseRun ent r.1 r.2 d.durBase d.durDelta d.S d.halfOB (r.1.getD (u + 1) 0) (r.2.getD (u + 1) 0)
    n u (u * d.S + s) (s * d.maxD) (d.durClass.getD s 0 * triOff d.maxD d.T + triOff d.maxD u) pEB 0

theorem sCloseTerm_eq (d : PData) (pref : Pref) (ent : Array Nat) {s u τ0 : Nat} (hτ : τ0 ≤ u)
    (hcls : d.durClass.isEmpty = false) :
    sCloseTerm d ent (pref.getD s (#[], #[])).1 (pref.getD s (#[], #[])).2 s u
        ((pref.getD s (#[], #[])).1.getD (u + 1) 0) ((pref.getD s (#[], #[])).2.getD (u + 1) 0)
        (d.durClass.getD s 0 * triOff d.maxD d.T + triOff d.maxD u) τ0
      = pAdd (pAdd (ent.getD ((u - τ0) * d.S + s) 0)
          (sRun (pref.getD s (#[], #[])).1 (pref.getD s (#[], #[])).2 (u - τ0) (τ0 + 1)))
        (d.durAt s (τ0 + 1) u) := by
  have hidx : u - τ0 + (τ0 + 1) = u + 1 := by omega
  unfold sCloseTerm sRun PData.durAt
  simp only [hidx, hcls, if_false, Nat.add_one_ne_zero, beq_iff_eq]
  rw [if_neg (by omega : ¬ (τ0 + 1 > u + 1))]
  simp only [Nat.add_sub_cancel]
  by_cases hk : (pref.getD s (#[], #[])).2.getD (u + 1) 0 = (pref.getD s (#[], #[])).2.getD (u - τ0) 0
  · simp only [hk, bne_self_eq_false, Bool.false_eq_true, if_false]
    by_cases he : ent.getD ((u - τ0) * d.S + s) 0 = 0
    · simp [he, pAdd]
    · simp only [he, if_false]
      by_cases hb : d.durBase.getD (s * d.maxD + τ0) 0 = 0
      · simp [hb, pAdd]
      · simp only [hb, if_false]
        rfl
  · have h2 : ((pref.getD s (#[], #[])).2.getD (u + 1) 0 != (pref.getD s (#[], #[])).2.getD (u - τ0) 0) = true := by
      simpa using hk
    rw [if_pos h2, if_pos h2]
    simp [pAdd]

theorem sCloseGo_eq (d : PData) (ent zr kr : Array Nat) (s u zE kE cOff n : Nat) (f : Nat → Nat)
    (hf : ∀ τ0, τ0 < n → sCloseTerm d ent zr kr s u zE kE cOff τ0 = f τ0) :
    ∀ k τ0 acc, n - τ0 = k → sCloseGo d ent zr kr s u zE kE cOff n τ0 acc = pRangeMaxGo f n τ0 acc
  | 0, τ0, acc, hk => by
    unfold sCloseGo pRangeMaxGo
    rw [dif_neg (by omega), dif_neg (by omega)]
  | k + 1, τ0, acc, hk => by
    unfold sCloseGo pRangeMaxGo
    rw [dif_pos (by omega), dif_pos (by omega), hf τ0 (by omega)]
    exact sCloseGo_eq d ent zr kr s u zE kE cOff n f hf k (τ0 + 1) _ (by omega)

theorem sClose_eq (d : PData) (pref : Pref) (ent : Array Nat) (s u : Nat) :
    sClose d pref ent s u = sCloseRef d pref ent s u := by
  unfold sClose
  cases hcls : d.durClass.isEmpty
  · simp only [Bool.false_eq_true, if_false]
    have hrun := sCloseRun_eq d ent (pref.getD s (#[], #[])).1 (pref.getD s (#[], #[])).2 s u
      ((pref.getD s (#[], #[])).1.getD (u + 1) 0) ((pref.getD s (#[], #[])).2.getD (u + 1) 0)
      (d.durClass.getD s 0 * triOff d.maxD d.T + triOff d.maxD u) (min d.maxD (u + 1))
      (Nat.min_le_right _ _) (min d.maxD (u + 1)) 0 0 u (u * d.S + s) (s * d.maxD)
      (d.durClass.getD s 0 * triOff d.maxD d.T + triOff d.maxD u) pEB (by omega) (Nat.zero_le _)
      (fun _ => ⟨by omega, by simp, by simp, by simp, by simp⟩)
    simp only at hrun ⊢
    rw [hrun]
    unfold sCloseRef pRangeMaxL
    apply sCloseGo_eq _ _ _ _ _ _ _ _ _ _ _ (fun τ0 hτ0 => ?_) _ 0 0 rfl
    exact sCloseTerm_eq d pref ent (by have := Nat.min_le_right d.maxD (u + 1); omega) hcls
  · rfl

/-- After `u` minutes: `ent` holds rows `0 … u - 1` and `bst` rows `0 … u`,
    `S` wide, by minute. -/
def sBuild (d : PData) (pref : Pref) : Nat → Array Nat × Array Nat
  | 0 => (#[], Array.replicate d.S 0)
  | u + 1 =>
    match sBuild d pref u with
    | (ent, bst) =>
      let ent := ent ++ Array.ofFn (n := d.S) fun s => sEnt d bst u s.val
      let bst := bst ++ Array.ofFn (n := d.S) fun s => sClose d pref ent s.val u
      (ent, bst)

theorem getD_append_lt (a b : Array Nat) {i : Nat} (h : i < a.size) :
    (a ++ b).getD i 0 = a.getD i 0 := by
  rw [getD_of_lt _ _ (by rw [Array.size_append]; omega), getD_of_lt _ _ h, Array.getElem_append_left h]

theorem getD_append_ofFn {n : Nat} (a : Array Nat) (f : Fin n → Nat) {j : Nat} (hj : j < n) :
    (a ++ Array.ofFn f).getD (a.size + j) 0 = f ⟨j, hj⟩ := by
  rw [getD_of_lt _ _ (by rw [Array.size_append, Array.size_ofFn]; omega),
    Array.getElem_append_right (by omega)]
  simp

theorem emitRun_bounded {P : Problem} (hin : InBounds P) (s a : Nat) :
    ∀ len, Bounded (len * pEB) (emitRun P s a len)
  | 0 => by simp [emitRun, Score.zero, Bounded]
  | len + 1 => by
    rw [emitRun_succ]
    have := (emitRun_bounded hin s a len).add (hin.emit (a + len) s)
    exact this.mono (by rw [Nat.add_mul, Nat.one_mul]; exact Nat.le_refl _)

theorem colB_succ (t : Nat) : colB (t + 1) = colB t + pEB + 3 * pOB := by
  unfold colB
  rw [show 3 * (t + 1) + 4 = (3 * t + 4) + 3 by omega, Nat.add_mul (3 * t + 4) 3,
    Nat.add_mul (t + 1) 1, Nat.add_mul t 1]
  omega

theorem bestEnd_close (P : Problem) (hmaxD : 1 ≤ P.maxD) (t s : Nat) :
    bestEnd P s (t + 1) = Score.listMax ((List.range P.maxD).map fun τ0 =>
      col P t s (τ0 + 1) + P.dur s (τ0 + 1) t) :=
  (closeB_eq P hmaxD t (col_eq_openVal P hmaxD t) s).symm

theorem bestEnd_bounded {P : Problem} (hin : InBounds P) (hmaxD : 1 ≤ P.maxD) :
    ∀ m s, Bounded (colB m) (bestEnd P s m)
  | 0, s => by simp [bestEnd, Bounded]
  | t + 1, s => by
    rw [bestEnd_close P hmaxD t s]
    apply Bounded.listMax
    intro y hy
    simp only [List.mem_map, List.mem_range] at hy
    obtain ⟨τ0, _, rfl⟩ := hy
    exact ((col_bounded hin t s (τ0 + 1)).add (hin.dur s (τ0 + 1) t)).mono
      (by rw [colB_succ]; omega)

theorem entSpec_bounded {P : Problem} (hin : InBounds P) (hmaxD : 1 ≤ P.maxD) (u s : Nat) :
    Bounded (colB u + 2 * pOB) (entSpec P u s) := by
  unfold entSpec
  by_cases hu : u = 0
  · rw [if_pos hu]
    subst hu
    exact ((hin.init s).add (hin.entry s 0)).mono (by simp only [colB]; omega)
  · rw [if_neg hu]
    obtain ⟨t, rfl⟩ : ∃ t, u = t + 1 := ⟨u - 1, by omega⟩
    have hL : Bounded (colB (t + 1) + pOB) (Score.listMax ((List.range P.S).flatMap fun sp =>
        if sp == s then [] else [bestEnd P sp (t + 1) + P.trans sp s (t + 1)])) := by
      apply Bounded.listMax
      intro x hx
      simp only [List.mem_flatMap, List.mem_range] at hx
      obtain ⟨sp, _, hx2⟩ := hx
      cases hb : sp == s <;> rw [hb] at hx2
      · simp only [Bool.false_eq_true, if_false, List.mem_singleton] at hx2
        subst hx2
        exact (bestEnd_bounded hin hmaxD (t + 1) sp).add (hin.trans sp s (t + 1))
      · simp at hx2
    exact (hL.add (hin.entry s (t + 1))).mono (by omega)

theorem colB_mono {a : Nat} : ∀ {b}, a ≤ b → colB a ≤ colB b
  | b, h => by
    induction b with
    | zero => have : a = 0 := by omega
              subst this; exact Nat.le_refl _
    | succ b ih =>
      by_cases hab : a = b + 1
      · subst hab; exact Nat.le_refl _
      · have := ih (by omega); rw [colB_succ]; omega

theorem colB_add_le (a len : Nat) : colB a + len * pEB ≤ colB (a + len) := by
  induction len with
  | zero => rw [Nat.zero_mul, Nat.add_zero, Nat.add_zero]; exact Nat.le_refl _
  | succ len ih =>
    rw [show a + (len + 1) = (a + len) + 1 by omega, colB_succ, Nat.add_mul, Nat.one_mul]
    omega

theorem colB_max : colB pTMax + pEB + 8 * pOB < pOff := by
  show colB pTMax + pEB + 8 * pOB + 1 ≤ pOff
  exact Nat.le_of_ble_eq_true rfl

theorem sEnt_eq {d : PData} {P : Problem} (hag : Agrees (toModel d) P) (hin : InBounds P)
    (hmaxD : 1 ≤ P.maxD) {bst : Array Nat} {u s : Nat} (hu : u ≤ pTMax)
    (hbst : ∀ sp, sp < P.S → bst.getD (u * P.S + sp) 0 = enc (bestEnd P sp u)) :
    sEnt d bst u s = enc (entSpec P u s) := by
  have hS : d.S = P.S := hag.S
  have hCB := colB_mono hu
  have hmx := colB_max
  have hinit : d.initAt s = enc (P.init s) := hag.init s
  have hentry : d.entryAt s u = enc (P.entry s u) := hag.entry s u
  unfold sEnt entSpec
  by_cases hu0 : u = 0
  · subst hu0
    simp only [beq_self_eq_true, if_true]
    rw [hinit, hentry,
      enc_add (M1 := pOB) (M2 := pOB) (by simp only [pOB, pOff]; omega) (hin.init s) (hin.entry s 0)]
  · rw [if_neg (by simpa using hu0), if_neg hu0, Score.listMax_flatMap_ite, ← rangeMax_eq]
    have hFb : ∀ i, i < P.S → Bounded (colB u + pOB)
        (if (i == s) = true then Score.negInf else bestEnd P i u + P.trans i s u) := by
      intro i _
      cases hb : i == s
      · simp only [Bool.false_eq_true, if_false]
        exact (bestEnd_bounded hin hmaxD u i).add (hin.trans i s u)
      · simp only [if_true]; trivial
    rw [hentry, enc_add (M1 := colB u + pOB) (M2 := pOB) (by omega)
      (Bounded.rangeMax fun i hi => hFb i hi) (hin.entry s u), pRangeMaxL_eq, hS]
    congr 1
    apply enc_rangeMax
    intro i hiS
    cases hb : i == s
    · simp only [Bool.false_eq_true, if_false]
      have htr : d.transAt i s u = enc (P.trans i s u) := hag.trans i s u
      rw [hbst i hiS, htr, ← enc_add (M1 := colB u) (M2 := pOB) (by omega)
        (bestEnd_bounded hin hmaxD u i) (hin.trans i s u)]
    · simp only [if_true]; rfl

theorem sCloseRef_eq {d : PData} {P : Problem} (hag : Agrees (toModel d) P) (hin : InBounds P)
    (hmaxD : 1 ≤ P.maxD) {pref : Pref} {ent : Array Nat} {s u : Nat} (hu : u + 1 ≤ pTMax)
    (hpref : ∀ b, b ≤ u + 1 →
      (pref.getD s (#[], #[])).1.getD b 0 = zSum d s b ∧ (pref.getD s (#[], #[])).2.getD b 0 = kSum d s b)
    (hent : ∀ a, a ≤ u → ent.getD (a * P.S + s) 0 = enc (entSpec P a s)) :
    sCloseRef d pref ent s u = enc (bestEnd P s (u + 1)) := by
  have hS : d.S = P.S := hag.S
  have hM : d.maxD = P.maxD := hag.maxD
  have hmx := colB_max
  have hn1 : 1 ≤ min P.maxD (u + 1) := by omega
  rw [bestEnd_close P hmaxD u s, Score.listMax_map_range_pad _ (Nat.min_le_left _ _) hn1 (by
    intro i hi hiM
    rw [col_eq_openVal P hmaxD u s (i + 1), if_neg (by omega), Score.negInf_add]), ← rangeMax_eq]
  unfold sCloseRef
  rw [pRangeMaxL_eq, hM]
  apply enc_rangeMax
  intro τ0 hτ0
  have hτm : τ0 < P.maxD := Nat.lt_of_lt_of_le hτ0 (Nat.min_le_left _ _)
  have hτu : τ0 ≤ u := by have := Nat.min_le_right P.maxD (u + 1); omega
  rw [col_eq_openVal P hmaxD u s (τ0 + 1), if_pos ⟨by omega, by omega, by omega⟩,
    show u + 1 - (τ0 + 1) = u - τ0 by omega, openVal_ent]
  have hadd := colB_add_le (u - τ0) (τ0 + 1)
  have hCB := colB_mono (show u - τ0 + (τ0 + 1) ≤ pTMax by omega)
  rw [enc_add (M1 := colB (u - τ0) + 2 * pOB + (τ0 + 1) * pEB) (M2 := pOB) (by omega)
      ((entSpec_bounded hin hmaxD (u - τ0) s).add (emitRun_bounded hin s (u - τ0) (τ0 + 1)))
      (hin.dur s (τ0 + 1) u),
    enc_add (M1 := colB (u - τ0) + 2 * pOB) (M2 := (τ0 + 1) * pEB) (by omega)
      (entSpec_bounded hin hmaxD (u - τ0) s) (emitRun_bounded hin s (u - τ0) (τ0 + 1)),
    ← hent (u - τ0) (by omega), hS,
    sRun_eq hag hin (by omega) (by omega)
      (fun b hb => (hpref b (by omega)).1) (fun b hb => (hpref b (by omega)).2)]
  have hdur : d.durAt s (τ0 + 1) u = enc (P.dur s (τ0 + 1) u) := hag.dur s (τ0 + 1) u
  rw [hdur]

theorem sPrefix_spec (d : PData) {s b : Nat} (hs : s < d.S) (hb : b ≤ d.T) :
    ((sPrefix d).getD s (#[], #[])).1.getD b 0 = zSum d s b ∧
    ((sPrefix d).getD s (#[], #[])).2.getD b 0 = kSum d s b := by
  rw [sPrefix, getD_of_lt (Array.ofFn _) s (by simpa using hs), Array.getElem_ofFn]
  exact (sPrefRow_spec d s d.T).2.2 b hb

theorem row_lt {a s u S : Nat} (ha : a < u) (hs : s < S) : a * S + s < u * S := by
  have : (a + 1) * S ≤ u * S := Nat.mul_le_mul_right S ha
  rw [Nat.add_mul, Nat.one_mul] at this
  omega

theorem sBuild_spec {d : PData} {P : Problem} (hag : Agrees (toModel d) P) (hin : InBounds P)
    (hmaxD : 1 ≤ P.maxD) (hT : P.T ≤ pTMax) {pref : Pref}
    (hpref : ∀ s b, s < P.S → b ≤ P.T →
      (pref.getD s (#[], #[])).1.getD b 0 = zSum d s b ∧ (pref.getD s (#[], #[])).2.getD b 0 = kSum d s b) :
    ∀ u, u ≤ P.T →
      (sBuild d pref u).1.size = u * P.S ∧ (sBuild d pref u).2.size = (u + 1) * P.S ∧
      (∀ a s, a < u → s < P.S → (sBuild d pref u).1.getD (a * P.S + s) 0 = enc (entSpec P a s)) ∧
      (∀ m s, m ≤ u → s < P.S → (sBuild d pref u).2.getD (m * P.S + s) 0 = enc (bestEnd P s m))
  | 0, _ => by
    have hS : d.S = P.S := hag.S
    refine ⟨by simp [sBuild], by simp [sBuild, hS], fun a s ha _ => absurd ha (Nat.not_lt_zero _), ?_⟩
    intro m s hm hs
    have : m = 0 := by omega
    subst this
    simp only [sBuild, Nat.zero_mul, Nat.zero_add]
    rw [getD_of_lt _ _ (by simp [hS, hs]), Array.getElem_replicate]
    simp [bestEnd, enc]
  | u + 1, hu => by
    have hS : d.S = P.S := hag.S
    obtain ⟨h1, h2, h3, h4⟩ := sBuild_spec hag hin hmaxD hT hpref u (by omega)
    rw [sBuild]
    generalize sBuild d pref u = r at h1 h2 h3 h4 ⊢
    obtain ⟨ent, bst⟩ := r
    simp only at h1 h2 h3 h4 ⊢
    -- The new entering row, then the new close row.
    have hent' : ∀ a s, a ≤ u → s < P.S →
        (ent ++ Array.ofFn (n := d.S) fun s => sEnt d bst u s.val).getD (a * P.S + s) 0
          = enc (entSpec P a s) := by
      intro a s ha hs
      by_cases hau : a < u
      · rw [getD_append_lt _ _ (by rw [h1]; exact row_lt hau hs)]
        exact h3 a s hau hs
      · have : a = u := by omega
        subst this
        rw [show a * P.S + s = ent.size + s by rw [h1]]
        rw [getD_append_ofFn _ _ (by rw [hS]; exact hs)]
        exact sEnt_eq hag hin hmaxD (by omega) (fun sp hsp => h4 a sp (Nat.le_refl _) hsp)
    refine ⟨?_, ?_, ?_, ?_⟩
    · simp [h1, hS, Nat.add_mul]
    · simp [h2, hS, Nat.add_mul]
    · intro a s ha hs
      exact hent' a s (by omega) hs
    · intro m s hm hs
      by_cases hmu : m ≤ u
      · rw [getD_append_lt _ _ (by rw [h2]; exact row_lt (by omega) hs)]
        exact h4 m s hmu hs
      · have : m = u + 1 := by omega
        subst this
        rw [show (u + 1) * P.S + s = bst.size + s by rw [h2]]
        rw [getD_append_ofFn _ _ (by rw [hS]; exact hs)]
        rw [sClose_eq]
        exact sCloseRef_eq hag hin hmaxD (by omega)
          (fun b hb => hpref s b hs (by omega)) (fun a ha => hent' a s ha hs)

/-- A cell of `col`, encoded, from the by-start rows: entering at the run's
    first minute plus the run's emissions; `0` for a run that cannot be. -/
def sCell (d : PData) (pref : Pref) (ent : Array Nat) (t s τ : Nat) : Nat :=
  if 1 ≤ τ ∧ τ ≤ d.maxD ∧ τ ≤ t + 1 then
    pAdd (ent.getD ((t + 1 - τ) * d.S + s) 0)
      (sRun (pref.getD s (#[], #[])).1 (pref.getD s (#[], #[])).2 (t + 1 - τ) τ)
  else 0

theorem sCell_eq {d : PData} {P : Problem} (hag : Agrees (toModel d) P) (hin : InBounds P)
    (hmaxD : 1 ≤ P.maxD) {pref : Pref} {ent : Array Nat} {t s τ : Nat} (ht : t + 1 ≤ pTMax)
    (hpref : ∀ b, b ≤ t + 1 →
      (pref.getD s (#[], #[])).1.getD b 0 = zSum d s b ∧ (pref.getD s (#[], #[])).2.getD b 0 = kSum d s b)
    (hent : ∀ a, a ≤ t → ent.getD (a * P.S + s) 0 = enc (entSpec P a s)) :
    sCell d pref ent t s τ = enc (col P t s τ) := by
  have hS : d.S = P.S := hag.S
  have hM : d.maxD = P.maxD := hag.maxD
  have hmx := colB_max
  unfold sCell
  rw [hM, col_eq_openVal P hmaxD t s τ]
  by_cases hc : 1 ≤ τ ∧ τ ≤ P.maxD ∧ τ ≤ t + 1
  · rw [if_pos hc, if_pos hc, openVal_ent]
    have hadd := colB_add_le (t + 1 - τ) τ
    have hCB := colB_mono (show t + 1 - τ + τ ≤ pTMax by omega)
    rw [enc_add (M1 := colB (t + 1 - τ) + 2 * pOB) (M2 := τ * pEB) (by omega)
      (entSpec_bounded hin hmaxD (t + 1 - τ) s) (emitRun_bounded hin s (t + 1 - τ) τ),
      ← hent (t + 1 - τ) (by omega), hS,
      sRun_eq hag hin (by omega) (by omega)
        (fun b hb => (hpref b (by omega)).1) (fun b hb => (hpref b (by omega)).2)]
  · rw [if_neg hc, if_neg hc]; rfl


/-- The walk over any cell source: `walk`'s shape, cells and tensors decoded
with `dec`. Equal to `walk` wherever the cells are `col`'s (`pWalkC_eq`). -/
def pWalkC (m : PModel) (cell : Nat → Nat → Nat → Nat) : (t s τ : Nat) → Option (List Seg)
  | t, s, τ =>
    if _hτ : τ = 0 then none
    else if _hs0 : t + 1 - τ = 0 then some [⟨s, τ⟩]
    else
      match pickBest
          (fun p : Nat × Nat =>
            dec (cell (t + 1 - τ - 1) p.1 p.2) + dec (m.dur p.1 p.2 (t + 1 - τ - 1))
              + dec (m.trans p.1 s (t + 1 - τ - 1 + 1)))
          ((List.range m.S).flatMap fun sp =>
            if sp == s then []
            else (List.range m.maxD).map fun τ0 => (sp, τ0 + 1)) with
      | none => none
      | some ((sp, τ'), _) => (pWalkC m cell (t + 1 - τ - 1) sp τ').map (⟨s, τ⟩ :: ·)
  termination_by t _ _ => t
  decreasing_by omega

theorem pWalkC_eq {m : PModel} {P : Problem} (hag : Agrees m P) (hin : InBounds P)
    (cell : Nat → Nat → Nat → Nat) {B : Nat} (hB : B ≤ pTMax)
    (hcols : ∀ t s τ, t < B → s < P.S → 1 ≤ τ → τ ≤ P.maxD → cell t s τ = enc (col P t s τ)) :
    ∀ (t s τ : Nat), t < B → pWalkC m cell t s τ = walk P t s τ
  | t, s, τ => by
    intro htB
    have ht : t < pTMax := Nat.lt_of_lt_of_le htB hB
    rw [pWalkC, walk]
    by_cases hτ : τ = 0
    · rw [dif_pos hτ, dif_pos hτ]
    · rw [dif_neg hτ, dif_neg hτ]
      by_cases hs0 : t + 1 - τ = 0
      · rw [dif_pos hs0, dif_pos hs0]
      · rw [dif_neg hs0, dif_neg hs0]
        rw [hag.S, hag.maxD]
        have hpick :
            pickBest
                (fun p : Nat × Nat =>
                  dec (cell (t + 1 - τ - 1) p.1 p.2)
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
          rw [pWalkC_eq hag hin cell hB hcols (t + 1 - τ - 1) sp τ' (by omega)]
  termination_by t _ _ => t
  decreasing_by omega


/-! ## The pick, in `Nat`

`pickBest` is a right fold that keeps the earlier of two equal candidates and
ignores `-∞`. The same fold over encoded values — scanning from the last
candidate back, replacing on `≥` — returns the same candidate, without a
`Score` built per candidate. -/

/-- One candidate of the right fold: `x` with value `v` against the best of
    the candidates after it (`0` for none). -/
@[inline] def stepR (x : Nat × Nat) (v : Nat) (st : Nat × (Nat × Nat)) : Nat × (Nat × Nat) :=
  if st.1 ≤ v ∧ v ≠ 0 then (v, x) else st

/-- The lengths `τ0 + 1`, `τ0 < k`, of state `sp`, last first. -/
def pickT (g : Nat → Nat → Nat) (sp : Nat) : Nat → Nat × (Nat × Nat) → Nat × (Nat × Nat)
  | 0, st => st
  | k + 1, st => pickT g sp k (stepR (sp, k + 1) (g sp (k + 1)) st)

/-- The states `sp < k`, last first, each over its lengths `< n`; `skip` ones left out. -/
def pickS (g : Nat → Nat → Nat) (n : Nat) (skip : Nat → Bool) : Nat → Nat × (Nat × Nat) → Nat × (Nat × Nat)
  | 0, st => st
  | k + 1, st => pickS g n skip k (if skip k then st else pickT g k n st)

/-- How a `Nat` fold state stands for a `pickBest` result. -/
def PickRel (st : Nat × (Nat × Nat)) (o : Option ((Nat × Nat) × Score)) : Prop :=
  (st.1 = 0 ∧ o = none) ∨ (st.1 ≠ 0 ∧ o = some (st.2, dec st.1))

theorem dec_ble {a b : Nat} (ha : a ≠ 0) (hb : b ≠ 0) : Score.ble (dec a) (dec b) = decide (a ≤ b) := by
  simp only [dec, if_neg ha, if_neg hb, Score.ble]
  by_cases h : a ≤ b <;> simp [h] <;> omega

theorem pickBest_foldr (f : Nat × Nat → Score) (g : Nat × Nat → Nat) :
    ∀ (l : List (Nat × Nat)), (∀ x ∈ l, f x = dec (g x)) →
      PickRel (l.foldr (fun x st => stepR x (g x) st) (0, (0, 0))) (pickBest f l)
  | [], _ => Or.inl ⟨rfl, rfl⟩
  | x :: xs, h => by
    have ih := pickBest_foldr f g xs (fun y hy => h y (List.mem_cons_of_mem _ hy))
    have hx := h x (List.mem_cons_self ..)
    simp only [List.foldr_cons, pickBest]
    generalize xs.foldr (fun x st => stepR x (g x) st) (0, (0, 0)) = st at ih ⊢
    rcases ih with ⟨h0, hn⟩ | ⟨h0, hs⟩
    · rw [hn]
      unfold PickRel stepR
      rw [h0]
      by_cases hv : g x = 0
      · simp [hv, hx, dec, h0]
      · rw [if_pos ⟨Nat.zero_le _, hv⟩]
        simp [hx, dec, hv]
    · rw [hs]
      simp only [stepR, hx]
      by_cases hv : g x = 0
      · have : ¬ (st.1 ≤ g x ∧ g x ≠ 0) := by omega
        rw [if_neg this]
        have hble : Score.ble (dec st.1) (dec (g x)) = false := by
          simp [dec, hv, if_neg h0, Score.ble]
        rw [hble]
        exact Or.inr ⟨h0, rfl⟩
      · rw [dec_ble h0 hv]
        by_cases hle : st.1 ≤ g x
        · rw [if_pos ⟨hle, hv⟩]
          simp only [hle, decide_true, if_true]
          exact Or.inr ⟨hv, rfl⟩
        · rw [if_neg (by omega)]
          simp only [hle, decide_false, Bool.false_eq_true, if_false]
          exact Or.inr ⟨h0, rfl⟩

theorem pickT_foldr (g : Nat → Nat → Nat) (sp : Nat) :
    ∀ k st, pickT g sp k st
      = ((List.range k).map fun τ0 => (sp, τ0 + 1)).foldr (fun x st => stepR x (g x.1 x.2) st) st
  | 0, st => rfl
  | k + 1, st => by
    rw [pickT, pickT_foldr g sp k, List.range_succ, List.map_append, List.foldr_append]
    rfl

theorem pickS_foldr (g : Nat → Nat → Nat) (n : Nat) (skip : Nat → Bool) :
    ∀ k st, pickS g n skip k st
      = ((List.range k).flatMap fun sp => if skip sp then [] else (List.range n).map fun τ0 => (sp, τ0 + 1)).foldr
          (fun x st => stepR x (g x.1 x.2) st) st
  | 0, st => rfl
  | k + 1, st => by
    rw [pickS, pickS_foldr g n skip k, List.range_succ, List.flatMap_append, List.foldr_append]
    congr 1
    simp only [List.flatMap_cons, List.flatMap_nil, List.append_nil]
    cases skip k
    · simp [pickT_foldr]
    · simp

/-- Lengths past `n` whose values are all `0` change nothing. -/
theorem pickT_pad (g : Nat → Nat → Nat) (sp n : Nat) (hz : ∀ τ0, n ≤ τ0 → g sp (τ0 + 1) = 0) :
    ∀ k st, n ≤ k → pickT g sp k st = pickT g sp n st
  | 0, st, h => by have : n = 0 := by omega
                   subst this; rfl
  | k + 1, st, h => by
    by_cases hk : n = k + 1
    · subst hk; rfl
    · rw [pickT, pickT_pad g sp n hz k _ (by omega)]
      congr 1
      simp [stepR, hz k (by omega)]

/-- The pick: over states `< S` (`skip` left out) and lengths `≤ n`. -/
def sPick (g : Nat → Nat → Nat) (S n : Nat) (skip : Nat → Bool) : Option ((Nat × Nat) × Nat) :=
  let st := pickS g n skip S (0, (0, 0))
  if st.1 = 0 then none else some (st.2, st.1)

theorem pickS_pad (g : Nat → Nat → Nat) (n M : Nat) (skip : Nat → Bool) (hnM : n ≤ M)
    (hz : ∀ sp τ0, n ≤ τ0 → g sp (τ0 + 1) = 0) :
    ∀ k st, pickS g M skip k st = pickS g n skip k st
  | 0, st => rfl
  | k + 1, st => by
    rw [pickS, pickS, pickT_pad g k n (hz k) M st hnM, pickS_pad g n M skip hnM hz k]

/-- `sPick` is `pickBest` over the full candidate list, values decoded. -/
theorem sPick_eq (g : Nat → Nat → Nat) (f : Nat × Nat → Score) {S n M : Nat} (skip : Nat → Bool)
    (hnM : n ≤ M) (hz : ∀ sp τ0, n ≤ τ0 → g sp (τ0 + 1) = 0)
    (hf : ∀ sp τ0, sp < S → τ0 < M → f (sp, τ0 + 1) = dec (g sp (τ0 + 1))) :
    (sPick g S n skip).map (fun r => (r.1, dec r.2))
      = pickBest f ((List.range S).flatMap fun sp =>
          if skip sp then [] else (List.range M).map fun τ0 => (sp, τ0 + 1)) := by
  have hrel := pickBest_foldr f (fun x => g x.1 x.2)
    ((List.range S).flatMap fun sp => if skip sp then [] else (List.range M).map fun τ0 => (sp, τ0 + 1))
    (by
      intro x hx
      simp only [List.mem_flatMap, List.mem_range] at hx
      obtain ⟨sp, hsp, hx2⟩ := hx
      cases hb : skip sp <;> rw [hb] at hx2
      · simp only [Bool.false_eq_true, if_false, List.mem_map, List.mem_range] at hx2
        obtain ⟨τ0, hτ0, rfl⟩ := hx2
        exact hf sp τ0 hsp hτ0
      · simp at hx2)
  rw [← pickS_foldr, pickS_pad g n M skip hnM hz] at hrel
  unfold sPick
  generalize pickS g n skip S (0, (0, 0)) = st at hrel ⊢
  rcases hrel with ⟨h0, hn⟩ | ⟨h0, hs⟩
  · rw [hn, if_pos h0]; rfl
  · rw [hs, if_neg h0]; rfl

/-- The walk over by-start cells, each boundary's argmax in `Nat` (`sPick`)
    over the lengths that fit before it. -/
def sWalk (d : PData) (pref : Pref) (ent : Array Nat) : (t s τ : Nat) → Option (List Seg)
  | t, s, τ =>
    if _hτ : τ = 0 then none
    else if _hs0 : t + 1 - τ = 0 then some [⟨s, τ⟩]
    else
      match sPick (fun sp τ' => pAdd (pAdd (sCell d pref ent (t + 1 - τ - 1) sp τ')
            (d.durAt sp τ' (t + 1 - τ - 1))) (d.transAt sp s (t + 1 - τ - 1 + 1)))
          d.S (min d.maxD (t + 1 - τ - 1 + 1)) (fun sp => sp == s) with
      | none => none
      | some ((sp, τ'), _) => (sWalk d pref ent (t + 1 - τ - 1) sp τ').map (⟨s, τ⟩ :: ·)
  termination_by t _ _ => t
  decreasing_by omega

theorem dec_pAdd3 {x y z : Score} {Mx : Nat} (hx : Bounded Mx x) (hy : Bounded pOB y) (hz : Bounded pOB z)
    (hM : Mx + pOB + pOB < pOff) :
    dec (pAdd (pAdd (enc x) (enc y)) (enc z)) = x + y + z := by
  rw [← enc_add (M1 := Mx) (M2 := pOB) (by omega) hx hy,
    ← enc_add (M1 := Mx + pOB) (M2 := pOB) (by omega) (hx.add hy) hz,
    dec_enc (M := Mx + pOB + pOB) (by omega) ((hx.add hy).add hz)]

theorem sWalk_eq {d : PData} {P : Problem} (hag : Agrees (toModel d) P) (hin : InBounds P)
    (hT : P.T ≤ pTMax) {pref : Pref} {ent : Array Nat}
    (hcols : ∀ t s τ, t < P.T → s < P.S → 1 ≤ τ → τ ≤ P.maxD →
      sCell d pref ent t s τ = enc (col P t s τ)) :
    ∀ t s τ, t < P.T → sWalk d pref ent t s τ = pWalkC (toModel d) (sCell d pref ent) t s τ
  | t, s, τ => by
    intro ht
    have hS : d.S = P.S := hag.S
    have hM : d.maxD = P.maxD := hag.maxD
    rw [sWalk, pWalkC]
    by_cases hτ : τ = 0
    · rw [dif_pos hτ, dif_pos hτ]
    · rw [dif_neg hτ, dif_neg hτ]
      by_cases hs0 : t + 1 - τ = 0
      · rw [dif_pos hs0, dif_pos hs0]
      · rw [dif_neg hs0, dif_neg hs0]
        have ht' : t + 1 - τ - 1 < P.T := by omega
        have hmx := colB_max
        have hCB := colB_mono (show t + 1 - τ - 1 ≤ pTMax by omega)
        have hpick := sPick_eq
          (fun sp τ' => pAdd (pAdd (sCell d pref ent (t + 1 - τ - 1) sp τ')
            (d.durAt sp τ' (t + 1 - τ - 1))) (d.transAt sp s (t + 1 - τ - 1 + 1)))
          (fun p : Nat × Nat =>
            dec (sCell d pref ent (t + 1 - τ - 1) p.1 p.2) + dec ((toModel d).dur p.1 p.2 (t + 1 - τ - 1))
              + dec ((toModel d).trans p.1 s (t + 1 - τ - 1 + 1)))
          (S := d.S) (n := min d.maxD (t + 1 - τ - 1 + 1)) (M := d.maxD) (fun sp => sp == s)
          (Nat.min_le_left _ _)
          (by
            intro sp τ0 hτ0
            have : ¬ (1 ≤ τ0 + 1 ∧ τ0 + 1 ≤ d.maxD ∧ τ0 + 1 ≤ t + 1 - τ - 1 + 1) := by omega
            simp only [sCell, if_neg this, pAdd]; simp)
          (by
            intro sp τ0 hsp hτ0
            have hc := hcols (t + 1 - τ - 1) sp (τ0 + 1) ht' (by omega) (by omega) (by omega)
            have hd : d.durAt sp (τ0 + 1) (t + 1 - τ - 1) = enc (P.dur sp (τ0 + 1) (t + 1 - τ - 1)) :=
              hag.dur sp (τ0 + 1) (t + 1 - τ - 1)
            have htr : d.transAt sp s (t + 1 - τ - 1 + 1) = enc (P.trans sp s (t + 1 - τ - 1 + 1)) :=
              hag.trans sp s (t + 1 - τ - 1 + 1)
            show _ = dec (pAdd (pAdd (sCell d pref ent (t + 1 - τ - 1) sp (τ0 + 1))
              (d.durAt sp (τ0 + 1) (t + 1 - τ - 1))) (d.transAt sp s (t + 1 - τ - 1 + 1)))
            rw [hc, hd, htr, dec_pAdd3 (col_bounded hin _ sp (τ0 + 1)) (hin.dur _ _ _) (hin.trans _ _ _)
              (by omega)]
            show dec (sCell d pref ent (t + 1 - τ - 1) sp (τ0 + 1)) + dec (d.durAt sp (τ0 + 1) (t + 1 - τ - 1))
              + dec (d.transAt sp s (t + 1 - τ - 1 + 1)) = _
            rw [hc, hd, htr,
              dec_enc (M := colB (t + 1 - τ - 1)) (by omega) (col_bounded hin _ sp (τ0 + 1)),
              dec_enc (M := pOB) (by simp only [pOB, pOff]; omega) (hin.dur _ _ _),
              dec_enc (M := pOB) (by simp only [pOB, pOff]; omega) (hin.trans _ _ _)])
        generalize sPick (fun sp τ' => pAdd (pAdd (sCell d pref ent (t + 1 - τ - 1) sp τ')
            (d.durAt sp τ' (t + 1 - τ - 1))) (d.transAt sp s (t + 1 - τ - 1 + 1)))
          d.S (min d.maxD (t + 1 - τ - 1 + 1)) (fun sp => sp == s) = o at hpick ⊢
        dsimp only [toModel] at hpick ⊢
        rw [← hpick]
        cases o with
        | none => rfl
        | some q =>
          obtain ⟨⟨sp, τ'⟩, b⟩ := q
          dsimp only [Option.map]
          rw [sWalk_eq hag hin hT hcols (t + 1 - τ - 1) sp τ' ht']
          rfl
  termination_by t _ _ => t
  decreasing_by omega

/-- The final pick and the walk over given entering rows. -/
def sDecodeWith (d : PData) (pref : Pref) (ent : Array Nat) : Option DecodeResult :=
  match sPick (fun s τ => pAdd (sCell d pref ent (d.T - 1) s τ) (d.durAt s τ (d.T - 1)))
      d.S (min d.maxD d.T) (fun _ => false) with
  | none => none
  | some ((s, τ), b) =>
    match sWalk d pref ent (d.T - 1) s τ with
    | none => none
    | some rsegs => some ⟨(toPath rsegs.reverse).toArray, dec b⟩

/-- The by-start decoder: the rows once, then the final pick and the walk,
    every argmax in `Nat`. -/
def sDecode (d : PData) : Option DecodeResult :=
  if d.T = 0 then some ⟨#[], Score.zero⟩
  else sDecodeWith d (sPrefix d) (sBuild d (sPrefix d) d.T).1

theorem sDecode_eq {d : PData} {P : Problem} (hag : Agrees (toModel d) P) (hin : InBounds P)
    (hT : P.T ≤ pTMax) : sDecode d = decode P := by
  have hS : d.S = P.S := hag.S
  have hM : d.maxD = P.maxD := hag.maxD
  have hTT : d.T = P.T := hag.T
  unfold sDecode sDecodeWith decode
  rw [hTT]
  by_cases hTz : P.T = 0
  · rw [if_pos hTz, if_pos hTz]
  · rw [if_neg hTz, if_neg hTz]
    have hmx := colB_max
    have hCB := colB_mono (show P.T - 1 ≤ pTMax by omega)
    have hpick0 : ∀ (hmaxD : 1 ≤ P.maxD),
        (sPick (fun s τ => pAdd (sCell d (sPrefix d) (sBuild d (sPrefix d) P.T).1 (P.T - 1) s τ)
            (d.durAt s τ (P.T - 1))) d.S (min d.maxD P.T) (fun _ => false)).map (fun r => (r.1, dec r.2))
          = pickBest (fun p : Nat × Nat => col P (P.T - 1) p.1 p.2 + P.dur p.1 p.2 (P.T - 1))
              ((List.range P.S).flatMap fun s => (List.range P.maxD).map fun τ0 => (s, τ0 + 1)) := by
      intro hmaxD
      have hpref : ∀ s b, s < P.S → b ≤ P.T →
          ((sPrefix d).getD s (#[], #[])).1.getD b 0 = zSum d s b ∧
          ((sPrefix d).getD s (#[], #[])).2.getD b 0 = kSum d s b :=
        fun s b hs hb => sPrefix_spec d (by rw [hS]; exact hs) (by rw [hTT]; exact hb)
      obtain ⟨_, _, hent, _⟩ := sBuild_spec hag hin hmaxD hT hpref P.T (Nat.le_refl _)
      have hl : ((List.range P.S).flatMap fun s => (List.range P.maxD).map fun τ0 => (s, τ0 + 1))
          = ((List.range d.S).flatMap fun s =>
              if (fun _ => false) s then [] else (List.range d.maxD).map fun τ0 => (s, τ0 + 1)) := by
        simp [hS, hM]
      rw [hl]
      apply sPick_eq _ _ _ (by rw [hM]; exact Nat.min_le_left _ _)
      · intro sp τ0 hτ0
        have : ¬ (1 ≤ τ0 + 1 ∧ τ0 + 1 ≤ d.maxD ∧ τ0 + 1 ≤ P.T - 1 + 1) := by omega
        simp only [sCell, if_neg this, pAdd]; simp
      · intro sp τ0 hsp hτ0
        have hc := sCell_eq (t := P.T - 1) (s := sp) (τ := τ0 + 1) hag hin hmaxD (by omega)
          (fun b hb => hpref sp b (by omega) (by omega)) (fun a ha => hent a sp (by omega) (by omega))
        have hd : d.durAt sp (τ0 + 1) (P.T - 1) = enc (P.dur sp (τ0 + 1) (P.T - 1)) :=
          hag.dur sp (τ0 + 1) (P.T - 1)
        show _ = dec (pAdd (sCell d (sPrefix d) (sBuild d (sPrefix d) P.T).1 (P.T - 1) sp (τ0 + 1))
          (d.durAt sp (τ0 + 1) (P.T - 1)))
        rw [hc, hd, ← enc_add (M1 := colB (P.T - 1)) (M2 := pOB) (by omega)
            (col_bounded hin _ sp (τ0 + 1)) (hin.dur _ _ _),
          dec_enc (M := colB (P.T - 1) + pOB) (by omega)
            ((col_bounded hin _ sp (τ0 + 1)).add (hin.dur _ _ _))]
    by_cases hM0 : P.maxD = 0
    · have : min d.maxD P.T = 0 := by rw [hM, hM0]; exact Nat.zero_min _
      rw [this]
      have hz : ∀ k st, pickS (fun s τ => pAdd (sCell d (sPrefix d) (sBuild d (sPrefix d) P.T).1 (P.T - 1) s τ)
          (d.durAt s τ (P.T - 1))) 0 (fun _ => false) k st = st := by
        intro k; induction k with
        | zero => intro st; rfl
        | succ k ih => intro st; simp [pickS, pickT, ih]
      simp only [sPick, hz, hM0, List.range_zero, List.map_nil]
      rw [List.flatMap_eq_nil_iff.mpr (fun _ _ => rfl)]
      rfl
    have hmaxD : 1 ≤ P.maxD := by omega
    have hpref : ∀ s b, s < P.S → b ≤ P.T →
        ((sPrefix d).getD s (#[], #[])).1.getD b 0 = zSum d s b ∧
        ((sPrefix d).getD s (#[], #[])).2.getD b 0 = kSum d s b :=
      fun s b hs hb => sPrefix_spec d (by rw [hS]; exact hs) (by rw [hTT]; exact hb)
    obtain ⟨_, _, hent, _⟩ := sBuild_spec hag hin hmaxD hT hpref P.T (Nat.le_refl _)
    have hcols : ∀ t s τ, t < P.T → s < P.S → 1 ≤ τ → τ ≤ P.maxD →
        sCell d (sPrefix d) (sBuild d (sPrefix d) P.T).1 t s τ = enc (col P t s τ) :=
      fun t s τ ht hs _ _ => sCell_eq hag hin hmaxD (by omega)
        (fun b hb => hpref s b hs (by omega)) (fun a ha => hent a s (by omega) hs)
    rw [← hpick0 hmaxD]
    cases hq : sPick (fun s τ => pAdd (sCell d (sPrefix d) (sBuild d (sPrefix d) P.T).1 (P.T - 1) s τ)
        (d.durAt s τ (P.T - 1))) d.S (min d.maxD P.T) (fun _ => false) with
    | none => rfl
    | some q =>
      obtain ⟨⟨s, τ⟩, b⟩ := q
      dsimp only [Option.map]
      rw [sWalk_eq hag hin hT hcols (P.T - 1) s τ (by omega),
        pWalkC_eq hag hin _ hT hcols (P.T - 1) s τ (by omega)]
      rfl

theorem sDecode_correct {d : PData} {P : Problem} (hag : Agrees (toModel d) P)
    (hin : InBounds P) (hT : P.T ≤ pTMax) {r : DecodeResult} (h : sDecode d = some r) :
    ∃ segs, wellFormed P segs = true
      ∧ score P segs = r.best
      ∧ r.best = oracleBest P
      ∧ r.path = (toPath segs).toArray :=
  decode_correct P (sDecode_eq hag hin hT ▸ h)

/-! ## Today, resumed

Two models that agree on what the rows up to `t0` read build the same rows up
to `t0` (`sBuild_agree`), and a build to a later minute only appends rows
(`sBuild_prefix`). So a day's rows, cut at `t0` and built on with the new
model, are the new model's own (`sDecodeInc_eq`). -/

theorem sBuild_size (d : PData) (pref : Pref) :
    ∀ u, (sBuild d pref u).1.size = u * d.S ∧ (sBuild d pref u).2.size = (u + 1) * d.S
  | 0 => by simp [sBuild]
  | u + 1 => by
    obtain ⟨h1, h2⟩ := sBuild_size d pref u
    rw [sBuild]
    generalize sBuild d pref u = r at h1 h2 ⊢
    obtain ⟨ent, bst⟩ := r
    simp only at h1 h2 ⊢
    simp [h1, h2, Nat.add_mul]

theorem arr_ext_getD {a b : Array Nat} (hs : a.size = b.size)
    (h : ∀ i, i < a.size → a.getD i 0 = b.getD i 0) : a = b := by
  apply Array.ext hs
  intro i h1 h2
  have := h i h1
  rwa [getD_of_lt _ _ h1, getD_of_lt _ _ h2] at this

theorem sBuild_prefix_getD (d : PData) (pref : Pref) (t0 : Nat) :
    ∀ k, (∀ i, i < t0 * d.S → (sBuild d pref (t0 + k)).1.getD i 0 = (sBuild d pref t0).1.getD i 0) ∧
      (∀ i, i < (t0 + 1) * d.S → (sBuild d pref (t0 + k)).2.getD i 0 = (sBuild d pref t0).2.getD i 0)
  | 0 => ⟨fun _ _ => rfl, fun _ _ => rfl⟩
  | k + 1 => by
    obtain ⟨ih1, ih2⟩ := sBuild_prefix_getD d pref t0 k
    obtain ⟨h1, h2⟩ := sBuild_size d pref (t0 + k)
    have hle1 : t0 * d.S ≤ (t0 + k) * d.S := Nat.mul_le_mul_right _ (by omega)
    have hle2 : (t0 + 1) * d.S ≤ (t0 + k + 1) * d.S := Nat.mul_le_mul_right _ (by omega)
    rw [show t0 + (k + 1) = (t0 + k) + 1 by omega, sBuild]
    generalize hr : sBuild d pref (t0 + k) = r at ih1 ih2 h1 h2
    obtain ⟨ent, bst⟩ := r
    simp only at ih1 ih2 h1 h2 ⊢
    exact ⟨fun i hi => by rw [getD_append_lt _ _ (by omega)]; exact ih1 i hi,
      fun i hi => by rw [getD_append_lt _ _ (by omega)]; exact ih2 i hi⟩

theorem extract_getD (a : Array Nat) {k i : Nat} (hk : k ≤ a.size) (hi : i < k) :
    (a.extract 0 k).getD i 0 = a.getD i 0 := by
  rw [getD_of_lt _ _ (by simp [Array.size_extract]; omega), getD_of_lt _ _ (by omega),
    Array.getElem_extract]
  simp

/-- A build cut at `t0` is the build to `t0`. -/
theorem sBuild_prefix (d : PData) (pref : Pref) {t0 t1 : Nat} (h : t0 ≤ t1) :
    ((sBuild d pref t1).1.extract 0 (t0 * d.S), (sBuild d pref t1).2.extract 0 ((t0 + 1) * d.S))
      = sBuild d pref t0 := by
  obtain ⟨k, rfl⟩ : ∃ k, t1 = t0 + k := ⟨t1 - t0, by omega⟩
  obtain ⟨p1, p2⟩ := sBuild_prefix_getD d pref t0 k
  obtain ⟨s1, s2⟩ := sBuild_size d pref (t0 + k)
  obtain ⟨z1, z2⟩ := sBuild_size d pref t0
  have hle1 : t0 * d.S ≤ (t0 + k) * d.S := Nat.mul_le_mul_right _ (by omega)
  have hle2 : (t0 + 1) * d.S ≤ (t0 + k + 1) * d.S := Nat.mul_le_mul_right _ (by omega)
  apply Prod.ext
  · apply arr_ext_getD (by simp [Array.size_extract, s1, z1] <;> omega)
    intro i hi
    simp [Array.size_extract, s1] at hi
    rw [extract_getD _ (by omega) (by omega), p1 i (by omega)]
  · apply arr_ext_getD (by simp [Array.size_extract, s2, z2] <;> omega)
    intro i hi
    simp [Array.size_extract, s2] at hi
    rw [extract_getD _ (by omega) (by omega), p2 i (by omega)]

theorem zSum_agree {d₁ d₂ : PData} {f : Nat} (h : AgreeTo (toModel d₁) (toModel d₂) f) (s : Nat) :
    ∀ b, b ≤ f + 1 → zSum d₁ s b = zSum d₂ s b ∧ kSum d₁ s b = kSum d₂ s b
  | 0, _ => ⟨rfl, rfl⟩
  | b + 1, hb => by
    obtain ⟨ih1, ih2⟩ := zSum_agree h s b (by omega)
    have he : d₁.emitAt b s = d₂.emitAt b s := h.emit b s (by omega)
    simp [zSum, kSum, ih1, ih2, he]

/-- Up to `t0 ≤ f`, two agreeing models build the same rows. -/
theorem sBuild_agree {d₁ d₂ : PData} {f : Nat} (h : AgreeTo (toModel d₁) (toModel d₂) f)
    {t0 : Nat} (hf : t0 ≤ f) (hT1 : t0 ≤ d₁.T) (hT2 : t0 ≤ d₂.T) :
    ∀ u, u ≤ t0 → sBuild d₁ (sPrefix d₁) u = sBuild d₂ (sPrefix d₂) u
  | 0, _ => by
    have hS : d₁.S = d₂.S := h.S
    simp [sBuild, hS]
  | u + 1, hu => by
    have hS : d₁.S = d₂.S := h.S
    have hM : d₁.maxD = d₂.maxD := h.maxD
    have ih := sBuild_agree h hf hT1 hT2 u (by omega)
    rw [sBuild, sBuild, ih]
    generalize sBuild d₂ (sPrefix d₂) u = r
    obtain ⟨ent, bst⟩ := r
    simp only
    have hent : (ent ++ Array.ofFn (n := d₁.S) fun s => sEnt d₁ bst u s.val)
        = (ent ++ Array.ofFn (n := d₂.S) fun s => sEnt d₂ bst u s.val) := by
      congr 1
      apply arr_ext_getD (by simp [hS])
      intro i hi
      simp only [Array.size_ofFn] at hi
      rw [getD_of_lt _ _ (by simpa using hi), getD_of_lt _ _ (by simp [← hS]; exact hi),
        Array.getElem_ofFn, Array.getElem_ofFn]
      have hinit : d₁.initAt i = d₂.initAt i := h.init i
      have hentry : d₁.entryAt i u = d₂.entryAt i u := h.entry i u (by omega)
      have htr : ∀ sp, d₁.transAt sp i u = d₂.transAt sp i u := fun sp => h.trans sp i u (by omega)
      simp only [sEnt, hinit, hentry, htr, hS]
    rw [hent]
    congr 1
    apply arr_ext_getD (by simp [hS])
    intro i hi
    simp only [Array.size_append, Array.size_ofFn] at hi
    by_cases hlt : i < bst.size
    · rw [getD_append_lt _ _ hlt, getD_append_lt _ _ hlt]
    · obtain ⟨j, rfl⟩ : ∃ j, i = bst.size + j := ⟨i - bst.size, by omega⟩
      have hj : j < d₁.S := by omega
      rw [getD_append_ofFn _ _ hj, getD_append_ofFn _ _ (by rw [← hS]; exact hj), sClose_eq, sClose_eq]
      unfold sCloseRef
      rw [hM, pRangeMaxL_eq, pRangeMaxL_eq]
      apply pRangeMax_congr
      intro τ0 hτ0
      have hτu : τ0 ≤ u := by have := Nat.min_le_right d₂.maxD (u + 1); omega
      have hd : d₁.durAt j (τ0 + 1) u = d₂.durAt j (τ0 + 1) u := h.dur j (τ0 + 1) u (by omega)
      have hrun : sRun ((sPrefix d₁).getD j (#[], #[])).1 ((sPrefix d₁).getD j (#[], #[])).2 (u - τ0) (τ0 + 1)
          = sRun ((sPrefix d₂).getD j (#[], #[])).1 ((sPrefix d₂).getD j (#[], #[])).2 (u - τ0) (τ0 + 1) := by
        unfold sRun
        have hb1 := sPrefix_spec d₁ (s := j) (b := u - τ0 + (τ0 + 1)) hj (by omega)
        have hb2 := sPrefix_spec d₂ (s := j) (b := u - τ0 + (τ0 + 1)) (by rw [← hS]; exact hj) (by omega)
        have ha1 := sPrefix_spec d₁ (s := j) (b := u - τ0) hj (by omega)
        have ha2 := sPrefix_spec d₂ (s := j) (b := u - τ0) (by rw [← hS]; exact hj) (by omega)
        have zb := zSum_agree h j (u - τ0 + (τ0 + 1)) (by omega)
        have za := zSum_agree h j (u - τ0) (by omega)
        rw [hb1.1, hb1.2, hb2.1, hb2.2, ha1.1, ha1.2, ha2.1, ha2.2, zb.1, zb.2, za.1, za.2]
      have hidx : (u - τ0) * d₁.S + j = (u - τ0) * d₂.S + j := by rw [hS]
      rw [hrun, hd, hidx]

/-- `sBuild` from a given state at `t0`, for `k` more minutes. -/
def sBuildFrom (d : PData) (pref : Pref) (st : Array Nat × Array Nat) (t0 : Nat) :
    Nat → Array Nat × Array Nat
  | 0 => st
  | k + 1 =>
    match sBuildFrom d pref st t0 k with
    | (ent, bst) =>
      let ent := ent ++ Array.ofFn (n := d.S) fun s => sEnt d bst (t0 + k) s.val
      let bst := bst ++ Array.ofFn (n := d.S) fun s => sClose d pref ent s.val (t0 + k)
      (ent, bst)

theorem sBuildFrom_eq (d : PData) (pref : Pref) (t0 : Nat) :
    ∀ k, sBuildFrom d pref (sBuild d pref t0) t0 k = sBuild d pref (t0 + k)
  | 0 => rfl
  | k + 1 => by
    rw [sBuildFrom, sBuildFrom_eq d pref t0 k, show t0 + (k + 1) = (t0 + k) + 1 by omega, sBuild]

/-- The server's incremental decode: an earlier run's rows `old`, cut at `t0`
    and built on to the day's end. When the earlier run's model agrees with
    `d`'s up to `f ≥ t0`, this is `sDecode d`, and it hands on `d`'s own rows
    (`sDecodeInc_eq`). -/
def sDecodeInc (d : PData) (t0 : Nat) (old : Array Nat × Array Nat) :
    Option DecodeResult × (Array Nat × Array Nat) :=
  let pref := sPrefix d
  let rows := sBuildFrom d pref (old.1.extract 0 (t0 * d.S), old.2.extract 0 ((t0 + 1) * d.S)) t0 (d.T - t0)
  (if d.T = 0 then some ⟨#[], Score.zero⟩ else sDecodeWith d pref rows.1, rows)

theorem sDecodeInc_eq {d₁ d₂ : PData} {f : Nat} (h : AgreeTo (toModel d₁) (toModel d₂) f)
    {t0 t1 : Nat} (hf : t0 ≤ f) (h01 : t0 ≤ t1) (hT1 : t0 ≤ d₁.T) (hT2 : t0 ≤ d₂.T) :
    sDecodeInc d₂ t0 (sBuild d₁ (sPrefix d₁) t1) = (sDecode d₂, sBuild d₂ (sPrefix d₂) d₂.T) := by
  have hS : d₁.S = d₂.S := h.S
  unfold sDecodeInc
  rw [← hS, sBuild_prefix d₁ (sPrefix d₁) h01, sBuild_agree h hf hT1 hT2 t0 (Nat.le_refl _)]
  dsimp only
  rw [sBuildFrom_eq, show t0 + (d₂.T - t0) = d₂.T by omega]
  rfl

end Verified.Hsmm

/-- info: 'Verified.Hsmm.sDecode_eq' depends on axioms: [propext, Classical.choice, Quot.sound] -/
#guard_msgs in #print axioms Verified.Hsmm.sDecode_eq

/-- info: 'Verified.Hsmm.sDecodeInc_eq' depends on axioms: [propext, Classical.choice, Quot.sound] -/
#guard_msgs in #print axioms Verified.Hsmm.sDecodeInc_eq
