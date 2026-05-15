package database

import (
	"context"
	"errors"
)

// GcpAdapter is the Cloud-SQL-backed database adapter. Stubbed pending the GCP-cloud milestone.
type GcpAdapter struct{}

func NewGcpAdapter() *GcpAdapter { return &GcpAdapter{} }

func (*GcpAdapter) ProvisionInstance(context.Context, string, string) (Handle, error) {
	return Handle{}, errors.New("NotImplemented: cloud-adapters/database/gcp.ProvisionInstance — Cloud SQL impl lands in the GCP-cloud milestone")
}
func (*GcpAdapter) DescribeInstance(context.Context, string) (Handle, error) {
	return Handle{}, errors.New("NotImplemented: cloud-adapters/database/gcp.DescribeInstance — Cloud SQL impl lands in the GCP-cloud milestone")
}
func (*GcpAdapter) DeleteInstance(context.Context, string) error {
	return errors.New("NotImplemented: cloud-adapters/database/gcp.DeleteInstance — Cloud SQL impl lands in the GCP-cloud milestone")
}
