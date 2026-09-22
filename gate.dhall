{-
health/gate.dhall — this repository's commit gate.

Was `scripts/verify.sh`, which was mostly a wrapper around one package script:
`pnpm run verify`, an eight-link `&&` chain. That chain is the reason for the
conversion. It reported ONE name — "verify failed" — when any of typecheck,
frontend typecheck, schema-types drift, biome, eslint, vitest, the frontend unit
tests or the Lean parity harness could be the thing that broke, and it stopped at
the first, so a run that failed typecheck said nothing about the other seven.
They are eight rows now, and a run names every one that is red.

`pnpm run verify` still exists and still means "this commit is verified" — a
dozen files say so, including deploy.sh's first step — but it now runs THIS
table, so there is one definition of verified rather than two that drift.

**The conditional installs are gone.** `[ ! -d node_modules ] || [ pnpm-lock.yaml
-nt node_modules ]` was there because verify has to work from a clean checkout,
and it made the check on the lockfile depend on a timestamp: touch `node_modules`
and the frozen-lockfile check never runs again. Two unconditional rows, one per
project — the backend at the root, the frontend in `frontend/`, two lockfiles.

**The build is checked rather than hoped for.** `NG_BUILD_MAX_WORKERS=1 pnpm exec
ng build` came with a comment telling you to "re-run verify on a spurious build
abort", which is a gate that asks a person to decide whether it meant it.
`dev-lint#ng-build` keeps the worker cap, retries the macOS Piscina teardown
abort itself, and then judges the artifact: every asset `index.html` references,
every chunk those assets reference, all present, non-empty, parseable, and
written by THIS build.

`pnpm exec ng build` becomes `pnpm run build` on the way, which changes nothing
here — `build` is exactly `ng build` — and matches the rest of the fleet.

**dev-lint keeps its baseline**, and this is the only repository with one. It
grandfathers TWO DL-WIRE-UNTYPED-RESPONSE findings in
`rust/backend/src/routes/tables.rs`: a served route the frontend calls whose
handler builds its response with `json!`, so the response has NO Rust type —
rustc checks a `Value` and tsc checks a hand-written interface, and
DL-WIRE-MIRROR-DRIFT cannot help because it compares PAIRS and there is no Rust
half. Counts only ratchet down, so new routes are held to a typed response.

⚠ **THIS PARAGRAPH DESCRIBED A DEAD STATE UNTIL 2026-09-10.** It said the
baseline grandfathered DL-KYSELY-DRIVER-TYPE's 56 findings in `db/tables.ts` —
a different rule, a different count, and a file that went with the TypeScript
backend (#975). Read `.dev-lint-baseline` rather than this prose if they ever
disagree again; the file is three lines and it is the thing dev-lint actually
loads.

⚠ The remaining two are #1404's, and its verdict is that they must NOT be typed
with a struct — that would duplicate `RowEncoder`. So the count stops at two
until that design question is answered, and a zero here is not the goal.

Regenerate after fixing a batch:

    nix run ../dev-lint -- --write-baseline .dev-lint-baseline .

The generated `gate.json` is committed; `the table matches its Dhall` re-renders
and diffs it, so running the gate needs no `dhall`.
-}

let G = ../dev-lint/gate/schema.dhall

{-  `scripts/dev` in place of `G.inDevShell`. The prelude's helper is
    `nix develop --command`, and `nix develop` is ~9 s of flake evaluation per
    call (2026-09-17: `nix develop -c true` = 8.7 s wall); seventeen rows paid it,
    ~2.5 min of every gate spent entering one shell. The wrapper execs directly
    when `HEALTH_DEVSHELL=1` is already set — the hook, `pnpm run verify` and
    deploy.sh set it by entering once — and enters the shell itself otherwise, so
    a row run from a bare terminal still works.
-}
let dev = \(argv : List Text) -> [ "scripts/dev" ] # argv

{-  The same, for a row whose `cwd` is one level below the root — the path to
    the wrapper is relative to the row's cwd, and the first run of this table
    failed exactly the three rows that set one (`frontend`, `rust`). -}
let devBelow = \(argv : List Text) -> [ "../scripts/dev" ] # argv

in  { name = "health"
    , checks =
      [ G.Check::{
        , name = "frontend deps match the lockfile"
        , cwd = "frontend"
        , argv = devBelow [ "pnpm", "install", "--frozen-lockfile" ]
        , env = G.nonInteractive
        , timeout_s = 900
        }
      , G.Check::{
        , name = "typecheck (frontend app + e2e)"
        , argv = dev [ "pnpm", "run", "typecheck:frontend" ]
        , env = G.nonInteractive
        , timeout_s = 900
        }
      , {-  The frontend restates the backend's string unions — it has no
            compile-time link to them. This fails when a copy has drifted, so
            adding a mode or an episode kind server-side cannot silently leave
            the UI rendering it as a default.

            ⚠ IT USED TO COMPARE AGAINST `src/sleep/day-state.ts`, which held the
            only closed `DayStateMode` anywhere. #975 deletes that, so the
            backend side is now `Verified.Geo.WireVocab` — where the lists are
            tied by `#guard` to the closed types that DO exist, rather than being
            a list nobody enforces. Rust rather than node, so checking the
            backend stops needing a TypeScript runtime.
        -}
        G.Check::{
        , name = "frontend union copies match the backend"
        , argv = dev
            [ "cargo", "test", "--manifest-path", "rust/Cargo.toml"
            , "-p", "backend", "--test", "frontend_unions"
            ]
        , timeout_s = 600
        }
      , {-  The house `cargo fmt --all --check` row, which ten sibling repos have
            and this one did not (#990). Cheapest of the three Rust rows and
            therefore first, matching the fmt → clippy → tests order everywhere
            else in the fleet.

            `--manifest-path`, because health's crates live under `rust/` rather
            than at the root — same reason the tests row below carries it.

            First run rewrote 14 sites across 6 files. All of them were wrapping
            and import order; not one comment moved. That is the argument for the
            row: nothing had ever run rustfmt here, so every future Rust diff
            would have carried unrelated reformatting noise the moment anyone
            did.
        -}
        G.Check::{
        , name = "rust formatting"
        , argv =
            dev
              [ "cargo"
              , "fmt"
              , "--all"
              , "--check"
              , "--manifest-path"
              , "rust/Cargo.toml"
              ]
        , timeout_s = 180
        }
      , {-  Clippy at `-D warnings`, over the whole workspace.

            Its own row, so a lint failure is reported as a lint failure: it
            used to run inside a host-equivalence script and a warning came
            out under that script's name (#990).

            It also clears a fleet red that was NOT a real gap, and the
            distinction is worth writing down: `check -c` derives the rows a
            repo's contents demand, but `fleet.py`'s `_gate_text` reads
            `verify.sh` plus each row's `argv` — it does not follow into a
            script a row invokes, and row names are not part of the text. health
            was the first repo to run a demanded tool from inside a script, so
            it was the first to look uncovered while being covered.

            `backend`'s `build.rs` runs `lake build verified_cli` itself, so
            this row needs nothing above it to have built the Lean side.

            Own target directory, the house `clippyTarget`: clippy-driver and
            rustc fingerprint the workspace differently and evict each other in
            a shared one. Costs one extra copy of the deps on disk.
        -}
        G.Check::{
        , name = "clippy"
        , argv =
            dev
              [ "cargo"
              , "clippy"
              , "--manifest-path"
              , "rust/Cargo.toml"
              , "--all-targets"
              , "--"
              , "-D"
              , "warnings"
              ]
        , env = G.clippyTarget
        , timeout_s = 1800
        }
      , {-  #1003's two-hop mode check needs a clean slate, and it accumulates
            ACROSS the two test rows below rather than within one: `cargo
            nextest` runs test-per-process, so a record shared in memory would
            never be read back, and the file is the union of every test process
            in the run.

            Immediately before the test rows rather than at the top of the
            table: everything above is frontend or formatting and asks Lean
            nothing, and the two rows below are between them the whole Rust
            suite.
        -}
        G.Check::{
        , name = "reset the mode trace"
        , argv = [ "rm", "-f", "rust/target/mode-trace.txt" ]
        , timeout_s = 60
        }
      , {-  The Rust workspace's own tests, which NOTHING ran until #982.

            So `rust/backend/tests/config.rs` — the file whose whole subject is
            that a missing `DB_PASSWORD` is REFUSED rather than defaulted to the
            empty string — could have failed for a week without anything saying
            so. That is the same shape as a ledger nobody's build fails on.

            ⚠ THE TIMEOUT WAS 900s AND THAT WAS TOO TIGHT. Measured clean on
            2026-08-24 with an idle machine: 524s. Under any concurrent load --
            another build, a background ssh poll, a `kubectl top` loop -- it
            crossed 900s and the row was KILLED. Two commits failed that way in
            one afternoon.

            ⚠ It does not report contention; it reports

                12. rust workspace tests
                    -> TIMED OUT after 900s

            and the summary line says only `- rust workspace tests`, which reads
            as a broken test. The first occurrence cost ~25 minutes hunting one
            that did not exist -- the suite passed, alone, with zero failures.

            Same shape as #1133, where a 1Gi memory limit sat below a >1113Mi
            working set and the OOMKill read as a network failure: a bound set
            below the real requirement, failing as something else.

            1800s matches the six rows around it and is 3.4x the measured run.
        -}
        G.Check::{
        , name = "rust workspace tests"
        , env = toMap { HEALTH_MODE_TRACE = "1" }
        , argv =
            dev
              [ "cargo"
              , "nextest"
              , "run"
              , "--manifest-path"
              , "rust/Cargo.toml"
              , "--workspace"
              , "-E"
              , "not (binary(=corpus_gate) | binary(=hsmm_decode_corpus))"
              ]
        , timeout_s = 1800
        }
      , {-  The six corpus replays, split out of the row above and run at
            `--release` — the profile deploy.sh step 2 already runs the same
            binaries at, so no NEW trade is taken here; the trade (release drops
            debug-asserts and overflow checks on these paths) is the one the
            deploy gates accepted the day they existed.

            Split because they are EXECUTION-bound, not compile-bound: 42-day
            replays through the Kalman/fold/trellis paths. The debug multiple on
            the walk referee alone was dominating the whole gate the day after
            #1048 landed the five new replay gates into the row above.

            ⚠ `corpus_gate` REPLACED FOUR BINARIES on 2026-09-09 (#1359).
            `walk_gate`, `day_corpus`, `truth_corpus` and `journey_corpus` each
            rebuilt the SAME day from the SAME fixture and then graded it
            differently, so the corpus was replayed four times over; they are
            four graders behind one replay now, sharded two ways by day. That is
            also what made the walk matcher affordable in the other three
            (#1418) — it was never the matcher that was too dear, it was paying
            for it once per harness.

            The complement in the debug row keeps everything else — including
            `decoder_scoreboard` and `fold_env`, which are sub-second and so
            keep debug-assert coverage for free. The two filtersets are disjoint
            and exhaustive by construction: this row names its binaries and the
            row above is its exact negation.

            ⚠ NAMED AS `--test` TARGETS, NOT SELECTED OUT OF `--workspace`, and
            the difference is only in what gets BUILT. `-E` chooses what RUNS;
            the build scope is still whatever `--workspace` said, so this row
            used to compile ~98 test binaries in release in order to run three.
            Measured 2026-09-13, same warm tree, one `touch` of backend's lib:

                --workspace           187 s wall, 783 s CPU
                the three targets     103 s wall, 259 s CPU

            84 s of wall and 524 CPU-seconds per Rust change, for the same three
            tests. It matters more than it looks because this phase SATURATES
            the machine — median load1 8.8 on ten cores — so the only thing that
            helps is less work, not more of it.

            ⚠ The explicit list is not self-maintaining, and that is survivable
            rather than a hole: a fourth `*_corpus` binary matches the row
            above's negation, so it would RUN there — slowly, in debug, but run.
            Adding it here is an optimisation, never a correctness fix.

        -}
        G.Check::{
        , name = "corpus replay gates (release)"
        , env = toMap { HEALTH_MODE_TRACE = "1" }
        , argv =
            dev
              [ "cargo"
              , "nextest"
              , "run"
              , "--release"
              , "--manifest-path"
              , "rust/Cargo.toml"
              , "-p"
              , "backend"
              , "--test"
              , "corpus_gate"
              , "--test"
              , "hsmm_decode_corpus"
              ]
        , timeout_s = 1800
        }
      , {-  The second hop of #1003. A mode can be dispatched and executed by
            NOTHING, and every check we had passed anyway: `lean_serve` proves
            `dispatch` still routes to a mode by asking it a question, so it is
            green while nobody calls it, and a caller-side gate like `corpus_gate`
            proves the other half and stays green if an arm and its one caller
            are renamed together.

            This reads the table's own arms for hop 1 and the run's trace for
            hop 2, and holds its exception list exact in BOTH directions — an
            excused mode that gains a caller fails, and an excuse naming a mode
            the table no longer dispatches fails — so the list cannot rot
            quietly. It found three modes on its first run, `focus`, `biolabels`
            and `stationchain`, whose only caller was the routing probe.

            ⚠ AFTER BOTH TEST ROWS, and that ordering is load-bearing rather
            than presentational: this row judges their trace. It exits 2 rather
            than 0 when the trace is missing, so running it out of order says so
            instead of passing on an empty file.

            `--release` reuses what the corpus row above has already built.
        -}
        G.Check::{
        , name = "every dispatched Lean mode is executed by something"
        , argv =
            dev
              [ "cargo"
              , "run"
              , "--release"
              , "--manifest-path"
              , "rust/Cargo.toml"
              , "-p"
              , "backend"
              , "--example"
              , "mode_reachability"
              ]
        , timeout_s = 600
        }
      , {-  ⚠ SEPARATE, because `cargo nextest` DOES NOT RUN DOCTESTS and the row
            above is nextest now.

            There are ZERO doctests in this workspace today, which is exactly why
            this row exists rather than being skipped as pointless: without it,
            the first doctest anyone writes would silently never run, and a check
            that stops running while still reporting green is the failure this
            gate is for.

            It costs a couple of seconds against nextest's saving (524 s -> 276 s
            measured 2026-08-25, 221 tests both ways — identical coverage, so the
            switch loses nothing but doctests, and this row takes those back).
        -}
        G.Check::{
        , name = "rust doctests"
        , argv =
            dev
              [ "cargo"
              , "test"
              , "--doc"
              , "--manifest-path"
              , "rust/Cargo.toml"
              , "--workspace"
              ]
        , timeout_s = 600
        }
      , {-  ⚠ `cwd = "rust"`, where every other cargo row here passes
            `--manifest-path rust/Cargo.toml` from the root. `G.cargoDoc` is a
            whole row rather than an argv, so adapting it means moving the
            working directory rather than adding a flag. Nix resolves the flake
            from the enclosing git root, so `nix develop` still finds this
            repository's shell from a subdirectory — verified by running it,
            2026-09-05, not read off the documentation.
        -}
        G.cargoDoc
          with cwd = "rust"
          with argv = devBelow [ "cargo", "doc", "--no-deps", "--workspace" ]
      , G.Check::{
        , name = "lint (eslint, frontend)"
        , argv = dev [ "pnpm", "run", "lint:frontend" ]
        , env = G.nonInteractive
        , timeout_s = 900
        }
      , G.Check::{
        , name = "frontend unit tests"
        , argv = dev [ "pnpm", "run", "test:frontend" ]
        , env = G.nonInteractive # G.oneAngularWorker
        , timeout_s = 1800
        }
      , {-  `lake build` — every `#guard` runs inside it, so a trellis/spec
            divergence fails the build.

            ⚠ THE NAME SAID "+ decode parity" UNTIL 2026-09-01 AND THIS COMMENT
            PROMISED "the TS↔Lean decode parity harness: 42 seeded problems, day
            scale included, exact path and score agreement required". That
            harness compared against the TypeScript ARM, which retired with the
            TypeScript backend (#975, 2026-08-26). `scripts/lean-check.sh` has
            run `lake build` and nothing else since. The row was not silently
            green — the `#guard`s are real and they fail the build — but it
            claimed a second, cross-implementation check that no longer existed,
            which is the more flattering half of the claim.

            The cross-implementation checking now lives where it can actually
            run: the corpus harnesses in `rust/backend/tests/` gate against
            floors and ceilings blessed from the TypeScript before it went
            (`corpus_gate`, `feasibility_corpus`). Those replay gitignored
            corpora, so they are in `deploy.sh` rather than here.
        -}
        G.Check::{
        , name = "Lean verified core (#guards)"
        , argv = dev [ "pnpm", "run", "lean-check" ]
        , env = G.nonInteractive
        , timeout_s = 3600
        }
      , G.Check::{
        , name = "frontend build"
        , cwd = "frontend"
        , argv =
            G.ngBuild "../../" [ "dist/frontend/browser" ] [ "pnpm", "run", "build" ]
        , env = G.nonInteractive
        , timeout_s = 1800
        }
      , {-  The L2 phone-width layout harness: serves the dist the row above
            wrote and asserts no overlap or overflow at Pixel width.
        -}
        G.Check::{
        , name = "frontend ui-check (phone-width layout harness)"
        , cwd = "frontend"
        , argv = devBelow [ "pnpm", "run", "ui-check" ]
        , {-  Playwright DELETES this at the start of every run, so the run made
              to investigate a failure is the run that erases it — and no option
              turns that off (`preserveOutput` is about PASSING tests). Declaring
              it here makes the gate copy it aside when this check fails. #1545
          -}
          artifacts = [ "test-results" ]
        , env = G.nonInteractive
        , timeout_s = 1800
        }
      , {-  Not `G.devLint`, because of the baseline — see the header. Pinned the
            same way that helper pins: `?ref=HEAD` builds dev-lint's committed
            HEAD, so a neighbour's half-finished edit cannot fail this gate for a
            reason no commit anywhere explains.
        -}
        G.Check::{
        , name = "dev-lint (baselined)"
        , argv =
          [ "nix"
          , "run"
          , "git+file:../dev-lint?ref=HEAD"
          , "--"
          , "--baseline"
          , ".dev-lint-baseline"
          , "."
          ]
        , timeout_s = 900
        }
      , {-  A green gate has to mean the packages this repo PUBLISHES still build.

            ⚠ NOT covered by `Lean verified core (#guards)` above, which
            runs `pnpm run lean-check` in the dev shell. `packages.verified-cli`
            is the derivation the production image's lean-build stage consumes,
            and its own comment says `lake build` runs every #guard spec check,
            so BUILDING IT IS THE PROOF GATE. Running the proof in a dev shell
            and shipping a derivation nobody built is the gap this closes: the
            thing production consumes is the thing that has to be green.

            It is a DIFFERENT build from the dev-shell one the cargo rows
            exercise: a sandboxed derivation with vendored crates. Either can
            break without the other.

            `.#backend` joined it when the image started carrying the HTTP
            server (#982). Same argument once more, and it is the derivation
            that will replace `node dist/server.js`: shipping a server nobody
            built inside the sandbox is exactly the gap this check exists to
            close.

            ⚠ **`.#health-bins` LEFT THIS ROW ON 2026-09-13, and the argument
            above for it is still TRUE — what changed is where it is paid.**
            Measured over 251 recorded runs of this row: 1,356 CPU-MINUTES —
            22.6 hours, a THIRD of every CPU-minute this gate has ever spent —
            for ONE failure. For comparison, over the same window `clippy`
            caught thirteen for 40 minutes and `rust formatting` twelve for six.

            Two things make it that expensive. Its `src = ./.` is the WHOLE
            REPOSITORY, so a markdown-only commit invalidates it exactly as a
            Rust one does; and it rebuilds, in a sandbox with vendored crates,
            the same code the cargo rows compiled minutes earlier.

            ⚠ **AND CI ALREADY BUILDS IT.** The Dockerfile's stages run
            `nix build .#verified-cli` and the Rust halves on every push, on
            GitHub's runners. So this row was not the only thing standing
            between a broken derivation and production — it was the SECOND
            thing, paid on the slowest machine of the two.

            What is genuinely lost: the sandboxed build can break while the dev
            build is fine ("either can break without the other", above), and
            that is now found ~10 minutes after a push rather than before the
            commit. That is the trade, taken deliberately by Pippijn.

            ⚠ `.#verified-cli` STAYS, and cheaply: its `src = ./lean`, so it is
            a cache hit unless Lean changed, and BUILDING IT IS THE PROOF GATE
            per the paragraph above. Do not fold it in with the Rust halves
            again — the two have completely different invalidation.
        -}
        G.Check::{
        , name = "the verified CLI packages (what the production image consumes)"
        , argv =
            [ "nix"
            , "build"
            , "--no-warn-dirty"
            , "--no-link"
            , ".#verified-cli"
            ]
        , timeout_s = 3600
        }
      , {-  ⚠ THIS CHECKS THE VENDOR HASH. IT DOES NOT CHECK THAT THE IMAGE
            BUILDS, and reading it as if it did is the way it turns negative.

            `flake.nix` pins `cargoDeps.hash`, so any change to `rust/Cargo.lock`
            — a dependency added, a version bumped — invalidates a fixed-output
            derivation nothing else on the commit path builds. On 2026-09-21 that
            broke `main`: a crate grew `anyhow` for #1667, every gate row was
            green, and the image build failed 13 minutes after the push.

            ⚠ **IT IS NOT THE SANDBOXED RUST BUILD THAT WAS REMOVED ABOVE.** That
            one rebuilt the whole workspace from `src = ./.`, so a markdown commit
            paid for it, and it was taken out deliberately. This builds the VENDOR
            TREE alone: `vendorStaging`, the fixed-output derivation keyed on
            the lockfile.

            ⚠ **`--rebuild`, AND THE STAGING STAGE BY NAME — the first version
            of this row was BLIND.** It built `.#health-bins.cargoDeps`, whose
            fixed-output stage is addressed by its DECLARED hash: once an output
            with that hash is in the local store, nix never recomputes it, for
            ANY lockfile. So on 2026-09-22 a 409-line `Cargo.lock` change passed
            this row green (2.6 s, "a store hit") and CI failed 11 minutes later
            on the mismatch — the very failure the row was added the day before
            to catch. `scripts/vendor-hash-check.sh` builds, then `--rebuild`s
            — the first step is the only one that works on a hash not yet in
            the store, the second the only one that recomputes a hash that is.
            4 s on a warm store; a mismatch prints the hash to paste into
            `flake.nix`.

            ⚠ The other ways to break the image are still uncaught: the
            Dockerfile, a flake input, anything Linux-specific (the gate runs on
            darwin), a renamed binary in the image's `install -m755` lines. One
            class, named.
        -}
        G.Check::{
        , name = "the cargo vendor hash matches rust/Cargo.lock"
        , argv =
            [ "scripts/vendor-hash-check.sh" ]
        , timeout_s = 1800
        }
      , {-  ⚠ A NAME DECLARED IN BOTH LANGUAGES IS A RULE WRITTEN TWICE. The
            decisions belong in Lean and Rust is IO glue, but nothing enforced
            that and the boundary has a gradient: a rule needed AT an IO site
            costs one line to write there against a new entry point and a JSON
            round-trip to write in Lean. So rules drift Rustwards, one constant
            at a time.

            Measured the first time anybody looked (2026-09-12): FOURTEEN shared
            names. Thirteen were exact duplicates — same value, two declarations,
            so changing one and forgetting the other diverges silently. The
            fourteenth, `ACCURACY_CEILING_M`, was 200.0 in Rust and 80 in Lean:
            one name, two different rules. It was renamed rather than listed.

            ⚠ CHECKS NAMES, NOT SEMANTICS, deliberately. "Is this a rule or IO
            tuning?" has no oracle and a check needing that judgement argues with
            its reader and gets muted. "Is this name declared twice?" is decided
            by the two trees.

            ⚠ It cannot see a rule only ever written in Rust. A ratchet against
            divergence and regrowth, not a proof the split is right.
        -}
        G.Check::{
        , name = "a rule is declared once (Lean or Rust, not both)"
        , argv = [ "scripts/rules-live-in-lean.sh" ]
        , timeout_s = 120
        }
      , G.checkTable "../dev-lint"
      , {-  THIS FILE IS THE FULL TABLE, and the commit hook runs a PROJECTION of
            it: `gate-commit.json` is `gate.json` minus the rows named in
            `scripts/commit-table.sh` — the 42-day corpus replay, the
            mode-reachability pair around it, and the sandboxed CLI build. Those run in deploy.sh, before
            anything reaches the pod, and NOT on every commit.

            Why a projection and not a second Dhall table: `--check-table`
            renders the Dhall in a staged copy that provides ONLY the schema
            import, so a second table could not share rows with this one — it
            would be a copy, and two copies of a gate drift (the reason this
            file exists at all). One source, one projection, and this row is
            what keeps the projection honest: it re-derives `gate-commit.json`
            from `gate.json` and fails on any difference.

            Measured before the split (2026-09-17, 8 runs): the full table is
            ~8.7 min sequential, and the five rows dropped from the commit gate
            are ~6 min of it. A deploy ran the table TWICE (deploy.sh, then the
            hook) plus the corpus a third time on its own — ~45 min per deploy.
        -}
        G.Check::{
        , name = "the commit table is the full table minus its slow rows"
        , argv = dev [ "scripts/commit-table.sh", "--check" ]
        , timeout_s = 120
        }
      ]
    }
