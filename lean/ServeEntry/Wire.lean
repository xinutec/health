import Verified
import DayEntry
import Lean.Data.Json

/-!
# `ServeEntry.Wire` — what the serve modes and the referee modes read alike

Float, fix and option parsers shared by `ServeEntry` and `ServeEntry.Gates`,
in the same `Wire` namespace as `DayEntry.Wire`, so one `open Wire` reaches
both. Separate so the referee modes need not import the serving ones.
-/

open Lean (Json)

namespace Wire

/-- A Float from either encoding: a JSON number (serde senders) or the decimal
of its IEEE-754 bit pattern (Lean-to-Lean hops, where re-rounding would move a
node's 5-dp identity key). Any other string is an error, by name. -/
def jFloat (j : Json) : Except String Float :=
  match j.getStr? with
  | .ok _ => jBits j
  | .error _ => do return (← j.getNum?).toFloat

/-! `observation.points` crosses as plain JSON numbers, as `decode-day` sends
them. Exact because serde writes the shortest round-trip decimal and
`Json.parse` reads it back to the same bits, which is checked here so a parser
change fails loudly. -/

def jFloatField (j : Json) (k : String) : Except String Float := do jFloat (← j.getObjVal? k)
def jOptFloat (j : Json) (k : String) : Except String (Option Float) :=
  match j.getObjVal? k with
  | .ok v => if v.isNull then .ok none else do return some (← jFloat v)
  | .error _ => .ok none
def jOptInt (j : Json) (k : String) : Except String (Option Int) :=
  match j.getObjVal? k with
  | .ok v => if v.isNull then .ok none else do return some (← v.getInt?)
  | .error _ => .ok none

def parseFix (j : Json) : Except String Verified.Hsmm.Observation.Fix := do
  return ⟨← (← j.getObjVal? "ts").getInt?, ← jFloatField j "lat", ← jFloatField j "lon"⟩
def parseOptFix (j : Json) (k : String) : Except String (Option Verified.Hsmm.Observation.Fix) :=
  match j.getObjVal? k with
  | .ok v => if v.isNull then .ok none else do return some (← parseFix v)
  | .error _ => .ok none

/-- `none` → `null`, `some s` → the string. -/
def optStrJson : Option String → Json
  | none => Json.null
  | some s => Json.str s

end Wire
