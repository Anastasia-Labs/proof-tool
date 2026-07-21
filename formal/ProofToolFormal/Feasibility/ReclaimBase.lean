import CardanoLedgerApi.V3
import ProofToolFormal.Artifacts

namespace ProofToolFormal.Feasibility.ReclaimBase

open CardanoLedgerApi.V3.Contexts (spendingInputs)
open ProofToolFormal.Artifacts

/- Dedicated feasibility probe; not imported by the default library root. -/
#prep_uplc preparedReclaimBase500 reclaimBase spendingInputs 500

end ProofToolFormal.Feasibility.ReclaimBase
