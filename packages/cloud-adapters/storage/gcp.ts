import type { StorageAdapter } from "./interface";

const notImpl = (op: string): never => {
  throw new Error(`NotImplemented: cloud-adapters/storage/gcp.${op} — GCS impl lands in the GCP-cloud milestone`);
};

export const gcp: StorageAdapter = {
  put:    async () => notImpl("put"),
  get:    async () => notImpl("get"),
  delete: async () => notImpl("delete"),
  list:   async () => notImpl("list"),
};
