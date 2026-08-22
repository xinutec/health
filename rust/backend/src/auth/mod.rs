//! Authentication: the crypto and the storage (#982).
//!
//! ⚠ THE RULES ARE NOT HERE. When a session has expired, how a signed cookie is
//! framed, and what a share recipient may do are `Verified.Session`, reached
//! through `crate::lean`. What is in this module is the part a Lean model of
//! would be fiction — an HMAC, a CSPRNG, a constant-time compare — plus the
//! table reads and writes around them.
//!
//! `src/share/token.ts` is the worked example of that split and `lib.rs`
//! records it: `generateShareToken` reads the CSPRNG and stays shell;
//! `shareableDateRange` is a total function of its arguments and went to Lean.

pub mod session;
pub mod share;
