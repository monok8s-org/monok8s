// Secrets adapter axis — KMS-style envelope ops the platform uses for
// per-tenant data encryption. Crypto-shred = key delete (Discussion #76).
// Bare-metal is Vault Transit; cloud impls map to AWS Secrets Manager /
// GCP Secret Manager / Azure Key Vault.

export interface SecretsAdapter {
  mintKey(name: string): Promise<void>;
  encrypt(name: string, plaintext: Uint8Array): Promise<string>;
  decrypt(name: string, ciphertext: string): Promise<Uint8Array>;
  rotateKey(name: string): Promise<void>;
  deleteKey(name: string): Promise<void>;
}
