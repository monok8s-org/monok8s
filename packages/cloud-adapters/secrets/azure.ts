import type { SecretsAdapter } from "./interface";

const notImpl = (op: string): never => {
  throw new Error(`NotImplemented: cloud-adapters/secrets/azure.${op} — Key Vault impl lands in the Azure-cloud milestone`);
};

export const azure: SecretsAdapter = {
  mintKey:   async () => notImpl("mintKey"),
  encrypt:   async () => notImpl("encrypt"),
  decrypt:   async () => notImpl("decrypt"),
  rotateKey: async () => notImpl("rotateKey"),
  deleteKey: async () => notImpl("deleteKey"),
};
