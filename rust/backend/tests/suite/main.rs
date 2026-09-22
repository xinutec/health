//! Every integration test that does not need a binary of its own.
//!
//! ⚠ **ONE BINARY, AND THE REASON IS BUILD TIME.** Cargo gives every file in
//! `tests/` its own crate and its own executable, and each of ours statically
//! links the Lean runtime — a mean of 58 MB across 115 of them, 6.5 GB of
//! `target/`. Touching one line in `backend` relinks the lot. Measured
//! 2026-09-13 on a warm tree, one `touch` of `backend/src/lib.rs`:
//!
//! ```text
//! lib + 1 test binary      16 s
//! lib + 112 test binaries  490 s      -> ~4.3 s per binary, all of it link
//! ```
//!
//! The tests themselves are not the cost: 378 of them total 214 s of CPU and
//! 351 finish inside a second. The row was ~90% compilation.
//!
//! ⚠ **ISOLATION IS UNCHANGED.** `nextest` runs one process per TEST, not per
//! binary, so sharing a binary does not share process state — which is what
//! #1560 was about. `cargo test` would thread them together, and that is
//! exactly why the corpus shards below stay out of here.
//!
//! ⚠ **SIX BINARIES ARE DELIBERATELY NOT IN HERE**, because something names
//! each by binary and would silently stop selecting it:
//!
//! * `corpus_gate`, `hsmm_decode_corpus` — the release row's
//!   `--test` arguments, `scripts/deploy.sh`, `scripts/venue-prior-drift.sh`
//! * `frontend_unions` — its own gate row
//! * `decoder_scoreboard` — `scripts/deploy.sh`
//! * `lean_serve` — `examples/mode_reachability.rs`'s `PROBES`
//!
//! ⚠ **`lean_serve` IS THE ONE THAT CAUGHT ME, and it is the instructive one.**
//! The other five are named in a gate row or a shell script, which is where
//! anybody would think to look. This one is named in RUST SOURCE:
//! `mode_reachability` EXCUSES the modes `lean_serve` asks for, because that
//! file exists to probe that dispatch still routes and is indifferent to the
//! answers — it also asks for `nope`, which is not a mode at all. Attribution
//! is by BINARY, since the trace records `current_exe()`, so folding it in here
//! made its probes read as real use and the gate failed with "1 mode(s) were
//! executed but are in no arm this reads: nope".
//!
//! The rule for the next merge: grep the binary's name across the WHOLE repo,
//! not just `gate.dhall` and `scripts/`. A filter keyed on a name fails by
//! selecting the wrong set, never by erroring.
//!
//! Adding a test file here is free; adding one as a sibling costs ~4.3 s on
//! every Rust change in the repo, so do that only when a caller must name it.

mod activity_parse;
mod api_window;
mod assemble_observation;
mod auth_middleware;
mod backfill;
mod backfill_walk;
mod battery;
mod bio_labels;
mod bus_route_reach;
mod capture_inputs_stamp;
mod classification_inputs;
mod clip_inferred;
mod compression;
mod config;
mod connection_status;
mod date_bounds;
mod decode_request;
mod decode_window;
mod feasibility_corpus;
mod focus_mining;
mod focus_places;
mod fold_env;
mod fold_payload;
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
mod rail_snap;
mod recovery_rules;
mod render_segments;
mod row_json;
mod row_source;
mod rowset_prefilter;
mod session_crypto;
mod session_rules;
mod share_route;
mod share_wire_shape;
mod sleep_parse;
mod sleep_stub_guard;
mod static_serving;
mod station_chain;
mod stations_on_line;
mod steps_parse;
mod stream_parse;
mod timezone;
mod tz_source;
mod usage;
mod velocity_cache;
mod velocity_cache_store;
mod velocity_episode_bits;
mod velocity_route;
mod venue_rank_probe;
mod watch_battery;
