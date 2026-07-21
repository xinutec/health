/**
 * CLI: render the float (TS) vs quant (Lean) walk-matcher output for the legs
 * where they differ — the visual "are they the same, or is Lean better?" for
 * the matcher flip (`LEAN_MATCH`).
 *
 * The `compare-match --gate` corpus run pins the divergence set: the legs in
 * `src/lean/accepted-match-deltas.ts`. Since quant↔Lean is bit-exact, the quant
 * arm IS what Lean serves, so float-vs-quant is exactly float-vs-Lean. This tool
 * replays each such golden day, recomputes both arms on the identical
 * leg-windowed input, and draws them overlaid: OSM ways (context), building
 * footprints, the raw GPS fixes, the TS/float route, and the Lean/quant route.
 *
 * Output is a single self-contained HTML file (inline SVG, no external assets) —
 * it carries real coordinates, so it is written to a local path and never
 * published. Route-choice flips (coarse DIFF) are shown first and badged; the
 * display near-ties follow.
 *
 * Usage: node dist/cli/render-match-compare.js [outfile.html]
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import type { BuildingRing, RoadFix } from "../geo/map-match-core.js";
import { type QWalkMatchResult, type QWay, qMatchWalkSegment } from "../geo/match-twin.js";
import { matchWalkSegment, type WalkMatchResult } from "../geo/pedestrian-match.js";
import { type QPt, quantPt } from "../geo/quant-twin.js";
import type { OsmRoadWay } from "../geo/road-match.js";
import { computeVelocityFromInputs } from "../geo/velocity.js";
import {
	extractWalkLegs,
	flattenBuildings,
	flattenWalkable,
	type WalkEpisode,
	type WalkLegInput,
} from "../geo/walk-shadow-core.js";
import { ACCEPTED_MATCH_DELTAS } from "../lean/accepted-match-deltas.js";
import { inputsFromFixture, parseCapturedDay } from "./fixture-day.js";

interface LatLon {
	lat: number;
	lon: number;
}

const outfile = process.argv[2] ?? "match-compare.html";

/** (date, hh:mm) → the manifest entry, so a replayed leg is matched to its
 *  signed-off delta and captioned with the reason. */
const wanted = new Map(ACCEPTED_MATCH_DELTAS.map((d) => [`${d.date}|${d.hhmm}`, d]));
const days = [...new Set(ACCEPTED_MATCH_DELTAS.map((d) => d.date))].sort();
const goldenFiles = readdirSync("tests/golden/days").filter((f) => f.endsWith(".json"));
const fileForDate = (date: string): string => {
	const f = goldenFiles.find((g) => g.startsWith(date));
	if (f === undefined) throw new Error(`no golden fixture for ${date}`);
	return f;
};

const deqQ = (p: QPt): LatLon => ({ lat: Number(p.la) / 1e7, lon: Number(p.lo) / 1e7 });

/** Both matcher arms on one leg's identical quantised input (skips the Lean
 *  spawn — quant IS what Lean serves, bit-exact). */
function arms(leg: WalkLegInput): { float: WalkMatchResult | null; quant: QWalkMatchResult | null } {
	const float = matchWalkSegment(leg.clean, { ways: leg.ways, buildings: leg.buildings });
	const qFixes = leg.clean.map((p) => quantPt(p));
	const qWays: QWay[] = leg.ways.map((w) => ({
		coords: w.coords.map(([lat, lon]) => quantPt({ lat, lon })),
		name: w.name,
	}));
	const qBuildings = leg.buildings.map((r) => r.map((p) => quantPt(p)));
	return { float, quant: qMatchWalkSegment(qFixes, qWays, qBuildings) };
}

interface RenderedLeg {
	date: string;
	hhmm: string;
	coarse: string;
	path: string;
	note: string;
	reason: string;
	routeFlip: boolean;
	fixes: readonly RoadFix[];
	ways: readonly OsmRoadWay[];
	buildings: readonly BuildingRing[];
	floatPath: LatLon[];
	quantPath: LatLon[];
}

const rendered: RenderedLeg[] = [];

for (const date of days) {
	const captured = parseCapturedDay(readFileSync(`tests/golden/days/${fileForDate(date)}`, "utf8"));
	const inputs = inputsFromFixture(captured);
	const run = await computeVelocityFromInputs(inputs, { walkMatch: true });
	const legInputs = extractWalkLegs(
		run.episodes as WalkEpisode[],
		inputs.phonetrack.today,
		flattenWalkable(captured.inputs.osmTrace),
		flattenBuildings(captured.inputs.osmTrace),
	);
	for (const leg of legInputs) {
		const hhmm = new Date(leg.startTs * 1000).toISOString().slice(11, 16);
		const entry = wanted.get(`${date}|${hhmm}`);
		if (entry === undefined) continue;
		const { float, quant } = arms(leg);
		rendered.push({
			date,
			hhmm,
			coarse: entry.coarse,
			path: entry.path,
			note: entry.note,
			reason: entry.reason,
			routeFlip: entry.coarse === "DIFF",
			fixes: leg.clean,
			ways: leg.ways,
			buildings: leg.buildings,
			floatPath: float ? float.path.map((p) => ({ lat: p.lat, lon: p.lon })) : [],
			quantPath: quant ? quant.path.map(deqQ) : [],
		});
	}
}

// Route-choice flips first (the visible ones), then display near-ties.
rendered.sort((a, b) => Number(b.routeFlip) - Number(a.routeFlip) || a.date.localeCompare(b.date));

// ── SVG rendering ────────────────────────────────────────────────────────────
const W = 460;
const H = 340;
const PAD = 16;

function svgFor(leg: RenderedLeg): string {
	// bbox over the decision-relevant geometry (fixes + both routes).
	const all: LatLon[] = [...leg.fixes, ...leg.floatPath, ...leg.quantPath];
	if (all.length === 0) return `<svg viewBox="0 0 ${W} ${H}"></svg>`;
	let minLat = all[0].lat;
	let maxLat = all[0].lat;
	let minLon = all[0].lon;
	let maxLon = all[0].lon;
	for (const p of all) {
		minLat = Math.min(minLat, p.lat);
		maxLat = Math.max(maxLat, p.lat);
		minLon = Math.min(minLon, p.lon);
		maxLon = Math.max(maxLon, p.lon);
	}
	const midLat = (minLat + maxLat) / 2;
	const cosLat = Math.cos((midLat * Math.PI) / 180);
	const spanLon = (maxLon - minLon) * cosLat || 1e-9;
	const spanLat = maxLat - minLat || 1e-9;
	const scale = Math.min((W - 2 * PAD) / spanLon, (H - 2 * PAD) / spanLat);
	const ox = PAD + (W - 2 * PAD - spanLon * scale) / 2;
	const oy = PAD + (H - 2 * PAD - spanLat * scale) / 2;
	// Round to 0.1px — plenty for a thumbnail, and keeps the file small.
	const proj = (p: LatLon): [number, number] => [
		Math.round((ox + (p.lon - minLon) * cosLat * scale) * 10) / 10,
		Math.round((oy + (maxLat - p.lat) * scale) * 10) / 10,
	];
	const poly = (pts: readonly LatLon[]): string => pts.map((p) => proj(p).join(",")).join(" ");
	// A vertex is worth drawing only if it lands inside the (padded) viewBox;
	// the leg-windowed ways/buildings extend far beyond the decision bbox.
	const inView = (p: LatLon): boolean => {
		const [x, y] = proj(p);
		return x >= -20 && x <= W + 20 && y >= -20 && y <= H + 20;
	};

	const wayLines = leg.ways
		.filter((w) => w.coords.some(([lat, lon]) => inView({ lat, lon })))
		.map((w) => `<polyline points="${poly(w.coords.map(([lat, lon]) => ({ lat, lon })))}" class="way"/>`)
		.join("");
	const buildingRings = leg.buildings
		.filter((r) => r.some((p) => inView(p)))
		.map((r) => `<polygon points="${poly(r)}" class="bldg"/>`)
		.join("");
	const fixDots = leg.fixes
		.map((f) => {
			const [x, y] = proj(f);
			return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2" class="fix"/>`;
		})
		.join("");
	const floatLine = `<polyline points="${poly(leg.floatPath)}" class="ts"/>`;
	const quantLine = `<polyline points="${poly(leg.quantPath)}" class="lean"/>`;

	return `<svg viewBox="0 0 ${W} ${H}" role="img">${buildingRings}${wayLines}${fixDots}${floatLine}${quantLine}</svg>`;
}

const cards = rendered
	.map((leg) => {
		const badge = leg.routeFlip
			? `<span class="badge flip">route flip</span>`
			: `<span class="badge tie">near-tie</span>`;
		return `<figure class="card${leg.routeFlip ? " big" : ""}">
  <figcaption>
    <div class="head"><span class="when">${leg.date} ${leg.hhmm}</span>${badge}</div>
    <div class="sig">coarse=${leg.coarse} / path=${leg.path} · ${leg.note}</div>
    <div class="reason">${leg.reason}</div>
  </figcaption>
  ${svgFor(leg)}
</figure>`;
	})
	.join("\n");

const flips = rendered.filter((l) => l.routeFlip).length;
const html = `<h1>Walk matcher — TS (float) vs Lean (quant)</h1>
<p class="lede">The ${rendered.length} golden legs where serving the verified Lean matcher differs from the TS float matcher
(quant↔Lean is bit-exact, so quant = what Lean serves). ${flips} are route-choice flips; the rest are display
near-ties. <strong class="ts-k">TS route</strong> vs <strong class="lean-k">Lean route</strong>; grey = raw GPS fixes,
faint lines = OSM ways, faint fills = buildings.</p>
<div class="grid">
${cards}
</div>
<style>
  :root { --ts:#2563eb; --lean:#ea7317; --ink:#1a1a1a; --muted:#6b7280; --line:#e5e7eb; --bg:#ffffff; }
  @media (prefers-color-scheme: dark){ :root{ --ink:#e8e8ea; --muted:#9aa0aa; --line:#2a2d34; --bg:#141518; } }
  :root[data-theme=dark]{ --ink:#e8e8ea; --muted:#9aa0aa; --line:#2a2d34; --bg:#141518; }
  :root[data-theme=light]{ --ink:#1a1a1a; --muted:#6b7280; --line:#e5e7eb; --bg:#ffffff; }
  body{ margin:0; padding:28px 32px 48px; background:var(--bg); color:var(--ink);
        font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
  h1{ font-size:22px; font-weight:650; margin:0 0 8px; letter-spacing:-.01em; }
  .lede{ max-width:70ch; color:var(--muted); margin:0 0 24px; }
  .ts-k{ color:var(--ts); } .lean-k{ color:var(--lean); }
  .grid{ display:grid; grid-template-columns:repeat(auto-fill,minmax(300px,1fr)); gap:18px; }
  .card{ border:1px solid var(--line); border-radius:10px; padding:12px; background:var(--bg); }
  .card.big{ grid-column:span 2; }
  @media (max-width:720px){ .card.big{ grid-column:span 1; } }
  figcaption{ margin-bottom:8px; }
  .head{ display:flex; align-items:center; gap:8px; justify-content:space-between; }
  .when{ font-weight:600; font-variant-numeric:tabular-nums; }
  .badge{ font-size:11px; font-weight:600; padding:2px 8px; border-radius:999px; }
  .badge.flip{ background:color-mix(in srgb,var(--lean) 18%,transparent); color:var(--lean); }
  .badge.tie{ background:color-mix(in srgb,var(--muted) 16%,transparent); color:var(--muted); }
  .sig{ font-size:12px; color:var(--muted); font-variant-numeric:tabular-nums; margin-top:4px; }
  .reason{ font-size:12px; color:var(--muted); margin-top:6px; }
  svg{ width:100%; height:auto; display:block; margin-top:10px; border-radius:6px;
       background:color-mix(in srgb,var(--muted) 6%,transparent); }
  .way{ fill:none; stroke:var(--muted); stroke-width:1; opacity:.35; }
  .bldg{ fill:var(--muted); opacity:.10; stroke:var(--muted); stroke-opacity:.25; stroke-width:.5; }
  .fix{ fill:var(--muted); opacity:.7; }
  .ts{ fill:none; stroke:var(--ts); stroke-width:2.4; stroke-linejoin:round; stroke-linecap:round; opacity:.9; }
  .lean{ fill:none; stroke:var(--lean); stroke-width:2.4; stroke-linejoin:round; stroke-linecap:round;
         opacity:.9; stroke-dasharray:1 5; }
</style>`;

writeFileSync(outfile, html);
console.log(`wrote ${outfile}: ${rendered.length} legs (${flips} route flips, ${rendered.length - flips} near-ties)`);
