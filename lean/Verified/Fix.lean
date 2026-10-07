/-!
# One GPS fix, once

The TypeScript gave every pass module its own `Fix` interface and the port
kept them: twelve records with the same three fields (and three with a speed
too), converted field by field at the cascade's `Env`. They are one type now
(#1937); each module's `Fix` is an `abbrev` of these (named `GeoFix`, not `Fix`, so a bare `Fix` inside a `Verified.*` namespace still means the module's own), so its name, its
constructor and its field access read exactly as before.
-/

namespace Verified

/-- A timestamped position: Unix seconds, degrees. -/
structure GeoFix where
  ts : Int
  lat : Float
  lon : Float
  deriving Inhabited, BEq, Repr

/-- A fix with the speed the pipeline derived for it, km/h. -/
structure SpeedFix where
  ts : Int
  lat : Float
  lon : Float
  speedKmh : Float
  deriving Inhabited, BEq, Repr

/-- The fixes inside `[startTs, endTs]`, both ends included — the window every
pass's `samplesInWindow` reads. -/
def GeoFix.within (xs : Array GeoFix) (startTs endTs : Int) : Array GeoFix :=
  xs.filter fun p => p.ts ≥ startTs && p.ts ≤ endTs

/-- `GeoFix.within` for fixes that carry a speed. -/
def SpeedFix.within (xs : Array SpeedFix) (startTs endTs : Int) : Array SpeedFix :=
  xs.filter fun p => p.ts ≥ startTs && p.ts ≤ endTs

end Verified
