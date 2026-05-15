package storage

import (
	"context"
	"errors"
)

// AwsAdapter is the S3-backed storage adapter. Stubbed pending the AWS-cloud milestone.
type AwsAdapter struct{}

func NewAwsAdapter() *AwsAdapter { return &AwsAdapter{} }

func (*AwsAdapter) Put(context.Context, string, []byte) error {
	return errors.New("NotImplemented: cloud-adapters/storage/aws.Put — S3 impl lands in the AWS-cloud milestone")
}
func (*AwsAdapter) Get(context.Context, string) ([]byte, error) {
	return nil, errors.New("NotImplemented: cloud-adapters/storage/aws.Get — S3 impl lands in the AWS-cloud milestone")
}
func (*AwsAdapter) Delete(context.Context, string) error {
	return errors.New("NotImplemented: cloud-adapters/storage/aws.Delete — S3 impl lands in the AWS-cloud milestone")
}
func (*AwsAdapter) List(context.Context, string) ([]string, error) {
	return nil, errors.New("NotImplemented: cloud-adapters/storage/aws.List — S3 impl lands in the AWS-cloud milestone")
}
