package server

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
	"xdrive/internal/update"
)

func TestBridgeContinuationQueuesSameApprovedTargetAndStatusTracksSecondStage(t *testing.T) {
	root := t.TempDir()
	h := &Handler{buildVersion: update.LegacyBridgeVersion, updateRequestPath: filepath.Join(root, "request.json"), updateStatusPath: filepath.Join(root, "status.json"), updateManagerCheck: func(context.Context) bool { return true }}
	id := "abcdefghijklmnopqrstu_"
	if err := update.WriteStatus(h.updateStatusPath, update.Status{ID: id, Version: "v1.4.0", State: "succeeded", UpdatedAt: time.Now().Unix()}); err != nil {
		t.Fatal(err)
	}
	h.ContinueLegacyUpdate(context.Background(), filepath.Join(root, "missing-hold"))
	request, err := update.ReadRequest(h.updateRequestPath)
	if err != nil || request.ID != id || request.Version != "v1.4.0" {
		t.Fatalf("request=%+v err=%v", request, err)
	}
	recorder := httptest.NewRecorder()
	h.systemUpdateStatus(recorder, httptest.NewRequest("GET", "/api/v1/system/update/status?id="+id, nil))
	var status update.Status
	if err := json.Unmarshal(recorder.Body.Bytes(), &status); err != nil {
		t.Fatal(err)
	}
	if status.State != "queued" || status.ID != id || status.Version != "v1.4.0" {
		t.Fatalf("old success hid the next stage: %+v", status)
	}
}

func TestNormalServiceStartupDoesNotScheduleAutomaticUpdate(t *testing.T) {
	root := t.TempDir()
	h := &Handler{buildVersion: "v1.4.0", updateRequestPath: filepath.Join(root, "request.json"), updateStatusPath: filepath.Join(root, "status.json")}
	if err := update.WriteStatus(h.updateStatusPath, update.Status{ID: "abcdefghijklmnopqrstu_", Version: "v1.5.0", State: "succeeded", UpdatedAt: time.Now().Unix()}); err != nil {
		t.Fatal(err)
	}
	h.ContinueLegacyUpdate(context.Background(), filepath.Join(root, "missing-hold"))
	if _, err := os.Stat(h.updateRequestPath); !os.IsNotExist(err) {
		t.Fatal("normal startup queued an unrelated update")
	}
}
