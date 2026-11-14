//! Authentication: the crypto and the storage.
//!
//! The rules are not here. When a session has expired, how a signed cookie is
//! framed, and what a share recipient may do are `Verified.Session`, reached
//! through `crate::lean`. What is in this module is the part a Lean model of
//! would be fiction — an HMAC, a CSPRNG, a constant-time compare — plus the
//! table reads and writes around them.
//!
//! Share tokens are the worked example of that split: generating one reads the
//! CSPRNG and is shell; `shareableDateRange` is a total function of its
//! arguments and is Lean's.

pub mod middleware;
pub mod session;
pub mod share;
