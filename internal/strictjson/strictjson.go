// Package strictjson provides fail-closed JSON decoding for signed and
// security-sensitive artifacts that are not required to use the ceremony's
// compact canonical encoding.
package strictjson

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

const (
	maxDepth      = 64
	maxObjectKeys = 100_000
)

// Unmarshal rejects duplicate object keys, unknown struct fields, and trailing
// JSON values. Whitespace before or after the one value remains valid.
func Unmarshal(data []byte, destination any) error {
	if destination == nil {
		return errors.New("JSON destination is nil")
	}
	if err := scanOneValue(data); err != nil {
		return err
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	return decodeOne(decoder, destination)
}

// UnmarshalProjection provides duplicate/trailing-value protection when a
// caller intentionally decodes only a documented projection of a larger JSON
// schema. Unknown fields are allowed; use Unmarshal for complete schemas.
func UnmarshalProjection(data []byte, destination any) error {
	if destination == nil {
		return errors.New("JSON destination is nil")
	}
	if err := scanOneValue(data); err != nil {
		return err
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	return decodeOne(decoder, destination)
}

func decodeOne(decoder *json.Decoder, destination any) error {
	if err := decoder.Decode(destination); err != nil {
		return fmt.Errorf("decode strict JSON: %w", err)
	}
	return requireEOF(decoder)
}

func scanOneValue(data []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	keyCount := 0
	if err := scanValue(decoder, 0, &keyCount); err != nil {
		return err
	}
	return requireEOF(decoder)
}

func requireEOF(decoder *json.Decoder) error {
	token, err := decoder.Token()
	if errors.Is(err, io.EOF) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("invalid trailing JSON: %w", err)
	}
	return fmt.Errorf("unexpected trailing JSON token %v", token)
}

func scanValue(decoder *json.Decoder, depth int, keyCount *int) error {
	if depth > maxDepth {
		return fmt.Errorf("JSON nesting exceeds maximum depth %d", maxDepth)
	}
	token, err := decoder.Token()
	if err != nil {
		return fmt.Errorf("invalid JSON: %w", err)
	}
	delim, isDelimiter := token.(json.Delim)
	if !isDelimiter {
		return nil
	}
	switch delim {
	case '{':
		seen := make(map[string]struct{})
		for decoder.More() {
			keyToken, err := decoder.Token()
			if err != nil {
				return fmt.Errorf("invalid JSON object key: %w", err)
			}
			key, ok := keyToken.(string)
			if !ok {
				return errors.New("JSON object key is not a string")
			}
			if _, duplicate := seen[key]; duplicate {
				return fmt.Errorf("duplicate JSON object key %q", key)
			}
			seen[key] = struct{}{}
			*keyCount++
			if *keyCount > maxObjectKeys {
				return fmt.Errorf("JSON object key count exceeds maximum %d", maxObjectKeys)
			}
			if err := scanValue(decoder, depth+1, keyCount); err != nil {
				return err
			}
		}
		end, err := decoder.Token()
		if err != nil {
			return fmt.Errorf("invalid JSON object end: %w", err)
		}
		if end != json.Delim('}') {
			return errors.New("invalid JSON object delimiter")
		}
	case '[':
		for decoder.More() {
			if err := scanValue(decoder, depth+1, keyCount); err != nil {
				return err
			}
		}
		end, err := decoder.Token()
		if err != nil {
			return fmt.Errorf("invalid JSON array end: %w", err)
		}
		if end != json.Delim(']') {
			return errors.New("invalid JSON array delimiter")
		}
	default:
		return fmt.Errorf("unexpected JSON delimiter %q", delim)
	}
	return nil
}
