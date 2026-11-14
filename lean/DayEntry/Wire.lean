import Lean.Data.Json

/-!
# `Wire` — the float-exact JSON helpers the entry points share

Shared by `DayEntry` and the serve modes, above `Verified` (which has no
`Json`: its folds are pure and their guards build literals). `fBits` / `jBits`
carry a Float as the decimal of its IEEE-754 bit pattern, so `1e-7` and `-0.0`
round-trip by construction.
-/
open Lean (Json)

namespace Wire

def fBits (v : Float) : Json := Json.str (toString v.toBits.toNat)

def jBits (j : Json) : Except String Float := do
  let s ← j.getStr?
  match s.toNat? with
  | some n => return Float.ofBits (UInt64.ofNat n)
  | none => throw s!"not a float bit pattern: {s}"

/-- An optional string field: absent and `null` both read as `none`. -/
def optStr (j : Json) (k : String) : Except String (Option String) :=
  match j.getObjVal? k with
  | .error _ => pure none
  | .ok v => if v.isNull then pure none else some <$> v.getStr?

def optBool (j : Json) (k : String) (dflt : Bool) : Except String Bool :=
  match j.getObjVal? k with
  | .error _ => pure dflt
  | .ok v => if v.isNull then pure dflt else v.getBool?

/-- A field holding an array; absent and `null` both read as empty. -/
def optArr (j : Json) (k : String) : Except String (Array Json) :=
  match j.getObjVal? k with
  | .error _ => pure #[]
  | .ok v => if v.isNull then pure #[] else v.getArr?

def nth (a : Array Json) (i : Nat) : Except String Json :=
  match a[i]? with
  | some v => pure v
  | none => throw s!"tuple too short: wanted index {i} of {a.size}"

end Wire
