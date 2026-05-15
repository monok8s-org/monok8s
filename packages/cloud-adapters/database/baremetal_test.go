package database

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// fakeK8s is a hermetic in-process stand-in for the Kubernetes API
// server. It implements only the verbs the CNPG adapter exercises
// (POST/GET/DELETE on /apis/postgresql.cnpg.io/v1/namespaces/<ns>/
// clusters[/name]) and keeps applied CRs in memory.
type fakeK8s struct {
	mu        sync.Mutex
	clusters  map[string]map[string]any // ns/name → cluster CR
	requests  []requestLog
}

type requestLog struct {
	method, path, body string
}

func newFakeK8s() *fakeK8s {
	return &fakeK8s{clusters: map[string]map[string]any{}}
}

func (f *fakeK8s) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()

	body := ""
	if r.Body != nil {
		buf, _ := io.ReadAll(r.Body)
		body = string(buf)
	}
	f.requests = append(f.requests, requestLog{r.Method, r.URL.Path, body})

	prefix := "/apis/postgresql.cnpg.io/v1/namespaces/"
	if !strings.HasPrefix(r.URL.Path, prefix) {
		http.Error(w, "no route", http.StatusNotFound)
		return
	}
	rest := strings.TrimPrefix(r.URL.Path, prefix)
	parts := strings.Split(rest, "/")
	// expected: <ns>/clusters[/name]
	if len(parts) < 2 || parts[1] != "clusters" {
		http.Error(w, "no route", http.StatusNotFound)
		return
	}
	ns := parts[0]

	switch {
	case r.Method == http.MethodPost && len(parts) == 2:
		// POST .../clusters — create
		var cr map[string]any
		if err := json.NewDecoder(strings.NewReader(body)).Decode(&cr); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		meta, _ := cr["metadata"].(map[string]any)
		name, _ := meta["name"].(string)
		f.clusters[ns+"/"+name] = cr
		writeJSON(w, cr)

	case r.Method == http.MethodGet && len(parts) == 3:
		// GET .../clusters/<name>
		cr, ok := f.clusters[ns+"/"+parts[2]]
		if !ok {
			http.Error(w, `{"reason":"NotFound"}`, http.StatusNotFound)
			return
		}
		writeJSON(w, cr)

	case r.Method == http.MethodDelete && len(parts) == 3:
		// DELETE .../clusters/<name>
		key := ns + "/" + parts[2]
		if _, ok := f.clusters[key]; !ok {
			http.Error(w, `{"reason":"NotFound"}`, http.StatusNotFound)
			return
		}
		delete(f.clusters, key)
		w.WriteHeader(http.StatusOK)

	default:
		http.Error(w, "unhandled: "+r.Method+" "+rest, http.StatusNotImplemented)
	}
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func newFakeCluster(t *testing.T) (*BaremetalAdapter, *fakeK8s, func()) {
	t.Helper()
	fk := newFakeK8s()
	server := httptest.NewServer(fk)
	adapter := NewBaremetalAdapter(server.Client(), server.URL, "fake-token", "tenant-acme", "app")
	return adapter, fk, server.Close
}

func TestBaremetalAdapter_ProvisionDescribeDelete(t *testing.T) {
	adapter, fk, cleanup := newFakeCluster(t)
	defer cleanup()
	ctx := context.Background()

	h, err := adapter.ProvisionInstance(ctx, "tenant-acme-db", "us-central1")
	if err != nil {
		t.Fatalf("ProvisionInstance: %v", err)
	}
	if h.ID != "tenant-acme/tenant-acme-db" {
		t.Errorf("Handle.ID: got %q want tenant-acme/tenant-acme-db", h.ID)
	}
	want := "postgres://app@tenant-acme-db-rw.tenant-acme.svc.cluster.local:5432/app?sslmode=require"
	if h.DSN != want {
		t.Errorf("Handle.DSN: got %q want %q", h.DSN, want)
	}

	// Verify the CR shape the fake K8s API received.
	if len(fk.requests) != 1 {
		t.Fatalf("requests: got %d, want 1", len(fk.requests))
	}
	req := fk.requests[0]
	if req.method != "POST" || !strings.Contains(req.path, "/namespaces/tenant-acme/clusters") {
		t.Errorf("provision request: got %s %s", req.method, req.path)
	}
	var cr map[string]any
	if err := json.NewDecoder(strings.NewReader(req.body)).Decode(&cr); err != nil {
		t.Fatalf("decode CR: %v", err)
	}
	if cr["apiVersion"] != "postgresql.cnpg.io/v1" || cr["kind"] != "Cluster" {
		t.Errorf("CR apiVersion/kind: got %v/%v", cr["apiVersion"], cr["kind"])
	}

	// Describe round-trips through GET.
	h2, err := adapter.DescribeInstance(ctx, "tenant-acme-db")
	if err != nil {
		t.Fatalf("DescribeInstance: %v", err)
	}
	if h2.DSN != want {
		t.Errorf("DescribeInstance DSN: got %q want %q", h2.DSN, want)
	}

	// Delete reaps; subsequent describe surfaces the error path.
	if err := adapter.DeleteInstance(ctx, "tenant-acme-db"); err != nil {
		t.Fatalf("DeleteInstance: %v", err)
	}
	if _, err := adapter.DescribeInstance(ctx, "tenant-acme-db"); err == nil {
		t.Errorf("DescribeInstance after delete: expected error, got nil")
	}
}

func TestBaremetalAdapter_BearerTokenHeader(t *testing.T) {
	var seenAuth string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenAuth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"apiVersion":"postgresql.cnpg.io/v1","kind":"Cluster","metadata":{"name":"x","namespace":"y"},"spec":{}}`))
	}))
	defer server.Close()

	adapter := NewBaremetalAdapter(server.Client(), server.URL, "my-token", "ns", "")
	_, err := adapter.ProvisionInstance(context.Background(), "x", "")
	if err != nil {
		t.Fatalf("ProvisionInstance: %v", err)
	}
	if seenAuth != "Bearer my-token" {
		t.Errorf("Authorization header: got %q, want %q", seenAuth, "Bearer my-token")
	}
}
