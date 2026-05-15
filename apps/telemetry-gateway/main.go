// apps/telemetry-gateway/
//
// Reverse proxy that terminates mTLS from Model B OTel Collectors,
// extracts the installation ID from the client certificate CN,
// and injects X-Scope-OrgID before forwarding to Mimir / Loki / Tempo.
//
// URL scheme:
//   /v1/{installation_id}/metrics  → Mimir  (Prometheus remote_write)
//   /v1/{installation_id}/logs     → Loki   (Loki push API)
//   /v1/{installation_id}/otlp     → OTel Collector (OTLP HTTP)
//
// The client cert CN must be "installation/<installation_id>".
// A mismatch between the URL path and the cert CN is rejected with 403.

package main

import (
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
)

var (
	mimirURL = mustEnv("MIMIR_URL")   // e.g. http://mimir.monok8s-platform:9009
	lokiURL  = mustEnv("LOKI_URL")    // e.g. http://loki.monok8s-platform:3100
	otlpURL  = mustEnv("OTLP_URL")    // e.g. http://otel-collector.monok8s-platform:4318

	tlsCertFile = mustEnv("TLS_CERT_FILE")  // server cert (from Vault PKI or cert-manager)
	tlsKeyFile  = mustEnv("TLS_KEY_FILE")
	caCertFile  = mustEnv("CA_CERT_FILE")   // Vault PKI CA — validates client certs
)

func main() {
	caPEM, err := os.ReadFile(caCertFile)
	if err != nil {
		slog.Error("failed to read CA cert", "error", err)
		os.Exit(1)
	}
	caPool := x509.NewCertPool()
	caPool.AppendCertsFromPEM(caPEM)

	tlsConfig := &tls.Config{
		ClientAuth: tls.RequireAndVerifyClientCert,
		ClientCAs:  caPool,
		MinVersion: tls.VersionTLS13,
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/v1/", handleTelemetry)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	srv := &http.Server{
		Addr:      ":8443",
		Handler:   mux,
		TLSConfig: tlsConfig,
	}

	slog.Info("telemetry gateway starting", "addr", srv.Addr)
	if err := srv.ListenAndServeTLS(tlsCertFile, tlsKeyFile); err != nil {
		slog.Error("server error", "error", err)
		os.Exit(1)
	}
}

func handleTelemetry(w http.ResponseWriter, r *http.Request) {
	// Extract installation ID from URL: /v1/{installation_id}/{signal}
	parts := strings.SplitN(strings.TrimPrefix(r.URL.Path, "/v1/"), "/", 2)
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		http.Error(w, "invalid path", http.StatusBadRequest)
		return
	}
	installationID := parts[0]
	signal := parts[1] // "metrics" | "logs" | "otlp"

	// Validate client cert CN matches the installation ID.
	if r.TLS == nil || len(r.TLS.PeerCertificates) == 0 {
		http.Error(w, "client certificate required", http.StatusUnauthorized)
		return
	}
	cn := r.TLS.PeerCertificates[0].Subject.CommonName
	expectedCN := "installation/" + installationID
	if cn != expectedCN {
		slog.Warn("cert CN mismatch",
			"url_installation_id", installationID,
			"cert_cn", cn,
		)
		http.Error(w, "certificate CN does not match installation ID", http.StatusForbidden)
		return
	}

	// Route to the correct backend.
	var targetBase string
	var stripPrefix string
	switch signal {
	case "metrics":
		targetBase = mimirURL
		stripPrefix = fmt.Sprintf("/v1/%s/metrics", installationID)
	case "logs":
		targetBase = lokiURL
		stripPrefix = fmt.Sprintf("/v1/%s/logs", installationID)
	case "otlp":
		targetBase = otlpURL
		stripPrefix = fmt.Sprintf("/v1/%s/otlp", installationID)
	default:
		http.Error(w, "unknown signal type", http.StatusNotFound)
		return
	}

	target, err := url.Parse(targetBase)
	if err != nil {
		slog.Error("bad target URL", "error", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	proxy := httputil.NewSingleHostReverseProxy(target)
	originalDirector := proxy.Director
	proxy.Director = func(req *http.Request) {
		originalDirector(req)
		req.URL.Path = strings.TrimPrefix(req.URL.Path, stripPrefix)
		if req.URL.Path == "" {
			req.URL.Path = "/"
		}
		// Inject tenant header — Mimir and Loki use this for data isolation.
		req.Header.Set("X-Scope-OrgID", installationID)
		req.Header.Set("X-Installation-Id", installationID)
		// Don't leak client cert details to the backend.
		req.Header.Del("X-Forwarded-Client-Cert")
	}
	proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		slog.Error("proxy error", "installation_id", installationID, "signal", signal, "error", err)
		http.Error(w, "upstream error", http.StatusBadGateway)
	}

	proxy.ServeHTTP(w, r)
}

func mustEnv(key string) string {
	v := os.Getenv(key)
	if v == "" {
		panic("required env var not set: " + key)
	}
	return v
}
