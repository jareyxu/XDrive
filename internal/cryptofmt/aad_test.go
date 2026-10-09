package cryptofmt

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hkdf"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"testing"
)

type sharedVectors struct {
	KeySlot struct {
		Input  KeySlotInput `json:"input"`
		AADHex string       `json:"aadHex"`
	} `json:"keySlot"`
	Chunk struct {
		Input  ChunkInput `json:"input"`
		AADHex string     `json:"aadHex"`
	} `json:"chunk"`
	Manifest struct {
		FileID string `json:"fileId"`
		AADHex string `json:"aadHex"`
	} `json:"manifest"`
	Thumbnail struct {
		FileID string `json:"fileId"`
		AADHex string `json:"aadHex"`
	} `json:"thumbnail"`
	Index struct {
		MetadataID string `json:"metadataId"`
		Revision   uint64 `json:"revision"`
		AADHex     string `json:"aadHex"`
	} `json:"index"`
	LocalState struct {
		RecordType string `json:"recordType"`
		RecordID   string `json:"recordId"`
		AADHex     string `json:"aadHex"`
	} `json:"localState"`
	EncryptedObject struct {
		KeyHex       string `json:"keyHex"`
		NonceHex     string `json:"nonceHex"`
		PlaintextHex string `json:"plaintextHex"`
		AADHex       string `json:"aadHex"`
		EnvelopeHex  string `json:"envelopeHex"`
	} `json:"encryptedObject"`
}

func loadVectors(t *testing.T) sharedVectors {
	t.Helper()
	data, err := os.ReadFile("../../tests/testdata/crypto-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors sharedVectors
	if err := json.Unmarshal(data, &vectors); err != nil {
		t.Fatal(err)
	}
	return vectors
}

func assertHex(t *testing.T, name, want string, got []byte, err error) {
	t.Helper()
	if err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	if hex.EncodeToString(got) != want {
		t.Errorf("%s = %x, want %s", name, got, want)
	}
}

func TestSharedV1AADVectors(t *testing.T) {
	v := loadVectors(t)
	got, err := KeySlotAAD(v.KeySlot.Input)
	assertHex(t, "KeySlotAADV1", v.KeySlot.AADHex, got, err)
	got, err = ChunkAAD(v.Chunk.Input)
	assertHex(t, "ChunkAADV1", v.Chunk.AADHex, got, err)
	got, err = ManifestAAD(v.Manifest.FileID)
	assertHex(t, "ManifestAADV1", v.Manifest.AADHex, got, err)
	got, err = ThumbnailAAD(v.Thumbnail.FileID)
	assertHex(t, "ThumbnailAADV1", v.Thumbnail.AADHex, got, err)
	got, err = IndexAAD(v.Index.MetadataID, v.Index.Revision)
	assertHex(t, "IndexAADV1", v.Index.AADHex, got, err)
	got, err = LocalStateAAD(v.LocalState.RecordType, v.LocalState.RecordID)
	assertHex(t, "LocalStateAADV1", v.LocalState.AADHex, got, err)
}

func TestSharedV2AADAndKeyDerivationVectors(t *testing.T) {
	data, err := os.ReadFile("../../tests/testdata/crypto-v2.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors struct {
		KeySlot struct {
			Input  KeySlotInput `json:"input"`
			AADHex string       `json:"aadHex"`
		} `json:"keySlot"`
		KeyDerivation struct {
			VaultKeyHex     string `json:"vaultKeyHex"`
			DataKeyHex      string `json:"dataKeyHex"`
			FileID          string `json:"fileId"`
			FileKeyHex      string `json:"fileKeyHex"`
			ThumbnailKeyHex string `json:"thumbnailKeyHex"`
		} `json:"keyDerivation"`
		Chunk struct {
			Input  ChunkInput `json:"input"`
			AADHex string     `json:"aadHex"`
		} `json:"chunk"`
		Manifest struct {
			FileID string `json:"fileId"`
			AADHex string `json:"aadHex"`
		} `json:"manifest"`
		Thumbnail struct {
			FileID string `json:"fileId"`
			AADHex string `json:"aadHex"`
		} `json:"thumbnail"`
	}
	if err := json.Unmarshal(data, &vectors); err != nil {
		t.Fatal(err)
	}
	got, err := KeySlotAAD(vectors.KeySlot.Input)
	assertHex(t, "KeySlotAADV2", vectors.KeySlot.AADHex, got, err)
	got, err = ChunkAADVersion(vectors.Chunk.Input, 2)
	assertHex(t, "ChunkAADV2", vectors.Chunk.AADHex, got, err)
	got, err = ManifestAADVersion(vectors.Manifest.FileID, 2)
	assertHex(t, "ManifestAADV2", vectors.Manifest.AADHex, got, err)
	got, err = ThumbnailAADVersion(vectors.Thumbnail.FileID, 2)
	assertHex(t, "ThumbnailAADV2", vectors.Thumbnail.AADHex, got, err)

	root := mustHex(t, vectors.KeyDerivation.VaultKeyHex)
	dataKey, err := hkdf.Key(sha256.New, root, nil, "xdrive/v1/data", 32)
	if err != nil {
		t.Fatal(err)
	}
	assertHex(t, "K_data", vectors.KeyDerivation.DataKeyHex, dataKey, nil)
	fileKey, err := hkdf.Key(sha256.New, dataKey, []byte(vectors.KeyDerivation.FileID), "xdrive/v1/file", 32)
	if err != nil {
		t.Fatal(err)
	}
	assertHex(t, "K_file", vectors.KeyDerivation.FileKeyHex, fileKey, nil)
	thumbnailKey, err := hkdf.Key(sha256.New, dataKey, []byte(vectors.KeyDerivation.FileID), "xdrive/v1/thumb", 32)
	if err != nil {
		t.Fatal(err)
	}
	assertHex(t, "K_thumb", vectors.KeyDerivation.ThumbnailKeyHex, thumbnailKey, nil)
}

func TestSharedEncryptedObjectVector(t *testing.T) {
	fixture := loadVectors(t).EncryptedObject
	key := mustHex(t, fixture.KeyHex)
	envelope := mustHex(t, fixture.EnvelopeHex)
	if len(envelope) < 36 || string(envelope[:4]) != "XDRV" || envelope[4] != 1 || envelope[5] != 1 || envelope[6] != 0 || envelope[7] != 0 {
		t.Fatalf("invalid EncryptedObjectV1 header: %x", envelope[:8])
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		t.Fatal(err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		t.Fatal(err)
	}
	plaintext, err := aead.Open(nil, envelope[8:20], envelope[20:], mustHex(t, fixture.AADHex))
	if err != nil {
		t.Fatal(err)
	}
	assertHex(t, "plaintext", fixture.PlaintextHex, plaintext, nil)
	assertHex(t, "nonce", fixture.NonceHex, envelope[8:20], nil)
}

func TestAADRejectsInvalidInputs(t *testing.T) {
	if _, err := LocalStateAAD("arbitrary", "record"); err == nil {
		t.Fatal("unsupported local state type accepted")
	}
	input := KeySlotInput{KDF: KDFParams{Alg: "argon2id", Salt: "%%%"}}
	if _, err := KeySlotAAD(input); err == nil {
		t.Fatal("invalid salt accepted")
	}
	if _, err := ChunkAADVersion(ChunkInput{FileID: "file"}, 3); err == nil {
		t.Fatal("unsupported chunk crypto version accepted")
	}
}

func mustHex(t *testing.T, value string) []byte {
	t.Helper()
	decoded, err := hex.DecodeString(value)
	if err != nil {
		t.Fatal(err)
	}
	return decoded
}
