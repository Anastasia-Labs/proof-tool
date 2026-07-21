package ownership

import (
	"crypto/subtle"
	"errors"
	"fmt"
)

// ErrExplicitPathMismatch is returned when a caller-supplied CIP-1852 path
// does not derive the requested target credential. It omits path and
// credential bytes so it is safe to surface across a local worker boundary.
var ErrExplicitPathMismatch = errors.New("explicit path does not derive the target credential")

// ValidateExplicitCredentialPath checks that path is accepted by the deployed
// circuit (roles 0..2) and that masterXPrv derives targetCredential at that
// path. Callers that already know the path use this instead of discovery.
func ValidateExplicitCredentialPath(masterXPrv, targetCredential []byte, path Path) error {
	if len(targetCredential) != 28 {
		return fmt.Errorf("target credential is %d bytes, want 28", len(targetCredential))
	}
	derived, err := DeriveCredential(masterXPrv, path)
	if err != nil {
		return err
	}
	if subtle.ConstantTimeCompare(derived[:], targetCredential) != 1 {
		return ErrExplicitPathMismatch
	}
	return nil
}
