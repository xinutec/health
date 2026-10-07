//! Slow numeric conversions in compiled Lean, held to a baseline.
//!
//! # What it catches
//!
//! Three things Lean compiles to arbitrary-precision (GMP) work on EVERY
//! evaluation, each of which has cost the walk matcher or the decoder build
//! real time:
//!
//!   * `lean_float_of_nat(` — `Nat.toFloat` is `Float.ofScientific n false 0`,
//!     the generic literal path, not a cast. Use `Verified.FloatConst.natToFloat`.
//!   * `lean_cstr_to_nat(` — a `Nat`/`UInt64` literal ≥ 2^32 is parsed from a
//!     decimal string each time. Hoist it to a module-level `@[noinline] def`
//!     (a literal-bodied `def` without it is inlined back).
//!   * `l_Float_ofScientific(` — a `Float` literal inside a loop body or a
//!     branch is rebuilt per pass. Hoist it to a module-level `def`.
//!
//! The generated C says exactly where each happens; a function whose name
//! contains `_init_` runs once and is not counted. The check reads
//! `lean/.lake/build/ir/**/*.c`, so it runs after something has built the Lean
//! (the Rust tests do, through `build.rs`).
//!
//! # The baseline
//!
//! `lean/gmp-hotpaths.baseline` lists today's sites, most of them in cold code.
//! It is held EXACT: a new site, or more of an existing one, fails and names
//! the function; a site that went away also fails, so the list shrinks with the
//! code instead of keeping stale excuses. After judging a change —
//! fixed it, or it is genuinely cold — rewrite the list with
//! `GMP_HOTPATHS_BLESS=1`.
//!
//! Generated names carry specialisation counters and hygiene hashes that move
//! with unrelated edits; they are normalised (digits after `spec__`, `lam__`,
//! `closed__`, `hyg_` become `N`, and any run of six or more digits becomes
//! `H`) so the baseline names the function, not its build.

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};

const PATTERNS: [&str; 3] = [
    "lean_float_of_nat(",
    "lean_cstr_to_nat(",
    "l_Float_ofScientific(",
];

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../lean")
}

fn c_files(dir: &Path, out: &mut Vec<PathBuf>) -> std::io::Result<()> {
    for e in std::fs::read_dir(dir)? {
        let p = e?.path();
        if p.is_dir() {
            c_files(&p, out)?;
        } else if p.extension().is_some_and(|x| x == "c") {
            out.push(p);
        }
    }
    Ok(())
}

/// The function a C line opens, if it opens one: Lean emits each definition's
/// signature on one line ending in `{`.
fn opens_function(line: &str) -> Option<&str> {
    // `{` alone at column 0 opens a block inside a body, not a function.
    if line.starts_with(' ')
        || line.starts_with('\t')
        || !line.ends_with('{')
        || !line.contains('(')
    {
        return None;
    }
    let head = line.split('(').next()?;
    head.rsplit([' ', '*']).next().filter(|n| !n.is_empty())
}

/// A forward declaration at file scope — `double l_Float_ofScientific(lean_object*, …);`
/// — names the function without calling it. Every file that uses one declares it
/// once, so counting declarations would charge each file a phantom site.
fn is_declaration(line: &str) -> bool {
    !line.starts_with(' ')
        && !line.starts_with('\t')
        && line.ends_with(");")
        && !line.contains('=')
        && !line.starts_with("return")
}

fn normalise(name: &str) -> String {
    let mut out = String::new();
    let b = name.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i].is_ascii_digit() {
            let start = i;
            while i < b.len() && b[i].is_ascii_digit() {
                i += 1;
            }
            let after_counter = ["spec__", "lam__", "closed__", "hyg_"]
                .iter()
                .any(|m| out.ends_with(m));
            if i - start >= 6 {
                out.push('H');
            } else if after_counter {
                out.push('N');
            } else {
                out.push_str(&name[start..i]);
            }
        } else {
            out.push(b[i] as char);
            i += 1;
        }
    }
    out
}

fn main() -> std::process::ExitCode {
    let ir = root().join(".lake/build/ir");
    let mut files = Vec::new();
    if let Err(e) = c_files(&ir, &mut files) {
        eprintln!(
            "lean_gmp_hotpaths: cannot read {} ({e}) — build the Lean first",
            ir.display()
        );
        return std::process::ExitCode::from(2);
    }
    files.sort();
    // (module, function, pattern) -> count
    let mut now: BTreeMap<(String, String, &str), u32> = BTreeMap::new();
    for f in &files {
        let Ok(text) = std::fs::read_to_string(f) else {
            continue;
        };
        let module = f.strip_prefix(&ir).unwrap_or(f).display().to_string();
        let mut func = String::new();
        for line in text.lines() {
            if let Some(n) = opens_function(line) {
                func = normalise(n);
            }
            if func.contains("_init_") || is_declaration(line) {
                continue;
            }
            for p in PATTERNS {
                let k = line.matches(p).count();
                if k > 0 {
                    *now.entry((module.clone(), func.clone(), p)).or_default() +=
                        u32::try_from(k).unwrap_or(u32::MAX);
                }
            }
        }
    }
    let path = root().join("gmp-hotpaths.baseline");
    let render = |m: &BTreeMap<(String, String, &str), u32>| {
        let mut s = String::from(
            "# Slow numeric conversions in compiled Lean, by module and function.\n\
             # Written by `GMP_HOTPATHS_BLESS=1 cargo run --example lean_gmp_hotpaths`;\n\
             # see that example for what each pattern costs and how to remove it.\n",
        );
        for ((module, func, p), n) in m {
            let _ = writeln!(s, "{n}\t{p}\t{module}\t{func}");
        }
        s
    };
    if std::env::var_os("GMP_HOTPATHS_BLESS").is_some() {
        if let Err(e) = std::fs::write(&path, render(&now)) {
            eprintln!("lean_gmp_hotpaths: writing {}: {e}", path.display());
            return std::process::ExitCode::from(2);
        }
        println!(
            "lean_gmp_hotpaths: blessed {} site(s) into {}",
            now.len(),
            path.display()
        );
        return std::process::ExitCode::SUCCESS;
    }
    let mut was: BTreeMap<(String, String, String), u32> = BTreeMap::new();
    for line in std::fs::read_to_string(&path).unwrap_or_default().lines() {
        if line.starts_with('#') || line.is_empty() {
            continue;
        }
        let f: Vec<&str> = line.splitn(4, '\t').collect();
        if let [n, p, m, func] = f[..] {
            was.insert(
                (m.to_string(), func.to_string(), p.to_string()),
                n.parse().unwrap_or(0),
            );
        }
    }
    let mut grew = Vec::new();
    let mut shrank = Vec::new();
    for ((m, func, p), n) in &now {
        let before = was
            .get(&(m.clone(), func.clone(), (*p).to_string()))
            .copied()
            .unwrap_or(0);
        if *n > before {
            grew.push(format!("  {p} ×{n} (was {before})  {m}  {func}"));
        } else if *n < before {
            shrank.push(format!("  {p} ×{n} (was {before})  {m}  {func}"));
        }
    }
    for ((m, func, p), before) in &was {
        if !now
            .keys()
            .any(|(m2, f2, p2)| m2 == m && f2 == func && p2 == p)
        {
            shrank.push(format!("  {p} gone (was {before})  {m}  {func}"));
        }
    }
    if grew.is_empty() && shrank.is_empty() {
        println!(
            "lean_gmp_hotpaths: {} site(s), all in the baseline",
            now.len()
        );
        return std::process::ExitCode::SUCCESS;
    }
    if !grew.is_empty() {
        eprintln!(
            "NEW slow numeric conversions in compiled Lean — each runs GMP work on every call:\n{}\n\
             Fix: Nat.toFloat → Verified.FloatConst.natToFloat; a literal ≥ 2^32 → a module-level \
             @[noinline] def; a Float literal in a loop or branch → a module-level def. If the site \
             is genuinely cold, re-bless with GMP_HOTPATHS_BLESS=1.",
            grew.join("\n")
        );
    }
    if !shrank.is_empty() {
        eprintln!(
            "Sites left the code but not the baseline — re-bless with GMP_HOTPATHS_BLESS=1 so the \
             list shrinks with them:\n{}",
            shrank.join("\n")
        );
    }
    std::process::ExitCode::FAILURE
}
