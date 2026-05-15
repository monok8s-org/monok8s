// Package secrets defines the cloud-adapter secrets axis interface.
// Bare-metal impl: Vault Transit. Cloud impls: AWS Secrets Manager /
// GCP Secret Manager / Azure Key Vault.
package secrets

import "context"

type Adapter interface {
	MintKey(ctx context.Context, name string) error
	Encrypt(ctx context.Context, name string, plaintext []byte) (string, error)
	Decrypt(ctx context.Context, name string, ciphertext string) ([]byte, error)
	RotateKey(ctx context.Context, name string) error
	DeleteKey(ctx context.Context, name string) error
}
