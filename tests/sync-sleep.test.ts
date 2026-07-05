/**
 * Sleep-stage ingestion replaces a log's stages wholesale.
 *
 * `syncSleep` used to upsert stage rows (ON DUPLICATE KEY UPDATE only),
 * which can add or update rows but never remove stale ones — so a
 * botched historical merge (overlapping synthesized + tz-mismatched
 * halves) could not self-heal on re-sync. It must now DELETE a log's
 * existing `sleep_stages` before inserting the fresh set.
 */

import type * as mariadb from "mariadb";
import { describe, expect, it } from "vitest";
import type { FitbitClient } from "../src/fitbit/client.js";
import { type FitbitSleepLog, syncSleep } from "../src/fitbit/sync/sleep.js";

interface RecordedCall {
	kind: "query" | "batch";
	sql: string;
	params: unknown;
}

function mockConn(): { conn: mariadb.Connection; calls: RecordedCall[] } {
	const calls: RecordedCall[] = [];
	const conn = {
		query: async (sql: string, params?: unknown) => {
			calls.push({ kind: "query", sql, params });
			// The canonical-log-id lookup needs a row back.
			if (/SELECT log_id FROM sleep/i.test(sql)) return [{ log_id: 999n }];
			return [];
		},
		batch: async (sql: string, rows: unknown) => {
			calls.push({ kind: "batch", sql, params: rows });
			return {};
		},
	};
	return { conn: conn as unknown as mariadb.Connection, calls };
}

function mockClient(sleep: FitbitSleepLog[]): FitbitClient {
	return { get: async () => ({ sleep }) } as unknown as FitbitClient;
}

const logWithStages: FitbitSleepLog = {
	logId: 123n as FitbitSleepLog["logId"],
	dateOfSleep: "2026-05-11",
	startTime: "2026-05-10T23:34:00.000",
	endTime: "2026-05-11T07:56:00.000",
	duration: 1,
	efficiency: 90,
	minutesAsleep: 400,
	minutesAwake: 30,
	isMainSleep: true,
	levels: {
		summary: {},
		data: [
			{ dateTime: "2026-05-10T23:34:00.000", level: "wake", seconds: 600 },
			{ dateTime: "2026-05-10T23:44:00.000", level: "light", seconds: 1200 },
		],
	},
};

describe("syncSleep", () => {
	it("deletes a log's existing sleep_stages before inserting the fresh set", async () => {
		const { conn, calls } = mockConn();
		await syncSleep(mockClient([logWithStages]), conn, "pippijn", "2026-05-11", "2026-05-11");

		const deleteIdx = calls.findIndex((c) => /DELETE FROM sleep_stages/i.test(c.sql));
		const insertIdx = calls.findIndex((c) => c.kind === "batch" && /INSERT INTO sleep_stages/i.test(c.sql));

		expect(deleteIdx).toBeGreaterThanOrEqual(0);
		expect(insertIdx).toBeGreaterThanOrEqual(0);
		// The stale rows must be cleared before the fresh ones land.
		expect(deleteIdx).toBeLessThan(insertIdx);
		// Scoped to the canonical log id resolved from the sleep row (999n),
		// not the raw id from the Fitbit response.
		expect(calls[deleteIdx].params).toContain(999n);
	});

	it("does not delete sleep_stages when the log carries no stage data", async () => {
		const { conn, calls } = mockConn();
		const summaryOnly: FitbitSleepLog = { ...logWithStages, levels: undefined };
		await syncSleep(mockClient([summaryOnly]), conn, "pippijn", "2026-05-11", "2026-05-11");

		expect(calls.some((c) => /DELETE FROM sleep_stages/i.test(c.sql))).toBe(false);
	});
});
