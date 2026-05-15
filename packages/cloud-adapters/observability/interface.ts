// Observability adapter axis — one push surface per signal (logs /
// metrics / traces). Bare-metal pushes to Loki / Mimir / Tempo over
// OTLP+HTTP-push; cloud impls map to CloudWatch+X-Ray / Cloud Logging+
// Trace / Azure Monitor+App Insights.

export interface LogRecord {
  readonly timestamp: number;
  readonly severity: string;
  readonly body: string;
  readonly labels: Record<string, string>;
}

export interface MetricPoint {
  readonly name: string;
  readonly value: number;
  readonly timestamp: number;
  readonly labels: Record<string, string>;
}

export interface SpanRecord {
  readonly traceId: string;
  readonly spanId: string;
  readonly name: string;
  readonly startTimeNs: number;
  readonly endTimeNs: number;
  readonly attributes: Record<string, string>;
}

export interface ObservabilityAdapter {
  pushLogs(records: LogRecord[]): Promise<void>;
  pushMetrics(points: MetricPoint[]): Promise<void>;
  pushTraces(spans: SpanRecord[]): Promise<void>;
}
