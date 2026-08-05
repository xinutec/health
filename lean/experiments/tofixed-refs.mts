/**
 * V8 reference values for the Lean port of `Number.prototype.toFixed`.
 *
 * `toFixed` is not a convenience here — it is load-bearing algorithm. Two OSM
 * coordinates fuse into one graph vertex iff their `toFixed(7)` strings are
 * equal (`map-match-core`'s road graph, `rail-snap`'s rail graph,
 * `walkable-route`'s `nodeKey`), so the rounding rule decides graph
 * connectivity. It also formats the display strings the ports reproduce
 * verbatim.
 *
 * The rule is ECMA-262 21.1.3.3 step 10: let `n` be the integer for which
 * `n / 10^f - x` is closest to zero, **ties going to the LARGER n**, computed
 * against the double's EXACT binary value. Two consequences that a naive
 * implementation gets wrong, both pinned below:
 *   - `(1.005).toFixed(2)` is `"1.00"`, because the double nearest 1.005 is
 *     slightly below it;
 *   - ties round half-UP on the magnitude (the sign is stripped first), so
 *     `(-0.5).toFixed(0)` is `"-1"` — unlike `Math.round(-0.5)`, which is `-0`.
 *
 * Run:
 *   nix develop /Users/pippijn/Code/health --command \
 *     npx tsx /Users/pippijn/Code/health/lean/experiments/tofixed-refs.mts
 */

const lines: string[] = [];
const say = (label: string, value: string): void => { lines.push(`${label} = ${value}`); };
const section = (name: string): void => { lines.push(`\n=== ${name} ===`); };

/** `x.toFixed(f)`, labelled by the double's exact bit pattern so the Lean twin
 *  can be handed the identical value rather than a decimal literal it might
 *  parse differently. */
const fx = (x: number, f: number): void => {
	const bits = new DataView(new ArrayBuffer(8));
	bits.setFloat64(0, x);
	say(`toFixed(${x === 0 && Object.is(x, -0) ? "-0" : x}, ${f}) [0x${bits.getBigUint64(0).toString(16)}]`, JSON.stringify(x.toFixed(f)));
};

section("ties round half-up on the magnitude");
for (const x of [0.5, 1.5, 2.5, 3.5, -0.5, -1.5, -2.5]) fx(x, 0);
// 0.25 and 0.75 are exact in binary, so ×10 lands exactly on a tie.
fx(0.25, 1);
fx(0.75, 1);
fx(0.125, 2);
fx(0.375, 2);

section("the exact binary value decides, not the decimal literal");
fx(1.005, 2);
fx(1.015, 2);
fx(1.025, 2);
fx(8.575, 2);
fx(0.35, 1);
fx(0.45, 1);
fx(1.0049999999999999, 2);

section("padding and the f = 0 path");
fx(0.5, 7);
fx(0.000001, 7);
fx(1e-8, 7);
fx(0, 7);
fx(-0, 7);
fx(123.456, 0);
fx(0.0000005, 6);
fx(9.9999999, 7);
fx(9.99999995, 7);

section("negatives and carries");
fx(-51.52, 7);
fx(-0.13, 7);
fx(99.99999999, 7);
fx(-99.99999999, 7);
fx(0.9999999999, 7);

section("coordinate keys — the fusion identity");
const LAT0 = 51.52;
const LON0 = -0.13;
const MLAT = 1 / 111_320;
const MLON = 1 / (111_320 * Math.cos((LAT0 * Math.PI) / 180));
const P = (n: number, e: number): [number, number] => [LAT0 + n * MLAT, LON0 + e * MLON];
for (const [n, e] of [
	[0, 0],
	[0, 250],
	[300, 1000],
	[150, 500],
	[0, 1010],
] as Array<[number, number]>) {
	const [lat, lon] = P(n, e);
	say(`key(${n},${e})`, `${lat.toFixed(7)},${lon.toFixed(7)}`);
}
// Two coordinates ~1 mm apart that MUST fuse, and ~2 cm apart that must not.
const a = LAT0;
const b = LAT0 + 1e-9;
const c = LAT0 + 2e-7;
say("fuse 1e-9 apart", `${a.toFixed(7)} vs ${b.toFixed(7)} same=${a.toFixed(7) === b.toFixed(7)}`);
say("split 2e-7 apart", `${a.toFixed(7)} vs ${c.toFixed(7)} same=${a.toFixed(7) === c.toFixed(7)}`);

section("other precisions used for display strings");
for (const f of [1, 2, 3]) {
	fx(1234.56789, f);
	fx(-1234.56789, f);
}
fx(0.05, 1);
fx(2.675, 2);

section("large and subnormal");
fx(1e20, 7);
fx(123456789012345680000, 2);
fx(5e-324, 7);
fx(Number.MIN_VALUE, 20);
say("1e21 falls back to ToString", JSON.stringify((1e21).toFixed(2)));
say("Infinity", JSON.stringify(Number.POSITIVE_INFINITY.toFixed(2)));
say("-Infinity", JSON.stringify(Number.NEGATIVE_INFINITY.toFixed(2)));
say("NaN", JSON.stringify(Number.NaN.toFixed(2)));

console.log(lines.join("\n"));
