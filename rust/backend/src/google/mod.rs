//! Google Health: OAuth, the feeds, and the weight reconciliation. The scale
//! reaches Google (Hume → Health Connect → Google Health); the legacy Fitbit
//! weight series was forward-filled and froze, a flat line that looks like a
//! stable weight.

pub mod archive;
pub mod body;
pub mod exercise;
pub mod health;
pub mod oauth;
pub mod probe;
pub mod routes;
pub mod run;
pub mod source;
pub mod sync;
