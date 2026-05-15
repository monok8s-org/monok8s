import type { DatabaseAdapter } from "./interface";

const notImpl = (op: string): never => {
  throw new Error(`NotImplemented: cloud-adapters/database/aws.${op} — RDS impl lands in the AWS-cloud milestone`);
};

export const aws: DatabaseAdapter = {
  provisionInstance: async () => notImpl("provisionInstance"),
  describeInstance:  async () => notImpl("describeInstance"),
  deleteInstance:    async () => notImpl("deleteInstance"),
};
