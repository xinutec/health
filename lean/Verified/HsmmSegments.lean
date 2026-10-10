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
      -- The run ends at the array's end (no state at `i`), or where the state changes.
      let ended := match states[i]?, states[runStart]? with
        | some a, some b => !(sameState a b)
        | _, _ => true
      if ended then
        -- `runStart < i ≤ size` and the two arrays are the same length.
        match states[runStart]?, timestamps[runStart]?, timestamps[i - 1]? with
        | some s, some t0, some t1 =>
          out := out.push
            { startTs := t0
              -- ⚠ The LAST MINUTE of this run plus 60, never the next run's start.
              endTs := t1 + 60
              mode := s.mode, placeId := s.placeId, lineName := s.lineName }
        | _, _, _ => pure ()
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

/-! ## A short wait beside a ride is part of the trip

The decode reports a platform wait as what it is, a stay: the phone stood still,
no steps, a fix a minute. The narratives fold one into the walk or the ride
beside it, and keep a longer one as a stay of its own. Measured 2026-10-10 on
every decoded stay touching a train against the narrated minutes it covers: 25
of 28 under ten minutes were narrated as movement, 7 of 8 of ten or more as a
stay. So a stay shorter than `RIDE_WAIT_MAX_S` with a train beside it joins the
walk on its side, or the train when there is no walk; the decode itself is
untouched. A short stop between two pieces of one mainline ride is the train
standing at a station, and the pieces are one ride (10-01's TGV, split at four
stops of five to seven minutes). Between two pieces of a NAMED line the stop is
left alone: joined, 05-15's Jubilee was re-lined by the station chain, whose
duration term does not know a train can stand; an unnamed ride has no line for
the chain to re-line. -/

def RIDE_WAIT_MAX_S : Int := 10 * 60

/-- Fold each short wait beside a train into its neighbour (see above). -/
def foldRideWaits (segs : Array Segment) : Array Segment := Id.run do
  let mut out : Array Segment := #[]
  let mut i := 0
  while h : i < segs.size do
    let s := segs[i]
    let prev := out.back?
    let next := segs[i + 1]?
    let isTrain := fun (x : Option Segment) => (x.map (·.mode == "train")).getD false
    let isWalk := fun (x : Option Segment) => (x.map (·.mode == "walking")).getD false
    let sameRide := match prev, next with
      | some p, some n => p.mode == "train" && n.mode == "train" && p.lineName == n.lineName
          && p.lineName == some "unknown_rail"
      | _, _ => false
    if s.mode == "stationary" && s.endTs - s.startTs < RIDE_WAIT_MAX_S && sameRide then
      match next with
      | some n =>
        out := out.modify (out.size - 1) ({ · with endTs := n.endTs })
        i := i + 2
      | none => i := i + 1
    else if s.mode == "stationary" && s.endTs - s.startTs < RIDE_WAIT_MAX_S
        && (isTrain prev != isTrain next) then
      if isWalk prev || (isTrain prev && !isWalk next) then
        out := out.modify (out.size - 1) ({ · with endTs := s.endTs })
        i := i + 1
      else
        match next with
        | some n =>
          out := out.push { n with startTs := s.startTs }
          i := i + 2
        | none =>
          out := out.push s
          i := i + 1
    else
      out := out.push s
      i := i + 1
  return out

private def sg (a b : Int) (m : String) (l : Option String := none) : Segment := ⟨a, b, m, none, l⟩
-- Walk, an 8-minute wait, the ride: the wait joins the walk.
#guard foldRideWaits #[sg 0 600 "walking", sg 600 1080 "stationary", sg 1080 2000 "train" (some "M")]
  == #[sg 0 1080 "walking", sg 1080 2000 "train" (some "M")]
-- A wait after the ride joins the walk after it.
#guard foldRideWaits #[sg 0 900 "train" (some "M"), sg 900 1200 "stationary", sg 1200 2000 "walking"]
  == #[sg 0 900 "train" (some "M"), sg 900 2000 "walking"]
-- A wait after the ride with no walk beside it joins the ride.
#guard foldRideWaits #[sg 0 900 "train" (some "M"), sg 900 1200 "stationary", sg 1200 9000 "stationary"]
  == #[sg 0 1200 "train" (some "M"), sg 1200 9000 "stationary"]
-- A stay before a ride with no walk joins the ride's start.
#guard foldRideWaits #[sg 0 300 "stationary", sg 300 900 "train" (some "M")]
  == #[sg 0 900 "train" (some "M")]
-- A stop inside a mainline ride joins its pieces.
#guard foldRideWaits #[sg 0 900 "train" (some "unknown_rail"), sg 900 1200 "stationary", sg 1200 2000 "train" (some "unknown_rail")]
  == #[sg 0 2000 "train" (some "unknown_rail")]
-- A wait between two pieces of a named line is left alone.
#guard foldRideWaits #[sg 0 180 "train" (some "J"), sg 180 480 "stationary", sg 480 600 "train" (some "J")]
  == #[sg 0 180 "train" (some "J"), sg 180 480 "stationary", sg 480 600 "train" (some "J")]
-- Ten minutes is a stay; a short stay with no train beside it is untouched.
#guard foldRideWaits #[sg 0 600 "walking", sg 600 1200 "stationary", sg 1200 2000 "train" (some "M")]
  == #[sg 0 600 "walking", sg 600 1200 "stationary", sg 1200 2000 "train" (some "M")]
#guard foldRideWaits #[sg 0 600 "walking", sg 600 900 "stationary", sg 900 2000 "walking"]
  == #[sg 0 600 "walking", sg 600 900 "stationary", sg 900 2000 "walking"]

end Verified.HsmmSegments
