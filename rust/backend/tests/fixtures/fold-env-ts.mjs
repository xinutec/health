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
const GOLD = new URL("../../../../tests/golden/days/", import.meta.url).pathname;
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
    // Real tzAt entries from the capture, truncated; bestPlace stays empty
    // because the Rust encoder does not build it yet (see fold_payload.rs).
    tzAt: (c.tzAt ?? []).slice(0, 6).map((q) => ({ ...q, lat: shift(q.lat), lon: shift(q.lon) })),
    bestPlace: [], sleepPlace: [],
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
  // knownPlaces come from the golden FIXTURE, not the capture: buildDayRequest
  // reads them off `inputs`, and six env fields are different views of them.
  const fx = JSON.parse(readFileSync(`${GOLD}/${f}`, "utf8"));
  const places = (fx.inputs.knownPlaces ?? []).slice(0, 8).map((p) => ({
    ...p, centroidLat: shift(p.centroidLat), centroidLon: shift(p.centroidLon),
    displayName: p.displayName == null ? p.displayName : `place-${p.id % 7}`,
    amenityLabel: p.amenityLabel == null ? p.amenityLabel : `amenity-${p.id % 5}`,
  }));
  // The caches come from the fixture too, truncated. Coordinates are shifted
  // like everything else; route names are real OSM line names (public data, but
  // they localise the user, so they are replaced).
  const stopsOf = (ss) => (ss ?? []).slice(0, 4).map((x, j) => ({
    ...x, name: x.name == null ? x.name : `stop-${j}`, lat: shift(x.lat), lon: shift(x.lon) }));
  const railRouteCache = (fx.inputs.railRouteCache ?? []).slice(0, 3).map((r, j) => ({
    routeKey: `route-${j}`,
    geometryJson: JSON.stringify(JSON.parse(r.geometryJson).slice(0, 4)
      .map((q) => ({ lat: shift(q.lat), lon: shift(q.lon) }))) }));
  const busRouteCache = (fx.inputs.busRouteCache ?? []).slice(0, 3).map((b, j) => ({
    ...b, routeRef: `bus-${j}`, routeName: b.routeName == null ? b.routeName : `busname-${j}`,
    stops: stopsOf(b.stops) }));
  const railStopsCache = (fx.inputs.railStopsCache ?? []).slice(0, 3).map((r, j) => ({
    ...r, lineRef: r.lineRef == null ? r.lineRef : `line-${j}`,
    lineName: r.lineName == null ? r.lineName : `linename-${j}`, stops: stopsOf(r.stops) }));
  const hsmmDecode = (fx.inputs.hsmmDecode ?? []).slice(0, 6).map((h, j) => ({
    ...h, lineName: h.lineName == null ? h.lineName : `hline-${j}` }));

  const inputs = { homeTz: "UTC", knownPlaces: places, venuePriors: null,
                   hsmmDecode, busRouteCache, railRouteCache, railStopsCache };
  // A real recorded trace, truncated. The keys are "lat|lon[|radius]" decimals;
  // they are NOT shifted, because the key IS the question and a shifted key
  // would test a different lookup than the one recorded. They are dropped to
  // the first few entries per section instead, and the ANSWERS are scrubbed.
  const take = (o, n) => Object.fromEntries(Object.entries(o ?? {}).slice(0, n));
  const scrubName = (x, j) => (x == null ? x : `name-${j}`);
  const tr = fx.inputs.osmTrace ?? {};
  const trace = {
    nearbyWays: Object.fromEntries(Object.entries(take(tr.nearbyWays, 3)).map(([k, v]) => [k,
      v.slice(0, 3).map((w, j) => ({ ...w, name: scrubName(w.name, j) }))])),
    nearbyStations: Object.fromEntries(Object.entries(take(tr.nearbyStations, 2)).map(([k, v]) => [k,
      v.slice(0, 3).map((x, j) => ({ ...x, name: scrubName(x.name, j) }))])),
    nearbyTransitStops: take(tr.nearbyTransitStops, 2),
    nearbyLandmarks: Object.fromEntries(Object.entries(take(tr.nearbyLandmarks, 2)).map(([k, v]) => [k,
      v.slice(0, 3).map((x, j) => ({ ...x, name: scrubName(x.name, j) }))])),
    linesAtPoint: take(tr.linesAtPoint, 2),
    reverseGeocode: Object.fromEntries(Object.entries(take(tr.reverseGeocode, 2)).map(([k, v]) => [k,
      v == null ? null : { ...v, displayName: "display", address: { ...v.address, road: v.address?.road == null ? v.address?.road : "road" } }])),
    stationsOnLine: Object.fromEntries(Object.entries(take(tr.stationsOnLine, 2)).map(([k, v]) => [k,
      v.slice(0, 3).map((x, j) => ({ ...x, name: scrubName(x.name, j) }))])),
  };
  const req = buildDayRequest(cap, inputs, trace);
  cap.knownPlaces = places;
  cap.trace = trace;
  Object.assign(cap, { railRouteCache, busRouteCache, railStopsCache, hsmmDecode });
  const keep = ["lookups", "hmmDecode", "railRouteCache", "busRouteCache", "railStops",
                "stayPlaces", "dwellPlaces", "enrichPlaces", "knownPlaces", "focusPlaceDays", "hsmmPlaces",
                "points", "rawFixes", "displayFixes", "steps", "hr", "sleep", "speedByTs",
                "morningFixes", "prevEveningFixes", "rawSleep", "dayEndTs", "modeStats"];
  const env = {};
  for (const k of keep) env[k] = req.env[k];
  out.push({ day: f.replace(/\.json$/, ""), cap, env });
}
writeFileSync(new URL("./fold-env-ts.json", import.meta.url), JSON.stringify(out, null, 1));
console.error(`${out.length} days`);
