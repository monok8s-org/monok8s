package secrets

import (
	"context"
	"errors"
)

// AwsAdapter is the AWS-Secrets-Manager-backed secrets adapter. Stubbed pending the AWS-cloud milestone.
type AwsAdapter struct{}

func NewAwsAdapter() *AwsAdapter { return &AwsAdapter{} }

func (*AwsAdapter) MintKey(context.Context, string) error {
	return errors.New("NotImplemented: cloud-adapters/secrets/aws.MintKey — Secrets Manager impl lands in the AWS-cloud milestone")
}
func (*AwsAdapter) Encrypt(context.Context, string, []byte) (string, error) {
	return "", errors.New("NotImplemented: cloud-adapters/secrets/aws.Encrypt — Secrets Manager impl lands in the AWS-cloud milestone")
}
func (*AwsAdapter) Decrypt(context.Context, string, string) ([]byte, error) {
	return nil, errors.New("NotImplemented: cloud-adapters/secrets/aws.Decrypt — Secrets Manager impl lands in the AWS-cloud milestone")
}
func (*AwsAdapter) RotateKey(context.Context, string) error {
	return errors.New("NotImplemented: cloud-adapters/secrets/aws.RotateKey — Secrets Manager impl lands in the AWS-cloud milestone")
}
func (*AwsAdapter) DeleteKey(context.Context, string) error {
	return errors.New("NotImplemented: cloud-adapters/secrets/aws.DeleteKey — Secrets Manager impl lands in the AWS-cloud milestone")
}
