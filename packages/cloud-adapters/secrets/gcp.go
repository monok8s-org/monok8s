package secrets

import (
	"context"
	"errors"
)

// GcpAdapter is the GCP-Secret-Manager-backed secrets adapter. Stubbed pending the GCP-cloud milestone.
type GcpAdapter struct{}

func NewGcpAdapter() *GcpAdapter { return &GcpAdapter{} }

func (*GcpAdapter) MintKey(context.Context, string) error {
	return errors.New("NotImplemented: cloud-adapters/secrets/gcp.MintKey — Secret Manager impl lands in the GCP-cloud milestone")
}
func (*GcpAdapter) Encrypt(context.Context, string, []byte) (string, error) {
	return "", errors.New("NotImplemented: cloud-adapters/secrets/gcp.Encrypt — Secret Manager impl lands in the GCP-cloud milestone")
}
func (*GcpAdapter) Decrypt(context.Context, string, string) ([]byte, error) {
	return nil, errors.New("NotImplemented: cloud-adapters/secrets/gcp.Decrypt — Secret Manager impl lands in the GCP-cloud milestone")
}
func (*GcpAdapter) RotateKey(context.Context, string) error {
	return errors.New("NotImplemented: cloud-adapters/secrets/gcp.RotateKey — Secret Manager impl lands in the GCP-cloud milestone")
}
func (*GcpAdapter) DeleteKey(context.Context, string) error {
	return errors.New("NotImplemented: cloud-adapters/secrets/gcp.DeleteKey — Secret Manager impl lands in the GCP-cloud milestone")
}
