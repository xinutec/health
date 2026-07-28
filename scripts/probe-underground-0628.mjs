#!/usr/bin/env node
// Why does the 06-28 return ride not reconstruct into its two real legs?
//
// Replays the day's captured inputs and walks the underground reconstruction's
// own decision path over the return window: which fixes are coarse, which good
// fixes bracket the dark run, what the mid-run interchange clusters are, and
// what each half resolves to. Read-only — no DB, no network.
//
// Usage: nix develop . --command node scripts/probe-underground-0628.mjs [date]
import { readFileSync } from "node:fs";
import { inputsFromFixture, parseCapturedDay } from "../dist/cli/fixture-day.js";
import {
	COARSE_ACCURACY_M,
	reconstructUndergroundJourney,
	reconstructUndergroundRun,
	UNDERGROUND_LINES_RADIUS_M,
	UNDERGROUND_STATION_RADIUS_M,
} from "../dist/geo/underground-rail.js";

const date = process.argv[2] ?? "2026-06-28";
const t = (ts) => new Date(ts * 1000).toISOString().slice(11, 19);

const captured = parseCapturedDay(readFileSync(`tests/golden/days/${date}-pippijn.json`, "utf8"));
const inputs = inputsFromFixture(captured);
const osm = inputs.osm;

const stations = (lat, lon) => osm.nearbyStations(lat, lon, UNDERGROUND_STATION_RADIUS_M);
const lines = (lat, lon) => osm.linesAtPoint(lat, lon, UNDERGROUND_LINES_RADIUS_M);
const served = (line) => osm.stationsOnLine(line);

// The return, roughly 10:35–11:10Z.
const from = Date.parse(`${date}T10:35:00Z`) / 1000;
const to = Date.parse(`${date}T11:10:00Z`) / 1000;
const fixes = inputs.phonetrack.today.filter((p) => p.ts >= from && p.ts <= to);
const isCoarse = (f) => f.accuracy != null && f.accuracy >= COARSE_ACCURACY_M;

const coarse = fixes.filter(isCoarse);
const good = fixes.filter((f) => !isCoarse(f));
console.log(`${fixes.length} fixes, ${coarse.length} coarse, ${good.length} good`);
console.log(`coarse span ${t(coarse[0].ts)} … ${t(coarse.at(-1).ts)}`);

const boarding = [...good].reverse().find((f) => f.ts <= coarse[0].ts);
const alighting = good.find((f) => f.ts >= coarse.at(-1).ts);
console.log(`boarding fix ${t(boarding.ts)}  alighting fix ${t(alighting.ts)}`);
const bs = await stations(boarding.lat, boarding.lon);
const as = await stations(alighting.lat, alighting.lon);
console.log(`  board stations: ${bs.map((s) => s.name).join(", ")}`);
console.log(`  alight stations: ${as.map((s) => s.name).join(", ")}`);

const single = await reconstructUndergroundRun(coarse, boarding, alighting, stations, lines, served);
console.log(`single through-line: ${single ? `${single.boardingStation} → ${single.alightingStation} · ${single.line}` : "none"}`);

const mid = good.filter((f) => f.ts > coarse[0].ts && f.ts < coarse.at(-1).ts);
console.log(`mid-run good fixes: ${mid.length}`);
for (const f of mid) console.log(`   ${t(f.ts)} acc=${f.accuracy} ${(await stations(f.lat, f.lon)).map((s) => s.name)[0] ?? "-"}`);

const legs = await reconstructUndergroundJourney(coarse, mid, boarding, alighting, stations, lines, served);
console.log(`journey legs: ${legs.length}`);
for (const l of legs) console.log(`   ${l.boardingStation} → ${l.alightingStation} · ${l.line}  ${t(l.startTs)}-${t(l.endTs)}`);
