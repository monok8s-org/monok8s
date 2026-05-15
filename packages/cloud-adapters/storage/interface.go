// Package storage defines the cloud-adapter storage axis interface.
// Bare-metal impl: MinIO. Cloud impls: S3 / GCS / Azure Blob.
package storage

import "context"

type Adapter interface {
	Put(ctx context.Context, key string, body []byte) error
	Get(ctx context.Context, key string) ([]byte, error)
	Delete(ctx context.Context, key string) error
	List(ctx context.Context, prefix string) ([]string, error)
}
