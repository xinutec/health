//! Per-minute rail/road proximity across the FFI (#982, #238).
//!
//! ⚠ THE POINT OF THIS FILE IS THE SEAM, not the arithmetic. `railRoadDistFromWays`,
//! the median, the ~11 m key and the join all have `#guard`s in
//! `Verified/Hsmm/RailRoadProximity.lean` and are not re-checked here. What only a
//! round trip can check is that the two modes agree with each other and with
//! `assemblesegments` about the ENCODING and the FIELD ORDER — and that is exactly
//! the class of defect that shipped a decode-day which could never decode a day.

use backend::fold_payload::bits;
use backend::lean::{self, ProximityAnswer};

fn setup() {
    lean::init().expect("the Lean runtime must start");
}

const T0: i64 = 1_000_000;
const T1: i64 = T0 + 1440 * 60;

fn way(kind: &str, subtype: &str, d: f64) -> serde_json::Value {
    serde_json::json!({ "type": kind, "subtype": subtype, "name": null, "distanceM": bits(d) })
}

/// ⚠ ONE QUERY PER ~11 m, NOT ONE PER FIX. This is the whole cost argument: a
/// stationary day is hundreds of minutes at one place, and without the collapse
/// each of them would be its own five-query OSM fan-out.
#[test]
fn a_stationary_hour_costs_one_osm_query() {
    setup();
    let pts: Vec<(i64, f64, f64)> = (0..60)
        .map(|m| (T0 + m * 60 + 5, 51.512_300 + (m as f64) * 1e-7, -0.1))
        .collect();
    let plan = lean::proximity_queries(T0, T1, &pts).unwrap();
    assert_eq!(
        plan.minutes.as_array().unwrap().len(),
        60,
        "every minute with a fix is still a minute"
    );
    assert_eq!(plan.queries.len(), 1, "but they share one location");
}

/// ⚠ A FIX OUTSIDE THE LOCAL DAY IS DROPPED, NOT CLAMPED. Clamped, yesterday's
/// 23:59 fix becomes this day's minute 0 and gives the day a starting location it
/// never had.
#[test]
fn fixes_outside_the_day_produce_no_minutes() {
    setup();
    let plan = lean::proximity_queries(T0, T1, &[(T0 - 1, 51.5, -0.1), (T1, 51.5, -0.1)]).unwrap();
    assert!(plan.minutes.as_array().unwrap().is_empty());
    assert!(plan.queries.is_empty());
}

/// ⚠ THE ROW IS `[ts, road, rail]` AND THE STRUCT NAMES RAIL FIRST. Swapping them
/// compiles, decodes, and puts every fix on a road — which is precisely the
/// evidence the decoder uses to refuse a tube line. Nothing but an exact
/// assertion catches it.
#[test]
fn the_table_is_ts_then_road_then_rail() {
    setup();
    let plan = lean::proximity_queries(T0, T1, &[(T0 + 5, 51.5, -0.1)]).unwrap();
    let q = &plan.queries[0];
    let answers = vec![ProximityAnswer::new(
        q,
        vec![
            way("highway", "primary", 30.0),
            way("railway", "rail", 12.0),
        ],
    )];
    let (table, unanswered) = lean::proximity_table(&plan.minutes, &answers).unwrap();
    assert_eq!(unanswered, 0);
    assert_eq!(
        table,
        serde_json::json!([[T0, bits(30.0), bits(12.0)]]),
        "road is element 1 and rail element 2"
    );
}

/// ⚠ A DECLINED QUERY IS COUNTED, NOT INVENTED. `nearby_ways` answering `None`
/// means the mirror could not vouch for the coordinate; sending it back as an
/// empty way list would tell the decoder there is no railway within 300 m, which
/// is evidence against rail rather than the absence of evidence (#976).
#[test]
fn a_declined_query_leaves_no_row_and_is_counted() {
    setup();
    let plan =
        lean::proximity_queries(T0, T1, &[(T0 + 5, 51.5, -0.1), (T0 + 65, 52.9, -0.1)]).unwrap();
    assert_eq!(plan.queries.len(), 2);
    // Only the first query is answered — the second is what a decline looks like.
    let answers = vec![ProximityAnswer::new(
        &plan.queries[0],
        vec![way("railway", "rail", 12.0)],
    )];
    let (table, unanswered) = lean::proximity_table(&plan.minutes, &answers).unwrap();
    assert_eq!(table, serde_json::json!([[T0, null, bits(12.0)]]));
    assert_eq!(unanswered, 1);
}

/// An answered query with nothing in range is NOT a decline: no row either way,
/// but `unanswered` is what tells the two apart in a log line.
#[test]
fn an_empty_neighbourhood_is_answered() {
    setup();
    let plan = lean::proximity_queries(T0, T1, &[(T0 + 5, 51.5, -0.1)]).unwrap();
    let answers = vec![ProximityAnswer::new(&plan.queries[0], vec![])];
    let (table, unanswered) = lean::proximity_table(&plan.minutes, &answers).unwrap();
    assert_eq!(table, serde_json::json!([]));
    assert_eq!(unanswered, 0, "asked and answered, just empty");
}

/// ⚠ THE TWO MODES AND THE DECODER MUST AGREE ABOUT THE ENCODING. `proximitytable`
/// writes bit patterns so a distance is the one the TypeScript compared rather
/// than the one a JSON decimal survived; `assemblesegments` had only ever been
/// handed plain numbers. This is the only test that runs the real table into the
/// real decoder.
#[test]
fn the_table_feeds_assemblesegments_unread() {
    setup();
    let pts: Vec<(i64, f64, f64)> = (0..3)
        .map(|m| (T0 + m * 60 + 30, 51.5 + (m as f64) * 0.001, -0.1))
        .collect();
    let plan = lean::proximity_queries(T0, T1, &pts).unwrap();
    let answers: Vec<_> = plan
        .queries
        .iter()
        .map(|q| ProximityAnswer::new(q, vec![way("railway", "subway", 1e-7)]))
        .collect();
    let (table, _) = lean::proximity_table(&plan.minutes, &answers).unwrap();
    // ⚠ 1e-7 is the reason for the bit patterns: it is exactly the value that a
    // decimal round trip is not obliged to preserve.
    assert!(
        table.to_string().contains(&bits(1e-7)),
        "the table must carry the bit pattern, got {table}"
    );

    let segs = lean::assemble_segments(&serde_json::json!({
        "observation": {
            "startUtc": T0,
            "points": pts.iter().map(|(ts, lat, lon)| serde_json::json!({
                "ts": ts, "lat": lat, "lon": lon, "speedKmh": 0.0
            })).collect::<Vec<_>>(),
            "hr": [], "steps": [], "sleep": [],
            "localCtx": (0..1440).map(|m| [(m / 60) % 24, 1]).collect::<Vec<_>>(),
            "proximity": table,
            "imputeCadence": true,
        },
        "edges": [], "places": [], "nodes": null, "continuity": null,
        "flags": { "reacquireRobust": true, "segEvidence": true, "chainContext": true },
        "maxD": 30,
    }))
    .expect("the decoder must accept the table this pipeline produces")
    .expect("a viable path");
    assert!(!segs.as_array().unwrap().is_empty());
}

/// ⚠ `gpsoutliers` HAD NO RUST CALLER UNTIL THE DECODE PATH NEEDED IT — a #1003
/// orphan one function away from the code that had to have it. The Lean guards
/// cover the filter; this covers that the wire round trip reaches it at all, and
/// that a fix survives it BIT-EXACT rather than through a decimal rendering.
#[test]
fn the_outlier_filter_is_reachable_and_exact() {
    use backend::lean::GpsFix;
    let fix = |ts: i64, lat: f64, lon: f64| GpsFix {
        ts,
        lat,
        lon,
        speed_kmh: 0.0,
    };
    setup();
    // Six clustered fixes and one 55 km teleport, the shape of the Lean guard.
    let day = vec![
        fix(0, 51.5, -0.1),
        fix(60, 51.501, -0.101),
        fix(120, 51.499_5, -0.099_8),
        fix(180, 52.0, -0.5),
        fix(240, 51.500_5, -0.100_2),
        fix(300, 51.500_100_000_000_01, -0.099_9),
        fix(360, 51.499_8, -0.100_1),
    ];
    let kept = backend::lean::drop_gps_outliers(&day).unwrap();
    assert_eq!(
        kept.iter().map(|p| p.ts).collect::<Vec<_>>(),
        vec![0, 60, 120, 240, 300, 360],
        "the teleport at 180 must be the only fix dropped"
    );
    // ⚠ THE LAST DIGIT MATTERS. The filter is a passthrough for what it keeps,
    // so a coordinate that changed here would be a transport defect and would
    // shift every downstream median by an invisible amount.
    assert_eq!(kept[4].lat, 51.500_100_000_000_01);
}

/// ⚠ AN EMPTY DAY IS AN EMPTY ANSWER, NOT A FAILURE. A day with no fixes still
/// has to decode; if this threw, every gap in the phone's history would become a
/// failed cron run.
#[test]
fn a_day_with_no_fixes_asks_nothing() {
    setup();
    assert!(backend::lean::drop_gps_outliers(&[]).unwrap().is_empty());
    let plan = lean::proximity_queries(T0, T1, &[]).unwrap();
    assert!(plan.queries.is_empty());
    let (table, unanswered) = lean::proximity_table(&plan.minutes, &[]).unwrap();
    assert_eq!(table, serde_json::json!([]));
    assert_eq!(unanswered, 0);
}
