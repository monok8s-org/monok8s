package database

import (
	"context"
	"errors"
)

// AzureAdapter is the Azure-DB-Flexible-Server-backed database adapter. Stubbed pending the Azure-cloud milestone.
type AzureAdapter struct{}

func NewAzureAdapter() *AzureAdapter { return &AzureAdapter{} }

func (*AzureAdapter) ProvisionInstance(context.Context, string, string) (Handle, error) {
	return Handle{}, errors.New("NotImplemented: cloud-adapters/database/azure.ProvisionInstance — Azure DB impl lands in the Azure-cloud milestone")
}
func (*AzureAdapter) DescribeInstance(context.Context, string) (Handle, error) {
	return Handle{}, errors.New("NotImplemented: cloud-adapters/database/azure.DescribeInstance — Azure DB impl lands in the Azure-cloud milestone")
}
func (*AzureAdapter) DeleteInstance(context.Context, string) error {
	return errors.New("NotImplemented: cloud-adapters/database/azure.DeleteInstance — Azure DB impl lands in the Azure-cloud milestone")
}
