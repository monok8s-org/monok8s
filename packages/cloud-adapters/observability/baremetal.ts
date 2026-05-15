import type {
  ObservabilityAdapter,
  LogRecord,
  MetricPoint,
  SpanRecord,
} from "./interface";

export interface OtelConfig {
  logsURL: string;
  metricsURL: string;
  tracesURL: string;
  serviceName?: string;
  authHeader?: string;
  fetch?: typeof fetch;
}

const attrPairs = (labels: Record<string, string>) =>
  Object.entries(labels).map(([k, v]) => ({
    key: k,
    value: { stringValue: v },
  }));

export function newBaremetalAdapter(cfg: OtelConfig): ObservabilityAdapter {
  const f = cfg.fetch ?? fetch;
  const serviceName = cfg.serviceName ?? "monok8s";
  const resourceAttrs = () => ({
    attributes: [{ key: "service.name", value: { stringValue: serviceName } }],
  });

  const post = async (url: string, payload: object): Promise<void> => {
    if (!url) throw new Error("baremetal observability: endpoint URL not configured");
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (cfg.authHeader) headers["Authorization"] = cfg.authHeader;
    const res = await f(url, { method: "POST", headers, body: JSON.stringify(payload) });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`otlp ${url} → ${res.status}: ${body}`);
    }
  };

  return {
    async pushLogs(records: LogRecord[]): Promise<void> {
      if (records.length === 0) return;
      const logRecords = records.map((r) => ({
        timeUnixNano: String(r.timestamp),
        severityText: r.severity,
        body: { stringValue: r.body },
        attributes: attrPairs(r.labels),
      }));
      await post(cfg.logsURL, {
        resourceLogs: [{ resource: resourceAttrs(), scopeLogs: [{ logRecords }] }],
      });
    },
    async pushMetrics(points: MetricPoint[]): Promise<void> {
      if (points.length === 0) return;
      const metrics = points.map((p) => ({
        name: p.name,
        gauge: {
          dataPoints: [
            {
              timeUnixNano: String(p.timestamp),
              asDouble: p.value,
              attributes: attrPairs(p.labels),
            },
          ],
        },
      }));
      await post(cfg.metricsURL, {
        resourceMetrics: [{ resource: resourceAttrs(), scopeMetrics: [{ metrics }] }],
      });
    },
    async pushTraces(spans: SpanRecord[]): Promise<void> {
      if (spans.length === 0) return;
      const spanRecords = spans.map((s) => ({
        traceId: s.traceId,
        spanId: s.spanId,
        name: s.name,
        startTimeUnixNano: String(s.startTimeNs),
        endTimeUnixNano: String(s.endTimeNs),
        attributes: attrPairs(s.attributes),
      }));
      await post(cfg.tracesURL, {
        resourceSpans: [{ resource: resourceAttrs(), scopeSpans: [{ spans: spanRecords }] }],
      });
    },
  };
}

// Backwards-compat stub from #80 — throws on call; operators wire the
// real adapter via newBaremetalAdapter(cfg) instead.
const stubMsg = "cloud-adapters/observability/baremetal: configure via newBaremetalAdapter(cfg)";
export const baremetal: ObservabilityAdapter = {
  pushLogs:    async () => { throw new Error(stubMsg); },
  pushMetrics: async () => { throw new Error(stubMsg); },
  pushTraces:  async () => { throw new Error(stubMsg); },
};
