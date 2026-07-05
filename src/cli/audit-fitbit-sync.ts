/**
 * CLI tool: audit which Fitbit-derived data is actually in the
 * health-sync DB.
 *
 * Falsification proof for claims like "we sync HRV / breathing /
 * skin temperature / etc.": for every table that *could* hold
 * Fitbit data, this script asks the live MariaDB instance for the
 * row count plus the earliest and latest record. A table claimed
 * as synced that comes back with 0 rows is a falsified claim.
 *
 * Usage (from inside the health-auth pod):
 *   node dist/cli/audit-fitbit-sync.js
 *
 * Reuses the same Kysely query layer + DB pool the production
 * server uses — so what this script sees is what production sees.
 */

import { z } from "zod";
import { db, destroyPool, initPool } from "../db/pool.js";

const config = z
	.object({
		db: z.object({
			host: z.string().default("health-db"),
			port: z.coerce.number().default(3306),
			user: z.string(),
			password: z.string(),
			database: z.string().default("health"),
		}),
	})
	.parse({
		db: {
			host: process.env.DB_HOST,
			port: process.env.DB_PORT,
			user: process.env.DB_USER,
			password: process.env.DB_PASSWORD,
			database: process.env.DB_NAME,
		},
	});

initPool(config.db);

interface AuditResult {
	table: string;
	rows: number;
	earliest: string | null;
	latest: string | null;
}

/** Run a count + min + max for one Fitbit-derived table.
 *  Kept generic on the column expression rather than typed against
 *  the schema -- the date column varies per table (`ts` for
 *  intraday, `date` for daily, `start_time` for sleep, etc.) and
 *  splitting into 14 identical functions added noise without
 *  adding type safety. The schema-types CI check covers the
 *  table names themselves. */
async function auditTable(
	table: keyof import("../db/tables.js").Database,
	dateCol: string,
	dateColIsTimestamp: boolean,
): Promise<AuditResult> {
	const k = db();
	// Use raw SQL fragments for MIN/MAX so we can wrap in DATE()
	// when the underlying column is a DATETIME. Kysely's typed
	// MIN/MAX would force a per-table function.
	const rowsRow = await k
		.selectFrom(table)
		.select((eb) => eb.fn.countAll<number>().as("c"))
		.executeTakeFirstOrThrow();
	const rows = Number(rowsRow.c);

	if (rows === 0) return { table, rows: 0, earliest: null, latest: null };

	const { sql } = await import("kysely");
	const wrap = (op: "MIN" | "MAX") =>
		dateColIsTimestamp ? sql.raw(`DATE(${op}(${dateCol}))`) : sql.raw(`${op}(${dateCol})`);
	const minMax = await k
		.selectFrom(table)
		.select([wrap("MIN").as("min"), wrap("MAX").as("max")])
		.executeTakeFirstOrThrow();

	const toDate = (v: unknown): string | null => {
		if (v === null || v === undefined) return null;
		if (v instanceof Date) return v.toISOString().slice(0, 10);
		return String(v).slice(0, 10);
	};

	return { table, rows, earliest: toDate(minMax.min), latest: toDate(minMax.max) };
}

/** List of tables that *could* hold Fitbit-derived data. The third
 *  field is true for DATETIME columns (DATE-wrap needed), false
 *  for DATE columns. */
const TABLES: Array<[keyof import("../db/tables.js").Database, string, boolean]> = [
	["heart_rate_intraday", "ts", true],
	["heart_rate_zones", "date", false],
	["sleep", "start_time", true],
	["sleep_stages", "ts", true],
	["daily_activity", "date", false],
	["steps_intraday", "ts", true],
	["body", "date", false],
	["spo2_daily", "date", false],
	["spo2_intraday", "ts", true],
	["hrv_daily", "date", false],
	["hrv_intraday", "ts", true],
	["breathing_rate", "date", false],
	["skin_temperature", "date", false],
	["cardio_fitness", "date", false],
];

try {
	const results: AuditResult[] = [];
	for (const [name, col, isTs] of TABLES) {
		results.push(await auditTable(name, col, isTs));
	}

	// devices has no date column — count only.
	const devicesCount = await db()
		.selectFrom("devices")
		.select((eb) => eb.fn.countAll<number>().as("c"))
		.executeTakeFirstOrThrow();
	results.push({ table: "devices", rows: Number(devicesCount.c), earliest: null, latest: null });

	results.sort((a, b) => b.rows - a.rows);

	// Render. Fixed-width columns for ergonomic terminal output.
	const nameWidth = Math.max(...results.map((r) => r.table.length), 5);
	const rowsWidth = Math.max(...results.map((r) => String(r.rows).length), 4);
	const sep = `+${"-".repeat(nameWidth + 2)}+${"-".repeat(rowsWidth + 2)}+------------+------------+`;
	console.log(sep);
	console.log(`| ${"table".padEnd(nameWidth)} | ${"rows".padStart(rowsWidth)} | earliest   | latest     |`);
	console.log(sep);
	for (const r of results) {
		console.log(
			`| ${r.table.padEnd(nameWidth)} | ${String(r.rows).padStart(rowsWidth)} | ${(r.earliest ?? "—").padEnd(10)} | ${(r.latest ?? "—").padEnd(10)} |`,
		);
	}
	console.log(sep);

	const falsified = results.filter((r) => r.rows === 0);
	if (falsified.length > 0) {
		console.log();
		console.log("Falsified claims (table exists, 0 rows):");
		for (const f of falsified) console.log(`  - ${f.table}`);
	}
} finally {
	await destroyPool();
}
