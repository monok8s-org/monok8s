import type { SecretsAdapter } from "./interface";

const notImpl = (op: string): never => {
  throw new Error(`NotImplemented: cloud-adapters/secrets/gcp.${op} — Secret Manager impl lands in the GCP-cloud milestone`);
};

export const gcp: SecretsAdapter = {
  mintKey:   async () => notImpl("mintKey"),
  encrypt:   async () => notImpl("encrypt"),
  decrypt:   async () => notImpl("decrypt"),
  rotateKey: async () => notImpl("rotateKey"),
  deleteKey: async () => notImpl("deleteKey"),
};
