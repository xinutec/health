import ServeEntry

/-!
# `verified_cli` — the executable shim

Everything that used to be here is `ServeEntry`, a library, so a Rust host can
link the handlers. ⚠ THIS MODULE MUST STAY THIS SMALL: whatever lives beside
`main` cannot be linked by a host, which is the whole reason for the split.
-/

def main (args : List String) : IO UInt32 := cliMain args
