package cryptofmt

import (
	"encoding/json"
	"os"
	"strconv"
	"testing"
)

func TestSharedIntegerAndUTF8Boundaries(t *testing.T) {
	data, err := os.ReadFile("../../tests/testdata/crypto-encoding.json")
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Schema int                             `json:"schema"`
		U32    []struct{ Decimal, Hex string } `json:"u32"`
		U64    []struct{ Decimal, Hex string } `json:"u64"`
		LP     []struct{ Value, Hex string }   `json:"lp"`
	}
	if err = json.Unmarshal(data, &v); err != nil {
		t.Fatal(err)
	}
	if v.Schema != 1 || len(v.U32) != 3 || len(v.U64) != 5 || len(v.LP) != 5 {
		t.Fatal("unexpected encoding inventory")
	}
	for _, value := range v.U32 {
		n, err := strconv.ParseUint(value.Decimal, 10, 32)
		if err != nil {
			t.Fatal(err)
		}
		assertHex(t, "uint32", value.Hex, u32(uint32(n)), nil)
	}
	for _, value := range v.U64 {
		n, err := strconv.ParseUint(value.Decimal, 10, 64)
		if err != nil {
			t.Fatal(err)
		}
		assertHex(t, "uint64", value.Hex, u64(n), nil)
	}
	for _, value := range v.LP {
		if !validStrings(value.Value) {
			t.Fatal("valid UTF-8 rejected")
		}
		assertHex(t, "UTF-8 LP", value.Hex, lp([]byte(value.Value)), nil)
	}
}

func TestAADVersionAndInvalidUTF8Boundaries(t *testing.T) {
	for _, version := range []uint32{0, 3, 255, 4294967295} {
		if _, err := ChunkAADVersion(ChunkInput{FileID: "valid"}, version); err == nil {
			t.Fatalf("accepted chunk version%d", version)
		}
		if _, err := ManifestAADVersion("valid", version); err == nil {
			t.Fatalf("accepted manifest version%d", version)
		}
		if _, err := ThumbnailAADVersion("valid", version); err == nil {
			t.Fatalf("accepted thumbnail version%d", version)
		}
	}
	for _, invalid := range []string{string([]byte{0xff}), string([]byte{0xc0, 0x80}), string([]byte{0xed, 0xa0, 0x80})} {
		if _, err := ManifestAAD(invalid); err == nil {
			t.Fatal("accepted invalid UTF-8 manifest ID")
		}
		if _, err := IndexAAD(invalid, 0); err == nil {
			t.Fatal("accepted invalid UTF-8 metadata ID")
		}
		if _, err := LocalStateAAD("upload-resume", invalid); err == nil {
			t.Fatal("accepted invalid UTF-8 record ID")
		}
	}
}
