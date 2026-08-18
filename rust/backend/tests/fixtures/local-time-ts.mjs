// Generates local-time-ts.json: the ORACLE for timezone::local_hour_of and
// local_stay_samples, produced by running the real functions from dist/.
//
// Regenerate: nix develop . -c node rust/backend/tests/fixtures/local-time-ts.mjs
//
// The cases are chosen for the edges these two get wrong quietly: the
// Monday-based weekday index, both European DST transitions (a stay that
// crosses one samples a repeated or skipped local hour), a zero-length window,
// a stay that starts mid-minute, and a southern-hemisphere zone whose DST runs
// the other way.
import { writeFileSync } from "node:fs";
import { localStaySamples } from "../../../../dist/geo/opening-hours.js";
import { localHourOf } from "../../../../dist/geo/venue-prior.js";

const zones = ["UTC", "Europe/London", "Europe/Amsterdam", "America/New_York",
               "Australia/Sydney", "Asia/Kolkata"];
// 2026-03-29 01:00Z London springs forward; 2026-10-25 01:00Z falls back.
const instants = [1767225600, 1774746000, 1774749600, 1792142400, 1792146000,
                  1768435200, 1768435230, 1782000000];

const hours = [];
for (const tz of zones) for (const ts of instants) hours.push({ ts, tz, hour: localHourOf(ts, tz) });

const stays = [];
for (const tz of ["Europe/London", "Australia/Sydney"]) {
  for (const [s, e] of [[1774746000, 1774746000], [1774746000, 1774749600],
                        [1792142400, 1792146000], [1768435230, 1768435530]]) {
    stays.push({ startTs: s, endTs: e, tz, samples: localStaySamples(s, e, tz) });
  }
}
writeFileSync(new URL("./local-time-ts.json", import.meta.url), JSON.stringify({ hours, stays }, null, 1));
console.error(`${hours.length} hours, ${stays.length} stays`);
