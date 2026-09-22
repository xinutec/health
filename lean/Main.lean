import ServeEntry

/-!
# `verified_cli` — the executable shim

Everything is `ServeEntry`; this module only turns `cliMain` into `main`.
-/

def main (args : List String) : IO UInt32 := cliMain args
