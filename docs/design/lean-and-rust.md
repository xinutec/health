# What goes in Lean, what goes in Rust

The rule is one sentence: **decisions go in Lean, IO glue goes in Rust.**

This file exists because that sentence was nowhere in the repository until
2026-09-12, and a rule nobody can read is a rule that erodes.

## ⚠ `src/*.ts` in a comment is PROVENANCE, and the tree is recoverable

Roughly 55 deleted TypeScript files are named in comments across `rust/` and
`lean/` — almost all as "port of `src/geo/osm.ts`" or "transcribed from". **Those
are not dangling pointers and must not be stripped.** The TypeScript was deleted
in #975 and the whole tree is one command away:

    git show 06346bd^:src/geo/osm.ts

That is not hypothetical. On 2026-09-19 the Nominatim client was re-ported by
reading exactly that file, because the cache it wrote is still in production and a
key that disagrees does not fail — it MISSES. A comment naming its origin is what
made recovering the original behaviour possible instead of guessing it.

⚠ What a comment may NOT promise is a LINE NUMBER in a file that no longer
exists. Cite the file; let the reader find the function.

## Rust is here for ecosystem, not for ability

Lean 4 has full `IO`. Nothing in the split is about what Lean can do. What Lean
cannot cheaply *be* is a MariaDB driver, a TLS stack, an HTTP server, or the
IANA timezone database. Measured on 2026-09-12, that is what the Rust
dependencies buy and essentially all they buy:

```text
sqlx                    MariaDB wire protocol
axum / tower            HTTP server
reqwest                 HTTP client + TLS
tokio                   async runtime
hmac sha2 subtle        session and OAuth crypto
chrono-tz               the IANA timezone database
tzf-rs                  geo point -> timezone, bundled index
```

These are the parts where a proof buys nothing and a battle-tested
implementation buys everything. ⚠ Note that `chrono-tz` and `tzf-rs` are DATA,
not logic — "which zone is this point in" is a table lookup, not a rule. That is
the clearest example of something that belongs on the Rust side.

At the time of writing: ~31k lines of Rust `src` against ~73k of Lean.

## What a decision looks like

A threshold applied to a domain quantity. "How long must a dwell last to count
as a visit." "How far can a fix be off before the filter ignores it." "How many
tiles must answer before a refresh may overwrite the cache."

If changing the number changes what the system BELIEVES about the day, it is a
decision and it belongs in Lean, where it can carry `#guard`s.

If changing the number changes only how long something waits, how many rows come
back per page, or which mirror is tried first, it is transport policy and it
belongs in Rust.

⚠ The boundary is not always obvious and the check below does NOT adjudicate it.
When it is genuinely unclear, the tie-breaker is: can it be wrong in a way a
user would notice in their timeline? Then Lean.

## ⚠ THE DRIFT IS A GRADIENT, NOT A DISCIPLINE PROBLEM

Writing a rule AT an IO site costs one line. Writing the same rule in Lean costs
a new entry point, a JSON round-trip and a guard. So rules drift Rustwards, and
they drift for the same reason every time: the person writing one is already in
Rust, already holding the data, and the Lean route is three times the work.

This is not fixed by intending to do better. It was measured on 2026-09-12 and
the session that measured it had itself added three new rules to the Rust side
in two days while the identical kind of rule sat in Lean beside it
(`coverageRefusal` is in Lean; `OverpassBreaker` is in Lean).

Expect the gradient. Budget for it.

## The check, and what it cannot do

`scripts/rules-live-in-lean.sh` (a gate row) refuses a constant name declared in
BOTH `rust/*/src` and `lean/Verified`. Grandfathered names live in
`scripts/rules-live-in-lean.allow`, each with a reason, and that list may only
shrink.

First run, 2026-09-12: **fourteen** shared names. Thirteen were exact duplicates
— same value, two declarations, so changing one and forgetting the other
diverges in silence. The fourteenth was `ACCURACY_CEILING_M`, which was **200.0
in Rust and 80 in Lean**: one name, two unrelated rules, and no way for a reader
of either to know the other existed. It was renamed, not listed.

⚠ **IT CHECKS NAMES, NOT SEMANTICS, AND THAT IS DELIBERATE.** "Is this constant
a rule or is it tuning?" has no oracle. A check needing that judgement argues
with its reader and gets muted, which is how checks die. "Is this name declared
twice?" is decided by the two trees and needs no opinion.

⚠ **IT CANNOT SEE A RULE THAT WAS ONLY EVER WRITTEN IN RUST.** A threshold with
a name Lean never used passes silently — which is exactly the shape of the three
added in the two days before the check existed. This is a ratchet against
divergence and regrowth. It is not a proof that the split is right, and reading
it as one would be worse than having no check at all.

## The seam itself

Four functions, all passing JSON strings:

```rust
fn health_backend_init() -> i32;
fn health_backend_json(input: *const c_char) -> *mut c_char;
fn health_serve_json(input: *const c_char) -> *mut c_char;
fn health_backend_free(p: *mut c_char);
```

No struct crosses the boundary, which is why the seam has never been the source
of a memory fault. ⚠ The faults came from LINKING: four separately-built Lean
archives, each baking in the field offsets of the datatypes it compiled against.
A rebuilt `Verified.a` beside a stale `ServeEntry.a` means one archive
constructs a `DayState` with the old field count while another reads a field
that object does not have. `rust/*/build.rs` now builds the archives itself, so
an unbuilt subset cannot reach the linker — see the comment there for what was
ruled out and why.
