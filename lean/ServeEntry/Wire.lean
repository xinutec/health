import Verified
import DayEntry
import Lean.Data.Json

/-!
# `ServeEntry.Wire` — what the serve modes and the referee modes read alike

The float, fix and option parsers both halves of `ServeEntry` use. Same
`Wire` namespace as `DayEntry.Wire` (`fBits`/`jBits`/`nth`/`optArr`), so one
`open Wire` reaches all of it. Split out of `ServeEntry.lean` on 2026-10-06
so the referee modes (`ServeEntry.Gates`) can import what they share with the
serving modes without importing the serving modes.
-/

open Lean (Json)

namespace Wire

/-- A Float from either encoding on this wire: a JSON number, or the decimal of
its IEEE-754 bit pattern as a string.

⚠ **BOTH, BECAUSE THE TWO PRODUCERS DISAGREE AND FIVE FIELDS PROVED IT.** The
TypeScript arms send numbers, because that is what `JSON.stringify` makes of a
JS float. Every Lean-to-Lean hop sends bit patterns (`fBits`), because a
coordinate re-rounded on the wire moves a node's 5-dp key, which is its
IDENTITY. Reading only one of the two is how `buildWireGraph`'s `edges`/`nodes`
came out of one Lean entry point and were refused with `number expected` by the
next — a shape defect entirely inside this repository, between two files that
are both here.

⚠ IT IS NOT A LENIENT PARSE. A string that is not a bit pattern is still an
error, by name: silently reading an unparseable distance as "no evidence" would
let a day decode, look plausible, and never learn that any fix was on a
railway. -/
def jFloat (j : Json) : Except String Float :=
  match j.getStr? with
  | .ok _ => jBits j
  | .error _ => do return (← j.getNum?).toFloat

/-! ⚠ **A COORDINATE ON THIS WIRE IS A DECIMAL, AND IT HAS TO SURVIVE EXACTLY.**
Most floats in this file cross as IEEE-754 bit patterns (`fBits`/`jBits`), but
`observation.points` does not: the tensor's fixes are plain JSON numbers, because
that is what the TypeScript arm sends and what `decode-day` now sends too.

That is only safe because two things hold together — the emitter writes the
SHORTEST decimal that round-trips (`serde_json` uses Ryū; V8's `JSON.stringify`
is the same rule), and `Json.parse` reads it back to the same bits. The first is
somebody else's library; the second is checked here, so a toolchain bump that
made the parser merely close would fail loudly rather than shift every fix by an
invisible amount.

Measured 2026-08-26 before relying on it, rather than assumed. -/

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
