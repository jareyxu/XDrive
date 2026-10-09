package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestMaintenanceReserveRecyclesAcrossTrashPurgeAndHistoryPruning(t *testing.T) {
	h, objectRoot, firstTrash := fullQuotaTrashFixture(t, 512)
	defer h.Close()

	const reserveCapacity = int64(512)
	parentID := firstTrash.Updates[0].MetadataID
	trashID := firstTrash.Updates[1].MetadataID
	parentRevision := int64(1)
	trashRevision := int64(1)
	globalRevision := int64(0)
	indexEnvelope := make([]byte, 36)
	copy(indexEnvelope, []byte{'X', 'D', 'R', 'V', 1, 1, 0, 0})

	checkAccounting := func(stage string, wantMaintenance int64) {
		t.Helper()
		usage := readUsage(t, h)
		if got := int64(usage["maintenanceReservedBytes"].(float64)); got != wantMaintenance {
			t.Fatalf("%s maintenance headroom = %d, want %d (usage=%v)", stage, got, wantMaintenance, usage)
		}
		used := int64(usage["usedBytes"].(float64))
		reserved := int64(usage["reservedBytes"].(float64))
		if used < 0 || reserved < 0 || used+reserved > 4096 || usage["pendingBytes"] != float64(0) || usage["uploadReservedBytes"] != float64(0) {
			t.Fatalf("%s violated quota invariant: %v", stage, usage)
		}
		remaining, err := maintenanceRemaining(context.Background(), h.database)
		if err != nil || remaining != wantMaintenance {
			t.Fatalf("%s maintenance ledger = %d, err=%v, want %d", stage, remaining, err, wantMaintenance)
		}
	}

	commitTrash := func(cycle int, request maintenanceTrashRequest) {
		t.Helper()
		response := requestMaintenanceTrash(t, h, request, fmt.Sprintf("recycle-trash-%016d", cycle))
		if response.Code != http.StatusOK {
			t.Fatalf("cycle %d logical trash: %d %s", cycle, response.Code, response.Body.String())
		}
		globalRevision++
		parentRevision++
		trashRevision++
	}

	purgeTrash := func(cycle int, tombstoneID string) {
		t.Helper()
		newTrashIndex := fmt.Sprintf("purge-index-%016d", cycle)
		request := maintenancePurgeRequest{
			ExpectedGlobalRevision: globalRevision,
			PurgeTombstoneIDs:      []string{tombstoneID},
			Updates:                []metadataPointerUpdate{{MetadataID: trashID, ExpectedRevision: trashRevision, ObjectID: newTrashIndex}},
			EncryptedObject:        base64.StdEncoding.EncodeToString(indexEnvelope),
		}
		body, err := json.Marshal(request)
		if err != nil {
			t.Fatal(err)
		}
		response := maintenanceRequest(t, h, body, fmt.Sprintf("recycle-purge-%016d", cycle))
		if response.Code != http.StatusOK {
			t.Fatalf("cycle %d purge: %d %s", cycle, response.Code, response.Body.String())
		}
		globalRevision++
		trashRevision++
	}

	commitTrash(1, firstTrash)
	checkAccounting("first trash", 440)
	purgeTrash(1, firstTrash.CreateTombstoneID)
	if err := CleanupOnceWithPolicy(context.Background(), h.database, objectRoot, time.Now(), 30*24*time.Hour, h.MetadataKeepVersions()); err != nil {
		t.Fatal("cleanup after first purge:", err)
	}
	checkAccounting("first purge", 440)

	for cycle := 2; cycle <= 3; cycle++ {
		sourceID := fmt.Sprintf("recycle-source-%016d", cycle)
		sourceBytes := bytes.Repeat([]byte{byte(cycle)}, 36)
		digest := sha256.Sum256(sourceBytes)
		shard := filepath.Join(objectRoot, sourceID[:2])
		if err := os.MkdirAll(shard, 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(shard, sourceID), sourceBytes, 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := h.database.Exec("INSERT INTO objects(id,size_bytes,sha256,state,created_at) VALUES(?,?,?,'live',?)", sourceID, len(sourceBytes), digest[:], time.Now().Unix()); err != nil {
			t.Fatal(err)
		}

		buildID := fmt.Sprintf("recycle-build-%016d", cycle)
		tombstoneID := fmt.Sprintf("recycle-root-%016d", cycle)
		if _, err := h.database.Exec("INSERT INTO tombstone_builds(id,state,created_at,expires_at,expected_global_revision) VALUES(?,'active',?,?,?)", buildID, time.Now().Unix(), time.Now().Add(time.Hour).Unix(), globalRevision); err != nil {
			t.Fatal(err)
		}
		if _, err := h.database.Exec("INSERT INTO tombstone_build_members VALUES(?,'object',?)", buildID, sourceID); err != nil {
			t.Fatal(err)
		}
		request := maintenanceTrashRequest{
			ExpectedGlobalRevision:   globalRevision,
			FinalizeTombstoneBuildID: buildID,
			CreateTombstoneID:        tombstoneID,
			Updates: []metadataPointerUpdate{
				{MetadataID: parentID, ExpectedRevision: parentRevision, ObjectID: fmt.Sprintf("parent-index-%016d", cycle)},
				{MetadataID: trashID, ExpectedRevision: trashRevision, ObjectID: fmt.Sprintf("trash-index-%016d", cycle)},
			},
			EncryptedObjects: []string{
				base64.StdEncoding.EncodeToString(indexEnvelope),
				base64.StdEncoding.EncodeToString(indexEnvelope),
			},
		}
		commitTrash(cycle, request)
		checkAccounting(fmt.Sprintf("cycle %d trash", cycle), reserveCapacity-int64(cycle)*72)
		purgeTrash(cycle, tombstoneID)
		if err := CleanupOnceWithPolicy(context.Background(), h.database, objectRoot, time.Now(), 30*24*time.Hour, h.MetadataKeepVersions()); err != nil {
			t.Fatalf("cleanup after cycle %d purge: %v", cycle, err)
		}
		wantMaintenance := reserveCapacity - int64(cycle)*72
		if cycle == 3 {
			// The retention policy prunes the first maintenance index at this checkpoint.
			wantMaintenance += 36
		}
		checkAccounting(fmt.Sprintf("cycle %d purge", cycle), wantMaintenance)
	}

	// Three trash/purge cycles have committed six 36-byte maintenance indexes.
	// The fifth-version retention policy now prunes the first committed trash
	// index and returns its charge to the pool without touching the current one.
	checkAccounting("history-prune credit refund", 332)
	var roots, journals, versions int
	for query, target := range map[string]*int{
		"SELECT COUNT(*) FROM tombstones":           &roots,
		"SELECT COUNT(*) FROM metadata_maintenance": &journals,
		"SELECT COUNT(*) FROM metadata_versions":    &versions,
	} {
		if err := h.database.QueryRow(query).Scan(target); err != nil {
			t.Fatal(err)
		}
	}
	if roots != 0 || journals != 0 || versions != 9 {
		t.Fatalf("recycling left lifecycle/history residue: tombstones=%d journals=%d versions=%d", roots, journals, versions)
	}
	prunedIndexID := firstTrash.Updates[1].ObjectID
	var retainedPrunedIndex int
	if err := h.database.QueryRow("SELECT COUNT(*) FROM metadata_versions WHERE metadata_id=? AND object_id=?", trashID, prunedIndexID).Scan(&retainedPrunedIndex); err != nil {
		t.Fatal(err)
	}
	if retainedPrunedIndex != 0 {
		t.Fatalf("old trash index %s is still retained after history pruning", prunedIndexID)
	}
	if _, err := os.Stat(filepath.Join(objectRoot, prunedIndexID[:2], prunedIndexID)); !os.IsNotExist(err) {
		t.Fatalf("pruned trash index %s was not physically collected: %v", prunedIndexID, err)
	}
	for cycle := 1; cycle <= 3; cycle++ {
		id := fmt.Sprintf("recycle-source-%016d", cycle)
		if _, err := os.Stat(filepath.Join(objectRoot, id[:2], id)); !os.IsNotExist(err) {
			t.Fatalf("purged source %s was not physically collected: %v", id, err)
		}
	}
}
