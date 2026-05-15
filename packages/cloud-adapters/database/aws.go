package database

import (
	"context"
	"errors"
)

// AwsAdapter is the RDS-backed database adapter. Stubbed pending the AWS-cloud milestone.
type AwsAdapter struct{}

func NewAwsAdapter() *AwsAdapter { return &AwsAdapter{} }

func (*AwsAdapter) ProvisionInstance(context.Context, string, string) (Handle, error) {
	return Handle{}, errors.New("NotImplemented: cloud-adapters/database/aws.ProvisionInstance — RDS impl lands in the AWS-cloud milestone")
}
func (*AwsAdapter) DescribeInstance(context.Context, string) (Handle, error) {
	return Handle{}, errors.New("NotImplemented: cloud-adapters/database/aws.DescribeInstance — RDS impl lands in the AWS-cloud milestone")
}
func (*AwsAdapter) DeleteInstance(context.Context, string) error {
	return errors.New("NotImplemented: cloud-adapters/database/aws.DeleteInstance — RDS impl lands in the AWS-cloud milestone")
}
