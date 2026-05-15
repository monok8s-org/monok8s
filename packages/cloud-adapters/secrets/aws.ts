import type { SecretsAdapter } from "./interface";

const notImpl = (op: string): never => {
  throw new Error(`NotImplemented: cloud-adapters/secrets/aws.${op} — Secrets Manager impl lands in the AWS-cloud milestone`);
};

export const aws: SecretsAdapter = {
  mintKey:   async () => notImpl("mintKey"),
  encrypt:   async () => notImpl("encrypt"),
  decrypt:   async () => notImpl("decrypt"),
  rotateKey: async () => notImpl("rotateKey"),
  deleteKey: async () => notImpl("deleteKey"),
};
