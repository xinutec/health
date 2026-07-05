/**
 * mode-coherence factor.
 *
 * Scores the compatibility of a candidate's `mode` with its
 * `waySubtype` (the OSM tag value the candidate is attached to).
 *
 * Why a separate factor (not just inside osm-distance):
 *
 *   - osm-distance favours the closest way regardless of class.
 *     In urban areas a footway is frequently 5-10m closer than the
 *     real road, so on its own it would label fast driving as
 *     "near footway." The cascade-era rule for this was
 *     `pickBestHighway`; this factor is the scoring-era version.
 *   - Likewise a "train" candidate attached to a primary road
 *     should be penalised, regardless of distance.
 *
 * The score values are deliberately bounded log-likelihood-shaped
 * (±0.5 to ±3 nats). The magnitudes were chosen so the canonical
 * failure cases tested in `mode-coherence.test.ts` resolve
 * correctly when paired with `osm-distance` at urban-GPS distances.
 * Recalibration against fixture days is a Phase 2 / Phase 3 task.
 */

import type { Factor } from "./types.js";

const PEDESTRIAN_HIGHWAY = new Set(["footway", "path", "pedestrian", "cycleway", "bridleway", "steps"]);
const DRIVEABLE_HIGHWAY = new Set([
	"motorway",
	"trunk",
	"primary",
	"secondary",
	"tertiary",
	"residential",
	"service",
	"unclassified",
	"track",
	"living_street",
]);
const MAJOR_HIGHWAY = new Set(["motorway", "trunk", "primary", "secondary"]);
const RAIL_SUBTYPES = new Set(["rail", "subway", "light_rail", "tram", "monorail", "narrow_gauge"]);
const WATERWAY_NAVIGABLE = new Set(["river", "canal", "fairway"]);
const AEROWAY = new Set(["runway", "taxiway", "aerodrome", "terminal"]);

type Rule = (subtype: string) => number | null;

const RULES_BY_MODE: Record<string, Rule> = {
	driving: (s) => {
		if (PEDESTRIAN_HIGHWAY.has(s)) return -1.5;
		if (MAJOR_HIGHWAY.has(s)) return 1.0;
		if (DRIVEABLE_HIGHWAY.has(s)) return 0.3;
		return null;
	},
	walking: (s) => {
		if (PEDESTRIAN_HIGHWAY.has(s)) return 1.0;
		if (MAJOR_HIGHWAY.has(s)) return -1.5;
		if (DRIVEABLE_HIGHWAY.has(s)) return 0.0;
		return null;
	},
	cycling: (s) => {
		if (s === "cycleway") return 1.5;
		if (PEDESTRIAN_HIGHWAY.has(s)) return -0.5;
		if (s === "motorway" || s === "trunk") return -2.0;
		if (DRIVEABLE_HIGHWAY.has(s)) return 0.0;
		return null;
	},
	train: (s) => {
		if (RAIL_SUBTYPES.has(s)) return 1.5;
		// Anything else is wrong for a train.
		return -3.0;
	},
	plane: (s) => {
		if (AEROWAY.has(s)) return 1.5;
		return -3.0;
	},
	stationary: () => null, // mode-coherence doesn't differentiate stationary by way subtype
};

export const modeCoherence: Factor = (candidate, _ctx) => {
	const subtype = candidate.waySubtype;
	if (!subtype) return null;
	const rule = RULES_BY_MODE[candidate.mode];
	if (!rule) return { name: "mode-coherence", score: 0, rationale: `no rule for ${candidate.mode}` };
	const score = rule(subtype);
	// Boat-on-waterway is the one case we want to bonus across modes —
	// handled as a small additive bonus on top of any per-mode rule
	// outcome. (Not part of a candidate mode today; reserved for when
	// a "boat" mode is added.)
	if (score === null) {
		return {
			name: "mode-coherence",
			score: 0,
			rationale: `unknown way subtype "${subtype}" for ${candidate.mode}`,
		};
	}
	// Unused but referenced — keep the lint quiet.
	void WATERWAY_NAVIGABLE;
	return {
		name: "mode-coherence",
		score,
		rationale: rationaleFor(candidate.mode, subtype, score),
	};
};

function rationaleFor(mode: string, subtype: string, score: number): string {
	if (score >= 0.5) return `${mode} fits ${subtype} (canonical)`;
	if (score > 0) return `${mode} compatible with ${subtype}`;
	if (score === 0) return `${mode} neutral on ${subtype}`;
	if (score > -1.5) return `${mode} unlikely on ${subtype}`;
	return `${mode} incompatible with ${subtype}`;
}
