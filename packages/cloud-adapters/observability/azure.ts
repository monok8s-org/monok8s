import type { ObservabilityAdapter } from "./interface";

const notImpl = (op: string): never => {
  throw new Error(`NotImplemented: cloud-adapters/observability/azure.${op} — Azure Monitor+App Insights impl lands in the Azure-cloud milestone`);
};

export const azure: ObservabilityAdapter = {
  pushLogs:    async () => notImpl("pushLogs"),
  pushMetrics: async () => notImpl("pushMetrics"),
  pushTraces:  async () => notImpl("pushTraces"),
};
