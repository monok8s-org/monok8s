import type { StorageAdapter } from "./interface";

const notImpl = (op: string): never => {
  throw new Error(`NotImplemented: cloud-adapters/storage/aws.${op} — S3 impl lands in the AWS-cloud milestone`);
};

export const aws: StorageAdapter = {
  put:    async () => notImpl("put"),
  get:    async () => notImpl("get"),
  delete: async () => notImpl("delete"),
  list:   async () => notImpl("list"),
};
