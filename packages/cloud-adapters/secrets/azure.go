package secrets

import (
	"context"
	"errors"
)

// AzureAdapter is the Azure-Key-Vault-backed secrets adapter. Stubbed pending the Azure-cloud milestone.
type AzureAdapter struct{}

func NewAzureAdapter() *AzureAdapter { return &AzureAdapter{} }

func (*AzureAdapter) MintKey(context.Context, string) error {
	return errors.New("NotImplemented: cloud-adapters/secrets/azure.MintKey — Key Vault impl lands in the Azure-cloud milestone")
}
func (*AzureAdapter) Encrypt(context.Context, string, []byte) (string, error) {
	return "", errors.New("NotImplemented: cloud-adapters/secrets/azure.Encrypt — Key Vault impl lands in the Azure-cloud milestone")
}
func (*AzureAdapter) Decrypt(context.Context, string, string) ([]byte, error) {
	return nil, errors.New("NotImplemented: cloud-adapters/secrets/azure.Decrypt — Key Vault impl lands in the Azure-cloud milestone")
}
func (*AzureAdapter) RotateKey(context.Context, string) error {
	return errors.New("NotImplemented: cloud-adapters/secrets/azure.RotateKey — Key Vault impl lands in the Azure-cloud milestone")
}
func (*AzureAdapter) DeleteKey(context.Context, string) error {
	return errors.New("NotImplemented: cloud-adapters/secrets/azure.DeleteKey — Key Vault impl lands in the Azure-cloud milestone")
}
