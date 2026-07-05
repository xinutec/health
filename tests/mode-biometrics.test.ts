import { describe, expect, it } from "vitest";
import {
	aggregateModeStats,
	correctModeBySignature,
	gateCycling,
	labelMinuteByHeuristic,
	type MinuteObservation,
	type ModeStats,
	scoreModeLogLikelihood,
	vetoImplausibleCadence,
	vetoImplausibleHr,
} from "../src/geo/mode-biometrics.js";

describe("labelMinuteByHeuristic", () => {
	// The heuristic labels per-minute observations into a "confident" mode
	// label or null (ambiguous, skip). Designed to produce clean training
	// data for per-user emission stats, accepting that many minutes will
	// be unlabeled.

	it("labels low-speed low-cadence as stationary", () => {
		expect(labelMinuteByHeuristic({ hr: 72, cadence: 0, speed: 0.3 })).toBe("stationary");
		expect(labelMinuteByHeuristic({ hr: null, cadence: 0, speed: 0.5 })).toBe("stationary");
	});

	it("labels walking-cadence walking-speed as walking", () => {
		// Typical adult walking cadence 100-130 spm, speed 4-6 km/h.
		expect(labelMinuteByHeuristic({ hr: 110, cadence: 110, speed: 5 })).toBe("walking");
		expect(labelMinuteByHeuristic({ hr: 95, cadence: 90, speed: 4 })).toBe("walking");
	});

	it("labels zero-cadence + cycling-speed + elevated-HR as cycling", () => {
		// Cycling has the unique signature: no steps recorded, moderate
		// speed (12-25 km/h), elevated HR.
		expect(labelMinuteByHeuristic({ hr: 130, cadence: 0, speed: 18 })).toBe("cycling");
		expect(labelMinuteByHeuristic({ hr: 140, cadence: 0, speed: 22 })).toBe("cycling");
	});

	it("does NOT label cycling without HR confirmation", () => {
		// Cycling at 18 km/h cadence 0 looks like a slow drive without HR.
		// Refuse to label rather than learn wrong stats.
		expect(labelMinuteByHeuristic({ hr: null, cadence: 0, speed: 18 })).toBeNull();
	});

	it("does NOT label cycling-speed with sub-cycling HR as cycling", () => {
		// HR too low for cycling — probably a slow drive on a residential
		// road. Skip the label.
		expect(labelMinuteByHeuristic({ hr: 80, cadence: 0, speed: 18 })).toBeNull();
	});

	it("labels high-speed zero-cadence as driving", () => {
		// > 30 km/h with no steps. HR can confirm (low / sitting) but null
		// is fine — no other mode plausibly hits this speed.
		expect(labelMinuteByHeuristic({ hr: 75, cadence: 0, speed: 50 })).toBe("driving");
		expect(labelMinuteByHeuristic({ hr: null, cadence: 0, speed: 40 })).toBe("driving");
	});

	it("does NOT label driving when HR is high (could be cycling on a hill)", () => {
		// HR 130 at 35 km/h could be a fast cyclist on a descent. Reject
		// to avoid learning wrong-mode stats.
		expect(labelMinuteByHeuristic({ hr: 130, cadence: 0, speed: 35 })).toBeNull();
	});

	it("labels very high speed zero-cadence as train", () => {
		expect(labelMinuteByHeuristic({ hr: 72, cadence: 0, speed: 100 })).toBe("train");
		expect(labelMinuteByHeuristic({ hr: null, cadence: 0, speed: 120 })).toBe("train");
		// Fastest scheduled high-speed rail: TGV 320 km/h, Shinkansen 285.
		// Up to ~330 km/h is still rail.
		expect(labelMinuteByHeuristic({ hr: 75, cadence: 0, speed: 250 })).toBe("train");
	});

	it("labels cruise-speed zero-cadence as plane", () => {
		// Commercial jet cruise: 700-900 km/h. Unambiguous vs every other
		// mode — high-speed trains top out around 320 km/h, so > 500 km/h
		// is definitely a plane.
		expect(labelMinuteByHeuristic({ hr: 72, cadence: 0, speed: 800 })).toBe("plane");
		expect(labelMinuteByHeuristic({ hr: null, cadence: 0, speed: 700 })).toBe("plane");
		expect(labelMinuteByHeuristic({ hr: 90, cadence: 0, speed: 850 })).toBe("plane");
	});

	it("does NOT label transition-zone speeds (between high-speed rail and plane)", () => {
		// 350-500 km/h is climb-out / descent / fast turboprop — ambiguous.
		// Skip rather than corrupt either signature.
		expect(labelMinuteByHeuristic({ hr: 75, cadence: 0, speed: 400 })).toBeNull();
		expect(labelMinuteByHeuristic({ hr: 80, cadence: 0, speed: 450 })).toBeNull();
	});

	it("does NOT label walking when speed is too high (could be running)", () => {
		// 9 km/h with cadence 150 might be jogging — we don't have a
		// "running" mode, so refuse to label.
		expect(labelMinuteByHeuristic({ hr: 130, cadence: 150, speed: 9 })).toBeNull();
	});

	it("does NOT label walking when cadence is missing (passenger could match)", () => {
		// 5 km/h at cadence null — could be walking with watch off, could
		// be slow stop-and-go traffic. Skip.
		expect(labelMinuteByHeuristic({ hr: 100, cadence: null, speed: 5 })).toBeNull();
	});

	it("returns null for ambiguous mid-band observations", () => {
		// 10 km/h cadence 30 HR 100 — could be cycling, slow drive, fast
		// walk, escalator, whatever. No clean label.
		expect(labelMinuteByHeuristic({ hr: 100, cadence: 30, speed: 10 })).toBeNull();
	});

	it("returns null when there is no signal at all", () => {
		expect(labelMinuteByHeuristic({ hr: null, cadence: null, speed: null })).toBeNull();
	});
});

describe("aggregateModeStats", () => {
	// Per-mode summary statistics from an array of labeled minute samples.
	// Produces mean/std/sample_count per mode, plus per-modality
	// null-counts so application can decide whether HR-based scoring is
	// viable.

	it("groups samples by mode and computes per-mode means", () => {
		const samples: { mode: string; obs: MinuteObservation }[] = [
			{ mode: "walking", obs: { hr: 100, cadence: 110, speed: 5 } },
			{ mode: "walking", obs: { hr: 110, cadence: 120, speed: 5 } },
			{ mode: "walking", obs: { hr: 120, cadence: 100, speed: 5 } },
			{ mode: "cycling", obs: { hr: 130, cadence: 0, speed: 18 } },
			{ mode: "cycling", obs: { hr: 140, cadence: 0, speed: 20 } },
		];
		const stats = aggregateModeStats(samples);
		const walking = stats.find((s) => s.mode === "walking");
		expect(walking?.hrMean).toBeCloseTo(110, 1);
		expect(walking?.sampleCount).toBe(3);
		const cycling = stats.find((s) => s.mode === "cycling");
		expect(cycling?.hrMean).toBeCloseTo(135, 1);
		expect(cycling?.speedMean).toBeCloseTo(19, 1);
	});

	it("handles nullable modalities — null HRs are excluded from HR stats", () => {
		const samples = [
			{ mode: "walking", obs: { hr: 100, cadence: 110, speed: 5 } },
			{ mode: "walking", obs: { hr: null, cadence: 120, speed: 5 } },
			{ mode: "walking", obs: { hr: null, cadence: 100, speed: 5 } },
		];
		const stats = aggregateModeStats(samples);
		const walking = stats.find((s) => s.mode === "walking");
		expect(walking?.hrMean).toBeCloseTo(100, 1);
		expect(walking?.hrSampleCount).toBe(1);
		expect(walking?.sampleCount).toBe(3); // total samples for this mode
	});

	it("computes standard deviation", () => {
		const samples = [
			{ mode: "walking", obs: { hr: 100, cadence: 100, speed: 5 } },
			{ mode: "walking", obs: { hr: 120, cadence: 100, speed: 5 } },
		];
		const stats = aggregateModeStats(samples);
		const walking = stats.find((s) => s.mode === "walking");
		// Population std of [100, 120] around mean 110 = sqrt((100+100)/2) = 10
		expect(walking?.hrStd).toBeCloseTo(10, 1);
	});

	it("returns empty array when given no samples", () => {
		expect(aggregateModeStats([])).toEqual([]);
	});

	it("returns null hrMean when all HRs are null for that mode", () => {
		const samples = [
			{ mode: "stationary", obs: { hr: null, cadence: 0, speed: 0.3 } },
			{ mode: "stationary", obs: { hr: null, cadence: 0, speed: 0.4 } },
		];
		const stats = aggregateModeStats(samples);
		const stat = stats.find((s) => s.mode === "stationary");
		expect(stat?.hrMean).toBeNull();
		expect(stat?.hrStd).toBeNull();
		expect(stat?.sampleCount).toBe(2);
	});

	it("ignores samples with null speed (cannot be aggregated)", () => {
		const samples = [
			{ mode: "walking", obs: { hr: 100, cadence: 110, speed: 5 } },
			{ mode: "walking", obs: { hr: 110, cadence: 120, speed: null } },
		];
		const stats = aggregateModeStats(samples);
		const walking = stats.find((s) => s.mode === "walking");
		expect(walking?.speedMean).toBeCloseTo(5, 1);
		expect(walking?.sampleCount).toBe(2);
	});
});

// Synthetic per-user signatures used in scoring + correction tests. The
// walking/driving HR gap (108 vs 75) is exactly the signal we want the
// corrector to use.
const USER_STATS: ModeStats[] = [
	{
		mode: "stationary",
		hrMean: 68.5,
		hrStd: 12.3,
		hrSampleCount: 50000,
		cadenceMean: 0,
		cadenceStd: 0.4,
		cadenceSampleCount: 50000,
		speedMean: 0.3,
		speedStd: 0.3,
		speedSampleCount: 50000,
		sampleCount: 51693,
	},
	{
		mode: "walking",
		hrMean: 108,
		hrStd: 14,
		hrSampleCount: 9000,
		cadenceMean: 107,
		cadenceStd: 11,
		cadenceSampleCount: 10000,
		speedMean: 5.1,
		speedStd: 1.1,
		speedSampleCount: 10000,
		sampleCount: 10034,
	},
	{
		mode: "driving",
		hrMean: 75,
		hrStd: 8,
		hrSampleCount: 4000,
		cadenceMean: 0,
		cadenceStd: 0.5,
		cadenceSampleCount: 4274,
		speedMean: 52,
		speedStd: 15,
		speedSampleCount: 4274,
		sampleCount: 4274,
	},
	{
		mode: "cycling",
		hrMean: 107,
		hrStd: 6,
		hrSampleCount: 60,
		cadenceMean: 0,
		cadenceStd: 0.8,
		cadenceSampleCount: 60,
		speedMean: 17.5,
		speedStd: 3.3,
		speedSampleCount: 60,
		sampleCount: 60,
	},
	{
		mode: "train",
		hrMean: 74,
		hrStd: 9,
		hrSampleCount: 4000,
		cadenceMean: 0,
		cadenceStd: 0.4,
		cadenceSampleCount: 4052,
		speedMean: 100, // realistic train cruise; ignore the airplane-skewed real value
		speedStd: 30,
		speedSampleCount: 4052,
		sampleCount: 4052,
	},
];

describe("scoreModeLogLikelihood", () => {
	const statsFor = (mode: string): (typeof USER_STATS)[number] => {
		const s = USER_STATS.find((x) => x.mode === mode);
		if (s === undefined) throw new Error(`no USER_STATS fixture for mode ${mode}`);
		return s;
	};
	const walking = statsFor("walking");
	const driving = statsFor("driving");

	it("scores a perfect walking observation high under walking", () => {
		const score = scoreModeLogLikelihood({ hr: 108, cadence: 107, speed: 5.1 }, walking);
		// Three z-scores all zero → log-lik = 0 (the max under Gaussian).
		expect(score).toBeCloseTo(0, 1);
	});

	it("scores a perfect walking observation low under driving", () => {
		// HR 108 is 4σ above driving's 75; speed 5 is 3σ below driving's 52.
		const score = scoreModeLogLikelihood({ hr: 108, cadence: 107, speed: 5.1 }, driving);
		// Significantly negative — driving doesn't explain this observation.
		expect(score).toBeLessThan(-10);
	});

	it("scores an observation higher under the correct mode", () => {
		const obs = { hr: 105, cadence: 105, speed: 5 };
		const wScore = scoreModeLogLikelihood(obs, walking);
		const dScore = scoreModeLogLikelihood(obs, driving);
		expect(wScore).toBeGreaterThan(dScore);
	});

	it("handles null observations gracefully (drops the modality)", () => {
		// HR missing → just cadence + speed contribute.
		const score = scoreModeLogLikelihood({ hr: null, cadence: 107, speed: 5.1 }, walking);
		expect(Number.isFinite(score)).toBe(true);
		expect(score).toBeCloseTo(0, 1); // cadence+speed at mean
	});

	it("returns -Infinity when modeStat has all-null modalities (unusable)", () => {
		const empty: ModeStats = {
			mode: "x",
			hrMean: null,
			hrStd: null,
			hrSampleCount: 0,
			cadenceMean: null,
			cadenceStd: null,
			cadenceSampleCount: 0,
			speedMean: null,
			speedStd: null,
			speedSampleCount: 0,
			sampleCount: 0,
		};
		expect(scoreModeLogLikelihood({ hr: 100, cadence: 100, speed: 5 }, empty)).toBe(-Infinity);
	});
});

describe("vetoImplausibleHr", () => {
	// The HR-veto is a hard rule that fires independently of the
	// log-likelihood-based correction: if the observed HR is more
	// than VETO_SIGMA std-devs below the current mode's HR mean,
	// the classification is biologically implausible regardless of
	// what speed/cadence/OSM features say.
	it("vetoes a cycling label when observed HR is ~3 sigma below cycling's HR distribution", () => {
		// Cycling: 107 ± 6 → 2σ floor at 95. Observed 80 is way below.
		const r = vetoImplausibleHr({ mode: "cycling", obsHr: 80, obsCadence: 5, obsSpeed: 6 }, USER_STATS);
		expect(r.changed).toBe(true);
		expect(r.mode).not.toBe("cycling");
	});

	it("does not veto when observed HR is comfortably inside the cycling distribution", () => {
		const r = vetoImplausibleHr({ mode: "cycling", obsHr: 110, obsCadence: 0, obsSpeed: 18 }, USER_STATS);
		expect(r.changed).toBe(false);
	});

	it("after vetoing, picks the highest-log-likelihood alternative mode", () => {
		// Observation: HR 85, cadence 5, speed 6. Walking signature
		// (108 ± 14, cadence 107 ± 11, speed 5.1 ± 1.1) — HR is
		// borderline but speed and cadence are off. Stationary
		// signature (68.5 ± 12.3, cadence 0, speed 0.3) — HR fits
		// well, low cadence + speed look right. Score should put
		// walking just slightly ahead of stationary for these obs
		// because cadence=5 is in walking's lower tail.
		const r = vetoImplausibleHr({ mode: "cycling", obsHr: 85, obsCadence: 5, obsSpeed: 6 }, USER_STATS);
		expect(r.changed).toBe(true);
		// Either walking or stationary is acceptable here; this
		// pins down that the veto picks a movement-compatible
		// mode, not e.g. plane.
		expect(["walking", "stationary"]).toContain(r.mode);
	});
});

describe("vetoImplausibleCadence", () => {
	// Sibling to vetoImplausibleHr. Cycling, driving, train, and plane all
	// share the signature "cadence ≈ 0" — pedalling / sitting / standing
	// quietly don't register as steps. A segment labelled one of these
	// modes whose observed cadence is in walking range (~80-130 spm) is
	// biologically implausible; the user was walking, not cycling.
	//
	// Motivating scenario: a 20-min segment classified as cycling with HR
	// ~97 and cadence ~80 spm. HR is in cycling's borderline range
	// (~107 ± 6 mean), so vetoImplausibleHr doesn't fire. Cadence is
	// decisive.

	it("vetoes a cycling label when observed cadence is in walking range", () => {
		// 80 spm at HR 97. Cycling cadenceMean=0 std=0.8 → 2σ
		// + floor 30 → threshold 30. 80 >> 30, demote.
		const r = vetoImplausibleCadence({ mode: "cycling", obsHr: 97, obsCadence: 80, obsSpeed: 6 }, USER_STATS);
		expect(r.changed).toBe(true);
		expect(r.mode).not.toBe("cycling");
	});

	it("does not veto when cadence is plausibly zero (real cycling)", () => {
		const r = vetoImplausibleCadence({ mode: "cycling", obsHr: 130, obsCadence: 0, obsSpeed: 18 }, USER_STATS);
		expect(r.changed).toBe(false);
	});

	it("does not veto when cadence is small noise (e.g. 5 spm — incidental steps while pedalling)", () => {
		// A noisy cadence reading of 5 spm during real cycling shouldn't
		// trigger a flip. Floor 30 protects against this.
		const r = vetoImplausibleCadence({ mode: "cycling", obsHr: 120, obsCadence: 5, obsSpeed: 18 }, USER_STATS);
		expect(r.changed).toBe(false);
	});

	it("vetoes driving if observed cadence is in walking range", () => {
		// A "driving" misclassification of a brisk walk — high cadence
		// gives it away.
		const r = vetoImplausibleCadence({ mode: "driving", obsHr: 105, obsCadence: 100, obsSpeed: 5 }, USER_STATS);
		expect(r.changed).toBe(true);
	});

	it("after vetoing, picks the highest-log-likelihood alternative", () => {
		// HR 97 + cadence 80 + speed 6: walking signature fits best
		// (HR ~108 ± 14, cadence ~107 ± 11, speed ~5.1 ± 1.1).
		const r = vetoImplausibleCadence({ mode: "cycling", obsHr: 97, obsCadence: 80, obsSpeed: 6 }, USER_STATS);
		expect(r.changed).toBe(true);
		expect(r.mode).toBe("walking");
	});

	it("does not veto at high speeds (walking is biomechanically implausible)", () => {
		// Train at 108 km/h with vibration-cadence 50 spm. The prior
		// version would have demoted to cycling (the least-bad LL among
		// alternatives, all bad at 108 km/h). The speed gate prevents
		// the veto because walking isn't a plausible alternative here.
		const r = vetoImplausibleCadence({ mode: "driving", obsHr: 80, obsCadence: 50, obsSpeed: 108 }, USER_STATS);
		expect(r.changed).toBe(false);
	});

	it("still vetoes when speed is plausible for walking even with elevated cadence", () => {
		// Cycling at 6 km/h is borderline-slow cycling but plausibly walking
		// with cadence 80. Veto fires because speed is well under the 15 km/h
		// ceiling.
		const r = vetoImplausibleCadence({ mode: "cycling", obsHr: 97, obsCadence: 80, obsSpeed: 6 }, USER_STATS);
		expect(r.changed).toBe(true);
	});

	it("respects the FLOOR even when std-dev is zero (degenerate stats)", () => {
		// Some users have cadenceMean=0, cadenceStd=0 (pure zeros for
		// cycling). Then mean + 2σ = 0, which would veto any obsCadence > 0.
		// Floor 30 prevents this false positive at small cadence noise.
		const cyclingDegenerate = USER_STATS.map((s) =>
			s.mode === "cycling" ? { ...s, cadenceMean: 0, cadenceStd: 0, cadenceSampleCount: 60 } : s,
		);
		const r = vetoImplausibleCadence({ mode: "cycling", obsHr: 120, obsCadence: 20, obsSpeed: 18 }, cyclingDegenerate);
		expect(r.changed).toBe(false);
	});
});

describe("cadence-veto integration via correctModeBySignature", () => {
	// The phantom-cycling → walking case is covered by
	// tests/scenarios/phantom-cycling.test.ts, which drives the same
	// situation through classifySegments instead of pinning the exact
	// (margin, HR, cadence, speed) trio. Only the negative control
	// stays here — it's the "don't over-fire" boundary worth pinning
	// at the unit level.

	it("preserves genuine cycling at high confidence margin (cadence 0)", () => {
		// A real cycling segment: zero cadence, cycling HR, cycling speed.
		// High confidence margin must NOT trigger a cadence-veto here.
		const r = correctModeBySignature(
			{ mode: "cycling", confidenceMargin: 11.0, obsHr: 130, obsCadence: 0, obsSpeed: 18 },
			USER_STATS,
		);
		expect(r.changed).toBe(false);
		expect(r.mode).toBe("cycling");
	});
});

describe("correctModeBySignature speed-compatibility gate", () => {
	// The LL-based re-classification was picking 'cycling' as the best
	// alternative for a train segment at 80+ km/h. Reason: cycling's
	// per-user cadenceStd was wider than train's, so when the observation
	// had a non-zero cadence (vehicle vibration), cycling's log-likelihood
	// was less catastrophic than train's. The gate is "you cannot flip
	// into a mode whose speed signature is biomechanically incompatible
	// with the observed speed."

	it("does not flip a train segment at 80 km/h to cycling via LL", () => {
		// Borderline-ambiguous classifier output: confidence margin 1.3,
		// well inside the RELABEL_MAX_MARGIN=3 window. LL would normally
		// pick cycling here purely on cadence-std numerics; the speed gate
		// must block it.
		const r = correctModeBySignature(
			{ mode: "train", confidenceMargin: 1.3, obsHr: 80, obsCadence: 50, obsSpeed: 81 },
			USER_STATS,
		);
		expect(r.mode).not.toBe("cycling");
	});

	it("does not flip a driving segment at 100 km/h to walking via LL", () => {
		const r = correctModeBySignature(
			{ mode: "driving", confidenceMargin: 1.5, obsHr: 80, obsCadence: 0, obsSpeed: 100 },
			USER_STATS,
		);
		expect(r.mode).not.toBe("walking");
	});

	it("still allows flips among compatible alternatives at low speeds", () => {
		// A 6 km/h segment labelled cycling with cadence/HR consistent with
		// walking. Walking is speed-compatible at 6 km/h, so the flip is
		// allowed (this is the existing phantom-cycling correction).
		const r = correctModeBySignature(
			{ mode: "cycling", confidenceMargin: 1.5, obsHr: 100, obsCadence: 95, obsSpeed: 6 },
			USER_STATS,
		);
		expect(r.changed).toBe(true);
		expect(r.mode).toBe("walking");
	});
});

describe("correctModeBySignature", () => {
	// The bug we're fixing: a walking segment got classified as
	// "driving 6.3 km/h". HR ~110, cadence ~100, speed ~6. Under
	// driving's signature this fits terribly (HR way too high, speed
	// way too low). Under walking it fits well.

	it("fixes walking-mislabeled-as-driving (HR + cadence dispositive)", () => {
		const r = correctModeBySignature(
			{ mode: "driving", confidenceMargin: 1.2, obsHr: 110, obsCadence: 100, obsSpeed: 6 },
			USER_STATS,
		);
		expect(r.mode).toBe("walking");
		expect(r.changed).toBe(true);
	});

	it("never flips a segment INTO cycling, even when cycling fits best", () => {
		// 18 km/h, no steps, HR 130 looks bicycle-shaped — but the user
		// cycles only rarely and the mined cycling signature is bogus, so
		// the re-classifier must never pick cycling as a target. Genuine
		// cycling is preserved by gateCycling on positive evidence, not by
		// a signature flip.
		const r = correctModeBySignature(
			{ mode: "driving", confidenceMargin: 1.5, obsHr: 130, obsCadence: 0, obsSpeed: 18 },
			USER_STATS,
		);
		expect(r.mode).not.toBe("cycling");
	});

	it("leaves a clear driving segment alone (high speed, low HR, no steps)", () => {
		const r = correctModeBySignature(
			{ mode: "driving", confidenceMargin: 5, obsHr: 75, obsCadence: 0, obsSpeed: 60 },
			USER_STATS,
		);
		expect(r.mode).toBe("driving");
		expect(r.changed).toBe(false);
	});

	it("does NOT relabel when original confidence is high (margin > 3)", () => {
		// High-margin classifications are trusted even when biometrics look
		// a little off — could be a stressed driver (HR 110 in traffic).
		const r = correctModeBySignature(
			{ mode: "driving", confidenceMargin: 4, obsHr: 110, obsCadence: 0, obsSpeed: 30 },
			USER_STATS,
		);
		expect(r.mode).toBe("driving");
		expect(r.changed).toBe(false);
	});

	it("does NOT relabel when biometrics are completely missing", () => {
		const r = correctModeBySignature(
			{ mode: "driving", confidenceMargin: 1, obsHr: null, obsCadence: null, obsSpeed: 25 },
			USER_STATS,
		);
		// Speed alone is too weak a signal to override.
		expect(r.changed).toBe(false);
	});

	it("does NOT relabel when the new mode is only marginally better", () => {
		// A small log-likelihood gap shouldn't flip the label. Only big
		// differences (>= LL_THRESHOLD) trigger a correction.
		const r = correctModeBySignature(
			{ mode: "walking", confidenceMargin: 1.2, obsHr: 100, obsCadence: 100, obsSpeed: 4.5 },
			USER_STATS,
		);
		// Slight HR deviation but everything still walking-like.
		expect(r.mode).toBe("walking");
		expect(r.changed).toBe(false);
	});

	it("returns no change when modeStats are empty (cold-start user)", () => {
		const r = correctModeBySignature(
			{ mode: "driving", confidenceMargin: 1, obsHr: 110, obsCadence: 100, obsSpeed: 5 },
			[],
		);
		expect(r.mode).toBe("driving");
		expect(r.changed).toBe(false);
	});

	it("returns no change when current mode is stationary (stays not corrected)", () => {
		// Stationary segments are detected by clustering, not by mode score.
		// Biometric correction doesn't apply.
		const r = correctModeBySignature(
			{ mode: "stationary", confidenceMargin: 100, obsHr: 75, obsCadence: 0, obsSpeed: 0.3 },
			USER_STATS,
		);
		expect(r.changed).toBe(false);
	});

	it("vetoes cycling with implausibly low HR even when confidence margin is high", () => {
		// Phantom-cycling case: classifier scored cycling high (margin
		// ~11) because the segment hugged a cycleway in OSM. But HR was
		// 80-90 across the whole window — well below the user's cycling
		// signature (107 ± 6). The log-likelihood-based correction
		// wouldn't fire because margin >= RELABEL_MAX_MARGIN. The HR
		// veto fires regardless.
		const r = correctModeBySignature(
			{ mode: "cycling", confidenceMargin: 11, obsHr: 85, obsCadence: 5, obsSpeed: 6 },
			USER_STATS,
		);
		expect(r.changed).toBe(true);
		expect(r.mode).not.toBe("cycling");
	});

	it("does NOT veto cycling when HR is plausibly in the cycling band", () => {
		// Cycling stats: 107 ± 6. HR = 110 is well inside the
		// distribution → no veto, no relabel.
		const r = correctModeBySignature(
			{ mode: "cycling", confidenceMargin: 11, obsHr: 110, obsCadence: 0, obsSpeed: 18 },
			USER_STATS,
		);
		expect(r.changed).toBe(false);
		expect(r.mode).toBe("cycling");
	});

	// Sit-mode pairs (driving / train / plane) are biometrically
	// indistinguishable — same low HR, same zero cadence. Only speed
	// differs, and speed is what the GPS classifier + refineMode already
	// used (with OSM road/rail data). Letting biometric correction flip
	// between them adds noise on top of the genuine signal. Real bug:
	// motorway driving at 94 km/h got flipped to train because the user's
	// driving stats are dominated by 52 km/h city driving, making 94 km/h
	// look more train-like by speed alone.

	it("does NOT flip driving to train on a fast motorway stretch", () => {
		// 94 km/h on a motorway: clearly driving but speed is closer to
		// the train signature's mean. Biometric correction must not flip.
		const r = correctModeBySignature(
			{ mode: "driving", confidenceMargin: 1.5, obsHr: 75, obsCadence: 0, obsSpeed: 94 },
			USER_STATS,
		);
		expect(r.mode).toBe("driving");
		expect(r.changed).toBe(false);
	});

	it("does NOT flip train to driving on a slow stretch", () => {
		// 60 km/h on a train: could be a slowdown approaching a station,
		// or a regional service. Speed is closer to driving signature but
		// biometrics can't tell driving from train. Keep as classified.
		const r = correctModeBySignature(
			{ mode: "train", confidenceMargin: 1.5, obsHr: 75, obsCadence: 0, obsSpeed: 60 },
			USER_STATS,
		);
		expect(r.mode).toBe("train");
		expect(r.changed).toBe(false);
	});

	it("does NOT flip plane to train or driving on a slow descent", () => {
		// Plane on final approach at 350 km/h: speed below typical plane
		// cruise (850) but well above train (119) and driving (52). The
		// biometrics (low HR, no cadence) match all three sit-modes
		// equally. Don't flip.
		const r = correctModeBySignature(
			{ mode: "plane", confidenceMargin: 1.5, obsHr: 75, obsCadence: 0, obsSpeed: 350 },
			USER_STATS,
		);
		expect(r.mode).toBe("plane");
		expect(r.changed).toBe(false);
	});

	it("STILL flips driving to walking when biometrics genuinely disagree", () => {
		// Re-verify that legitimate cross-class corrections still work.
		// Walking and driving are biometrically distinguishable (cadence
		// + HR), so this flip should fire — regression check.
		const r = correctModeBySignature(
			{ mode: "driving", confidenceMargin: 1.2, obsHr: 110, obsCadence: 100, obsSpeed: 6 },
			USER_STATS,
		);
		expect(r.mode).toBe("walking");
		expect(r.changed).toBe(true);
	});
});

describe("gateCycling", () => {
	// The user cycles only rarely; the classifier over-produces cycling.
	// A "cycling" segment is kept only with genuine evidence — cycle-band
	// speed AND no walking step cadence (pedalling does not register a
	// sustained step rhythm). Otherwise it is demoted.

	it("keeps a segment with genuine cycling evidence", () => {
		// ~18 km/h with near-zero cadence — a real bicycle ride. This is
		// the true-positive the gate must not over-correct.
		const r = gateCycling({ mode: "cycling", obsCadence: 2, obsSpeed: 18 });
		expect(r.changed).toBe(false);
		expect(r.mode).toBe("cycling");
	});

	it("keeps genuine cycling when no cadence data is available", () => {
		const r = gateCycling({ mode: "cycling", obsCadence: null, obsSpeed: 20 });
		expect(r.changed).toBe(false);
		expect(r.mode).toBe("cycling");
	});

	it("demotes a slow 'cycling' segment to walking", () => {
		// 3.6 km/h with real step cadence — a walk the biometric
		// re-classifier wrongly flipped to cycling.
		const r = gateCycling({ mode: "cycling", obsCadence: 33, obsSpeed: 3.6 });
		expect(r.changed).toBe(true);
		expect(r.mode).toBe("walking");
	});

	it("demotes 'cycling' with walking cadence to walking, even at cycle speed", () => {
		// 14 km/h but 90 steps/min — the step counter says on foot.
		const r = gateCycling({ mode: "cycling", obsCadence: 90, obsSpeed: 14 });
		expect(r.changed).toBe(true);
		expect(r.mode).toBe("walking");
	});

	it("demotes too-fast 'cycling' to driving", () => {
		const r = gateCycling({ mode: "cycling", obsCadence: 0, obsSpeed: 55 });
		expect(r.changed).toBe(true);
		expect(r.mode).toBe("driving");
	});

	it("leaves non-cycling segments untouched", () => {
		const r = gateCycling({ mode: "walking", obsCadence: 110, obsSpeed: 5 });
		expect(r.changed).toBe(false);
		expect(r.mode).toBe("walking");
	});
});
