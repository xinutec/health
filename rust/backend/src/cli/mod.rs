//! The subcommands behind `backend <subcommand>`, grouped by what they touch;
//! the dispatch itself is in `main.rs`.

pub(crate) mod census;
pub(crate) mod day;
pub(crate) mod decode;
pub(crate) mod google;
pub(crate) mod mirror;
pub(crate) mod refresh;
pub(crate) mod session;
