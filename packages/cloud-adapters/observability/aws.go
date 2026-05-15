package observability

import (
	"context"
	"errors"
)

// AwsAdapter is the CloudWatch+X-Ray-backed observability adapter. Stubbed pending the AWS-cloud milestone.
type AwsAdapter struct{}

func NewAwsAdapter() *AwsAdapter { return &AwsAdapter{} }

func (*AwsAdapter) PushLogs(context.Context, []LogRecord) error {
	return errors.New("NotImplemented: cloud-adapters/observability/aws.PushLogs — CloudWatch+X-Ray impl lands in the AWS-cloud milestone")
}
func (*AwsAdapter) PushMetrics(context.Context, []MetricPoint) error {
	return errors.New("NotImplemented: cloud-adapters/observability/aws.PushMetrics — CloudWatch+X-Ray impl lands in the AWS-cloud milestone")
}
func (*AwsAdapter) PushTraces(context.Context, []SpanRecord) error {
	return errors.New("NotImplemented: cloud-adapters/observability/aws.PushTraces — CloudWatch+X-Ray impl lands in the AWS-cloud milestone")
}
