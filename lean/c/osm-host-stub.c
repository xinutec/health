/*
 * The DECLINE, for anything that links the fold without being a host.
 *
 * `DayEntry/OsmHost.lean` declares `walkableRoadsRaw` / `buildingsNearRaw` as
 * `@[extern]`, so every binary linking the fold must resolve those symbols —
 * including `verified_cli`, which is a SPAWNED process and by construction
 * cannot answer a query the fold generates mid-run.
 *
 * ⚠ SO IT SAYS SO, rather than answering empty (#1667). "There are no roads
 * here" is a claim about the world, and a process with no mirror behind it is
 * in no position to make it (#976); an area nobody has fetched would otherwise
 * be indistinguishable from an area with nothing in it, forever, because
 * nothing recorded that anyone had asked.
 *
 * The DRAWING is unchanged either way — `annotateWalkMatches` bails on a leg
 * whose ways came back empty exactly as it bails on one that was declined — so
 * this is a change in what the CLI can be asked, not in what it draws.
 *
 * `rust/day-shell` links its OWN implementations instead of this file, the same
 * way it is the only binary that defines `main`. Two definitions of one symbol
 * is what silently broke the first host build, so: exactly one of these ever
 * enters a link.
 */
#include <lean/lean.h>

/* A ZERO-LENGTH buffer — `OsmHost.decodeWays?` and `decodePolylines?` read it
 * as `none`. Both wire formats open with a mandatory four-byte count, so no
 * answer can be this short and the sentinel is unambiguous.
 *
 * ⚠ NOT a four-byte zero. That is a well-formed answer of no features. */
static lean_object *decline(void) {
	return lean_alloc_sarray(1, 0, 0);
}

/* The Lean signature is `Float → Float → Int → ByteArray`. `Int` arrives as a
 * boxed `lean_object *` rather than a machine integer.
 *
 * `lean_dec` on the radius is not optional even though this stub ignores it: an
 * `@[extern]` callee OWNS its boxed arguments. A radius small enough to be a
 * tagged scalar makes `lean_dec` a no-op, which is why forgetting it would leak
 * only for the large values nothing here passes — the worst kind of leak to find
 * later. The two Floats are unboxed and own nothing. */
LEAN_EXPORT lean_object *health_osm_walkable_roads(double lat, double lon, lean_object *radius_m) {
	(void)lat;
	(void)lon;
	lean_dec(radius_m);
	return decline();
}

LEAN_EXPORT lean_object *health_osm_buildings_near(double lat, double lon, lean_object *radius_m) {
	(void)lat;
	(void)lon;
	lean_dec(radius_m);
	return decline();
}

/* `drivableRoads` takes its radius as a `Float`, not an `Int` — the road
 * corridor passes a fractional radius through untouched — so there is no boxed
 * argument to release here. */
LEAN_EXPORT lean_object *health_osm_drivable_roads(double lat, double lon, double radius_m) {
	(void)lat;
	(void)lon;
	(void)radius_m;
	return decline();
}
