package cryptofmt

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"encoding/json"
	"fmt"
	"os"
	"testing"
)

type aeadVector struct {
	Name         string `json:"name"`
	KeyHex       string `json:"keyHex"`
	NonceHex     string `json:"nonceHex"`
	PlaintextHex string `json:"plaintextHex"`
	AADHex       string `json:"aadHex"`
	EnvelopeHex  string `json:"envelopeHex"`
}

func TestSharedAEADOutputAndTamperMatrix(t *testing.T) {
	data, err := os.ReadFile("../../tests/testdata/crypto-aead.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Schema  int          `json:"schema"`
		Vectors []aeadVector `json:"vectors"`
	}
	if err = json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Schema != 1 || len(fixture.Vectors) != 30 {
		t.Fatal("unexpected shared AEAD inventory")
	}
	for _, v := range fixture.Vectors {
		t.Run(v.Name, func(t *testing.T) {
			key, nonce, plain, aad, want := mustHex(t, v.KeyHex), mustHex(t, v.NonceHex), mustHex(t, v.PlaintextHex), mustHex(t, v.AADHex), mustHex(t, v.EnvelopeHex)
			block, err := aes.NewCipher(key)
			if err != nil {
				t.Fatal(err)
			}
			aead, err := cipher.NewGCM(block)
			if err != nil {
				t.Fatal(err)
			}
			got := append([]byte{'X', 'D', 'R', 'V', 1, 1, 0, 0}, nonce...)
			got = append(got, aead.Seal(nil, nonce, plain, aad)...)
			if !bytes.Equal(got, want) {
				t.Fatalf("full deterministic envelope differs: %x", got)
			}
			opened, err := aead.Open(nil, want[8:20], want[20:], aad)
			if err != nil || !bytes.Equal(opened, plain) {
				t.Fatalf("positive decrypt: %v", err)
			}
			for _, field := range []struct {
				name       string
				begin, end int
			}{{"nonce", 8, 20}, {"ciphertext", 20, len(want) - 16}, {"tag", len(want) - 16, len(want)}} {
				for offset := field.begin; offset < field.end; offset++ {
					for bit := byte(1); bit != 0; bit <<= 1 {
						changed := bytes.Clone(want)
						changed[offset] ^= bit
						if _, err := aead.Open(nil, changed[8:20], changed[20:], aad); err == nil {
							t.Fatal(fmt.Sprintf("accepted %s offset%d bit%x", field.name, offset, bit))
						}
					}
				}
			}
			for offset := range aad {
				for bit := byte(1); bit != 0; bit <<= 1 {
					changed := bytes.Clone(aad)
					changed[offset] ^= bit
					if _, err := aead.Open(nil, want[8:20], want[20:], changed); err == nil {
						t.Fatalf("accepted AAD offset%d bit%x", offset, bit)
					}
				}
			}
			wrong := bytes.Clone(key)
			wrong[0] ^= 1
			block, err = aes.NewCipher(wrong)
			if err != nil {
				t.Fatal(err)
			}
			other, err := cipher.NewGCM(block)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = other.Open(nil, want[8:20], want[20:], aad); err == nil {
				t.Fatal("accepted wrong key")
			}
		})
	}
}

func TestSharedWrappedVaultKeyOutput(t *testing.T) {
	data, err := os.ReadFile("../../tests/testdata/crypto-aead.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		KeySlots []struct {
			Input                                                 KeySlotInput `json:"input"`
			KeyHex, NonceHex, PlaintextHex, AADHex, CiphertextHex string
		} `json:"keySlots"`
	}
	if err = json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	if len(fixture.KeySlots) != 2 {
		t.Fatal("missing wrapped-key vectors")
	}
	for _, v := range fixture.KeySlots {
		t.Run(fmt.Sprintf("format%d", v.Input.FormatVersion), func(t *testing.T) {
			aad, err := KeySlotAAD(v.Input)
			assertHex(t, "key-slot AAD", v.AADHex, aad, err)
			block, err := aes.NewCipher(mustHex(t, v.KeyHex))
			if err != nil {
				t.Fatal(err)
			}
			aead, err := cipher.NewGCM(block)
			if err != nil {
				t.Fatal(err)
			}
			nonce, plain, wrapped := mustHex(t, v.NonceHex), mustHex(t, v.PlaintextHex), mustHex(t, v.CiphertextHex)
			if len(plain) != 32 || len(wrapped) != 48 {
				t.Fatal("unexpected wrapped Vault Key lengths")
			}
			if !bytes.Equal(aead.Seal(nil, nonce, plain, aad), wrapped) {
				t.Fatal("wrapped-key output differs")
			}
			opened, err := aead.Open(nil, nonce, wrapped, aad)
			if err != nil || !bytes.Equal(opened, plain) {
				t.Fatalf("unwrap: %v", err)
			}
		})
	}
}
