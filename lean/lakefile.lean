/-
Was `lakefile.toml`. Converted because TOML cannot express an `extern_lib`, and
`DayEntry.OsmHost` declares two `@[extern]` lookups that every binary linking the
fold has to resolve — including `verified_cli`, which as a spawned process cannot
answer them and gets the empty stub. See `c/osm-host-stub.c`.

No `lean-toolchain` file on purpose: the toolchain is pinned by the repo flake
(`nix develop` provides lean/lake), not by elan.
-/
import Lake
open Lake DSL

package verified

/-- The verified core: pure folds and their `#guard` specs. No `Json`, no `IO`,
no `@[extern]` — deliberately, so a spec here means what it says. -/
@[default_target]
lean_lib Verified

/-- The day entry point as a LIBRARY (#952), so a host process can link the fold
in and call `health_day_result` through the C ABI instead of paying a spawn.

It is `DayEntry` and not `Main` because a `lean_exe`'s root module also emits
`main`, and an archive carrying `_main` wins the link in a foreign host
silently — it built, ran, and printed well-formed JSON from the WRONG entry
point. `DayEntry` defines no `main`, so there is nothing to collide. -/
lean_lib DayEntry

/-- The backend's entry point as a LIBRARY, for the same reason `DayEntry` is
one: an exe's root module emits `main`, and an archive carrying `_main` wins the
link in a foreign host silently. `rust/backend` links this to call the decisions
in `Verified.Sync` rather than reimplementing them beside it (#982). -/
lean_lib BackendEntry

/-- The serve-mode handlers as a LIBRARY (#982), for the third time and the same
reason as `DayEntry` and `BackendEntry`: an exe root emits `main`, so anything
sharing a module with it cannot be linked by a host. `geo`, `match`, `rail`,
`hsmm`, `kalman`, `gpsquality`, `biolabels`, `head` and `stationchain` all lived
beside `main` and were unreachable from Rust for that reason alone. -/
lean_lib ServeEntry

@[default_target]
lean_exe verified_cli where
  root := `Main

/-! ## The extern stub

`DayEntry.OsmHost`'s two lookups are `@[extern]`, so the symbols must resolve in
anything that links the module. `verified_cli` gets the EMPTY answer, which is
exactly the shell behaviour it has today; `rust/day-shell` links its own
implementations instead and never sees this file.

Exactly one implementation per link, always. Two definitions of one symbol is
what silently broke the first host build — it linked, ran, and answered from the
wrong one. -/

target «osm-host-stub.o» pkg : System.FilePath := do
  let src := pkg.dir / "c" / "osm-host-stub.c"
  let obj := pkg.buildDir / "c" / "osm-host-stub.o"
  buildO obj (← inputTextFile src) #["-I", (← getLeanIncludeDir).toString, "-fPIC"]

extern_lib libosmhoststub pkg := do
  let job ← «osm-host-stub.o».fetch
  buildStaticLib (pkg.staticLibDir / nameToStaticLib "osmhoststub") #[job]
