package server

import (
	"context"
	"xdrive/internal/db"
)

const maintenanceRemainingSQL = db.MaintenanceRemainingSQL

func maintenanceRemaining(ctx context.Context, q rowQueryer) (int64, error) {
	return db.MaintenanceRemaining(ctx, q)
}
func initializeMaintenanceQuota(ctx context.Context, database *db.DB, quota, capacity int64) error {
	return database.InitializeMaintenanceQuota(ctx, quota, capacity)
}
