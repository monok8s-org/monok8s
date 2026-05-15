package iamwriteback

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"

	"github.com/Azure/azure-sdk-for-go/sdk/messaging/azservicebus"
	"go.temporal.io/sdk/client"
)

// AzureServiceBusConsumer receives Event Grid messages from the Service Bus queue
// and starts an IAMWritebackWorkflow for each Entra ID app role assignment change.
type AzureServiceBusConsumer struct {
	receiver           *azservicebus.Receiver
	temporal           client.Client
	crossplanePrincipalID string // managed identity object ID (idempotency fence)
	appID              string   // monok8s Enterprise Application app ID
}

// azureRoleAssignmentEvent is the Event Grid event shape for role assignment writes.
type azureRoleAssignmentEvent struct {
	ID   string `json:"id"`
	Data struct {
		Authorization struct {
			Action string `json:"action"` // "Microsoft.Authorization/roleAssignments/write" etc
			Scope  string `json:"scope"`
		} `json:"authorization"`
		Claims struct {
			AppID string `json:"appid"` // caller's app ID (for idempotency fence)
			OID   string `json:"oid"`   // caller's object ID
		} `json:"claims"`
		OperationName string `json:"operationName"`
		Status        struct {
			Value string `json:"value"` // "Succeeded"
		} `json:"status"`
		ResourceProvider string `json:"resourceProvider"`
		// Properties contains the role assignment details
		Properties json.RawMessage `json:"properties"`
	} `json:"data"`
	EventType string `json:"eventType"` // "Microsoft.Authorization.RoleAssignmentCreated" etc
}

type azureRoleAssignmentProperties struct {
	RoleDefinitionID string `json:"roleDefinitionId"`
	PrincipalID      string `json:"principalId"` // Entra object ID of assignee
	PrincipalType    string `json:"principalType"` // "User" | "Group" | "ServicePrincipal"
	// Scope includes the resource group / resource
}

func (c *AzureServiceBusConsumer) Poll(ctx context.Context) error {
	for {
		select {
		case <-ctx.Done():
			return nil
		default:
		}

		msgs, err := c.receiver.ReceiveMessages(ctx, 10, nil)
		if err != nil {
			slog.Error("Service Bus receive failed", "error", err)
			continue
		}

		for _, msg := range msgs {
			body := string(msg.Body)
			event, skipReason, err := c.parseAndTranslate(body)
			if err != nil {
				slog.Warn("skipping unparseable Service Bus message", "msgId", msg.MessageID, "error", err)
				_ = c.receiver.CompleteMessage(ctx, msg, nil)
				continue
			}
			if skipReason != "" {
				slog.Debug("skipping message", "msgId", msg.MessageID, "reason", skipReason)
				_ = c.receiver.CompleteMessage(ctx, msg, nil)
				continue
			}

			event.MessageID = msg.MessageID
			_, err = c.temporal.ExecuteWorkflow(ctx,
				client.StartWorkflowOptions{
					ID:        "iam-writeback-azure-" + event.MessageID,
					TaskQueue: "iam-writeback",
				},
				IAMWritebackWorkflow,
				*event,
			)
			if err != nil {
				slog.Error("failed to start IAMWritebackWorkflow", "error", err)
				// Abandon — will reappear after lock timeout
				_ = c.receiver.AbandonMessage(ctx, msg, nil)
				continue
			}

			_ = c.receiver.CompleteMessage(ctx, msg, nil)
		}
	}
}

func (c *AzureServiceBusConsumer) parseAndTranslate(body string) (*CloudRoleEvent, string, error) {
	var raw azureRoleAssignmentEvent
	if err := json.Unmarshal([]byte(body), &raw); err != nil {
		return nil, "", fmt.Errorf("json unmarshal: %w", err)
	}

	if raw.Data.Status.Value != "Succeeded" {
		return nil, "non-succeeded event", nil
	}

	// Idempotency fence: skip events from the Crossplane managed identity.
	if raw.Data.Claims.OID == c.crossplanePrincipalID {
		return nil, "originated-by-crossplane", nil
	}

	// Filter to app role assignments on the monok8s Enterprise Application only.
	if raw.Data.Claims.AppID != c.appID {
		return nil, "not a monok8s app role assignment", nil
	}

	var eventType string
	switch {
	case strings.Contains(raw.EventType, "Created"):
		eventType = "assigned"
	case strings.Contains(raw.EventType, "Deleted"):
		eventType = "revoked"
	default:
		return nil, fmt.Sprintf("unhandled event type %s", raw.EventType), nil
	}

	var props azureRoleAssignmentProperties
	if err := json.Unmarshal(raw.Data.Properties, &props); err != nil {
		return nil, "", fmt.Errorf("parse properties: %w", err)
	}

	// Role definition ID suffix encodes the app role value "monok8s:<role>".
	// In practice, look up the role definition to get its value.
	role := "member" // TODO: resolve props.RoleDefinitionID to app role value, then call ExtractRoleFromAzureAppRole

	// Group display name encodes tenant ID: "monok8s-<tenant_id>-<role>"
	tenantID := "" // TODO: look up Entra group display name from props.PrincipalID, then call ExtractTenantIDFromAzureGroupName

	subjectType := "user"
	if props.PrincipalType == "ServicePrincipal" {
		subjectType = "service_account"
	}

	// props.PrincipalID is an Entra object ID; resolve to monok8s UUID via
	// the Zitadel SCIM external ID mapping.
	subjectID := props.PrincipalID // TODO: resolve to monok8s UUID

	return &CloudRoleEvent{
		Cloud:       "azure",
		EventType:   eventType,
		TenantID:    tenantID,
		SubjectID:   subjectID,
		SubjectType: subjectType,
		Role:        role,
		RawEvent:    body,
		OriginatedByMonok8s: raw.Data.Claims.OID == c.crossplanePrincipalID,
	}, "", nil
}
