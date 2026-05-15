// Storage adapter axis — object-storage primitives the platform uses for
// tenant uploads / exports / cached blobs. Bare-metal is MinIO; cloud
// impls map to S3 / GCS / Azure Blob.

export interface StorageAdapter {
  put(key: string, body: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}
