package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// The headroom is counted before ordinary uploads can fill the account. Live
// maintenance objects consume it; logical deletion/GC returns their credit.
const MaintenanceRemainingSQL = `(COALESCE((SELECT capacity_bytes FROM maintenance_quota WHERE id=1),0)-COALESCE((SELECT SUM(o.size_bytes) FROM maintenance_quota_objects m JOIN objects o ON o.id=m.object_id WHERE o.state IN ('live','pending')),0))`

func MaintenanceRemaining(ctx context.Context, q interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}) (int64, error) {
	var remaining int64
	err := q.QueryRowContext(ctx, "SELECT "+MaintenanceRemainingSQL).Scan(&remaining)
	if err == nil && remaining < 0 {
		err = errors.New("maintenance quota accounting invalid")
	}
	return remaining, err
}

func (database *DB) InitializeMaintenanceQuota(ctx context.Context, quota, capacity int64) error {
	if capacity < 0 || capacity > 8<<20 || quota <= 0 {
		return errors.New("invalid maintenance quota configuration")
	}
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var existing int64
	err = tx.QueryRowContext(ctx, "SELECT capacity_bytes FROM maintenance_quota WHERE id=1").Scan(&existing)
	if err == nil {
		if existing != capacity {
			return fmt.Errorf("maintenance reserve is fixed at %d bytes; configuration requested %d", existing, capacity)
		}
	} else if errors.Is(err, sql.ErrNoRows) {
		var used, reserved int64
		err = tx.QueryRowContext(ctx, `SELECT COALESCE((SELECT SUM(size_bytes) FROM objects WHERE state IN ('live','pending')),0),COALESCE((SELECT SUM(reserved_bytes-consumed_bytes) FROM upload_sessions WHERE state='active' AND expires_at>?),0)`, time.Now().Unix()).Scan(&used, &reserved)
		if err != nil {
			return err
		}
		if used < 0 || reserved < 0 || used > quota || reserved > quota-used || capacity > quota-used-reserved {
			return errors.New("insufficient quota to establish maintenance reserve; clean space with the previous version before upgrading")
		}
		if _, err = tx.ExecContext(ctx, "INSERT INTO maintenance_quota VALUES(1,?)", capacity); err != nil {
			return err
		}
	} else {
		return err
	}
	remaining, err := MaintenanceRemaining(ctx, tx)
	if err != nil {
		return err
	}
	var used, reserved int64
	if err = tx.QueryRowContext(ctx, `SELECT COALESCE((SELECT SUM(size_bytes) FROM objects WHERE state IN ('live','pending')),0),COALESCE((SELECT SUM(reserved_bytes-consumed_bytes) FROM upload_sessions WHERE state='active' AND expires_at>?),0)`, time.Now().Unix()).Scan(&used, &reserved); err != nil {
		return err
	}
	if used > quota || reserved > quota-used || remaining > quota-used-reserved {
		return errors.New("configured quota cannot cover existing objects, uploads and maintenance reserve")
	}
	return tx.Commit()
}
