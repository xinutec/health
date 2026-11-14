/-!
# How long a computed day may be reused

`/velocity` takes 5–10 s on a full day and is deterministic for
`(user, date, tz, walkMatch)`, so it is cached per pod. The map and in-flight
dedup are the host's; the freshness rule is here.

A finished day is settled, so five minutes of staleness costs nothing. A day
in progress changes with every fix and its verdicts are provisional, so it
gets a short window, affordable because a partial day is cheap to recompute.

`today` arrives resolved in the viewer's zone: at 23:30 in London the UTC date
has rolled over, and a UTC date would freeze the evening an hour early.

Pure and total. UNPROVEN; pinned by the `#guard`s below.
-/

namespace Verified.VelocityCache

/-- How long a settled day may be reused: five minutes. Short enough that a fix
landing now shows up within a fix or two, long enough that a session of
tab-switching and chevron navigation benefits. -/
def TTL_MS : Int := 5 * 60 * 1000

/-- How long a day still in progress may be reused. See the note above for why
this is not `TTL_MS` with a smaller number. -/
def LIVE_TTL_MS : Int := 60 * 1000

/-- LRU bound. One user covers maybe a month of recently-visited days; this
leaves headroom without unbounded growth. Here rather than in the host because
it is a size chosen for a person's browsing, not for a machine's memory. -/
def MAX_ENTRIES : Int := 32

/-- Is the requested date the day currently in progress, as the viewer
experiences it? `today` must already be the viewer's local civil date. -/
def isLiveDay (date today : String) : Bool := date == today

/-- The window a result computed for `date` may be reused within. Takes both
dates, so the liveness rule and its window live together. -/
def ttlMsFor (date today : String) : Int :=
  if isLiveDay date today then LIVE_TTL_MS else TTL_MS

/-- May a cached entry still be served? Strict: exactly at its TTL is stale. A
future `cachedAtMs` (the clock moved back) is stale too, or it would stay fresh
forever. -/
def isFresh (cachedAtMs nowMs ttlMs : Int) : Bool :=
  cachedAtMs ≤ nowMs && nowMs - cachedAtMs < ttlMs

/-! ## Guards -/

#guard isLiveDay "2026-08-22" "2026-08-22" == true
#guard isLiveDay "2026-08-21" "2026-08-22" == false
-- A day in the future is not live. It is not the day in progress, and its
-- result is as settled as an empty day gets.
#guard isLiveDay "2026-08-23" "2026-08-22" == false

#guard ttlMsFor "2026-08-22" "2026-08-22" == LIVE_TTL_MS
#guard ttlMsFor "2026-08-21" "2026-08-22" == TTL_MS

-- Fresh at zero age, fresh one millisecond inside, stale exactly at the bound.
#guard isFresh 1000 1000 TTL_MS == true
#guard isFresh 1000 (1000 + TTL_MS - 1) TTL_MS == true
#guard isFresh 1000 (1000 + TTL_MS) TTL_MS == false
#guard isFresh 1000 (1000 + TTL_MS + 1) TTL_MS == false
-- The live window is the one that matters for a day still accumulating fixes.
#guard isFresh 1000 (1000 + LIVE_TTL_MS - 1) LIVE_TTL_MS == true
#guard isFresh 1000 (1000 + LIVE_TTL_MS) LIVE_TTL_MS == false
-- Written in the future: stale, not eternally fresh.
#guard isFresh 5000 4999 TTL_MS == false

end Verified.VelocityCache
