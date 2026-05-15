package observability

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
)

// fakeOTLP captures every request that hits its handler — one per
// OTLP signal endpoint (`/otlp/v1/logs|metrics|traces`).
type fakeOTLP struct {
	mu       sync.Mutex
	requests []capturedRequest
}

type capturedRequest struct {
	path        string
	method      string
	contentType string
	body        map[string]any
}

func (f *fakeOTLP) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	buf, _ := io.ReadAll(r.Body)
	var body map[string]any
	_ = json.Unmarshal(buf, &body)
	f.requests = append(f.requests, capturedRequest{
		path:        r.URL.Path,
		method:      r.Method,
		contentType: r.Header.Get("Content-Type"),
		body:        body,
	})
	w.WriteHeader(http.StatusOK)
}

func newFakeOTLP(t *testing.T) (*BaremetalAdapter, *fakeOTLP, func()) {
	t.Helper()
	fk := &fakeOTLP{}
	server := httptest.NewServer(fk)
	adapter := NewBaremetalAdapter(Config{
		Client:      server.Client(),
		LogsURL:     server.URL + "/otlp/v1/logs",
		MetricsURL:  server.URL + "/otlp/v1/metrics",
		TracesURL:   server.URL + "/otlp/v1/traces",
		ServiceName: "monok8s-test",
	})
	return adapter, fk, server.Close
}

func TestBaremetalAdapter_PushLogs(t *testing.T) {
	adapter, fk, cleanup := newFakeOTLP(t)
	defer cleanup()
	err := adapter.PushLogs(context.Background(), []LogRecord{
		{Timestamp: 1700000000000000000, Severity: "INFO", Body: "hello", Labels: map[string]string{"tenant_id": "acme"}},
	})
	if err != nil {
		t.Fatalf("PushLogs: %v", err)
	}
	if len(fk.requests) != 1 {
		t.Fatalf("requests: got %d want 1", len(fk.requests))
	}
	req := fk.requests[0]
	if req.path != "/otlp/v1/logs" || req.method != "POST" {
		t.Errorf("logs request: got %s %s", req.method, req.path)
	}
	if req.contentType != "application/json" {
		t.Errorf("content-type: got %q want application/json", req.contentType)
	}
	// Drill into the OTLP envelope and assert the log record made it through.
	resourceLogs := req.body["resourceLogs"].([]any)
	scopeLogs := resourceLogs[0].(map[string]any)["scopeLogs"].([]any)
	logRecords := scopeLogs[0].(map[string]any)["logRecords"].([]any)
	logRec := logRecords[0].(map[string]any)
	if logRec["timeUnixNano"] != "1700000000000000000" {
		t.Errorf("timeUnixNano: got %v", logRec["timeUnixNano"])
	}
	if logRec["severityText"] != "INFO" {
		t.Errorf("severityText: got %v", logRec["severityText"])
	}
	body := logRec["body"].(map[string]any)
	if body["stringValue"] != "hello" {
		t.Errorf("body.stringValue: got %v", body["stringValue"])
	}
}

func TestBaremetalAdapter_PushMetrics(t *testing.T) {
	adapter, fk, cleanup := newFakeOTLP(t)
	defer cleanup()
	err := adapter.PushMetrics(context.Background(), []MetricPoint{
		{Name: "tenant.users.active", Value: 42.0, Timestamp: 1700000000000000000, Labels: map[string]string{"tenant_id": "acme"}},
	})
	if err != nil {
		t.Fatalf("PushMetrics: %v", err)
	}
	if fk.requests[0].path != "/otlp/v1/metrics" {
		t.Errorf("metrics request path: got %s", fk.requests[0].path)
	}
	metrics := fk.requests[0].body["resourceMetrics"].([]any)[0].(map[string]any)["scopeMetrics"].([]any)[0].(map[string]any)["metrics"].([]any)
	m := metrics[0].(map[string]any)
	if m["name"] != "tenant.users.active" {
		t.Errorf("metric name: got %v", m["name"])
	}
	dp := m["gauge"].(map[string]any)["dataPoints"].([]any)[0].(map[string]any)
	if dp["asDouble"] != 42.0 {
		t.Errorf("asDouble: got %v", dp["asDouble"])
	}
}

func TestBaremetalAdapter_PushTraces(t *testing.T) {
	adapter, fk, cleanup := newFakeOTLP(t)
	defer cleanup()
	err := adapter.PushTraces(context.Background(), []SpanRecord{{
		TraceID:     "abc",
		SpanID:      "def",
		Name:        "create-tenant",
		StartTimeNs: 1700000000000000000,
		EndTimeNs:   1700000001000000000,
		Attributes:  map[string]string{"tenant_id": "acme"},
	}})
	if err != nil {
		t.Fatalf("PushTraces: %v", err)
	}
	if fk.requests[0].path != "/otlp/v1/traces" {
		t.Errorf("traces request path: got %s", fk.requests[0].path)
	}
	spans := fk.requests[0].body["resourceSpans"].([]any)[0].(map[string]any)["scopeSpans"].([]any)[0].(map[string]any)["spans"].([]any)
	s := spans[0].(map[string]any)
	if s["name"] != "create-tenant" || s["traceId"] != "abc" || s["spanId"] != "def" {
		t.Errorf("span fields: name=%v traceId=%v spanId=%v", s["name"], s["traceId"], s["spanId"])
	}
}

func TestBaremetalAdapter_EmptyBatchesAreNoOps(t *testing.T) {
	adapter, fk, cleanup := newFakeOTLP(t)
	defer cleanup()
	ctx := context.Background()
	if err := adapter.PushLogs(ctx, nil); err != nil {
		t.Errorf("PushLogs nil: %v", err)
	}
	if err := adapter.PushMetrics(ctx, nil); err != nil {
		t.Errorf("PushMetrics nil: %v", err)
	}
	if err := adapter.PushTraces(ctx, nil); err != nil {
		t.Errorf("PushTraces nil: %v", err)
	}
	if len(fk.requests) != 0 {
		t.Errorf("empty batches sent requests: %d", len(fk.requests))
	}
}

func TestBaremetalAdapter_UnconfiguredEndpointErrors(t *testing.T) {
	adapter := NewBaremetalAdapter(Config{
		ServiceName: "test",
		// All three URLs left blank.
	})
	if err := adapter.PushLogs(context.Background(), []LogRecord{{Body: "x"}}); err == nil {
		t.Error("PushLogs with empty URL: expected error, got nil")
	}
}
