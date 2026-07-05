/**
 * `syncDevices` stores the numeric battery percentage on the current-device
 * snapshot AND appends a timestamped reading to the watch-battery history —
 * the data behind the day-view watch series. A device with no numeric
 * `batteryLevel` still upserts the snapshot but logs no history point.
 */
import type * as mariadb from "mariadb";
import { describe, expect, it } from "vitest";
import type { FitbitClient } from "../src/fitbit/client.js";
import { syncDevices } from "../src/fitbit/sync/devices.js";
import type { FitbitDevice } from "../src/types.js";

interface RecordedCall {
	sql: string;
	params: unknown[];
}

function mockConn(): { conn: mariadb.Connection; calls: RecordedCall[] } {
	const calls: RecordedCall[] = [];
	const conn = {
		query: async (sql: string, params?: unknown[]) => {
			calls.push({ sql, params: params ?? [] });
			return [];
		},
	};
	return { conn: conn as unknown as mariadb.Connection, calls };
}

function mockClient(devices: FitbitDevice[]): FitbitClient {
	return { get: async () => devices } as unknown as FitbitClient;
}

const inspire: FitbitDevice = {
	id: "3065341880",
	deviceVersion: "Inspire 3",
	type: "TRACKER",
	battery: "Medium",
	batteryLevel: 57,
	lastSyncTime: "2026-06-30T10:01:50.000",
};

describe("syncDevices", () => {
	it("stores battery_level on the snapshot and logs a history reading", async () => {
		const { conn, calls } = mockConn();
		await syncDevices(mockClient([inspire]), conn, "pippijn");

		const snapshot = calls.find((c) => /INSERT INTO devices/i.test(c.sql));
		expect(snapshot?.sql).toMatch(/battery_level/);
		expect(snapshot?.params).toEqual([
			"pippijn",
			"3065341880",
			"Inspire 3",
			"TRACKER",
			"Medium",
			57,
			"2026-06-30T10:01:50.000",
		]);

		const log = calls.find((c) => /INSERT INTO device_battery_log/i.test(c.sql));
		expect(log).toBeDefined();
		expect(log?.params).toEqual(["pippijn", "3065341880", "2026-06-30T10:01:50.000", 57, "Inspire 3"]);
	});

	it("upserts the snapshot but logs no history when batteryLevel is absent", async () => {
		const { conn, calls } = mockConn();
		const noLevel: FitbitDevice = { ...inspire, batteryLevel: undefined };
		await syncDevices(mockClient([noLevel]), conn, "pippijn");

		const snapshot = calls.find((c) => /INSERT INTO devices/i.test(c.sql));
		expect((snapshot?.params as unknown[])[5]).toBeNull(); // battery_level param
		expect(calls.some((c) => /INSERT INTO device_battery_log/i.test(c.sql))).toBe(false);
	});
});
