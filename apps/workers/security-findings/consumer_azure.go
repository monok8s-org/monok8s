package securityfindings

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/messaging/azservicebus"
	"go.temporal.io/sdk/client"
)

// AzureSecurityFindingsConsumer receives Defender for Cloud alerts from the
// monok8s-security-findings Service Bus queue and starts SecurityFindingWorkflow.
type AzureSecurityFindingsConsumer struct {
	receiver *azservicebus.Receiver
	temporal client.Client
	logger   *slog.Logger
}

func (c *AzureSecurityFindingsConsumer) Run(ctx context.Context) error {
	c.logger.Info("starting Azure security findings consumer")
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		messages, err := c.receiver.ReceiveMessages(ctx, 10, nil)
		if err != nil {
			c.logger.Error("Service Bus receive error", "err", err)
			continue
		}
		for _, msg := range messages {
			if err := c.processMessage(ctx, msg); err != nil {
				c.logger.Error("failed to process Azure security finding",
					"err", err, "msg_id", msg.MessageID)
				c.receiver.AbandonMessage(ctx, msg, nil)
				continue
			}
			c.receiver.CompleteMessage(ctx, msg, nil)
		}
	}
}

func (c *AzureSecurityFindingsConsumer) processMessage(ctx context.Context, msg *azservicebus.ReceivedMessage) error {
	// Event Grid delivers alerts as an array of events.
	var events []struct {
		EventType string    `json:"eventType"`
		EventTime time.Time `json:"eventTime"`
		ID        string    `json:"id"`
		Data      struct {
			Alert struct {
				AlertDisplayName  string            `json:"AlertDisplayName"`
				AlertSeverity     string            `json:"AlertSeverity"`
				Description       string            `json:"Description"`
				CompromisedEntity string            `json:"CompromisedEntity"`
				AlertType         string            `json:"AlertType"`
				ExtendedProperties map[string]string `json:"ExtendedProperties"`
				Entities          []struct {
					Type       string `json:"Type"`
					ResourceID string `json:"ResourceId"`
				} `json:"Entities"`
			} `json:"Alert"`
			// Assessment events have a different payload shape
			Assessment struct {
				DisplayName string `json:"displayName"`
				Status      struct {
					Code        string `json:"code"` // "Healthy" | "Unhealthy" | "NotApplicable"
					Description string `json:"description"`
					Severity    string `json:"severity"`
				} `json:"status"`
				ResourceDetails struct {
					ID     string `json:"id"`
					Source string `json:"source"`
				} `json:"resourceDetails"`
			} `json:"Assessment"`
		} `json:"data"`
	}

	if err := json.Unmarshal(msg.Body, &events); err != nil {
		return fmt.Errorf("unmarshalling Event Grid events: %w", err)
	}

	for _, ev := range events {
		var finding NormalisedFinding

		switch ev.EventType {
		case "Microsoft.Security.AlertCreated":
			alert := ev.Data.Alert
			// Only process Medium and High severity alerts.
			if alert.AlertSeverity != "High" && alert.AlertSeverity != "Medium" {
				continue
			}
			resourceID := ""
			for _, e := range alert.Entities {
				if e.Type == "azure-resource" {
					resourceID = e.ResourceID
					break
				}
			}
			finding = NormalisedFinding{
				FindingID:    ev.ID,
				Cloud:        "azure",
				ResourceARN:  resourceID,
				Severity:     strings.ToLower(alert.AlertSeverity),
				Title:        alert.AlertDisplayName,
				Description:  alert.Description,
				FindingType:  "threat",
				Status:       "active",
				RawPayload:   string(msg.Body),
				ReceivedAt:   ev.EventTime,
			}

		case "Microsoft.Security.AssessmentStatusChanged":
			assessment := ev.Data.Assessment
			if assessment.Status.Code != "Unhealthy" {
				continue
			}
			finding = NormalisedFinding{
				FindingID:    ev.ID,
				Cloud:        "azure",
				ResourceARN:  assessment.ResourceDetails.ID,
				Severity:     strings.ToLower(assessment.Status.Severity),
				Title:        assessment.DisplayName,
				Description:  assessment.Status.Description,
				FindingType:  "misconfiguration",
				Status:       "active",
				RawPayload:   string(msg.Body),
				ReceivedAt:   ev.EventTime,
			}

		default:
			continue
		}

		_, err := c.temporal.ExecuteWorkflow(ctx, client.StartWorkflowOptions{
			ID:        "security-finding-azure-" + sanitizeID(ev.ID),
			TaskQueue: "security-findings",
			WorkflowIDReusePolicy: client.WORKFLOW_ID_REUSE_POLICY_ALLOW_DUPLICATE_FAILED_ONLY,
		}, SecurityFindingWorkflow, finding)
		if err != nil {
			return err
		}
	}
	return nil
}

// sanitizeID replaces characters not valid in Temporal workflow IDs.
func sanitizeID(id string) string {
	r := strings.NewReplacer("/", "-", ":", "-", " ", "-")
	s := r.Replace(id)
	if len(s) > 200 {
		return s[:200]
	}
	return s
}
