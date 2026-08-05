#!/usr/bin/env -S npx tsx
/**
 * Reference-value generator for `annotateBusRoutes`
 * (`src/geo/bus-route-match.ts`), ported into `Verified/Geo/Bus.lean`.
 *
 * The matcher underneath (`matchBusRoute`, `busRouteLabel`) was ported and
 * pinned earlier; this covers the pass that wraps it — the leg filter, the
 * board/alight/trace extraction out of the day's fixes, and the two fields it
 * writes.
 *
 * Unlike the other passes in this tranche, nothing here is injected: the
 * candidate routes arrive as data (the orchestrator reads `bus_route_cache`),
 * so the pass is already synchronous and reference-testable as it stands.
 *
 * Run: npx tsx lean/experiments/annotate-bus-routes-refs.mts
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

type LatLon = { lat: number; lon: number };
type Fix = { ts: number; lat: number; lon: number };

const S = (name: string, lat: number, lon: number, seq: number) => ({ name, lat, lon, seq });

/** The 38, Green Park → Vauxhall Bridge Road — the same route fixture the
 *  matcher's own guards use. */
const route38 = {
	routeRef: "38",
	routeName: "Victoria - Clapton Pond",
	osmRelationId: 1234,
	stops: [
		S("Green Park", 51.50675, -0.14273, 0),
		S("Hyde Park Corner", 51.50305, -0.15195, 1),
		S("Grosvenor Place", 51.50043, -0.14855, 2),
		S("Wilton Street", 51.49825, -0.14625, 3),
		S("Victoria Station", 51.49607, -0.14413, 4),
		S("Vauxhall Bridge Road", 51.49392, -0.14166, 5),
	],
};

/** Along the route's road, past every intermediate stop — a real bus. */
const onRoute: LatLon[] = [
	{ lat: 51.5067, lon: -0.1428 },
	{ lat: 51.5049, lon: -0.1475 },
	{ lat: 51.5031, lon: -0.1519 },
	{ lat: 51.5016, lon: -0.1501 },
	{ lat: 51.5004, lon: -0.1486 },
	{ lat: 51.4993, lon: -0.1474 },
	{ lat: 51.4982, lon: -0.1463 },
	{ lat: 51.4971, lon: -0.1452 },
	{ lat: 51.4961, lon: -0.1442 },
];

/** The same endpoints down the direct road — a taxi. */
const direct: LatLon[] = [
	{ lat: 51.5067, lon: -0.1428 },
	{ lat: 51.5045, lon: -0.1438 },
	{ lat: 51.5022, lon: -0.1441 },
	{ lat: 51.4998, lon: -0.1442 },
	{ lat: 51.4975, lon: -0.1442 },
	{ lat: 51.4961, lon: -0.1442 },
];

/** Timestamps at a round 100 s apart, so a window edge is easy to name. */
const stamp = (pts: LatLon[]): Fix[] => pts.map((p, i) => ({ ts: 100 + 100 * i, ...p }));

const busFixes = stamp(onRoute);
const taxiFixes = stamp(direct);

const LEG_START = 100;
const LEG_END = 900;

type Seg = {
	startTs: number;
	endTs: number;
	mode: TransportMode;
	refinedMode?: TransportMode;
	vehicleKind?: "bus";
	wayName?: string;
	avgSpeed?: number;
};

const drive = (over: Partial<Seg> = {}): Seg => ({
	startTs: LEG_START,
	endTs: LEG_END,
	mode: "driving",
	...over,
});

const show = (label: string, segs: Seg[], fixes: Fix[], routes: Parameters<typeof M.annotateBusRoutes>[2], opts?: Parameters<typeof M.annotateBusRoutes>[3]) => {
	const out = M.annotateBusRoutes(segs, fixes, routes, opts);
	const cells = out.map((s: Seg) => `${s.vehicleKind ?? "-"}/${s.wayName ?? "-"}`);
	console.log(`${label.padEnd(38)} ${cells.join(" | ")}`);
};

console.log("=== annotateBusRoutes: vehicleKind/wayName per segment ===");

show("matches", [drive()], busFixes, [route38]);
show("no routes loaded", [drive()], busFixes, []);
show("taxi trace", [drive()], taxiFixes, [route38]);

console.log("--- the leg filter reads the EFFECTIVE mode ---");
show("mode driving", [drive()], busFixes, [route38]);
show("refinedMode driving", [drive({ mode: "stationary", refinedMode: "driving" })], busFixes, [route38]);
show("refinedMode train over driving", [drive({ refinedMode: "train" })], busFixes, [route38]);
show("mode walking", [drive({ mode: "walking" })], busFixes, [route38]);
show("mode stationary", [drive({ mode: "stationary" })], busFixes, [route38]);

console.log("--- the window is inclusive at both ends ---");
show("[100,900] all nine", [drive()], busFixes, [route38]);
show("[101,900] drops the board fix", [drive({ startTs: 101 })], busFixes, [route38]);
show("[100,899] drops the alight fix", [drive({ endTs: 899 })], busFixes, [route38]);
show("[100,150] one fix", [drive({ endTs: 150 })], busFixes, [route38]);
show("[901,1000] no fixes", [drive({ startTs: 901, endTs: 1000 })], busFixes, [route38]);
show("[100,200] two fixes", [drive({ endTs: 200 })], busFixes, [route38]);

console.log("--- avgSpeed is the speed evidence ---");
show("avgSpeed absent", [drive()], busFixes, [route38]);
show("avgSpeed 14", [drive({ avgSpeed: 14 })], busFixes, [route38]);
show("avgSpeed 35.56", [drive({ avgSpeed: 35.56 })], busFixes, [route38]);
show("avgSpeed 35.57", [drive({ avgSpeed: 35.57 })], busFixes, [route38]);
show("avgSpeed 62", [drive({ avgSpeed: 62 })], busFixes, [route38]);

console.log("--- what the pass writes ---");
show("existing wayName overwritten", [drive({ wayName: "Piccadilly" })], busFixes, [route38]);
show("wayName kept when unmatched", [drive({ wayName: "Piccadilly" })], taxiFixes, [route38]);
show("existing vehicleKind, no match", [drive({ vehicleKind: "bus" })], taxiFixes, [route38]);

console.log("--- array shape is preserved ---");
show(
	"three segments",
	[drive(), drive({ mode: "walking" }), drive({ endTs: 150 })],
	busFixes,
	[route38],
);

console.log("--- opts reach the matcher ---");
show("minCoverage 1.01", [drive()], busFixes, [route38], { minCoverage: 1.01 });
show("anchorM 1", [drive()], busFixes, [route38], { anchorM: 1 });
show("stopPassM 1", [drive()], busFixes, [route38], { stopPassM: 1 });

console.log("--- the two-fix bar, with the coverage floor lowered ---");
/** Two stops 24 m apart, so ONE fix anchors both ends of an in-order pair.
 *  Their span has no intermediate stop, so coverage is 0 — which only clears
 *  the bar when `minCoverage` is 0 (`0 < 0` is false). That is the one setting
 *  under which the `legFixes.length < 2` test has a consequence of its own. */
import * as M from "../../src/geo/bus-route-match.js";
import type { TransportMode } from "../../src/geo/segments.js";
const routeTwin = {
	routeRef: "C1",
	routeName: "Twin",
	osmRelationId: 9999,
	stops: [
		S("Twin A", 51.50672, -0.1428, 0),
		S("Twin B", 51.50652, -0.143, 1),
		S("Mid", 51.50043, -0.14855, 2),
		S("Twin Y", 51.49625, -0.14395, 3),
		S("Twin Z", 51.496, -0.1442, 4),
	],
};
show("one fix, twin stops, minCoverage 0", [drive({ endTs: 150 })], busFixes, [routeTwin], {
	minCoverage: 0,
});
show("two fixes, twin stops, minCoverage 0", [drive({ endTs: 200 })], busFixes, [routeTwin], {
	minCoverage: 0,
});
show("one fix, twin stops, default", [drive({ endTs: 150 })], busFixes, [routeTwin]);
// What the bar is holding back: the matcher underneath DOES match a one-fix
// leg here (board and alight are the same coord, both anchor, empty span), so
// the bar is the only thing between this fixture and a "bus".
{
	const p = busFixes[0];
	const m = M.matchBusRoute({ board: p, alight: p, trace: [p] }, [routeTwin], { minCoverage: 0 });
	console.log(`matcher on a one-fix leg: ${m === null ? "null" : M.busRouteLabel(m)}`);
	const dflt = M.matchBusRoute({ board: p, alight: p, trace: [p] }, [routeTwin]);
	console.log(`  …at the default floor:  ${dflt === null ? "null" : M.busRouteLabel(dflt)}`);
}

console.log("--- untouched fields survive ---");
{
	const seg = drive({ refinedMode: "driving", avgSpeed: 14, wayName: "Piccadilly" });
	const [out] = M.annotateBusRoutes([seg], busFixes, [route38]);
	console.log(JSON.stringify(out));
	console.log(`aliased? ${out === seg}`);
}
{
	const seg = drive({ mode: "walking" });
	const [out] = M.annotateBusRoutes([seg], busFixes, [route38]);
	console.log(`unmatched segment aliased? ${out === seg}`);
	const [out0] = M.annotateBusRoutes([seg], busFixes, []);
	console.log(`empty-routes segment aliased? ${out0 === seg}`);
}
