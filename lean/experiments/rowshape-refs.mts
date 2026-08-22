#!/usr/bin/env -S npx tsx
/**
 * Derive `#guard` expectations for `Verified.RowShape` from V8.
 *
 * Twelve `/api` endpoints are `selectAll()` plus `c.json(rows)`, so their
 * response shape is decided entirely outside the route: by the MariaDB
 * driver's SQL-type mapping, then by `JSON.stringify`. This pins the second
 * half — the JS rendering — because that is the half V8 owns and the half a
 * Rust host has to reproduce byte for byte.
 *
 * ⚠ The FIRST half, which SQL type becomes which JS type, cannot be derived
 * from any TypeScript source: `src/db/tables.ts` declares `number | null` for
 * columns its own comment says arrive as strings. It was measured against
 * production instead — `scripts/prod-db.sh node scripts/probe-row-shapes.mjs`
 * — and the table in `Verified/RowShape.lean` records what that run observed.
 *
 * Run: npx tsx lean/experiments/rowshape-refs.mts
 */
import { execFileSync } from "node:child_process";
// Installs `BigInt.prototype.toJSON`. WITHOUT this import the bigint section
// below throws rather than printing — which is the point of the section.
import "../../src/bigint-json.js";

console.log("--- DATE: a plain date ships as a full midnight-UTC timestamp ---");
// This is what the driver hands back for a DATE column: a JS Date built from
// the calendar value. `JSON.stringify` then renders it via `toISOString`.
for (const [y, m, d] of [
	[2026, 8, 22],
	[2026, 1, 1],
] as const) {
	const dt = new Date(Date.UTC(y, m - 1, d));
	console.log(`DATE ${y}-${m}-${d}: ${JSON.stringify(dt)}`);
}

console.log("--- DATETIME/TIMESTAMP ---");
for (const [y, m, d, h, mi, s, ms] of [
	// `sleep.start_time` and its `_utc` sibling, an hour apart, as observed.
	[2026, 8, 21, 23, 15, 0, 0],
	[2026, 8, 21, 22, 15, 0, 0],
	[2026, 8, 22, 16, 30, 59, 0],
	// Milliseconds are always three digits, never elided or trimmed.
	[2026, 8, 22, 0, 0, 0, 7],
	[2026, 8, 22, 0, 0, 0, 70],
	[2026, 8, 22, 0, 0, 0, 700],
] as const) {
	const dt = new Date(Date.UTC(y, m - 1, d, h, mi, s, ms));
	console.log(`DATETIME ${y}-${m}-${d} ${h}:${mi}:${s}.${ms}: ${JSON.stringify(dt)}`);
}

console.log("--- BIGINT: a JSON string, via the toJSON patch ---");
// A real Fitbit sleep log id: 63 bits, so Number would round it. The patch is
// what keeps it exact, and it makes the field a STRING on the wire.
for (const v of [7159200472543411371n, 0n, 1n] as const) {
	console.log(`BIGINT ${v}: ${JSON.stringify(v)}`);
}
console.log(`BIGINT inside a row: ${JSON.stringify({ log_id: 7159200472543411371n })}`);

console.log("--- TINYINT(1): a NUMBER on the wire, not a boolean ---");
// The driver hands back 0/1 for `is_main_sleep`. sqlx calls that column type
// "BOOLEAN", so this line records what the two renderings would differ by.
console.log(`as driver returns it: ${JSON.stringify({ is_main_sleep: 1 })}`);
console.log(`if a host decoded bool: ${JSON.stringify({ is_main_sleep: true })}`);

// ⚠ The renderings above are UTC-correct only because the serving pod runs
// with TZ unset. The driver builds a DATE as LOCAL midnight, and
// `JSON.stringify` renders UTC — so the wire format of every date column in
// this app depends on an ambient environment variable. Rather than assert
// that, run it: a child process with TZ set shows the shift.
console.log("--- ⚠ the same DATE column under a different process TZ ---");
for (const tz of ["UTC", "Europe/London", "Asia/Tokyo"]) {
	const out = execFileSync(
		process.execPath,
		["-e", 'process.stdout.write(JSON.stringify(new Date(2026, 7, 22)))'],
		{ env: { ...process.env, TZ: tz }, encoding: "utf-8" },
	);
	console.log(`TZ=${tz.padEnd(13)} local midnight 2026-08-22 renders ${out}`);
}
