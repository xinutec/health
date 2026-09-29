import Verified.Hsmm.Emissions
/-!
# HSMM state-space enumeration (implementation-first port of `state-space.ts`)

The served decode's hidden state at each minute is a `(mode, place, line)` tuple
with structural constraints. This is the line-only enumeration that the served
path uses (`decode.ts` calls `buildStateSpace` with no `railEdges`, so the
per-edge Phase-1 states — and their `trainEdgeId` — never arise here; that lives
in the separate `route-aware-decoder.ts`, off the flip path). Faithful to the
served path, so the Lean `State` (mode/placeId/lineName) matches exactly.

Pure enumeration + dedup by `stateKey`, no geometry — a structural resolver, not
a scoring kernel. Ordering and first-occurrence dedup pinned against Node/V8.
UNPROVEN; pinned by the `#guard`.
-/

namespace Verified.Hsmm.StateSpace

open Verified.Hsmm.Emissions (Mode State)

/-- Mode → its `stateKey` token (matches the TS `ModelledMode` string). -/
def modeName : Mode → String
  | .stationary => "stationary"
  | .walking => "walking"
  | .cycling => "cycling"
  | .driving => "driving"
  | .train => "train"
  | .plane => "plane"
  | .unknown => "unknown"

/-- Stable string key for a state (line-only served path). Distinct states
    produce distinct keys; same key ⇒ same state for dedup. -/
def stateKey (s : State) : String :=
  match s.mode with
  | .stationary => "stationary|" ++ (match s.placeId with | some p => toString p | none => "none")
  | .train => "train|" ++ (match s.lineName with | some l => l | none => "unknown_rail")
  | .driving => if Verified.Hsmm.Emissions.isRideHead s then "driving|head" else "driving"
  | m => modeName m

/-- The ride's-head state (#366): `driving` with the head mark. Appended to the
    state space by the context that asks for it, never by `buildStateSpace`. -/
def RIDE_HEAD_STATE : State := ⟨.driving, none, some "head"⟩

#guard stateKey RIDE_HEAD_STATE == "driving|head"
#guard stateKey ⟨.driving, none, none⟩ == "driving"

/-- Minimal focus-place identity needed for enumeration (coords come in via the
    emission model, keyed by id). -/
structure FocusPlaceRef where
  id : Int
  displayName : Option String

/-- Movement modes: no place, no line. -/
def MOVEMENT_MODES : List Mode := [.walking, .cycling, .driving, .plane, .unknown]

/-- Append in order, dropping any state whose key already appeared (mirrors the
    TS `seen`-set `push`, first occurrence wins). -/
def dedupByKey (states : List State) : List State :=
  (states.foldl
    (fun (acc : List String × List State) s =>
      let key := stateKey s
      if acc.1.contains key then acc else (key :: acc.1, s :: acc.2))
    ([], [])).2.reverse

/-- `buildStateSpace` for the served (line-only) path: movement modes, then
    off-network stationary, then one stationary per focus place, then one train
    per known line, then the `unknown_rail` catch-all — deduped by key. -/
def buildStateSpace (focusPlaces : List FocusPlaceRef) (knownLines : List String) : List State :=
  dedupByKey <|
    MOVEMENT_MODES.map (fun m => ⟨m, none, none⟩)
    ++ [⟨.stationary, none, none⟩]
    ++ focusPlaces.map (fun p => ⟨.stationary, some p.id, none⟩)
    ++ knownLines.map (fun ln => ⟨.train, none, some ln⟩)
    ++ [⟨.train, none, some "unknown_rail"⟩]

-- Parity with the real `buildStateSpace` (ordering + first-occurrence dedup;
-- keys from Node/V8). Duplicate place id 5 and duplicate "Jubilee Line" drop.
private def places : List FocusPlaceRef := [⟨5, some "Home"⟩, ⟨7, some "Work"⟩, ⟨5, some "dup"⟩]
private def lines : List String := ["Jubilee Line", "Central Line", "Jubilee Line"]

#guard (buildStateSpace places lines).map stateKey ==
  ["walking", "cycling", "driving", "plane", "unknown",
   "stationary|none", "stationary|5", "stationary|7",
   "train|Jubilee Line", "train|Central Line", "train|unknown_rail"]

#guard (buildStateSpace places lines).length == 11

end Verified.Hsmm.StateSpace
