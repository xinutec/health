//! Every integration test that does not need a binary of its own.
//!
//! One binary for build time: each test binary statically links the Lean
//! runtime (~58 MB), and a change to `backend` relinks every one, ~4.3 s each.
//! The tests themselves are cheap. `nextest` runs one process per test, so
//! isolation is unchanged; `cargo test` would share a process, which is why the
//! corpus shards stay out.
//!
//! ⚠ These binaries stay separate because something selects them by name and
//! would silently stop if they moved:
//!
//! * `corpus_gate`, `hsmm_decode_corpus` — the release row's `--test`
//!   arguments, `scripts/deploy.sh`, `scripts/venue-prior-drift.sh`
//! * `frontend_unions` — its own gate row
//! * `decoder_scoreboard` — `scripts/deploy.sh`
//! * `lean_serve` — `examples/mode_reachability.rs`'s `PROBES`, which
//!   attributes mode calls by `current_exe()`
//!
//! Before merging another, grep its name across the whole repo, Rust included.
//! Adding a file here is free; a sibling binary costs ~4.3 s per Rust change.

mod api_window;
mod assemble_observation;
mod auth_middleware;
mod battery;
mod bio_labels;
mod bits_wire;
mod bus_route_reach;
mod capture_inputs_stamp;
mod classification_inputs;
mod clip_future;
mod compression;
mod config;
mod connection_status;
mod date_bounds;
mod day_route;
mod decode_freshness;
mod decode_request;
mod decode_window;
mod decoder_params;
mod fetch_drain;
mod focus_mining;
mod focus_places;
mod fold_env;
mod fold_payload;
mod fold_slot;
mod freshness;
mod geocode_wire;
mod google_payload_helpers;
mod google_probe;
mod google_rollup;
mod google_source;
mod google_weight;
mod ground_truth_corpus;
mod js_number_wire;
mod landmark_shaping;
mod lean_ffi;
mod local_time;
mod location_tail;
mod log_line;
mod login_rules;
mod minute_proximity;
mod mirror_coverage;
mod mirror_source;
mod nominatim;
mod osm_coverage;
mod osm_mirror;
mod osm_trace;
mod overpass;
mod overpass_extract;
mod overpass_plan;
mod overpass_status;
mod owntracks_rules;
mod phonetrack_parse;
mod phonetrack_split;
mod polygon_lookup;
mod priors_as_of;
mod rail_fill;
mod rail_relation;
mod rail_route_admission;
mod rail_snap;
mod recovery_rules;
mod render_segments;
mod rest_hr;
mod row_json;
mod row_source;
mod rowset_prefilter;
mod session_crypto;
mod session_rules;
mod share_route;
mod share_wire_shape;
mod sleep_stub_guard;
mod static_serving;
mod station_chain;
mod stations_on_line;
mod timezone;
mod usage;
mod velocity_cache;
mod velocity_cache_store;
mod velocity_episode_bits;
mod velocity_route;
mod venue_rank_probe;
mod walk_memo;
mod watch_battery;

/// The shipped decoder's record on a synthetic request, as `decode-day` lays
/// it on a real one: the decoder refuses a request without its record.
fn with_record(mut r: serde_json::Value) -> serde_json::Value {
    if let Some(p) = backend::decoder_params::from_env("2026-01-01").expect("the record reads") {
        backend::decoder_params::apply(&mut r, &p).expect("the record is whole");
    }
    r
}
