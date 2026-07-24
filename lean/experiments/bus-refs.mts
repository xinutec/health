/**
 * V8 reference values for the Lean port of the bus cluster
 * (`src/geo/bus-route-match.ts` + `src/geo/bus-evidence.ts`).
 *
 * Run:
 *   nix develop /Users/pippijn/Code/health --command \
 *     npx tsx /Users/pippijn/Code/health/lean/experiments/bus-refs.mts
 *
 * Prints the exact doubles Node produces so `Verified.Geo.Bus`'s `#guard`s
 * can be pinned against the real implementation rather than against my
 * arithmetic. Everything here calls the SHIPPING functions — nothing is
 * reimplemented in this file.
 */

import {
	matchBusRoute,
	busRouteLabel,
	type BusRoute,
	type BusStop,
	type VehicleLegEndpoints,
} from "../../src/geo/bus-route-match.js";
import { detectBoardingWait, detectVehicleDwells, scoreBusEvidence, type BusEvidence } from "../../src/geo/bus-evidence.js";

const f = (x: number): string => (Number.isFinite(x) ? x.toPrecision(17) : String(x));

function stop(name: string | null, lat: number, lon: number, seq: number): BusStop {
	return { name, lat, lon, seq };
}

// ---------------------------------------------------------------------------
// A realistic route: the 38 westbound-ish spine along Piccadilly/Grosvenor Pl,
// six stops, ~300-500 m apart. Coordinates are real London.
// ---------------------------------------------------------------------------
const route38: BusRoute = {
	routeRef: "38",
	routeName: "Victoria - Clapton Pond",
	osmRelationId: 1234,
	stops: [
		stop("Green Park", 51.50675, -0.14273, 0),
		stop("Hyde Park Corner", 51.50305, -0.15195, 1),
		stop("Grosvenor Place", 51.50043, -0.14855, 2),
		stop("Wilton Street", 51.49825, -0.14625, 3),
		stop("Victoria Station", 51.49607, -0.14413, 4),
		stop("Vauxhall Bridge Road", 51.49392, -0.14166, 5),
	],
};

// A decoy route sharing the two endpoints but running a different middle —
// the taxi-as-bus failure mode (#256): anchors fine, corroborates badly.
const routeDecoy: BusRoute = {
	routeRef: "N22",
	routeName: null,
	osmRelationId: 5678,
	stops: [
		stop("Green Park", 51.50681, -0.14266, 0),
		stop("Berkeley Square", 51.50968, -0.14636, 1),
		stop("Mount Street", 51.51033, -0.15095, 2),
		stop("Victoria Station", 51.49601, -0.14421, 3),
	],
};

/** A trace that follows the 38's spine: interpolated along the real stops. */
const traceOnRoute = [
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

/** A taxi: same endpoints, straight down the direct road, missing the
 *  Hyde Park Corner / Grosvenor loop entirely. */
const traceDirect = [
	{ lat: 51.5067, lon: -0.1428 },
	{ lat: 51.5045, lon: -0.1438 },
	{ lat: 51.5022, lon: -0.1441 },
	{ lat: 51.4998, lon: -0.1442 },
	{ lat: 51.4975, lon: -0.1442 },
	{ lat: 51.4961, lon: -0.1442 },
];

const board = { lat: 51.50662, lon: -0.14288 };
const alight = { lat: 51.49618, lon: -0.14402 };

function show(label: string, leg: VehicleLegEndpoints, routes: readonly BusRoute[]): void {
	const m = matchBusRoute(leg, routes);
	if (m === null) {
		console.log(`${label}: null`);
		return;
	}
	console.log(
		`${label}: ref=${m.routeRef} name=${m.routeName} rel=${m.osmRelationId} ` +
			`board=${m.boardStop.name}@${f(m.boardDistM)} alight=${m.alightStop.name}@${f(m.alightDistM)} ` +
			`span=${m.stopSpan} label="${busRouteLabel(m)}"`,
	);
}

console.log("=== matchBusRoute ===");
show("on-route, no speed", { board, alight, trace: traceOnRoute }, [route38]);
show("on-route, 14 km/h", { board, alight, trace: traceOnRoute, speedKmh: 14 }, [route38]);
show("on-route, 38 km/h (midpoint)", { board, alight, trace: traceOnRoute, speedKmh: 38 }, [route38]);
show("on-route, 62 km/h", { board, alight, trace: traceOnRoute, speedKmh: 62 }, [route38]);
show("direct/taxi trace", { board, alight, trace: traceDirect }, [route38]);
show("both routes offered", { board, alight, trace: traceOnRoute }, [routeDecoy, route38]);
show("decoy only (2-stop span)", { board, alight, trace: traceOnRoute }, [routeDecoy]);
show("reversed (alight before board)", { board: alight, alight: board, trace: traceOnRoute }, [route38]);
show("degenerate trace (1 fix)", { board, alight, trace: [board] }, [route38]);
show("no routes", { board, alight, trace: traceOnRoute }, []);

// Endpoint anchoring far from any stop.
show("board 400 m off", { board: { lat: 51.5100, lon: -0.1400 }, alight, trace: traceOnRoute }, [route38]);

// A short in-route hop: Hyde Park Corner -> Wilton Street (one intermediate).
console.log("");
console.log("=== matchBusRoute: short hop ===");
show(
	"HPC->Wilton (1 intermediate, on route)",
	{
		board: { lat: 51.50310, lon: -0.15190 },
		alight: { lat: 51.49830, lon: -0.14620 },
		trace: [
			{ lat: 51.5031, lon: -0.1519 },
			{ lat: 51.5016, lon: -0.1501 },
			{ lat: 51.5004, lon: -0.1486 },
			{ lat: 51.4993, lon: -0.1474 },
			{ lat: 51.4983, lon: -0.1462 },
		],
	},
	[route38],
);

// The speed logistic's decision boundary: coverage is 1.0 on this trace, so
// the match flips exactly where busSpeedPlausibility crosses minCoverage
// (0.6). Straddling it pins the logistic itself, not just a verdict.
console.log("");
console.log("=== speed-logistic boundary (coverage = 1) ===");
for (const speedKmh of [35.5, 35.56, 35.57, 35.6, 36, 40]) {
	const m = matchBusRoute({ board, alight, trace: traceOnRoute, speedKmh }, [route38]);
	console.log(`speed=${speedKmh}: ${m === null ? "null" : m.routeRef}`);
}

// busSpeedPlausibility is private, so recover it from the SHIPPING matcher
// rather than reimplementing the logistic here: on a trace with coverage 1
// the score IS the plausibility, and a match survives exactly when
// score >= minCoverage. Bisecting minCoverage therefore reads the private
// function's value out of production code to full double precision.
console.log("");
console.log("=== busSpeedPlausibility (bisected out of matchBusRoute) ===");
function plausibilityOf(speedKmh: number | undefined): number {
	const matches = (minCoverage: number): boolean =>
		matchBusRoute({ board, alight, trace: traceOnRoute, speedKmh }, [route38], { minCoverage }) !== null;
	let lo = 0; // matches
	let hi = 1.0000001; // does not
	for (let i = 0; i < 200 && hi - lo > 0; i++) {
		const mid = (lo + hi) / 2;
		if (mid === lo || mid === hi) break;
		if (matches(mid)) lo = mid;
		else hi = mid;
	}
	return lo;
}
for (const s of [undefined, 14, 35.5, 38, 50, 62]) {
	console.log(`speed=${s ?? "-"}: plausibility=${f(plausibilityOf(s))}`);
}

// Partial coverage: a trace that passes some but not all intermediates,
// exercising the fraction rather than the 0/1 ends.
console.log("");
console.log("=== partial coverage ===");
/** Follows the route past Hyde Park Corner + Grosvenor Place, then cuts the
 *  corner and misses Wilton Street by ~200 m. 2 of 3 intermediates. */
const tracePartial = [
	{ lat: 51.5067, lon: -0.1428 },
	{ lat: 51.5049, lon: -0.1475 },
	{ lat: 51.5031, lon: -0.1519 },
	{ lat: 51.5004, lon: -0.1486 },
	{ lat: 51.4990, lon: -0.1440 },
	{ lat: 51.4961, lon: -0.1442 },
];
for (const minCoverage of [0.6, 0.66, 0.67, 0.7]) {
	const m = matchBusRoute({ board, alight, trace: tracePartial }, [route38], { minCoverage });
	console.log(`minCoverage=${minCoverage}: ${m === null ? "null" : `${m.routeRef} span=${m.stopSpan}`}`);
}
for (const stopPassM of [50, 120, 400]) {
	const m = matchBusRoute({ board, alight, trace: tracePartial }, [route38], { stopPassM });
	console.log(`stopPassM=${stopPassM}: ${m === null ? "null" : `${m.routeRef} span=${m.stopSpan}`}`);
}

// Two stops of one route within the anchor radius of the board coord: the
// pair with the smallest combined anchor distance must win.
console.log("");
console.log("=== multi-anchor pair choice ===");
const routeTwin: BusRoute = {
	routeRef: "C1",
	routeName: "Twin",
	osmRelationId: 9999,
	stops: [
		stop("Twin A", 51.50672, -0.14280, 0), // ~10 m from board
		stop("Twin B", 51.50652, -0.14300, 1), // ~18 m from board, later in order
		stop("Mid", 51.50043, -0.14855, 2),
		stop("Twin Y", 51.49625, -0.14395, 3), // near alight
		stop("Twin Z", 51.49600, -0.14420, 4), // also near alight
	],
};
show("twin anchors both ends", { board, alight, trace: traceOnRoute }, [routeTwin]);

// ---------------------------------------------------------------------------
// bus-evidence: boarding wait + mid-leg dwells + scoring
// ---------------------------------------------------------------------------
console.log("");
console.log("=== detectBoardingWait ===");

/** A 90 s standstill then a pull-away at t=1000. */
const waitFixes = [
	{ ts: 850, lat: 51.5030, lon: -0.1520 },
	{ ts: 880, lat: 51.50301, lon: -0.15201 },
	{ ts: 910, lat: 51.50302, lon: -0.15199 },
	{ ts: 940, lat: 51.50300, lon: -0.15200 },
	{ ts: 970, lat: 51.50303, lon: -0.15202 },
	{ ts: 990, lat: 51.5035, lon: -0.1521 }, // pull-away pair, inside trim window
	{ ts: 1000, lat: 51.5040, lon: -0.1522 },
];
function showWait(label: string, fixes: readonly { ts: number; lat: number; lon: number }[], startTs: number): void {
	const w = detectBoardingWait(fixes, startTs);
	console.log(`${label}: ${w === null ? "null" : `dur=${w.durationS} lat=${f(w.lat)} lon=${f(w.lon)}`}`);
}
showWait("90s wait then pull-away", waitFixes, 1000);
showWait("same, leg starts at 990", waitFixes, 990);
showWait("rolling approach (all fast)", [
	{ ts: 900, lat: 51.500, lon: -0.150 },
	{ ts: 930, lat: 51.503, lon: -0.152 },
	{ ts: 960, lat: 51.506, lon: -0.154 },
	{ ts: 990, lat: 51.509, lon: -0.156 },
], 1000);
showWait("too short (30 s still)", [
	{ ts: 940, lat: 51.5030, lon: -0.1520 },
	{ ts: 955, lat: 51.50301, lon: -0.15201 },
	{ ts: 970, lat: 51.50302, lon: -0.15200 },
], 1000);
showWait("single fix", [{ ts: 950, lat: 51.5030, lon: -0.1520 }], 1000);
showWait("outside lookback", [
	{ ts: 300, lat: 51.5030, lon: -0.1520 },
	{ ts: 400, lat: 51.50301, lon: -0.15201 },
], 1000);

console.log("");
console.log("=== detectVehicleDwells ===");
/** Leg 1000..1400: moves, stands 1100-1160 at a stop, moves, stands 1250-1265
 *  (too short), moves. */
const legFixes = [
	{ ts: 1000, lat: 51.5040, lon: -0.1522 },
	{ ts: 1030, lat: 51.5030, lon: -0.1510 },
	{ ts: 1060, lat: 51.5020, lon: -0.1498 },
	{ ts: 1100, lat: 51.5010, lon: -0.1486 },
	{ ts: 1130, lat: 51.50101, lon: -0.14861 },
	{ ts: 1160, lat: 51.50100, lon: -0.14860 },
	{ ts: 1200, lat: 51.4998, lon: -0.1472 },
	{ ts: 1250, lat: 51.4988, lon: -0.1460 },
	{ ts: 1265, lat: 51.49881, lon: -0.14601 },
	{ ts: 1300, lat: 51.4975, lon: -0.1450 },
	{ ts: 1400, lat: 51.4961, lon: -0.1442 },
];
for (const d of detectVehicleDwells(legFixes, 1000, 1400)) {
	console.log(`dwell ${d.startTs}-${d.endTs} dur=${d.durationS} lat=${f(d.lat)} lon=${f(d.lon)}`);
}
console.log(`(count=${detectVehicleDwells(legFixes, 1000, 1400).length})`);
console.log(`window 1000-1150 count=${detectVehicleDwells(legFixes, 1000, 1150).length}`);
console.log(`empty window count=${detectVehicleDwells(legFixes, 5000, 6000).length}`);

console.log("");
console.log("=== scoreBusEvidence ===");
function showScore(label: string, ev: BusEvidence): void {
	const s = scoreBusEvidence(ev);
	console.log(
		`${label}: total=${f(s.total)} boarding=${f(s.parts.boarding)} dwell=${f(s.parts.dwellCredit)} pen=${f(s.parts.noStopPenalty)}`,
	);
}
const d = (durationS: number, stopM: number | null, sigM: number | null) => ({
	durationS,
	nearestBusStopM: stopM,
	nearestSignalM: sigM,
});
showScore("nothing", { boardingWaitS: null, boardingNearestBusStopM: null, dwells: [] });
showScore("boarding at stop only", { boardingWaitS: 90, boardingNearestBusStopM: 12, dwells: [] });
showScore("boarding, no stop nearby", { boardingWaitS: 90, boardingNearestBusStopM: 200, dwells: [] });
showScore("boarding, no stop data", { boardingWaitS: 90, boardingNearestBusStopM: null, dwells: [] });
showScore("boarding at stop + 1 stop dwell", {
	boardingWaitS: 90,
	boardingNearestBusStopM: 12,
	dwells: [d(40, 20, null)],
});
showScore("3 stop dwells, no boarding", {
	boardingWaitS: null,
	boardingNearestBusStopM: null,
	dwells: [d(40, 20, null), d(35, 15, null), d(25, 30, null)],
});
showScore("stop+signal ambiguous dwells", {
	boardingWaitS: null,
	boardingNearestBusStopM: null,
	dwells: [d(40, 20, 10), d(35, 15, 30), d(25, 30, 20)],
});
showScore("dwell credit cap (5 stop dwells)", {
	boardingWaitS: null,
	boardingNearestBusStopM: null,
	dwells: [d(40, 20, null), d(40, 20, null), d(40, 20, null), d(40, 20, null), d(40, 20, null)],
});
showScore("3 dwells none at a stop", {
	boardingWaitS: null,
	boardingNearestBusStopM: null,
	dwells: [d(40, null, 10), d(35, 200, 12), d(25, null, null)],
});
showScore("boarding + 3 dwells none at stop", {
	boardingWaitS: 90,
	boardingNearestBusStopM: 12,
	dwells: [d(40, null, 10), d(35, 200, 12), d(25, null, null)],
});
showScore("2 dwells none at stop (under MANY)", {
	boardingWaitS: null,
	boardingNearestBusStopM: null,
	dwells: [d(40, null, 10), d(35, 200, 12)],
});
showScore("boundary: stop at exactly 35 m", { boardingWaitS: 90, boardingNearestBusStopM: 35, dwells: [d(40, 35, 36)] });
