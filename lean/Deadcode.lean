import Lean

/-!
# `deadcode` — what nothing in `verified_cli` can reach

Reads the compiled environment of every module in this package and walks the
constants a body or a statement names, from `main` and `externalRoots`. Two
kinds of command are kept for what they check rather than for what they run:

* a theorem whose statement names a live definition, and the spec it relates
  that definition to;
* a `#guard`, `example` or `#eval` that names a live definition, or whose
  fixtures (private definitions only checks use) call a live function. A check
  makes no constant, so its references come from the build's `.ilean` files,
  and its extent from Lean's own parser.

A theorem or check about unreached code only is unreached with it.

The compiler adds edges the terms do not show, and they are followed:
`@[implemented_by]`, a `partial def`'s `_unsafe_rec` body, `initialize`, and
`@[csimp]` (a reached left-hand side reaches the right).

Run from `lean/` after `lake build`:

* no flag: each unreached command as `path:line names`, then the total; exits 1
  when there is any;
* `--count`: the number of unreached commands;
* `--why=<name>`: the chain that reaches `<name>`;
* `--control`: the same without `main` as a root; exits 1 unless most commands
  then come out unreached;
* `--delete`: removes the unreached commands from the sources.
-/

open Lean

/-- Declarations a reader outside Lean takes from the source, which no build
can see: each with its reader. -/
def externalRoots : List Name :=
  [ `Verified.Geo.WireVocab.EPISODE_KINDS  -- rust/backend/tests/frontend_unions.rs
  ]

/-- The package's top-level modules; everything else is the toolchain's. -/
def packageRoots : List String := ["Verified", "DayEntry", "ServeEntry", "BackendEntry", "Main"]

partial def leanFiles (dir : System.FilePath) : IO (Array System.FilePath) := do
  let mut out := #[]
  for e in ← dir.readDir do
    if ← e.path.isDir then out := out ++ (← leanFiles e.path)
    else if e.path.extension == some "lean" then out := out.push e.path
  return out

def moduleOf (p : System.FilePath) : Name :=
  (p.withExtension "").components.foldl Name.mkStr .anonymous

def sourceOf (m : Name) : System.FilePath :=
  (m.components.map toString |> System.mkFilePath).withExtension "lean"

def packageModules : IO (Array Name) := do
  let mut out := #[]
  for r in packageRoots do
    let file : System.FilePath := r ++ ".lean"
    if ← file.pathExists then out := out.push (moduleOf file)
    let dir : System.FilePath := r
    if ← dir.isDir then out := out ++ (← leanFiles dir).map moduleOf
  return out

/-- A name as `.ilean` and the command line spell it: dotted, numbers as numbers. -/
def parseName (s : String) : Name :=
  (s.splitOn ".").foldl (fun n c =>
    match c.toNat? with | some k => .mkNum n k | none => .mkStr n c) .anonymous

def inPackage (env : Environment) (n : Name) : Bool :=
  match env.getModuleIdxFor? n with
  | some i => packageRoots.contains (env.header.moduleNames[i.toNat]!).getRoot.toString
  | none => false

/-- Constants named by `n`'s statement and body, plus `extra`: the compiler's
edges and the names its source spells (a `simp only [h]` with an `rfl` lemma
`h` leaves no `h` in the term). -/
def edges (env : Environment) (extra : NameMap (Array Name)) (n : Name) : Array Name := Id.run do
  let some ci := env.find? n | return #[]
  let mut out := ci.type.getUsedConstants
  if let some v := ci.value? (allowOpaque := true) then out := out ++ v.getUsedConstants
  match ci with
  | .inductInfo i => out := out ++ i.ctors.toArray
  | .ctorInfo c => out := out.push c.induct
  | _ => pure ()
  if let some impl := Compiler.getImplementedBy? env n then out := out.push impl
  -- A `partial def` runs as its `_unsafe_rec` twin; the opaque body is a default.
  if env.contains (Compiler.mkUnsafeRecName n) then out := out.push (Compiler.mkUnsafeRecName n)
  if let some init := getInitFnNameFor? env n then out := out.push init
  if let some xs := extra.find? n then out := out ++ xs
  return out

/-- Reached constants, each mapped to what reached it. -/
abbrev Reached := NameMap Name

partial def close (env : Environment) (extra : NameMap (Array Name)) (live : Reached)
    (todo : List Name) : Reached :=
  match todo with
  | [] => live
  | n :: rest =>
    let new := (edges env extra n).filter (!live.contains ·)
    close env extra (new.foldl (·.insert · n) live) (new.toList ++ rest)

/-- Something someone wrote: not a field, an instance or a generated helper. -/
def written (env : Environment) (n : Name) : Bool :=
  !(privateToUserName n).isInternalDetail && (env.getProjectionFnInfo? n).isNone &&
  !Meta.isInstanceCore env n && (declRangeExt.find? env n).isSome

/-- A written function or value; an `abbrev` naming a type is a type. -/
def isDefinition (env : Environment) (n : Name) : Bool :=
  match env.find? n with
  | some ci@(.defnInfo _) | some ci@(.opaqueInfo _) =>
    written env n && !ci.type.getForallBody.isSort
  | _ => false

/-- One top-level command: its lines (0-based, inclusive), the package
constants it declares, and the constants it names. -/
structure Cmd where
  file : System.FilePath
  /-- `open` or `export`: names things without checking them. -/
  opens : Bool
  first : Nat
  last : Nat
  declares : Array Name
  refs : Array Name

/-- A command that declares nothing and names something: a check. -/
def Cmd.isCheck (c : Cmd) : Bool := !c.opens && c.declares.isEmpty && !c.refs.isEmpty

def Cmd.label (c : Cmd) : Name := .mkStr .anonymous s!"{c.file}:{c.first + 1}"

def jsonNats (j : Json) : Array Nat :=
  match j.getArr? with
  | .ok a => a.filterMap fun x => (x.getNat?).toOption
  | .error _ => #[]

/-- Line spans of every command in `file`, by Lean's parser. -/
def commandSpans (env : Environment) (file : System.FilePath) :
    IO (Array (Nat × Nat × Bool)) := do
  let src ← IO.FS.readFile file
  let ictx := Parser.mkInputContext src file.toString
  let (_, st, msgs) ← Parser.parseHeader ictx
  let mut st := st
  let mut msgs := msgs
  let mut out := #[]
  repeat
    let (stx, st', msgs') := Parser.parseCommand ictx { env, options := {} } st msgs
    st := st'
    msgs := msgs'
    if Parser.isTerminalCommand stx then break
    if let (some p, some q) := (stx.getPos?, stx.getTailPos?) then
      let opens := stx.getKind == ``Lean.Parser.Command.open ||
        stx.getKind == ``Lean.Parser.Command.export
      out := out.push ((ictx.fileMap.toPosition p).line - 1, (ictx.fileMap.toPosition q).line - 1, opens)
  -- A command the parser could not read has no extent to trust.
  if msgs.hasErrors then
    let first ← (msgs.toList.find? (·.severity == .error)).mapM (·.toString)
    throw <| IO.userError s!"{file}: does not parse: {first.getD ""}"
  return out

/-- `m`'s commands, with what each declares and names from its `.ilean`. -/
def commandsOf (env : Environment) (m : Name) : IO (Array Cmd × Array (Name × Name)) := do
  let file := sourceOf m
  let spans ← commandSpans env file
  let ilean : System.FilePath := ".lake/build/lib/lean" / (sourceOf m).withExtension "ilean"
  let some j := (Json.parse (← IO.FS.readFile ilean)).toOption | return (#[], #[])
  -- Each declared name at the line of its name, each reference at its line.
  let mut decls : Array (Nat × Name) := #[]
  if let .ok (.obj o) := j.getObjVal? "decls" then
    for (k, v) in o.toArray do
      let r := jsonNats v
      if r.size ≥ 5 then decls := decls.push (r[4]!, parseName k)
  let mut uses : Array (Nat × Name) := #[]
  let mut inDecl : Array (Name × Name) := #[]
  if let .ok (.obj o) := j.getObjVal? "references" then
    for (k, v) in o.toArray do
      let some key := (Json.parse k).toOption | continue
      let some c := (key.getObjValD "c" |>.getObjValAs? String "n").toOption | continue
      if let .ok us := v.getObjValAs? (Array Json) "usages" then
        for u in us do
          if let some l := (jsonNats u)[0]? then uses := uses.push (l, parseName c)
          if let .ok (.str d) := u.getArrVal? 4 then inDecl := inDecl.push (parseName d, parseName c)
  return (·, inDecl) <| spans.map fun (a, b, opens) =>
    { file, opens, first := a, last := b
      declares := decls.filterMap fun (l, n) =>
        if a ≤ l && l ≤ b && env.contains n then some n else none
      refs := uses.filterMap fun (l, n) => if a ≤ l && l ≤ b then some n else none }

/-- The written declaration a generated one (`match_1`, `_proof_1`, …) belongs to. -/
partial def owner (env : Environment) (n : Name) : Name :=
  if written env n || n.getPrefix == .anonymous then n else owner env n.getPrefix

/-- Private definitions only checks use, directly or through each other: fixtures.
The greatest such set, so mutual fixtures stay fixtures. -/
partial def fixtures (referrers : NameMap NameSet) (cands : NameSet) : NameSet :=
  let keep := cands.foldl (fun (k : NameSet) d =>
    let rs := (referrers.get? d).getD {}
    if rs.toList.all fun r => r == d || cands.contains r then k.insert d else k) {}
  if keep.size == cands.size then cands else fixtures referrers keep

/-- What a check names, followed through fixtures to what they call. -/
partial def throughFixtures (env : Environment) (extra : NameMap (Array Name)) (fix : NameSet)
    (seen : NameSet) (todo : List Name) : NameSet :=
  match todo with
  | [] => seen
  | n :: rest =>
    if !fix.contains n then throughFixtures env extra fix seen rest else
    let new := (edges env extra n).filter (!seen.contains ·)
    throughFixtures env extra fix (new.foldl NameSet.insert seen) (new.toList ++ rest)

/-- Grow `live` by every written theorem whose statement names a live package
definition, and every check that names one through its fixtures, until neither
adds anything. -/
partial def grow (env : Environment) (extra : NameMap (Array Name)) (thms : Array Name)
    (fix : NameSet) (checks : Array (Cmd × NameSet)) (live : Reached) : Reached :=
  let newThms := thms.filterMap fun t => if live.contains t || !written env t then none else
    (env.find? t).bind (·.type.getUsedConstants.find? fun c =>
      live.contains c && inPackage env c && isDefinition env c) |>.map (t, ·)
  -- What a check tests: a live definition it names, or a live FUNCTION a
  -- fixture of it calls. A value a fixture reads is data, and a fixture tests
  -- nothing itself.
  let tests (c : Cmd) (r : Name) :=
    live.contains r && inPackage env r && isDefinition env r && !fix.contains r &&
      (c.refs.contains r || ((env.find? r).map (·.type.isForall)).getD false)
  let newChecks := checks.filterMap fun (c, reach) =>
    if live.contains c.label then none else (reach.toList.find? (tests c ·)).map (c, ·)
  if newThms.isEmpty && newChecks.isEmpty then live
  else
    let live := newThms.foldl (fun m (t, c) => m.insert t c) live
    let live := newChecks.foldl (fun m (c, r) => m.insert c.label r) live
    let named := newChecks.foldl (fun acc (c, _) =>
      acc ++ (c.refs.filter (!live.contains ·)).map (·, c.label)) #[]
    let live := named.foldl (fun m (r, c) => if m.contains r then m else m.insert r c) live
    grow env extra thms fix checks
      (close env extra live ((newThms.map (·.1)) ++ named.map (·.1)).toList)

/-- Delete `spans` from `file`, with the `--` comment lines directly above
each, drop the names in `unopen` from the `open` commands on their lines, and
collapse the blank lines left behind. -/
def deleteSpans (file : System.FilePath) (spans : Array (Nat × Nat))
    (unopen : Array (Nat × Nat × Array String)) : IO Unit := do
  let mut lines := (← IO.FS.readFile file).splitOn "\n" |>.toArray
  for (a, b, names) in unopen do
    for i in [a:b + 1] do
      let words := (lines[i]!.splitOn " ").filter fun w =>
        !names.contains (w.dropWhile (· == '(') |>.takeWhile (· != ')')).toString
      -- Keep a closing paren a dropped last name carried.
      let closes := lines[i]!.endsWith ")" && !(words.getLast?.map (·.endsWith ")")).getD true
      lines := lines.set! i (" ".intercalate words ++ if closes then ")" else "")
  let mut gone := Array.replicate lines.size false
  for (a, b) in spans do
    let mut a := a
    while a > 0 && (lines[a - 1]!.startsWith "--") do a := a - 1
    for i in [a:b + 1] do gone := gone.set! i true
  let mut out : Array String := #[]
  for i in [0:lines.size] do
    if gone[i]! then continue
    let blank := lines[i]!.trimAscii.isEmpty
    if blank && (out.back?.map (·.trimAscii.isEmpty)).getD false then continue
    out := out.push lines[i]!
  IO.FS.writeFile file ("\n".intercalate out.toList)

unsafe def main (args : List String) : IO UInt32 := do
  initSearchPath (← findSysroot)
  -- Imported notation lives in extension state, which only loads this way.
  enableInitializersExecution
  let mods ← packageModules
  let env ← importModules (mods.map ({ module := · })) {} (trustLevel := 1024) (loadExts := true)
  let pkg := env.constants.fold (fun acc n _ => if inPackage env n then acc.push n else acc) #[]
  let thms := pkg.filter fun n => match env.find? n with
    | some (.thmInfo _) => true
    | _ => false
  let (cmds, inDecl) ← mods.foldlM (fun (cs, ds) m => do
    let (c, d) ← commandsOf env m
    return (cs ++ c, ds ++ d)) (#[], #[])
  let add (m : NameMap (Array Name)) (k v : Name) := m.insert k (((m.get? k).getD #[]).push v)
  -- `@[csimp] theorem : @f = @g` makes the compiler emit `g` wherever `f` is.
  let extra := (Compiler.CSimp.ext.getState env).map.fold
    (fun m _ e => add m e.fromDeclName e.toDeclName) {}
  let extra := inDecl.foldl (fun m (d, c) => add m d c) extra
  let checks := cmds.filter (·.isCheck)
  -- Who names each package constant: a written declaration, or a check.
  let mut referrers : NameMap NameSet := {}
  for n in pkg do
    let o := owner env n
    if !written env o then continue
    for e in edges env extra n do
      if inPackage env e then referrers := referrers.insert e (((referrers.get? e).getD {}).insert o)
  for c in checks do
    for r in c.refs do
      referrers := referrers.insert r (((referrers.get? r).getD {}).insert c.label)
  let checkLabels := checks.foldl (fun (s : NameSet) c => s.insert c.label) {}
  -- Candidates: every private definition (a public one is a subject, tested).
  -- Then drop any a declaration other than a fixture names.
  let cands := (pkg.filter fun n => isPrivateName n && isDefinition env n).foldl
    NameSet.insert {}
  let byDecls := referrers.foldl (fun m k v =>
    m.insert k (v.foldl (fun (s : NameSet) r => if checkLabels.contains r then s else s.insert r) {})) {}
  let fix := fixtures byDecls cands
  let checks := checks.map fun c =>
    (c, throughFixtures env extra fix (c.refs.foldl NameSet.insert {}) c.refs.toList)
  -- `--control` drops `main`: the same analysis must then find nearly
  -- everything unreached, so a run that finds nothing is not a broken one.
  let control := args.contains "--control"
  let roots := if control then externalRoots else `main :: externalRoots
  let live := grow env extra thms fix checks
    (close env extra (roots.foldl (·.insert · .anonymous) ∅) roots)
  if let some w := args.find? (·.startsWith "--why=") then
    let n := parseName (w.drop 6).toString
    let mut cur := n
    while live.contains cur && cur != .anonymous do
      IO.println cur
      cur := (live.get? cur).getD .anonymous
    unless live.contains n do IO.println s!"{n} is not reached"
    return 0
  let unreached (n : Name) := inPackage env n && !live.contains n
  -- A declaration all of whose names are unreached, a check of nothing live
  -- that names something unreached, or an `open` of unreached names only.
  let dead := cmds.filter fun c =>
    if c.opens then !c.refs.isEmpty && c.refs.all unreached
    else if c.isCheck then !live.contains c.label && c.refs.any unreached
    else !c.declares.isEmpty && c.declares.all unreached
  if args.contains "--count" then
    IO.println dead.size
    return 0
  if control then
    IO.println s!"control: {dead.size} of {cmds.size} commands unreached without `main`"
    return if dead.size * 2 > cmds.size then 0 else 1
  -- An `open` of live and unreached names keeps the live ones.
  let unopen := cmds.filterMap fun c =>
    if !c.opens || c.refs.all unreached then none else
    let names := (c.refs.filter unreached).map fun n => (privateToUserName n).getString!
    if names.isEmpty then none else some (c.file, c.first, c.last, names)
  if args.contains "--delete" then
    let files := ((dead.map (·.file)) ++ unopen.map (·.1)).toList.eraseDups
    for f in files do
      deleteSpans f ((dead.filter (·.file == f)).map fun c => (c.first, c.last))
        ((unopen.filter (·.1 == f)).map fun (_, a, b, ns) => (a, b, ns))
    IO.println s!"{dead.size} commands deleted"
    return 0
  for c in dead do
    let what := if c.opens then "(open)" else if c.isCheck then "(check)" else
      " ".intercalate (c.declares.filter (written env ·) |>.map toString).toList
    IO.println s!"{c.file}:{c.first + 1} {what}"
  IO.println s!"{dead.size} unreached"
  return if dead.isEmpty then 0 else 1
