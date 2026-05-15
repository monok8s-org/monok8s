import type { ObservabilityAdapter } from "./interface";

const notImpl = (op: string): never => {
  throw new Error(`NotImplemented: cloud-adapters/observability/gcp.${op} — Cloud Logging+Trace impl lands in the GCP-cloud milestone`);
};

export const gcp: ObservabilityAdapter = {
  pushLogs:    async () => notImpl("pushLogs"),
  pushMetrics: async () => notImpl("pushMetrics"),
  pushTraces:  async () => notImpl("pushTraces"),
};
