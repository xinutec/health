// CI check: the frontend's hand-written copies of backend string unions
// must list exactly the same members as the backend originals.
//
// Why this exists: the frontend has no compile-time link to the backend
// types — it restates them. `modes.ts` closed four divergent mode maps
// behind one `Record<DayStateMode, …>`, so a mode missing an icon is now
// a frontend build error; but nothing checks that the frontend's
// `DayStateMode` is the backend's. Adding a mode server-side still
// leaves the frontend compiling happily against a union that no longer
// matches what the API sends, and the mode falls through to a default
// style — the exact silence #337 was opened to end.
//
// Same shape for `EpisodeKind`: `health.service.ts` says in a comment
// that its `kind` union is "hand-kept". This makes the comment enforced.
//
// The check resolves alias references (backend `DayStateMode` is
// `TransportMode | "sleeping" | "bus"`), so it compares the flattened
// member sets, not the source text.
//
// It fails when a target cannot be FOUND, not just when it disagrees. A
// renamed type or a moved file would otherwise silently reduce this to a
// check of nothing, which reads identically to a check that passes.
//
// Run via `pnpm run check:frontend-unions`; wired into gate.json and CI.

import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

/** Parse one file into { aliases, interfaces } of raw TS AST nodes.
 *  Nodes, not text — resolution walks the union tree rather than
 *  re-parsing source with a regex. */
function parseFile(path) {
	const source = readFileSync(path, "utf-8");
	const sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
	const aliases = new Map();
	const interfaces = new Map();

	for (const stmt of sf.statements) {
		if (ts.isTypeAliasDeclaration(stmt)) {
			aliases.set(stmt.name.text, stmt.type);
		} else if (ts.isInterfaceDeclaration(stmt)) {
			const fields = new Map();
			for (const member of stmt.members) {
				if (ts.isPropertySignature(member) && member.type) {
					fields.set(member.name.getText(), member.type);
				}
			}
			interfaces.set(stmt.name.text, fields);
		}
	}

	return { aliases, interfaces, path };
}

/** A scope is several parsed files searched as one namespace. Both sides
 *  of every comparison here are small, closed sets of files. */
function scopeOf(...relPaths) {
	const files = relPaths.map((p) => parseFile(resolve(ROOT, p)));
	const aliases = new Map();
	const interfaces = new Map();
	for (const f of files) {
		for (const [k, v] of f.aliases) aliases.set(k, v);
		for (const [k, v] of f.interfaces) interfaces.set(k, v);
	}
	return { aliases, interfaces, files: relPaths };
}

/** Flatten a union-of-string-literals to its member set, following alias
 *  references. Throws on anything it cannot account for — an unresolved
 *  reference must not read as "no members". */
function resolveUnion(node, scope, seen = new Set()) {
	if (ts.isParenthesizedTypeNode(node)) return resolveUnion(node.type, scope, seen);

	if (ts.isUnionTypeNode(node)) {
		const out = new Set();
		for (const member of node.types) {
			for (const v of resolveUnion(member, scope, seen)) out.add(v);
		}
		return out;
	}

	if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal)) {
		return new Set([node.literal.text]);
	}

	if (ts.isTypeReferenceNode(node)) {
		const name = node.typeName.getText();
		if (seen.has(name)) throw new Error(`type alias ${name} is cyclic`);
		const target = scope.aliases.get(name);
		if (!target) {
			throw new Error(`type alias ${name} not found in ${scope.files.join(", ")}`);
		}
		return resolveUnion(target, scope, new Set([...seen, name]));
	}

	// `DayState["mode"]` and friends: resolve the interface field.
	if (ts.isIndexedAccessTypeNode(node)) {
		const objName = node.objectType.getText();
		const iface = scope.interfaces.get(objName);
		const key = ts.isLiteralTypeNode(node.indexType) && ts.isStringLiteral(node.indexType.literal)
			? node.indexType.literal.text
			: null;
		if (!iface || key === null || !iface.get(key)) {
			throw new Error(`indexed access ${node.getText()} could not be resolved in ${scope.files.join(", ")}`);
		}
		return resolveUnion(iface.get(key), scope, seen);
	}

	throw new Error(`unsupported type in union: ${node.getText()} (${ts.SyntaxKind[node.kind]})`);
}

/** Locate a named alias, or a named interface's field, in a scope. */
function lookup(scope, spec) {
	if (spec.field === undefined) {
		const node = scope.aliases.get(spec.type);
		if (!node) throw new Error(`type ${spec.type} not found in ${scope.files.join(", ")}`);
		return node;
	}
	const iface = scope.interfaces.get(spec.type);
	if (!iface) throw new Error(`interface ${spec.type} not found in ${scope.files.join(", ")}`);
	const node = iface.get(spec.field);
	if (!node) throw new Error(`${spec.type}.${spec.field} not found in ${scope.files.join(", ")}`);
	return node;
}

const BACKEND = scopeOf("src/geo/segments.ts", "src/sleep/day-state.ts", "src/geo/episode-geometry.ts");
const FRONTEND = scopeOf("frontend/src/app/modes.ts", "frontend/src/app/services/health.service.ts");

/** Each pair: one backend union, and the frontend restatement of it. */
const PAIRS = [
	{
		what: "DayStateMode",
		backend: { type: "DayStateMode" },
		frontend: { type: "DayStateMode" },
		fix: "update the union in frontend/src/app/modes.ts (and give any new mode an icon, colour and label in MODE_STYLES)",
	},
	{
		what: "EpisodeKind",
		backend: { type: "EpisodeKind" },
		frontend: { type: "EpisodeGeometry", field: "kind" },
		fix: "update the `kind` union in frontend/src/app/services/health.service.ts (and give any new kind a SOURCE_LABEL entry in map.component.ts)",
	},
];

function main() {
	const problems = [];

	for (const pair of PAIRS) {
		const back = resolveUnion(lookup(BACKEND, pair.backend), BACKEND);
		const front = resolveUnion(lookup(FRONTEND, pair.frontend), FRONTEND);

		// A union that resolved to nothing means the walk found no literals,
		// which would agree with any other empty union. Refuse it.
		if (back.size === 0) throw new Error(`${pair.what}: backend union resolved to no members`);
		if (front.size === 0) throw new Error(`${pair.what}: frontend union resolved to no members`);

		const missing = [...back].filter((m) => !front.has(m));
		const extra = [...front].filter((m) => !back.has(m));

		if (missing.length > 0 || extra.length > 0) {
			const lines = [`${pair.what}: frontend copy has drifted from the backend`];
			if (missing.length > 0) lines.push(`  backend has, frontend missing: ${missing.join(", ")}`);
			if (extra.length > 0) lines.push(`  frontend has, backend does not: ${extra.join(", ")}`);
			lines.push(`  fix: ${pair.fix}`);
			problems.push(lines.join("\n"));
		} else {
			console.log(`${pair.what}: ${back.size} members, frontend copy matches`);
		}
	}

	if (problems.length > 0) {
		console.error(`\nfrontend/backend union drift detected (${problems.length}):`);
		for (const p of problems) console.error(p);
		process.exit(1);
	}

	console.log("frontend union check: every mirrored union matches its backend original");
}

try {
	main();
} catch (err) {
	// A failure to RESOLVE is a failure of the check, not a pass. Renaming
	// a type or moving a file lands here rather than quietly checking less.
	console.error(`frontend union check could not run: ${err.message}`);
	console.error(`(checked from ${relative(process.cwd(), ROOT) || "."})`);
	process.exit(1);
}
