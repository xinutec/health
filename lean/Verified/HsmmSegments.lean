import Verified.JsNum
/-!
# Per-minute HSMM states → stored segments

Port of `groupStatesIntoSegments` in `src/hmm/persist.ts`. The decoder emits one
state per minute; `decoded_days` stores the run-length compaction of that, and
everything downstream — the day fold, the presence rollup — reads the compacted
form.

Pure and total. UNPROVEN; the run boundary and the `+ 60` are the TypeScript's.

⚠ **`endTs` is EXCLUSIVE and is built by adding 60 to the run's LAST minute**,
not by reading the next run's start. Those differ wherever the timestamp series
has a gap: taking the next start would silently stretch a segment across missing
minutes and claim the person was somewhere the decoder said nothing about.

⚠ **A run breaks on ANY of the three fields** — mode, place, line. Two adjacent
`train` minutes on different lines are two segments, and merging them would
invent a single ride the decoder never asserted.
-/

namespace Verified.HsmmSegments

/-- One decoded minute. -/
structure State where
  mode : String
  /-- `focus_places.id` for a stationary minute at a known place. -/
  placeId : Option Int
  /-- The named rail line, on a train minute the resolver could name. -/
  lineName : Option String
  deriving Inhabited, BEq, Repr

/-- One stored segment. `startTs` inclusive, `endTs` EXCLUSIVE. -/
structure Segment where
  startTs : Int
  endTs : Int
  mode : String
  placeId : Option Int
  lineName : Option String
  deriving Inhabited, BEq, Repr

/-- Do two minutes belong to the same run? All three fields, and the TypeScript
compares them with `===` — so `null` and `undefined` would differ there but
cannot here, which is a case Lean removes rather than reproduces. -/
def sameState (a b : State) : Bool :=
  a.mode == b.mode && a.placeId == b.placeId && a.lineName == b.lineName

/-- Run-length compact the day.

⚠ MISMATCHED LENGTHS ARE A CALLER BUG. The TypeScript throws; this returns
`none`, so the host reports it rather than silently compacting the shorter of
the two and writing a day that is missing its tail. -/
def groupStates (states : Array State) (timestamps : Array Int) : Option (Array Segment) :=
  if states.size != timestamps.size then none
  else if states.isEmpty then some #[]
  else Id.run do
    let mut out : Array Segment := #[]
    let mut runStart := 0
    for i in [1 : states.size + 1] do
      -- The run ends at the array's end, or where the state changes.
      let ended := i == states.size || !(sameState states[i]! states[runStart]!)
      if ended then
        let s := states[runStart]!
        out := out.push
          { startTs := timestamps[runStart]!
            -- ⚠ The LAST MINUTE of this run plus 60, never the next run's start.
            endTs := timestamps[i - 1]! + 60
            mode := s.mode, placeId := s.placeId, lineName := s.lineName }
        runStart := i
    return some out

/-! ## Guards -/

private def st (m : String) (p : Option Int := none) (l : Option String := none) : State :=
  { mode := m, placeId := p, lineName := l }

#guard groupStates #[] #[] == some #[]
-- ⚠ A length mismatch is refused, not compacted.
#guard groupStates #[st "walking"] #[] == none
#guard groupStates #[] #[0] == none

-- One minute becomes one segment ending 60s after it starts.
#guard (groupStates #[st "walking"] #[0]).map (·.map (·.endTs)) == some #[60]

-- Three like minutes collapse to one segment; endTs is the LAST minute + 60.
#guard (groupStates #[st "walking", st "walking", st "walking"] #[0, 60, 120]).map (·.size)
       == some 1
#guard (groupStates #[st "walking", st "walking", st "walking"] #[0, 60, 120]).map
       (·.map (·.endTs)) == some #[180]

-- ⚠ A GAP IN THE SERIES DOES NOT STRETCH THE SEGMENT. The first run ends at its
-- own last minute + 60 (120), not at the next run's start (600).
#guard (groupStates #[st "walking", st "walking", st "driving"] #[0, 60, 600]).map
       (·.map (fun s => (s.startTs, s.endTs))) == some #[(0, 120), (600, 660)]

-- Each field alone breaks a run.
#guard (groupStates #[st "stationary" (some 1), st "stationary" (some 2)] #[0, 60]).map (·.size)
       == some 2
#guard (groupStates #[st "train" none (some "Circle"), st "train" none (some "District")]
         #[0, 60]).map (·.size) == some 2
#guard (groupStates #[st "walking", st "driving"] #[0, 60]).map (·.size) == some 2

-- ...and identical fields do not.
#guard (groupStates #[st "stationary" (some 1), st "stationary" (some 1)] #[0, 60]).map (·.size)
       == some 1

-- A run that resumes after a different state is a THIRD segment, not a merge
-- back into the first.
#guard (groupStates #[st "walking", st "driving", st "walking"] #[0, 60, 120]).map (·.size)
       == some 3

end Verified.HsmmSegments
