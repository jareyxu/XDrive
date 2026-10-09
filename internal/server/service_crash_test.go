package server

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"xdrive/internal/config"
	"xdrive/internal/storage"
)

func crashOwnerConfig(root string) config.Config {
	return config.Config{ListenAddr: "127.0.0.1:8787", DatabasePath: filepath.Join(root, "drive.db"), StoragePath: filepath.Join(root, "objects"), SecretPath: filepath.Join(root, "secret"), Username: "admin", QuotaBytes: 4096}
}

// The helper stops at durable protocol component boundaries, without production
// fault hooks. This verifies real process death/startup, not a live HTTP crash or
// storage-device power loss.
func TestKilledOwnerRecoversClaimsAndPublishedCandidateWithoutDeletingOldData(t *testing.T) {
	root := t.TempDir()
	cfg := crashOwnerConfig(root)
	child := exec.Command(os.Args[0], "-test.run=^TestCrashOwnerHelperProcess$")
	child.Env = append(os.Environ(), "XDRIVE_CRASH_OWNER_HELPER="+root)
	stdout, err := child.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdin, err := child.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	defer stdin.Close()
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = child.Process.Kill(); _ = child.Wait() }()
	ready, err := bufio.NewReader(stdout).ReadString('\n')
	if err != nil || ready != "READY\n" {
		t.Fatal("helper did not finish durable publication", ready, err)
	}
	if other, err := New(cfg); !errors.Is(err, storage.ErrServiceInUse) {
		if other != nil {
			other.Close()
		}
		t.Fatal("new process reached live owner's recovery", err)
	}
	candidate := filepath.Join(cfg.StoragePath, "ne", "new-candidate-aaaaaaaaaa")
	if data, err := os.ReadFile(candidate); err != nil || len(data) != 36 {
		t.Fatal("candidate never reached final path", err)
	}
	if err := child.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = child.Wait()
	restarted, err := New(cfg)
	if err != nil {
		t.Fatal("restart after SIGKILL", err)
	}
	defer restarted.Close()
	for _, query := range []string{"SELECT COUNT(*) FROM metadata_maintenance", "SELECT COUNT(*) FROM upload_object_claims", "SELECT COUNT(*) FROM upload_receive_fences"} {
		var count int
		if err := restarted.database.QueryRow(query).Scan(&count); err != nil || count != 0 {
			t.Fatalf("orphan ownership remains: %s %d %v", query, count, err)
		}
	}
	if _, err := os.Stat(candidate); !os.IsNotExist(err) {
		t.Fatal("uncommitted candidate remains", err)
	}
	temps, err := filepath.Glob(filepath.Join(cfg.StoragePath, "or", ".upload-*"))
	if err != nil || len(temps) != 0 {
		t.Fatal("interrupted receive temporary remains", temps, err)
	}
	for _, id := range []string{"old-index-aaaaaaaaaaaaaa", "old-member-aaaaaaaaaaaaa"} {
		data, err := os.ReadFile(filepath.Join(cfg.StoragePath, id[:2], id))
		if err != nil || !bytes.Equal(data, bytes.Repeat([]byte{7}, 36)) {
			t.Fatal("old data changed", id, err)
		}
	}
	var roots, revision, pointers, reserved int
	for query, target := range map[string]*int{"SELECT COUNT(*) FROM tombstones": &roots, "SELECT vault_mutation_revision FROM server_state": &revision, "SELECT COUNT(*) FROM metadata_pointers": &pointers, "SELECT reserved_bytes FROM upload_sessions WHERE id='active-upload-aaaaaaaaaa'": &reserved} {
		if err := restarted.database.QueryRow(query).Scan(target); err != nil {
			t.Fatal(err)
		}
	}
	if roots != 1 || revision != 0 || pointers != 1 || reserved != 36 {
		t.Fatalf("old logical state or resumable reservation changed: %d/%d/%d/%d", roots, revision, pointers, reserved)
	}
}

func TestKilledReceivingPUTRecoversTemporaryAndAllowsResume(t *testing.T) {
	root := t.TempDir()
	cfg := crashOwnerConfig(root)
	address, sessionID, _, stopReceiver, _ := startCrashUploadReceiver(t, root, false)
	defer stopReceiver()
	objectID := "abcdefghijklmnopqrstuvwx"
	data := bytes.Repeat([]byte{0x63}, 36)
	digest := sha256.Sum256(data)
	connection, err := net.DialTimeout("tcp", address, 5*time.Second)
	if err != nil {
		t.Fatal("connect to isolated upload server", err)
	}
	defer connection.Close()
	_, err = fmt.Fprintf(connection, "PUT /api/v1/uploads/%s/objects/%s HTTP/1.1\r\nHost: %s\r\nOrigin: http://%s\r\nX-CSRF-Token: test-csrf-token\r\nX-XDrive-Client-Protocol: 1\r\nX-XDrive-Object-Size: %d\r\nX-XDrive-Ciphertext-SHA256: %s\r\nCookie: %s=0123456789abcdefghijklmnopqrstuv\r\nContent-Length: %d\r\nConnection: close\r\n\r\n", sessionID, objectID, address, address, len(data), hex.EncodeToString(digest[:]), sessionCookieName, len(data))
	if err != nil {
		t.Fatal("write upload headers", err)
	}
	if _, err := connection.Write(data[:12]); err != nil {
		t.Fatal("send first body window", err)
	}
	if err := waitForUploadTemporary(filepath.Join(cfg.StoragePath, objectID[:2]), 12); err != nil {
		_ = connection.SetReadDeadline(time.Now().Add(100 * time.Millisecond))
		statusLine, _ := bufio.NewReader(connection).ReadString('\n')
		t.Fatalf("server never persisted the first upload body window: %v; HTTP status=%q", err, statusLine)
	}
	stopReceiver()
	_ = connection.Close()

	restarted, err := New(cfg)
	if err != nil {
		t.Fatal("restart after in-flight PUT SIGKILL", err)
	}
	defer restarted.Close()
	if _, err := os.Stat(filepath.Join(cfg.StoragePath, objectID[:2], objectID)); !os.IsNotExist(err) {
		t.Fatalf("partial PUT produced a final object: %v", err)
	}
	if temporary, err := filepath.Glob(filepath.Join(cfg.StoragePath, objectID[:2], ".upload-*")); err != nil || len(temporary) != 0 {
		t.Fatalf("startup left receive temporary files: %q %v", temporary, err)
	}
	var claims, fences, objects int
	var state string
	var reserved, consumed int64
	if err := restarted.database.QueryRow(`SELECT
		(SELECT COUNT(*) FROM upload_object_claims WHERE session_id = ?),
		(SELECT COUNT(*) FROM upload_receive_fences WHERE session_id = ?),
		(SELECT COUNT(*) FROM objects WHERE id = ?),
		state, reserved_bytes, consumed_bytes
		FROM upload_sessions WHERE id = ?`, sessionID, sessionID, objectID, sessionID).Scan(&claims, &fences, &objects, &state, &reserved, &consumed); err != nil {
		t.Fatal(err)
	}
	if claims != 0 || fences != 0 || objects != 0 || state != "active" || reserved != 36 || consumed != 0 {
		t.Fatalf("startup recovery state: claims=%d fences=%d objects=%d state=%s reserved=%d consumed=%d", claims, fences, objects, state, reserved, consumed)
	}
	if status := putTestUploadObject(t, restarted, sessionID, objectID, data, digest[:]); status != http.StatusCreated {
		t.Fatalf("resumed PUT after startup recovery status=%d", status)
	}
	if stored, err := os.ReadFile(filepath.Join(cfg.StoragePath, objectID[:2], objectID)); err != nil || !bytes.Equal(stored, data) {
		t.Fatalf("resumed object bytes differ: equal=%v error=%v", bytes.Equal(stored, data), err)
	}
}

func TestKilledPublishedPUTRecoversOrphanFinalAndAllowsResume(t *testing.T) {
	root := t.TempDir()
	cfg := crashOwnerConfig(root)
	address, sessionID, otherSessionID, stopReceiver, receiverLog := startCrashUploadReceiver(t, root, true)
	objectID := "abcdefghijklmnopqrstuvwx"
	data := bytes.Repeat([]byte{0x73}, 36)
	digest := sha256.Sum256(data)
	connection, err := net.DialTimeout("tcp", address, 5*time.Second)
	if err != nil {
		t.Fatal("connect to isolated upload server", err)
	}
	defer connection.Close()
	_ = connection.SetDeadline(time.Now().Add(10 * time.Second))
	_, err = fmt.Fprintf(connection, "PUT /api/v1/uploads/%s/objects/%s HTTP/1.1\r\nHost: %s\r\nOrigin: http://%s\r\nX-CSRF-Token: test-csrf-token\r\nX-XDrive-Client-Protocol: 1\r\nX-XDrive-Object-Size: %d\r\nX-XDrive-Ciphertext-SHA256: %s\r\nCookie: %s=0123456789abcdefghijklmnopqrstuv\r\nContent-Length: %d\r\nConnection: close\r\n\r\n", sessionID, objectID, address, address, len(data), hex.EncodeToString(digest[:]), sessionCookieName, len(data))
	if err != nil {
		t.Fatal("write upload headers", err)
	}
	if _, err := connection.Write(data[:12]); err != nil {
		t.Fatal("send first body window", err)
	}
	shard := filepath.Join(cfg.StoragePath, objectID[:2])
	if err := waitForUploadTemporary(shard, 12); err != nil {
		t.Fatal("server did not persist partial body before competing-session request", err)
	}
	if status := networkPUTStatus(t, address, otherSessionID, objectID, data, digest[:]); status != http.StatusConflict {
		t.Fatalf("second session in the real TCP receive window returned status=%d, want 409", status)
	}

	if _, err := connection.Write(data[12:]); err != nil {
		t.Fatal("send remaining upload body", err)
	}
	finalPath := filepath.Join(shard, objectID)
	if err := waitForCrashMarker(filepath.Join(root, "published")); err != nil {
		t.Fatal("server did not reach the synchronized post-publish test gate", err)
	}
	if err := waitForPublishedUploadObject(finalPath, data); err != nil {
		entries, _ := os.ReadDir(shard)
		var names []string
		for _, entry := range entries {
			names = append(names, entry.Name())
		}
		response, responseErr := http.ReadResponse(bufio.NewReader(connection), &http.Request{Method: http.MethodPut})
		if responseErr != nil {
			stopReceiver()
			t.Fatalf("server did not publish the immutable final object before the post-publish gate: %v; shard=%q; reading HTTP response: %v; server log=%s", err, names, responseErr, receiverLog())
		}
		body, bodyErr := io.ReadAll(response.Body)
		closeErr := response.Body.Close()
		stopReceiver()
		t.Fatalf("server did not publish the immutable final object before the post-publish gate: %v; shard=%q; HTTP status=%d body=%q read=%v close=%v; server log=%s", err, names, response.StatusCode, body, bodyErr, closeErr, receiverLog())
	}
	stopReceiver()
	_ = connection.Close()

	restarted, err := New(cfg)
	if err != nil {
		t.Fatal("restart after published-but-uncommitted PUT SIGKILL", err)
	}
	defer restarted.Close()
	if _, err := os.Stat(finalPath); !os.IsNotExist(err) {
		t.Fatalf("startup recovery left orphan final object: %v", err)
	}
	if temporary, err := filepath.Glob(filepath.Join(shard, ".upload-*")); err != nil || len(temporary) != 0 {
		t.Fatalf("startup left receive temporary files: %q %v", temporary, err)
	}
	var claims, fences, objects int
	var state string
	var reserved, consumed int64
	if err := restarted.database.QueryRow(`SELECT
		(SELECT COUNT(*) FROM upload_object_claims WHERE object_id = ?),
		(SELECT COUNT(*) FROM upload_receive_fences WHERE object_id = ?),
		(SELECT COUNT(*) FROM objects WHERE id = ?),
		state, reserved_bytes, consumed_bytes
		FROM upload_sessions WHERE id = ?`, objectID, objectID, objectID, sessionID).Scan(&claims, &fences, &objects, &state, &reserved, &consumed); err != nil {
		t.Fatal(err)
	}
	if claims != 0 || fences != 0 || objects != 0 || state != "active" || reserved != 36 || consumed != 0 {
		t.Fatalf("startup recovery state: claims=%d fences=%d objects=%d state=%s reserved=%d consumed=%d", claims, fences, objects, state, reserved, consumed)
	}
	var otherState string
	var otherReserved, otherConsumed int64
	if err := restarted.database.QueryRow("SELECT state, reserved_bytes, consumed_bytes FROM upload_sessions WHERE id = ?", otherSessionID).Scan(&otherState, &otherReserved, &otherConsumed); err != nil {
		t.Fatal("read competing session after recovery", err)
	}
	if otherState != "active" || otherReserved != 36 || otherConsumed != 0 {
		t.Fatalf("competing session quota changed after crash recovery: state=%s reserved=%d consumed=%d", otherState, otherReserved, otherConsumed)
	}
	if status := putTestUploadObject(t, restarted, sessionID, objectID, data, digest[:]); status != http.StatusCreated {
		t.Fatalf("resumed PUT after orphan final recovery status=%d", status)
	}
	if stored, err := os.ReadFile(finalPath); err != nil || !bytes.Equal(stored, data) {
		t.Fatalf("resumed object bytes differ: equal=%v error=%v", bytes.Equal(stored, data), err)
	}
}

func startCrashUploadReceiver(t *testing.T, root string, gateAfterPublish bool) (address, sessionID, retrySession string, stop func(), logs func() string) {
	t.Helper()
	child := exec.Command(os.Args[0], "-test.run=^TestCrashUploadReceiverHelperProcess$")
	child.Env = append(os.Environ(), "XDRIVE_CRASH_UPLOAD_HELPER="+root)
	if gateAfterPublish {
		child.Env = append(child.Env, "XDRIVE_CRASH_UPLOAD_PUBLISHED_GATE=1")
	}
	var childStderr bytes.Buffer
	child.Stderr = &childStderr
	stdout, err := child.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	childRunning := true
	stop = func() {
		if childRunning {
			_ = child.Process.Kill()
			_ = child.Wait()
			childRunning = false
		}
	}
	t.Cleanup(stop)
	logs = func() string { return childStderr.String() }
	stdoutReader := bufio.NewReader(stdout)
	type readiness struct {
		line string
		err  error
	}
	ready := make(chan readiness, 1)
	go func() {
		line, err := stdoutReader.ReadString('\n')
		ready <- readiness{line: line, err: err}
	}()
	var line string
	select {
	case result := <-ready:
		line, err = result.line, result.err
	case <-time.After(10 * time.Second):
		stop()
		t.Fatal("upload receiver did not become ready within 10 seconds; stderr=", childStderr.String())
	}
	if err != nil {
		stop()
		t.Fatal("upload receiver did not become ready", line, err)
	}
	parts := strings.Fields(strings.TrimSpace(line))
	if len(parts) != 4 || parts[0] != "READY" {
		stop()
		details, _ := io.ReadAll(stdoutReader)
		t.Fatalf("invalid upload receiver readiness output: %q; child output=%s; stderr=%s", line, details, childStderr.String())
	}
	return parts[1], parts[2], parts[3], stop, logs
}

func TestDisconnectedReceivingPUTReleasesFenceAndAllowsRetry(t *testing.T) {
	root := t.TempDir()
	cfg := crashOwnerConfig(root)
	address, sessionID, retrySession, stopReceiver, _ := startCrashUploadReceiver(t, root, false)
	defer stopReceiver()
	objectID := "abcdefghijklmnopqrstuvwx"
	data := bytes.Repeat([]byte{0x53}, 36)
	digest := sha256.Sum256(data)
	connection, err := net.DialTimeout("tcp", address, 5*time.Second)
	if err != nil {
		t.Fatal("connect to isolated upload server", err)
	}
	defer connection.Close()
	_ = connection.SetDeadline(time.Now().Add(5 * time.Second))
	_, err = fmt.Fprintf(connection, "PUT /api/v1/uploads/%s/objects/%s HTTP/1.1\r\nHost: %s\r\nOrigin: http://%s\r\nX-CSRF-Token: test-csrf-token\r\nX-XDrive-Client-Protocol: 1\r\nX-XDrive-Object-Size: %d\r\nX-XDrive-Ciphertext-SHA256: %s\r\nCookie: %s=0123456789abcdefghijklmnopqrstuv\r\nContent-Length: %d\r\nConnection: close\r\n\r\n", sessionID, objectID, address, address, len(data), hex.EncodeToString(digest[:]), sessionCookieName, len(data))
	if err != nil {
		t.Fatal("write interrupted upload headers", err)
	}
	if _, err := connection.Write(data[:12]); err != nil {
		t.Fatal("send first body window", err)
	}
	shard := filepath.Join(cfg.StoragePath, objectID[:2])
	if err := waitForUploadTemporary(shard, 12); err != nil {
		t.Fatal("server did not persist the partial request before disconnect", err)
	}
	if err := connection.(*net.TCPConn).CloseWrite(); err != nil {
		t.Fatal("half-close interrupted request", err)
	}
	response, err := http.ReadResponse(bufio.NewReader(connection), &http.Request{Method: http.MethodPut})
	if err != nil {
		t.Fatal("read incomplete PUT response", err)
	}
	body, readErr := io.ReadAll(response.Body)
	closeErr := response.Body.Close()
	if response.StatusCode != http.StatusBadRequest || readErr != nil || closeErr != nil || !strings.Contains(string(body), "object_size_mismatch") {
		t.Fatalf("incomplete PUT response: status=%d body=%s read=%v close=%v", response.StatusCode, body, readErr, closeErr)
	}
	if temporary, err := filepath.Glob(filepath.Join(shard, ".upload-*")); err != nil || len(temporary) != 0 {
		t.Fatalf("disconnected receive left temporary files: %q %v", temporary, err)
	}
	if status := networkPUTStatus(t, address, retrySession, objectID, data, digest[:]); status != http.StatusCreated {
		t.Fatalf("retry from a second session after client disconnect returned %d", status)
	}
	if stored, err := os.ReadFile(filepath.Join(shard, objectID)); err != nil || !bytes.Equal(stored, data) {
		t.Fatalf("retry after client disconnect has wrong bytes: equal=%v error=%v", bytes.Equal(stored, data), err)
	}
}

func networkPUTStatus(t *testing.T, address, sessionID, objectID string, data, digest []byte) int {
	t.Helper()
	connection, err := net.DialTimeout("tcp", address, 5*time.Second)
	if err != nil {
		t.Fatal("connect for retry PUT", err)
	}
	defer connection.Close()
	_ = connection.SetDeadline(time.Now().Add(5 * time.Second))
	_, err = fmt.Fprintf(connection, "PUT /api/v1/uploads/%s/objects/%s HTTP/1.1\r\nHost: %s\r\nOrigin: http://%s\r\nX-CSRF-Token: test-csrf-token\r\nX-XDrive-Client-Protocol: 1\r\nX-XDrive-Object-Size: %d\r\nX-XDrive-Ciphertext-SHA256: %s\r\nCookie: %s=0123456789abcdefghijklmnopqrstuv\r\nContent-Length: %d\r\nConnection: close\r\n\r\n", sessionID, objectID, address, address, len(data), hex.EncodeToString(digest), sessionCookieName, len(data))
	if err != nil {
		t.Fatal("write retry PUT headers", err)
	}
	if _, err := connection.Write(data); err != nil {
		t.Fatal("write retry PUT body", err)
	}
	response, err := http.ReadResponse(bufio.NewReader(connection), &http.Request{Method: http.MethodPut})
	if err != nil {
		t.Fatal("read retry PUT response", err)
	}
	defer response.Body.Close()
	if _, err := io.Copy(io.Discard, response.Body); err != nil {
		t.Fatal("read retry PUT response body", err)
	}
	return response.StatusCode
}

func TestCrashUploadReceiverHelperProcess(t *testing.T) {
	root := os.Getenv("XDRIVE_CRASH_UPLOAD_HELPER")
	if root == "" {
		return
	}
	cfg := crashOwnerConfig(root)
	owner, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if os.Getenv("XDRIVE_CRASH_UPLOAD_PUBLISHED_GATE") == "1" {
		owner.uploadPublishedHook = func() {
			if err := os.WriteFile(filepath.Join(root, "published"), []byte("ready\n"), 0o600); err != nil {
				panic(err)
			}
			select {}
		}
	}
	addAuthenticatedTestSession(t, owner)
	sessionID := createTestUpload(t, owner)
	if status := reserveTestUpload(t, owner, sessionID, 36); status != http.StatusOK {
		t.Fatalf("reserve upload: %d", status)
	}
	retrySession := createTestUpload(t, owner)
	if status := reserveTestUpload(t, owner, retrySession, 36); status != http.StatusOK {
		t.Fatalf("reserve retry upload: %d", status)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go func() { _ = http.Serve(listener, owner) }()
	_, _ = fmt.Fprintf(os.Stdout, "READY %s %s %s\n", listener.Addr().String(), sessionID, retrySession)
	select {}
}

func waitForUploadTemporary(shard string, expectedSize int64) error {
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		entries, err := os.ReadDir(shard)
		if err == nil {
			for _, entry := range entries {
				if !strings.HasPrefix(entry.Name(), ".upload-") {
					continue
				}
				info, err := entry.Info()
				if err == nil && info.Size() == expectedSize {
					return nil
				}
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	return fmt.Errorf("temporary file with %d bytes not found", expectedSize)
}

func waitForPublishedUploadObject(path string, expected []byte) error {
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		data, err := os.ReadFile(path)
		if err == nil && bytes.Equal(data, expected) {
			return nil
		}
		time.Sleep(time.Millisecond)
	}
	return fmt.Errorf("published object with %d expected bytes not found", len(expected))
}

func waitForCrashMarker(path string) error {
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if info, err := os.Stat(path); err == nil && info.Mode().IsRegular() {
			return nil
		}
		time.Sleep(time.Millisecond)
	}
	return errors.New("post-publish crash marker not found")
}

func TestCrashOwnerHelperProcess(t *testing.T) {
	root := os.Getenv("XDRIVE_CRASH_OWNER_HELPER")
	if root == "" {
		return
	}
	cfg := crashOwnerConfig(root)
	owner, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer owner.Close()
	data := bytes.Repeat([]byte{7}, 36)
	digest := sha256.Sum256(data)
	now := time.Now().Unix()
	for _, id := range []string{"old-index-aaaaaaaaaaaaaa", "old-member-aaaaaaaaaaaaa"} {
		if _, err := persistOpaqueObject(cfg.StoragePath, id, data); err != nil {
			t.Fatal(err)
		}
		if _, err := owner.database.Exec("INSERT INTO objects(id,size_bytes,sha256,state,created_at) VALUES(?,36,?,'live',?)", id, digest[:], now); err != nil {
			t.Fatal(err)
		}
	}
	for _, query := range []string{
		"INSERT INTO metadata_pointers VALUES('trash-index-aaaaaaaaaaa','old-index-aaaaaaaaaaaaaa',1,1)",
		"INSERT INTO metadata_versions VALUES('trash-index-aaaaaaaaaaa',1,'old-index-aaaaaaaaaaaaaa',1)",
		"INSERT INTO tombstone_objects VALUES('trash-root-aaaaaaaaaaaa','old-member-aaaaaaaaaaaaa')",
	} {
		if query == "INSERT INTO tombstone_objects VALUES('trash-root-aaaaaaaaaaaa','old-member-aaaaaaaaaaaaa')" {
			if _, err := owner.database.Exec("INSERT INTO tombstones VALUES('trash-root-aaaaaaaaaaaa',?,'active')", now); err != nil {
				t.Fatal(err)
			}
		}
		if _, err := owner.database.Exec(query); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := owner.database.Exec("INSERT INTO upload_sessions VALUES('active-upload-aaaaaaaaaa','active',36,0,?,?)", now, now+3600); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.database.Exec("INSERT INTO upload_object_claims VALUES('active-upload-aaaaaaaaaa','orphan-receive-aaaaaaaaa',36,?,?)", digest[:], now); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.database.Exec("INSERT INTO upload_receive_fences VALUES('orphan-receive-aaaaaaaaa','active-upload-aaaaaaaaaa',36,?,?)", digest[:], now); err != nil {
		t.Fatal(err)
	}
	directory := filepath.Join(cfg.StoragePath, "or")
	if err := os.MkdirAll(directory, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, ".upload-interrupted"), data[:12], 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.database.Exec("INSERT INTO metadata_maintenance VALUES(1,'new-candidate-aaaaaaaaaa',36,?)", now); err != nil {
		t.Fatal(err)
	}
	candidate := make([]byte, 36)
	copy(candidate, []byte{'X', 'D', 'R', 'V', 1, 1, 0, 0})
	published := false
	if err := publishMaintenanceObject(cfg.StoragePath, "new-candidate-aaaaaaaaaa", candidate, &published); err != nil || !published {
		t.Fatal("publish", err)
	}
	_, _ = fmt.Fprintln(os.Stdout, "READY")
	_, _ = os.Stdin.Read(make([]byte, 1))
}
