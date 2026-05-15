import type { StorageAdapter } from "./interface";
import { Client as MinIOClient } from "minio";

// MinIO-backed StorageAdapter. Bucket is fixed at construction so each
// caller owns a single-bucket adapter instance; multi-bucket use cases
// instantiate one adapter per bucket.
export function newBaremetalAdapter(client: MinIOClient, bucket: string): StorageAdapter {
  return {
    async put(key: string, body: Uint8Array): Promise<void> {
      // minio-js expects Buffer; Uint8Array converts cheaply (no copy
      // in modern Node).
      const buf = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
      await client.putObject(bucket, key, buf);
    },
    async get(key: string): Promise<Uint8Array> {
      const stream = await client.getObject(bucket, key);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk as Buffer);
      }
      return Uint8Array.from(Buffer.concat(chunks));
    },
    async delete(key: string): Promise<void> {
      await client.removeObject(bucket, key);
    },
    async list(prefix: string): Promise<string[]> {
      const out: string[] = [];
      const stream = client.listObjectsV2(bucket, prefix, true);
      await new Promise<void>((resolve, reject) => {
        stream.on("data", (obj) => {
          if (obj.name) out.push(obj.name);
        });
        stream.on("end", () => resolve());
        stream.on("error", (err) => reject(err));
      });
      return out;
    },
  };
}

// Backwards-compat alias — preserves the `baremetal` named export from
// the #80 scaffolding so contract_test.ts's Record entry stays valid.
// Throws on call until the operator wires it via newBaremetalAdapter.
export const baremetal: StorageAdapter = {
  put:    async () => { throw new Error("cloud-adapters/storage/baremetal: configure via newBaremetalAdapter(client, bucket)"); },
  get:    async () => { throw new Error("cloud-adapters/storage/baremetal: configure via newBaremetalAdapter(client, bucket)"); },
  delete: async () => { throw new Error("cloud-adapters/storage/baremetal: configure via newBaremetalAdapter(client, bucket)"); },
  list:   async () => { throw new Error("cloud-adapters/storage/baremetal: configure via newBaremetalAdapter(client, bucket)"); },
};
