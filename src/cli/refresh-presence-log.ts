/**
 * refresh-presence-log — populate the `presence_log` table from the
 * existing `decoded_days` per-minute HSMM output.
 *
 * Phase 1 of `docs/proposals/2026-06-presence-continuity.md`. Pure
 * function of (decoded_days, current code). DELETE+INSERT-rebuilt from
 * a bounded backfill window — same pattern as `refresh-focus-places`
 * and `refresh-rail-routes`, no incremental accumulator.
 *
 * Run by the data-analysis cron (and manually):
 *   node dist/cli/refresh-presence-log.js        # default 30-day window
 *   node dist/cli/refresh-presence-log.js 60     # explicit window
 *
 * No external I/O beyond the database — no Overpass, no Nominatim, no
 * Fitbit. Cheap and idempotent.
 */

import { z } from "zod";
import { db, destroyPool, initPool, withConnection } from "../db/pool.js";
import { migrate } from "../db/schema.js";
import type { HmmSegment } from "../hmm/persist.js";
import { computeRow } from "../hmm/presence-log.js";

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

const DEFAULT_LOOKBACK_DAYS = 30;

async function main(): Promise<void> {
	const raw = process.argv[2];
	const lookback = Number(raw ?? DEFAULT_LOOKBACK_DAYS);
	if (!Number.isFinite(lookback) || lookback <= 0) {
		console.error(`refresh-presence-log: invalid lookback ${raw ?? "(undefined)"}`);
		process.exit(2);
	}

	initPool(config.db);
	await withConnection(migrate);

	const cutoffDate = new Date(Date.now() - lookback * 24 * 3600 * 1000);
	const cutoffStr = cutoffDate.toISOString().slice(0, 10);
	console.log(`refresh-presence-log: lookback=${lookback}d (cutoff=${cutoffStr})`);

	const rows = await db()
		.selectFrom("decoded_days")
		.where("date", ">=", cutoffStr)
		.select(["user_id", "date", "segments_json"])
		.execute();
	console.log(`refresh-presence-log: ${rows.length} decoded day(s) in window`);

	const tzByUser = new Map<string, string>();

	let inserted = 0;
	let skipped = 0;
	for (const row of rows) {
		if (!tzByUser.has(row.user_id)) {
			const tz = await db()
				.selectFrom("sync_state")
				.where("user_id", "=", row.user_id)
				.where("key_name", "=", "home_tz")
				.select("value")
				.executeTakeFirst();
			tzByUser.set(row.user_id, tz?.value ?? "Europe/London");
		}

		let segments: HmmSegment[];
		try {
			segments = JSON.parse(row.segments_json) as HmmSegment[];
		} catch {
			console.warn(`refresh-presence-log: bad JSON for ${row.user_id} ${row.date}`);
			skipped++;
			continue;
		}

		const rollup = computeRow({
			user_id: row.user_id,
			date: row.date,
			tz: tzByUser.get(row.user_id) ?? "Europe/London",
			segments,
		});
		if (rollup === null) {
			skipped++;
			continue;
		}

		await db()
			.insertInto("presence_log")
			.values({
				user_id: rollup.user_id,
				date: rollup.date,
				tz: rollup.tz,
				dominant_place_id: rollup.dominant_place_id,
				dominant_fraction: rollup.dominant_fraction,
				end_of_day_place_id: rollup.end_of_day_place_id,
				end_of_day_ts: rollup.end_of_day_ts,
				end_of_day_posterior: rollup.end_of_day_posterior,
			})
			.onDuplicateKeyUpdate({
				tz: rollup.tz,
				dominant_place_id: rollup.dominant_place_id,
				dominant_fraction: rollup.dominant_fraction,
				end_of_day_place_id: rollup.end_of_day_place_id,
				end_of_day_ts: rollup.end_of_day_ts,
				end_of_day_posterior: rollup.end_of_day_posterior,
			})
			.execute();
		inserted++;
	}

	console.log(`refresh-presence-log: inserted ${inserted}, skipped ${skipped}`);
	await destroyPool();
}

main().catch((err: unknown) => {
	console.error(err);
	process.exit(1);
});
