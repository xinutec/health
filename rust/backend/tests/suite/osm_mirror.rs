//! The base mirror's write half — bucketing, box sizing and the query (#1658).
//!
//! The rows these queries write sit BESIDE rows the TypeScript wrote before it
//! was deleted (#975), so the shapes are pinned against
//! `06346bd^:src/geo/osm-local.ts` rather than trusted. A bucket that disagrees
//! with its neighbours does not fail: it fills the mirror with rows the reader's
//! `feature_type` filter never selects.

use backend::osm_mirror::{
    BUCKETS, Bbox, bucket_of, fetch_bbox_around, half_width_for, overpass_query, parse_element,
    parse_queue_key, queue_key, queue_kind,
};
use serde_json::json;

/// ⚠ THE PRECEDENCE IS THE RULE. A way carrying both tags buckets under the
/// FIRST match, and railway beats highway because the rail signal is rarer.
#[test]
fn railway_wins_over_highway_on_an_element_carrying_both() {
    let el = json!({
        "type": "way", "id": 7,
        "tags": {"highway": "service", "railway": "rail"},
        "geometry": [{"lat": 51.5, "lon": -0.1}, {"lat": 51.6, "lon": -0.2}],
    });
    let f = parse_element(&el).expect("bucketed");
    assert_eq!(f.feature_type, "railway");
    assert_eq!(f.subtype.as_deref(), Some("rail"));
}

/// A building that is ALSO a venue was already caught by an earlier rule; only
/// a plain one falls through. Without this the landmark bucket loses every
/// shop that happens to have a footprint.
#[test]
fn a_shop_with_a_footprint_stays_a_landmark() {
    let outline = [
        json!({"lat": 51.5, "lon": -0.1}),
        json!({"lat": 51.5, "lon": -0.2}),
    ];
    let venue = json!({
        "type": "way", "id": 1,
        "tags": {"building": "yes", "shop": "bakery"},
        "geometry": outline,
    });
    let plain = json!({
        "type": "way", "id": 2,
        "tags": {"building": "yes"},
        "geometry": outline,
    });
    assert_eq!(
        parse_element(&venue).expect("venue").feature_type,
        "landmark"
    );
    assert_eq!(
        parse_element(&plain).expect("plain").feature_type,
        "building"
    );
}

/// ⚠ NODES ONLY. A way tagged `highway=bus_stop` is not a stop, and letting one
/// into `transit_stop` would put a line in a bucket the bus/car discriminator
/// reads as point evidence (#328).
#[test]
fn a_bus_stop_node_is_furniture_and_a_bus_stop_way_is_not() {
    let node = json!({"type": "node", "id": 3, "lat": 51.5, "lon": -0.1,
                      "tags": {"highway": "bus_stop"}});
    let way = json!({"type": "way", "id": 4, "tags": {"highway": "bus_stop"},
                     "geometry": [{"lat": 51.5, "lon": -0.1}, {"lat": 51.6, "lon": -0.2}]});
    assert_eq!(
        parse_element(&node).expect("node").feature_type,
        "transit_stop"
    );
    assert_eq!(parse_element(&way).expect("way").feature_type, "highway");
}

/// ⚠ `ref` IS THE FALLBACK AND IT NAMES THE MOTORWAYS. The A41 carries no
/// `name`; without this every trunk road in the mirror is anonymous.
#[test]
fn a_way_with_only_a_ref_is_named_by_it() {
    let el = json!({"type": "way", "id": 5, "tags": {"highway": "trunk", "ref": "A41"},
                    "geometry": [{"lat": 51.5, "lon": -0.1}, {"lat": 51.6, "lon": -0.2}]});
    assert_eq!(
        parse_element(&el).expect("named").name.as_deref(),
        Some("A41")
    );
}

/// A one-vertex way is not a LINESTRING. MariaDB rejects the whole 500-row
/// batch for one of these, so it has to be dropped here.
#[test]
fn a_way_with_one_vertex_is_dropped() {
    let el = json!({"type": "way", "id": 6, "tags": {"highway": "service"},
                    "geometry": [{"lat": 51.5, "lon": -0.1}]});
    assert_eq!(parse_element(&el), None);
}

/// WKT is `lon lat`. Swapped, distances come out wrong and entirely plausible.
#[test]
fn wkt_is_written_longitude_first() {
    let node = json!({"type": "node", "id": 8, "lat": 51.5, "lon": -0.1,
                      "tags": {"amenity": "cafe"}});
    assert_eq!(
        parse_element(&node).expect("node").geom_wkt,
        "POINT(-0.1 51.5)"
    );
    let way = json!({"type": "way", "id": 9, "tags": {"waterway": "river"},
                     "geometry": [{"lat": 51.5, "lon": -0.1}, {"lat": 51.6, "lon": -0.2}]});
    assert_eq!(
        parse_element(&way).expect("way").geom_wkt,
        "LINESTRING(-0.1 51.5,-0.2 51.6)"
    );
}

/// An element with no tag we bucket is not an error — Overpass returns plenty.
#[test]
fn an_untagged_element_is_skipped_rather_than_failing() {
    assert_eq!(
        parse_element(&json!({"type": "node", "id": 10, "lat": 1.0, "lon": 2.0})),
        None
    );
    assert_eq!(
        parse_element(&json!({"type": "relation", "id": 11, "tags": {"highway": "x"}})),
        None
    );
}

/// ⚠ OVERPASS WRITES `(south, west, north, east)` — the opposite pairing from
/// the WKT three functions away in the same module.
#[test]
fn the_query_bbox_is_south_west_north_east() {
    let b = Bbox {
        min_lat: 51.0,
        max_lat: 52.0,
        min_lon: -1.0,
        max_lon: 1.0,
    };
    let q = overpass_query("highway", &b).expect("a known bucket");
    assert!(q.contains("(51,-1,52,1)"), "{q}");
    assert!(q.starts_with("[out:json][timeout:25];"), "{q}");
    assert!(q.trim_end().ends_with("out tags geom;"), "{q}");
}

#[test]
fn an_unknown_bucket_has_no_query_rather_than_an_empty_one() {
    let b = Bbox {
        min_lat: 51.0,
        max_lat: 52.0,
        min_lon: -1.0,
        max_lon: 1.0,
    };
    assert!(overpass_query("not_a_bucket", &b).is_err());
    for bucket in BUCKETS {
        assert!(overpass_query(bucket, &b).is_ok(), "{bucket} has no filter");
    }
}

/// ⚠ THE REASON THE BOX IS SIZED TO THE QUESTION. `osm_covered` asks whether
/// the search disc lies inside SOME SINGLE box, so a fetch narrower than the
/// question leaves it uncovered and re-queued on the next fold — forever.
/// Measured over the 44 golden days, the walk disc reaches 1832 m.
#[test]
fn a_box_is_never_narrower_than_the_question_that_provoked_it() {
    for radius in [50.0, 369.0, 940.0, 1832.0] {
        for bucket in ["highway", "building"] {
            let w = half_width_for(bucket, radius).expect("inside the cap");
            assert!(w >= radius, "{bucket} r={radius} got {w}");
        }
    }
}

/// The TypeScript's floors survive as floors: a 50 m question still fetches a
/// neighbourhood, so one box answers the next street too.
#[test]
fn a_small_question_still_fetches_the_typescripts_box() {
    assert_eq!(half_width_for("highway", 50.0).expect("ok"), 5000.0);
    assert_eq!(half_width_for("building", 50.0).expect("ok"), 500.0);
}

/// ⚠ REFUSED, NOT UNDER-FETCHED. Silently fetching less would write a coverage
/// row that does not answer the question it was written for.
#[test]
fn a_question_past_the_cap_is_refused_and_says_why() {
    let e = half_width_for("building", 9_000.0).expect_err("past the building cap");
    let msg = e.to_string();
    assert!(msg.contains("cap"), "{msg}");
    assert!(msg.contains("re-queued"), "{msg}");
    assert!(half_width_for("highway", 9_000.0).is_ok());
}

/// The box is centred on the point and symmetric in metres, so the longitude
/// half-width is WIDER in degrees than the latitude one at London's latitude.
#[test]
fn the_box_is_centred_and_wider_in_longitude_degrees() {
    let b = fetch_bbox_around(51.5, -0.1, 5000.0);
    assert!((b.min_lat + b.max_lat) / 2.0 - 51.5 < 1e-9);
    assert!((b.min_lon + b.max_lon) / 2.0 + 0.1 < 1e-9);
    let d_lat = b.max_lat - b.min_lat;
    let d_lon = b.max_lon - b.min_lon;
    assert!(d_lon > d_lat, "lat {d_lat} lon {d_lon}");
}

/// ⚠ THE KEY IS THE QUESTION, at full precision. A rounded one records a
/// decline against a question nobody asks, and the real one is then answered.
#[test]
fn a_queue_key_round_trips_at_full_precision() {
    let (lat, lon, r) = (51.656_213_71, -0.396_481_27, 1832.0);
    assert_eq!(
        parse_queue_key(&queue_key(lat, lon, r)),
        Some((lat, lon, r))
    );
}

#[test]
fn a_key_that_is_not_three_numbers_is_refused() {
    assert_eq!(parse_queue_key("51.5|-0.1"), None);
    assert_eq!(parse_queue_key("51.5|-0.1|50|7"), None);
    assert_eq!(parse_queue_key("51.5|here|50"), None);
}

/// ⚠ NAMESPACED, so the Overpass kinds cannot be confused with the geocode
/// drain's `nominatim_z<n>` rows in the same table (#1076).
#[test]
fn a_kind_round_trips_and_a_geocode_kind_is_not_one_of_ours() {
    for bucket in BUCKETS {
        assert_eq!(bucket_of(&queue_kind(bucket)), Some(bucket));
    }
    assert_eq!(bucket_of("nominatim_z16"), None);
    assert_eq!(bucket_of("osm_not_a_bucket"), None);
}
