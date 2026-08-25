/-!
# The Overpass circuit breaker

When the public Overpass mirrors start rate-limiting, every subsequent fetch
hangs until its own timeout. A velocity request can have 25+ `ensureCovered`
calls queued; at a concurrency of 2 and 20 s each, that is four to eight minutes
of waiting on calls that were never going to succeed. The breaker turns that
into a fail-fast (#982 Tier 2).

Port of `src/geo/osm-overpass-breaker.ts`.

## ⚠ THE CLOCK IS A PARAMETER, NOT A CALL

Every function here takes `now` and returns the new state. The TypeScript reads
`Date.now()` from module-level mutable state, which is what makes its behaviour
untestable without a fake timer — and the reason the two "already open" early
returns below have never had a test. Threading the clock is the whole reason
this can carry guards at all.
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

/-- Are we in fail-fast mode?

⚠ STRICTLY BEFORE. At exactly `openUntilMs` the breaker is CLOSED — `Date.now() <
openUntilMs` — so the cooldown is a half-open interval and a fetch at the
boundary is allowed through. -/
def isOpen (s : State) (now : Nat) : Bool := now < s.openUntilMs

/-- Record one failure: a timeout, dropped connection, 5xx or 429.

⚠ WHILE OPEN, FAILURES ARE NOT COUNTED — the early return means a storm during
the cooldown cannot extend it. The breaker reopens on schedule and the next
failure starts a fresh tally.

⚠ AND THE TALLY IS CLEARED WHEN IT TRIPS, not merely pruned, so the following
cooldown needs another full `FAILURE_THRESHOLD` to trip again. -/
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

/-- Record one success. Clears the tally — but only while CLOSED.

⚠ A SUCCESS DOES NOT CLOSE AN OPEN BREAKER. The cooldown is the recovery window,
and reopening the path on the first lucky response is what invites the storm
straight back. -/
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

-- ⚠ The cooldown is HALF-OPEN: closed again exactly at `openUntilMs`.
#guard isOpen TRIPPED (T0 + 20 + COOLDOWN_MS - 1) == true
#guard isOpen TRIPPED (T0 + 20 + COOLDOWN_MS) == false

-- ⚠ A SLOW TRICKLE NEVER TRIPS: three failures spread beyond the window prune
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

-- ⚠ A SUCCESS WHILE OPEN CHANGES NOTHING — the cooldown is the only recovery.
#guard recordSuccess TRIPPED (T0 + 100) == TRIPPED
#guard isOpen (recordSuccess TRIPPED (T0 + 100)) (T0 + 100) == true

-- ⚠ NOR DOES A FAILURE WHILE OPEN EXTEND THE COOLDOWN. Without the early return
-- a sustained outage would hold the breaker open forever and it would never
-- retry — the failure mode is invisible because it looks like "Overpass is
-- still down".
#guard (recordFailure TRIPPED (T0 + 100)).openUntilMs == TRIPPED.openUntilMs

-- And after the cooldown the tally starts fresh: it takes three more.
private def REOPENED : Nat := T0 + 20 + COOLDOWN_MS
#guard isOpen (recordFailure TRIPPED REOPENED) REOPENED == false
#guard (recordFailure TRIPPED REOPENED).failures.size == 1

end Verified.Geo.OverpassBreaker
