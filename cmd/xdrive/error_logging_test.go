package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestServeErrorIDReachesDefaultStderrWithoutRequestSecrets(t *testing.T) {
	root := t.TempDir()
	binary := filepath.Join(root, "xdrive")
	if output, err := exec.Command("go", "build", "-o", binary, ".").CombinedOutput(); err != nil {
		t.Fatalf("build CLI: %s %v", output, err)
	}
	probe, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := probe.Addr().String()
	if err := probe.Close(); err != nil {
		t.Fatal(err)
	}
	environment := []string{}
	for _, entry := range os.Environ() {
		if !strings.HasPrefix(entry, "XDRIVE_") {
			environment = append(environment, entry)
		}
	}
	environment = append(environment, "XDRIVE_DATABASE_PATH="+filepath.Join(root, "drive.db"), "XDRIVE_STORAGE_PATH="+filepath.Join(root, "objects"), "XDRIVE_SECRET_PATH="+filepath.Join(root, "secret"), "XDRIVE_LISTEN_ADDR="+address, "XDRIVE_USERNAME=admin", "XDRIVE_DISK_SAFETY_BYTES=0")
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	child := exec.CommandContext(ctx, binary, "serve")
	child.Env = environment
	var logs bytes.Buffer
	child.Stderr = &logs
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	waited := false
	defer func() {
		if !waited {
			cancel()
			_ = child.Wait()
		}
	}()
	client := &http.Client{Timeout: time.Second}
	ready := false
	for ctx.Err() == nil {
		response, err := client.Get("http://" + address + "/readyz")
		if err == nil {
			io.Copy(io.Discard, response.Body)
			response.Body.Close()
			if response.StatusCode == 200 {
				ready = true
				break
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	if !ready {
		t.Fatal("owned fixture server did not become ready")
	}
	request, err := http.NewRequest(http.MethodGet, "http://"+address+"/api/v1/vault/config?filename=private-cli-name&token=private-cli-setup", strings.NewReader("private-cli-body"))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Cookie", "xdrive_session=private-cli-cookie")
	request.Header.Set("Authorization", "Bearer private-cli-auth")
	request.Header.Set("X-Request-ID", "private-cli-spoof")
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	var body struct {
		RequestID string `json:"requestId"`
		Error     string `json:"error"`
	}
	err = json.NewDecoder(response.Body).Decode(&body)
	response.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	id := response.Header.Get("X-Request-ID")
	if response.StatusCode != 401 || id == "" || body.RequestID != id || body.Error != "invalid_session" {
		t.Fatal("actual CLI response lost correlation")
	}
	cancel()
	_ = child.Wait() // Stop only the owned test process; this is not a graceful-shutdown test.
	waited = true
	// Wait has drained stderr: inspecting the buffer now does not race the copy goroutine.
	found := false
	for _, line := range strings.Split(logs.String(), "\n") {
		if strings.Contains(line, "request_id="+id) && strings.Contains(line, "status=401") && strings.Contains(line, "response_bytes=") && strings.Contains(line, "latency_ms=") && strings.Contains(line, "code=invalid_session") {
			found = true
			break
		}
	}
	if !found {
		t.Fatal("actual default stderr logger omitted response correlation or approved metrics")
	}
	for _, marker := range []string{"private-cli-name", "private-cli-setup", "private-cli-body", "private-cli-cookie", "private-cli-auth", "private-cli-spoof", "/api/v1/vault/config"} {
		if strings.Contains(logs.String(), marker) {
			t.Fatalf("request secret reached CLI stderr: %q", marker)
		}
	}

	// Process-level command failures may wrap the source path. The CLI should
	// keep the stable error category while redacting that diagnostic from stderr.
	privatePath := filepath.Join(root, "private-backup-path-marker")
	command := exec.Command(binary, "inspect-backup", privatePath)
	output, err := command.CombinedOutput()
	if err == nil {
		t.Fatal("inspection of a missing backup unexpectedly succeeded")
	}
	if strings.Contains(string(output), privatePath) {
		t.Fatalf("CLI process error leaked its source path: %s", output)
	}
	if !strings.Contains(string(output), "code=not_found") || strings.Contains(string(output), "error=") {
		t.Fatalf("CLI process error omitted its safe code or logged a raw error: %s", output)
	}
}
