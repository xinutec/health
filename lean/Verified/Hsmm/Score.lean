/-!
# Scores: log-probabilities with `-∞`

The trellis adds log-probabilities and takes maxima; `-∞` marks a hard-zero
(impossible transition / emission / duration). The pilot works over *integer*
scores — fixed-point nats — rather than floats: integer arithmetic is exact, so
the spec, the oracle, and the TypeScript decoder (whose IEEE doubles represent
integers exactly below 2^53) agree bit-for-bit, and every order/algebra lemma
is provable without a float model. The float bridge is a later, separate step
(see `docs/proposals/2026-07-verified-core-lean.md`).
-/

namespace Verified.Hsmm

/-- A score: an exact integer log-probability, or `-∞`. -/
inductive Score where
  | negInf
  | val (v : Int)
deriving Repr, DecidableEq, Inhabited

namespace Score

/-- Addition: `-∞` absorbs. -/
def add : Score → Score → Score
  | val a, val b => val (a + b)
  | _, _ => negInf

instance : Add Score := ⟨add⟩

private theorem add_eq (a b : Score) : a + b = add a b := rfl

/-- The additive identity (log 1). -/
def zero : Score := val 0

/-- Boolean order: `-∞` below everything. -/
def ble : Score → Score → Bool
  | negInf, _ => true
  | val _, negInf => false
  | val a, val b => decide (a ≤ b)

/-- Strict boolean order — the argmax loops' "improves on the incumbent" test.
`blt best cand = true` iff `cand` is strictly better. -/
def blt (a b : Score) : Bool := !(ble b a)

instance : LE Score := ⟨fun a b => ble a b = true⟩

private theorem le_def (a b : Score) : (a ≤ b) = (ble a b = true) := rfl

/-- Maximum; on a tie keeps the value (both sides equal, so either is fine). -/
def max (a b : Score) : Score := if ble a b then b else a

@[simp] theorem add_negInf (a : Score) : a + negInf = negInf := by
  cases a <;> rfl

@[simp] theorem negInf_add (a : Score) : negInf + a = negInf := rfl

@[simp] theorem val_add_val (a b : Int) : val a + val b = val (a + b) := rfl

theorem add_assoc (a b c : Score) : a + b + c = a + (b + c) := by
  cases a <;> cases b <;> cases c <;> simp [add_eq, add] <;> omega

theorem add_comm (a b : Score) : a + b = b + a := by
  cases a <;> cases b <;> simp [add_eq, add] <;> omega

@[simp] theorem add_zero (a : Score) : a + zero = a := by
  cases a <;> simp [add_eq, add, zero]

@[simp] theorem zero_add (a : Score) : zero + a = a := by
  cases a <;> simp [add_eq, add, zero]

theorem le_refl (a : Score) : a ≤ a := by
  cases a <;> simp [le_def, ble]

theorem le_trans {a b c : Score} : a ≤ b → b ≤ c → a ≤ c := by
  cases a <;> cases b <;> cases c <;> simp [le_def, ble] <;> omega

theorem le_total (a b : Score) : a ≤ b ∨ b ≤ a := by
  cases a <;> cases b <;> simp [le_def, ble] <;> omega

theorem le_antisymm {a b : Score} : a ≤ b → b ≤ a → a = b := by
  cases a <;> cases b <;> simp [le_def, ble] <;> omega

@[simp] theorem negInf_le (a : Score) : negInf ≤ a := by
  cases a <;> simp [le_def, ble]

theorem le_max_left (a b : Score) : a ≤ max a b := by
  unfold max
  split
  · -- `a ≤ b` is definitionally `ble a b = true`, the split hypothesis.
    next h => exact h
  · exact le_refl a

theorem le_max_right (a b : Score) : b ≤ max a b := by
  unfold max
  split
  · exact le_refl b
  · next h =>
    rcases le_total a b with hab | hba
    · exact absurd hab h
    · exact hba

theorem max_le {a b c : Score} : a ≤ c → b ≤ c → max a b ≤ c := by
  intro h1 h2
  unfold max
  split
  · exact h2
  · exact h1

/-- `max` returns one of its arguments. -/
theorem max_eq_or (a b : Score) : max a b = a ∨ max a b = b := by
  unfold max; split <;> simp

@[simp] theorem negInf_max (a : Score) : max negInf a = a := rfl

@[simp] theorem max_negInf (a : Score) : max a negInf = a := by
  cases a <;> rfl

theorem max_assoc (a b c : Score) : max (max a b) c = max a (max b c) := by
  apply le_antisymm
  · exact max_le
      (max_le (le_max_left a _) (le_trans (le_max_left b c) (le_max_right a _)))
      (le_trans (le_max_right b c) (le_max_right a _))
  · exact max_le
      (le_trans (le_max_left a b) (le_max_left _ c))
      (max_le (le_trans (le_max_right a b) (le_max_left _ c)) (le_max_right _ c))

theorem add_le_add_left {a b : Score} (h : a ≤ b) (c : Score) : c + a ≤ c + b := by
  cases c <;> cases a <;> cases b <;> simp_all [le_def, ble, add_eq, add] <;> omega

/-- Addition distributes over `max` (`-∞` absorbs on both sides). -/
theorem add_max (c a b : Score) : c + max a b = max (c + a) (c + b) := by
  apply le_antisymm
  · rcases max_eq_or a b with h | h <;> rw [h]
    · exact le_max_left ..
    · exact le_max_right ..
  · exact max_le (add_le_add_left (le_max_left a b) c) (add_le_add_left (le_max_right a b) c)

/-- Fold a list down to its maximum, starting from `-∞`. -/
def listMax (xs : List Score) : Score := xs.foldl max negInf

theorem foldl_max_ge_init (acc : Score) (xs : List Score) : acc ≤ xs.foldl max acc := by
  induction xs generalizing acc with
  | nil => exact le_refl acc
  | cons y ys ih => exact le_trans (le_max_left acc y) (ih (max acc y))

theorem foldl_max_ge_mem {x : Score} {xs : List Score} (hx : x ∈ xs) (acc : Score) :
    x ≤ xs.foldl max acc := by
  induction xs generalizing acc with
  | nil => cases hx
  | cons y ys ih =>
    cases hx with
    | head => exact le_trans (le_max_right acc _) (foldl_max_ge_init _ ys)
    | tail _ hmem => exact ih hmem (max acc y)

/-- Every list element is bounded by the list maximum. -/
theorem listMax_ge {xs : List Score} {x : Score} (hx : x ∈ xs) : x ≤ listMax xs :=
  foldl_max_ge_mem hx negInf

theorem foldl_max_attained (acc : Score) (xs : List Score) :
    xs.foldl max acc ∈ xs ∨ xs.foldl max acc = acc := by
  induction xs generalizing acc with
  | nil => exact .inr rfl
  | cons y ys ih =>
    simp only [List.foldl_cons]
    rcases ih (max acc y) with h | h
    · exact .inl (List.mem_cons_of_mem _ h)
    · rcases max_eq_or acc y with h2 | h2
      · exact .inr (h.trans h2)
      · exact .inl (by rw [h, h2]; exact List.mem_cons_self ..)

/-- The list maximum is attained by some element (or the list had no finite
score and the maximum is `-∞`). -/
theorem listMax_mem_or_negInf (xs : List Score) : listMax xs ∈ xs ∨ listMax xs = negInf :=
  foldl_max_attained negInf xs

/-- Folding from any seed equals `max seed (fold from -∞)`. -/
theorem foldl_max_eq (acc : Score) (xs : List Score) :
    xs.foldl max acc = max acc (xs.foldl max negInf) := by
  induction xs generalizing acc with
  | nil => simp
  | cons y ys ih =>
    simp only [List.foldl_cons, negInf_max]
    rw [ih (max acc y), ih y, ← max_assoc]

@[simp] theorem listMax_nil : listMax [] = negInf := rfl

theorem listMax_cons (y : Score) (ys : List Score) : listMax (y :: ys) = max y (listMax ys) := by
  simp only [listMax, List.foldl_cons, negInf_max]
  exact foldl_max_eq y ys

theorem listMax_append (xs ys : List Score) :
    listMax (xs ++ ys) = max (listMax xs) (listMax ys) := by
  simp only [listMax, List.foldl_append]
  exact foldl_max_eq _ ys

/-- The maximum over a `flatMap` is the maximum of the per-chunk maxima. -/
theorem listMax_flatMap {α : Type} (l : List α) (h : α → List Score) :
    listMax (l.flatMap h) = listMax (l.map fun x => listMax (h x)) := by
  induction l with
  | nil => rfl
  | cons x xs ih =>
    simp only [List.flatMap_cons, List.map_cons]
    rw [listMax_append, listMax_cons, ih]

/-- Addition distributes over the list maximum (both sides are `-∞` on `[]`). -/
theorem add_listMax (c : Score) (xs : List Score) :
    c + listMax xs = listMax (xs.map (c + ·)) := by
  induction xs with
  | nil => simp
  | cons y ys ih =>
    simp only [List.map_cons, listMax_cons, add_max, ih]

/-- `add_listMax` in mapped form: a constant summand hoists out of a
per-element maximum. -/
theorem add_listMax_map {α : Type} (c : Score) (f : α → Score) (l : List α) :
    listMax (l.map fun x => c + f x) = c + listMax (l.map f) := by
  rw [add_listMax, List.map_map]
  rfl

end Score

end Verified.Hsmm
