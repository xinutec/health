import Verified.Geo.EpisodeGeometry
import Verified.Hsmm.StateSpace

/-!
# The closed string vocabularies the API sends and the frontend restates

A day-state's mode and an episode geometry's kind are copied by hand into the
frontend, which keys a `Record<DayStateMode, …>` on the first: an unknown mode
falls through to a default style silently. A test compares the frontend's
unions against these lists.

Each list is tied by `#guard` to whatever closed Lean structure exists for its
members, and the members with none are named as such.
-/

namespace Verified.Geo.WireVocab

-- Fully qualified, not `open`: more than one `Mode` is in scope. It is declared
-- in `Emissions`; `StateSpace` only re-opens it, so `StateSpace.Mode` fails.
private abbrev SMode := Verified.Hsmm.Emissions.Mode
private abbrev sName := Verified.Hsmm.StateSpace.modeName

/-- Every constructor of the HSMM's generative `Mode`, written out so a new
constructor fails to compile until it is added here. -/
private def ALL_GENERATIVE : List SMode :=
  -- ⚠ spelled out, not `.stationary`. Dot-notation resolves against whichever
  -- `Mode` the elaborator picks, and there are two.
  [ Verified.Hsmm.Emissions.Mode.stationary
  , Verified.Hsmm.Emissions.Mode.walking
  , Verified.Hsmm.Emissions.Mode.cycling
  , Verified.Hsmm.Emissions.Mode.driving
  , Verified.Hsmm.Emissions.Mode.train
  , Verified.Hsmm.Emissions.Mode.plane
  , Verified.Hsmm.Emissions.Mode.unknown ]

/-- Every `mode` a day-state can carry on the wire, as a set. Sources:

  * the HSMM's generative modes (`StateSpace.modeName`), guarded as a subset;
  * the drawn-line modes (`EpisodeGeometry.MOVING_MODES`), likewise;
  * `sleeping` (from the watch's sleep windows) and `bus` (a segment's
    `vehicleKind`, lifted by `DayState`), which no Lean type derives; the guards
    pin the literals that produce them. -/
def DAY_STATE_MODES : List String :=
  ["sleeping", "stationary", "walking", "cycling", "driving", "vehicle",
   "bus", "train", "boat", "plane", "unknown"]

/-- Every `kind` an episode's geometry can carry. `matched` and `smoothed` are
handed in by the walk matcher and smoother, so they cannot be guarded against
an `EpisodeGeometry` literal. -/
def EPISODE_KINDS : List String :=
  ["snapped", "raw", "anchor", "tentative", "matched", "smoothed"]

/-! ## Guards — what ties these lists to the code that emits the strings -/

-- Every generative mode is a day-state mode. `Mode` is a real inductive, so
-- this is exhaustive by construction: adding a constructor there and forgetting
-- it here fails at build time rather than in a browser.
#guard ALL_GENERATIVE.all (fun m => DAY_STATE_MODES.contains (sName m))

-- And every drawn-line mode. `MOVING_MODES` is the list the renderer asks
-- "does this leg draw a track", so a member missing from the wire vocabulary
-- would be a mode that draws and cannot be styled.
#guard Verified.Geo.EpisodeGeometry.MOVING_MODES.all DAY_STATE_MODES.contains

-- The two that nothing derives: absent from both closed sources, or the
-- docstring above is wrong.
#guard !(ALL_GENERATIVE.map sName).contains "sleeping"
#guard !Verified.Geo.EpisodeGeometry.MOVING_MODES.contains "sleeping"

-- The four kinds `EpisodeGeometry` itself emits as literals.
#guard ["snapped", "raw", "anchor", "tentative"].all EPISODE_KINDS.contains

-- No duplicates. A repeated member reads as a longer vocabulary and would
-- make a set comparison against the frontend pass on a list that is wrong.
#guard DAY_STATE_MODES.eraseDups.length == DAY_STATE_MODES.length
#guard EPISODE_KINDS.eraseDups.length == EPISODE_KINDS.length

end Verified.Geo.WireVocab
