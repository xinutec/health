/*
 * The empty answer, for anything that links the fold without being a host.
 *
 * `DayEntry/OsmHost.lean` declares `walkableRoadsRaw` / `buildingsNearRaw` as
 * `@[extern]`, so every binary linking the fold must resolve those symbols —
 * including `verified_cli`, which is a SPAWNED process and by construction
 * cannot answer a query the fold generates mid-run. It gets these: a well-formed
 * buffer declaring zero polylines.
 *
 * That is exactly the behaviour `verified_cli` has today, where `walkEnv`'s
 * reads are `fun _ _ _ => #[]`. Nothing about the CLI's answers changes by
 * introducing the extern — which is the point, and is what the day gate is
 * asked to confirm.
 *
 * `rust/day-shell` links its OWN implementations instead of this file, the same
 * way it is the only binary that defines `main`. Two definitions of one symbol
 * is what silently broke the first host build, so: exactly one of these ever
 * enters a link.
 */
#include <lean/lean.h>

/* A four-byte little-endian zero — "no polylines" in OsmHost's wire format. */
static lean_object *empty_answer(void) {
	lean_object *a = lean_alloc_sarray(1, 4, 4);
	uint8_t *p = lean_sarray_cptr(a);
	p[0] = p[1] = p[2] = p[3] = 0;
	return a;
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
	return empty_answer();
}

LEAN_EXPORT lean_object *health_osm_buildings_near(double lat, double lon, lean_object *radius_m) {
	(void)lat;
	(void)lon;
	lean_dec(radius_m);
	return empty_answer();
}

/* `drivableRoads` takes its radius as a `Float`, not an `Int` — the road
 * corridor passes a fractional radius through untouched — so there is no boxed
 * argument to release here. A four-byte zero means "no ways" in the second wire
 * format exactly as it means "no polylines" in the first. */
LEAN_EXPORT lean_object *health_osm_drivable_roads(double lat, double lon, double radius_m) {
	(void)lat;
	(void)lon;
	(void)radius_m;
	return empty_answer();
}
