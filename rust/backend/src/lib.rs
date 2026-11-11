//! The backend: IO glue around the verified Lean core.
//!
//! # What this is, and what it is not
//!
//! The user's rule: *"We want no TS backend. Logic should be in Lean. A bit of
//! IO glue needs to be in Rust."* This crate is the IO glue: configuration, a
//! connection pool, the cursor store, the HTTP routes, the ingestion, and the
//! entrypoint that ties them together. **Nothing here decides anything.** If a
//! module in this crate grows a rule about what a day means or when a segment
//! is a walk, that rule belongs in Lean and its presence here is the bug.
//!
//! # The Lean/Rust line, drawn by example
//!
//! *"Anything that can be in Lean should be in Lean."* Share links are the
//! worked example and the shape to copy; the split is not 50/50 and was not a
//! judgement call:
//!
//!   * generating a share token reads the CSPRNG → **Rust**. There is nothing
//!     to prove about 32 random bytes beyond that they were asked for, and a
//!     Lean model of them would be fiction.
//!   * building the share URL, the shareable date range and the clamp on days
//!     back are total functions of their arguments → **Lean**
//!     (`Verified/Share.lean`), on top of `Verified/Civil.lean`.
//!
//! The test to apply at each module: *does this decide anything, or does it
//! only move bytes?* Deciding goes to Lean even when it is three lines, because
//! three lines is exactly the size at which a wrong clamp survives review.

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
