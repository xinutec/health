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
      , {-  `Verified.Geo.PassFold` pins its wiring against a HAND-COPIED list
            of the TS pass names, so a pass added to `velocity.ts` leaves the
            Lean guards agreeing with each other and disagreeing with what
            runs. This reads the names out of the TS. The fold fell a pass
            behind exactly this way when `changeoverWindow` landed (#444).
        -}
        G.Check::{
        , name = "Lean fold's cascade copy matches velocity.ts"
        , argv = G.inDevShell [ "pnpm", "run", "check:cascade-parity" ]
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
      , {-  A green gate has to mean the package this repo PUBLISHES still builds.

            ⚠ NOT covered by `Lean verified core + decode parity` above, which
            runs `pnpm run lean-check` in the dev shell. `packages.verified-cli`
            is the derivation the production image's lean-build stage consumes,
            and its own comment says `lake build` runs every #guard spec check,
            so BUILDING IT IS THE PROOF GATE. Running the proof in a dev shell
            and shipping a derivation nobody built is the gap this closes: the
            thing production consumes is the thing that has to be green.
        -}
        G.Check::{
        , name = "the verified CLI packages (what the production image consumes)"
        , argv =
            [ "nix", "build", "--no-warn-dirty", "--no-link", ".#verified-cli" ]
        , timeout_s = 3600
        }
      , G.checkTable "../dev-lint"
      ]
    }
