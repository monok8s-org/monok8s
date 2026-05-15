package iamwriteback

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"

	"cloud.google.com/go/pubsub"
	"go.temporal.io/sdk/client"
)

// GCPPubSubConsumer receives Cloud Audit Log messages from the Pub/Sub subscription
// and starts an IAMWritebackWorkflow for each GCP IAM role binding change.
type GCPPubSubConsumer struct {
	sub                     *pubsub.Subscription
	temporal                client.Client
	crossplaneSAEmail       string // Crossplane service account email (idempotency fence)
}

// gcpAuditLogEntry is the Pub/Sub message payload shape for Cloud Audit Log sinks.
type gcpAuditLogEntry struct {
	ProtoPayload struct {
		AuthenticationInfo struct {
			PrincipalEmail string `json:"principalEmail"`
		} `json:"authenticationInfo"`
		MethodName string `json:"methodName"`
		// For SetIamPolicy calls:
		ServiceData struct {
			PolicyDelta struct {
				BindingDeltas []struct {
					Action  string `json:"action"` // "ADD" | "REMOVE"
					Role    string `json:"role"`   // "projects/<p>/roles/monok8s_admin_<tid>"
					Member  string `json:"member"` // "user:..." | "serviceAccount:..."
				} `json:"bindingDeltas"`
			} `json:"policyDelta"`
		} `json:"serviceData"`
		ResourceName string `json:"resourceName"`
	} `json:"protoPayload"`
	Resource struct {
		Labels map[string]string `json:"labels"`
	} `json:"resource"`
	InsertID string `json:"insertId"` // used as message ID for dedup
}

func (c *GCPPubSubConsumer) Poll(ctx context.Context) error {
	return c.sub.Receive(ctx, func(ctx context.Context, msg *pubsub.Message) {
		var entry gcpAuditLogEntry
		if err := json.Unmarshal(msg.Data, &entry); err != nil {
			slog.Warn("skipping unparseable Pub/Sub message", "msgId", msg.ID, "error", err)
			msg.Ack()
			return
		}

		events, skipReason, err := c.parseAndTranslate(entry, string(msg.Data))
		if err != nil {
			slog.Warn("skipping message", "msgId", msg.ID, "error", err)
			msg.Ack()
			return
		}
		if skipReason != "" {
			slog.Debug("skipping message", "msgId", msg.ID, "reason", skipReason)
			msg.Ack()
			return
		}

		for _, event := range events {
			event.MessageID = entry.InsertID
			_, err := c.temporal.ExecuteWorkflow(ctx,
				client.StartWorkflowOptions{
					ID:        "iam-writeback-gcp-" + event.MessageID + "-" + event.Role,
					TaskQueue: "iam-writeback",
				},
				IAMWritebackWorkflow,
				event,
			)
			if err != nil {
				slog.Error("failed to start IAMWritebackWorkflow", "error", err)
				msg.Nack()
				return
			}
		}

		msg.Ack()
	})
}

func (c *GCPPubSubConsumer) parseAndTranslate(entry gcpAuditLogEntry, raw string) ([]CloudRoleEvent, string, error) {
	// Idempotency fence: skip changes made by the Crossplane service account.
	if entry.ProtoPayload.AuthenticationInfo.PrincipalEmail == c.crossplaneSAEmail {
		return nil, "originated-by-crossplane", nil
	}

	// Only process SetIamPolicy calls.
	if !strings.HasSuffix(entry.ProtoPayload.MethodName, ".setIamPolicy") {
		return nil, fmt.Sprintf("unhandled method %s", entry.ProtoPayload.MethodName), nil
	}

	var events []CloudRoleEvent
	for _, delta := range entry.ProtoPayload.ServiceData.PolicyDelta.BindingDeltas {
		// Only process monok8s custom roles.
		roleParts := strings.Split(delta.Role, "/")
		roleID := roleParts[len(roleParts)-1] // last segment is the role ID
		role, err := ExtractRoleFromGCPCustomRole(roleID)
		if err != nil {
			// Not a monok8s role binding change — skip this delta.
			continue
		}

		// Tenant ID from resource label.
		tenantID, err := ExtractTenantIDFromGCPBucketLabel(entry.Resource.Labels)
		if err != nil {
			return nil, "", fmt.Errorf("cannot extract tenant ID: %w", err)
		}

		// Member format: "user:alice@example.com" or "serviceAccount:sa@project.iam.gserviceaccount.com"
		memberParts := strings.SplitN(delta.Member, ":", 2)
		if len(memberParts) != 2 {
			continue
		}
		subjectType := "user"
		if memberParts[0] == "serviceAccount" {
			subjectType = "service_account"
		}
		// memberParts[1] is the email; resolve to monok8s UUID via Zitadel SCIM mapping.
		subjectID := memberParts[1] // TODO: resolve to monok8s UUID

		var eventType string
		switch delta.Action {
		case "ADD":
			eventType = "assigned"
		case "REMOVE":
			eventType = "revoked"
		default:
			continue
		}

		events = append(events, CloudRoleEvent{
			Cloud:       "gcp",
			EventType:   eventType,
			TenantID:    tenantID,
			SubjectID:   subjectID,
			SubjectType: subjectType,
			Role:        role,
			RawEvent:    raw,
		})
	}

	if len(events) == 0 {
		return nil, "no monok8s role deltas in policy change", nil
	}
	return events, "", nil
}
