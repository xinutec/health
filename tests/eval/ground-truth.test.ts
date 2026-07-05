import { describe, expect, it } from "vitest";
import { isEnforceableTruth, parseGroundTruth, parseProvenance } from "../../src/eval/ground-truth.js";

/**
 * Parser tests cover the format variants seen across the five real
 * ground-truth files (column counts 3 or 4; em-dash window separator;
 * bolded `**wrong**` status; trailing notes column with free text;
 * `train BoardingStation → AlightingStation · Line Name` blessed-cell
 * shape). Fixtures are synthetic — the real files are gitignored
 * because they carry private context.
 */

const MINIMAL_FOUR_COL = `# 2026-05-22 — ground truth

## Audit of 2026-05-22 blessed golden

| Window         | Blessed                                                     | Status     | Correct version                                             |
| -------------- | ----------------------------------------------------------- | ---------- | ----------------------------------------------------------- |
| 00:05 – 08:58  | sleeping @ Home                                             | correct    |                                                             |
| 09:08 – 13:02  | stationary @ Home                                           | correct    |                                                             |
| 13:02 – 13:16  | walking                                                     | correct    | walking to Ashvale tube                                |
| 13:16 – 13:26  | train Ashvale → Carfax                           | partial    | Should be labelled "Metropolitan Line"                      |
| 13:26 – 13:35  | train Carfax → Farvale · Jubilee Line              | correct    | Two-leg shape was right                                     |
| 19:55 – 20:04  | walking on Pentonville Road                                 | correct    |                                                             |
| 20:05 – 20:12  | driving on Deepwell Underpass                                 | **wrong**  | This is the Met Line tube to Brookden, not driving     |
| 20:46 – 23:59  | stationary @ Royal Free Hospital                            | correct    |                                                             |
`;

const MINIMAL_THREE_COL_WITH_TRAILING_NOTES = `# 2026-04-29 — ground truth

## Audit of 2026-04-29 blessed golden (post Layer 1 re-bless)

| Window         | Blessed (now)                                       | Status   |
| -------------- | --------------------------------------------------- | -------- |
| 22:16 – 08:08  | sleeping @ Parkhotel Den Haag (hotel)               | correct  | Was "@ Molenstraat 61A" pre-Layer 1.
| 09:51 – 10:50  | stationary @ Parkhotel Den Haag (hotel)             | correct  |
| 11:05 – 11:10  | stationary on HMC Westeinde Heliport                | partial  | A heliport label for a walking-past moment.
| 18:48 – 22:13  | walking                                             | wrong    | Sparse-day phantom motion.
`;

describe("parseGroundTruth", () => {
	it("returns empty rows for content with no audit table", () => {
		const out = parseGroundTruth("# Just a narrative, no table\n\nSome text.", "2026-05-22", "Europe/London");
		expect(out.date).toBe("2026-05-22");
		expect(out.tz).toBe("Europe/London");
		expect(out.rows).toEqual([]);
	});

	it("parses a 4-column table including correct-version cells", () => {
		const out = parseGroundTruth(MINIMAL_FOUR_COL, "2026-05-22", "Europe/London");
		expect(out.rows.length).toBe(8);
		const r0 = out.rows[0];
		expect(r0.windowText).toBe("00:05 – 08:58");
		expect(r0.status).toBe("correct");
		expect(r0.blessed?.mode).toBe("sleeping");
		expect(r0.blessed?.place).toBe("Home");
		expect(r0.correctVersionText).toBeNull(); // empty cell → null
	});

	it("normalises **wrong** to wrong", () => {
		const out = parseGroundTruth(MINIMAL_FOUR_COL, "2026-05-22", "Europe/London");
		const wrongRow = out.rows.find((r) => r.blessedText.includes("Deepwell Underpass"));
		expect(wrongRow?.status).toBe("wrong");
		expect(wrongRow?.correctVersionText).toContain("Met Line");
	});

	it("parses a 3-column table with trailing notes after status", () => {
		const out = parseGroundTruth(MINIMAL_THREE_COL_WITH_TRAILING_NOTES, "2026-04-29", "Europe/Amsterdam");
		expect(out.rows.length).toBe(4);
		const noteRow = out.rows.find((r) => r.windowText === "11:05 – 11:10");
		expect(noteRow?.status).toBe("partial");
		expect(noteRow?.correctVersionText).toContain("heliport");
	});

	it("parses cross-midnight windows as ending the next day", () => {
		const out = parseGroundTruth(MINIMAL_THREE_COL_WITH_TRAILING_NOTES, "2026-04-29", "Europe/Amsterdam");
		const sleepRow = out.rows.find((r) => r.windowText === "22:16 – 08:08");
		if (sleepRow === undefined) throw new Error("sleep row missing");
		// 9h52m = 35520s duration, regardless of anchor day.
		expect(sleepRow.endTs - sleepRow.startTs).toBe(9 * 3600 + 52 * 60);
	});

	it("anchors a first-row evening-sleep to YESTERDAY's date, not the file date", () => {
		// 22:16 – 08:08 on a file dated 2026-04-29 in Europe/Amsterdam.
		// The convention is: row 1 with start hour >= 12 represents
		// the previous evening's sleep into THIS morning. So startTs
		// should be 2026-04-28 22:16 local, not 2026-04-29 22:16.
		const out = parseGroundTruth(MINIMAL_THREE_COL_WITH_TRAILING_NOTES, "2026-04-29", "Europe/Amsterdam");
		const sleepRow = out.rows.find((r) => r.windowText === "22:16 – 08:08");
		if (sleepRow === undefined) throw new Error("sleep row missing");
		// 22:16 Amsterdam on 2026-04-28 = 20:16 UTC on 2026-04-28.
		// Unix epoch for that: Date.UTC(2026, 3, 28, 20, 16, 0) / 1000.
		const expected = Date.UTC(2026, 3, 28, 20, 16, 0) / 1000;
		expect(sleepRow.startTs).toBe(expected);
	});

	it("advances the day cursor when a later row's start time wraps backward", () => {
		// File-dated table with daytime rows followed by a tonight-sleep
		// row that starts after midnight — that row should anchor to
		// the NEXT day, not the file date.
		const md = `## Audit of 2026-05-22 blessed golden

| Window         | Blessed                    | Status     |
| -------------- | -------------------------- | ---------- |
| 09:00 – 11:00  | stationary @ Home          | correct    |
| 12:00 – 18:00  | stationary @ Work          | correct    |
| 00:30 – 08:00  | sleeping @ Home            | correct    |
`;
		const out = parseGroundTruth(md, "2026-05-22", "Europe/London");
		expect(out.rows.length).toBe(3);
		const lastRow = out.rows[2];
		// 00:30 BST on 2026-05-23 = 23:30 UTC on 2026-05-22.
		const expected = Date.UTC(2026, 4, 22, 23, 30, 0) / 1000;
		expect(lastRow.startTs).toBe(expected);
	});

	it("classifies blessed cells: sleeping / stationary @ Place / walking / driving / train", () => {
		const out = parseGroundTruth(MINIMAL_FOUR_COL, "2026-05-22", "Europe/London");
		const byWindow = new Map(out.rows.map((r) => [r.windowText, r.blessed]));

		expect(byWindow.get("00:05 – 08:58")?.mode).toBe("sleeping");
		expect(byWindow.get("00:05 – 08:58")?.place).toBe("Home");

		expect(byWindow.get("09:08 – 13:02")?.mode).toBe("stationary");
		expect(byWindow.get("09:08 – 13:02")?.place).toBe("Home");

		expect(byWindow.get("13:02 – 13:16")?.mode).toBe("walking");
		expect(byWindow.get("13:02 – 13:16")?.place).toBeNull();

		expect(byWindow.get("20:05 – 20:12")?.mode).toBe("driving");
		expect(byWindow.get("20:05 – 20:12")?.wayName).toBe("Deepwell Underpass");

		const trainNoLine = byWindow.get("13:16 – 13:26");
		expect(trainNoLine?.mode).toBe("train");
		expect(trainNoLine?.trainFromTo).toEqual({ from: "Ashvale", to: "Carfax" });
		expect(trainNoLine?.lineName).toBeNull();

		const trainWithLine = byWindow.get("13:26 – 13:35");
		expect(trainWithLine?.mode).toBe("train");
		expect(trainWithLine?.trainFromTo).toEqual({ from: "Carfax", to: "Farvale" });
		expect(trainWithLine?.lineName).toBe("Jubilee Line");
	});

	it("strips trailing parenthetical type qualifiers from place names", () => {
		const out = parseGroundTruth(MINIMAL_THREE_COL_WITH_TRAILING_NOTES, "2026-04-29", "Europe/Amsterdam");
		const hotelRow = out.rows.find((r) => r.windowText === "22:16 – 08:08");
		// "Parkhotel Den Haag (hotel)" → place "Parkhotel Den Haag", placeQualifier "hotel"
		expect(hotelRow?.blessed?.place).toBe("Parkhotel Den Haag");
		expect(hotelRow?.blessed?.placeQualifier).toBe("hotel");
	});

	it("returns groundTruthAt(minute) resolving any minute in the day", () => {
		const out = parseGroundTruth(MINIMAL_FOUR_COL, "2026-05-22", "Europe/London");
		// 00:30 local on 2026-05-22 → covered by 00:05 – 08:58 sleeping row.
		// Compute the UTC ts for 00:30 London on 2026-05-22.
		const ts = Date.UTC(2026, 4, 21, 23, 30, 0) / 1000; // 00:30 BST = 23:30 UTC prev day
		const row = out.rows.find((r) => r.startTs <= ts && ts < r.endTs);
		expect(row?.blessed?.mode).toBe("sleeping");
	});
});

describe("parseProvenance", () => {
	it("reads each tag", () => {
		expect(parseProvenance("correct {user}")).toBe("user");
		expect(parseProvenance("notes... {derived} ...")).toBe("derived");
		expect(parseProvenance("**wrong** {corroborated}")).toBe("corroborated");
		expect(parseProvenance("hair appointment {inferred}")).toBe("inferred");
	});
	it("is case-insensitive", () => {
		expect(parseProvenance("{USER}")).toBe("user");
	});
	it("defaults to unspecified when no tag", () => {
		expect(parseProvenance("correct")).toBe("unspecified");
		expect(parseProvenance("")).toBe("unspecified");
	});
});

describe("isEnforceableTruth — only a trustworthy definite verdict gates a check", () => {
	const row = (status: string, provenance: string) =>
		({ status, provenance }) as Parameters<typeof isEnforceableTruth>[0];

	it("enforces a correct/wrong verdict backed by user/derived/corroborated", () => {
		expect(isEnforceableTruth(row("correct", "user"))).toBe(true);
		expect(isEnforceableTruth(row("wrong", "corroborated"))).toBe(true);
		expect(isEnforceableTruth(row("correct", "derived"))).toBe(true);
	});

	it("does NOT enforce an inferred or unspecified verdict (the contamination guard)", () => {
		// The 2026-04-29 "hair appointment" was status=correct but really inferred
		// from the pipeline's own label — it must never gate.
		expect(isEnforceableTruth(row("correct", "inferred"))).toBe(false);
		expect(isEnforceableTruth(row("correct", "unspecified"))).toBe(false);
	});

	it("does NOT enforce partial/unclear verdicts however trusted", () => {
		expect(isEnforceableTruth(row("partial", "user"))).toBe(false);
		expect(isEnforceableTruth(row("unclear", "corroborated"))).toBe(false);
	});
});

describe("parseGroundTruth — provenance per row", () => {
	const MD = `# 2026-04-29 — ground truth

## Audit of 2026-04-29

| Window         | Blessed                                      | Status     | Notes                                  |
| -------------- | -------------------------------------------- | ---------- | -------------------------------------- |
| 14:36 – 16:19  | stationary @ Kapsalon Marian (hairdresser)   | **wrong**  | HMC outpatient visit {corroborated}    |
| 12:25 – 12:35  | walking on Hudson Walk                        | correct    | cadence + GPS {derived}                |
| 09:00 – 10:00  | stationary @ Home                             | correct    |                                        |
`;
	it("attaches the tagged provenance and leaves untagged rows unspecified", () => {
		const out = parseGroundTruth(MD, "2026-04-29", "Europe/Amsterdam");
		const byWindow = (w: string) => out.rows.find((r) => r.windowText.includes(w));
		expect(byWindow("14:36")?.provenance).toBe("corroborated");
		expect(byWindow("14:36")?.status).toBe("wrong");
		expect(byWindow("12:25")?.provenance).toBe("derived");
		expect(byWindow("09:00")?.provenance).toBe("unspecified");
		// Enforceability flows from both fields.
		const hmc = byWindow("14:36");
		expect(hmc && isEnforceableTruth(hmc)).toBe(true);
		const home = byWindow("09:00");
		expect(home && isEnforceableTruth(home)).toBe(false); // correct but unspecified
	});
});
