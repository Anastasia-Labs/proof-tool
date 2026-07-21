package ownership

import (
	"errors"
	"testing"
)

func TestValidateExplicitCredentialPathMatch(t *testing.T) {
	master := mustDecodeHex(t, knownMaster)
	path := Path{Account: 3, Role: 1, Index: 42}
	target := credentialAt(t, master, path)

	if err := ValidateExplicitCredentialPath(master, target[:], path); err != nil {
		t.Fatal(err)
	}
}

func TestValidateExplicitCredentialPathMismatch(t *testing.T) {
	master := mustDecodeHex(t, knownMaster)
	target := credentialAt(t, master, Path{Account: 0, Role: 0, Index: 0})
	wrong := Path{Account: 1, Role: 0, Index: 0}

	err := ValidateExplicitCredentialPath(master, target[:], wrong)
	if !errors.Is(err, ErrExplicitPathMismatch) {
		t.Fatalf("error = %v, want ErrExplicitPathMismatch", err)
	}
}

func TestValidateExplicitCredentialPathRejectsRole3(t *testing.T) {
	master := mustDecodeHex(t, knownMaster)
	target := make([]byte, 28)
	err := ValidateExplicitCredentialPath(master, target, Path{Account: 0, Role: 3, Index: 0})
	if err == nil || err.Error() != "role must be 0, 1, or 2" {
		t.Fatalf("role-3 error = %v", err)
	}
}

func TestValidateExplicitCredentialPathRejectsBadCredentialLength(t *testing.T) {
	master := mustDecodeHex(t, knownMaster)
	err := ValidateExplicitCredentialPath(master, []byte{1, 2, 3}, Path{Account: 0, Role: 0, Index: 0})
	if err == nil {
		t.Fatal("expected credential length error")
	}
}
