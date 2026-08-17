//! The Rust backend skeleton (#982).
//!
//! # What this is, and what it is NOT
//!
//! Pippijn, 2026-08-17: *"We want no TS backend. Logic should be in Lean. A bit
//! of IO glue needs to be in Rust."* This crate is the IO glue — configuration,
//! a connection pool, the cursor store, and the entrypoint that ties them
//! together. **Nothing here decides anything.** If a module in this crate grows
//! a rule about what a day means or when a segment is a walk, that rule belongs
//! in Lean and its presence here is the bug.
//!
//! # Why it exists NOW, ahead of the algorithm port
//!
//! #982 is blocked by #975 — porting the SERVER before the per-tenant A/B
//! retires would mean the Rust service calling into TS logic on its way out.
//! That argument is about the algorithm surface. It does not cover config, a
//! pool, or a cursor table, none of which have a TypeScript algorithm behind
//! them to strand.
//!
//! The reason to build them ahead of the rest is #260: Fitbit's Web API is
//! decommissioned in September 2026, and the call on 2026-08-25 is "skeleton
//! exists → write the new ingestion in Rust; skeleton does not → do it in
//! TypeScript and book the rework". This crate is what makes that a real
//! choice. ⚠ It is NOT a decision that the ingestion goes in Rust — the
//! deadline outranks the architecture there, and that call is Pippijn's.
//!
//! # The order things arrive in
//!
//! `sync` first, because it is the entrypoint with the fewest dependencies on
//! the parts #975 is still moving: it reads and writes its own tables and talks
//! to two HTTP APIs. The HTTP server (`dist/server.js`), its auth surface and
//! the `/api` routes come after the tenants retire, not before.
//!
//! # The Lean/Rust line, drawn by example
//!
//! Pippijn, 2026-08-17: *"anything that can be in Lean should be in Lean."*
//! `src/share/token.ts` is the worked example and the shape to copy. Four
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

pub mod config;
pub mod db;
pub mod error;
pub mod fitbit;
pub mod routes;
pub mod state;
pub mod sync_state;
