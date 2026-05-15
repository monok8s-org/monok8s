import type { ObservabilityAdapter } from "./interface";

const notImpl = (op: string): never => {
  throw new Error(`NotImplemented: cloud-adapters/observability/aws.${op} — CloudWatch+X-Ray impl lands in the AWS-cloud milestone`);
};

export const aws: ObservabilityAdapter = {
  pushLogs:    async () => notImpl("pushLogs"),
  pushMetrics: async () => notImpl("pushMetrics"),
  pushTraces:  async () => notImpl("pushTraces"),
};
