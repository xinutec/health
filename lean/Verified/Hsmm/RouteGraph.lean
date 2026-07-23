/-!
# Route-graph primitives (implementation-first port of `route-graph.ts`)

Pure primitives the HSMM route factors need from the OSM route graph. First up:
`parseLineMemberships`, which turns an OSM way's `name` tag into the set of tube
lines it carries — stripping directional suffixes ("… Eastbound") and splitting
conjunctions ("Circle, Hammersmith & City and Metropolitan Lines"). Pure string
work, no transcendentals, so it is EXACT. UNPROVEN; pinned by the `#guard`s.

(The spatial primitives — `pointToPolylineMeters`, the grid index, `edgesNear`,
line connectivity — are the larger follow-on and land here next.)
-/

namespace Verified.Hsmm.RouteGraph

/-- Directional suffixes OSM appends to distinguish parallel tracks; the line
    membership is the same either way. Order matters (first match wins). -/
def DIRECTIONALS : List String :=
  [" Eastbound", " Westbound", " Northbound", " Southbound", " Inner Rail", " Outer Rail"]

/-- Strip a trailing directional (first match), re-trimming after. -/
def stripDirectional (s : String) : String :=
  match DIRECTIONALS.find? (fun d => s.endsWith d) with
  | some d => (s.dropRight d.length).trim
  | none => s

/-- Append-preserving dedup (mirrors JS `Set` insertion-order iteration). -/
def dedup (xs : List String) : List String :=
  xs.foldl (fun acc x => if acc.contains x then acc else acc ++ [x]) []

/-- OSM way `name` → the tube lines it carries. Empty for names not ending in
    "Line"/"Lines". -/
def parseLineMemberships (name : Option String) : List String :=
  match name with
  | none => []
  | some n =>
    if n == "" then [] else
    let cleaned := stripDirectional n.trim
    let stripped? : Option String :=
      if cleaned.endsWith " Lines" then some (cleaned.dropRight " Lines".length)
      else if cleaned.endsWith " Line" then some (cleaned.dropRight " Line".length)
      else none
    match stripped? with
    | none => []
    | some stripped =>
      let parts := (stripped.splitOn " and ").flatMap (fun andPart => andPart.splitOn ", ")
      dedup (parts.filterMap (fun commaPart =>
        let trimmed := commaPart.trim
        if trimmed.isEmpty then none else some (trimmed ++ " Line")))

-- Parity with the real `parseLineMemberships` (Node/V8; Set → insertion-ordered list).
#guard parseLineMemberships (some "Metropolitan Line") == ["Metropolitan Line"]
#guard parseLineMemberships (some "Hammersmith & City Line") == ["Hammersmith & City Line"]
#guard parseLineMemberships (some "Circle, Hammersmith & City and Metropolitan Lines")
  == ["Circle Line", "Hammersmith & City Line", "Metropolitan Line"]
#guard parseLineMemberships (some "Metropolitan and Piccadilly Line")
  == ["Metropolitan Line", "Piccadilly Line"]
#guard parseLineMemberships (some "Jubilee Line Eastbound") == ["Jubilee Line"]
#guard parseLineMemberships (some "Metropolitan Line Westbound") == ["Metropolitan Line"]
#guard parseLineMemberships (some "District Line Inner Rail") == ["District Line"]
#guard parseLineMemberships (some "Not A Railway") == []
#guard parseLineMemberships (some "") == []
#guard parseLineMemberships none == []
#guard parseLineMemberships (some "Bakerloo Lines") == ["Bakerloo Line"]
#guard parseLineMemberships (some "A, B and C Lines") == ["A Line", "B Line", "C Line"]

end Verified.Hsmm.RouteGraph
