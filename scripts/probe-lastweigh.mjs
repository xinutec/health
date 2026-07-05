// When did the weight last actually change? (vs Fitbit forward-fill.)
//   scripts/prod-db.sh node scripts/probe-lastweigh.mjs
import { createConnection } from "mariadb";
const c = await createConnection({
	host: process.env.DB_HOST,
	port: Number(process.env.DB_PORT),
	user: process.env.DB_USER,
	password: process.env.DB_PASSWORD,
	database: process.env.DB_NAME,
});
const [{ wkg: cur }] = await c.query("SELECT weight_kg AS wkg FROM body WHERE user_id='pippijn' ORDER BY date DESC LIMIT 1");
const diff = await c.query(
	"SELECT date, weight_kg FROM body WHERE user_id='pippijn' AND weight_kg <> ? ORDER BY date DESC LIMIT 1",
	[cur],
);
console.log("current latest weight:", Number(cur).toFixed(2), "kg");
console.log(
	diff.length === 0
		? "entire table is flat at this value"
		: `last day differing from current: ${String(diff[0].date).slice(0, 10)} = ${Number(diff[0].weight_kg).toFixed(2)} kg`,
);
const [s] = await c.query(
	"SELECT MIN(date) lo, MAX(date) hi, COUNT(DISTINCT weight_kg) n FROM body WHERE user_id='pippijn'",
);
console.log(`history: ${String(s.lo).slice(0, 10)} -> ${String(s.hi).slice(0, 10)}   distinct weights: ${Number(s.n)}`);
await c.end();
process.exit(0);
