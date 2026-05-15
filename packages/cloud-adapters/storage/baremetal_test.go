package storage

import (
	"context"
	"net/http/httptest"
	"net/url"
	"sort"
	"strings"
	"testing"

	gofakes3 "github.com/johannesboyne/gofakes3"
	"github.com/johannesboyne/gofakes3/backend/s3mem"
	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

// newFakeMinIO spawns an in-process gofakes3 server, creates a bucket,
// and returns a minio-go client pointed at it. Hermetic L1 — no host
// binaries, no network.
func newFakeMinIO(t *testing.T) (*minio.Client, string, func()) {
	t.Helper()
	backend := s3mem.New()
	faker := gofakes3.New(backend)
	server := httptest.NewServer(faker.Server())

	u, err := url.Parse(server.URL)
	if err != nil {
		server.Close()
		t.Fatalf("parse fake server URL: %v", err)
	}

	client, err := minio.New(u.Host, &minio.Options{
		Creds:  credentials.NewStaticV4("ak", "sk", ""),
		Secure: false,
	})
	if err != nil {
		server.Close()
		t.Fatalf("minio client: %v", err)
	}

	const bucket = "monok8s-test"
	if err := client.MakeBucket(context.Background(), bucket, minio.MakeBucketOptions{}); err != nil {
		server.Close()
		t.Fatalf("make bucket: %v", err)
	}
	return client, bucket, server.Close
}

func TestBaremetalAdapter_RoundTrip(t *testing.T) {
	client, bucket, cleanup := newFakeMinIO(t)
	defer cleanup()
	ctx := context.Background()

	adapter := NewBaremetalAdapter(client, bucket)

	// Put two objects under the same prefix and one under a different prefix.
	want := map[string][]byte{
		"tenant/acme/users.json":   []byte(`{"users":[]}`),
		"tenant/acme/groups.json":  []byte(`{"groups":[]}`),
		"tenant/beta/users.json":   []byte(`{"users":[{"id":"1"}]}`),
	}
	for k, v := range want {
		if err := adapter.Put(ctx, k, v); err != nil {
			t.Fatalf("Put(%q): %v", k, err)
		}
	}

	// Get each back and compare bytes.
	for k, expected := range want {
		got, err := adapter.Get(ctx, k)
		if err != nil {
			t.Fatalf("Get(%q): %v", k, err)
		}
		if string(got) != string(expected) {
			t.Errorf("Get(%q): got %q want %q", k, got, expected)
		}
	}

	// List under the acme prefix returns exactly the two acme keys.
	keys, err := adapter.List(ctx, "tenant/acme/")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	sort.Strings(keys)
	wantKeys := []string{"tenant/acme/groups.json", "tenant/acme/users.json"}
	if strings.Join(keys, ",") != strings.Join(wantKeys, ",") {
		t.Errorf("List(acme/): got %v want %v", keys, wantKeys)
	}

	// Delete one, verify it's gone, the other survives.
	if err := adapter.Delete(ctx, "tenant/acme/users.json"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	keys2, err := adapter.List(ctx, "tenant/acme/")
	if err != nil {
		t.Fatalf("List after delete: %v", err)
	}
	if len(keys2) != 1 || keys2[0] != "tenant/acme/groups.json" {
		t.Errorf("List after delete: got %v want [tenant/acme/groups.json]", keys2)
	}
}

func TestBaremetalAdapter_GetMissingKey(t *testing.T) {
	client, bucket, cleanup := newFakeMinIO(t)
	defer cleanup()
	adapter := NewBaremetalAdapter(client, bucket)
	if _, err := adapter.Get(context.Background(), "does/not/exist"); err == nil {
		t.Fatalf("Get missing key: expected error, got nil")
	}
}
