/**
 * Spec: the spatial queries against `osm_points` and `osm_lines`
 * MUST be filterable by the SPATIAL index, not by a distance
 * function on every row.
 *
 * Background: with `WHERE ST_Distance(geom, point) < n` alone,
 * MariaDB doesn't use the spatial index — it falls back to a
 * range scan via `idx_feature_type` and computes ST_Distance for
 * every row. Production EXPLAIN on 2026-05-13 showed the current
 * `queryLines` examining 239 559 rows per call. With ~40 such
 * queries firing in parallel during a single /api/velocity, the
 * 20-connection pool exhausted and segments lost OSM enrichment.
 *
 * The fix is to add `MBRIntersects(geom, ST_Buffer(point, dDeg))`
 * as a leading predicate. MBRIntersects is index-accelerated; the
 * distance refinement then runs only on the (small) candidate set.
 * After the fix EXPLAIN dropped rows examined to 3.
 *
 * These tests assert the COMPILED SQL contains `MBRIntersects`.
 * That's a structural test — it doesn't measure performance, but
 * it does prevent a future refactor from silently removing the
 * index-using predicate. The runtime perf claim is re-verified
 * via EXPLAIN after the deploy.
 */

import { Kysely, sql } from "kysely";
import { MariadbDialect } from "kysely-mariadb";
import { describe, expect, it } from "vitest";
import type { Database } from "../src/db/tables.js";
import { buildLinesQuery, buildLocalDataProbeQuery, buildPointsQuery } from "../src/geo/osm-local.js";

/** Kysely instance configured for SQL compilation only — the
 *  pool is never executed against, so a stubbed object suffices. */
function compileOnlyKysely(): Kysely<Database> {
	return new Kysely<Database>({
		dialect: new MariadbDialect({ mariadb: {} as never }),
	});
}

describe("osm spatial query SQL", () => {
	it("queryPoints SQL includes MBRIntersects so the spatial index is used", () => {
		const k = compileOnlyKysely();
		const q = buildPointsQuery(k, 51.5, -0.1, 500, "railway");
		const { sql: compiled } = q.compile();
		expect(compiled).toContain("MBRIntersects");
	});

	it("queryLines SQL includes MBRIntersects so the spatial index is used", () => {
		const k = compileOnlyKysely();
		const q = buildLinesQuery(k, 51.5, -0.1, 500, "highway");
		const { sql: compiled } = q.compile();
		expect(compiled).toContain("MBRIntersects");
	});

	it("queryLines respects the subtype filter when provided", () => {
		const k = compileOnlyKysely();
		const q = buildLinesQuery(k, 51.5, -0.1, 500, "highway", ["motorway", "trunk"]);
		const { sql: compiled, parameters } = q.compile();
		expect(compiled).toContain("`subtype` in");
		expect(parameters).toContain("motorway");
		expect(parameters).toContain("trunk");
	});

	it("queryPoints still computes ST_Distance_Sphere for the distance ordering (great-circle metres)", () => {
		// MBR is a coarse pre-filter — the final distance + ordering
		// must still use ST_Distance_Sphere so the metre values are
		// accurate. This guards against accidentally dropping the
		// great-circle calc when adding MBR.
		const k = compileOnlyKysely();
		const q = buildPointsQuery(k, 51.5, -0.1, 500, "railway");
		const { sql: compiled } = q.compile();
		expect(compiled).toContain("ST_Distance_Sphere");
	});

	// --------------------------------------------------------------
	// Local-data probe: existence check used by ensureCovered as a
	// fallback when osm_coverage has no row for (feature_type, area)
	// but the geometry table may already contain data from a sibling
	// fetch. MUST use the spatial index — otherwise the probe would
	// itself become a 240k-row scan and the fix would make things
	// worse, not better.
	// --------------------------------------------------------------

	it("buildLocalDataProbeQuery (lines table) uses MBRIntersects for index-accelerated probe", () => {
		const k = compileOnlyKysely();
		const q = buildLocalDataProbeQuery(k, "osm_lines", 50.85, 4.35, 500, "highway");
		const { sql: compiled } = q.compile();
		expect(compiled).toContain("MBRIntersects");
	});

	it("buildLocalDataProbeQuery (points table) uses MBRIntersects for index-accelerated probe", () => {
		const k = compileOnlyKysely();
		const q = buildLocalDataProbeQuery(k, "osm_points", 50.85, 4.35, 500, "railway");
		const { sql: compiled } = q.compile();
		expect(compiled).toContain("MBRIntersects");
	});

	it("buildLocalDataProbeQuery filters on feature_type and limits to 1 row (existence check)", () => {
		// Existence-only — we don't care about the actual rows, just
		// whether ANY match. `LIMIT 1` lets the spatial index stop
		// scanning after the first hit, which is what makes this
		// cheap enough to run on every uncovered query.
		const k = compileOnlyKysely();
		const q = buildLocalDataProbeQuery(k, "osm_lines", 50.85, 4.35, 500, "highway");
		const { sql: compiled, parameters } = q.compile();
		expect(compiled).toContain("`feature_type` =");
		expect(parameters).toContain("highway");
		// Kysely parameterises LIMIT — check the compiled SQL has a
		// `limit ?` clause AND the parameter is exactly 1.
		expect(compiled.toLowerCase()).toContain("limit ?");
		expect(parameters).toContain(1);
	});
});

// suppress unused-import warning for sql which the test helpers
// may need later when adding more cases.
void sql;
