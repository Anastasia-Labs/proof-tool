import Blaster
import CardanoLedgerApi.V3
import PlutusCore.UPLC

namespace ProofToolFormal.Smoke

/--
Exercise the complete installed stack, including a real Z3-backed Blaster call.
This is an installation check, not a correctness claim about a contract.
-/
theorem blasterStackLoads (n : Nat) : n = n := by
  blaster

end ProofToolFormal.Smoke
