/-
No `lean-toolchain` file on purpose: the toolchain is pinned by the repo flake
(`nix develop` provides lean/lake), not by elan.
-/
import Lake
open Lake DSL

package verified

/-- The verified core: pure folds and their `#guard` specs. No `Json`, no `IO`,
no host — deliberately, so a spec here means what it says. -/
@[default_target]
lean_lib Verified

/-- The day request/response shape, and the asks the fold puts to its host. -/
lean_lib DayEntry

/-- The backend's decision table (`Verified.Sync` and friends), one `op` per
request. -/
lean_lib BackendEntry

/-- The mode table `verified_cli serve` dispatches on. -/
lean_lib ServeEntry

@[default_target]
lean_exe verified_cli where
  root := `Main
