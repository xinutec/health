import { describe, expect, it } from "vitest";
import type { GroundTruthRow, ParsedBlessed } from "../../src/eval/ground-truth.js";
import { parseGroundTruth } from "../../src/eval/ground-truth.js";
import { blessedEquivalent, classifyDay, parsePipelineState, rowVerdict } from "../../src/eval/truth-check.js";

const stay = (place: string, qualifier: string | null = null): ParsedBlessed => ({
	mode: "stationary",
	place,
	wayName: null,
	placeQualifier: qualifier,
	trainFromTo: null,
	lineName: null,
});
const walk = (wayName: string | null): ParsedBlessed => ({
	mode: "walking",
	place: null,
	wayName,
	placeQualifier: null,
	trainFromTo: null,
	lineName: null,
});
const train = (from: string, to: string, lineName: string | null = null): ParsedBlessed => ({
	mode: "train",
	place: null,
	wayName: null,
	placeQualifier: null,
	trainFromTo: { from, to },
	lineName,
});

describe("blessedEquivalent", () => {
	it("matches the same place ignoring the trailing qualifier", () => {
		expect(blessedEquivalent(stay("HMC Westeinde", "hospital"), stay("HMC Westeinde", null))).toBe(true);
	});
	it("treats sleeping and stationary at the same place as equivalent", () => {
		const sleeping: ParsedBlessed = { ...stay("Home"), mode: "sleeping" };
		expect(blessedEquivalent(sleeping, stay("Home"))).toBe(true);
	});
	it("distinguishes different places", () => {
		expect(blessedEquivalent(stay("HMC Westeinde"), stay("Kapsalon Marian"))).toBe(false);
	});
	it("matches walking on the same way, and an unlabelled walk to an unlabelled walk", () => {
		expect(blessedEquivalent(walk("Hudson Walk"), walk("Hudson Walk"))).toBe(true);
		expect(blessedEquivalent(walk(null), walk(null))).toBe(true);
		expect(blessedEquivalent(walk("Hudson Walk"), walk("Westeinde"))).toBe(false);
	});
	it("matches trains on board+alight; line only discriminates when both name one", () => {
		expect(blessedEquivalent(train("A", "B", "Met"), train("A", "B", null))).toBe(true); // missing line ≠ contradiction
		expect(blessedEquivalent(train("A", "B", "Met"), train("A", "B", "Jubilee"))).toBe(false);
		expect(blessedEquivalent(train("A", "B"), train("A", "C"))).toBe(false);
	});
	it("never matches when either side is null", () => {
		expect(blessedEquivalent(null, stay("Home"))).toBe(false);
		expect(blessedEquivalent(stay("Home"), null)).toBe(false);
	});
});

describe("parsePipelineState — render a live state for comparison", () => {
	it("splits a place name from its qualifier and round-trips equivalent to a blessed stay", () => {
		const r = parsePipelineState({ mode: "stationary", place: "HMC Westeinde (hospital)" });
		expect(r?.place).toBe("HMC Westeinde");
		expect(r?.placeQualifier).toBe("hospital");
		expect(blessedEquivalent(r, stay("HMC Westeinde", "hospital"))).toBe(true);
	});
	it("renders a walk as a way", () => {
		expect(
			blessedEquivalent(parsePipelineState({ mode: "walking", wayName: "Hudson Walk" }), walk("Hudson Walk")),
		).toBe(true);
	});
	it("parses a train route wayName into board/alight + line", () => {
		const r = parsePipelineState({ mode: "train", wayName: "Ashvale → Carfax · Metropolitan Line" });
		expect(r?.trainFromTo).toEqual({ from: "Ashvale", to: "Carfax" });
		expect(r?.lineName).toBe("Metropolitan Line");
		expect(blessedEquivalent(r, train("Ashvale", "Carfax", "Metropolitan Line"))).toBe(true);
	});
	it("handles a bare line-name train wayName as line-only", () => {
		const r = parsePipelineState({ mode: "train", wayName: "Circle Line" });
		expect(r?.trainFromTo).toBeNull();
		expect(r?.lineName).toBe("Circle Line");
	});
	it("returns null for an absent state", () => {
		expect(parsePipelineState(null)).toBeNull();
	});
});

describe("rowVerdict — the five-way classification", () => {
	const row = (status: string, provenance: string) =>
		({ status, provenance }) as Pick<GroundTruthRow, "status" | "provenance">;

	it("verified: enforceable correct + pipeline matches", () => {
		expect(rowVerdict(row("correct", "user"), true)).toBe("verified");
	});
	it("regressed: enforceable correct + pipeline no longer matches", () => {
		expect(rowVerdict(row("correct", "corroborated"), false)).toBe("regressed");
	});
	it("known-error: enforceable wrong + pipeline still emits the wrong value", () => {
		expect(rowVerdict(row("wrong", "corroborated"), true)).toBe("known-error");
	});
	it("cleared: enforceable wrong + pipeline no longer emits the wrong value", () => {
		expect(rowVerdict(row("wrong", "corroborated"), false)).toBe("cleared");
	});
	it("unverified: inferred/unspecified provenance never gates, whatever the match", () => {
		expect(rowVerdict(row("correct", "inferred"), true)).toBe("unverified");
		expect(rowVerdict(row("correct", "unspecified"), false)).toBe("unverified");
		expect(rowVerdict(row("partial", "user"), true)).toBe("unverified");
	});
});

describe("classifyDay — 2026-04-29 hairdresser → HMC, the contamination case end to end", () => {
	// A wrong+corroborated row rejecting the hairdresser, and a correct+derived
	// walk. Plus a legacy untagged 'correct' row that must NOT gate.
	const MD = `# 2026-04-29

## Audit of 2026-04-29

| Window         | Blessed                                      | Status     | Notes                               |
| -------------- | -------------------------------------------- | ---------- | ----------------------------------- |
| 14:36 – 16:19  | stationary @ Kapsalon Marian (hairdresser)   | **wrong**  | really HMC outpatient {corroborated}|
| 12:25 – 12:35  | walking on Hudson Walk                        | correct    | cadence + GPS {derived}             |
| 09:00 – 10:00  | stationary @ Home                             | correct    | legacy untagged row                 |
`;
	const day = parseGroundTruth(MD, "2026-04-29", "Europe/Amsterdam");
	const byWindow = (w: string) => {
		const r = day.rows.find((row) => row.windowText.includes(w));
		if (!r) throw new Error(`no ground-truth row for ${w}`);
		return r;
	};

	it("before the fix: the hairdresser is a tolerated known-error, not a failure", () => {
		// Pipeline still emits the wrong (blessed) value for the 14:36 row.
		const res = classifyDay(day.rows, (row) => row.blessed);
		const v = (w: string) => res.verdicts.find((x) => x.row === byWindow(w))?.verdict;
		expect(v("14:36")).toBe("known-error"); // wrong + pipeline matches the wrong value
		expect(v("12:25")).toBe("verified"); // correct + derived, pipeline matches
		expect(v("09:00")).toBe("unverified"); // correct but untagged → never gates
		expect(res.hasRegression).toBe(false);
	});

	it("after the fix: emitting HMC clears the known-error and does not regress anything", () => {
		const hmc: ParsedBlessed = {
			mode: "stationary",
			place: "HMC Westeinde",
			wayName: null,
			placeQualifier: "hospital",
			trainFromTo: null,
			lineName: null,
		};
		// Pipeline now emits HMC for 14:36 (≠ the wrong blessed value), still
		// matches the correct rows.
		const res = classifyDay(day.rows, (row) => (row.windowText.includes("14:36") ? hmc : row.blessed));
		const v = (w: string) => res.verdicts.find((x) => x.row === byWindow(w))?.verdict;
		expect(v("14:36")).toBe("cleared");
		expect(v("12:25")).toBe("verified");
		expect(res.hasRegression).toBe(false);
	});

	it("a real regression on a verified row IS flagged", () => {
		// Pipeline breaks the 12:25 derived-correct walk (emits a stay instead).
		const wrongWalk: ParsedBlessed = {
			mode: "stationary",
			place: "Nowhere",
			wayName: null,
			placeQualifier: null,
			trainFromTo: null,
			lineName: null,
		};
		const res = classifyDay(day.rows, (row) => (row.windowText.includes("12:25") ? wrongWalk : row.blessed));
		expect(res.verdicts.find((x) => x.row === byWindow("12:25"))?.verdict).toBe("regressed");
		expect(res.hasRegression).toBe(true);
	});
});
