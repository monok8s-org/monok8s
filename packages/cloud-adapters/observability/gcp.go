package observability

import (
	"context"
	"errors"
)

// GcpAdapter is the Cloud-Logging+Trace-backed observability adapter. Stubbed pending the GCP-cloud milestone.
type GcpAdapter struct{}

func NewGcpAdapter() *GcpAdapter { return &GcpAdapter{} }

func (*GcpAdapter) PushLogs(context.Context, []LogRecord) error {
	return errors.New("NotImplemented: cloud-adapters/observability/gcp.PushLogs — Cloud Logging+Trace impl lands in the GCP-cloud milestone")
}
func (*GcpAdapter) PushMetrics(context.Context, []MetricPoint) error {
	return errors.New("NotImplemented: cloud-adapters/observability/gcp.PushMetrics — Cloud Logging+Trace impl lands in the GCP-cloud milestone")
}
func (*GcpAdapter) PushTraces(context.Context, []SpanRecord) error {
	return errors.New("NotImplemented: cloud-adapters/observability/gcp.PushTraces — Cloud Logging+Trace impl lands in the GCP-cloud milestone")
}
