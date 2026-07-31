// Copyright 2026 Midgard Labs
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"crypto/ed25519"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"

	"proof-tool/internal/mpcceremony"
)

const maxOperationalRecordBytes = 16 << 20

func executeOpsExportSigning(options OpsExportSigningOptions) (result CommandResult, err error) {
	recordType := mpcceremony.OperationalRecordType(options.RecordType)
	canonical, record, trusted, err := loadBoundOperationalRecord(
		recordType,
		options.RecordPath,
		options.CeremonyPath,
		options.CeremonySignaturePath,
		options.CoordinatorPublicKeyFile,
	)
	if err != nil {
		return CommandResult{}, err
	}
	request, err := mpcceremony.NewOperationalSigningRequest(recordType, canonical)
	if err != nil {
		return CommandResult{}, err
	}
	requestBytes, err := mpcceremony.MarshalCanonical(request)
	if err != nil {
		return CommandResult{}, err
	}
	definitionBytes, err := mpcceremony.MarshalCanonical(trusted.Definition)
	if err != nil {
		return CommandResult{}, err
	}
	if _, err := mpcceremony.VerifyOperationalRecordBinding(trusted.Definition, definitionBytes, record); err != nil {
		return CommandResult{}, err
	}

	if err := os.Mkdir(options.OutDir, 0o700); err != nil {
		return CommandResult{}, fmt.Errorf("create fresh signing export directory: %w", err)
	}
	complete := false
	defer func() {
		if complete {
			return
		}
		_ = os.Remove(filepath.Join(options.OutDir, "canonical.json"))
		_ = os.Remove(filepath.Join(options.OutDir, "signing-request.json"))
		_ = os.Remove(options.OutDir)
	}()
	canonicalPath := filepath.Join(options.OutDir, "canonical.json")
	requestPath := filepath.Join(options.OutDir, "signing-request.json")
	if err := writeFreshOperationalFile(canonicalPath, canonical, 0o600); err != nil {
		return CommandResult{}, err
	}
	if err := writeFreshOperationalFile(requestPath, requestBytes, 0o600); err != nil {
		return CommandResult{}, err
	}
	if err := syncDirectory(options.OutDir); err != nil {
		return CommandResult{}, err
	}
	complete = true
	return CommandResult{
		CeremonyID: trusted.Definition.CeremonyID,
		Summary:    "exported exact canonical operational record bytes and digest for offline signing",
		Outputs: map[string]string{
			"canonical":       canonicalPath,
			"signing_request": requestPath,
		},
	}, nil
}

func executeOpsImportSignature(options OpsImportSignatureOptions) (CommandResult, error) {
	recordType := mpcceremony.OperationalRecordType(options.RecordType)
	canonical, record, trusted, err := loadBoundOperationalRecord(
		recordType,
		options.CanonicalPath,
		options.CeremonyPath,
		options.CeremonySignaturePath,
		options.CoordinatorPublicKeyFile,
	)
	if err != nil {
		return CommandResult{}, err
	}
	definitionBytes, err := canonicalDefinition(trusted)
	if err != nil {
		return CommandResult{}, err
	}
	expectedSigner, err := mpcceremony.VerifyOperationalRecordBinding(
		trusted.Definition,
		definitionBytes,
		record,
	)
	if err != nil {
		return CommandResult{}, err
	}
	publicKey, err := loadExpectedOperationalPublicKey(options.SignerPublicKeyFile, expectedSigner)
	if err != nil {
		return CommandResult{}, err
	}
	rawTransport, err := readRegularOperationalFile(options.RawSignaturePath, 4096)
	if err != nil {
		return CommandResult{}, err
	}
	rawSignature, err := mpcceremony.DecodeOfflineSignature(rawTransport)
	if err != nil {
		return CommandResult{}, err
	}
	signature, err := mpcceremony.ImportOperationalSignature(
		canonical,
		expectedSigner.KeyID,
		publicKey,
		rawSignature,
	)
	if err != nil {
		return CommandResult{}, err
	}
	signatureBytes, err := mpcceremony.MarshalCanonical(signature)
	if err != nil {
		return CommandResult{}, err
	}
	if err := writeFreshOperationalFile(options.OutPath, signatureBytes, 0o644); err != nil {
		return CommandResult{}, err
	}
	return CommandResult{
		CeremonyID: trusted.Definition.CeremonyID,
		Summary:    "verified and imported an offline Ed25519 signature over exact canonical bytes",
		Outputs: map[string]string{
			"signature": options.OutPath,
		},
	}, nil
}

func executeOpsVerify(options OpsVerifyOptions) (CommandResult, error) {
	recordType := mpcceremony.OperationalRecordType(options.RecordType)
	canonical, record, trusted, err := loadBoundOperationalRecord(
		recordType,
		options.RecordPath,
		options.CeremonyPath,
		options.CeremonySignaturePath,
		options.CoordinatorPublicKeyFile,
	)
	if err != nil {
		return CommandResult{}, err
	}
	definitionBytes, err := canonicalDefinition(trusted)
	if err != nil {
		return CommandResult{}, err
	}
	expectedSigner, err := mpcceremony.VerifyOperationalRecordBinding(
		trusted.Definition,
		definitionBytes,
		record,
	)
	if err != nil {
		return CommandResult{}, err
	}
	publicKey, err := loadExpectedOperationalPublicKey(options.SignerPublicKeyFile, expectedSigner)
	if err != nil {
		return CommandResult{}, err
	}
	signatureBytes, err := readRegularOperationalFile(options.SignaturePath, 4096)
	if err != nil {
		return CommandResult{}, err
	}
	var signature mpcceremony.DetachedSignature
	if err := mpcceremony.UnmarshalCanonical(signatureBytes, &signature); err != nil {
		return CommandResult{}, fmt.Errorf("signature: %w", err)
	}
	if err := mpcceremony.VerifyExact(canonical, signature, expectedSigner.KeyID, publicKey); err != nil {
		return CommandResult{}, err
	}

	if recordType == mpcceremony.RecordReceipt {
		if options.RelatedRecordPath == "" {
			return CommandResult{}, errors.New("receipt verification requires --related-record with the exact canonical handoff")
		}
		handoffBytes, err := readRegularOperationalFile(options.RelatedRecordPath, maxOperationalRecordBytes)
		if err != nil {
			return CommandResult{}, err
		}
		parsed, err := mpcceremony.ParseOperationalRecord(mpcceremony.RecordHandoff, handoffBytes)
		if err != nil {
			return CommandResult{}, fmt.Errorf("related handoff: %w", err)
		}
		handoff := parsed.(*mpcceremony.TransferHandoff)
		receipt := record.(*mpcceremony.TransferReceipt)
		if err := mpcceremony.VerifyTransferReceipt(handoffBytes, *handoff, *receipt); err != nil {
			return CommandResult{}, err
		}
	}
	if recordType == mpcceremony.RecordEvidenceBundle {
		if options.EvidenceRoot == "" {
			return CommandResult{}, errors.New("evidence-bundle verification requires --evidence-root")
		}
		bundle := record.(*mpcceremony.OperationalEvidenceBundle)
		phase1Close, err := mpcceremony.LoadAuthenticatedCloseEvidence(
			options.EvidenceRoot,
			bundle.Phase1.Close,
		)
		if err != nil {
			return CommandResult{}, fmt.Errorf("phase1 close evidence: %w", err)
		}
		phase2Close, err := mpcceremony.LoadAuthenticatedCloseEvidence(
			options.EvidenceRoot,
			bundle.Phase2.Close,
		)
		if err != nil {
			return CommandResult{}, fmt.Errorf("phase2 close evidence: %w", err)
		}
		if _, err := mpcceremony.VerifyOperationalEvidenceBundle(
			mpcceremony.VerifyOperationalEvidenceOptions{
				Definition:           trusted.Definition,
				CoordinatorPublicKey: trusted.CoordinatorPublicKey,
				EvidenceRoot:         options.EvidenceRoot,
				BundleBytes:          canonical,
				BundleSignatureBytes: signatureBytes,
				Phase1Close:          phase1Close,
				Phase2Close:          phase2Close,
			},
		); err != nil {
			return CommandResult{}, err
		}
	}
	return CommandResult{
		CeremonyID: trusted.Definition.CeremonyID,
		Summary:    "verified canonical operational record, ceremony binding, signer identity, and detached signature",
		Outputs: map[string]string{
			"record":    options.RecordPath,
			"signature": options.SignaturePath,
		},
	}, nil
}

func loadBoundOperationalRecord(
	recordType mpcceremony.OperationalRecordType,
	recordPath, ceremonyPath, ceremonySignaturePath, coordinatorPublicKeyPath string,
) ([]byte, any, *mpcceremony.TrustedCeremony, error) {
	if err := recordType.Validate(); err != nil {
		return nil, nil, nil, err
	}
	trusted, err := mpcceremony.LoadSignedDefinition(mpcceremony.TrustPaths{
		DefinitionPath:           ceremonyPath,
		DefinitionSignaturePath:  ceremonySignaturePath,
		CoordinatorPublicKeyPath: coordinatorPublicKeyPath,
	})
	if err != nil {
		return nil, nil, nil, err
	}
	canonical, err := readRegularOperationalFile(recordPath, maxOperationalRecordBytes)
	if err != nil {
		return nil, nil, nil, err
	}
	record, err := mpcceremony.ParseOperationalRecord(recordType, canonical)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("operational record: %w", err)
	}
	definitionBytes, err := canonicalDefinition(trusted)
	if err != nil {
		return nil, nil, nil, err
	}
	if _, err := mpcceremony.VerifyOperationalRecordBinding(
		trusted.Definition,
		definitionBytes,
		record,
	); err != nil {
		return nil, nil, nil, err
	}
	return canonical, record, trusted, nil
}

func canonicalDefinition(trusted *mpcceremony.TrustedCeremony) ([]byte, error) {
	// LoadSignedDefinition already accepted this exact type using the canonical
	// parser, so remarshal cannot fail. Keeping this helper local avoids adding
	// mutable raw bytes to the trusted ceremony API.
	data, err := mpcceremony.MarshalCanonical(trusted.Definition)
	if err != nil {
		return nil, fmt.Errorf("remarshal authenticated canonical definition: %w", err)
	}
	return data, nil
}

func loadExpectedOperationalPublicKey(path string, expected mpcceremony.Identity) (ed25519.PublicKey, error) {
	value, err := readPublicKeyHex(path)
	if err != nil {
		return nil, err
	}
	if value != expected.Ed25519PublicKeyHex {
		return nil, errors.New("out-of-band signer public key does not match operational record identity")
	}
	raw, err := hex.DecodeString(value)
	if err != nil || len(raw) != ed25519.PublicKeySize {
		return nil, errors.New("decode expected operational signer public key")
	}
	return ed25519.PublicKey(raw), nil
}

func readRegularOperationalFile(path string, maximum int64) ([]byte, error) {
	linkInfo, err := os.Lstat(path)
	if err != nil {
		return nil, fmt.Errorf("inspect %q: %w", path, err)
	}
	if linkInfo.Mode()&fs.ModeSymlink != 0 || !linkInfo.Mode().IsRegular() {
		return nil, fmt.Errorf("%q must be a regular file, not a symlink", path)
	}
	if linkInfo.Size() <= 0 || linkInfo.Size() > maximum {
		return nil, fmt.Errorf("%q size %d is outside [1,%d]", path, linkInfo.Size(), maximum)
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || !os.SameFile(linkInfo, info) || info.Size() != linkInfo.Size() {
		return nil, fmt.Errorf("%q changed while being opened", path)
	}
	data := make([]byte, info.Size())
	if _, err := io.ReadFull(file, data); err != nil {
		return nil, err
	}
	var extra [1]byte
	if n, err := file.Read(extra[:]); n != 0 || (err != nil && !errors.Is(err, io.EOF)) {
		return nil, fmt.Errorf("%q changed while being read", path)
	}
	return data, nil
}

func writeFreshOperationalFile(path string, data []byte, mode fs.FileMode) (err error) {
	if len(data) == 0 {
		return errors.New("refuse to write empty operational artifact")
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return fmt.Errorf("create fresh operational artifact %q: %w", path, err)
	}
	complete := false
	defer func() {
		closeErr := file.Close()
		if err == nil && closeErr != nil {
			err = closeErr
		}
		if !complete {
			_ = os.Remove(path)
		}
	}()
	if _, err = file.Write(data); err != nil {
		return err
	}
	if err = file.Sync(); err != nil {
		return err
	}
	complete = true
	return nil
}

func syncDirectory(path string) error {
	directory, err := os.Open(path)
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}
