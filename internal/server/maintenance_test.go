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
	"xdrive/internal/storage"
)

func TestFullQuotaRejectsOrdinaryCleanupReservation(t *testing.T) {
	h, _ := concurrentUploadFixture(t)
	session := createTestUpload(t, h)
	if reserveTestUpload(t, h, session, 4096) != http.StatusOK {
		t.Fatal("full reservation")
	}
	cleanup := createTestUpload(t, h)
	if reserveTestUpload(t, h, cleanup, 36) != http.StatusInsufficientStorage {
		t.Fatal("ordinary cleanup must not bypass full quota")
	}
	if readUsage(t, h)["availableBytes"] != float64(0) {
		t.Fatal("fixture is not exactly full")
	}
}

// Opaque fixture objects test transaction accounting; real AEAD round trips
// are covered by the browser maintenance test, not by this schema fixture.
func maintenanceFixture(t *testing.T, memberBytes int) (*Handler, string, []byte) {
	h, path := concurrentUploadFixture(t)
	digest := sha256.Sum256([]byte("opaque fixture"))
	for _, item := range []struct {
		id   string
		size int
	}{{"old-trash-index-aaaaaaaa", 36}, {"trash-member-aaaaaaaaaaa", memberBytes}} {
		if _, err := h.database.Exec("INSERT INTO objects(id,size_bytes,sha256,state,created_at) VALUES(?,?,?,'live',1)", item.id, item.size, digest[:]); err != nil {
			t.Fatal(err)
		}
	}
	for _, query := range []string{
		"INSERT INTO metadata_pointers VALUES('trash-index-aaaaaaaaaaa','old-trash-index-aaaaaaaa',1,1)",
		"INSERT INTO metadata_versions VALUES('trash-index-aaaaaaaaaaa',1,'old-trash-index-aaaaaaaa',1)",
		"INSERT INTO tombstones VALUES('trash-root-aaaaaaaaaaaa',1,'active')",
		"INSERT INTO tombstone_objects VALUES('trash-root-aaaaaaaaaaaa','trash-member-aaaaaaaaaaa')",
	} {
		if _, err := h.database.Exec(query); err != nil {
			t.Fatal(err)
		}
	}
	session := createTestUpload(t, h)
	if reserveTestUpload(t, h, session, int64(4096-36-memberBytes)) != http.StatusOK {
		t.Fatal("fill reservation")
	}
	envelope := make([]byte, 36)
	copy(envelope, []byte{'X', 'D', 'R', 'V', 1, 1, 0, 0})
	return h, path, envelope
}

func maintenanceBody(envelope []byte) []byte {
	result, _ := json.Marshal(map[string]any{"expectedGlobalRevision": 0, "purgeTombstoneIds": []string{"trash-root-aaaaaaaaaaaa"}, "updates": []metadataPointerUpdate{{MetadataID: "trash-index-aaaaaaaaaaa", ExpectedRevision: 1, ObjectID: "new-trash-index-aaaaaaaa"}}, "encryptedObject": base64.StdEncoding.EncodeToString(envelope)})
	return result
}

func maintenanceRequest(t *testing.T, h *Handler, body []byte, key string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest("POST", "/api/v1/metadata/maintenance-purge", bytes.NewReader(body))
	r.Header.Set(clientProtocolHeader, "1")
	r.Header.Set("Origin", "http://example.com")
	r.Header.Set("X-CSRF-Token", "test-csrf-token")
	r.Header.Set("Idempotency-Key", key)
	r.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "0123456789abcdefghijklmnopqrstuv"})
	result := httptest.NewRecorder()
	h.ServeHTTP(result, r)
	return result
}
func TestMaintenancePurgeUsesOnlyCommittedCredits(t *testing.T) {
	for _, memberBytes := range []int{36, 200} {
		t.Run(fmt.Sprint(memberBytes), func(t *testing.T) {
			h, path, envelope := maintenanceFixture(t, memberBytes)
			before := readUsage(t, h)
			if before["availableBytes"] != float64(0) {
				t.Fatal("not full")
			}
			body := maintenanceBody(envelope)
			response := maintenanceRequest(t, h, body, "maintenance-key-aaaaaaaaa")
			if response.Code != 200 {
				t.Fatalf("%d %s", response.Code, response.Body.String())
			}
			usage := readUsage(t, h)
			if usage["usedBytes"] != float64(72) || usage["reservedBytes"] != before["reservedBytes"] || usage["trashBytes"] != float64(0) || usage["pendingBytes"] != float64(0) {
				t.Fatalf("incorrect usage: %v", usage)
			}
			replay := maintenanceRequest(t, h, body, "maintenance-key-aaaaaaaaa")
			if replay.Code != 200 || replay.Body.String() != response.Body.String() {
				t.Fatal("response lost replay failed")
			}
			var versions, revision, journal int
			for q, v := range map[string]*int{"SELECT COUNT(*) FROM metadata_versions": &versions, "SELECT vault_mutation_revision FROM server_state": &revision, "SELECT COUNT(*) FROM metadata_maintenance": &journal} {
				if err := h.database.QueryRow(q).Scan(v); err != nil {
					t.Fatal(err)
				}
			}
			if versions != 2 || revision != 1 || journal != 0 {
				t.Fatalf("history/replay/journal %d/%d/%d", versions, revision, journal)
			}
			stored, err := os.ReadFile(filepath.Join(path, "ne", "new-trash-index-aaaaaaaa"))
			if err != nil || !bytes.Equal(stored, envelope) {
				t.Fatal("published bytes")
			}
			changed := bytes.Replace(body, []byte("new-trash-index-aaaaaaaa"), []byte("new-trash-index-bbbbbbbb"), 1)
			if result := maintenanceRequest(t, h, changed, "maintenance-key-aaaaaaaaa"); result.Code != 409 || !bytes.Contains(result.Body.Bytes(), []byte("idempotency_conflict")) {
				t.Fatal("different replay accepted")
			}
		})
	}
}

func TestMaintenanceFailuresLeaveQuotaAndRootsUnchanged(t *testing.T) {
	for _, kind := range []string{"quota", "global", "local", "missing", "duplicate", "object", "unknown", "envelope", "journal", "fence", "tombstoned"} {
		t.Run(kind, func(t *testing.T) {
			h, path, envelope := maintenanceFixture(t, 36)
			body := maintenanceBody(envelope)
			var value map[string]any
			_ = json.Unmarshal(body, &value)
			status := 409
			switch kind {
			case "quota":
				envelope = append(envelope, 1)
				value["encryptedObject"] = base64.StdEncoding.EncodeToString(envelope)
				status = 507
			case "global":
				value["expectedGlobalRevision"] = 1
			case "local":
				value["updates"] = []metadataPointerUpdate{{MetadataID: "trash-index-aaaaaaaaaaa", ExpectedRevision: 2, ObjectID: "new-trash-index-aaaaaaaa"}}
			case "missing":
				value["purgeTombstoneIds"] = []string{"trash-root-aaaaaaaaaaaa", "missing-root-aaaaaaaaaa"}
			case "duplicate":
				value["purgeTombstoneIds"] = []string{"trash-root-aaaaaaaaaaaa", "trash-root-aaaaaaaaaaaa"}
				status = 400
			case "object":
				value["updates"] = []metadataPointerUpdate{{MetadataID: "trash-index-aaaaaaaaaaa", ExpectedRevision: 1, ObjectID: "old-trash-index-aaaaaaaa"}}
			case "unknown":
				value["restoreTombstoneId"] = "trash-root-aaaaaaaaaaaa"
				status = 400
			case "envelope":
				value["encryptedObject"] = "AAAA"
				status = 400
			case "journal":
				if _, err := h.database.Exec("INSERT INTO metadata_maintenance VALUES(1,'another-index-aaaaaaaaaa',36,1)"); err != nil {
					t.Fatal(err)
				}
			case "fence":
				session := createTestUpload(t, h)
				digest := sha256.Sum256(envelope)
				if _, err := h.database.Exec("INSERT INTO upload_receive_fences VALUES('new-trash-index-aaaaaaaa',?,36,?,1)", session, digest[:]); err != nil {
					t.Fatal(err)
				}
			case "tombstoned":
				if _, err := h.database.Exec("INSERT INTO tombstone_metadata VALUES('trash-root-aaaaaaaaaaaa','trash-index-aaaaaaaaaaa')"); err != nil {
					t.Fatal(err)
				}
			}
			before := readUsage(t, h)
			body, _ = json.Marshal(value)
			response := maintenanceRequest(t, h, body, "maintenance-key-aaaaaaaaa")
			if response.Code != status {
				t.Fatalf("%d %s want %d", response.Code, response.Body.String(), status)
			}
			after := readUsage(t, h)
			for _, key := range []string{"usedBytes", "reservedBytes", "trashBytes"} {
				if after[key] != before[key] {
					t.Fatalf("changed %s", key)
				}
			}
			var roots, revision int
			if err := h.database.QueryRow("SELECT COUNT(*) FROM tombstones").Scan(&roots); err != nil {
				t.Fatal(err)
			}
			if err := h.database.QueryRow("SELECT vault_mutation_revision FROM server_state").Scan(&revision); err != nil {
				t.Fatal(err)
			}
			if roots != 1 || revision != 0 {
				t.Fatal("partial purge")
			}
			if _, err := os.Stat(filepath.Join(path, "ne", "new-trash-index-aaaaaaaa")); !os.IsNotExist(err) {
				t.Fatalf("uncommitted file remains: %v", err)
			}
		})
	}
}

func TestMaintenanceJournalExcludesPUTAndRecoversPublication(t *testing.T) {
	h, path, envelope := maintenanceFixture(t, 36)
	if _, err := h.database.Exec("INSERT INTO metadata_maintenance VALUES(1,'new-trash-index-aaaaaaaa',36,1)"); err != nil {
		t.Fatal(err)
	}
	// Existing full reservation is owned by this session; receiving the candidate
	// via the regular path must fail before it can contend for the immutable path.
	var session string
	if err := h.database.QueryRow("SELECT id FROM upload_sessions WHERE reserved_bytes>0").Scan(&session); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(envelope)
	if putTestUploadObject(t, h, session, "new-trash-index-aaaaaaaa", envelope, digest[:]) != 409 {
		t.Fatal("journal allowed competing PUT")
	}
	published := false
	if err := publishMaintenanceObject(path, "new-trash-index-aaaaaaaa", envelope, &published); err != nil || !published {
		t.Fatal(err)
	}
	temp, err := os.CreateTemp(filepath.Join(path, "ne"), ".upload-maintenance-")
	if err != nil {
		t.Fatal(err)
	}
	_ = temp.Close()
	if err := RecoverUploadClaimsAtStartup(context.Background(), h.database, path); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{filepath.Join(path, "ne", "new-trash-index-aaaaaaaa"), temp.Name()} {
		if _, err := os.Stat(name); !os.IsNotExist(err) {
			t.Fatalf("orphan %s: %v", name, err)
		}
	}
	// A crash after SQL commit must retain the final object even if a stale journal
	// exists. Recovery checks objects, rather than assuming every journal is orphaned.
	if _, err := h.database.Exec("INSERT INTO metadata_maintenance VALUES(1,'new-trash-index-aaaaaaaa',36,1)"); err != nil {
		t.Fatal(err)
	}
	published = false
	if err := publishMaintenanceObject(path, "new-trash-index-aaaaaaaa", envelope, &published); err != nil {
		t.Fatal(err)
	}
	if _, err := h.database.Exec("INSERT INTO objects(id,size_bytes,sha256,state,created_at) VALUES('new-trash-index-aaaaaaaa',36,?,'live',1)", digest[:]); err != nil {
		t.Fatal(err)
	}
	if err := RecoverUploadClaimsAtStartup(context.Background(), h.database, path); err != nil {
		t.Fatal(err)
	}
	if actual, err := os.ReadFile(filepath.Join(path, "ne", "new-trash-index-aaaaaaaa")); err != nil || !bytes.Equal(actual, envelope) {
		t.Fatal("committed candidate lost")
	}
}

func TestMaintenanceRespectsBackupLockAndCancellation(t *testing.T) {
	h, path, envelope := maintenanceFixture(t, 200)
	lease, err := storage.AcquireBackupLease(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Close()
	var request maintenancePurgeRequest
	_ = json.Unmarshal(maintenanceBody(envelope), &request)
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	hash := sha256.Sum256([]byte("request"))
	if _, err := runMaintenancePurge(ctx, h.database, path, 4096, 0, request, envelope, "maintenance-key-aaaaaaaaa", hash[:]); err == nil {
		t.Fatal("ignored backup exclusion")
	}
	var count int
	if err := h.database.QueryRow("SELECT COUNT(*) FROM metadata_maintenance").Scan(&count); err != nil || count != 0 {
		t.Fatal("cancelled before lease mutated journal")
	}
}

func TestMaintenanceNeverOverwritesExistingPath(t *testing.T) {
	h, path, envelope := maintenanceFixture(t, 200)
	directory := filepath.Join(path, "ne")
	if err := os.MkdirAll(directory, 0700); err != nil {
		t.Fatal(err)
	}
	prior := []byte("preexisting immutable bytes")
	if err := os.WriteFile(filepath.Join(directory, "new-trash-index-aaaaaaaa"), prior, 0600); err != nil {
		t.Fatal(err)
	}
	response := maintenanceRequest(t, h, maintenanceBody(envelope), "maintenance-key-aaaaaaaaa")
	if response.Code != 500 {
		t.Fatalf("expected publication failure: %d", response.Code)
	}
	stored, err := os.ReadFile(filepath.Join(directory, "new-trash-index-aaaaaaaa"))
	if err != nil || !bytes.Equal(stored, prior) {
		t.Fatal("overwrote another object")
	}
	var roots, journal int
	if err := h.database.QueryRow("SELECT COUNT(*) FROM tombstones").Scan(&roots); err != nil {
		t.Fatal(err)
	}
	if err := h.database.QueryRow("SELECT COUNT(*) FROM metadata_maintenance").Scan(&journal); err != nil {
		t.Fatal(err)
	}
	if roots != 1 || journal != 0 {
		t.Fatal("publication error mutated lifecycle")
	}
}

func TestMaintenanceAuthenticationAndPhysicalBudget(t *testing.T) {
	h, path, envelope := maintenanceFixture(t, 200)
	response := httptest.NewRecorder()
	request := httptest.NewRequest("POST", "/api/v1/metadata/maintenance-purge", bytes.NewReader(maintenanceBody(envelope)))
	request.Header.Set(clientProtocolHeader, "1")
	h.ServeHTTP(response, request)
	if response.Code != 403 {
		t.Fatal("missing Origin accepted")
	}
	r := httptest.NewRequest("POST", "/api/v1/metadata/maintenance-purge", bytes.NewReader(maintenanceBody(envelope)))
	r.Header.Set("Origin", "http://example.com")
	r.Header.Set(clientProtocolHeader, "1")
	response = httptest.NewRecorder()
	h.ServeHTTP(response, r)
	if response.Code != 401 {
		t.Fatal("unauthenticated maintenance accepted")
	}
	r = httptest.NewRequest("POST", "/", bytes.NewReader(maintenanceBody(envelope)))
	r.Header.Set("Idempotency-Key", "maintenance-key-aaaaaaaaa")
	response = httptest.NewRecorder()
	maintenancePurge(response, r, h.database, path, 4096, 1<<62)
	if response.Code != 507 || !bytes.Contains(response.Body.Bytes(), []byte("disk_space_low")) {
		t.Fatalf("physical margin bypass: %d %s", response.Code, response.Body.String())
	}
	var count int
	if err := h.database.QueryRow("SELECT COUNT(*) FROM metadata_maintenance").Scan(&count); err != nil || count != 0 {
		t.Fatal("disk failure left candidate")
	}
}

func TestMaintenancePurgeRejectsResidualSecondJournal(t *testing.T) {
	h, _, envelope := maintenanceFixture(t, 200)
	defer h.Close()
	if _, err := h.database.Exec("INSERT INTO metadata_maintenance VALUES(2,'residual-candidate-aaaaaaa',36,?)", time.Now().Unix()); err != nil {
		t.Fatal(err)
	}
	response := maintenanceRequest(t, h, maintenanceBody(envelope), "maintenance-key-aaaaaaaaa")
	if response.Code != 409 || !bytes.Contains(response.Body.Bytes(), []byte("maintenance_in_progress")) {
		t.Fatalf("%d %s", response.Code, response.Body.String())
	}
	var journals, roots int
	if err := h.database.QueryRow("SELECT COUNT(*) FROM metadata_maintenance").Scan(&journals); err != nil || journals != 1 {
		t.Fatal("changed residual ownership")
	}
	if err := h.database.QueryRow("SELECT COUNT(*) FROM tombstones").Scan(&roots); err != nil || roots != 1 {
		t.Fatal("partial purge")
	}
}
