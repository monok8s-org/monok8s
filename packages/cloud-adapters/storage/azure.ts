import type { StorageAdapter } from "./interface";

const notImpl = (op: string): never => {
  throw new Error(`NotImplemented: cloud-adapters/storage/azure.${op} — Blob impl lands in the Azure-cloud milestone`);
};

export const azure: StorageAdapter = {
  put:    async () => notImpl("put"),
  get:    async () => notImpl("get"),
  delete: async () => notImpl("delete"),
  list:   async () => notImpl("list"),
};
