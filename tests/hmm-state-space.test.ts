/**
 * `buildStateSpace` — pure function enumerating the HMM's reachable
 * (mode, place, line) tuples for a user.
 *
 * Valid combinations enforced:
 *   - mode=stationary: line=none; place ∈ {focus_place ids, none}
 *   - mode=train: line ∈ {known lines, "unknown_rail"}; place=none
 *   - mode ∈ {walking, cycling, driving, plane}: line=none; place=none
 *   - mode=unknown: line=none; place=none (carryover from honest-gaps)
 *
 * Each state has a stable string key for transition / emission lookup.
 */

import { describe, expect, it } from "vitest";
import { buildStateSpace, stateKey } from "../src/hmm/state-space.js";

describe("buildStateSpace", () => {
	it("returns the always-on backbone states even with no input", () => {
		const states = buildStateSpace({ focusPlaces: [], knownLines: [] });
		const keys = new Set(states.map(stateKey));
		// Movement modes (no place, no line) always present.
		expect(keys.has("walking")).toBe(true);
		expect(keys.has("cycling")).toBe(true);
		expect(keys.has("driving")).toBe(true);
		expect(keys.has("plane")).toBe(true);
		expect(keys.has("unknown")).toBe(true);
		// Train fallback for unknown lines always present.
		expect(keys.has("train|unknown_rail")).toBe(true);
		// Stationary at no-place (off-network) always present.
		expect(keys.has("stationary|none")).toBe(true);
	});

	it("adds one stationary state per focus place", () => {
		const states = buildStateSpace({
			focusPlaces: [
				{ id: 1, displayName: "Home" },
				{ id: 2, displayName: "Work" },
				{ id: 3, displayName: null },
			],
			knownLines: [],
		});
		const keys = new Set(states.map(stateKey));
		expect(keys.has("stationary|1")).toBe(true);
		expect(keys.has("stationary|2")).toBe(true);
		expect(keys.has("stationary|3")).toBe(true);
		// And the off-network stationary stays as a backbone state.
		expect(keys.has("stationary|none")).toBe(true);
	});

	it("adds one train state per known line plus the unknown_rail fallback", () => {
		const states = buildStateSpace({
			focusPlaces: [],
			knownLines: ["Metropolitan Line", "Jubilee Line", "Victoria Line"],
		});
		const keys = new Set(states.map(stateKey));
		expect(keys.has("train|Metropolitan Line")).toBe(true);
		expect(keys.has("train|Jubilee Line")).toBe(true);
		expect(keys.has("train|Victoria Line")).toBe(true);
		expect(keys.has("train|unknown_rail")).toBe(true);
	});

	it("does not emit invalid combinations (walking with a place, train with a place, etc.)", () => {
		const states = buildStateSpace({
			focusPlaces: [{ id: 1, displayName: "Home" }],
			knownLines: ["Metropolitan Line"],
		});
		for (const s of states) {
			if (
				s.mode === "walking" ||
				s.mode === "cycling" ||
				s.mode === "driving" ||
				s.mode === "plane" ||
				s.mode === "unknown"
			) {
				expect(s.placeId).toBeNull();
				expect(s.lineName).toBeNull();
			}
			if (s.mode === "train") {
				expect(s.placeId).toBeNull();
				expect(s.lineName).not.toBeNull();
			}
			if (s.mode === "stationary") {
				expect(s.lineName).toBeNull();
			}
		}
	});

	it("dedupes states", () => {
		const states = buildStateSpace({
			focusPlaces: [
				{ id: 1, displayName: "Home" },
				{ id: 1, displayName: "Home" }, // duplicate
			],
			knownLines: ["Metropolitan Line", "Metropolitan Line"], // duplicate
		});
		const keys = states.map(stateKey);
		expect(new Set(keys).size).toBe(keys.length);
	});

	it("produces ~21 states for a typical user (top-10 places + top-6 lines + 5 movement modes)", () => {
		const focusPlaces = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, displayName: `Place${i + 1}` }));
		const knownLines = ["Met", "Jub", "Vic", "Pic", "Bak"]; // 5 lines + unknown_rail = 6 train states
		const states = buildStateSpace({ focusPlaces, knownLines });
		// 10 place stationaries + 1 off-network stationary + 5 movement modes (walking, cycling, driving, plane, unknown)
		// + 5 named train states + 1 unknown_rail = 22.
		expect(states.length).toBe(22);
	});

	it("stateKey is stable and round-trippable for transitions", () => {
		const s1 = { mode: "stationary" as const, placeId: 42, lineName: null, trainEdgeId: null };
		const s2 = { mode: "train" as const, placeId: null, lineName: "Jubilee Line", trainEdgeId: null };
		const s3 = { mode: "walking" as const, placeId: null, lineName: null, trainEdgeId: null };
		// Distinct keys per distinct state.
		expect(stateKey(s1)).not.toBe(stateKey(s2));
		expect(stateKey(s2)).not.toBe(stateKey(s3));
		// Same state object → same key.
		expect(stateKey(s1)).toBe(stateKey({ mode: "stationary", placeId: 42, lineName: null, trainEdgeId: null }));
	});
});
