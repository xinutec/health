// CI check: the Lean fold's copy of the refinement cascade must name the same
// passes, in the same order, as `velocity.ts` actually runs.
//
// Why this exists: `Verified.Geo.PassFold` pins its wiring against
// `TS_CASCADE`, a hand-copied literal of the TS pass names. Those guards are
// strong about the fold and blind about the pipeline — when a pass is added to
// `velocity.ts`, `TS_CASCADE` and `passes` go on agreeing with each other while
// both disagree with what runs in production. That is not hypothetical: it is
// how the fold fell a pass behind when `changeoverWindow` landed (#444), and
// every Lean guard stayed green through it. The Lean side cannot catch this —
// it has no way to read the TS — so the check has to live out here.
//
// It fails when a target cannot be FOUND, not only when the lists disagree. A
// renamed `passes` binding or a moved `TS_CASCADE` would otherwise reduce this
// to a check of nothing, which reads exactly like a check that passes.
//
// Run via `npm run check:cascade-parity`; wired into gate.json.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const VELOCITY = resolve(ROOT, "src/geo/velocity.ts");
const PASSFOLD = resolve(ROOT, "lean/Verified/Geo/PassFold.lean");

/** The `name` of every entry of `const passes: RefinementPass[] = [...]`, in
 *  execution order. Read from the AST rather than by text, so a comment
 *  quoting a pass name cannot be mistaken for a pass. */
function tsCascade(path) {
	const sf = ts.createSourceFile(path, readFileSync(path, "utf-8"), ts.ScriptTarget.Latest, true);
	let literal = null;
	const visit = (node) => {
		if (
			ts.isVariableDeclaration(node) &&
			ts.isIdentifier(node.name) &&
			node.name.text === "passes" &&
			node.initializer &&
			ts.isArrayLiteralExpression(node.initializer)
		) {
			if (literal !== null) fail(`${path}: more than one \`passes\` array literal — which one runs?`);
			literal = node.initializer;
		}
		ts.forEachChild(node, visit);
	};
	visit(sf);
	if (literal === null) fail(`${path}: no \`const passes = [...]\` found — the cascade has moved or been renamed.`);

	return literal.elements.map((el, i) => {
		if (!ts.isObjectLiteralExpression(el)) fail(`${path}: cascade entry ${i} is not an object literal.`);
		const prop = el.properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText() === "name");
		if (prop === undefined || !ts.isStringLiteral(prop.initializer))
			fail(`${path}: cascade entry ${i} has no literal \`name\`.`);
		return prop.initializer.text;
	});
}

/** The strings of `def TS_CASCADE : Array String := #[ ... ]`, in order. */
function leanCascade(path) {
	const src = readFileSync(path, "utf-8");
	const marker = "def TS_CASCADE : Array String := #[";
	const at = src.indexOf(marker);
	if (at < 0) fail(`${path}: no \`${marker}\` — the Lean copy has moved or been renamed.`);
	const end = src.indexOf("]", at);
	if (end < 0) fail(`${path}: \`TS_CASCADE\` is not closed.`);
	const body = src.slice(at + marker.length, end);
	return [...body.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
}

function fail(message) {
	console.error(`check-cascade-parity: ${message}`);
	process.exit(1);
}

const inTs = tsCascade(VELOCITY);
const inLean = leanCascade(PASSFOLD);

// Report the whole disagreement rather than the first index that differs: a
// pass inserted in the middle shifts every name after it, and "index 36 differs"
// would name the wrong pass as the problem.
const missing = inTs.filter((n) => !inLean.includes(n));
const extra = inLean.filter((n) => !inTs.includes(n));
const reordered =
	missing.length === 0 && extra.length === 0 && inTs.some((n, i) => n !== inLean[i]);

if (missing.length > 0 || extra.length > 0 || reordered) {
	console.error("check-cascade-parity: the Lean fold's cascade copy is out of date.");
	console.error(`  velocity.ts runs ${inTs.length} passes; PassFold.TS_CASCADE lists ${inLean.length}.`);
	for (const n of missing) console.error(`  MISSING from TS_CASCADE (and so from the fold): ${n}`);
	for (const n of extra) console.error(`  EXTRA in TS_CASCADE, not in velocity.ts: ${n}`);
	if (reordered) {
		console.error("  SAME set, DIFFERENT order:");
		console.error(`    velocity.ts: ${inTs.join(" ")}`);
		console.error(`    TS_CASCADE:  ${inLean.join(" ")}`);
	}
	console.error("  Fix: update TS_CASCADE, wire the pass into `passes`, and give it a witness.");
	process.exit(1);
}

console.log(`check-cascade-parity: ${inTs.length} passes, same names and same order in velocity.ts and PassFold.`);
