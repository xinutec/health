/**
 * parseGroundTruth day-anchor: a ground-truth table lists wall-clock
 * windows with no date, so the parser must infer which calendar day each
 * row belongs to. The first row anchors to the *previous* evening only
 * when it is an overnight stay that wraps past midnight (e.g.
 * "23:16 – 09:08 sleeping"); a same-day after-noon activity
 * ("19:27 – 20:40 dinner") stays on `date`.
 *
 * Regression: a single-evening-row table (05-14 Miné Mané dinner) was
 * mis-anchored a full day early, so the golden truth report could never
 * locate the matching state and always cried "regressed".
 */

import { describe, expect, it } from "vitest";
import { parseGroundTruth } from "../src/eval/ground-truth.js";

const table = (rows: string): string =>
	`# test\n\n## Audit of 2026-05-14\n\n| Window | Blessed | Status | Notes |\n| - | - | - | - |\n${rows}\n`;
const isoDay = (ts: number): string => new Date(ts * 1000).toISOString().slice(0, 10);

describe("parseGroundTruth day-anchor", () => {
	it("anchors a same-day evening activity to `date`, not the previous day", () => {
		const md = table("| 19:27 – 20:40 | stationary @ Miné Mané | correct | dinner {user} |");
		const gt = parseGroundTruth(md, "2026-05-14", "Europe/London");
		expect(gt.rows).toHaveLength(1);
		// 19:27 BST on 2026-05-14 = 18:27Z on 2026-05-14 — NOT 2026-05-13.
		expect(isoDay(gt.rows[0].startTs)).toBe("2026-05-14");
	});

	it("anchors a leading overnight-sleep row to the previous evening", () => {
		const md = table("| 23:16 – 09:08 | sleeping @ Hotel | correct | overnight {user} |");
		const gt = parseGroundTruth(md, "2026-04-29", "Europe/Amsterdam");
		// 23:16 belongs to the night that started on 2026-04-28.
		expect(isoDay(gt.rows[0].startTs)).toBe("2026-04-28");
	});

	it("advances the cursor when a later row's start time decreases", () => {
		const md = table(
			"| 23:16 – 09:08 | sleeping @ Hotel | correct | overnight {user} |\n| 10:51 – 11:50 | stationary @ Hotel | correct | morning {user} |",
		);
		const gt = parseGroundTruth(md, "2026-04-29", "Europe/Amsterdam");
		expect(isoDay(gt.rows[0].startTs)).toBe("2026-04-28");
		expect(isoDay(gt.rows[1].startTs)).toBe("2026-04-29");
	});
});

describe("parseGroundTruth cell parsing", () => {
	it("parses a bus leg's stops + route number symmetrically to a train", () => {
		const md = table("| 10:25 – 10:29 | bus Farvale → Cleveland Clinic London · 38 | correct | {user} |");
		const gt = parseGroundTruth(md, "2026-06-12", "Europe/London");
		const b = gt.rows[0].truth;
		expect(b?.mode).toBe("bus");
		expect(b?.trainFromTo).toEqual({ from: "Farvale", to: "Cleveland Clinic London" });
		expect(b?.lineName).toBe("38");
	});

	it("accepts a provenance tag inside the status cell (not just notes)", () => {
		const md = table("| 10:01 – 10:18 | train Ashvale → Farvale · Jubilee Line | correct {user} | |");
		const gt = parseGroundTruth(md, "2026-06-12", "Europe/London");
		expect(gt.rows[0].status).toBe("correct");
		expect(gt.rows[0].provenance).toBe("user");
	});
});
