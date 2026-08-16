//! Link the Lean fold into this binary.
//!
//! # The link line is READ, never restated
//!
//! Lean's own link line is nine libraries plus two nix store paths that move on
//! every `nix flake update`. Copying it here would be a second copy of a thing
//! that drifts silently — the exact defect `scripts/day-gate-smoke.sh` was
//! written twice to avoid, where a guessed layout made a check reach nothing and
//! pass. So this parses `verified_cli.rsp`, which lake WROTE when it linked the
//! real binary: whatever links the CLI links this.
//!
//! The `.rsp` lists the object files first and the flags after. The objects are
//! dropped — we link the static libs instead, which is the same code with an
//! archive index — and everything else passes through untouched.

use std::path::{Path, PathBuf};
use std::process::Command;

/// Re-emit `libverified_Main.a`'s single object with Lean's own `main` made
/// local, and return the path to it.
///
/// `Main.c.o.export` defines BOTH `initialize_verified_Main` — which the host
/// must call — and `main`, which Lean's compiler emits because `Main.lean`
/// declares one. Linking the archive as-is gives two `_main` definitions, and
/// the resolution is silent: the first attempt here linked, ran, printed
/// well-formed JSON and exited 1, because LEAN's `main` had won and parsed the
/// request as a decoder model. Nothing about that output said the host had not
/// run. The `init=...ms` line this binary prints to stderr exists to make that
/// failure visible rather than plausible.
///
/// `ld -r` is a partial link: one object in, one object out, with
/// `-unexported_symbol` demoting `_main` to local so it can no longer collide.
///
/// This is a workaround for a layout problem, not a fix for it. The fix is for
/// the day entry point to live in the `Verified` LIBRARY rather than in the
/// executable's root module — see #952. Until then, a host that links the exe's
/// object has to do something about the exe's entry point.
fn hide_lean_main(archive: &Path) -> PathBuf {
	let out = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR"));
	let extracted = out.join("Main.c.o.export");
	let hidden = out.join("main_hidden.o");

	let st = Command::new("ar")
		.arg("x")
		.arg(archive)
		.arg("Main.c.o.export")
		.current_dir(&out)
		.status()
		.expect("run ar");
	assert!(st.success(), "ar x failed on {}", archive.display());

	let st = Command::new("ld")
		.args(["-r", "-o"])
		.arg(&hidden)
		.arg(&extracted)
		.args(["-unexported_symbol", "_main"])
		.status()
		.expect("run ld -r");
	assert!(st.success(), "ld -r failed");

	// Checked, because the whole point is that a silent failure here is
	// indistinguishable from success at run time.
	let syms = Command::new("nm").arg("-g").arg(&hidden).output().expect("run nm");
	let syms = String::from_utf8_lossy(&syms.stdout);
	assert!(
		!syms.lines().any(|l| l.ends_with(" _main")),
		"ld -r left _main global; the host would silently run Lean's entry point"
	);
	assert!(
		syms.lines().any(|l| l.ends_with(" _initialize_verified_Main")),
		"ld -r dropped _initialize_verified_Main; the fold could not be initialised"
	);
	hidden
}

fn main() {
	let lean_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../lean");
	let build = lean_dir.join(".lake/build");
	let rsp = build.join("bin/verified_cli.rsp");

	// Both static libs and the rsp come from lake, and a stale or absent one is
	// the difference between "this host is wrong" and "this host was never
	// built". Say which, rather than letting the linker say neither.
	let libs = [
		build.join("lib/libverified_Main.a"),
		build.join("lib/libverified_Verified.a"),
	];
	for p in libs.iter().chain(std::iter::once(&rsp)) {
		if !p.exists() {
			panic!(
				"missing {}\n\
				 Build the Lean side first:\n    \
				 cd lean && lake build verified_cli Main:static Verified:static",
				p.display()
			);
		}
	}

	let text = std::fs::read_to_string(&rsp).expect("read verified_cli.rsp");
	let toks: Vec<String> = text
		.split_whitespace()
		.map(|t| t.trim_matches('"').to_string())
		.filter(|t| !t.is_empty())
		// The compiled modules. We take them from the archives instead, so that
		// the linker drops what the host does not reach.
		.filter(|t| !t.ends_with(".o.export") && !t.ends_with(".o"))
		.collect();

	// Ours FIRST: a static archive only satisfies symbols already undefined when
	// the linker reaches it, so the Lean runtime has to come after the code that
	// calls it.
	println!("cargo:rustc-link-arg={}", hide_lean_main(&libs[0]).display());
	println!("cargo:rustc-link-arg={}", libs[1].display());
	for t in &toks {
		println!("cargo:rustc-link-arg={t}");
	}

	// `lean.h` — the shim includes it, and the prefix is asked for rather than
	// derived from the store path in the rsp, because `--print-prefix` is the
	// question we actually mean.
	let prefix = Command::new("lean")
		.arg("--print-prefix")
		.output()
		.expect("run `lean --print-prefix` (is the dev shell active?)");
	let prefix = String::from_utf8(prefix.stdout).expect("utf8").trim().to_string();

	cc::Build::new()
		.file("src/shim.c")
		.include(Path::new(&prefix).join("include"))
		.compile("health_shell");

	println!("cargo:rerun-if-changed=src/shim.c");
	println!("cargo:rerun-if-changed={}", rsp.display());
	for l in &libs {
		println!("cargo:rerun-if-changed={}", l.display());
	}
}
