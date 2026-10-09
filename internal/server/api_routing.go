package server

import (
	"net/http"
	"strings"
)

// apiRoutingErrors replaces ServeMux's default plain-text API 404/405
// responses with the normal structured error response. The root GET route is
// the single page app fallback; API paths must never fall through to it.
func apiRoutingErrors(mux *http.ServeMux) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/api/") {
			mux.ServeHTTP(w, r)
			return
		}

		handler, pattern := mux.Handler(r)
		if pattern == "GET /" {
			writeError(w, http.StatusNotFound, "not_found")
			return
		}
		if pattern != "" {
			mux.ServeHTTP(w, r)
			return
		}

		// An empty pattern means ServeMux selected its built-in 404 or 405
		// handler. Invoke only that built-in handler against a status-only
		// writer so its Allow header can distinguish a real method mismatch
		// from the SPA catch-all making an unknown API path look like a 405.
		probe := &routingProbeWriter{header: make(http.Header)}
		handler.ServeHTTP(probe, r)
		if probe.status == http.StatusMethodNotAllowed && apiPathHasRegisteredMethod(mux, r, probe.header.Get("Allow")) {
			w.Header().Set("Allow", probe.header.Get("Allow"))
			writeError(w, http.StatusMethodNotAllowed, "method_not_allowed")
			return
		}
		writeError(w, http.StatusNotFound, "not_found")
	})
}

func apiPathHasRegisteredMethod(mux *http.ServeMux, r *http.Request, allow string) bool {
	for _, method := range strings.Split(allow, ",") {
		method = strings.TrimSpace(method)
		if method == "" {
			continue
		}
		candidate := r.Clone(r.Context())
		candidate.Method = method
		_, pattern := mux.Handler(candidate)
		if pattern != "" && pattern != "GET /" {
			return true
		}
	}
	return false
}

// routingProbeWriter records only the status and headers of ServeMux's
// built-in route errors. It deliberately discards the plain-text body.
type routingProbeWriter struct {
	header http.Header
	status int
}

func (w *routingProbeWriter) Header() http.Header { return w.header }

func (w *routingProbeWriter) WriteHeader(status int) {
	if w.status == 0 {
		w.status = status
	}
}

func (w *routingProbeWriter) Write(p []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	return len(p), nil
}
