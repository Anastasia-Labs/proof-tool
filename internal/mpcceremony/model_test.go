package mpcceremony

import "testing"

func TestBeaconPolicyPinsOfficialDrandQuicknetMainnet(t *testing.T) {
	valid := BeaconPolicy{
		Provider:                  BeaconProviderDrand,
		Network:                   BeaconNetworkQuicknet,
		ChainHashHex:              BeaconQuicknetChainHash,
		PublicKeyHex:              BeaconQuicknetPublicKey,
		Scheme:                    BeaconQuicknetScheme,
		GenesisTimeUnix:           BeaconQuicknetGenesis,
		PeriodSeconds:             BeaconQuicknetPeriod,
		Extraction:                BeaconExtractionV1,
		MinimumChallengeBytes:     32,
		MinimumWitnessLeadSeconds: ProductionMinimumWitnessLeadSeconds,
		FutureRoundRequired:       true,
	}
	if err := valid.Validate(); err != nil {
		t.Fatalf("pinned beacon policy rejected: %v", err)
	}
	cases := []struct {
		name   string
		mutate func(*BeaconPolicy)
	}{
		{"provider", func(p *BeaconPolicy) { p.Provider = "other" }},
		{"network", func(p *BeaconPolicy) { p.Network = "quicknet-testnet" }},
		{"chain hash", func(p *BeaconPolicy) { p.ChainHashHex = "00" + p.ChainHashHex[2:] }},
		{"public key", func(p *BeaconPolicy) { p.PublicKeyHex = "00" + p.PublicKeyHex[2:] }},
		{"scheme", func(p *BeaconPolicy) { p.Scheme = "other" }},
		{"genesis", func(p *BeaconPolicy) { p.GenesisTimeUnix++ }},
		{"period", func(p *BeaconPolicy) { p.PeriodSeconds++ }},
		{"extraction", func(p *BeaconPolicy) { p.Extraction = "raw-randomness" }},
		{"challenge length", func(p *BeaconPolicy) { p.MinimumChallengeBytes = 64 }},
		{"witness lead", func(p *BeaconPolicy) { p.MinimumWitnessLeadSeconds = 0 }},
		{"future round", func(p *BeaconPolicy) { p.FutureRoundRequired = false }},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			changed := valid
			test.mutate(&changed)
			if err := changed.Validate(); err == nil {
				t.Fatal("modified beacon policy unexpectedly accepted")
			}
		})
	}
}
