#!/usr/bin/env -S npx tsx
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const BC = await import(path.join(repo, "src/geo/biometric-coherence.ts"));

type Hr = { ts: number; bpm: number };
type St = { ts: number; steps: number };
const cases: [string, { startTs: number; endTs: number; hr: Hr[]; steps: St[] }][] = [
	["sittingRest", { startTs: 0, endTs: 3600, hr: [{ ts: 60, bpm: 68 }, { ts: 120, bpm: 70 }], steps: [{ ts: 60, steps: 0 }] }],
	["walking", { startTs: 0, endTs: 600, hr: [{ ts: 60, bpm: 95 }], steps: [{ ts: 60, steps: 90 }, { ts: 120, steps: 90 }, { ts: 180, steps: 90 }, { ts: 240, steps: 90 }, { ts: 300, steps: 90 }] }],
	["noData", { startTs: 0, endTs: 3600, hr: [], steps: [] }],
	["mild30spm", { startTs: 0, endTs: 600, hr: [{ ts: 60, bpm: 70 }], steps: Array.from({ length: 10 }, (_, i) => ({ ts: 60 * (i + 1), steps: 30 })) }],
];
for (const [name, input] of cases) console.log(`${name}: ${BC.biometricCoherence(input)}`);
