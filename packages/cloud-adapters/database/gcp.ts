import type { DatabaseAdapter } from "./interface";

const notImpl = (op: string): never => {
  throw new Error(`NotImplemented: cloud-adapters/database/gcp.${op} — Cloud SQL impl lands in the GCP-cloud milestone`);
};

export const gcp: DatabaseAdapter = {
  provisionInstance: async () => notImpl("provisionInstance"),
  describeInstance:  async () => notImpl("describeInstance"),
  deleteInstance:    async () => notImpl("deleteInstance"),
};
