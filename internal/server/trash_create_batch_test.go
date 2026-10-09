package server

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestBatchTrashFinalizationAtomicReplayAndOverlap(t *testing.T) {
	for _, failure := range []string{"", "missing-second", "overlap-second", "parent-selected"} {
		t.Run(failure, func(t *testing.T) {
			h, _ := concurrentUploadFixture(t)
			defer h.Close()
			now := time.Now().Unix()
			body := bytes.Repeat([]byte{8}, 36)
			digest := sha256.Sum256(body)
			for i := 0; i < 2; i++ {
				id := fmt.Sprintf("batch-original-%016d", i)
				if _, err := h.database.Exec("INSERT INTO objects(id,size_bytes,sha256,state,created_at) VALUES(?,36,?,'live',?)", id, digest[:], now); err != nil {
					t.Fatal(err)
				}
				metadata := fmt.Sprintf("batch-index-%016d", i)
				if _, err := h.database.Exec("INSERT INTO metadata_pointers VALUES(?,?,1,?)", metadata, id, now); err != nil {
					t.Fatal(err)
				}
				if _, err := h.database.Exec("INSERT INTO metadata_versions VALUES(?,1,?,?)", metadata, id, now); err != nil {
					t.Fatal(err)
				}
				build := fmt.Sprintf("batch-build-%016d", i)
				if _, err := h.database.Exec("INSERT INTO tombstone_builds VALUES(?,'active',?,?,0)", build, now, now+3600); err != nil {
					t.Fatal(err)
				}
				member := id
				if failure == "overlap-second" && i == 1 {
					member = "batch-original-0000000000000000"
				}
				if _, err := h.database.Exec("INSERT INTO tombstone_build_members VALUES(?,'object',?)", build, member); err != nil {
					t.Fatal(err)
				}
			}
			if failure == "parent-selected" {
				if _, err := h.database.Exec("INSERT INTO tombstone_build_members VALUES('batch-build-0000000000000001','metadata','batch-index-0000000000000000')"); err != nil {
					t.Fatal(err)
				}
			}
			upload := createTestUpload(t, h)
			if reserveTestUpload(t, h, upload, 36) != 200 {
				t.Fatal("reserve")
			}
			object := "batch-candidate-aaaaaaaaa"
			if putTestUploadObject(t, h, upload, object, body, digest[:]) != 201 {
				t.Fatal("PUT")
			}
			builds := []tombstoneBuildFinalization{{"batch-build-0000000000000000", "batch-root-0000000000000000"}, {"batch-build-0000000000000001", "batch-root-0000000000000001"}}
			if failure == "missing-second" {
				builds[1].BuildID = "batch-missing-aaaaaaaaaaa"
			}
			request := metadataTransactionRequest{UploadID: upload, ActivateObjectIDs: []string{object}, Updates: []metadataPointerUpdate{{MetadataID: "batch-index-0000000000000000", ExpectedRevision: 1, ObjectID: object}}, FinalizeTombstoneBuilds: builds}
			encoded, err := json.Marshal(request)
			if err != nil {
				t.Fatal(err)
			}
			response := metadataTransactionRequestForTest(t, h, string(encoded), "batch-trash-idempotency-aaaa")
			var roots, finalized, revision, pointer, pending int
			for query, target := range map[string]*int{"SELECT COUNT(*) FROM tombstones": &roots, "SELECT COUNT(*) FROM tombstone_builds WHERE state='finalized'": &finalized, "SELECT vault_mutation_revision FROM server_state": &revision, "SELECT revision FROM metadata_pointers WHERE id='batch-index-0000000000000000'": &pointer, "SELECT COUNT(*) FROM objects WHERE state='pending'": &pending} {
				if err := h.database.QueryRow(query).Scan(target); err != nil {
					t.Fatal(err)
				}
			}
			if failure != "" {
				if response.Code != 409 || roots != 0 || finalized != 0 || revision != 0 || pointer != 1 || pending != 1 {
					t.Fatalf("partial batch %d %s state=%v", response.Code, response.Body.String(), []int{roots, finalized, revision, pointer, pending})
				}
				return
			}
			if response.Code != 200 || roots != 2 || finalized != 2 || revision != 1 || pointer != 2 || pending != 0 {
				t.Fatalf("batch %d %s state=%v", response.Code, response.Body.String(), []int{roots, finalized, revision, pointer, pending})
			}
			replay := metadataTransactionRequestForTest(t, h, string(encoded), "batch-trash-idempotency-aaaa")
			if replay.Code != 200 || replay.Body.String() != response.Body.String() {
				t.Fatal("replay")
			}
			if err := h.database.QueryRow("SELECT vault_mutation_revision FROM server_state").Scan(&revision); err != nil || revision != 1 {
				t.Fatal("revision advanced on replay")
			}
		})
	}
}
func TestBatchTrashLifecycleValidation(t *testing.T) {
	base := metadataTransactionRequest{UploadID: "batch-upload-aaaaaaaaaaaa", ActivateObjectIDs: []string{"batch-object-aaaaaaaaaaaa"}, Updates: []metadataPointerUpdate{{MetadataID: "batch-index-aaaaaaaaaaaaa", ObjectID: "batch-object-aaaaaaaaaaaa", ExpectedRevision: 1}}, FinalizeTombstoneBuilds: []tombstoneBuildFinalization{{"batch-build-aaaaaaaaaaaaa", "batch-root-aaaaaaaaaaaaaa"}}}
	if !validMetadataTransaction(base) {
		t.Fatal("valid batch rejected")
	}
	for _, mode := range []string{"empty", "duplicate-build", "duplicate-root", "invalid", "mixed-single", "restore", "purge", "too-many"} {
		t.Run(mode, func(t *testing.T) {
			req := base
			req.FinalizeTombstoneBuilds = append([]tombstoneBuildFinalization(nil), base.FinalizeTombstoneBuilds...)
			switch mode {
			case "empty":
				req.FinalizeTombstoneBuilds = []tombstoneBuildFinalization{}
			case "duplicate-build":
				req.FinalizeTombstoneBuilds = append(req.FinalizeTombstoneBuilds, tombstoneBuildFinalization{base.FinalizeTombstoneBuilds[0].BuildID, "another-root-aaaaaaaaaaaa"})
			case "duplicate-root":
				req.FinalizeTombstoneBuilds = append(req.FinalizeTombstoneBuilds, tombstoneBuildFinalization{"another-build-aaaaaaaaaaa", base.FinalizeTombstoneBuilds[0].TombstoneID})
			case "invalid":
				req.FinalizeTombstoneBuilds[0].BuildID = "../bad"
			case "mixed-single":
				req.FinalizeTombstoneBuildID = "single-build-aaaaaaaaaaaa"
				req.CreateTombstoneID = "single-root-aaaaaaaaaaaaa"
			case "restore":
				req.RestoreTombstoneID = "restore-root-aaaaaaaaaaaa"
			case "purge":
				req.PurgeTombstoneIDs = []string{"purge-root-aaaaaaaaaaaaaa"}
			case "too-many":
				req.FinalizeTombstoneBuilds = make([]tombstoneBuildFinalization, 5001)
			}
			if validMetadataTransaction(req) {
				t.Fatal("invalid batch accepted")
			}
		})
	}
}
func TestFullQuotaBatchTrashThreeIndicesAtomicReplayAndLateOverlap(t *testing.T) {
	for _, overlap := range []bool{false, true} {
		t.Run(fmt.Sprint(overlap), func(t *testing.T) {
			h, root, request := fullQuotaTrashFixture(t, 256)
			defer h.Close()
			now := time.Now().Unix()
			body := bytes.Repeat([]byte{8}, 36)
			digest := sha256.Sum256(body)
			// Add a second original file and parent index while keeping quota exactly full.
			if _, err := h.database.Exec("UPDATE objects SET size_bytes=size_bytes-72 WHERE id='original-file-aaaaaaaaaaa'"); err != nil {
				t.Fatal(err)
			}
			var remaining int64
			if err := h.database.QueryRow("SELECT size_bytes FROM objects WHERE id='original-file-aaaaaaaaaaa'").Scan(&remaining); err != nil {
				t.Fatal(err)
			}
			if err := os.Truncate(filepath.Join(root, "or", "original-file-aaaaaaaaaaa"), remaining); err != nil {
				t.Fatal(err)
			}
			for _, id := range []string{"second-original-aaaaaaaaa", "old-second-index-aaaaaaaa"} {
				if _, err := h.database.Exec("INSERT INTO objects(id,size_bytes,sha256,state,created_at) VALUES(?,36,?,'live',?)", id, digest[:], now); err != nil {
					t.Fatal(err)
				}
				if err := os.MkdirAll(filepath.Join(root, id[:2]), 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(root, id[:2], id), body, 0600); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := h.database.Exec("INSERT INTO metadata_pointers VALUES('second-parent-aaaaaaaaaa','old-second-index-aaaaaaaa',1,?)", now); err != nil {
				t.Fatal(err)
			}
			if _, err := h.database.Exec("INSERT INTO metadata_versions VALUES('second-parent-aaaaaaaaaa',1,'old-second-index-aaaaaaaa',?)", now); err != nil {
				t.Fatal(err)
			}
			secondBuild := "second-build-aaaaaaaaaaaa"
			if _, err := h.database.Exec("INSERT INTO tombstone_builds VALUES(?,'active',?,?,0)", secondBuild, now, now+3600); err != nil {
				t.Fatal(err)
			}
			member := "second-original-aaaaaaaaa"
			if overlap {
				member = "original-file-aaaaaaaaaaa"
			}
			if _, err := h.database.Exec("INSERT INTO tombstone_build_members VALUES(?,'object',?)", secondBuild, member); err != nil {
				t.Fatal(err)
			}
			request.FinalizeTombstoneBuilds = []tombstoneBuildFinalization{{request.FinalizeTombstoneBuildID, request.CreateTombstoneID}, {secondBuild, "second-root-aaaaaaaaaaaaa"}}
			request.FinalizeTombstoneBuildID = ""
			request.CreateTombstoneID = ""
			request.Updates = append(request.Updates, metadataPointerUpdate{MetadataID: "second-parent-aaaaaaaaaa", ExpectedRevision: 1, ObjectID: "new-second-index-aaaaaaaa"})
			envelope := make([]byte, 36)
			copy(envelope, []byte{'X', 'D', 'R', 'V', 1, 1, 0, 0})
			request.EncryptedObjects = append(request.EncryptedObjects, base64.StdEncoding.EncodeToString(envelope))
			response := requestMaintenanceTrash(t, h, request, "full-batch-trash-idempotency")
			var roots, revision, journal, used, reserved int
			for query, target := range map[string]*int{"SELECT COUNT(*) FROM tombstones": &roots, "SELECT vault_mutation_revision FROM server_state": &revision, "SELECT COUNT(*) FROM metadata_maintenance": &journal, "SELECT SUM(size_bytes) FROM objects WHERE state IN ('live','pending')": &used, "SELECT capacity_bytes-COALESCE((SELECT SUM(size_bytes) FROM objects JOIN maintenance_quota_objects ON object_id=objects.id),0) FROM maintenance_quota": &reserved} {
				if err := h.database.QueryRow(query).Scan(target); err != nil {
					t.Fatal(err)
				}
			}
			if journal != 0 || used+reserved != 4096 {
				t.Fatalf("quota or journal %v", []int{journal, used, reserved})
			}
			if overlap {
				if response.Code != 409 || roots != 0 || revision != 0 || used != 3840 {
					t.Fatalf("partial maintenance %d %s %v", response.Code, response.Body.String(), []int{roots, revision, used})
				}
				return
			}
			if response.Code != 200 || roots != 2 || revision != 1 || used != 3948 {
				t.Fatalf("maintenance %d %s %v", response.Code, response.Body.String(), []int{roots, revision, used})
			}
			replay := requestMaintenanceTrash(t, h, request, "full-batch-trash-idempotency")
			if replay.Code != 200 || replay.Body.String() != response.Body.String() {
				t.Fatal("replay")
			}
		})
	}
}
