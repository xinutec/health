//! Authentication: the crypto and the storage. The rules (expiry, cookie
//! framing, what a share recipient may do) are `Verified.Session`; here are
//! the HMAC, CSPRNG and constant-time compare, and the table reads around them.

pub mod middleware;
pub mod session;
pub mod share;
