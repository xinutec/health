import Lean.Data.Json

/-!
# `Wire` — the float-exact JSON helpers the entry points share

Lifted out of `Main.lean` so the day entry point can live in a LIBRARY rather
than in the executable's root module (#952). Three callers use them: the day
cascade in `DayEntry`, and `Focus` / `StationChain`, which stay in `Main` and
used to reach them with `open Day (optArr nth)` — a namespace borrowing a
sibling's private helpers, which said plainly enough that they belonged neither
to `Day` nor to `Main`.

Deliberately NOT in `Verified`. That library has no `Lean.Data.Json` import and
no `Json` anywhere in it: the folds are pure and their `#guard` specs build
inputs as literals, so a parser there would be weight the proofs carry for one
caller's benefit. This module sits above `Verified` and below both entry points.

`fBits` / `jBits` are the float-exactness pair — a Float crosses as the decimal
of its IEEE-754 bit pattern, so `1e-7` and `-0.0` round-trip by construction
rather than by rounding. The TS twin is `src/lean/float-bits.ts`.
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
