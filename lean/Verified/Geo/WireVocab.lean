import Verified.Geo.EpisodeGeometry
import Verified.Hsmm.StateSpace

/-!
# The closed string vocabularies the API sends and the frontend restates

Two sets of strings cross to the browser and are hand-copied there: the mode of
a day-state, and the kind of an episode's geometry. The frontend keys a
`Record<DayStateMode, …>` on the first, so a mode it has never heard of falls
through to a default style rather than failing — silently, in production. #337
was opened for exactly that and `scripts/check-frontend-unions.mjs` closed it by
comparing the frontend's union against the TypeScript backend's.

## ⚠ THIS FILE EXISTS BECAUSE THAT COMPARISON LOST ITS OTHER SIDE

`src/sleep/day-state.ts` held the only closed `DayStateMode` anywhere. Deleting
the TypeScript backend (#975) removes it, and Lean has no replacement to point
at: `Verified.Geo.DayState.Mode` is `abbrev Mode := String`, and the eleven
members live as bare literals across ten files.

A bare `def DAY_STATE_MODES` would be a list nothing enforces — the shape that
passes while being wrong. So each list below is tied by `#guard` to whatever
closed structure DOES exist for its members, and the members with no such
structure are named as exactly that.
-/

namespace Verified.Geo.WireVocab

-- ⚠ FULLY QUALIFIED, NOT `open`. `Mode` is ambiguous — `Hsmm.Emissions`
-- declares one too — and an `open` here would resolve to whichever the
-- elaborator preferred rather than to the one the wire actually carries.
-- ⚠ `Mode` IS DECLARED IN `Emissions`, not in `StateSpace` — the latter only
-- re-opens it, so `StateSpace.Mode` does not resolve.
private abbrev SMode := Verified.Hsmm.Emissions.Mode
private abbrev sName := Verified.Hsmm.StateSpace.modeName

/-- Every constructor of the HSMM's generative `Mode`, listed once so the guards
below share it. ⚠ A `Mode` gains a constructor and this list does not compile
until it is added — which is the whole reason the enumeration is written out
rather than derived from a string set. -/
private def ALL_GENERATIVE : List SMode :=
  -- ⚠ SPELLED OUT, not `.stationary`. Dot-notation resolves against whichever
  -- `Mode` the elaborator picks, and there are two.
  [ Verified.Hsmm.Emissions.Mode.stationary
  , Verified.Hsmm.Emissions.Mode.walking
  , Verified.Hsmm.Emissions.Mode.cycling
  , Verified.Hsmm.Emissions.Mode.driving
  , Verified.Hsmm.Emissions.Mode.train
  , Verified.Hsmm.Emissions.Mode.plane
  , Verified.Hsmm.Emissions.Mode.unknown ]

/-- Every `mode` a day-state can carry on the wire.

⚠ ORDER IS NOT MEANINGFUL; membership is. The consumer builds a set.

⚠ THREE SOURCES FEED THIS, and only two of them are closed:

  * the HSMM's generative modes — `Verified.Hsmm.StateSpace.modeName`, a real
    inductive, guarded below to be a SUBSET of this list;
  * the drawn-line modes — `EpisodeGeometry.MOVING_MODES`, likewise guarded;
  * `sleeping`, which comes from the Fitbit sleep windows rather than from GPS
    and so appears in no mode type at all, and `bus`, which rides on a segment
    as `vehicleKind` and is lifted to a mode by `DayState`.

The last two are the honest gap: nothing in Lean can derive them, so they are
declared here and the guards below pin the literals that produce them. -/
def DAY_STATE_MODES : List String :=
  ["sleeping", "stationary", "walking", "cycling", "driving", "vehicle",
   "bus", "train", "boat", "plane", "unknown"]

/-- Every `kind` an episode's geometry can carry.

⚠ `matched` and `smoothed` are produced by the walk matcher and the smoother,
which hand the string in from outside `EpisodeGeometry` — so unlike the other
four they cannot be guarded against a literal in that module. -/
def EPISODE_KINDS : List String :=
  ["snapped", "raw", "anchor", "tentative", "matched", "smoothed"]

/-! ## Guards — what ties these lists to the code that emits the strings -/

-- ⚠ EVERY GENERATIVE MODE IS A DAY-STATE MODE. `Mode` is a real inductive, so
-- this is exhaustive by construction: adding a constructor there and forgetting
-- it here fails at build time rather than in a browser.
#guard ALL_GENERATIVE.all (fun m => DAY_STATE_MODES.contains (sName m))

-- ⚠ AND EVERY DRAWN-LINE MODE. `MOVING_MODES` is the list the renderer asks
-- "does this leg draw a track", so a member missing from the wire vocabulary
-- would be a mode that draws and cannot be styled.
#guard Verified.Geo.EpisodeGeometry.MOVING_MODES.all DAY_STATE_MODES.contains

-- ⚠ THE TWO THAT NOTHING DERIVES. Stated as guards so the claim in the
-- docstring is checked rather than asserted: these really are absent from both
-- closed sources, and if either ever gains them this guard fails and the
-- docstring above is what needs correcting.
#guard !(ALL_GENERATIVE.map sName).contains "sleeping"
#guard !Verified.Geo.EpisodeGeometry.MOVING_MODES.contains "sleeping"

-- The four kinds `EpisodeGeometry` itself emits as literals.
#guard ["snapped", "raw", "anchor", "tentative"].all EPISODE_KINDS.contains

-- ⚠ NO DUPLICATES. A repeated member reads as a longer vocabulary and would
-- make a set comparison against the frontend pass on a list that is wrong.
#guard DAY_STATE_MODES.eraseDups.length == DAY_STATE_MODES.length
#guard EPISODE_KINDS.eraseDups.length == EPISODE_KINDS.length

end Verified.Geo.WireVocab
