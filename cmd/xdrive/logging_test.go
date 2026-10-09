package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestLoggerForLevelKeepsSuccessDiagnosticsOptIn(t *testing.T) {
	var output bytes.Buffer
	loggerForLevel(&output, "info").Debug("API request completed", "request_id", "request-1")
	if output.Len() != 0 {
		t.Fatalf("INFO logger emitted DEBUG API record: %s", output.String())
	}
	loggerForLevel(&output, "debug").Debug("API request completed", "request_id", "request-1")
	if !strings.Contains(output.String(), "request_id=request-1") || !strings.Contains(output.String(), "API request completed") {
		t.Fatalf("DEBUG logger omitted request correlation: %s", output.String())
	}
}
