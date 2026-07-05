import { describe, expect, it } from "vitest";
import { type HrvIntradayResponse, parseHrvIntraday } from "../src/fitbit/sync/hrv.js";

/**
 * `parseHrvIntraday` flattens a Fitbit intraday-HRV response into
 * `hrv_intraday` insert rows. Pins: the `minute` ISO timestamp is stored
 * verbatim as a wall-clock DATETIME, all four metrics ride through, and an
 * empty / missing series yields no rows (a day without main sleep).
 */

const USER = "pippijn";

describe("parseHrvIntraday", () => {
	it("flattens the 5-minute series, keeping rmssd/coverage/hf/lf and a wall-clock ts", () => {
		const res: HrvIntradayResponse = {
			hrv: [
				{
					dateTime: "2026-06-12",
					minutes: [
						{ minute: "2026-06-12T02:05:00.000", value: { rmssd: 26.617, coverage: 0.935, hf: 245.626, lf: 510.605 } },
						{ minute: "2026-06-12T02:10:00.000", value: { rmssd: 31.2, coverage: 0.98, hf: 300.1, lf: 420.0 } },
					],
				},
			],
		};
		const rows = parseHrvIntraday(res, USER);
		expect(rows).toEqual([
			[USER, "2026-06-12 02:05:00", 26.617, 0.935, 245.626, 510.605],
			[USER, "2026-06-12 02:10:00", 31.2, 0.98, 300.1, 420.0],
		]);
	});

	it("returns no rows for an empty or missing series (a day with no main sleep)", () => {
		expect(parseHrvIntraday({ hrv: [] }, USER)).toEqual([]);
		expect(parseHrvIntraday({ hrv: [{ dateTime: "2026-06-12", minutes: [] }] }, USER)).toEqual([]);
		expect(parseHrvIntraday({} as HrvIntradayResponse, USER)).toEqual([]);
	});
});
