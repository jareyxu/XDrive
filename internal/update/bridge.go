package update

import (
	"context"
	"errors"
	"os"
	"time"
)

// LegacyBridgeVersion is immutable. Original artifact names in future releases
// carry this version; complete distributions use the -package artifact names.
const LegacyBridgeVersion = "v1.3.7"

// AwaitBridgeContinuation follows only a recent update the user already
// approved. After the legacy worker finishes installing this bridge, the
// service queues the same target and request ID for the upgraded worker. A
// changed GitHub latest release is rejected by that worker, never substituted.
func AwaitBridgeContinuation(ctx context.Context, current, statusPath, holdPath string) (*Request, error) {
	if current != LegacyBridgeVersion {
		return nil, nil
	}
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	for {
		status, err := ReadStatus(statusPath)
		if errors.Is(err, os.ErrNotExist) || err != nil {
			return nil, nil
		}
		comparison, err := CompareVersions(current, status.Version)
		age := time.Now().Unix() - status.UpdatedAt
		if err != nil || comparison >= 0 || age < -60 || age > 15*60 || status.State == "failed" {
			return nil, nil
		}
		if status.State == "succeeded" {
			if _, err := os.Lstat(holdPath); errors.Is(err, os.ErrNotExist) {
				return &Request{ID: status.ID, Version: status.Version}, nil
			} else if err != nil {
				return nil, err
			}
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-ticker.C:
		}
	}
}
