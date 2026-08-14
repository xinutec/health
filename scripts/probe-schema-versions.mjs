// Read-only by default: what does schema_migrations hold, and does it line up
// with MIGRATIONS.length?
//
// `--forget <v> [<v>...]` deletes those version rows so the statements now at
// those indices run again. That is ONLY correct when the recorded versions are
// bogus — e.g. a migration was inserted mid-array instead of appended, which
// shifts every later index and records the wrong statements under the new
// numbers. MIGRATIONS is keyed by ARRAY INDEX (schema.ts `migrate`), so its
// header rule — "add a new entry at the end — never modify existing ones" — is
// load-bearing, not style.
import { createConnection } from "mariadb";

const forget = process.argv.includes("--forget")
	? process.argv.slice(process.argv.indexOf("--forget") + 1).map(Number)
	: [];

const c = await createConnection({
	host: process.env.DB_HOST,
	port: Number(process.env.DB_PORT),
	user: process.env.DB_USER,
	password: process.env.DB_PASSWORD,
	database: "health",
});

const rows = await c.query("SELECT version, applied_at FROM schema_migrations ORDER BY version");
console.log(`applied versions: ${rows.length} (max ${rows[rows.length - 1]?.version})`);
console.log(`last 4: ${rows.slice(-4).map((r) => `${r.version}@${r.applied_at.toISOString().slice(0, 19)}`).join("  ")}`);

if (forget.length > 0) {
	const res = await c.query(
		`DELETE FROM schema_migrations WHERE version IN (${forget.map(() => "?").join(",")})`,
		forget,
	);
	console.log(`forgot version(s) ${forget.join(", ")} — ${res.affectedRows} row(s) deleted; they will re-run`);
}

await c.end();
process.exit(0);
