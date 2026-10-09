package server

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
)

func TestBatchRestoreAtomicMembershipAndCAS(t *testing.T) {
	for _, failure := range []string{"", "missing", "late-cas", "unselected"} {
		t.Run(failure, func(t *testing.T) {
			h, _ := concurrentUploadFixture(t)
			defer h.Close()
			body := bytes.Repeat([]byte{7}, 36)
			digest := sha256.Sum256(body)
			roots := []string{"restore-root-aaaaaaaaaaaa", "restore-root-bbbbbbbbbbbb", "restore-root-cccccccccccc"}
			for i, root := range roots {
				object, metadata := fmt.Sprintf("restore-object-%016d", i), fmt.Sprintf("restore-index-%016d", i)
				for _, statement := range []struct {
					query string
					args  []any
				}{
					{"INSERT INTO objects(id,size_bytes,sha256,state,created_at) VALUES(?,36,?,'live',1)", []any{object, digest[:]}},
					{"INSERT INTO tombstones(id,deleted_at,state) VALUES(?,1,'active')", []any{root}},
					{"INSERT INTO tombstone_objects(tombstone_id,object_id) VALUES(?,?)", []any{root, object}},
					{"INSERT INTO metadata_pointers(id,object_id,revision,updated_at) VALUES(?,?,1,1)", []any{metadata, object}},
					{"INSERT INTO metadata_versions(metadata_id,revision,object_id,created_at) VALUES(?,1,?,1)", []any{metadata, object}},
					{"INSERT INTO tombstone_metadata(tombstone_id,metadata_id) VALUES(?,?)", []any{root, metadata}},
				} {
					if _, err := h.database.Exec(statement.query, statement.args...); err != nil {
						t.Fatal(err)
					}
				}
			}
			session := createTestUpload(t, h)
			object := "restored-new-index-aaaaaaaa"
			if reserveTestUpload(t, h, session, 36) != 200 || putTestUploadObject(t, h, session, object, body, digest[:]) != 201 {
				t.Fatal("prepare")
			}
			ids := append([]string(nil), roots[:2]...)
			update := metadataPointerUpdate{MetadataID: "restore-index-0000000000000000", ObjectID: object, ExpectedRevision: 1}
			updates := []metadataPointerUpdate{update}
			if failure == "missing" {
				ids[1] = "missing-root-aaaaaaaaaaaa"
			}
			if failure == "late-cas" {
				updates = append(updates, metadataPointerUpdate{MetadataID: "restore-index-0000000000000001", ObjectID: object, ExpectedRevision: 99})
			}
			if failure == "unselected" {
				updates = append(updates, metadataPointerUpdate{MetadataID: "restore-index-0000000000000002", ObjectID: object, ExpectedRevision: 1})
			}
			encoded, err := json.Marshal(metadataTransactionRequest{UploadID: session, ActivateObjectIDs: []string{object}, Updates: updates, RestoreTombstoneIDs: ids})
			if err != nil {
				t.Fatal(err)
			}
			response := metadataTransactionRequestForTest(t, h, string(encoded), "restore-batch-idempotency-aaaa")
			var stones, members, live, pending, revision, pointerRevision int
			for query, target := range map[string]*int{
				"SELECT COUNT(*) FROM tombstones": &stones, "SELECT COUNT(*) FROM tombstone_metadata": &members,
				"SELECT COUNT(*) FROM objects WHERE state='live'": &live, "SELECT COUNT(*) FROM objects WHERE state='pending'": &pending,
				"SELECT vault_mutation_revision FROM server_state WHERE id=1":                      &revision,
				"SELECT revision FROM metadata_pointers WHERE id='restore-index-0000000000000000'": &pointerRevision,
			} {
				if err := h.database.QueryRow(query).Scan(target); err != nil {
					t.Fatal(err)
				}
			}
			if failure != "" {
				if response.Code != http.StatusConflict || stones != 3 || members != 3 || live != 3 || pending != 1 || revision != 0 || pointerRevision != 1 {
					t.Fatalf("partial restore %d %s counts=%v", response.Code, response.Body.String(), []int{stones, members, live, pending, revision, pointerRevision})
				}
			} else {
				if response.Code != 200 || stones != 1 || members != 1 || live != 4 || pending != 0 || revision != 1 || pointerRevision != 2 {
					t.Fatalf("restore %d %s counts=%v", response.Code, response.Body.String(), []int{stones, members, live, pending, revision, pointerRevision})
				}
				replay := metadataTransactionRequestForTest(t, h, string(encoded), "restore-batch-idempotency-aaaa")
				if replay.Code != 200 || replay.Body.String() != response.Body.String() {
					t.Fatal("replay")
				}
				if err := h.database.QueryRow("SELECT vault_mutation_revision FROM server_state WHERE id=1").Scan(&revision); err != nil || revision != 1 {
					t.Fatal("replay advanced revision")
				}
			}
		})
	}
}

func TestBatchRestoreValidation(t *testing.T) {
	base := metadataTransactionRequest{UploadID: "upload-session-aaaaaaaaa", ActivateObjectIDs: []string{"object-id-aaaaaaaaaaaaaa"}, Updates: []metadataPointerUpdate{{MetadataID: "metadata-id-aaaaaaaaaaaa", ObjectID: "object-id-aaaaaaaaaaaaaa"}}}
	for _, count := range []int{0, 1, 5000, 5001} {
		request := base
		request.RestoreTombstoneIDs = make([]string, count)
		for i := range request.RestoreTombstoneIDs {
			request.RestoreTombstoneIDs[i] = fmt.Sprintf("restore-root-%024d", i)
		}
		if validMetadataTransaction(request) != (count == 1 || count == 5000) {
			t.Fatalf("count=%d", count)
		}
	}
	for _, kind := range []string{"duplicate", "invalid", "singular", "purge", "purge-array", "build"} {
		request := base
		request.RestoreTombstoneIDs = []string{"restore-root-aaaaaaaaaaaa"}
		switch kind {
		case "duplicate":
			request.RestoreTombstoneIDs = append(request.RestoreTombstoneIDs, request.RestoreTombstoneIDs[0])
		case "invalid":
			request.RestoreTombstoneIDs = []string{"../unsafe"}
		case "singular":
			request.RestoreTombstoneID = "restore-root-bbbbbbbbbbbb"
		case "purge":
			request.PurgeTombstoneID = "restore-root-bbbbbbbbbbbb"
		case "purge-array":
			request.PurgeTombstoneIDs = []string{"restore-root-bbbbbbbbbbbb"}
		case "build":
			request.FinalizeTombstoneBuildID = "build-id-aaaaaaaaaaaaaa"
			request.CreateTombstoneID = "restore-root-bbbbbbbbbbbb"
		}
		if validMetadataTransaction(request) {
			t.Fatalf("accepted %s", kind)
		}
	}
}
