/-!
# When is a route mirror stale?

The OSM route mirrors (bus routes, rail stops) tile the home region. A nightly
run refetches tiles not refreshed for a week and replaces each that answers,
so a refused tile keeps its rows and is due again tomorrow.

The risk is a mostly old cache with every night reporting success, so the check
after the write is the fraction of the area answered recently. A count floor
measured the wrong thing: it passed a run that lost the routes actually ridden
and failed one that dropped untouched peripheral ones.

A failed CronJob is reported by `fleet_health.py`'s `_check_cronjob_runs`; a
quiet success by nothing, so the rule fails the run.
-/

namespace Verified.Geo.OsmMirrorRefresh

/-- The fraction of the area that must be fresh: half. With weekly refreshes and
two-week staleness it takes a week of mostly refused tiles to fire, so ordinary
flakiness stays green and the alarm is not muted. -/
def FRESH_FLOOR_PERCENT : Nat := 50

/-- Is too much of the area stale? `staleTiles` of `tilesTotal` have not answered
in `staleDays` days; `some why` is the job's failure sentence. An empty cache
(`existing = 0`) is exempt: a partial first run has nothing old to hide.
Compared by multiplication, since `Nat` division truncates 44% to 0. -/
def staleRefusal (existing staleTiles tilesTotal staleDays : Nat) : Option String :=
  if tilesTotal == 0 || existing == 0 then none
  else
    let fresh := tilesTotal - staleTiles
    if fresh * 100 < tilesTotal * FRESH_FLOOR_PERCENT then
      some s!"only {fresh}/{tilesTotal} tiles answered in the last {staleDays} days ({fresh * 100 / tilesTotal}% of the area), below the {FRESH_FLOOR_PERCENT}% floor — the cache is mostly stale"
    else none

/-! ## Guards -/

-- Most of the area gone unanswered for two weeks, against a populated cache.
#guard (staleRefusal 994 16 18 14).isSome
#guard (staleRefusal 994 18 18 14).isSome
-- Ordinary readings stay green.
#guard (staleRefusal 436 3 18 14).isNone   -- 15/18, 83%
#guard (staleRefusal 400 0 18 14).isNone   -- all fresh
-- the boundary, both sides. 9/18 is exactly the floor and passes; 8/18 is
-- under it and fails. A test only at 2/18 would pass with the comparison written
-- either way round.
#guard (staleRefusal 994 9 18 14).isNone   -- 9/18 = 50%, exactly the floor
#guard (staleRefusal 994 10 18 14).isSome  -- 8/18 = 44%
-- an empty cache bootstraps.
#guard (staleRefusal 0 16 18 14).isNone
#guard (staleRefusal 0 18 18 14).isNone
-- No tiles at all is not staleness. An empty plan means the bbox produced
-- nothing to fetch, which is a different fault and belongs to whoever built the
-- plan.
#guard (staleRefusal 994 0 0 14).isNone
-- Nat subtraction truncates rather than wrapping, so more stale tiles than
-- tiles is 0 fresh rather than an enormous number.
#guard (staleRefusal 994 25 18 14).isSome
-- The sentence names the window it judged.
#guard staleRefusal 994 16 18 14 ==
  some "only 2/18 tiles answered in the last 14 days (11% of the area), below the 50% floor — the cache is mostly stale"

end Verified.Geo.OsmMirrorRefresh
