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
grandfathers DL-KYSELY-DRIVER-TYPE's 56 pre-existing findings in `db/tables.ts`:
DATE/DATETIME columns typed `string`, DECIMAL typed `number`, none of which is
what the mariadb pool actually returns. Counts only ratchet down, so new code is
held to the honest types. Correcting a column makes tsc surface every read that
relied on the wrong one — that is the remediation, not a side effect.
Regenerate after fixing a batch:

    nix run ../dev-lint -- --write-baseline .dev-lint-baseline .

The generated `gate.json` is committed; `the table matches its Dhall` re-renders
and diffs it, so running the gate needs no `dhall`.
-}

let G = ../dev-lint/gate/schema.dhall

in  { name = "health"
    , checks =
      [ {-  Unconditional, and separate: two projects, two lockfiles.
            `--frozen-lockfile` is pnpm's ci mode — install exactly what the
            lockfile says, or fail.
        -}
        G.Check::{
        , name = "backend deps match the lockfile"
        , argv = G.inDevShell [ "pnpm", "install", "--frozen-lockfile" ]
        , timeout_s = 900
        }
      , G.Check::{
        , name = "frontend deps match the lockfile"
        , cwd = "frontend"
        , argv = G.inDevShell [ "pnpm", "install", "--frozen-lockfile" ]
        , timeout_s = 900
        }
      , {-  `tsc --noEmit` over src and over the test tsconfig: the tests are
            typechecked too, because a test that no longer compiles is a test
            that stopped testing.
        -}
        G.Check::{
        , name = "typecheck (backend)"
        , argv = G.inDevShell [ "pnpm", "run", "typecheck" ]
        , timeout_s = 900
        }
      , G.Check::{
        , name = "typecheck (frontend app + e2e)"
        , argv = G.inDevShell [ "pnpm", "run", "typecheck:frontend" ]
        , timeout_s = 900
        }
      , {-  The DB schema and the TypeScript that reads it are generated from one
            source; this fails when the committed types have drifted from it.
        -}
        G.Check::{
        , name = "generated schema types are current"
        , argv = G.inDevShell [ "pnpm", "run", "check:schema-types" ]
        , timeout_s = 600
        }
      , {-  The frontend restates the backend's string unions — it has no
            compile-time link to them. This fails when a copy has drifted, so
            adding a mode or an episode kind server-side cannot silently leave
            the UI rendering it as a default.
        -}
        G.Check::{
        , name = "frontend union copies match the backend"
        , argv = G.inDevShell [ "pnpm", "run", "check:frontend-unions" ]
        , timeout_s = 600
        }
      , {-  The `*-refs.mts` generators, held to a committed snapshot.

            A Lean port that is SERVED is protected from TS drift by the day gate
            — which exists because `feefb75` moved a constant in `velocity.ts`
            and the fold never got it. A port that is written but UNREACHABLE has
            no such protection: the day gate compares arms, and an orphan is in
            neither. 31 covered TS exports are in that state today (#1003).

            What those orphans have instead is a `#guard` pinned to a constant
            copied by hand from a run of the sibling refs file. Those refs import
            the production TypeScript, so they are real parity evidence — but
            nothing re-ran them, so if the TS moved the guard still passed. This
            row is what re-runs them. All 69 generators, ~30 s, no database, no
            network, and none of them reads the gitignored corpus, so it passes
            on a clean checkout.

            ⚠ GREEN DOES NOT MEAN NO TS DRIFTED, and the row is worth having
            anyway. It holds what the generators PRINT; it cannot check that any
            `#guard` agrees with them, because no machine-readable link from a
            guard to a ref value exists. Measured by ablation rather than
            asserted: every numeric constant in `src/geo/segments.ts` is caught,
            36 perturbations for 36 catches, at a tuning-sized edit as well as a
            gross one — one module of the 77 the refs import. The rest are
            unmeasured. See the header of `refs-snapshot.mts`, including the one
            unexplained reading recorded there.
        -}
        G.Check::{
        , name = "the reference generators still agree with their snapshot"
        , argv = G.inDevShell [ "pnpm", "run", "check:refs-snapshot" ]
        , timeout_s = 600
        }
      , {-  The check above pins the pass NAMES. It cannot pin a pass's BODY,
            and that is the gap this closes: `feefb75` added
            MINED_LABEL_MIN_DAYS to velocity.ts with no Lean counterpart, the
            name list still matched, and the day gate went RED on 6 of 35 days
            with nothing to say so until the next deploy — `deploy.sh` is the
            only place the full gate runs. THIRD silent TS/Lean drift (#417,
            #425, this), all three found by accident.

            ONE day, ~9 s, so this is a tripwire and not the gate: the 35-day
            corpus still owns the verdict in deploy.sh. Skips cleanly when the
            gitignored corpus is absent, which is why it can sit in a table
            that must also pass on a clean checkout.

            Verified RED as well as green — a TS-only change to the mined-label
            gate fails it. #943.
        -}
        G.Check::{
        , name = "Lean fold matches the TS day (one-day smoke)"
        , argv = G.inDevShell [ "scripts/day-gate-smoke.sh" ]
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
            G.inDevShell
              [ "cargo"
              , "fmt"
              , "--all"
              , "--check"
              , "--manifest-path"
              , "rust/Cargo.toml"
              ]
        , timeout_s = 180
        }
      , {-  `rust/day-shell` calls the SAME Lean fold in-process that
            `verified_cli day` is spawned for, and the entire argument for it is
            that the two answers are identical. That is a third arm computing the
            day, and every silent drift this repository has had came from a
            second copy with no check between the copies (#444, `feefb75`, the
            frontend unions).

            Builds it, runs clippy at `-D warnings`, then diffs the two answers
            byte for byte on a real day. Verified RED as well as green: a change
            to the export that leaves `Day.dayResult` alone fails it.

            Skips the equivalence out loud when the gitignored corpus is absent —
            build and clippy still run — so this passes on a clean checkout.
        -}
        G.Check::{
        , name = "the in-process Rust host agrees with the spawned CLI"
        , argv = G.inDevShell [ "scripts/rust-host-check.sh" ]
        , timeout_s = 1800
        }
      , {-  Clippy at `-D warnings`, over the whole workspace.

            A MOVE, not new coverage: `scripts/rust-host-check.sh` ran exactly
            this from the day the crate existed. What the row buys is the NAME.
            That script builds, linted, checked the host/CLI equivalence and
            checked the callbacks reached the host — four failures under one
            name, which is the thing the header of this file exists to argue
            against. A lint failure reported "the in-process Rust host agrees
            with the spawned CLI", and that was never what broke.

            It also clears a fleet red that was NOT a real gap, and the
            distinction is worth writing down: `check -c` derives the rows a
            repo's contents demand, but `fleet.py`'s `_gate_text` reads
            `verify.sh` plus each row's `argv` — it does not follow into a
            script a row invokes, and row names are not part of the text. health
            was the first repo to run a demanded tool from inside a script, so
            it was the first to look uncovered while being covered.

            ⚠ ORDERING: this must come after the host row above, which is what
            runs `lake build … DayEntry:static Verified:static`. `day-shell`'s
            `build.rs` reads its link line out of the `.rsp` that build writes,
            so cargo cannot even run its build script on a clean checkout until
            then. The gate runs rows in table order (`gate/src/main.rs`), and
            the tests row below already depends on this — it is stated here
            because an implicit dependency that nothing writes down is one a
            reorder breaks silently.

            Own target directory, the house `clippyTarget`: clippy-driver and
            rustc fingerprint the workspace differently and evict each other in
            a shared one. Costs one extra copy of the deps on disk.
        -}
        G.Check::{
        , name = "clippy"
        , argv =
            G.inDevShell
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
      , {-  The Rust workspace's own tests, which NOTHING ran until #982.

            A compile error or a lint in `rust/backend` was already a red row —
            `scripts/rust-host-check.sh` built the workspace and, until #990
            moved it to the row above, linted it too. `cargo test` was in
            neither: that script is about one equivalence, and widening it would
            have made its name a lie.

            So `rust/backend/tests/config.rs` — the file whose whole subject is
            that a missing `DB_PASSWORD` is REFUSED rather than defaulted to the
            empty string — could have failed for a week without anything saying
            so. That is the same shape as a ledger nobody's build fails on.

            Whole workspace, not `-p backend`: `day-shell`'s own tests
            (`mirror_port`, `mirror_async_guard`) were in the same position.

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
        , argv =
            G.inDevShell
              [ "cargo", "test", "--manifest-path", "rust/Cargo.toml", "--workspace" ]
        , timeout_s = 1800
        }
      , G.Check::{
        , name = "lint (biome, backend)"
        , argv = G.inDevShell [ "pnpm", "run", "lint" ]
        , timeout_s = 600
        }
      , G.Check::{
        , name = "lint (eslint, frontend)"
        , argv = G.inDevShell [ "pnpm", "run", "lint:frontend" ]
        , timeout_s = 900
        }
      , G.Check::{
        , name = "tests (vitest)"
        , argv = G.inDevShell [ "pnpm", "test" ]
        , timeout_s = 1800
        }
      , G.Check::{
        , name = "frontend unit tests"
        , argv = G.inDevShell [ "pnpm", "run", "test:frontend" ]
        , env = G.oneAngularWorker
        , timeout_s = 1800
        }
      , {-  `lake build` — every `#guard` parity check runs inside it, so a
            trellis/spec divergence fails the build — then the TS↔Lean decode
            parity harness: 42 seeded problems, day scale included, exact path
            and score agreement required.
        -}
        G.Check::{
        , name = "Lean verified core + decode parity"
        , argv = G.inDevShell [ "pnpm", "run", "lean-check" ]
        , timeout_s = 3600
        }
      , G.Check::{
        , name = "frontend build"
        , cwd = "frontend"
        , argv =
            G.ngBuild "../../" [ "dist/frontend/browser" ] [ "pnpm", "run", "build" ]
        , timeout_s = 1800
        }
      , {-  The L2 phone-width layout harness: serves the dist the row above
            wrote and asserts no overlap or overflow at Pixel width.
        -}
        G.Check::{
        , name = "frontend ui-check (phone-width layout harness)"
        , cwd = "frontend"
        , argv = G.inDevShell [ "pnpm", "run", "ui-check" ]
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

            ⚠ NOT covered by `Lean verified core + decode parity` above, which
            runs `pnpm run lean-check` in the dev shell. `packages.verified-cli`
            is the derivation the production image's lean-build stage consumes,
            and its own comment says `lake build` runs every #guard spec check,
            so BUILDING IT IS THE PROOF GATE. Running the proof in a dev shell
            and shipping a derivation nobody built is the gap this closes: the
            thing production consumes is the thing that has to be green.

            `.#day-shell` joined it when the image started carrying the host
            (#959) — for exactly the same reason, and it is a DIFFERENT build
            from the dev one `the in-process Rust host agrees with the spawned
            CLI` exercises: that check runs cargo in the dev shell against a
            local `lake` tree, where this builds both halves inside a
            sandboxed derivation with vendored crates. Either can break
            without the other.

            `.#backend` joined it when the image started carrying the HTTP
            server (#982). Same argument once more, and it is the derivation
            that will replace `node dist/server.js`: shipping a server nobody
            built inside the sandbox is exactly the gap this check exists to
            close.
        -}
        G.Check::{
        , name = "the verified CLI packages (what the production image consumes)"
        , argv =
            [ "nix"
            , "build"
            , "--no-warn-dirty"
            , "--no-link"
            , ".#verified-cli"
            , ".#health-bins"
            ]
        , timeout_s = 3600
        }
      , G.checkTable "../dev-lint"
      ]
    }
