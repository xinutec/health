import { createConnection } from "mariadb";
const c = await createConnection({
	host: process.env.DB_HOST,
	port: Number(process.env.DB_PORT),
	user: process.env.DB_USER,
	password: process.env.DB_PASSWORD,
	database: "health",
});
const tables = await c.query(`SHOW TABLES`);
const names = tables.map((r) => Object.values(r)[0]);
console.log("All tables:", names.join(", "));
console.log("\nBio-relevant:", names.filter((n) => /heart|steps|fitbit|owntrack|cadence|phone|gps|sleep|track/i.test(n)).join(", "));

for (const t of ["heart_rate_intraday", "steps_intraday", "owntracks_history", "phonetrack_history"]) {
	if (!names.includes(t)) {
		console.log(`\n${t}: (missing)`);
		continue;
	}
	const cols = await c.query(`SHOW COLUMNS FROM ${t}`);
	console.log(`\n${t} columns:`, cols.map((c) => c.Field).join(", "));
	const [row] = await c.query(`SELECT * FROM ${t} ORDER BY ${cols[0].Field} DESC LIMIT 1`);
	console.log(`  newest row sample:`, JSON.stringify(row, null, 0).slice(0, 200));
}

await c.end();
