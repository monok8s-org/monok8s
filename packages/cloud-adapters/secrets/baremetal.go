package secrets

import (
	"context"
	"encoding/base64"
	"fmt"

	vault "github.com/hashicorp/vault/api"
)

// BaremetalAdapter is the Vault-Transit-backed secrets adapter. The
// Transit Secrets Engine is per-tenant by convention — keys are named
// per-tenant (e.g. `tenant-acme-pii`), and crypto-shred = delete-key
// (Discussion #76). Mount path is fixed at construction; multi-mount
// use cases get one adapter per mount.
type BaremetalAdapter struct {
	client *vault.Client
	mount  string
}

// NewBaremetalAdapter constructs a Vault-Transit-backed adapter. The
// caller passes a *vault.Client already configured with endpoint +
// token (typically via vault.DefaultConfig() + client.SetToken()).
// The Transit engine must already be mounted at `mount` (operator
// runbook responsibility; not part of the adapter).
func NewBaremetalAdapter(client *vault.Client, mount string) *BaremetalAdapter {
	return &BaremetalAdapter{client: client, mount: mount}
}

func (a *BaremetalAdapter) MintKey(ctx context.Context, name string) error {
	path := fmt.Sprintf("%s/keys/%s", a.mount, name)
	if _, err := a.client.Logical().WriteWithContext(ctx, path, map[string]any{
		"type": "aes256-gcm96",
	}); err != nil {
		return fmt.Errorf("baremetal secrets MintKey %q: %w", name, err)
	}
	return nil
}

func (a *BaremetalAdapter) Encrypt(ctx context.Context, name string, plaintext []byte) (string, error) {
	path := fmt.Sprintf("%s/encrypt/%s", a.mount, name)
	res, err := a.client.Logical().WriteWithContext(ctx, path, map[string]any{
		"plaintext": base64.StdEncoding.EncodeToString(plaintext),
	})
	if err != nil {
		return "", fmt.Errorf("baremetal secrets Encrypt %q: %w", name, err)
	}
	if res == nil || res.Data == nil {
		return "", fmt.Errorf("baremetal secrets Encrypt %q: empty response", name)
	}
	ct, ok := res.Data["ciphertext"].(string)
	if !ok {
		return "", fmt.Errorf("baremetal secrets Encrypt %q: missing ciphertext", name)
	}
	return ct, nil
}

func (a *BaremetalAdapter) Decrypt(ctx context.Context, name string, ciphertext string) ([]byte, error) {
	path := fmt.Sprintf("%s/decrypt/%s", a.mount, name)
	res, err := a.client.Logical().WriteWithContext(ctx, path, map[string]any{
		"ciphertext": ciphertext,
	})
	if err != nil {
		return nil, fmt.Errorf("baremetal secrets Decrypt %q: %w", name, err)
	}
	if res == nil || res.Data == nil {
		return nil, fmt.Errorf("baremetal secrets Decrypt %q: empty response", name)
	}
	b64, ok := res.Data["plaintext"].(string)
	if !ok {
		return nil, fmt.Errorf("baremetal secrets Decrypt %q: missing plaintext", name)
	}
	pt, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return nil, fmt.Errorf("baremetal secrets Decrypt %q: invalid base64: %w", name, err)
	}
	return pt, nil
}

func (a *BaremetalAdapter) RotateKey(ctx context.Context, name string) error {
	path := fmt.Sprintf("%s/keys/%s/rotate", a.mount, name)
	if _, err := a.client.Logical().WriteWithContext(ctx, path, nil); err != nil {
		return fmt.Errorf("baremetal secrets RotateKey %q: %w", name, err)
	}
	return nil
}

func (a *BaremetalAdapter) DeleteKey(ctx context.Context, name string) error {
	// Vault refuses to delete a transit key unless deletion is enabled
	// on the key itself (`allow_plaintext_backup` / `deletion_allowed`).
	// Per the crypto-shred design (Discussion #76), the adapter flips
	// `deletion_allowed=true` first, then deletes.
	cfgPath := fmt.Sprintf("%s/keys/%s/config", a.mount, name)
	if _, err := a.client.Logical().WriteWithContext(ctx, cfgPath, map[string]any{
		"deletion_allowed": true,
	}); err != nil {
		return fmt.Errorf("baremetal secrets DeleteKey %q: enable deletion: %w", name, err)
	}
	path := fmt.Sprintf("%s/keys/%s", a.mount, name)
	if _, err := a.client.Logical().DeleteWithContext(ctx, path); err != nil {
		return fmt.Errorf("baremetal secrets DeleteKey %q: %w", name, err)
	}
	return nil
}

// Compile-time interface conformance check.
var _ Adapter = (*BaremetalAdapter)(nil)
