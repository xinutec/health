//! The Rust backend skeleton (#982).
//!
//! # What this is, and what it is NOT
//!
//! The user, 2026-08-17: *"We want no TS backend. Logic should be in Lean. A bit
//! of IO glue needs to be in Rust."* This crate is the IO glue — configuration,
//! a connection pool, the cursor store, and the entrypoint that ties them
//! together. **Nothing here decides anything.** If a module in this crate grows
//! a rule about what a day means or when a segment is a walk, that rule belongs
//! in Lean and its presence here is the bug.
//!
//! # ⚠ THE PLAN THIS HEADER USED TO DESCRIBE HAS COMPLETED
//!
//! ⚠ KEEP THE SECTIONS BELOW IN THE PRESENT TENSE. Written as plans they
//! outlive the plan and tell a reader the opposite of what is live.
//!
//! Where it stands:
//!
//!   * the TS↔Lean per-tenant A/B retired with the TypeScript backend (#975,
//!     2026-08-26). `state.rs` still names `setVerifiedCoreOverride`; that
//!     symbol exists nowhere but in prose.
//!   * this crate serves `/api` — see `routes/`, which answers `/api/me`,
//!     `/api/locations` and the biometric tables. `dist/server.js` is gone.
//!   * the ingestion IS Rust, and the Fitbit→Google cutover it was written for
//!     landed and was verified in prod on 2026-09-01 (#260).
//!
//! The paragraph below is kept because the RULE it states outlived the plan.
//!
//! # The Lean/Rust line, drawn by example
//!
//! The user, 2026-08-17: *"anything that can be in Lean should be in Lean."*
//! `token.ts` is the worked example and the shape to copy. Four
//! functions; the split is not 50/50 and was not a judgement call:
//!
//!   * `generateShareToken` reads the CSPRNG → **Rust**. There is nothing to
//!     prove about `randomBytes(32)` beyond that it was asked for 32 bytes, and
//!     a Lean model of it would be fiction.
//!   * `buildShareUrl`, `shareableDateRange`, `clampShareDaysBack` are total
//!     functions of their arguments → **Lean** (`Verified/Share.lean`), on top
//!     of `Verified/Civil.lean`.
//!
//! The test to apply at each module: *does this decide anything, or does it
//! only move bytes?* Deciding goes to Lean even when it is three lines, because
//! three lines is exactly the size at which a wrong clamp survives review.

pub mod argv;
pub mod auth;
pub mod backfill;
pub mod classification_inputs;
pub mod config;
pub mod db;
pub mod decode_fixture;
pub mod error;
pub mod fetch_drain;
pub mod fetch_queue;
pub mod fitbit;
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
pub mod velocity_cache;
pub mod walk_memo;
