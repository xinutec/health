// CI check: every BIGINT column in `src/db/schema.ts` must be
// declared as `bigint` (or a branded bigint alias) in the
// corresponding Kysely interface in `src/db/tables.ts`.
//
// Why this exists: when we flipped `bigIntAsNumber:false`, every
// BIGINT column started returning `bigint` at runtime, but the TS
// declarations stayed `number` for the columns I didn't think to
// touch. The compiler greenlit `r.total_dwell_sec / r.visit_count`
// (number/number from its perspective) and the owntracks proxy
// threw "Cannot mix BigInt and other types" on every POST in
// production.
//
// This check parses schema.ts via regex (the CREATE TABLE bodies
// are structured text inside template literals) and tables.ts via
// the TypeScript AST. For each BIGINT column in schema.ts, it
// resolves the corresponding TS type and fails if the type doesn't
// include `bigint` (transitively through aliases like
// FitbitSleepLogId).
//
// Run via `npm run check:schema-types`; wired into `verify`.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SCHEMA_PATH = resolve(ROOT, "src/db/schema.ts");
const TABLES_PATH = resolve(ROOT, "src/db/tables.ts");
const BRANDED_PATH = resolve(ROOT, "src/db/branded.ts");

// Parse schema.ts. Returns Map<table_name, [{name, sqlType}]>.
// Covers both CREATE TABLE and ALTER TABLE ADD COLUMN.
function parseSchema() {
	const source = readFileSync(SCHEMA_PATH, "utf-8");
	const out = new Map();

	const createRe = /CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]+?)\)`/g;
	for (const m of source.matchAll(createRe)) {
		const [, table, body] = m;
		const cols = [];
		for (const rawLine of body.split("\n")) {
			const line = rawLine.trim().replace(/,$/, "");
			if (!line) continue;
			// Skip table-level constraints.
			if (/^(PRIMARY KEY|UNIQUE|INDEX|KEY|FOREIGN KEY|CONSTRAINT)\b/i.test(line)) continue;
			const colMatch = line.match(/^(\w+)\s+([A-Z]+)/i);
			if (colMatch) cols.push({ name: colMatch[1], sqlType: colMatch[2].toUpperCase() });
		}
		out.set(table, cols);
	}

	const alterRe = /ALTER TABLE (\w+) ADD COLUMN(?:\s+IF NOT EXISTS)?\s+(\w+)\s+([A-Z]+)/gi;
	for (const m of source.matchAll(alterRe)) {
		const [, table, col, type] = m;
		if (!out.has(table)) out.set(table, []);
		out.get(table).push({ name: col, sqlType: type.toUpperCase() });
	}

	return out;
}

// Parse a TS file. Returns { interfaces, aliases } where:
//   interfaces: Map<name, Map<field, typeText>>
//   aliases:    Map<name, typeText>
function parseTsFile(path) {
	const source = readFileSync(path, "utf-8");
	const sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
	const interfaces = new Map();
	const aliases = new Map();

	for (const stmt of sf.statements) {
		if (ts.isInterfaceDeclaration(stmt)) {
			const fields = new Map();
			for (const member of stmt.members) {
				if (ts.isPropertySignature(member) && member.type) {
					fields.set(member.name.getText(), member.type.getText());
				}
			}
			interfaces.set(stmt.name.text, fields);
		} else if (ts.isTypeAliasDeclaration(stmt)) {
			aliases.set(stmt.name.text, stmt.type.getText());
		}
	}

	return { interfaces, aliases };
}

// Walk the alias graph from `start`, returning every definition reached.
function resolveAliases(start, aliases) {
	const reached = new Set();
	const stack = [start];
	while (stack.length > 0) {
		const t = stack.pop();
		if (t === undefined || reached.has(t)) continue;
		reached.add(t);
		const def = aliases.get(t);
		if (def) stack.push(def);
	}
	return reached;
}

// Does a TS type (raw source text) ultimately rest on `bigint`?
function typeIncludesBigint(tsType, aliases) {
	if (/\bbigint\b/.test(tsType)) return true;
	const idents = tsType.match(/\b[A-Z]\w+/g) ?? [];
	for (const id of idents) {
		const reached = resolveAliases(id, aliases);
		for (const t of reached) {
			if (/\bbigint\b/.test(t)) return true;
		}
	}
	return false;
}

function tableNameToInterface(table) {
	return `${table.split("_").map((p) => p[0].toUpperCase() + p.slice(1)).join("")}Table`;
}

function main() {
	const sqlTables = parseSchema();
	const tablesParsed = parseTsFile(TABLES_PATH);
	const brandedParsed = parseTsFile(BRANDED_PATH);
	const allAliases = new Map([...tablesParsed.aliases, ...brandedParsed.aliases]);

	const databaseIface = tablesParsed.interfaces.get("Database");
	const tableToIface = new Map();
	if (databaseIface) {
		for (const [table, ifaceText] of databaseIface) tableToIface.set(table, ifaceText);
	}

	const problems = [];
	for (const [tableName, cols] of sqlTables) {
		const ifaceName = tableToIface.get(tableName) ?? tableNameToInterface(tableName);
		const iface = tablesParsed.interfaces.get(ifaceName);
		if (!iface) {
			console.log(`note: ${tableName} has no matching ${ifaceName} interface, skipping`);
			continue;
		}
		for (const { name: colName, sqlType } of cols) {
			if (sqlType !== "BIGINT") continue;
			const tsType = iface.get(colName);
			if (!tsType) {
				problems.push(`${tableName}.${colName}: BIGINT in schema but column not declared in ${ifaceName}`);
				continue;
			}
			if (!typeIncludesBigint(tsType, allAliases)) {
				problems.push(`${tableName}.${colName}: schema=BIGINT, ${ifaceName} declares "${tsType}" (does not resolve to bigint)`);
			}
		}
	}

	if (problems.length > 0) {
		console.error(`schema/types drift detected (${problems.length}):`);
		for (const p of problems) console.error(`  ${p}`);
		console.error("\nFix: update the listed column(s) in src/db/tables.ts so the TS type is bigint (or a branded bigint).");
		process.exit(1);
	}

	console.log("schema/types check: all BIGINT columns are declared as bigint");
}

main();
