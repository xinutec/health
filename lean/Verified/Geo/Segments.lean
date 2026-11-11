import Verified.Fix
/-!
# What a mode's motion allows

`MAX_SPEED_FOR_MODE` is the fastest each slow mode plausibly moves, and
`roadSupportedConfidence` tempers a drive by how much of it hugged a road.
-/

namespace Verified.Geo.Segments

/-- The fastest a mode plausibly moves (km/h). Absent for a mode with no cap. -/
def MAX_SPEED_FOR_MODE : List (String × Float) := [("stationary", 5), ("walking", 12), ("cycling", 35)]

/-- Temper a `driving` segment's confidence by how much of its track hugged a
    drivable road. Non-driving or `none` fraction ⇒ unchanged. `Math.round` to
    two decimals. -/
def roadSupportedConfidence (mode : String) (confidence : Float) (roadCorridorFraction : Option Float) : Float :=
  match roadCorridorFraction with
  | none => confidence
  | some fr =>
    if mode != "driving" then confidence
    else
      let support := 0.5 + min 0.5 (max 0 fr)
      Float.floor (confidence * support * 100 + 0.5) / 100


#guard roadSupportedConfidence "driving" 0.9 (some 1.0) == 0.9
#guard roadSupportedConfidence "driving" 0.9 (some 0.0) == 0.45
#guard roadSupportedConfidence "driving" 0.88 (some 0.3) == 0.7
#guard roadSupportedConfidence "driving" 0.9 none == 0.9
#guard roadSupportedConfidence "train" 0.9 (some 0.0) == 0.9

end Verified.Geo.Segments
