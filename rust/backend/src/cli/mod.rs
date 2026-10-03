//! The subcommands behind `backend <subcommand>`, grouped by what they touch;
//! the dispatch itself is in `main.rs`.

pub(crate) mod census;
pub(crate) mod day;
pub(crate) mod decode;
pub(crate) mod google;
pub(crate) mod mirror;
pub(crate) mod refresh;
pub(crate) mod session;

/// Logs to stderr at `info`, or whatever `RUST_LOG` says. Every long-running or
/// library-driven subcommand calls this once; the library speaks `tracing` and a
/// process that never installed a subscriber drops every line it says.
pub(crate) fn init_tracing() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();
}
