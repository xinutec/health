import { createConnection } from "mariadb";
const c = await createConnection({
	host: process.env.DB_HOST,
	port: Number(process.env.DB_PORT),
	user: process.env.DB_USER,
	password: process.env.DB_PASSWORD,
	database: "health",
});
const r = await c.query(
	"SELECT mode, ROUND(speed_mean,2) speedMean, ROUND(speed_std,2) speedStd, ROUND(hr_mean,1) hrMean, ROUND(hr_std,1) hrStd, ROUND(cadence_mean,2) cadMean, ROUND(cadence_std,2) cadStd, sample_count FROM mode_biometrics WHERE user_id='pippijn' ORDER BY mode",
);
console.table(r);
await c.end();
