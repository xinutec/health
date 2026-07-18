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

end Score

end Verified.Hsmm
