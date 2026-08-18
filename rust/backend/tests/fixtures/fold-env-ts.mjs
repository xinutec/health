// Generates fold-env-ts.json: the ORACLE for src/fold_payload.rs's
// encode_obs_and_tail / encode_mode_stats, produced by running the real
// buildDayRequest from dist/lean/fold-payload.js.
//
// Regenerate with:
//   FOLD_CAPTURE=/tmp/foldcap nix develop . -c node dist/cli/golden-check.js
//   nix develop . -c node rust/backend/tests/fixtures/fold-env-ts.mjs
//
// ⚠ COMMITTABLE BY CONSTRUCTION. The golden corpus is gitignored because it
// carries real coordinates; every lat/lon here is shifted into [1,2) and the
// series are truncated. What survives is the SHAPE — tuple order, arity, which
// fields are bit-encoded, how an absent accuracy travels — which is all this
// encoder can get wrong.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { buildDayRequest } from "../../../../dist/lean/fold-payload.js";

const CAP = process.env.FOLD_CAPTURE ?? "/tmp/foldcap";
const N = 12; // rows kept per series
const shift = (x) => (typeof x === "number" ? (x % 1) + 1 : x);
const pt = (p) => ({ ...p, lat: shift(p.lat), lon: shift(p.lon) });

const out = [];
for (const f of readdirSync(CAP).sort()) {
  if (!f.endsWith(".json")) continue;
  const c = JSON.parse(readFileSync(`${CAP}/${f}`, "utf8"));
  const cap = {
    segsRaw: [],
    // The answer tables. Empty is fine — this fixture checks the OBSERVATION
    // encoding, and buildDayRequest reads these unconditionally.
    tzAt: [], bestPlace: [], sleepPlace: [],
    modeStats: c.modeStats ?? [],
    obs: {
      points: (c.obs.points ?? []).slice(0, N).map(pt),
      rawFixes: (c.obs.rawFixes ?? []).slice(0, N).map(pt),
      displayFixes: (c.obs.displayFixes ?? []).slice(0, N).map(pt),
      steps: (c.obs.steps ?? []).slice(0, N),
      hr: (c.obs.hr ?? []).slice(0, N),
      sleep: (c.obs.sleep ?? []).slice(0, N),
    },
    tail: {
      morningRaw: (c.tail?.morningRaw ?? []).slice(0, N).map(pt),
      prevEveningRaw: (c.tail?.prevEveningRaw ?? []).slice(0, N).map(pt),
      rawSleep: c.tail?.rawSleep ?? [],
      dayEndTs: c.tail?.dayEndTs ?? 0,
    },
  };
  // The other buildDayRequest arguments only feed env fields this test does not
  // read, so the minimum that satisfies its property accesses is enough.
  // Exactly what buildDayRequest reads off `inputs` and the trace, and nothing
  // more — the fields feed env keys this test does not read, but they must be
  // present or the encoder throws.
  const inputs = { homeTz: "UTC", knownPlaces: [], venuePriors: null, hsmmDecode: null,
                   busRouteCache: [], railRouteCache: [], railStopsCache: [] };
  const trace = { nearbyWays: {}, nearbyStations: {}, nearbyTransitStops: {},
                  nearbyLandmarks: {}, linesAtPoint: {}, reverseGeocode: {}, stationsOnLine: {} };
  const req = buildDayRequest(cap, inputs, trace);
  const keep = ["points", "rawFixes", "displayFixes", "steps", "hr", "sleep", "speedByTs",
                "morningFixes", "prevEveningFixes", "rawSleep", "dayEndTs", "modeStats"];
  const env = {};
  for (const k of keep) env[k] = req.env[k];
  out.push({ day: f.replace(/\.json$/, ""), cap, env });
}
writeFileSync(new URL("./fold-env-ts.json", import.meta.url), JSON.stringify(out, null, 1));
console.error(`${out.length} days`);
