package securityfindings

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"cloud.google.com/go/pubsub"
	"go.temporal.io/sdk/client"
)

// GCPSecurityFindingsConsumer polls the monok8s-security-findings-sub Pub/Sub
// subscription and starts SecurityFindingWorkflow for each finding.
type GCPSecurityFindingsConsumer struct {
	sub      *pubsub.Subscription
	temporal client.Client
	logger   *slog.Logger
}

func (c *GCPSecurityFindingsConsumer) Run(ctx context.Context) error {
	c.logger.Info("starting GCP security findings consumer")
	return c.sub.Receive(ctx, func(ctx context.Context, msg *pubsub.Message) {
		if err := c.processMessage(ctx, msg); err != nil {
			c.logger.Error("failed to process GCP security finding", "err", err, "msg_id", msg.ID)
			msg.Nack()
			return
		}
		msg.Ack()
	})
}

func (c *GCPSecurityFindingsConsumer) processMessage(ctx context.Context, msg *pubsub.Message) error {
	var envelope struct {
		Finding struct {
			Name        string `json:"name"`
			Category    string `json:"category"`
			State       string `json:"state"`
			Severity    string `json:"severity"`
			Description string `json:"description"`
			ResourceName string `json:"resourceName"`
			SourceProperties map[string]any `json:"sourceProperties"`
			FindingClass string `json:"findingClass"`
			EventTime   time.Time `json:"eventTime"`
			CreateTime  time.Time `json:"createTime"`
		} `json:"finding"`
		Resource struct {
			Name        string            `json:"name"`
			Type        string            `json:"type"`
			DisplayName string            `json:"displayName"`
			Labels      map[string]string `json:"labels"`
		} `json:"resource"`
	}
	if err := json.Unmarshal(msg.Data, &envelope); err != nil {
		return fmt.Errorf("unmarshalling SCC finding: %w", err)
	}

	// Ignore resolved/muted findings.
	if envelope.Finding.State != "ACTIVE" {
		return nil
	}

	tenantID := envelope.Resource.Labels["monok8s.io/tenant-id"]
	resourceID := envelope.Resource.Labels["monok8s.io/resource-id"]
	resourceType := envelope.Resource.Labels["monok8s.io/resource-type"]

	finding := NormalisedFinding{
		FindingID:    envelope.Finding.Name,
		Cloud:        "gcp",
		TenantID:     tenantID,   // may be empty; resolved by workflow activity
		ResourceType: resourceType,
		ResourceID:   resourceID,
		ResourceARN:  envelope.Resource.Name, // GCP uses resource name, not ARN
		Severity:     strings.ToLower(envelope.Finding.Severity),
		Title:        envelope.Finding.Category,
		Description:  envelope.Finding.Description,
		FindingType:  mapSCCFindingClass(envelope.Finding.FindingClass),
		Status:       "active",
		RawPayload:   string(msg.Data),
		ReceivedAt:   envelope.Finding.EventTime,
	}

	_, err := c.temporal.ExecuteWorkflow(ctx, client.StartWorkflowOptions{
		ID:        "security-finding-gcp-" + sanitizeID(envelope.Finding.Name),
		TaskQueue: "security-findings",
		// Deduplication: if the same finding arrives twice, Temporal returns the
		// existing workflow rather than starting a new one.
		WorkflowIDReusePolicy: client.WORKFLOW_ID_REUSE_POLICY_ALLOW_DUPLICATE_FAILED_ONLY,
	}, SecurityFindingWorkflow, finding)
	return err
}

func mapSCCFindingClass(class string) string {
	switch class {
	case "THREAT":
		return "threat"
	case "VULNERABILITY":
		return "vulnerability"
	case "MISCONFIGURATION":
		return "misconfiguration"
	default:
		return "access"
	}
}
