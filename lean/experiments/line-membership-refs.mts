#!/usr/bin/env -S npx tsx
/**
 * Reference-value generator for `src/geo/line-membership.ts`, ported to
 * `Verified/Geo/LineMembership.lean`.
 *
 * Run: npx tsx lean/experiments/line-membership-refs.mts
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const M = await import(path.join(repo, "src/geo/line-membership.ts"));
const R = await import(path.join(repo, "src/geo/passes/rail-runs.ts"));

// What the veto is fed: a mirror that knows three lines and nothing else. The
// North London Line's tracks run PAST Finchley Road to Finchley Road & Frognal
// — a different station — which is the #377 shape this module exists to reject.
const MIRROR: Record<string, string[]> = {
	"Metropolitan Line": ["Wembley Park", "Finchley Road", "Baker Street"],
	"Jubilee Line": ["Wembley Park", " finchley road ", "Neasden"],
	"North London Line": ["Finchley Road & Frognal", "West Hampstead"],
};
const lookup = async (line: string) => (MIRROR[line] ?? []).map((name) => ({ name }));

// Show how each label expands first — the Lean reuses RailRuns.expandTubeLineNames.
for (const label of [
	"Metropolitan Line",
	"Circle, Hammersmith & City and Metropolitan Lines",
	"Metropolitan and Piccadilly Line",
	"Bakerloo",
]) {
	console.log(`expand ${JSON.stringify(label)}:`, JSON.stringify(R.expandTubeLineNames(label)));
}

const cases: [string, string][] = [
	// Served, so no veto.
	["Metropolitan Line", "Finchley Road"],
	// THE #377 SHAPE: the tracks pass, the service does not stop. Veto fires.
	["North London Line", "Finchley Road"],
	// Unknown to the mirror — asserts nothing, so no veto.
	["Victoria Line", "Finchley Road"],
	// Normalisation is trim + lowercase on BOTH sides.
	["Jubilee Line", "FINCHLEY ROAD"],
	["Jubilee Line", "  Finchley Road  "],
	// A compound label names shared track: ONE component serving is enough.
	["Circle, Hammersmith & City and Metropolitan Lines", "Finchley Road"],
	// Compound where every KNOWN component fails to serve.
	["North London and Victoria Lines", "Finchley Road"],
	// Compound where every component is unknown: still no assertion.
	["Victoria and Piccadilly Lines", "Finchley Road"],
	// A station no line in the mirror serves.
	["Metropolitan Line", "Stratford"],
];
for (const [line, station] of cases) {
	console.log(`cannotServe ${JSON.stringify(line)} @ ${JSON.stringify(station)}:`, await M.lineCannotServe(line, station, lookup));
}
