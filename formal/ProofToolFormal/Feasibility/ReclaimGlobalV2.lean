import CardanoLedgerApi.V3
import ProofToolFormal.Artifacts

namespace ProofToolFormal.Feasibility.ReclaimGlobalV2

open CardanoLedgerApi.V3.Contexts (rewardingInputs)
open ProofToolFormal.Artifacts

/- Dedicated shallow feasibility probe; not imported by the default root. -/
#prep_uplc preparedReclaimGlobalV2_100 reclaimGlobalV2 rewardingInputs 100

/- Deeper structural probe; still not a completeness fuel bound. -/
#prep_uplc preparedReclaimGlobalV2_500 reclaimGlobalV2 rewardingInputs 500

end ProofToolFormal.Feasibility.ReclaimGlobalV2
