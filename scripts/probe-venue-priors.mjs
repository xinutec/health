#!/usr/bin/env node
// Dump the mined venue_type_priors blob for a user. Read-only.
//   prod-db.sh node scripts/probe-venue-priors.mjs [user]
import { createConnection } from "mariadb";
const c = await createConnection({
	host: process.env.DB_HOST,
	port: Number(process.env.DB_PORT),
	user: process.env.DB_USER,
	password: process.env.DB_PASSWORD,
	database: "health",
});
const user = process.argv[2] ?? "pippijn";
const [row] = await c.query("SELECT priors_json, mined_stays FROM venue_type_priors WHERE user_id=?", [user]);
if (!row) {
	console.log("no priors row");
	process.exit(0);
}
const p = JSON.parse(row.priors_json);
console.log(`mined_stays=${row.mined_stays} totalVisits=${p.totalVisits}`);
for (const [st, s] of Object.entries(p.bySubtype))
	console.log(
		`  ${st.padEnd(18)} v=${s.visits}  dwell=[${s.dwell.join(",")}]  hours=${s.hours
			.map((v, h) => [v, h])
			.filter(([v]) => v > 0)
			.map(([v, h]) => `${h}h:${v}`)
			.join(" ")}`,
	);
console.log("byCategory:");
for (const [cat, s] of Object.entries(p.byCategory))
	console.log(`  ${cat.padEnd(18)} v=${s.visits}  dwell=[${s.dwell.join(",")}]`);
await c.end();
process.exit(0);
