package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
	"xdrive/internal/backup"
	"xdrive/internal/config"
)

func fullQuotaTrashFixture(t *testing.T, capacity int64) (*Handler, string, maintenanceTrashRequest) {
	t.Helper()
	h, root := concurrentUploadFixture(t)
	if _, err := h.database.Exec("UPDATE maintenance_quota SET capacity_bytes=? WHERE id=1", capacity); err != nil {
		t.Fatal(err)
	}
	now := time.Now().Unix()
	for _, item := range []struct {
		id   string
		size int
	}{{"old-parent-index-aaaaaaaa", 36}, {"old-trash-index-aaaaaaaaa", 36}, {"original-file-aaaaaaaaaaa", int(4096 - capacity - 72)}} {
		data := bytes.Repeat([]byte{8}, item.size)
		digest := sha256.Sum256(data)
		if _, err := h.database.Exec("INSERT INTO objects(id,size_bytes,sha256,state,created_at) VALUES(?,?,?,'live',?)", item.id, item.size, digest[:], now); err != nil {
			t.Fatal(err)
		}
		dir := filepath.Join(root, item.id[:2])
		if err := os.MkdirAll(dir, 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, item.id), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	for _, pair := range []struct{ metadata, object string }{{"parent-index-aaaaaaaaaaaa", "old-parent-index-aaaaaaaa"}, {"trash-index-aaaaaaaaaaaaa", "old-trash-index-aaaaaaaaa"}} {
		if _, err := h.database.Exec("INSERT INTO metadata_pointers VALUES(?,?,1,?)", pair.metadata, pair.object, now); err != nil {
			t.Fatal(err)
		}
		if _, err := h.database.Exec("INSERT INTO metadata_versions VALUES(?,1,?,?)", pair.metadata, pair.object, now); err != nil {
			t.Fatal(err)
		}
	}
	build := "trash-build-aaaaaaaaaaaaa"
	if _, err := h.database.Exec("INSERT INTO tombstone_builds VALUES(?,'active',?,?,0)", build, now, now+3600); err != nil {
		t.Fatal(err)
	}
	if _, err := h.database.Exec("INSERT INTO tombstone_build_members VALUES(?,'object','original-file-aaaaaaaaaaa')", build); err != nil {
		t.Fatal(err)
	}
	envelope := make([]byte, 36)
	copy(envelope, []byte{'X', 'D', 'R', 'V', 1, 1, 0, 0})
	request := maintenanceTrashRequest{ExpectedGlobalRevision: 0, FinalizeTombstoneBuildID: build, CreateTombstoneID: "trash-root-aaaaaaaaaaaaaa", Updates: []metadataPointerUpdate{{MetadataID: "parent-index-aaaaaaaaaaaa", ObjectID: "new-parent-index-aaaaaaaa", ExpectedRevision: 1}, {MetadataID: "trash-index-aaaaaaaaaaaaa", ObjectID: "new-trash-index-aaaaaaaaa", ExpectedRevision: 1}}, EncryptedObjects: []string{base64.StdEncoding.EncodeToString(envelope), base64.StdEncoding.EncodeToString(envelope)}}
	return h, root, request
}
func requestMaintenanceTrash(t *testing.T, h *Handler, request maintenanceTrashRequest, key string) *httptest.ResponseRecorder {
	t.Helper()
	body, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest("POST", "/api/v1/metadata/maintenance-trash", bytes.NewReader(body))
	r.Header.Set(clientProtocolHeader, "1")
	r.Header.Set("Origin", "http://example.com")
	r.Header.Set("X-CSRF-Token", "test-csrf-token")
	r.Header.Set("Idempotency-Key", key)
	r.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "0123456789abcdefghijklmnopqrstuv"})
	response := httptest.NewRecorder()
	h.ServeHTTP(response, r)
	return response
}
func TestFullQuotaLogicalTrashPreservesDataAndQuota(t *testing.T) {
	h, root, request := fullQuotaTrashFixture(t, 512)
	defer h.Close()
	before := readUsage(t, h)
	if before["usedBytes"] != float64(3584) || before["uploadReservedBytes"] != float64(0) || before["maintenanceReservedBytes"] != float64(512) || before["availableBytes"] != float64(0) {
		t.Fatalf("not full live fixture %v", before)
	}
	session := createTestUpload(t, h)
	if reserveTestUpload(t, h, session, 72) != 507 {
		t.Fatal("ordinary upload borrowed maintenance headroom")
	}
	response := requestMaintenanceTrash(t, h, request, "maintenance-trash-key-aaaa")
	if response.Code != 200 {
		t.Fatalf("%d %s", response.Code, response.Body.String())
	}
	after := readUsage(t, h)
	if after["usedBytes"] != float64(3656) || after["reservedBytes"] != float64(440) || after["usedBytes"].(float64)+after["reservedBytes"].(float64) != float64(4096) || after["pendingBytes"] != float64(0) || after["uploadReservedBytes"] != float64(0) {
		t.Fatalf("quota exchange %v", after)
	}
	for _, id := range []string{"old-parent-index-aaaaaaaa", "old-trash-index-aaaaaaaaa", "original-file-aaaaaaaaaaa"} {
		data, err := os.ReadFile(filepath.Join(root, id[:2], id))
		if err != nil || len(data) == 0 || data[0] != 8 {
			t.Fatalf("old data lost %s %v", id, err)
		}
		var state string
		if err = h.database.QueryRow("SELECT state FROM objects WHERE id=?", id).Scan(&state); err != nil || state != "live" {
			t.Fatal("old data retired")
		}
	}
	var stones, versions, journals int
	for q, target := range map[string]*int{"SELECT COUNT(*) FROM tombstones": &stones, "SELECT COUNT(*) FROM metadata_versions": &versions, "SELECT COUNT(*) FROM metadata_maintenance": &journals} {
		if err := h.database.QueryRow(q).Scan(target); err != nil {
			t.Fatal(err)
		}
	}
	if stones != 1 || versions != 4 || journals != 0 {
		t.Fatalf("counts %v", []int{stones, versions, journals})
	}
	replay := requestMaintenanceTrash(t, h, request, "maintenance-trash-key-aaaa")
	if replay.Code != 200 || replay.Body.String() != response.Body.String() {
		t.Fatal("lost response replay")
	}
	var revision int
	if err := h.database.QueryRow("SELECT vault_mutation_revision FROM server_state WHERE id=1").Scan(&revision); err != nil || revision != 1 {
		t.Fatal("replay mutated")
	}
}
func TestMaintenanceTrashFailuresAreAtomic(t *testing.T) {
	for _, kind := range []string{"no-credit", "cas", "missing-build", "invalid-member", "selected-parent", "second-path-collision", "duplicate-index", "duplicate-object"} {
		t.Run(kind, func(t *testing.T) {
			capacity := int64(512)
			if kind == "no-credit" {
				capacity = 0
			}
			h, root, request := fullQuotaTrashFixture(t, capacity)
			defer h.Close()
			status := 409
			switch kind {
			case "no-credit":
				status = 507
			case "cas":
				request.Updates[1].ExpectedRevision = 2
			case "missing-build":
				request.FinalizeTombstoneBuildID = "missing-build-aaaaaaaaaaa"
			case "invalid-member":
				if _, err := h.database.Exec("UPDATE tombstone_build_members SET opaque_id='missing-object-aaaaaaaaa'"); err != nil {
					t.Fatal(err)
				}
			case "selected-parent":
				if _, err := h.database.Exec("INSERT INTO tombstone_build_members VALUES(?,'metadata',?)", request.FinalizeTombstoneBuildID, request.Updates[0].MetadataID); err != nil {
					t.Fatal(err)
				}
			case "second-path-collision":
				status = 500
				id := request.Updates[1].ObjectID
				dir := filepath.Join(root, id[:2])
				if err := os.MkdirAll(dir, 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(dir, id), []byte("foreign"), 0600); err != nil {
					t.Fatal(err)
				}
			case "duplicate-index":
				status = 400
				request.Updates[1].MetadataID = request.Updates[0].MetadataID
			case "duplicate-object":
				status = 400
				request.Updates[1].ObjectID = request.Updates[0].ObjectID
			}
			response := requestMaintenanceTrash(t, h, request, "maintenance-trash-key-aaaa")
			if response.Code != status {
				t.Fatalf("status=%d want=%d body=%s", response.Code, status, response.Body.String())
			}
			var stones, credits, journals, revision, versions int
			for q, target := range map[string]*int{"SELECT COUNT(*) FROM tombstones": &stones, "SELECT COUNT(*) FROM maintenance_quota_objects": &credits, "SELECT COUNT(*) FROM metadata_maintenance": &journals, "SELECT vault_mutation_revision FROM server_state WHERE id=1": &revision, "SELECT COUNT(*) FROM metadata_versions": &versions} {
				if err := h.database.QueryRow(q).Scan(target); err != nil {
					t.Fatal(err)
				}
			}
			if stones != 0 || credits != 0 || journals != 0 || revision != 0 || versions != 2 {
				t.Fatalf("partial commit %v", []int{stones, credits, journals, revision, versions})
			}
			if _, err := os.Stat(filepath.Join(root, "ne", request.Updates[0].ObjectID)); !os.IsNotExist(err) {
				t.Fatalf("orphan first candidate %v", err)
			}
			if kind == "second-path-collision" {
				data, err := os.ReadFile(filepath.Join(root, "ne", request.Updates[1].ObjectID))
				if err != nil || string(data) != "foreign" {
					t.Fatal("overwrote foreign object")
				}
			}
		})
	}
}
func TestMaintenanceQuotaInitializationAndRecycling(t *testing.T) {
	h, _, _ := fullQuotaTrashFixture(t, 512)
	defer h.Close()
	if err := initializeMaintenanceQuota(context.Background(), h.database, 4096, 512); err != nil {
		t.Fatal(err)
	}
	if err := initializeMaintenanceQuota(context.Background(), h.database, 4096, 1024); err == nil {
		t.Fatal("silently changed fixed reserve")
	}
	if _, err := h.database.Exec("DELETE FROM maintenance_quota"); err != nil {
		t.Fatal(err)
	}
	if err := initializeMaintenanceQuota(context.Background(), h.database, 4096, 1024); err == nil {
		t.Fatal("established headroom over existing full quota")
	}
	if err := initializeMaintenanceQuota(context.Background(), h.database, 4096, 512); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		id := fmt.Sprintf("maintenance-credit-%016d", i)
		digest := sha256.Sum256([]byte("fixture"))
		if _, err := h.database.Exec("INSERT INTO objects(id,size_bytes,sha256,state,created_at) VALUES(?,36,?,'live',1)", id, digest[:]); err != nil {
			t.Fatal(err)
		}
		if _, err := h.database.Exec("INSERT INTO maintenance_quota_objects VALUES(?)", id); err != nil {
			t.Fatal(err)
		}
	}
	remaining, err := maintenanceRemaining(context.Background(), h.database)
	if err != nil || remaining != 440 {
		t.Fatalf("live charge %d %v", remaining, err)
	}
	if _, err := h.database.Exec("UPDATE objects SET state='deleted' WHERE id='maintenance-credit-0000000000000000'"); err != nil {
		t.Fatal(err)
	}
	remaining, err = maintenanceRemaining(context.Background(), h.database)
	if err != nil || remaining != 476 {
		t.Fatalf("logical deletion refund %d %v", remaining, err)
	}
}

func TestRestartRecoversBothMaintenanceCandidates(t *testing.T) {
	h, root, request := fullQuotaTrashFixture(t, 512)
	defer h.Close()
	data := make([]byte, 36)
	copy(data, []byte{'X', 'D', 'R', 'V', 1, 1, 0, 0})
	for i, update := range request.Updates {
		if _, err := h.database.Exec("INSERT INTO metadata_maintenance VALUES(?,?,36,?)", i+1, update.ObjectID, time.Now().Unix()); err != nil {
			t.Fatal(err)
		}
		published := false
		if err := publishMaintenanceObject(root, update.ObjectID, data, &published); err != nil || !published {
			t.Fatal("publish candidate", err)
		}
	}
	if err := RecoverUploadClaimsAtStartup(context.Background(), h.database, root); err != nil {
		t.Fatal(err)
	}
	for _, update := range request.Updates {
		if _, err := os.Stat(filepath.Join(root, update.ObjectID[:2], update.ObjectID)); !os.IsNotExist(err) {
			t.Fatal("orphan candidate retained", err)
		}
	}
	remaining, err := maintenanceRemaining(context.Background(), h.database)
	if err != nil || remaining != 512 {
		t.Fatal("recovery spent quota", remaining, err)
	}
	var journals, versions int
	if err := h.database.QueryRow("SELECT COUNT(*) FROM metadata_maintenance").Scan(&journals); err != nil || journals != 0 {
		t.Fatal("journal retained")
	}
	if err := h.database.QueryRow("SELECT COUNT(*) FROM metadata_versions").Scan(&versions); err != nil || versions != 2 {
		t.Fatal("old history damaged")
	}
}

func TestMaintenanceTrashPreservesOtherUploadReservation(t *testing.T) {
	h, root, request := fullQuotaTrashFixture(t, 512)
	defer h.Close()
	id := "original-file-aaaaaaaaaaa"
	path := filepath.Join(root, id[:2], id)
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	data = data[:len(data)-128]
	digest := sha256.Sum256(data)
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := h.database.Exec("UPDATE objects SET size_bytes=?,sha256=? WHERE id=?", len(data), digest[:], id); err != nil {
		t.Fatal(err)
	}
	session := createTestUpload(t, h)
	if reserveTestUpload(t, h, session, 128) != 200 {
		t.Fatal("prepare other upload")
	}
	response := requestMaintenanceTrash(t, h, request, "maintenance-trash-key-aaaa")
	if response.Code != 200 {
		t.Fatalf("%d %s", response.Code, response.Body.String())
	}
	usage := readUsage(t, h)
	if usage["uploadReservedBytes"] != float64(128) || usage["maintenanceReservedBytes"] != float64(440) || usage["usedBytes"].(float64)+usage["reservedBytes"].(float64) != float64(4096) {
		t.Fatalf("other reservation was spent %v", usage)
	}
	if reserveTestUpload(t, h, session, 129) != 507 {
		t.Fatal("ordinary upload borrowed remaining headroom")
	}
}

func TestMaintenanceQuotaSurvivesBackupRestore(t *testing.T) {
	h, objects, request := fullQuotaTrashFixture(t, 512)
	defer h.Close()
	response := requestMaintenanceTrash(t, h, request, "maintenance-trash-key-aaaa")
	if response.Code != 200 {
		t.Fatal(response.Body.String())
	}
	source := filepath.Dir(objects)
	cfg := config.Config{ListenAddr: "127.0.0.1:8787", DatabasePath: filepath.Join(source, "drive.db"), StoragePath: objects, SecretPath: filepath.Join(source, "secret"), Username: "admin", QuotaBytes: 4096, MaintenanceReserveBytes: 512}
	destination := t.TempDir()
	if err := backup.Create(context.Background(), cfg, destination, true); err != nil {
		t.Fatal(err)
	}
	for _, failure := range []string{"capacity", "quota"} {
		rejected := t.TempDir()
		bad := cfg
		bad.DatabasePath = filepath.Join(rejected, "drive.db")
		bad.StoragePath = filepath.Join(rejected, "objects")
		bad.SecretPath = filepath.Join(rejected, "secret")
		if failure == "capacity" {
			bad.MaintenanceReserveBytes = 0
		} else {
			bad.QuotaBytes = 3656
		}
		if err := backup.Restore(context.Background(), bad, destination); err == nil {
			t.Fatal("activated incompatible restored quota", failure)
		}
		entries, err := os.ReadDir(rejected)
		if err != nil || len(entries) != 0 {
			t.Fatal("failed restore changed target", failure, err)
		}
	}
	target := t.TempDir()
	restoredConfig := cfg
	restoredConfig.DatabasePath = filepath.Join(target, "drive.db")
	restoredConfig.StoragePath = filepath.Join(target, "objects")
	restoredConfig.SecretPath = filepath.Join(target, "secret")
	if err := backup.Restore(context.Background(), restoredConfig, destination); err != nil {
		t.Fatal(err)
	}
	restored, err := New(restoredConfig)
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Close()
	remaining, err := maintenanceRemaining(context.Background(), restored.database)
	if err != nil || remaining != 440 {
		t.Fatalf("lost source charges %d %v", remaining, err)
	}
	var capacity, credits, sessions, journals int
	for q, value := range map[string]*int{"SELECT capacity_bytes FROM maintenance_quota WHERE id=1": &capacity, "SELECT COUNT(*) FROM maintenance_quota_objects": &credits, "SELECT COUNT(*) FROM sessions": &sessions, "SELECT COUNT(*) FROM metadata_maintenance": &journals} {
		if err := restored.database.QueryRow(q).Scan(value); err != nil {
			t.Fatal(err)
		}
	}
	if capacity != 512 || credits != 2 || sessions != 0 || journals != 0 {
		t.Fatalf("restored counts %v", []int{capacity, credits, sessions, journals})
	}
	for _, id := range []string{"old-parent-index-aaaaaaaa", "old-trash-index-aaaaaaaaa", "original-file-aaaaaaaaaaa", request.Updates[0].ObjectID, request.Updates[1].ObjectID} {
		original, err := os.ReadFile(filepath.Join(objects, id[:2], id))
		if err != nil {
			t.Fatal(err)
		}
		copied, err := os.ReadFile(filepath.Join(restoredConfig.StoragePath, id[:2], id))
		if err != nil || !bytes.Equal(original, copied) {
			t.Fatal("restore changed bytes", id, err)
		}
	}
}

func TestMaintenanceTrashEightMiBBoundary(t *testing.T) {
	root := t.TempDir()
	cfg := config.Config{ListenAddr: "127.0.0.1:8787", DatabasePath: filepath.Join(root, "drive.db"), StoragePath: filepath.Join(root, "objects"), SecretPath: filepath.Join(root, "secret"), Username: "admin", QuotaBytes: (16 << 20) + 36, MaintenanceReserveBytes: 8 << 20}
	h, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	addAuthenticatedTestSession(t, h)
	now := time.Now().Unix()
	digest := sha256.Sum256([]byte("opaque accounting fixture"))
	for _, item := range []struct {
		id   string
		size int
	}{{"old-parent-index-aaaaaaaa", 36}, {"old-trash-index-aaaaaaaaa", 36}, {"original-file-aaaaaaaaaaa", (8 << 20) - 72}, {"second-original-aaaaaaaaa", 36}} {
		if _, err := h.database.Exec("INSERT INTO objects(id,size_bytes,sha256,state,created_at) VALUES(?,?,?,'live',?)", item.id, item.size, digest[:], now); err != nil {
			t.Fatal(err)
		}
	}
	secondOriginal := bytes.Repeat([]byte{9}, 36)
	secondOriginalDigest := sha256.Sum256(secondOriginal)
	if _, err := h.database.Exec("UPDATE objects SET sha256=? WHERE id='second-original-aaaaaaaaa'", secondOriginalDigest[:]); err != nil {
		t.Fatal(err)
	}
	secondOriginalDir := filepath.Join(cfg.StoragePath, "se")
	if err := os.MkdirAll(secondOriginalDir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(secondOriginalDir, "second-original-aaaaaaaaa"), secondOriginal, 0600); err != nil {
		t.Fatal(err)
	}
	for _, pair := range []struct{ metadata, object string }{{"parent-index-aaaaaaaaaaaa", "old-parent-index-aaaaaaaa"}, {"trash-index-aaaaaaaaaaaaa", "old-trash-index-aaaaaaaaa"}} {
		if _, err := h.database.Exec("INSERT INTO metadata_pointers VALUES(?,?,1,?)", pair.metadata, pair.object, now); err != nil {
			t.Fatal(err)
		}
		if _, err := h.database.Exec("INSERT INTO metadata_versions VALUES(?,1,?,?)", pair.metadata, pair.object, now); err != nil {
			t.Fatal(err)
		}
	}
	build := "trash-build-aaaaaaaaaaaaa"
	if _, err := h.database.Exec("INSERT INTO tombstone_builds VALUES(?,'active',?,?,0)", build, now, now+3600); err != nil {
		t.Fatal(err)
	}
	if _, err := h.database.Exec("INSERT INTO tombstone_build_members VALUES(?,'object','original-file-aaaaaaaaaaa')", build); err != nil {
		t.Fatal(err)
	}
	envelope := make([]byte, 4<<20)
	copy(envelope, []byte{'X', 'D', 'R', 'V', 1, 1, 0, 0})
	encoded := base64.StdEncoding.EncodeToString(envelope)
	request := maintenanceTrashRequest{ExpectedGlobalRevision: 0, FinalizeTombstoneBuildID: build, CreateTombstoneID: "trash-root-aaaaaaaaaaaaaa", Updates: []metadataPointerUpdate{{MetadataID: "parent-index-aaaaaaaaaaaa", ObjectID: "new-parent-index-aaaaaaaa", ExpectedRevision: 1}, {MetadataID: "trash-index-aaaaaaaaaaaaa", ObjectID: "new-trash-index-aaaaaaaaa", ExpectedRevision: 1}}, EncryptedObjects: []string{encoded, encoded}}
	before := readUsage(t, h)
	if before["availableBytes"] != float64(0) {
		t.Fatal("not full")
	}
	response := requestMaintenanceTrash(t, h, request, "maintenance-trash-key-aaaa")
	if response.Code != 200 {
		t.Fatalf("%d %s", response.Code, response.Body.String())
	}
	after := readUsage(t, h)
	if after["usedBytes"] != float64((16<<20)+36) || after["reservedBytes"] != float64(0) || after["maintenanceReservedBytes"] != float64(0) || after["availableBytes"] != float64(0) {
		t.Fatalf("boundary exchange %v", after)
	}
	for _, update := range request.Updates {
		info, err := os.Stat(filepath.Join(cfg.StoragePath, update.ObjectID[:2], update.ObjectID))
		if err != nil || info.Size() != 4<<20 {
			t.Fatal("bounded publication", err)
		}
	}
	remaining, err := maintenanceRemaining(context.Background(), h.database)
	if err != nil || remaining != 0 {
		t.Fatalf("maintenance pool was not exhausted: %d %v", remaining, err)
	}
	secondBuild := "exhausted-trash-build-aaaaaaaa"
	if _, err := h.database.Exec("INSERT INTO tombstone_builds VALUES(?,'active',?,?,1)", secondBuild, now, now+3600); err != nil {
		t.Fatal(err)
	}
	if _, err := h.database.Exec("INSERT INTO tombstone_build_members VALUES(?,'object','second-original-aaaaaaaaa')", secondBuild); err != nil {
		t.Fatal(err)
	}
	secondEnvelope := make([]byte, 36)
	copy(secondEnvelope, []byte{'X', 'D', 'R', 'V', 1, 1, 0, 0})
	secondEncoded := base64.StdEncoding.EncodeToString(secondEnvelope)
	secondRequest := maintenanceTrashRequest{
		ExpectedGlobalRevision:   1,
		FinalizeTombstoneBuildID: secondBuild,
		CreateTombstoneID:        "exhausted-trash-root-aaaaaaaa",
		Updates: []metadataPointerUpdate{
			{MetadataID: request.Updates[0].MetadataID, ExpectedRevision: 2, ObjectID: "exhausted-parent-object-aaaaaaa"},
			{MetadataID: request.Updates[1].MetadataID, ExpectedRevision: 2, ObjectID: "exhausted-trash-object-aaaaaaaa"},
		},
		EncryptedObjects: []string{secondEncoded, secondEncoded},
	}
	refused := requestMaintenanceTrash(t, h, secondRequest, "maintenance-trash-exhausted-aaaa")
	if refused.Code != http.StatusInsufficientStorage || !bytes.Contains(refused.Body.Bytes(), []byte("maintenance_reserve_exhausted")) {
		t.Fatalf("exhausted pool response %d %s", refused.Code, refused.Body.String())
	}
	afterRefusal := readUsage(t, h)
	if afterRefusal["usedBytes"] != after["usedBytes"] || afterRefusal["reservedBytes"] != float64(0) || afterRefusal["maintenanceReservedBytes"] != float64(0) || afterRefusal["availableBytes"] != float64(0) {
		t.Fatalf("exhausted refusal changed accounting: %v", afterRefusal)
	}
	var revision, roots, journals, pointerRevision int
	for query, target := range map[string]*int{
		"SELECT vault_mutation_revision FROM server_state WHERE id=1": &revision,
		"SELECT COUNT(*) FROM tombstones":                             &roots,
		"SELECT COUNT(*) FROM metadata_maintenance":                   &journals,
		"SELECT revision FROM metadata_pointers WHERE id=?":           &pointerRevision,
	} {
		var err error
		if query == "SELECT revision FROM metadata_pointers WHERE id=?" {
			err = h.database.QueryRow(query, request.Updates[0].MetadataID).Scan(target)
		} else {
			err = h.database.QueryRow(query).Scan(target)
		}
		if err != nil {
			t.Fatal(err)
		}
	}
	if revision != 1 || roots != 1 || journals != 0 || pointerRevision != 2 {
		t.Fatalf("exhausted refusal partially committed: revision=%d roots=%d journals=%d pointer=%d", revision, roots, journals, pointerRevision)
	}
	if data, err := os.ReadFile(filepath.Join(secondOriginalDir, "second-original-aaaaaaaaa")); err != nil || !bytes.Equal(data, secondOriginal) {
		t.Fatalf("source file changed after refusal: %v", err)
	}
	for _, update := range secondRequest.Updates {
		if _, err := os.Stat(filepath.Join(cfg.StoragePath, update.ObjectID[:2], update.ObjectID)); !os.IsNotExist(err) {
			t.Fatalf("exhausted refusal published candidate %s: %v", update.ObjectID, err)
		}
	}
	// This tests bounded opaque envelope admission/accounting, not AEAD business
	// payloads or target-server peak RSS. Browser tests provide real cryptography.
}
