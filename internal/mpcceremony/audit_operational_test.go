package mpcceremony

import (
	"crypto/ed25519"
	"path/filepath"
	"testing"
	"time"
)

func TestReleaseOperationalEvidenceBindsCandidateAndChronology(t *testing.T) {
	fixture := newOperationalBundleFixture(t)
	writeFixtureFile(
		t,
		fixture.root,
		OperationalEvidenceBundleFile,
		fixture.bundleBytes,
	)
	writeFixtureFile(
		t,
		fixture.root,
		OperationalEvidenceSignatureFile,
		fixture.signatureBytes,
	)

	summary := func(
		phase PhaseOperationalEvidence,
		close AuthenticatedCloseEvidence,
	) PhaseSummary {
		t.Helper()
		raw, err := verifyArtifactBytes(
			fixture.root,
			phase.AcceptedChain.Record,
			maxSignedRecordBytes,
		)
		if err != nil {
			t.Fatal(err)
		}
		var chain Chain
		if err := UnmarshalCanonical(raw, &chain); err != nil {
			t.Fatal(err)
		}
		head, err := chain.HeadRecordID()
		if err != nil {
			t.Fatal(err)
		}
		participants, err := chain.ParticipantIDs()
		if err != nil {
			t.Fatal(err)
		}
		return PhaseSummary{
			Phase:   chain.Phase,
			PhaseID: chain.PhaseID,
			Genesis: chain.Genesis,
			Chain: ArtifactRef{
				Name:   filepath.Base(phase.AcceptedChain.Record.Name),
				Digest: phase.AcceptedChain.Record.Digest,
			},
			ChainHeadID:       head,
			ContributionCount: uint8(len(chain.Records)),
			Participants:      participants,
			CloseID:           close.Record.CloseID,
		}
	}
	candidate := CandidateMetadata{
		Phase1: summary(fixture.bundle.Phase1, fixture.phase1Close),
		Phase2: summary(fixture.bundle.Phase2, fixture.phase2Close),
	}
	bundlePath := filepath.Join(
		fixture.root,
		filepath.FromSlash(OperationalEvidenceBundleFile),
	)
	signaturePath := filepath.Join(
		fixture.root,
		filepath.FromSlash(OperationalEvidenceSignatureFile),
	)
	assembledAt, err := time.Parse(time.RFC3339Nano, fixture.bundle.AssembledAt)
	if err != nil {
		t.Fatal(err)
	}
	verify := func(candidate CandidateMetadata, releasedAt time.Time) error {
		_, err := verifyReleaseOperationalEvidence(
			fixture.definition,
			fixture.coordinatorKey.Public().(ed25519.PublicKey),
			candidate,
			fixture.root,
			bundlePath,
			signaturePath,
			releasedAt,
		)
		return err
	}
	coordinatorPublicKey := fixture.coordinatorKey.Public().(ed25519.PublicKey)
	result, err := verifyReleaseOperationalEvidence(
		fixture.definition,
		coordinatorPublicKey,
		candidate,
		fixture.root,
		bundlePath,
		signaturePath,
		assembledAt.Add(time.Second),
	)
	if err != nil {
		t.Fatalf("release rejected complete operational evidence: %v", err)
	}
	if result.BundleRef.Record.Name != OperationalEvidenceBundleFile ||
		result.BundleRef.Signature.Name != OperationalEvidenceSignatureFile ||
		len(result.Names) != len(result.Verified.ReferencedArtifacts)+2 {
		t.Fatal("release operational evidence result omitted bundle or referenced artifacts")
	}

	wrongChain := candidate
	wrongChain.Phase1.Chain = refForTest(
		wrongChain.Phase1.Chain.Name,
		[]byte("different accepted chain"),
	)
	if err := verify(wrongChain, assembledAt.Add(time.Second)); err == nil {
		t.Fatal("release accepted operational evidence for a different candidate chain")
	}
	wrongClose := candidate
	wrongClose.Phase2.CloseID = NewDigest([]byte("different close")).SHA256
	if err := verify(wrongClose, assembledAt.Add(time.Second)); err == nil {
		t.Fatal("release accepted operational evidence for a different candidate close")
	}
	if err := verify(candidate, assembledAt); err == nil {
		t.Fatal("release timestamp equal to bundle assembly was accepted")
	}
}
