{-
health/acting.dhall — every operational script in this repository (`*.sh`,
`*.py`), classified, with a ceiling per class; a test needs no row when its path
says it is one. What the classes mean and when a ceiling may rise:
dev-lint/tables/acting_schema.dhall. The gate runs `dev-lint-fleet --acting .`:
a script with no row, a row for a file that is gone, or a class over its
ceiling fails the commit that causes it.
-}
let A = ../dev-lint/tables/acting_schema.dhall

let subject = A.subject

let Class = A.Class

in  { ceilings =
        -- acts: each row names what it becomes (automation-model items 13-15)
        -- observes: a read of production compared with the tree
      { acts = 2
      , bootstrap = 0
      , by_design = 0
      , observes = 1
      , observer_checks = 0
      }
    , subjects =
      [ subject "frontend/gen-icons.sh" Class.OutOfScope ""
          , subject "lean/experiments/board-reach-census.py" Class.OutOfScope ""
          , subject "lean/experiments/day-centre-fit.py" Class.OutOfScope ""
          , subject "lean/experiments/decode-trace.py" Class.OutOfScope ""
          , subject "lean/experiments/hr-recovery-census.py" Class.OutOfScope ""
          , subject "lean/experiments/naming-coordinate.py" Class.OutOfScope ""
          , subject "lean/experiments/pair-outlier-runs.py" Class.OutOfScope ""
          , subject "lean/experiments/place-term-fit.py" Class.OutOfScope ""
          , subject "lean/experiments/reacquire-fit.py" Class.OutOfScope ""
          , subject "lean/experiments/ride-time-fit.py" Class.OutOfScope ""
          , subject "lean/experiments/round-trip-census.py" Class.OutOfScope ""
          , subject "lean/experiments/split-waits.py" Class.OutOfScope ""
          , subject "lean/experiments/station-reach-census.py" Class.OutOfScope ""
          , subject "lean/experiments/stay-distance-census.py" Class.OutOfScope ""
          , subject "lean/experiments/stay-edge-fit.py" Class.OutOfScope ""
          , subject "lean/experiments/stay-footprint-census.py" Class.OutOfScope ""
          , subject "lean/experiments/stay-return-census.py" Class.OutOfScope ""
          , subject "lean/experiments/venue-census.py" Class.OutOfScope ""
          , subject "lean/experiments/venue-fit-outside.py" Class.OutOfScope ""
          , subject "lean/experiments/venue-fit.py" Class.OutOfScope ""
          , subject "lean/experiments/walk-ends-census.py" Class.OutOfScope ""
          , subject "lean/experiments/walk-spread-fit.py" Class.OutOfScope ""
          , subject "scripts/_devshell.sh" Class.OutOfScope ""
          , subject "scripts/cdp-inspect.py" Class.OutOfScope ""
          , subject
              "scripts/check-decoder-record.sh"
              Class.Observes
              "reads production's decoder secret and compares it with the tree's"
          , subject
              "scripts/check-serving-conditions.sh"
              Class.Acts
              "starts the candidate image as a pod under production's conditions and deletes it after"
          , subject "scripts/ci-toolchain-check.sh" Class.OutOfScope ""
          , subject "scripts/commit-table.sh" Class.OutOfScope ""
          , subject
              "scripts/deploy.sh"
              Class.Acts
              "pushes and rolls health on isis by hand: a deploy-plan row's target (item 15)"
          , subject "scripts/lean-check.sh" Class.OutOfScope ""
          , subject "scripts/place-census.py" Class.OutOfScope ""
          , subject "scripts/probe-cosq-monotonicity.py" Class.OutOfScope ""
          , subject
              "scripts/prod-db.sh"
              Class.OutOfScope
              "opens a tunnel to production's database for one command; changes nothing itself"
          , subject "scripts/render-episodes.py" Class.OutOfScope ""
          , subject "scripts/replay-corpus-states.sh" Class.OutOfScope ""
          , subject "scripts/rules-live-in-lean.sh" Class.OutOfScope ""
          , subject "scripts/setup-hooks.sh" Class.OutOfScope ""
          , subject "scripts/smoke-summary.py" Class.OutOfScope ""
          , subject "scripts/venue-prior-drift.sh" Class.OutOfScope ""
          , subject "scripts/venue-rank-census.py" Class.OutOfScope ""
          , subject
              "scripts/webview-inspect.py"
              Class.OutOfScope
              "inspects the app's WebView over adb; changes nothing"
      ]
    }
