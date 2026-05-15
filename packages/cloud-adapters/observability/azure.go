package observability

import (
	"context"
	"errors"
)

// AzureAdapter is the Azure-Monitor+App-Insights-backed observability adapter. Stubbed pending the Azure-cloud milestone.
type AzureAdapter struct{}

func NewAzureAdapter() *AzureAdapter { return &AzureAdapter{} }

func (*AzureAdapter) PushLogs(context.Context, []LogRecord) error {
	return errors.New("NotImplemented: cloud-adapters/observability/azure.PushLogs — Azure Monitor+App Insights impl lands in the Azure-cloud milestone")
}
func (*AzureAdapter) PushMetrics(context.Context, []MetricPoint) error {
	return errors.New("NotImplemented: cloud-adapters/observability/azure.PushMetrics — Azure Monitor+App Insights impl lands in the Azure-cloud milestone")
}
func (*AzureAdapter) PushTraces(context.Context, []SpanRecord) error {
	return errors.New("NotImplemented: cloud-adapters/observability/azure.PushTraces — Azure Monitor+App Insights impl lands in the Azure-cloud milestone")
}
