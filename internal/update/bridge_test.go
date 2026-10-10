package update

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestLegacyBridgeContinuesOnlyRecentApprovedNewerTarget(t *testing.T) {
	for _, test := range []struct {
		name, current, target, state string
		age                          int64
		want                         bool
	}{
		{"approved", LegacyBridgeVersion, "v1.4.0", "succeeded", 0, true},
		{"already-current", LegacyBridgeVersion, LegacyBridgeVersion, "succeeded", 0, false},
		{"newer-service", "v1.4.0", "v1.5.0", "succeeded", 0, false},
		{"failed", LegacyBridgeVersion, "v1.4.0", "failed", 0, false},
		{"stale", LegacyBridgeVersion, "v1.4.0", "succeeded", 16 * 60, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			root := t.TempDir()
			status := filepath.Join(root, "status.json")
			id := "abcdefghijklmnopqrstu_"
			if err := WriteStatus(status, Status{ID: id, Version: test.target, State: test.state, UpdatedAt: time.Now().Unix() - test.age}); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			request, err := AwaitBridgeContinuation(ctx, test.current, status, filepath.Join(root, "hold"))
			if err != nil || (request != nil) != test.want {
				t.Fatalf("request=%+v err=%v", request, err)
			}
			if request != nil && (request.ID != id || request.Version != test.target) {
				t.Fatal("bridge changed the approved request")
			}
		})
	}
}

func TestLegacyBridgeWaitsForWorkerAndRollbackHold(t *testing.T) {
	root := t.TempDir()
	status := filepath.Join(root, "status.json")
	hold := filepath.Join(root, "hold")
	if err := os.WriteFile(hold, nil, 0640); err != nil {
		t.Fatal(err)
	}
	if err := WriteStatus(status, Status{ID: "abcdefghijklmnopqrstu_", Version: "v1.4.0", State: "succeeded", UpdatedAt: time.Now().Unix()}); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if request, err := AwaitBridgeContinuation(ctx, LegacyBridgeVersion, status, hold); request != nil || err == nil {
		t.Fatal("bridge continued while rollback hold existed")
	}
	if err := os.Remove(hold); err != nil {
		t.Fatal(err)
	}
	if request, err := AwaitBridgeContinuation(context.Background(), LegacyBridgeVersion, status, hold); request == nil || err != nil {
		t.Fatalf("request=%+v err=%v", request, err)
	}
}
