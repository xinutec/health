/-!
# Where a stay's name came from

A served stay's name is a claim about where he was. The record keeps the claim
whole: the name, the rule that chose it, and the coordinate it was asked for.
A later pass that renames the stay leaves the record behind, and a name that no
longer matches its record has no source, so neither a confidence nor a position
can outlive the name it was measured for (#325).
-/

namespace Verified

structure PlaceSource where
  name : String
  /-- `BestPlace.Source.key`, or `home`/`work`/`station`. -/
  rule : String
  /-- The coordinate the name was resolved for: the position the served stay
  stands for. `none` where the namer had no single point. -/
  askedAt : Option (Float × Float) := none
  deriving Inhabited, BEq, Repr

end Verified
