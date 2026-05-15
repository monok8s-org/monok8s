package storage

import (
	"context"
	"errors"
)

// GcpAdapter is the GCS-backed storage adapter. Stubbed pending the GCP-cloud milestone.
type GcpAdapter struct{}

func NewGcpAdapter() *GcpAdapter { return &GcpAdapter{} }

func (*GcpAdapter) Put(context.Context, string, []byte) error {
	return errors.New("NotImplemented: cloud-adapters/storage/gcp.Put — GCS impl lands in the GCP-cloud milestone")
}
func (*GcpAdapter) Get(context.Context, string) ([]byte, error) {
	return nil, errors.New("NotImplemented: cloud-adapters/storage/gcp.Get — GCS impl lands in the GCP-cloud milestone")
}
func (*GcpAdapter) Delete(context.Context, string) error {
	return errors.New("NotImplemented: cloud-adapters/storage/gcp.Delete — GCS impl lands in the GCP-cloud milestone")
}
func (*GcpAdapter) List(context.Context, string) ([]string, error) {
	return nil, errors.New("NotImplemented: cloud-adapters/storage/gcp.List — GCS impl lands in the GCP-cloud milestone")
}
