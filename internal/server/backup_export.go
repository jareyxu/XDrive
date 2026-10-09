package server

import (
	"context"
	"errors"
	"io"

	"xdrive/internal/config"
)

var ErrBackupInProgress = errors.New("another backup or deletion is in progress")

// BackupArchive is the minimal streaming contract needed by the HTTP layer.
// Its implementation owns any point-in-time locks and temporary snapshot.
type BackupArchive interface {
	DownloadFilename() string
	WriteTo(context.Context, io.Writer) error
	Close() error
}

type BackupArchivePreparer func(context.Context, config.Config) (BackupArchive, error)
