//! The backend: IO glue around the verified Lean core: configuration, the
//! pool, the cursor store, HTTP routes, ingestion and the entrypoint.
//!
//! Nothing here decides anything. The user's rule: *"Logic should be in Lean.
//! A bit of IO glue needs to be in Rust."* A rule about what a day means or when
//! a segment is a walk belongs in Lean, even at three lines.
//!
//! Share links are the example: minting a token reads the CSPRNG (Rust); the
//! URL, the date range and the days-back clamp are total functions
//! (`Verified/Share.lean`).

pub mod argv;
pub mod auth;
pub mod classification_inputs;
pub mod config;
pub mod db;
pub mod decode_fixture;
pub mod decode_freshness;
pub mod decoder_params;
pub mod error;
pub mod fetch_drain;
pub mod fetch_queue;
pub mod fold;
pub mod fold_payload;
pub mod freshness;
pub mod google;
pub mod head;
pub mod lean;
pub mod lean_worker;
pub mod location_cache;
pub mod mirror_source;
pub mod nextcloud;
pub mod nominatim;
pub mod osm_mirror;
pub mod osm_trace;
pub mod overpass;
pub mod rail_route;
pub mod rest_hr;
pub mod routes;
pub mod row_json;
pub mod rows_check;
pub mod rowset_answerer;
pub mod rowset_capture;
pub mod schema;
pub mod state;
pub mod sync_state;
pub mod timezone;
pub mod tz_lookup;
pub mod velocity_cache;
pub mod walk_memo;
pub mod watch_battery;
