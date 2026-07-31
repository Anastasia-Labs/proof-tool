package mpcceremony

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"

	drandcrypto "github.com/drand/drand/v2/crypto"
)

const (
	maxDrandResponseBytes  = 1 << 20
	quicknetSignatureBytes = 48
)

// drandHTTPBeacon is the exact public HTTP response shape archived by this
// ceremony. The quicknet scheme is unchained, so previous_signature must be
// absent or empty.
type drandHTTPBeacon struct {
	Round             uint64 `json:"round"`
	Randomness        string `json:"randomness"`
	Signature         string `json:"signature"`
	PreviousSignature string `json:"previous_signature,omitempty"`
}

type verifiedDrandBeacon struct {
	round     uint64
	signature []byte
}

func (b verifiedDrandBeacon) GetPreviousSignature() []byte { return nil }
func (b verifiedDrandBeacon) GetRound() uint64             { return b.round }
func (b verifiedDrandBeacon) GetSignature() []byte         { return b.signature }

// VerifyDrandBeaconResponse strictly parses and cryptographically verifies an
// archived drand response against the public key and scheme pinned in the
// signed ceremony definition. It returns randomness derived from the verified
// signature, never an operator-supplied value.
func VerifyDrandBeaconResponse(
	policy BeaconPolicy,
	expectedRound uint64,
	rawResponse []byte,
) (string, error) {
	if err := policy.Validate(); err != nil {
		return "", fmt.Errorf("beacon policy: %w", err)
	}
	if expectedRound == 0 {
		return "", errors.New("expected drand round must be positive")
	}
	if len(rawResponse) == 0 || len(rawResponse) > maxDrandResponseBytes {
		return "", fmt.Errorf("drand response size %d is outside [1,%d]", len(rawResponse), maxDrandResponseBytes)
	}
	if err := rejectDuplicateKeysAndTrailing(rawResponse); err != nil {
		return "", fmt.Errorf("strict drand response JSON: %w", err)
	}
	var response drandHTTPBeacon
	decoder := json.NewDecoder(bytes.NewReader(rawResponse))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&response); err != nil {
		return "", fmt.Errorf("decode drand response: %w", err)
	}
	if err := requireJSONEOF(decoder); err != nil {
		return "", err
	}
	if response.Round != expectedRound {
		return "", fmt.Errorf("drand round %d, want committed round %d", response.Round, expectedRound)
	}
	if response.PreviousSignature != "" {
		return "", errors.New("quicknet unchained response must not contain a previous signature")
	}
	signature, err := decodeLowerHexExact("drand signature", response.Signature, quicknetSignatureBytes)
	if err != nil {
		return "", err
	}
	responseRandomness, err := decodeLowerHexExact("drand randomness", response.Randomness, 32)
	if err != nil {
		return "", err
	}

	scheme, err := drandcrypto.SchemeFromName(policy.Scheme)
	if err != nil {
		return "", fmt.Errorf("load pinned drand scheme: %w", err)
	}
	publicKeyBytes, err := hex.DecodeString(policy.PublicKeyHex)
	if err != nil {
		return "", fmt.Errorf("decode pinned drand public key: %w", err)
	}
	publicKey := scheme.KeyGroup.Point()
	if err := publicKey.UnmarshalBinary(publicKeyBytes); err != nil {
		return "", fmt.Errorf("decode pinned drand public key point: %w", err)
	}
	beacon := verifiedDrandBeacon{round: response.Round, signature: signature}
	if err := scheme.VerifyBeacon(beacon, publicKey); err != nil {
		return "", fmt.Errorf("verify drand beacon signature: %w", err)
	}
	randomnessDigest := sha256.Sum256(signature)
	derivedRandomness := randomnessDigest[:]
	if !bytes.Equal(responseRandomness, derivedRandomness) {
		return "", errors.New("drand response randomness does not equal SHA-256(signature)")
	}
	return hex.EncodeToString(derivedRandomness), nil
}

func requireJSONEOF(decoder *json.Decoder) error {
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("drand response contains trailing JSON")
		}
		return fmt.Errorf("read drand response trailer: %w", err)
	}
	return nil
}

func decodeLowerHexExact(name, value string, size int) ([]byte, error) {
	if value == "" || value != strings.ToLower(value) {
		return nil, fmt.Errorf("%s must be lowercase hexadecimal", name)
	}
	decoded, err := hex.DecodeString(value)
	if err != nil || len(decoded) != size {
		return nil, fmt.Errorf("%s must contain exactly %d lowercase hexadecimal bytes", name, size)
	}
	return decoded, nil
}

// VerifyBeaconRecordFiles reloads the immutable raw response referenced by a
// signed beacon record and repeats the same offline provider verification.
func VerifyBeaconRecordFiles(
	trusted *TrustedCeremony,
	transcriptRoot string,
	closeRecord CloseRecord,
	beacon BeaconRecord,
) error {
	if err := validateTrustedCeremony(trusted); err != nil {
		return err
	}
	if err := ValidateBeacon(trusted.Definition, closeRecord, beacon); err != nil {
		return err
	}
	rawResponse, err := verifyArtifactBytes(
		transcriptRoot,
		beacon.RawResponse,
		maxDrandResponseBytes,
	)
	if err != nil {
		return fmt.Errorf("load archived drand response: %w", err)
	}
	randomnessHex, err := VerifyDrandBeaconResponse(
		trusted.Definition.BeaconPolicy,
		closeRecord.BeaconRound,
		rawResponse,
	)
	if err != nil {
		return err
	}
	if randomnessHex != beacon.RandomnessHex {
		return errors.New("signed beacon randomness differs from verified archived response")
	}
	return nil
}
