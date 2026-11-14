/-!
# Where a stay's name came from

A served stay's name claims where the user was. The record keeps the claim
whole: the name, the rule that chose it, and the coordinate it was asked for.
A later rename leaves no source, so neither a confidence nor a position outlives
the name it was measured for.
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
