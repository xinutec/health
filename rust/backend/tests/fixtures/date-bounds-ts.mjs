// Generates date-bounds-ts.json: the ORACLE for src/timezone.rs, produced by
// running the real `dateBoundsUtc` from dist/geo/timezone.js rather than by
// writing down what I think it does.
//
// Regenerate with:  nix develop . -c node rust/backend/tests/fixtures/date-bounds-ts.mjs
//
// The zone list is chosen for the edges: half-hour and quarter-hour offsets
// (Kolkata, St Johns, Lord Howe, Chatham) pin the hour-field truncation the
// TypeScript does, and Kiritimati (+14) / Midway (-11) pin the day-rollover
// branches. The dates cover both European DST switches, a leap day, and month
// and year boundaries.
import { dateBoundsUtc } from "../../../../dist/geo/timezone.js";
const zones = [undefined, "UTC", "Europe/London", "America/New_York", "Asia/Tokyo",
                "Pacific/Kiritimati", "Pacific/Midway", "Asia/Kolkata",
                "America/St_Johns", "Australia/Lord_Howe", "Pacific/Chatham"];
const dates = ["2026-01-15", "2026-03-29", "2026-10-25", "2026-02-28", "2026-12-31",
               "2026-01-01", "2024-02-29", "2026-06-30", "2026-11-01", "2026-03-31"];
const out = [];
for (const tz of zones) for (const d of dates) {
  const b = dateBoundsUtc(d, tz);
  out.push({ date: d, tz: tz ?? null, startUtc: b.startUtc, endUtc: b.endUtc });
}
console.log(JSON.stringify(out));
