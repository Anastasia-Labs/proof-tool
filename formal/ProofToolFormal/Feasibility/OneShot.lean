import CardanoLedgerApi.V3
import ProofToolFormal.Artifacts

namespace ProofToolFormal.Feasibility.OneShot

open CardanoLedgerApi.V3.Contexts (mintingInputs)
open ProofToolFormal.Artifacts

/- Dedicated feasibility probe; not imported by the default library root. -/
#prep_uplc preparedOneShot500 oneShotParamsNFT mintingInputs 500

end ProofToolFormal.Feasibility.OneShot
