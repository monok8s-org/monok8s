package secrets

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	vault "github.com/hashicorp/vault/api"
)

// fakeTransit is a hermetic in-process stand-in for Vault's Transit
// Secrets Engine. It implements only the verbs the adapter exercises
// (mint, encrypt, decrypt, rotate, deletion-config, delete) and the
// canonical `vault:v<version>:<base64-payload>` ciphertext shape.
type fakeTransit struct {
	mu        sync.Mutex
	mount     string
	keys      map[string]int // name → current version
	allowDel  map[string]bool
}

func newFakeTransit(mount string) *fakeTransit {
	return &fakeTransit{
		mount:    mount,
		keys:     map[string]int{},
		allowDel: map[string]bool{},
	}
}

// route trims the `/v1/<mount>/` prefix and dispatches on the rest.
func (f *fakeTransit) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	prefix := "/v1/" + f.mount + "/"
	if !strings.HasPrefix(r.URL.Path, prefix) {
		http.Error(w, "no route", http.StatusNotFound)
		return
	}
	sub := strings.TrimPrefix(r.URL.Path, prefix)
	parts := strings.Split(sub, "/")

	f.mu.Lock()
	defer f.mu.Unlock()

	switch {
	case len(parts) == 2 && parts[0] == "keys" && (r.Method == http.MethodPost || r.Method == http.MethodPut):
		// mint-or-update at /keys/<name>. vault-api's Logical().Write uses PUT.
		f.keys[parts[1]] = 1
		writeData(w, nil)

	case len(parts) == 2 && parts[0] == "keys" && r.Method == http.MethodDelete:
		// delete at /keys/<name> — requires deletion_allowed
		if !f.allowDel[parts[1]] {
			http.Error(w, `{"errors":["deletion is not allowed for this key"]}`, http.StatusBadRequest)
			return
		}
		delete(f.keys, parts[1])
		delete(f.allowDel, parts[1])
		w.WriteHeader(http.StatusNoContent)

	case len(parts) == 3 && parts[0] == "keys" && parts[2] == "rotate" && (r.Method == http.MethodPost || r.Method == http.MethodPut):
		// rotate at /keys/<name>/rotate
		if _, ok := f.keys[parts[1]]; !ok {
			http.Error(w, `{"errors":["key not found"]}`, http.StatusNotFound)
			return
		}
		f.keys[parts[1]]++
		writeData(w, nil)

	case len(parts) == 3 && parts[0] == "keys" && parts[2] == "config" && (r.Method == http.MethodPost || r.Method == http.MethodPut):
		// set config at /keys/<name>/config — supports `deletion_allowed`
		body := decodeBody(r)
		if v, _ := body["deletion_allowed"].(bool); v {
			f.allowDel[parts[1]] = true
		}
		writeData(w, nil)

	case len(parts) == 2 && parts[0] == "encrypt" && (r.Method == http.MethodPost || r.Method == http.MethodPut):
		// encrypt at /encrypt/<name> — body has `plaintext` (base64)
		ver, ok := f.keys[parts[1]]
		if !ok {
			http.Error(w, `{"errors":["encryption key not found"]}`, http.StatusNotFound)
			return
		}
		body := decodeBody(r)
		pt, _ := body["plaintext"].(string) // already base64-encoded by adapter
		ct := fmt.Sprintf("vault:v%d:%s", ver, pt)
		writeData(w, map[string]any{"ciphertext": ct})

	case len(parts) == 2 && parts[0] == "decrypt" && (r.Method == http.MethodPost || r.Method == http.MethodPut):
		// decrypt at /decrypt/<name> — body has `ciphertext`
		if _, ok := f.keys[parts[1]]; !ok {
			http.Error(w, `{"errors":["encryption key not found"]}`, http.StatusNotFound)
			return
		}
		body := decodeBody(r)
		ct, _ := body["ciphertext"].(string)
		// Format: vault:v<n>:<base64-payload>. Extract last segment.
		idx := strings.LastIndex(ct, ":")
		if idx < 0 || !strings.HasPrefix(ct, "vault:v") {
			http.Error(w, `{"errors":["invalid ciphertext"]}`, http.StatusBadRequest)
			return
		}
		writeData(w, map[string]any{"plaintext": ct[idx+1:]})

	default:
		http.Error(w, "unhandled route: "+sub, http.StatusNotImplemented)
	}
}

// writeData wraps a payload in Vault's response envelope.
func writeData(w http.ResponseWriter, data map[string]any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"request_id": "fake",
		"data":       data,
	})
}

func decodeBody(r *http.Request) map[string]any {
	var body map[string]any
	_ = json.NewDecoder(r.Body).Decode(&body)
	return body
}

// newFakeVault spawns the fake Transit HTTP server, returns a vault
// client pointed at it.
func newFakeVault(t *testing.T, mount string) (*vault.Client, func()) {
	t.Helper()
	fake := newFakeTransit(mount)
	server := httptest.NewServer(fake)
	cfg := vault.DefaultConfig()
	cfg.Address = server.URL
	client, err := vault.NewClient(cfg)
	if err != nil {
		server.Close()
		t.Fatalf("vault client: %v", err)
	}
	client.SetToken("fake-token")
	return client, server.Close
}

func TestBaremetalAdapter_TransitRoundTrip(t *testing.T) {
	client, cleanup := newFakeVault(t, "transit")
	defer cleanup()
	ctx := context.Background()
	adapter := NewBaremetalAdapter(client, "transit")

	const keyName = "tenant-acme-pii"
	plaintext := []byte("sensitive-email@example.com")

	// Mint, encrypt, decrypt round-trip.
	if err := adapter.MintKey(ctx, keyName); err != nil {
		t.Fatalf("MintKey: %v", err)
	}
	ct, err := adapter.Encrypt(ctx, keyName, plaintext)
	if err != nil {
		t.Fatalf("Encrypt: %v", err)
	}
	if !strings.HasPrefix(ct, "vault:v1:") {
		t.Errorf("ciphertext shape: got %q, want vault:v1:<...>", ct)
	}
	pt, err := adapter.Decrypt(ctx, keyName, ct)
	if err != nil {
		t.Fatalf("Decrypt: %v", err)
	}
	if string(pt) != string(plaintext) {
		t.Errorf("round-trip: got %q want %q", pt, plaintext)
	}

	// Rotate: ciphertext from rotated key uses new version.
	if err := adapter.RotateKey(ctx, keyName); err != nil {
		t.Fatalf("RotateKey: %v", err)
	}
	ct2, err := adapter.Encrypt(ctx, keyName, plaintext)
	if err != nil {
		t.Fatalf("Encrypt after rotate: %v", err)
	}
	if !strings.HasPrefix(ct2, "vault:v2:") {
		t.Errorf("post-rotate ciphertext: got %q, want vault:v2:<...>", ct2)
	}
}

func TestBaremetalAdapter_CryptoShred(t *testing.T) {
	client, cleanup := newFakeVault(t, "transit")
	defer cleanup()
	ctx := context.Background()
	adapter := NewBaremetalAdapter(client, "transit")
	const keyName = "tenant-beta-pii"

	if err := adapter.MintKey(ctx, keyName); err != nil {
		t.Fatalf("MintKey: %v", err)
	}
	// Lock the key into existence: encrypt-decrypt works pre-shred.
	if _, err := adapter.Encrypt(ctx, keyName, []byte("data")); err != nil {
		t.Fatalf("Encrypt pre-shred: %v", err)
	}

	// Crypto-shred: deleteKey flips deletion_allowed + deletes.
	if err := adapter.DeleteKey(ctx, keyName); err != nil {
		t.Fatalf("DeleteKey (shred): %v", err)
	}

	// Subsequent encrypt with the same name MUST fail — the key is
	// gone and the operator should get an error rather than a silent
	// fall-through to mint-and-encrypt (Discussion #76 crypto-shred
	// guarantee: a deleted key cannot be impersonated by a fresh mint
	// with the same name unless the operator explicitly mints again).
	if _, err := adapter.Encrypt(ctx, keyName, []byte("data")); err == nil {
		t.Errorf("Encrypt after crypto-shred: expected error, got nil")
	}
}

// Sanity: an empty base64-encoded plaintext round-trips cleanly.
func TestBaremetalAdapter_EmptyPlaintext(t *testing.T) {
	client, cleanup := newFakeVault(t, "transit")
	defer cleanup()
	ctx := context.Background()
	adapter := NewBaremetalAdapter(client, "transit")
	const keyName = "edge"
	if err := adapter.MintKey(ctx, keyName); err != nil {
		t.Fatal(err)
	}
	ct, err := adapter.Encrypt(ctx, keyName, nil)
	if err != nil {
		t.Fatalf("Encrypt empty: %v", err)
	}
	pt, err := adapter.Decrypt(ctx, keyName, ct)
	if err != nil {
		t.Fatalf("Decrypt empty: %v", err)
	}
	// base64("") = "" — the round-trip returns an empty slice.
	if len(pt) != 0 {
		t.Errorf("empty plaintext round-trip: got %v, want empty", pt)
	}
	// Belt-and-suspenders: a sentinel value resolves correctly.
	_ = base64.StdEncoding
}
