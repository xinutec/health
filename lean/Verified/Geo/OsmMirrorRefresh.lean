/-!
# When is a route mirror stale?

Both OSM route mirrors (bus routes, rail stops) cover the home region in tiles.
A nightly run fetches only the tiles that are DUE — not refreshed for a week —
and replaces each tile that answers, so a run that is refused somewhere loses
nothing: the tiles that failed keep what they had and are due again tomorrow.

What a run can still get wrong is to leave the cache mostly old while every
night reports success. So the question asked after the write is about the
AREA: what fraction of the planned tiles has answered recently?

⚠ **A COUNT-BASED FLOOR CANNOT ANSWER IT, and that is measured rather than
supposed**: a run fetching 796 of 995 bus routes while losing the handful the
rider actually used passed a count floor, and a run dropping 300 untouched
peripheral routes failed it. The number was uncorrelated with the harm. The
fraction of the area that is fresh is not.

A failed CronJob is named by `fleet_health.py`'s `_check_cronjob_runs` within
the hour, where a quiet success is named by nothing — so the rule fails the run.
-/

namespace Verified.Geo.OsmMirrorRefresh

/-- The fraction of the area that must be fresh.

Half: past it the cache is more old than fresh. With tiles due weekly and
stale after two weeks, it takes a week of Overpass refusing most tiles before
this fires, which keeps ordinary flakiness — a few tiles timing out on a few
nights — green, so the alarm does not cry wolf and get muted. -/
def FRESH_FLOOR_PERCENT : Nat := 50

/-- Is too much of the area stale?

`staleTiles` of `tilesTotal` planned tiles have not answered in `staleDays`
days. `none` means the cache is fresh enough; `some why` is the sentence the
job fails with.

⚠ **AN EMPTY CACHE IS EXEMPT.** With `existing = 0` there is nothing old to be
mistaken for current: a first run that answers on a ninth of the area has
populated a ninth, and the next run carries on.

⚠ Compared by MULTIPLICATION, not by dividing first: `fresh / total * 100` in
`Nat` truncates toward zero, so 8 of 18 (44%) would compute as 0 and 17 of 18
(94%) as 0 too. The percentage is computed only for the MESSAGE, where a
truncated figure is honest enough. -/
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
-- ⚠ THE BOUNDARY, both sides. 9/18 is exactly the floor and passes; 8/18 is
-- under it and fails. A test only at 2/18 would pass with the comparison written
-- either way round.
#guard (staleRefusal 994 9 18 14).isNone   -- 9/18 = 50%, exactly the floor
#guard (staleRefusal 994 10 18 14).isSome  -- 8/18 = 44%
-- ⚠ AN EMPTY CACHE BOOTSTRAPS.
#guard (staleRefusal 0 16 18 14).isNone
#guard (staleRefusal 0 18 18 14).isNone
-- ⚠ NO TILES AT ALL is not staleness. An empty plan means the bbox produced
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
