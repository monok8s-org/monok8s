package securityfindings

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/service/sqs"
	"go.temporal.io/sdk/client"
)

// AWSSecurityFindingsConsumer long-polls the monok8s-security-findings.fifo SQS
// queue and starts SecurityFindingWorkflow for each Security Hub finding.
type AWSSecurityFindingsConsumer struct {
	sqs      *sqs.Client
	queueURL string
	temporal client.Client
	logger   *slog.Logger
}

func (c *AWSSecurityFindingsConsumer) Run(ctx context.Context) error {
	c.logger.Info("starting AWS security findings consumer")
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		out, err := c.sqs.ReceiveMessage(ctx, &sqs.ReceiveMessageInput{
			QueueUrl:            &c.queueURL,
			MaxNumberOfMessages: 10,
			WaitTimeSeconds:     20,
			VisibilityTimeout:   120,
			MessageAttributeNames: []string{"All"},
		})
		if err != nil {
			c.logger.Error("SQS receive error", "err", err)
			continue
		}
		for _, msg := range out.Messages {
			if err := c.processMessage(ctx, msg); err != nil {
				c.logger.Error("failed to process AWS security finding",
					"err", err, "msg_id", aws.ToString(msg.MessageId))
				continue
			}
			c.sqs.DeleteMessage(ctx, &sqs.DeleteMessageInput{
				QueueUrl:      &c.queueURL,
				ReceiptHandle: msg.ReceiptHandle,
			})
		}
	}
}

func (c *AWSSecurityFindingsConsumer) processMessage(ctx context.Context, msg sqsMessage) error {
	// EventBridge wraps the Security Hub finding in a standard event envelope.
	var event struct {
		Source     string `json:"source"`
		DetailType string `json:"detail-type"`
		Detail     struct {
			Findings []struct {
				ID          string `json:"Id"`
				Title       string `json:"Title"`
				Description string `json:"Description"`
				Severity    struct {
					Label string `json:"Label"`
				} `json:"Severity"`
				Types     []string `json:"Types"`
				RecordState string `json:"RecordState"`
				WorkflowState string `json:"WorkflowState"`
				Resources []struct {
					Type    string            `json:"Type"`
					Id      string            `json:"Id"`
					Tags    map[string]string `json:"Tags"`
				} `json:"Resources"`
				UpdatedAt time.Time `json:"UpdatedAt"`
			} `json:"findings"`
		} `json:"detail"`
	}

	body := aws.ToString(msg.Body)
	if err := json.Unmarshal([]byte(body), &event); err != nil {
		return fmt.Errorf("unmarshalling Security Hub event: %w", err)
	}

	for _, f := range event.Detail.Findings {
		if f.RecordState != "ACTIVE" || f.WorkflowState == "SUPPRESSED" {
			continue
		}

		// Extract tenant context from the first tagged resource.
		var tenantID, resourceID, resourceType, resourceARN string
		for _, r := range f.Resources {
			if r.Tags["monok8s.io/managed"] == "true" {
				tenantID = r.Tags["monok8s.io/tenant-id"]
				resourceID = r.Tags["monok8s.io/resource-id"]
				resourceType = r.Tags["monok8s.io/resource-type"]
				resourceARN = r.Id
				break
			}
		}

		finding := NormalisedFinding{
			FindingID:    f.ID,
			Cloud:        "aws",
			TenantID:     tenantID,
			ResourceType: resourceType,
			ResourceID:   resourceID,
			ResourceARN:  resourceARN,
			Severity:     strings.ToLower(f.Severity.Label),
			Title:        f.Title,
			Description:  f.Description,
			FindingType:  mapSecHubFindingType(f.Types),
			Status:       "active",
			RawPayload:   body,
			ReceivedAt:   f.UpdatedAt,
		}

		_, err := c.temporal.ExecuteWorkflow(ctx, client.StartWorkflowOptions{
			ID:        "security-finding-aws-" + sanitizeID(f.ID),
			TaskQueue: "security-findings",
			WorkflowIDReusePolicy: client.WORKFLOW_ID_REUSE_POLICY_ALLOW_DUPLICATE_FAILED_ONLY,
		}, SecurityFindingWorkflow, finding)
		if err != nil {
			return err
		}
	}
	return nil
}

func mapSecHubFindingType(types []string) string {
	for _, t := range types {
		switch {
		case strings.Contains(t, "TTPs") || strings.Contains(t, "Unusual Behaviors"):
			return "threat"
		case strings.Contains(t, "Software and Configuration Checks"):
			return "misconfiguration"
		case strings.Contains(t, "Sensitive Data Identifications"):
			return "vulnerability"
		}
	}
	return "misconfiguration"
}

// Stub type to avoid import cycle in the module example
type sqsMessage = interface{ GetBody() *string; GetMessageId() *string; GetReceiptHandle() *string }
