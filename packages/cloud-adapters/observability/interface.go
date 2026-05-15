// Package observability defines the cloud-adapter observability axis interface.
// Bare-metal impl: Loki + Mimir + Tempo. Cloud impls: CloudWatch+X-Ray /
// Cloud Logging+Trace / Azure Monitor+App Insights.
package observability

import "context"

type LogRecord struct {
	Timestamp int64
	Severity  string
	Body      string
	Labels    map[string]string
}

type MetricPoint struct {
	Name      string
	Value     float64
	Timestamp int64
	Labels    map[string]string
}

type SpanRecord struct {
	TraceID     string
	SpanID      string
	Name        string
	StartTimeNs int64
	EndTimeNs   int64
	Attributes  map[string]string
}

type Adapter interface {
	PushLogs(ctx context.Context, records []LogRecord) error
	PushMetrics(ctx context.Context, points []MetricPoint) error
	PushTraces(ctx context.Context, spans []SpanRecord) error
}
