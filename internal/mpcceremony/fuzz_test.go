package mpcceremony

import (
	"bytes"
	"testing"
)

func FuzzCanonicalJSONParser(f *testing.F) {
	f.Add([]byte(`{}`))
	f.Add([]byte(`{"schema":"x","schema":"y"}`))
	f.Add([]byte(`{"nested":{"a":1},"tail":[]}`))
	f.Add([]byte(`null{}`))

	f.Fuzz(func(t *testing.T, data []byte) {
		// This scanner is the allocation-bounded first pass for every signed
		// canonical record and for archived drand JSON. Arbitrary input must
		// only return an error, never panic.
		_ = rejectDuplicateKeysAndTrailing(data)
	})
}

func FuzzPhase1Preflight(f *testing.F) {
	var canonical bytes.Buffer
	phase1, _, err := InitializePhase1(2)
	if err != nil {
		f.Fatalf("initialize Phase 1: %v", err)
	}
	if _, err := phase1.WriteTo(&canonical); err != nil {
		f.Fatalf("serialize Phase 1 seed: %v", err)
	}
	f.Add(canonical.Bytes())
	f.Add([]byte{})
	f.Add(bytes.Repeat([]byte{0xff}, 128))

	f.Fuzz(func(t *testing.T, data []byte) {
		_, _ = PreflightPhase1(
			bytes.NewReader(data),
			Phase1Shape{DomainN: 2, ChallengeLength: 0},
		)
	})
}

func FuzzPhase2Preflight(f *testing.F) {
	phase2, shape := adversarialPhase2Contribution(f)
	canonical := adversarialSerialize(f, phase2)
	f.Add(canonical)
	f.Add([]byte{})
	f.Add(bytes.Repeat([]byte{0xff}, 128))

	f.Fuzz(func(t *testing.T, data []byte) {
		_, _ = PreflightPhase2(bytes.NewReader(data), shape)
	})
}

func FuzzDrandResponseParser(f *testing.F) {
	policy := BeaconPolicy{
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
	f.Add([]byte(`{"round":1,"randomness":"","signature":""}`))
	f.Add([]byte(`{"round":1,"round":2}`))
	f.Add([]byte{})

	f.Fuzz(func(t *testing.T, data []byte) {
		_, _ = VerifyDrandBeaconResponse(policy, 1, data)
	})
}
