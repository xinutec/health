import Verified.VelocityCache
/-!
# The live-map reads

The Map tab's endpoints hold a few constants and two comparisons, each wrong
by one character while looking right.

`/location/tail` answers the fixes after the caller's last, filling the
pipeline's lag with raw points: `ts > since`, the last `TAIL_MAX_POINTS`.
Strict, or the caller's point is drawn twice; the last, not the first, or a
long buffer never reaches the present. The cap is silent, so the endpoint
cannot catch up from far back.

Both caches are ten seconds, fresh iff `age < ttl`, the rule
[`Verified.VelocityCache`] owns.

Pure and total. UNPROVEN; the `#guard`s pin its answers.
-/
namespace Verified.LocationTail

/-- The most a tail response may carry. -/
def TAIL_MAX_POINTS : Int := 2000

/-- How long `/location/latest` may reuse a fix. -/
def LATEST_FIX_TTL_MS : Int := 10000

/-- How long `/location/tail` may reuse its point buffer. -/
def TAIL_TTL_MS : Int := 10000

/-- The timestamps a tail request answers with, from ascending buffer
timestamps and `since`. The reference: the host filters inline (shipping
thousands of points per request costs too much) and `tests/location_tail.rs`
holds it to this. -/
def tailAfter (tss : List Int) (since : Int) : List Int :=
  let kept := tss.filter (fun t => t > since)
  -- `slice(-n)`: the last n, and the whole list when it is shorter than n.
  let drop := kept.length - TAIL_MAX_POINTS.toNat
  kept.drop drop

/-- Reuse the cached value? Ten seconds, and the same comparison the velocity
cache uses. -/
def cacheFresh (cachedAtMs : Int) (nowMs : Int) (ttlMs : Int) : Bool :=
  Verified.VelocityCache.isFresh cachedAtMs nowMs ttlMs

/-! ## Guards -/

-- Strict. The point the caller already has is not resent.
#guard tailAfter [1, 2, 3] 2 == [3]
#guard tailAfter [1, 2, 3] 0 == [1, 2, 3]
#guard tailAfter [1, 2, 3] 3 == []
#guard tailAfter [] 0 == []
-- `since=0` is what a client with nothing sends, and it must not mean "no filter
-- and no cap" — the cap still applies.
#guard (tailAfter (List.range 3000 |>.map (fun i => Int.ofNat i + 1)) 0).length == 2000
-- The last 2000, so the newest. Taking the first would answer a live map with
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
