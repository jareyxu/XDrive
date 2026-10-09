package server

import (
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"
)

// logAPIRequests records only response-level diagnostics that are safe to
// correlate with the request ID shown to the user. It deliberately omits the
// URL, method, headers, request body, response body and underlying errors.
func logAPIRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/api/") {
			next.ServeHTTP(w, r)
			return
		}

		started := time.Now()
		tracked := &requestLogWriter{ResponseWriter: w}
		requestID := w.Header().Get("X-Request-ID")
		completed := false
		defer func() {
			// Let net/http recover panics as usual; do not claim an implicit 200
			// for a handler that did not complete.
			if !completed {
				return
			}
			status := tracked.status
			if status == 0 {
				status = http.StatusOK
			}
			attributes := []any{
				"request_id", requestID,
				"status", status,
				"response_bytes", tracked.bytes,
				"latency_ms", time.Since(started).Milliseconds(),
			}
			if tracked.errorCode != "" && tracked.errorStatus == status {
				attributes = append(attributes, "code", tracked.errorCode)
			}
			switch {
			case status >= http.StatusInternalServerError:
				slog.Error("API request failed", attributes...)
			case status >= http.StatusBadRequest:
				slog.Warn("API request rejected", attributes...)
			default:
				// Successful responses can be high volume (chunk uploads and media
				// ranges). Keep them available for opt-in diagnostics without
				// filling the default service journal.
				slog.Debug("API request completed", attributes...)
			}
		}()
		next.ServeHTTP(tracked, r)
		completed = true
	})
}

// requestLogWriter counts response bytes without buffering or altering them.
// Unwrap keeps http.ResponseController operations (deadlines, flush and
// hijack) working through the logging layer.
type requestLogWriter struct {
	http.ResponseWriter
	status      int
	bytes       int64
	errorStatus int
	errorCode   string
}

func (w *requestLogWriter) Unwrap() http.ResponseWriter {
	return w.ResponseWriter
}

func (w *requestLogWriter) WriteHeader(status int) {
	if w.status != 0 {
		return
	}
	w.ResponseWriter.WriteHeader(status)
	// Informational responses do not finish the request, except protocol
	// switching (101), which is a final response.
	if status < 100 || status >= 200 || status == http.StatusSwitchingProtocols {
		w.status = status
	}
}

func (w *requestLogWriter) Write(p []byte) (int, error) {
	if w.status == 0 {
		w.WriteHeader(http.StatusOK)
	}
	n, err := w.ResponseWriter.Write(p)
	w.bytes += int64(n)
	return n, err
}

// ReadFrom preserves the optimized file-serving path when the underlying
// writer supports it, while still counting bytes. The fallback avoids
// recursing into this method through io.Copy's WriterTo/ReaderFrom shortcuts.
func (w *requestLogWriter) ReadFrom(r io.Reader) (int64, error) {
	if w.status == 0 {
		w.WriteHeader(http.StatusOK)
	}
	if readerFrom, ok := w.ResponseWriter.(io.ReaderFrom); ok {
		n, err := readerFrom.ReadFrom(r)
		w.bytes += n
		return n, err
	}
	n, err := io.Copy(struct{ io.Writer }{w}, r)
	return n, err
}

// FlushError lets ResponseController report an implicit 200 response while
// forwarding the operation to the original writer.
func (w *requestLogWriter) FlushError() error {
	err := http.NewResponseController(w.ResponseWriter).Flush()
	if err == nil && w.status == 0 {
		w.status = http.StatusOK
	}
	return err
}

func (w *requestLogWriter) recordError(status int, code string) {
	w.errorStatus = status
	w.errorCode = code
}
