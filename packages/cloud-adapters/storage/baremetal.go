package storage

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"

	"github.com/minio/minio-go/v7"
)

// BaremetalAdapter is the MinIO-backed storage adapter. Wraps the
// minio-go v7 client into the canonical Adapter interface. Bucket is
// fixed at construction; multi-bucket use cases get one adapter per
// bucket.
type BaremetalAdapter struct {
	client *minio.Client
	bucket string
}

// NewBaremetalAdapter constructs a MinIO-backed adapter. The bucket
// must already exist (callers either pre-create at install time or
// use minio-go's MakeBucket up front). Returning a non-nil error here
// usually means the minio.New call rejected the credentials or the
// endpoint config.
func NewBaremetalAdapter(client *minio.Client, bucket string) *BaremetalAdapter {
	return &BaremetalAdapter{client: client, bucket: bucket}
}

func (a *BaremetalAdapter) Put(ctx context.Context, key string, body []byte) error {
	_, err := a.client.PutObject(ctx, a.bucket, key,
		bytes.NewReader(body), int64(len(body)),
		minio.PutObjectOptions{},
	)
	if err != nil {
		return fmt.Errorf("baremetal storage put %q: %w", key, err)
	}
	return nil
}

func (a *BaremetalAdapter) Get(ctx context.Context, key string) ([]byte, error) {
	obj, err := a.client.GetObject(ctx, a.bucket, key, minio.GetObjectOptions{})
	if err != nil {
		return nil, fmt.Errorf("baremetal storage get %q: %w", key, err)
	}
	defer obj.Close()
	body, err := io.ReadAll(obj)
	if err != nil {
		// minio-go defers the 4xx/5xx surface to ReadAll on the
		// returned object — a NoSuchKey from S3 lands here, not on
		// GetObject above.
		return nil, fmt.Errorf("baremetal storage get %q: %w", key, err)
	}
	return body, nil
}

func (a *BaremetalAdapter) Delete(ctx context.Context, key string) error {
	if err := a.client.RemoveObject(ctx, a.bucket, key, minio.RemoveObjectOptions{}); err != nil {
		return fmt.Errorf("baremetal storage delete %q: %w", key, err)
	}
	return nil
}

func (a *BaremetalAdapter) List(ctx context.Context, prefix string) ([]string, error) {
	keys := []string{}
	for obj := range a.client.ListObjects(ctx, a.bucket, minio.ListObjectsOptions{
		Prefix:    prefix,
		Recursive: true,
	}) {
		if obj.Err != nil {
			return nil, fmt.Errorf("baremetal storage list %q: %w", prefix, obj.Err)
		}
		keys = append(keys, obj.Key)
	}
	return keys, nil
}

// Compile-time interface conformance check.
var _ Adapter = (*BaremetalAdapter)(nil)

// errNoClient is returned by helpers that need a configured client
// before a real impl is wired. Reserved for future use; currently the
// constructor takes a *minio.Client directly so we never produce this.
var errNoClient = errors.New("baremetal storage: no client configured")

var _ = errNoClient // keep referenced
