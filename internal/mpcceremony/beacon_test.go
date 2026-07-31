package mpcceremony

import (
	"strings"
	"testing"
)

const quicknetRound42Response = `{"round":42,"randomness":"8ada64bae5c6c0f5540a6a13af56e663240edfbd2c76ac6a8f27671eb7259ce3","signature":"95a9f9f5b231b7714de1553105d8ffdf3dcda24cfdb1e689319bccf79a9c8ce430a91b811fbfaf763900bc998b5d686a"}`

func quicknetPolicyForTest() BeaconPolicy {
	return BeaconPolicy{
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
}

func TestVerifyDrandBeaconResponseOfficialQuicknetVector(t *testing.T) {
	randomness, err := VerifyDrandBeaconResponse(
		quicknetPolicyForTest(),
		42,
		[]byte(quicknetRound42Response),
	)
	if err != nil {
		t.Fatalf("verify official quicknet round 42: %v", err)
	}
	const expected = "8ada64bae5c6c0f5540a6a13af56e663240edfbd2c76ac6a8f27671eb7259ce3"
	if randomness != expected {
		t.Fatalf("randomness = %q, want %q", randomness, expected)
	}
}

func TestVerifyDrandBeaconResponseRejectsTamperingAndLooseJSON(t *testing.T) {
	tests := map[string]string{
		"wrong round":        strings.Replace(quicknetRound42Response, `"round":42`, `"round":43`, 1),
		"wrong randomness":   strings.Replace(quicknetRound42Response, "8ada64", "9ada64", 1),
		"wrong signature":    strings.Replace(quicknetRound42Response, "95a9f9", "85a9f9", 1),
		"unknown field":      strings.TrimSuffix(quicknetRound42Response, "}") + `,"extra":true}`,
		"duplicate round":    strings.Replace(quicknetRound42Response, `"round":42`, `"round":42,"round":42`, 1),
		"trailing JSON":      quicknetRound42Response + `{}`,
		"uppercase encoding": strings.Replace(quicknetRound42Response, "8ada64", "8ADA64", 1),
	}
	for name, raw := range tests {
		t.Run(name, func(t *testing.T) {
			if _, err := VerifyDrandBeaconResponse(quicknetPolicyForTest(), 42, []byte(raw)); err == nil {
				t.Fatal("tampered response unexpectedly verified")
			}
		})
	}
}
