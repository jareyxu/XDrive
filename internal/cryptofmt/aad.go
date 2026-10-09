// Package cryptofmt contains the protocol's byte-level encodings. The server
// uses these only for compatibility checks and must never receive user keys.
package cryptofmt

import (
	"encoding/base64"
	"encoding/binary"
	"errors"
	"unicode/utf8"
)

type KDFParams struct {
	Alg  string `json:"alg"`
	M    uint32 `json:"m"`
	T    uint32 `json:"t"`
	P    uint32 `json:"p"`
	Salt string `json:"salt"`
}

type KeySlotInput struct {
	FormatVersion  uint32    `json:"formatVersion"`
	ConfigRevision uint64    `json:"configRevision"`
	SlotID         string    `json:"slotId"`
	Type           string    `json:"type"`
	KDF            KDFParams `json:"kdf"`
}

type ChunkInput struct {
	FileID        string `json:"fileId"`
	ChunkIndex    uint64 `json:"chunkIndex"`
	ChunkCount    uint64 `json:"chunkCount"`
	PlaintextSize uint64 `json:"plaintextSize"`
}

func KeySlotAAD(in KeySlotInput) ([]byte, error) {
	if in.KDF.Alg != "argon2id" {
		return nil, errors.New("unsupported KDF algorithm")
	}
	if !validStrings(in.SlotID, in.Type, in.KDF.Alg) {
		return nil, errors.New("invalid UTF-8 in key slot")
	}
	salt, err := base64.StdEncoding.Strict().DecodeString(in.KDF.Salt)
	if err != nil || base64.StdEncoding.EncodeToString(salt) != in.KDF.Salt {
		return nil, errors.New("invalid KDF salt encoding")
	}
	return concat(
		lp([]byte("xdrive/v1/keyslot")),
		u32(in.FormatVersion),
		u64(in.ConfigRevision),
		lp(mustUTF8(in.SlotID)),
		lp(mustUTF8(in.Type)),
		lp(mustUTF8(in.KDF.Alg)),
		u32(in.KDF.M),
		u32(in.KDF.T),
		u32(in.KDF.P),
		lp(salt),
	), nil
}

func ChunkAAD(in ChunkInput) ([]byte, error) {
	return ChunkAADVersion(in, 1)
}

func ChunkAADVersion(in ChunkInput, version uint32) ([]byte, error) {
	if version != 1 && version != 2 {
		return nil, errors.New("unsupported chunk crypto version")
	}
	if !validStrings(in.FileID) {
		return nil, errors.New("invalid UTF-8 in file ID")
	}
	return concat(
		lp([]byte("xdrive/v1/chunk")), u32(version), lp(mustUTF8(in.FileID)),
		u64(in.ChunkIndex), u64(in.ChunkCount), u64(in.PlaintextSize),
	), nil
}

func ManifestAAD(fileID string) ([]byte, error) {
	return ManifestAADVersion(fileID, 1)
}

func ManifestAADVersion(fileID string, version uint32) ([]byte, error) {
	if version != 1 && version != 2 {
		return nil, errors.New("unsupported manifest crypto version")
	}
	if !validStrings(fileID) {
		return nil, errors.New("invalid UTF-8 in file ID")
	}
	return concat(lp([]byte("xdrive/v1/manifest")), u32(version), lp(mustUTF8(fileID))), nil
}

func ThumbnailAAD(fileID string) ([]byte, error) {
	return ThumbnailAADVersion(fileID, 1)
}

func ThumbnailAADVersion(fileID string, version uint32) ([]byte, error) {
	if version != 1 && version != 2 {
		return nil, errors.New("unsupported thumbnail crypto version")
	}
	if !validStrings(fileID) {
		return nil, errors.New("invalid UTF-8 in file ID")
	}
	return concat(lp([]byte("xdrive/v1/thumbnail")), u32(version), lp(mustUTF8(fileID))), nil
}

func IndexAAD(metadataID string, revision uint64) ([]byte, error) {
	if !validStrings(metadataID) {
		return nil, errors.New("invalid UTF-8 in metadata ID")
	}
	return concat(lp([]byte("xdrive/v1/index")), u32(1), lp(mustUTF8(metadataID)), u64(revision)), nil
}

func LocalStateAAD(recordType, recordID string) ([]byte, error) {
	if recordType != "upload-resume" && recordType != "revision-baseline" {
		return nil, errors.New("unsupported local-state record type")
	}
	if !validStrings(recordType, recordID) {
		return nil, errors.New("invalid UTF-8 in local-state identifier")
	}
	return concat(lp([]byte("xdrive/v1/local-state")), u32(1), lp(mustUTF8(recordType)), lp(mustUTF8(recordID))), nil
}

func lp(field []byte) []byte {
	result := make([]byte, 4+len(field))
	binary.BigEndian.PutUint32(result, uint32(len(field)))
	copy(result[4:], field)
	return result
}

func concat(fields ...[]byte) []byte {
	size := 0
	for _, field := range fields {
		size += len(field)
	}
	result := make([]byte, 0, size)
	for _, field := range fields {
		result = append(result, field...)
	}
	return result
}

func u32(value uint32) []byte {
	result := make([]byte, 4)
	binary.BigEndian.PutUint32(result, value)
	return result
}

func u64(value uint64) []byte {
	result := make([]byte, 8)
	binary.BigEndian.PutUint64(result, value)
	return result
}

func mustUTF8(value string) []byte {
	return []byte(value)
}

func validStrings(values ...string) bool {
	for _, value := range values {
		if !utf8.ValidString(value) {
			return false
		}
	}
	return true
}
