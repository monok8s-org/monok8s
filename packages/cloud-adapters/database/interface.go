// Package database defines the cloud-adapter database axis interface.
// Bare-metal impl: CloudNativePG. Cloud impls: RDS / Cloud SQL / Azure DB.
package database

import "context"

type Handle struct {
	ID  string
	DSN string
}

type Adapter interface {
	ProvisionInstance(ctx context.Context, name, region string) (Handle, error)
	DescribeInstance(ctx context.Context, name string) (Handle, error)
	DeleteInstance(ctx context.Context, name string) error
}
