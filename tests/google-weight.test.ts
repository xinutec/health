import { describe, expect, it } from "vitest";
import { dedupeByDate } from "../src/google/body.js";

describe("dedupeByDate", () => {
	it("keeps the latest measurement per local date, sorted ascending", () => {
		const out = dedupeByDate([
			{ date: "2026-06-19", kg: 68.0, ts: "2026-06-19T06:00:00Z" }, // earlier same day
			{ date: "2026-06-19", kg: 68.3, ts: "2026-06-19T08:09:47Z" }, // latest same day → wins
			{ date: "2026-06-08", kg: 66.1, ts: "2026-06-08T10:09:07Z" },
		]);
		expect(out.map((m) => m.date)).toEqual(["2026-06-08", "2026-06-19"]);
		expect(out[1].kg).toBe(68.3);
	});

	it("returns empty for empty input", () => {
		expect(dedupeByDate([])).toEqual([]);
	});
});
