/-!
# How long a computed day may be reused (port of `src/routes/velocity-cache.ts`)

`/velocity` is expensive — a data-rich day is 5–10 s of fetch, Kalman,
segmentation, OSM enrichment and biometric joins — and deterministic for a given
`(user, date, tz, walkMatch)`. So the result is cached per pod, and the only
question that is a DECISION rather than a data structure is **how long**.

The map, its eviction order and the in-flight dedup stay in the host: which
request shares a computation with which is concurrency, not policy. What is here
is the freshness rule and the two windows it chooses between.

## ⚠ The two TTLs are not one number with an exception

A FINISHED day's classification is settled: replaying it tomorrow gives the same
answer, so five minutes of staleness costs nothing. A day IN PROGRESS is a
different object — every new fix can change it, and the pipeline's verdict on an
unfinished journey is provisional by construction. A ride a minute old cannot yet
be identified as the train it will turn out to be, and the full window leaves the
superseded verdict on screen long after the pipeline corrected itself (reported
2026-07-12).

The short window is affordable precisely BECAUSE the day is partial: mid-morning
there is simply less of it, so recomputing costs a few hundred milliseconds
rather than the seconds a full day takes.

## ⚠ Liveness is decided against the VIEWER's local date

`today` is passed in, already resolved in the viewer's zone, because Lean has no
zone database. The boundary that matters is the viewer's local midnight and not
UTC's: at 23:30 in London the UTC date has already rolled over, and treating the
day as finished would freeze the evening's timeline an hour early. A host that
passes a UTC date here is not passing a wrong argument — it is asking a different
question, and getting a plausible answer to it.

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

/-- Is the requested date the day currently in progress, as the VIEWER
experiences it? `today` must already be the viewer's local civil date. -/
def isLiveDay (date today : String) : Bool := date == today

/-- The window a result computed for `date` may be reused within.

Takes both dates rather than a `Bool` so the liveness rule and the window it
selects cannot drift apart in two files. -/
def ttlMsFor (date today : String) : Int :=
  if isLiveDay date today then LIVE_TTL_MS else TTL_MS

/-- May a cached entry still be served?

⚠ STRICT. An entry exactly at its TTL is stale, which is the direction that
cannot serve something older than the window promises.

⚠ A cache written in the FUTURE is stale, not fresh. `cachedAtMs > nowMs` means
the clock moved backwards, and the arithmetic alone would read a far-future entry
as eternally fresh — the one failure here that never expires by itself. -/
def isFresh (cachedAtMs nowMs ttlMs : Int) : Bool :=
  cachedAtMs ≤ nowMs && nowMs - cachedAtMs < ttlMs

/-! ## Guards -/

#guard isLiveDay "2026-08-22" "2026-08-22" == true
#guard isLiveDay "2026-08-21" "2026-08-22" == false
-- ⚠ A day in the FUTURE is not live. It is not the day in progress, and its
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
-- ⚠ Written in the future: stale, not eternally fresh.
#guard isFresh 5000 4999 TTL_MS == false

end Verified.VelocityCache
