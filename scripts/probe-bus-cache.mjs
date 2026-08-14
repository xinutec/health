// Read-only: how many routes does bus_route_cache hold right now, and when was
// it written? The baseline for #255's watched refresh — the decision was to
// check the count lands near 995 before un-suspending the CronJob.
import { createConnection } from "mariadb";

const c = await createConnection({
	host: process.env.DB_HOST,
	port: Number(process.env.DB_PORT),
	user: process.env.DB_USER,
	password: process.env.DB_PASSWORD,
	database: "health",
});

const [{ n }] = await c.query("SELECT COUNT(*) AS n FROM bus_route_cache");
console.log(`bus_route_cache rows: ${n}`);

const cols = (await c.query("SHOW COLUMNS FROM bus_route_cache")).map((r) => r.Field);
console.log(`columns: ${cols.join(", ")}`);

const tsCol = cols.find((f) => /updated|refreshed|created|fetched|computed/i.test(f));
if (tsCol) {
	const rows = await c.query(`SELECT MIN(${tsCol}) AS oldest, MAX(${tsCol}) AS newest FROM bus_route_cache`);
	console.log(`${tsCol}: oldest=${rows[0].oldest} newest=${rows[0].newest}`);
}

await c.end();
process.exit(0);
