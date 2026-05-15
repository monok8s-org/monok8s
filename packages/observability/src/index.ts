import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-grpc";

export function initTelemetry(serviceName: string) {
  const sdk = new NodeSDK({
    serviceName,
    traceExporter: new OTLPTraceExporter(),
    metricReader: new OTLPMetricExporter() as any,
  });

  sdk.start();

  process.on("SIGTERM", () => sdk.shutdown());
}
