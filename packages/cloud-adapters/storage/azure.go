package storage

import (
	"context"
	"errors"
)

// AzureAdapter is the Azure-Blob-backed storage adapter. Stubbed pending the Azure-cloud milestone.
type AzureAdapter struct{}

func NewAzureAdapter() *AzureAdapter { return &AzureAdapter{} }

func (*AzureAdapter) Put(context.Context, string, []byte) error {
	return errors.New("NotImplemented: cloud-adapters/storage/azure.Put — Blob impl lands in the Azure-cloud milestone")
}
func (*AzureAdapter) Get(context.Context, string) ([]byte, error) {
	return nil, errors.New("NotImplemented: cloud-adapters/storage/azure.Get — Blob impl lands in the Azure-cloud milestone")
}
func (*AzureAdapter) Delete(context.Context, string) error {
	return errors.New("NotImplemented: cloud-adapters/storage/azure.Delete — Blob impl lands in the Azure-cloud milestone")
}
func (*AzureAdapter) List(context.Context, string) ([]string, error) {
	return nil, errors.New("NotImplemented: cloud-adapters/storage/azure.List — Blob impl lands in the Azure-cloud milestone")
}
