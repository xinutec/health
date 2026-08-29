/-!
# When is a mirror refresh a refresh? (health #1134)

Both OSM mirror arms walk the same 18 tiles and both used to answer this with a
rule that could not see the thing that matters.

* **Bus** refused only when EVERY tile failed. The 2026-08-24 05:30 run refreshed
  **2 of 18 tiles and exited 0**, printing `994 -> 994 routes` — which is exactly
  what a healthy run prints when OSM did not change.
* **Rail** tripped whenever zero relations came back with any failure, so the same
  outage made it exit 1 while bus looked fine. The odd one out was the QUIET arm,
  not the healthy one.

⚠ **A COUNT-BASED FLOOR CANNOT FIX EITHER, and that is measured rather than
supposed** (2026-08-14, #255): a run fetching 796 of 995 routes while losing the
handful the rider actually uses PASSED a count floor, and a run dropping 300
untouched peripheral routes FAILED it. The number was uncorrelated with the harm.

COVERAGE — what fraction of the AREA answered — is the quantity that is not, and
it is the one neither rule read.

## Why this is about reporting and not about loss

Both arms carry a `tile_key` since 2026-08-25, so a partial run replaces only the
tiles that ANSWERED and nothing is dropped. A low-coverage run is therefore not
wrong, just mostly old. The defect is that it is INVISIBLE: `exit 0` and a
summary line that reads like success.

So this refuses, and refusing is cheap precisely because it cannot lose data — a
failed CronJob is named by `fleet_health.py`'s `_check_cronjob_runs` within the
hour, where a quiet success is named by nothing.
-/

namespace Verified.Geo.OsmMirrorRefresh

/-- The fraction of tiles that must answer for a run to count as a refresh.

⚠ **CHOSEN FROM MEASURED RUNS, not from taste.** Healthy production dry runs read
15/18 (83%) and 16/18 (89%); the run that prompted #1134 read 2/18 (11%). Half is
the point where a "refresh" has left the cache more stale than fresh, and it
leaves ordinary Overpass flakiness — one to three tiles timing out — green, so
the alarm does not cry wolf and get muted. -/
def COVERAGE_FLOOR_PERCENT : Nat := 50

/-- Did enough of the area answer to call this a refresh?

`none` means yes. `some why` is the sentence the job should die with.

⚠ **AN EMPTY CACHE IS EXEMPT, and that is not a special case for its own sake.**
The harm this rule names is a cache left MOSTLY STALE by a run that reported
success. With `existing = 0` there is nothing to be stale: a 2-of-18 first run
populates a ninth of the area and the next run replaces those tiles, where
refusing leaves it empty for ever. Caught by
`overpass_plan::the_two_arms_refuse_differently_and_that_is_deliberate`, which
pins `an all-failed first run still proceeds`.

⚠ Compared by MULTIPLICATION, not by dividing first: `answered / total * 100` in
`Nat` truncates toward zero, so 8 of 18 (44%) would compute as 0 and 17 of 18
(94%) as 0 too. The percentage is computed only for the MESSAGE, where a
truncated figure is honest enough. -/
def coverageRefusal (existing tileFailures tilesTotal : Nat) : Option String :=
  if tilesTotal == 0 || existing == 0 then none
  else
    let answered := tilesTotal - tileFailures
    if answered * 100 < tilesTotal * COVERAGE_FLOOR_PERCENT then
      some s!"only {answered}/{tilesTotal} tiles answered ({answered * 100 / tilesTotal}% of the area), below the {COVERAGE_FLOOR_PERCENT}% floor — the cache is mostly stale and this is not a refresh"
    else none

/-! ## Guards -/

-- The case this exists for: #1134's 2-of-18 run against a populated cache.
#guard (coverageRefusal 994 16 18).isSome
-- Every tile failed — refused here too, though the bus arm's own rule has a
-- better sentence for it and is asked first.
#guard (coverageRefusal 994 18 18).isSome
-- The healthy production readings stay green.
#guard (coverageRefusal 436 3 18).isNone   -- 15/18, 83%
#guard (coverageRefusal 996 2 18).isNone   -- 16/18, 89%
#guard (coverageRefusal 400 0 18).isNone   -- a full run
-- ⚠ THE BOUNDARY, both sides. 9/18 is exactly the floor and passes; 8/18 is
-- under it and fails. A test only at 2/18 would pass with the comparison written
-- either way round.
#guard (coverageRefusal 994 9 18).isNone   -- 9/18 = 50%, exactly the floor
#guard (coverageRefusal 994 10 18).isSome  -- 8/18 = 44%
-- ⚠ AN EMPTY CACHE BOOTSTRAPS. Refusing would leave it empty for ever.
#guard (coverageRefusal 0 16 18).isNone
#guard (coverageRefusal 0 18 18).isNone
-- ⚠ NO TILES AT ALL is not a coverage failure. An empty plan means the bbox
-- produced nothing to fetch, which is a different fault and belongs to whoever
-- built the plan.
#guard (coverageRefusal 994 0 0).isNone
-- Nat subtraction truncates rather than wrapping, so more failures than tiles is
-- 0 answered rather than an enormous one.
#guard (coverageRefusal 994 25 18).isSome

end Verified.Geo.OsmMirrorRefresh
