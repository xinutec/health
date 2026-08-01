import Verified.Geo.RailRuns
/-!
# The rail-membership veto (port of `src/geo/line-membership.ts`)

"Does line L serve station S?" — asked at the moment a rail label is WRITTEN,
rather than only by the gate afterwards.

`linesAtPoint` answers a DIFFERENT question: which lines pass within a few
hundred metres of a point. At Finchley Road the North London Line's tracks run
past on their way to Finchley Road & Frognal — a different station, on a line
that never stops here — so a proximity lookup happily reports it, and a
reconstruction that only asks "which line reaches both ends" can label a
Metropolitan ride "North London line" (2026-06-28, #377).

## Why absence is the only usable signal

Membership is proximity-inferred and therefore OVER-inclusive: a station near a
passing-but-not-stopping line counts as served. So absence is strong and
presence proves little, and that asymmetry is exactly what makes this safe as a
veto — it can only fail to reject a wrong line, never reject a right one. An
empty list means the mirror does not know the line, which is NOT "serves
nothing": it asserts nothing at all, and `known` stays false.

## `normalizeStationName` here is NOT the one in `LineStoppingPattern`

This one is `trim().toLowerCase()`; `Verified.Geo.LineStoppingPattern`'s strips
to lowercase alphanumerics. They are different functions with the same name in
the TS too, and the TS says the duplication is deliberate: the gate judges this
code's output, and an invariant that imports its subject's helpers can agree
with it by construction. Do not unify them.

## Deviations from the TS, both deliberate

* The TS `lookup` returns a `Promise`; here it is a pure `String → Array
  ServedStation`. The awaiting is shell — the decision is not.
* `String.prototype.trim` covers the Unicode `Zs` class and `﻿`;
  `trimAscii` does not. Station names in the mirror are ASCII.

Exactness: no arithmetic. UNPROVEN; pinned against Node/V8
(`lean/experiments/line-membership-refs.mts`).
-/

namespace Verified.Geo.LineMembership

open Verified.Geo.RailRuns (expandTubeLineNames)

/-- The shape this module needs of a station: its name. -/
structure ServedStation where
  name : String
  deriving Inhabited, BEq, Repr

/-- Station names compare case- and whitespace-insensitively: the mirror's
station points and a leg's rendered label come from different queries and differ
in incidental spacing. -/
private def normalizeStationName (name : String) : String :=
  name.trimAscii.toString.toLower

/-- Walk the expanded components, carrying whether ANY of them was known to the
mirror. A component that serves the station ends it immediately — the TS
`return false` — so later unknown components cannot undo a match. -/
private def scan (target : String) (lookup : String → Array ServedStation) :
    List String → Bool → Bool
  | [], known => known
  | component :: rest, known =>
    let served := lookup component
    if served.isEmpty then scan target lookup rest known  -- unknown: no assertion
    else if served.any (fun s => normalizeStationName s.name == target) then false
    else scan target lookup rest true

/--
Whether `line` is known NOT to serve `station` — the veto form, so the caller's
condition reads as the rejection it is.

A compound OSM relation ("Circle, Hammersmith & City and Metropolitan Lines") is
expanded first: the label names shared track, and it suffices that ONE of the
physical lines serves the station. When no component has a known station list the
answer is `false` — unknown is not evidence.
-/
def lineCannotServe (line station : String) (lookup : String → Array ServedStation) : Bool :=
  scan (normalizeStationName station) lookup (expandTubeLineNames line) false

/-! ## Guards

A mirror that knows three lines and nothing else. The Jubilee's Finchley Road
entry carries incidental spacing and case, so normalisation is exercised on the
MIRROR side as well as the query side.
-/

private def mirror : String → Array ServedStation
  | "Metropolitan Line" => #[⟨"Wembley Park"⟩, ⟨"Finchley Road"⟩, ⟨"Baker Street"⟩]
  | "Jubilee Line" => #[⟨"Wembley Park"⟩, ⟨" finchley road "⟩, ⟨"Neasden"⟩]
  | "North London Line" => #[⟨"Finchley Road & Frognal"⟩, ⟨"West Hampstead"⟩]
  | _ => #[]

-- Served, so no veto.
#guard lineCannotServe "Metropolitan Line" "Finchley Road" mirror == false
-- THE #377 SHAPE: the tracks pass, the service does not stop. The veto fires,
-- and "Finchley Road & Frognal" must NOT count as "Finchley Road".
#guard lineCannotServe "North London Line" "Finchley Road" mirror == true
-- Unknown to the mirror — asserts nothing, so no veto.
#guard lineCannotServe "Victoria Line" "Finchley Road" mirror == false
-- Normalisation is trim + lowercase, on both sides.
#guard lineCannotServe "Jubilee Line" "FINCHLEY ROAD" mirror == false
#guard lineCannotServe "Jubilee Line" "  Finchley Road  " mirror == false
-- A compound label names shared track: ONE component serving is enough, even
-- though the first two components are unknown.
#guard lineCannotServe "Circle, Hammersmith & City and Metropolitan Lines" "Finchley Road" mirror == false
-- Every KNOWN component fails to serve, so the veto fires despite the unknown one.
#guard lineCannotServe "North London and Victoria Lines" "Finchley Road" mirror == true
-- Every component unknown: still no assertion.
#guard lineCannotServe "Victoria and Piccadilly Lines" "Finchley Road" mirror == false
-- A station no line in the mirror serves.
#guard lineCannotServe "Metropolitan Line" "Stratford" mirror == true

end Verified.Geo.LineMembership
