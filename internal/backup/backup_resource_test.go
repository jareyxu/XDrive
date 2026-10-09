package backup

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"xdrive/internal/config"
	"xdrive/internal/db"
)

const backupResourceDefaultBytes int64 = 10 * 1024 * 1024 * 1024

type backupResourceReport struct {
	SchemaVersion         int               `json:"schemaVersion"`
	Status                string            `json:"status"`
	FixtureKind           string            `json:"fixtureKind"`
	SourceObjectBytes     int64             `json:"sourceObjectBytes"`
	BackupObjectBytes     int64             `json:"backupObjectBytes"`
	ObjectSHA256          string            `json:"objectSha256"`
	ObjectCount           int               `json:"objectCount"`
	FixtureSeconds        float64           `json:"fixtureSeconds"`
	BackupCreateSeconds   float64           `json:"backupCreateSeconds"`
	BackupVerifySeconds   float64           `json:"backupVerifySeconds"`
	RestoreSeconds        float64           `json:"restoreSeconds"`
	RestoredObjectBytes   int64             `json:"restoredObjectBytes"`
	RestoredObjectSHA256  string            `json:"restoredObjectSha256"`
	ElapsedSeconds        float64           `json:"elapsedSeconds"`
	MaxProcessRSSKiB      int64             `json:"maxProcessRssKiB"`
	MaxCgroupCurrentBytes int64             `json:"maxCgroupCurrentBytes"`
	CgroupPeakBytes       int64             `json:"cgroupPeakBytes"`
	CgroupMemoryLimit     int64             `json:"cgroupMemoryLimitBytes"`
	CgroupMemoryEvents    map[string]uint64 `json:"cgroupMemoryEvents"`
	CgroupMemoryStatAtMax map[string]uint64 `json:"cgroupMemoryStatAtMaxCurrent"`
	MemoryHeadroomStatus  string            `json:"memoryHeadroomStatus"`
	CPUUsageMicros        int64             `json:"cpuUsageMicros"`
	Error                 string            `json:"error,omitempty"`
}

// TestBackupNearQuotaResource is an opt-in Linux workload. It requires two
// explicit bind mounts so fixture data and backup output cannot land in the
// container's writable layer or the application's real data directory.
func TestBackupNearQuotaResource(t *testing.T) {
	if os.Getenv("XDRIVE_BACKUP_RESOURCE_E2E") != "1" {
		t.Skip("set XDRIVE_BACKUP_RESOURCE_E2E=1 to run the isolated large-backup workload")
	}
	if runtime.GOOS != "linux" {
		t.Fatal("large-backup resource workload is supported only in the isolated Linux container")
	}

	bytes, err := strconv.ParseInt(os.Getenv("XDRIVE_BACKUP_RESOURCE_BYTES"), 10, 64)
	if err != nil || bytes < 36 || bytes > backupResourceDefaultBytes {
		t.Fatalf("XDRIVE_BACKUP_RESOURCE_BYTES must be between 36 and %d", backupResourceDefaultBytes)
	}
	sourceRoot, err := requiredMountpoint("XDRIVE_BACKUP_RESOURCE_SOURCE")
	if err != nil {
		t.Fatal(err)
	}
	backupRoot, err := requiredMountpoint("XDRIVE_BACKUP_RESOURCE_DESTINATION")
	if err != nil {
		t.Fatal(err)
	}
	if within(sourceRoot, backupRoot) || within(backupRoot, sourceRoot) {
		t.Fatal("source and backup mountpoints must not contain one another")
	}
	started := time.Now()
	report := backupResourceReport{
		SchemaVersion:     1,
		Status:            "failed",
		FixtureKind:       "deterministic opaque object bytes; backup verifies byte integrity, not client-side AEAD validity",
		SourceObjectBytes: bytes,
	}
	work, err := os.MkdirTemp(sourceRoot, "xdrive-backup-resource-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(work)
	settings := config.Config{
		DatabasePath: filepath.Join(work, "data", "xdrive.db"),
		StoragePath:  filepath.Join(work, "data", "objects"),
		SecretPath:   filepath.Join(work, "data", "server.secret"),
	}
	destination := filepath.Join(backupRoot, "xdrive-backup-resource")
	if err := os.Mkdir(destination, 0o700); err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(destination)
	objectID := "backupresourceobject0001"

	cpuAtStart := readCgroupCPUUsage()
	sampler := startBackupResourceSampler()
	defer func() {
		metrics := sampler.stop()
		report.MaxProcessRSSKiB = metrics.maxRSSKiB
		report.MaxCgroupCurrentBytes = metrics.maxCgroupCurrent
		report.CgroupPeakBytes = metrics.cgroupPeak
		report.CgroupMemoryLimit = readCgroupInteger("memory.max")
		report.CgroupMemoryEvents = readCgroupKeyValues("memory.events")
		report.CgroupMemoryStatAtMax = metrics.memoryStatAtMax
		if report.CgroupMemoryLimit > 0 && report.CgroupPeakBytes >= report.CgroupMemoryLimit {
			report.MemoryHeadroomStatus = "limit-reached-or-exceeded; memory headroom not demonstrated"
		} else if report.CgroupMemoryEvents["max"] > 0 {
			report.MemoryHeadroomStatus = "limit-charge-retries-observed; memory headroom not demonstrated"
		} else if report.CgroupMemoryLimit > 0 {
			report.MemoryHeadroomStatus = "below-container-limit"
		} else {
			report.MemoryHeadroomStatus = "unavailable"
		}
		report.CPUUsageMicros = readCgroupCPUUsage() - cpuAtStart
		report.ElapsedSeconds = time.Since(started).Seconds()
		if report.Error != "" {
			report.Status = "failed"
		}
		reportPath := os.Getenv("XDRIVE_BACKUP_RESOURCE_REPORT")
		if reportPath != "" {
			if err := writeBackupResourceReport(reportPath, report); err != nil {
				t.Errorf("write resource report: %v", err)
			}
		}
	}()

	fixtureStarted := time.Now()
	digest, err := writeBackupResourceFixture(settings, objectID, bytes)
	report.FixtureSeconds = time.Since(fixtureStarted).Seconds()
	if err != nil {
		report.Error = "create source object: " + err.Error()
		t.Fatal(err)
	}
	report.ObjectSHA256 = hex.EncodeToString(digest)

	createStarted := time.Now()
	if err := Create(context.Background(), settings, destination, true); err != nil {
		report.Error = "create backup: " + err.Error()
		t.Fatal(err)
	}
	report.BackupCreateSeconds = time.Since(createStarted).Seconds()

	verifyStarted := time.Now()
	if err := Verify(context.Background(), destination); err != nil {
		report.Error = "verify backup: " + err.Error()
		t.Fatal(err)
	}
	report.BackupVerifySeconds = time.Since(verifyStarted).Seconds()
	info, err := Inspect(context.Background(), destination)
	if err != nil {
		report.Error = "inspect verified backup: " + err.Error()
		t.Fatal(err)
	}
	report.BackupObjectBytes = info.TotalObjectBytes
	report.ObjectCount = info.ObjectCount
	if info.ObjectCount != 1 || info.TotalObjectBytes != bytes {
		report.Error = fmt.Sprintf("unexpected manifest: objectCount=%d objectBytes=%d", info.ObjectCount, info.TotalObjectBytes)
		t.Fatal(report.Error)
	}
	if err := os.RemoveAll(work); err != nil {
		report.Error = "remove source fixture before restore: " + err.Error()
		t.Fatal(report.Error)
	}
	restoredRoot := filepath.Join(sourceRoot, "restored-data")
	defer os.RemoveAll(restoredRoot)
	restored := config.Config{
		DatabasePath: filepath.Join(restoredRoot, "xdrive.db"),
		StoragePath:  filepath.Join(restoredRoot, "objects"),
		SecretPath:   filepath.Join(restoredRoot, "server.secret"),
	}
	restoreStarted := time.Now()
	if err := Restore(context.Background(), restored, destination); err != nil {
		report.Error = "restore verified backup: " + err.Error()
		t.Fatal(report.Error)
	}
	report.RestoreSeconds = time.Since(restoreStarted).Seconds()
	restoredObject := objectPath(restored.StoragePath, objectID)
	restoredInfo, err := os.Stat(restoredObject)
	if err != nil || restoredInfo.Size() != bytes {
		report.Error = fmt.Sprintf("restored object size mismatch: info=%v error=%v", restoredInfo, err)
		t.Fatal(report.Error)
	}
	report.RestoredObjectBytes = restoredInfo.Size()
	report.RestoredObjectSHA256, err = hashObject(restored.StoragePath, objectID)
	if err != nil || report.RestoredObjectSHA256 != report.ObjectSHA256 {
		report.Error = fmt.Sprintf("restored object SHA-256 mismatch: %v", err)
		t.Fatal(report.Error)
	}
	report.Status = "passed"
	t.Logf("%.2f GiB opaque-object backup, verification, and restore passed in %.1fs", float64(bytes)/(1024*1024*1024), time.Since(started).Seconds())
}

func requiredMountpoint(name string) (string, error) {
	value := os.Getenv(name)
	if value == "" || !filepath.IsAbs(value) {
		return "", fmt.Errorf("%s must name an explicitly mounted absolute directory", name)
	}
	absolute, err := filepath.Abs(value)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(absolute)
	if err != nil || !info.IsDir() {
		return "", fmt.Errorf("%s must be an existing directory: %v", name, err)
	}
	mountInfo, err := os.ReadFile("/proc/self/mountinfo")
	if err != nil {
		return "", fmt.Errorf("read Linux mount table: %w", err)
	}
	mountpoint := false
	for _, line := range strings.Split(string(mountInfo), "\n") {
		fields := strings.Fields(line)
		if len(fields) > 5 && unescapeMountInfo(fields[4]) == absolute {
			mountpoint = true
			break
		}
	}
	if !mountpoint {
		return "", fmt.Errorf("%s=%s is not a mountpoint", name, absolute)
	}
	return absolute, nil
}

func unescapeMountInfo(value string) string {
	return strings.NewReplacer("\\040", " ", "\\011", "\t", "\\012", "\n", "\\134", "\\").Replace(value)
}

func writeBackupResourceFixture(settings config.Config, objectID string, objectBytes int64) ([]byte, error) {
	path := objectPath(settings.StoragePath, objectID)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return nil, err
	}
	prepareBackupStream(file)
	hasher := sha256.New()
	random := rand.New(rand.NewSource(13117))
	block := make([]byte, 1024*1024)
	remaining := objectBytes
	var writtenTotal int64
	var windowStart int64
	for remaining > 0 {
		length := int64(len(block))
		if remaining < length {
			length = remaining
		}
		chunk := block[:int(length)]
		if _, err := random.Read(chunk); err != nil {
			_ = file.Close()
			return nil, err
		}
		if _, err := hasher.Write(chunk); err != nil {
			_ = file.Close()
			return nil, err
		}
		written, err := file.Write(chunk)
		if err != nil {
			_ = file.Close()
			return nil, err
		}
		if written != len(chunk) {
			_ = file.Close()
			return nil, errors.New("short write creating resource fixture")
		}
		remaining -= int64(written)
		writtenTotal += int64(written)
		if writtenTotal-windowStart >= backupStreamWindowBytes {
			windowSize := writtenTotal - windowStart
			if err := flushBackupStreamWindow(file, windowStart, windowSize); err != nil {
				_ = file.Close()
				return nil, err
			}
			discardBackupStreamWindow(file, windowStart, windowSize)
			windowStart = writtenTotal
		}
	}
	if writtenTotal > windowStart {
		if err := flushBackupStreamWindow(file, windowStart, writtenTotal-windowStart); err != nil {
			_ = file.Close()
			return nil, err
		}
		discardBackupStreamWindow(file, windowStart, writtenTotal-windowStart)
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		return nil, err
	}
	if err := file.Close(); err != nil {
		return nil, err
	}
	database, err := db.Open(context.Background(), settings.DatabasePath)
	if err != nil {
		return nil, err
	}
	_, execErr := database.Exec(`INSERT INTO objects (id, size_bytes, sha256, state, created_at) VALUES (?, ?, ?, 'live', ?)`, objectID, objectBytes, hasher.Sum(nil), time.Now().Unix())
	closeErr := database.Close()
	if execErr != nil {
		return nil, execErr
	}
	if closeErr != nil {
		return nil, closeErr
	}
	return hasher.Sum(nil), nil
}

func writeBackupResourceReport(path string, report backupResourceReport) error {
	bytes, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		return err
	}
	bytes = append(bytes, '\n')
	if err := os.WriteFile(path, bytes, 0o600); err != nil {
		return err
	}
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	return file.Sync()
}

type backupResourceMetrics struct {
	maxRSSKiB        int64
	maxCgroupCurrent int64
	cgroupPeak       int64
	memoryStatAtMax  map[string]uint64
}

type backupResourceSampler struct {
	stopCh chan struct{}
	done   chan struct{}
	mu     sync.Mutex
	values backupResourceMetrics
}

func startBackupResourceSampler() *backupResourceSampler {
	sampler := &backupResourceSampler{stopCh: make(chan struct{}), done: make(chan struct{})}
	go func() {
		defer close(sampler.done)
		sample := func() {
			rss := readProcessHighWaterRSS()
			current := readCgroupMetric("memory.current")
			peak := readCgroupMetric("memory.peak")
			sampler.mu.Lock()
			if rss > sampler.values.maxRSSKiB {
				sampler.values.maxRSSKiB = rss
			}
			if current > sampler.values.maxCgroupCurrent {
				sampler.values.maxCgroupCurrent = current
				sampler.values.memoryStatAtMax = readCgroupKeyValues("memory.stat")
			}
			if peak > sampler.values.cgroupPeak {
				sampler.values.cgroupPeak = peak
			}
			sampler.mu.Unlock()
		}
		sample()
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-sampler.stopCh:
				sample()
				return
			case <-ticker.C:
				sample()
			}
		}
	}()
	return sampler
}

func (sampler *backupResourceSampler) stop() backupResourceMetrics {
	close(sampler.stopCh)
	<-sampler.done
	sampler.mu.Lock()
	defer sampler.mu.Unlock()
	return sampler.values
}

func readProcessHighWaterRSS() int64 {
	data, err := os.ReadFile("/proc/self/status")
	if err != nil {
		return 0
	}
	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(line, "VmHWM:") {
			fields := strings.Fields(line)
			if len(fields) > 1 {
				value, _ := strconv.ParseInt(fields[1], 10, 64)
				return value
			}
		}
	}
	return 0
}

func readCgroupMetric(name string) int64 {
	return readCgroupInteger(name)
}

func readCgroupInteger(name string) int64 {
	data, err := os.ReadFile(filepath.Join("/sys/fs/cgroup", name))
	if err != nil {
		return 0
	}
	value, _ := strconv.ParseInt(strings.TrimSpace(string(data)), 10, 64)
	return value
}

func readCgroupKeyValues(name string) map[string]uint64 {
	data, err := os.ReadFile(filepath.Join("/sys/fs/cgroup", name))
	if err != nil {
		return nil
	}
	values := make(map[string]uint64)
	for _, line := range strings.Split(string(data), "\n") {
		fields := strings.Fields(line)
		if len(fields) != 2 {
			continue
		}
		value, err := strconv.ParseUint(fields[1], 10, 64)
		if err == nil {
			values[fields[0]] = value
		}
	}
	return values
}

func readCgroupCPUUsage() int64 {
	data, err := os.ReadFile("/sys/fs/cgroup/cpu.stat")
	if err != nil {
		return 0
	}
	for _, line := range strings.Split(string(data), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 2 && fields[0] == "usage_usec" {
			value, _ := strconv.ParseInt(fields[1], 10, 64)
			return value
		}
	}
	return 0
}
