import Verified.VelocityCache
/-!
# The live-map reads (port of `src/routes/api.ts`)

Three endpoints feed the Map tab, and between them they hold four constants and
two comparisons. None of it is hard; all of it is the kind of thing that is
wrong by one character and looks right.

## The tail is a TAIL

`/location/tail` answers "every fix after the one you already have", so the
classification pipeline's lag can be filled with raw points. The TypeScript is
`points.filter(p => p.ts > since).slice(-TAIL_MAX_POINTS)`, and both halves are
inverted easily:

* `>` is STRICT. `>=` resends the point the caller named, which the map then
  draws twice.
* `slice(-2000)` takes the LAST 2000. `slice(0, 2000)` takes the first — the
  OLDEST — which for a long tail means answering a request for recent movement
  with the stale head of the buffer and never reaching the present.

⚠ The cap is silent in both implementations: a caller asking with an old
`since` gets 2000 points and no indication that more were dropped. That is the
TypeScript's behaviour and is preserved, but it means a client cannot use this
endpoint to catch up from arbitrarily far back.

## Freshness is the same rule as the velocity cache

Both caches here are ten seconds, and both are fresh iff `age < ttl` — the
TypeScript writes one as `now - at < TTL` and the other as `now - at >= TTL`
inverted, which is the same boundary said twice. [`Verified.VelocityCache`]
already owns that comparison, so it is reused rather than restated.

Pure and total. UNPROVEN; every `#guard` is what `src/routes/api.ts` produced
under Node — see `lean/experiments/locationtail-refs.mts`.
-/
namespace Verified.LocationTail

/-- The most a tail response may carry. -/
def TAIL_MAX_POINTS : Int := 2000

/-- How long `/location/latest` may reuse a fix. -/
def LATEST_FIX_TTL_MS : Int := 10000

/-- How long `/location/tail` may reuse its point buffer. -/
def TAIL_TTL_MS : Int := 10000

/-- The timestamps a tail request answers with, given the buffer's timestamps
(ascending) and the caller's `since`.

⚠ The REFERENCE implementation, not the serving one. A tail buffer is thousands
of points and a host call per request would ship all of them across the FFI, so
the host filters inline and `tests/location_tail.rs` holds it against this over
a corpus. If the two disagree, this one is right. -/
def tailAfter (tss : List Int) (since : Int) : List Int :=
  let kept := tss.filter (fun t => t > since)
  -- `slice(-n)`: the LAST n, and the whole list when it is shorter than n.
  let drop := kept.length - TAIL_MAX_POINTS.toNat
  kept.drop drop

/-- Reuse the cached value? Ten seconds, and the same comparison the velocity
cache uses. -/
def cacheFresh (cachedAtMs : Int) (nowMs : Int) (ttlMs : Int) : Bool :=
  Verified.VelocityCache.isFresh cachedAtMs nowMs ttlMs

/-! ## Guards -/

-- ⚠ STRICT. The point the caller already has is NOT resent.
#guard tailAfter [1, 2, 3] 2 == [3]
#guard tailAfter [1, 2, 3] 0 == [1, 2, 3]
#guard tailAfter [1, 2, 3] 3 == []
#guard tailAfter [] 0 == []
-- `since=0` is what a client with nothing sends, and it must not mean "no filter
-- and no cap" — the cap still applies.
#guard (tailAfter (List.range 3000 |>.map (fun i => Int.ofNat i + 1)) 0).length == 2000
-- ⚠ The LAST 2000, so the newest. Taking the first would answer a live map with
-- the oldest points in the buffer.
#guard (tailAfter (List.range 3000 |>.map (fun i => Int.ofNat i + 1)) 0).head? == some 1001
#guard (tailAfter (List.range 3000 |>.map (fun i => Int.ofNat i + 1)) 0).getLast? == some 3000
-- Shorter than the cap: everything after `since`, untruncated.
#guard (tailAfter (List.range 10 |>.map (fun i => Int.ofNat i + 1)) 4).length == 6

-- Ten seconds, exclusive at the boundary.
#guard cacheFresh 1000 1000 LATEST_FIX_TTL_MS == true
#guard cacheFresh 1000 10999 LATEST_FIX_TTL_MS == true
#guard cacheFresh 1000 11000 LATEST_FIX_TTL_MS == false
#guard cacheFresh 1000 20000 TAIL_TTL_MS == false

end Verified.LocationTail
