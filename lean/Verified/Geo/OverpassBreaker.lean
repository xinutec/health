/-!
# The Overpass circuit breaker

When the public Overpass mirrors rate-limit, every fetch hangs until its
timeout; the breaker fails fast instead (`overpass.rs`, the mirror crons).
Functions take `now` and return the new state, so the clock is a parameter and
the early returns carry guards.
-/

namespace Verified.Geo.OverpassBreaker

/-- Failures inside the window needed to trip. -/
def FAILURE_THRESHOLD : Nat := 3
/-- Failures older than this stop counting toward the threshold. -/
def WINDOW_MS : Nat := 30000
/-- How long the breaker stays open once tripped. -/
def COOLDOWN_MS : Nat := 60000

/-- Recent failure timestamps, plus the instant the breaker reopens for
business. -/
structure State where
  failures : Array Nat := #[]
  openUntilMs : Nat := 0
  deriving Repr, Inhabited, BEq

def initial : State := {}

/-- Are we in fail-fast mode? Strictly before `openUntilMs`: the cooldown is
half-open, so a fetch at the boundary goes through. -/
def isOpen (s : State) (now : Nat) : Bool := now < s.openUntilMs

/-- Record one failure (timeout, dropped connection, 5xx, 429). Ignored while
open, so a storm cannot extend the cooldown. Tripping clears the tally, so the
next trip needs a full `FAILURE_THRESHOLD`. -/
def recordFailure (s : State) (now : Nat) : State :=
  if isOpen s now then s
  else
    -- Prune by window first: a slow trickle of occasional errors must never
    -- accumulate to a trip, only a tight burst.
    let kept := s.failures.filter (fun t => now - t < WINDOW_MS)
    let kept := kept.push now
    if kept.size ≥ FAILURE_THRESHOLD then
      { failures := #[], openUntilMs := now + COOLDOWN_MS }
    else
      { s with failures := kept }

/-- Record one success: clears the tally while closed. It does not close an open
breaker; the cooldown is the recovery window. -/
def recordSuccess (s : State) (now : Nat) : State :=
  if isOpen s now then s else { s with failures := #[] }

/-! ## Guards -/

private def T0 : Nat := 1000000

-- A fresh breaker is closed and stays closed on a single failure.
#guard isOpen initial T0 == false
#guard isOpen (recordFailure initial T0) T0 == false
#guard isOpen (recordFailure (recordFailure initial T0) (T0 + 10)) (T0 + 10) == false

-- Three inside the window trips it.
private def TRIPPED : State :=
  recordFailure (recordFailure (recordFailure initial T0) (T0 + 10)) (T0 + 20)
#guard isOpen TRIPPED (T0 + 20) == true
#guard TRIPPED.openUntilMs == T0 + 20 + COOLDOWN_MS

-- The cooldown is half-open: closed again exactly at `openUntilMs`.
#guard isOpen TRIPPED (T0 + 20 + COOLDOWN_MS - 1) == true
#guard isOpen TRIPPED (T0 + 20 + COOLDOWN_MS) == false

-- A slow trickle never trips: three failures spread beyond the window prune
-- each other, so the tally never reaches three. This is the property the whole
-- `filter` exists for.
private def TRICKLE : State :=
  recordFailure (recordFailure (recordFailure initial T0) (T0 + WINDOW_MS + 1))
    (T0 + 2 * WINDOW_MS + 2)
#guard isOpen TRICKLE (T0 + 2 * WINDOW_MS + 2) == false

-- A success while closed clears the tally, so two failures either side of it
-- do not add up.
private def AFTER_SUCCESS : State :=
  recordFailure (recordSuccess (recordFailure (recordFailure initial T0) (T0 + 10)) (T0 + 20)) (T0 + 30)
#guard isOpen AFTER_SUCCESS (T0 + 30) == false
#guard AFTER_SUCCESS.failures.size == 1

-- A success while open changes nothing — the cooldown is the only recovery.
#guard recordSuccess TRIPPED (T0 + 100) == TRIPPED
#guard isOpen (recordSuccess TRIPPED (T0 + 100)) (T0 + 100) == true

-- Nor does a failure while open extend the cooldown, or a long outage would
-- hold it open forever without retrying.
#guard (recordFailure TRIPPED (T0 + 100)).openUntilMs == TRIPPED.openUntilMs

-- And after the cooldown the tally starts fresh: it takes three more.
private def REOPENED : Nat := T0 + 20 + COOLDOWN_MS
#guard isOpen (recordFailure TRIPPED REOPENED) REOPENED == false
#guard (recordFailure TRIPPED REOPENED).failures.size == 1

end Verified.Geo.OverpassBreaker
