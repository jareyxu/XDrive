package server

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
)

func TestBatchPurgeIsAtomicAndIdempotent(t *testing.T) {
	for _, missing := range []bool{false, true} {
		t.Run(fmt.Sprint(missing), func(t *testing.T) {
			h, _ := concurrentUploadFixture(t)
			defer h.Close()
			body := bytes.Repeat([]byte{4}, 36)
			digest := sha256.Sum256(body)
			roots := []string{"trash-root-aaaaaaaaaaaaaa", "trash-root-bbbbbbbbbbbbbb", "trash-root-cccccccccccccc"}
			for i, root := range roots {
				id := fmt.Sprintf("object-trash-%016d", i)
				if _, err := h.database.Exec("INSERT INTO objects(id,size_bytes,sha256,state,created_at) VALUES(?,36,?,'live',1)", id, digest[:]); err != nil {
					t.Fatal(err)
				}
				if _, err := h.database.Exec("INSERT INTO tombstones(id,deleted_at,state) VALUES(?,1,'active')", root); err != nil {
					t.Fatal(err)
				}
				if _, err := h.database.Exec("INSERT INTO tombstone_objects(tombstone_id,object_id) VALUES(?,?)", root, id); err != nil {
					t.Fatal(err)
				}
				metadata := fmt.Sprintf("child-index-%016d", i)
				if _, err := h.database.Exec("INSERT INTO metadata_pointers(id,object_id,revision,updated_at) VALUES(?,?,1,1)", metadata, id); err != nil {
					t.Fatal(err)
				}
				if _, err := h.database.Exec("INSERT INTO metadata_versions(metadata_id,revision,object_id,created_at) VALUES(?,1,?,1)", metadata, id); err != nil {
					t.Fatal(err)
				}
				if _, err := h.database.Exec("INSERT INTO tombstone_metadata(tombstone_id,metadata_id) VALUES(?,?)", root, metadata); err != nil {
					t.Fatal(err)
				}
			}
			session := createTestUpload(t, h)
			if reserveTestUpload(t, h, session, 36) != http.StatusOK || putTestUploadObject(t, h, session, "new-trash-index-object-aaaa", body, digest[:]) != http.StatusCreated {
				t.Fatal("prepare index")
			}
			ids := roots[:2]
			if missing {
				ids = []string{roots[0], "missing-root-aaaaaaaaaaaa"}
			}
			request := metadataTransactionRequest{UploadID: session, ActivateObjectIDs: []string{"new-trash-index-object-aaaa"}, Updates: []metadataPointerUpdate{{MetadataID: "trash-index-aaaaaaaaaaaa", ObjectID: "new-trash-index-object-aaaa"}}, PurgeTombstoneIDs: ids}
			encoded, err := json.Marshal(request)
			if err != nil {
				t.Fatal(err)
			}
			response := metadataTransactionRequestForTest(t, h, string(encoded), "batch-purge-idempotency-aaaa")
			var stones, deleted, pending, pointers, versions, revision int
			for query, target := range map[string]*int{
				"SELECT COUNT(*) FROM tombstones": &stones, "SELECT COUNT(*) FROM objects WHERE state='deleted'": &deleted,
				"SELECT COUNT(*) FROM objects WHERE state='pending'": &pending, "SELECT COUNT(*) FROM metadata_pointers": &pointers,
				"SELECT COUNT(*) FROM metadata_versions": &versions, "SELECT vault_mutation_revision FROM server_state WHERE id=1": &revision,
			} {
				if err := h.database.QueryRow(query).Scan(target); err != nil {
					t.Fatal(err)
				}
			}
			if missing {
				if response.Code != http.StatusConflict || stones != 3 || deleted != 0 || pending != 1 || pointers != 3 || versions != 3 || revision != 0 {
					t.Fatalf("partial purge status=%d counts=%v body=%s", response.Code, []int{stones, deleted, pending, pointers, versions, revision}, response.Body.String())
				}
			} else {
				if response.Code != http.StatusOK || stones != 1 || deleted != 2 || pending != 0 || pointers != 2 || versions != 2 || revision != 1 {
					t.Fatalf("purge status=%d counts=%v body=%s", response.Code, []int{stones, deleted, pending, pointers, versions, revision}, response.Body.String())
				}
				replay := metadataTransactionRequestForTest(t, h, string(encoded), "batch-purge-idempotency-aaaa")
				if replay.Code != http.StatusOK || replay.Body.String() != response.Body.String() {
					t.Fatal("lost-response replay failed")
				}
				if err := h.database.QueryRow("SELECT vault_mutation_revision FROM server_state WHERE id=1").Scan(&revision); err != nil || revision != 1 {
					t.Fatal("replay mutated revision")
				}
				abandon := uploadRequest(t, h, http.MethodPost, "/api/v1/uploads/"+session+"/abandon", []byte(`{}`))
				if abandon.Code != http.StatusNotFound {
					t.Fatal("cancellation must not abandon a committed session")
				}
				var state string
				if err := h.database.QueryRow("SELECT state FROM objects WHERE id='new-trash-index-object-aaaa'").Scan(&state); err != nil || state != "live" {
					t.Fatal("late abandonment damaged committed index")
				}
			}
		})
	}
}

func TestBatchPurgeValidationBoundsAndExclusiveActions(t *testing.T) {
	base := metadataTransactionRequest{UploadID: "upload-session-aaaaaaaaa", ActivateObjectIDs: []string{"object-id-aaaaaaaaaaaaaa"}, Updates: []metadataPointerUpdate{{MetadataID: "metadata-id-aaaaaaaaaaaa", ObjectID: "object-id-aaaaaaaaaaaaaa"}}}
	for _, count := range []int{0, 1, 5000, 5001} {
		request := base
		request.PurgeTombstoneIDs = make([]string, count)
		for i := range request.PurgeTombstoneIDs {
			request.PurgeTombstoneIDs[i] = fmt.Sprintf("tombstone-%024d", i)
		}
		if validMetadataTransaction(request) != (count == 1 || count == 5000) {
			t.Fatalf("count=%d", count)
		}
	}
	for _, kind := range []string{"duplicate", "invalid", "singular", "restore", "build"} {
		request := base
		request.PurgeTombstoneIDs = []string{"tombstone-aaaaaaaaaaaaaa"}
		switch kind {
		case "duplicate":
			request.PurgeTombstoneIDs = append(request.PurgeTombstoneIDs, request.PurgeTombstoneIDs[0])
		case "invalid":
			request.PurgeTombstoneIDs = []string{"../unsafe"}
		case "singular":
			request.PurgeTombstoneID = "tombstone-bbbbbbbbbbbbbb"
		case "restore":
			request.RestoreTombstoneID = "tombstone-bbbbbbbbbbbbbb"
		case "build":
			request.FinalizeTombstoneBuildID = "build-id-aaaaaaaaaaaaaa"
			request.CreateTombstoneID = "tombstone-bbbbbbbbbbbbbb"
		}
		if validMetadataTransaction(request) {
			t.Fatalf("accepted %s", kind)
		}
	}
}
