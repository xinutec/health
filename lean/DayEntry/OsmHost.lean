import Verified
import DayEntry.Wire
import DayEntry.Host

/-!
# `OsmHost` — the three matcher lookups, asked of the host

`walkableRoads`, `buildingsNear` and `drivableRoads`, the walk and road
matchers' mid-fold reads on discs the fold chooses, each one `DayEntry.Host.ask`.

A way is the record a fixture's `osmTrace` holds, coordinates as bit patterns:

    {"osmId": 7, "name": "A" | null, "subtype": "footway" | null,
     "coords": [[latBits, lonBits], …]}

A building ring is a bare array of `[latBits, lonBits]`. `name` absent and `""`
stay distinct: the road matcher's way-switch penalty reads `Way.name`.

A decline is `none`, an empty answer `some #[]` (see `Host`): the walk pass
bails on either, but a decline is a gap the host can record and fetch.

Not in `Verified`, which has no `Json`, `IO` or host.
-/

open Lean (Json)
open Wire

namespace DayEntry.OsmHost

open Verified.Geo.WalkableRoute (Pt)
open Verified.Geo.OsmCorridor (Way)

abbrev Ring := Array Pt

/-- `[latBits, lonBits]`. -/
def parsePt (j : Json) : Except String Pt := do
  let a ← j.getArr?
  return { lat := ← jBits (← nth a 0), lon := ← jBits (← nth a 1) }

def parseRing (j : Json) : Except String Ring := do
  (← j.getArr?).mapM parsePt

def parseRings (j : Json) : Except String (Array Ring) := do
  (← j.getArr?).mapM parseRing

def parseWay (j : Json) : Except String Way := do
  return {
    osmId := ← (← j.getObjVal? "osmId").getInt?
    name := ← optStr j "name"
    subtype := ← optStr j "subtype"
    coords := ← (← (← j.getObjVal? "coords").getArr?).mapM parsePt }

def parseWays (j : Json) : Except String (Array Way) := do
  (← j.getArr?).mapM parseWay

/-- The key every OSM ask is spelled with: three bit patterns. The radius is a
`Float` on the wire even where the caller holds an `Int`, so one spelling serves
all three tables and the host parses one shape. -/
def key (lat lon radiusM : Float) : String :=
  s!"{lat.toBits}|{lon.toBits}|{radiusM.toBits}"

def walkableRoads (lat lon : Float) (radiusM : Int) : Option (Array Way) :=
  Host.askAs "walkableRoads" (key lat lon (Float.ofInt radiusM)) parseWays

def buildingsNear (lat lon : Float) (radiusM : Int) : Option (Array Ring) :=
  Host.askAs "buildingsNear" (key lat lon (Float.ofInt radiusM)) parseRings

/-- `radiusM` is a `Float` here: `OsmCorridor` passes the corridor radius
through untouched, while the walk pass's radius is whole metres. -/
def drivableRoads (lat lon radiusM : Float) : Option (Array Way) :=
  Host.askAs "drivableRoads" (key lat lon radiusM) parseWays

/-! ## Specs — the row shapes, on literals -/

/-- `1.0` is `4607182418800017408`, `2.0` is `4611686018427387904`. -/
private def ONE_WAY : Json := Json.parse
  "[{\"osmId\":7,\"name\":\"A\",\"subtype\":null,\"coords\":[[\"4607182418800017408\",\"4611686018427387904\"]]}]"
  |>.toOption.get!

#guard (parseWays ONE_WAY).toOption ==
  some #[{ osmId := 7, name := some "A", subtype := none, coords := #[{ lat := 1.0, lon := 2.0 }] }]

-- Absent is not empty: `name: ""` is a name, a missing `name` is `none`.
#guard (parseWays (Json.parse "[{\"osmId\":7,\"name\":\"\",\"coords\":[]}]" |>.toOption.get!)
  |>.toOption.map fun ws => ws[0]!.name) == some (some "")
#guard (parseWays (Json.parse "[{\"osmId\":7,\"coords\":[]}]" |>.toOption.get!)
  |>.toOption.map fun ws => ws[0]!.name) == some none

#guard (parseRings (Json.parse "[[[\"4607182418800017408\",\"4611686018427387904\"]]]" |>.toOption.get!)).toOption ==
  some #[#[{ lat := 1.0, lon := 2.0 }]]

#guard (parseRings (Json.parse "[]" |>.toOption.get!)).toOption == some #[]

-- A row that is not the shape refuses rather than decoding to nothing.
#guard (parseWays (Json.parse "[{\"coords\":[]}]" |>.toOption.get!)).toOption == none

-- The key is three bit patterns; an integer radius spells as its Float.
#guard key 1.0 2.0 (Float.ofInt 100) == "4607182418800017408|4611686018427387904|4636737291354636288"

end DayEntry.OsmHost
