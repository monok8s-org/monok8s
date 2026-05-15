import type { DatabaseAdapter } from "./interface";

const notImpl = (op: string): never => {
  throw new Error(`NotImplemented: cloud-adapters/database/azure.${op} — Azure DB impl lands in the Azure-cloud milestone`);
};

export const azure: DatabaseAdapter = {
  provisionInstance: async () => notImpl("provisionInstance"),
  describeInstance:  async () => notImpl("describeInstance"),
  deleteInstance:    async () => notImpl("deleteInstance"),
};
