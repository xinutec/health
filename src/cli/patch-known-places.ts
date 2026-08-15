/**
 * Re-label the `knownPlaces` input of every captured golden day from a freshly
 * mined focus-place set, so a mining change can be graded without re-capturing.
 *
 * Only ever point this at a COPY of the corpus — see
 * `scripts/mining-experiment.sh`, which is the supported way to run it. It
 * rewrites fixtures in place, and `tests/golden/` has no remote.
 *
 *   node dist/cli/patch-known-places.js <days-dir> <known-places.json>
 *
 * ONLY `amenityLabel` is taken from the mining. Every other field — id,
 * centroid, radius, visit counts, hour profile — is left exactly as captured,
 * and that is not timidity: a fixture's OSM trace is keyed to the COORDINATES
 * the capture asked about, so substituting mined centroids (which differ in
 * their last decimals) makes the pipeline request reverse-geocodes the capture
 * never made, and all 35 days die as `uncaptured` before grading anything
 * (measured 2026-08-15). Holding the geometry fixed and varying only the label
 * is also the exact ablation a labelling change wants.
 *
 * Rows are matched to mined clusters by `matchClusters` — the same identity
 * rule the miner itself uses to keep `focus_places.id` stable across runs — so
 * this pairs them the way a real re-mine would.
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { type ExistingPlace, matchClusters } from "../geo/focus-places-identity.js";

interface MinedPlace {
	centroidLat: number;
	centroidLon: number;
	amenityLabel: string | null;
}
interface CapturedPlace {
	id: number;
	centroidLat: number;
	centroidLon: number;
	amenityLabel: string | null;
}

const [daysDir, placesPath] = process.argv.slice(2);
if (!daysDir || !placesPath) {
	console.error("usage: patch-known-places.js <days-dir> <known-places.json>");
	process.exit(2);
}

const mined = JSON.parse(await readFile(placesPath, "utf8")) as MinedPlace[];
if (!Array.isArray(mined) || mined.length === 0) {
	console.error(`${placesPath}: expected a non-empty array of known-place rows`);
	process.exit(2);
}

const files = (await readdir(daysDir)).filter((f) => f.endsWith(".json")).sort();
if (files.length === 0) {
	console.error(`${daysDir}: no fixtures`);
	process.exit(2);
}

let patched = 0;
let changed = 0;
let gained = 0;
let lost = 0;
let unmatched = 0;
for (const f of files) {
	const p = path.join(daysDir, f);
	const day = JSON.parse(await readFile(p, "utf8")) as { inputs?: { knownPlaces?: CapturedPlace[] } };
	const captured = day.inputs?.knownPlaces;
	if (captured === undefined) {
		console.error(`${f}: no inputs.knownPlaces — refusing to guess at its shape`);
		process.exit(1);
	}

	// `matchClusters` maps NEW clusters onto existing rows, which is the
	// direction the miner uses it in. `firstSeenTs` only breaks ties between
	// equally-close candidates; a constant is right here because the captured
	// rows carry no such field.
	const existing: ExistingPlace[] = captured.map((c) => ({
		id: c.id,
		centroidLat: c.centroidLat,
		centroidLon: c.centroidLon,
		firstSeenTs: 0,
	}));
	const { matches } = matchClusters(existing, mined);
	const labelById = new Map<number, string | null>();
	for (let i = 0; i < mined.length; i++) {
		const oldId = matches[i].oldId;
		if (oldId !== null) labelById.set(oldId, mined[i].amenityLabel);
	}

	for (const place of captured) {
		if (!labelById.has(place.id)) {
			unmatched++;
			continue;
		}
		const next = labelById.get(place.id) ?? null;
		if (next === place.amenityLabel) continue;
		changed++;
		if (place.amenityLabel === null) gained++;
		else if (next === null) lost++;
		place.amenityLabel = next;
	}
	await writeFile(p, JSON.stringify(day));
	patched++;
}

const perDay = (n: number): string => (n / patched).toFixed(1);
console.log(
	`patched ${patched} fixture(s) — per day: ${perDay(changed)} labels changed ` +
		`(${perDay(gained)} gained, ${perDay(lost)} lost, ${perDay(changed - gained - lost)} renamed), ` +
		`${perDay(unmatched)} captured rows had no mined counterpart and were left alone`,
);
