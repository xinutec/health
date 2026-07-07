import { describe, expect, it } from "vitest";
import type { GroundTruthRow, ParsedTruth } from "../../src/eval/ground-truth.js";
import { parseGroundTruth, parseTruthCell } from "../../src/eval/ground-truth.js";
import { classifyDay, parsePipelineState, rowVerdict, truthMatches } from "../../src/eval/truth-check.js";

const stay = (place: string, qualifier: string | null = null): ParsedTruth => ({
	mode: "stationary",
	place,
	wayName: null,
	placeQualifier: qualifier,
	trainFromTo: null,
	lineName: null,
});
const walk = (wayName: string | null): ParsedTruth => ({
	mode: "walking",
	place: null,
	wayName,
	placeQualifier: null,
	trainFromTo: null,
	lineName: null,
});
const train = (from: string | null, to: string | null, lineName: string | null = null): ParsedTruth => ({
	mode: "train",
	place: null,
	wayName: null,
	placeQualifier: null,
	trainFromTo: from != null && to != null ? { from, to } : null,
	lineName,
});

describe("truthMatches — asymmetric: the truth asserts only what it names", () => {
	it("matches the same place ignoring the trailing qualifier", () => {
		expect(truthMatches(stay("HMC Westeinde", "hospital"), stay("HMC Westeinde", null))).toBe(true);
	});
	it("treats sleeping and stationary at the same place as equivalent", () => {
		const sleeping: ParsedTruth = { ...stay("Home"), mode: "sleeping" };
		expect(truthMatches(sleeping, stay("Home"))).toBe(true);
	});
	it("distinguishes different places", () => {
		expect(truthMatches(stay("HMC Westeinde"), stay("Kapsalon Marian"))).toBe(false);
	});
	it("a truth-asserted way must hold; an unasserted way accepts any live label", () => {
		expect(truthMatches(walk("Hudson Walk"), walk("Hudson Walk"))).toBe(true);
		expect(truthMatches(walk("Hudson Walk"), walk("Westeinde"))).toBe(false);
		expect(truthMatches(walk("Hudson Walk"), walk(null))).toBe(false); // live lost the asserted way
		// Plain "walking" only vetted the mode — extra live attribution is not a contradiction.
		expect(truthMatches(walk(null), walk("Westeinde"))).toBe(true);
		expect(truthMatches(walk(null), walk(null))).toBe(true);
	});
	it("matches trains on board+alight; line only discriminates when both name one", () => {
		expect(truthMatches(train("A", "B", "Met"), train("A", "B", null))).toBe(true); // missing line ≠ contradiction
		expect(truthMatches(train("A", "B", "Met"), train("A", "B", "Jubilee"))).toBe(false);
		expect(truthMatches(train("A", "B"), train("A", "C"))).toBe(false);
	});
	it("a truth-bare train accepts any live train; an asserted route requires one", () => {
		expect(truthMatches(train(null, null), train("A", "B", "Met"))).toBe(true);
		expect(truthMatches(train("A", "B"), train(null, null))).toBe(false); // live lost the route
	});
	it("a truth-asserted bus road must hold against the live road label", () => {
		const busOn = (way: string | null): ParsedTruth => ({ ...walk(way), mode: "bus" });
		expect(truthMatches(busOn("Piccadilly"), busOn("Piccadilly"))).toBe(true);
		expect(truthMatches(busOn("Piccadilly"), busOn("Edgware Road"))).toBe(false);
		expect(truthMatches(busOn(null), busOn("Piccadilly"))).toBe(true);
	});
	it("never matches when either side is null", () => {
		expect(truthMatches(null, stay("Home"))).toBe(false);
		expect(truthMatches(stay("Home"), null)).toBe(false);
	});
});

describe("parsePipelineState — render a live state for comparison", () => {
	it("splits a place name from its qualifier and round-trips against a truth stay", () => {
		const r = parsePipelineState({ mode: "stationary", place: "HMC Westeinde (hospital)" });
		expect(r?.place).toBe("HMC Westeinde");
		expect(r?.placeQualifier).toBe("hospital");
		expect(truthMatches(stay("HMC Westeinde", "hospital"), r)).toBe(true);
	});
	it("renders a walk as a way", () => {
		expect(truthMatches(walk("Hudson Walk"), parsePipelineState({ mode: "walking", wayName: "Hudson Walk" }))).toBe(
			true,
		);
	});
	it("parses a train route wayName into board/alight + line", () => {
		const r = parsePipelineState({ mode: "train", wayName: "Ashvale → Carfax · Metropolitan Line" });
		expect(r?.trainFromTo).toEqual({ from: "Ashvale", to: "Carfax" });
		expect(r?.lineName).toBe("Metropolitan Line");
		expect(truthMatches(train("Ashvale", "Carfax", "Metropolitan Line"), r)).toBe(true);
	});
	it("handles a bare line-name train wayName as line-only", () => {
		const r = parsePipelineState({ mode: "train", wayName: "Circle Line" });
		expect(r?.trainFromTo).toBeNull();
		expect(r?.lineName).toBe("Circle Line");
	});
	it("parses a bus route wayName into board/alight + route number", () => {
		const r = parsePipelineState({ mode: "bus", wayName: "Green Park Station → Wilton Street · 38" });
		expect(r?.trainFromTo).toEqual({ from: "Green Park Station", to: "Wilton Street" });
		expect(r?.lineName).toBe("38");
		expect(truthMatches(parseTruthCell("bus Green Park Station → Wilton Street · 38"), r)).toBe(true);
	});
	it("keeps a routeless bus label as road names, matching a 'bus on X' truth cell", () => {
		const r = parsePipelineState({ mode: "bus", wayName: "Piccadilly" });
		expect(r?.wayName).toBe("Piccadilly");
		expect(truthMatches(parseTruthCell("bus on Piccadilly"), r)).toBe(true);
	});
	it("returns null for an absent state", () => {
		expect(parsePipelineState(null)).toBeNull();
	});
});

describe("parseTruthCell — narrative formatting is presentation, not content", () => {
	it("strips bold emphasis markers before parsing", () => {
		const r = parseTruthCell("**train Wembley Park → **Euston Square** · Metropolitan Line**");
		expect(r?.trainFromTo).toEqual({ from: "Wembley Park", to: "Euston Square" });
		expect(r?.lineName).toBe("Metropolitan Line");
	});
	it("treats a trailing parenthetical on the alight as commentary, not a line assertion", () => {
		const r = parseTruthCell("train Euston Square → King's Cross St Pancras (Circle/H&C/Met)");
		expect(r?.trainFromTo).toEqual({ from: "Euston Square", to: "King's Cross St Pancras" });
		expect(r?.lineName).toBeNull();
	});
	it("parses 'train on X' as a line name, 'bus on X' as a road", () => {
		expect(parseTruthCell("train on Circle Line")?.lineName).toBe("Circle Line");
		expect(parseTruthCell("bus on Piccadilly")?.wayName).toBe("Piccadilly");
	});
});

describe("parseGroundTruth — Times: declaration overrides the fixture tz", () => {
	const MD = `# 2026-04-29

Times: Europe/Amsterdam

## Audit of 2026-04-29

| Window         | Truth                  | Status  | Notes |
| -------------- | ---------------------- | ------- | ----- |
| 14:36 – 16:19  | stationary @ HMC       | correct | {user} |
`;
	it("interprets table times in the declared zone, not the caller's", () => {
		const declared = parseGroundTruth(MD, "2026-04-29", "Europe/London");
		const fallback = parseGroundTruth(MD.replace("Times: Europe/Amsterdam\n", ""), "2026-04-29", "Europe/London");
		// CEST is one hour ahead of BST → the same wall-clock is one hour earlier in UTC.
		expect(declared.rows[0].startTs).toBe(fallback.rows[0].startTs - 3600);
		expect(declared.tz).toBe("Europe/Amsterdam");
	});
});

describe("rowVerdict — the five-way classification (the cell is the truth)", () => {
	const row = (status: string, provenance: string) =>
		({ status, provenance }) as Pick<GroundTruthRow, "status" | "provenance">;

	it("verified: enforceable correct + pipeline matches the truth", () => {
		expect(rowVerdict(row("correct", "user"), true)).toBe("verified");
	});
	it("regressed: enforceable correct + pipeline no longer matches the truth", () => {
		expect(rowVerdict(row("correct", "corroborated"), false)).toBe("regressed");
	});
	it("known-error: enforceable wrong + pipeline still deviates from the truth", () => {
		expect(rowVerdict(row("wrong", "corroborated"), false)).toBe("known-error");
	});
	it("cleared: enforceable wrong + pipeline now matches the truth (verifiably fixed)", () => {
		expect(rowVerdict(row("wrong", "corroborated"), true)).toBe("cleared");
	});
	it("unverified: inferred/unspecified provenance never gates, whatever the match", () => {
		expect(rowVerdict(row("correct", "inferred"), true)).toBe("unverified");
		expect(rowVerdict(row("correct", "unspecified"), false)).toBe("unverified");
		expect(rowVerdict(row("partial", "user"), true)).toBe("unverified");
	});
});

describe("classifyDay — 2026-04-29 hairdresser → HMC, the contamination case end to end", () => {
	// A wrong+corroborated row whose cell states the TRUTH (HMC) the pipeline
	// deviates from, and a correct+derived walk. Plus a legacy untagged
	// 'correct' row that must NOT gate.
	const MD = `# 2026-04-29

## Audit of 2026-04-29

| Window         | Truth                                         | Status     | Notes                                        |
| -------------- | --------------------------------------------- | ---------- | -------------------------------------------- |
| 14:36 – 16:19  | stationary @ HMC Westeinde (hospital)         | **wrong**  | pipeline says Kapsalon Marian {corroborated} |
| 12:25 – 12:35  | walking on Hudson Walk                        | correct    | cadence + GPS {derived}                      |
| 09:00 – 10:00  | stationary @ Home                             | correct    | legacy untagged row                          |
`;
	const day = parseGroundTruth(MD, "2026-04-29", "Europe/Amsterdam");
	const byWindow = (w: string) => {
		const r = day.rows.find((row) => row.windowText.includes(w));
		if (!r) throw new Error(`no ground-truth row for ${w}`);
		return r;
	};
	const hairdresser = stay("Kapsalon Marian", "hairdresser");

	it("before the fix: the hairdresser is a tolerated known-error, not a failure", () => {
		// Pipeline still emits the hairdresser (≠ the HMC truth) for the 14:36 row.
		const res = classifyDay(day.rows, (row) => (row.windowText.includes("14:36") ? hairdresser : row.truth));
		const v = (w: string) => res.verdicts.find((x) => x.row === byWindow(w))?.verdict;
		expect(v("14:36")).toBe("known-error"); // wrong + pipeline still deviates
		expect(v("12:25")).toBe("verified"); // correct + derived, pipeline matches
		expect(v("09:00")).toBe("unverified"); // correct but untagged → never gates
		expect(res.hasRegression).toBe(false);
	});

	it("after the fix: emitting HMC clears the known-error — verifiably against the truth", () => {
		// Pipeline now emits the truth for every row.
		const res = classifyDay(day.rows, (row) => row.truth);
		const v = (w: string) => res.verdicts.find((x) => x.row === byWindow(w))?.verdict;
		expect(v("14:36")).toBe("cleared");
		expect(v("12:25")).toBe("verified");
		expect(res.hasRegression).toBe(false);
	});

	it("a real regression on a verified row IS flagged", () => {
		// Pipeline breaks the 12:25 derived-correct walk (emits a stay instead).
		const res = classifyDay(day.rows, (row) => (row.windowText.includes("12:25") ? stay("Nowhere") : row.truth));
		expect(res.verdicts.find((x) => x.row === byWindow("12:25"))?.verdict).toBe("regressed");
		expect(res.hasRegression).toBe(true);
	});
});
