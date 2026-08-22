#!/usr/bin/env node
// The TypeScript half of the /locations parity check (#982).
//
// Usage: scripts/prod-db.sh node scripts/locations-check-ts.mjs <user> <date>
//
// Prints what `GET /api/locations?date=` puts on the wire, in the same
// `<name>\t<json>` line format as `backend locations-check`, so the two can be
// diffed. Neither output is evidence alone -- the DIFF is the check.
//
// ⚠ What this is really testing is FLOATS. A fix carries lat, lon, altitude,
// speed and accuracy as JSON numbers, and they cross V8 on one side and
// serde_json on the other. `Verified.RowShape` refuses DOUBLE columns for
// exactly this reason, so the claim that these render identically has to be
// measured rather than assumed.
//
// ⚠ It also tests ORDER. Both implementations concatenate points across
// devices and then sort by ts, and a stable sort preserves whatever order the
// device walk produced -- which is a HashMap iteration in Rust and a JSON
// object's insertion order in TypeScript. Equal timestamps from two devices
// would expose that.
import { initPool } from "../dist/db/pool.js";
import { fetchTrackPointsRange, openPhoneTrack } from "../dist/nextcloud/phonetrack.js";

const [, , user, date] = process.argv;
if (!user || !date) {
	console.error("usage: locations-check-ts.mjs <user> <date>");
	process.exit(1);
}

function nextDay(d) {
	const t = new Date(d);
	t.setDate(t.getDate() + 1);
	return t.toISOString().slice(0, 10);
}

initPool({
	host: process.env.DB_HOST,
	port: Number(process.env.DB_PORT),
	user: process.env.DB_USER,
	password: process.env.DB_PASSWORD,
	database: process.env.DB_NAME,
});

// ⚠ `openPhoneTrack` takes the OUTER config and reads `.nextcloud` itself, so
// this is the wrapper shape rather than the client's own `{ baseUrl }`.
// ⚠ The same default `src/config.ts` applies on the API path. NC_BASE_URL is
// EMPTY on the serving pod, so hardcoding `process.env.NC_BASE_URL` here would
// measure a configuration the endpoint never runs under.
const config = { nextcloud: { baseUrl: process.env.NC_BASE_URL || "https://dash.xinutec.org" } };

const ctx = await openPhoneTrack(config, user);
const points = await fetchTrackPointsRange(ctx, date, nextDay(date));
console.log(`locations\t${JSON.stringify(points)}`);
process.exit(0);
