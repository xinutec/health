/-!
# One GPS fix, once

One fix type for every pass module; each module's `Fix` is an `abbrev` of
`GeoFix` (not `Fix`, so a bare `Fix` in a `Verified.*` namespace still means
the module's own).
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
def SpeedFix.within (xs : Array SpeedFix) (startTs endTs : Int) : Array SpeedFix :=
  xs.filter fun p => p.ts ≥ startTs && p.ts ≤ endTs

end Verified
