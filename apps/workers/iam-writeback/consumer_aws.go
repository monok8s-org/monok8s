package iamwriteback

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"

	"github.com/aws/aws-sdk-go-v2/service/sqs"
	"go.temporal.io/sdk/client"
)

// AWSSQSConsumer polls the SQS queue and starts an IAMWritebackWorkflow for
// each EventBridge event representing an IAM Identity Center role assignment change.
type AWSSQSConsumer struct {
	sqs       *sqs.Client
	temporal  client.Client
	queueURL  string
	crossplaneRolePrefix string // IRSA role prefix to filter (idempotency fence)
}

// iamIdentityCenterEvent is the EventBridge event shape for SSO account assignments.
type iamIdentityCenterEvent struct {
	Detail struct {
		EventName    string `json:"eventName"`
		UserIdentity struct {
			SessionContext struct {
				SessionIssuer struct {
					UserName string `json:"userName"` // IAM role name used by the caller
				} `json:"sessionIssuer"`
			} `json:"sessionContext"`
		} `json:"userIdentity"`
		RequestParameters struct {
			PermissionSetArn string `json:"permissionSetArn"`
			PrincipalType    string `json:"principalType"` // "USER" | "GROUP"
			PrincipalId      string `json:"principalId"`   // Identity Store user/group ID
			TargetId         string `json:"targetId"`      // AWS account ID
		} `json:"requestParameters"`
		// Account tags are fetched separately; stored in the account's tag map.
	} `json:"detail"`
	DetailType string `json:"detail-type"`
	ID         string `json:"id"`
}

func (c *AWSSQSConsumer) Poll(ctx context.Context) error {
	for {
		select {
		case <-ctx.Done():
			return nil
		default:
		}

		out, err := c.sqs.ReceiveMessage(ctx, &sqs.ReceiveMessageInput{
			QueueUrl:            &c.queueURL,
			MaxNumberOfMessages: 10,
			WaitTimeSeconds:     20, // long poll
		})
		if err != nil {
			slog.Error("SQS receive failed", "error", err)
			continue
		}

		for _, msg := range out.Messages {
			event, skipReason, err := c.parseAndTranslate(*msg.Body)
			if err != nil {
				slog.Warn("skipping unparseable SQS message", "msgId", *msg.MessageId, "error", err)
				c.deleteMessage(ctx, msg.ReceiptHandle)
				continue
			}
			if skipReason != "" {
				slog.Debug("skipping message", "msgId", *msg.MessageId, "reason", skipReason)
				c.deleteMessage(ctx, msg.ReceiptHandle)
				continue
			}

			event.MessageID = *msg.MessageId
			_, err = c.temporal.ExecuteWorkflow(ctx,
				client.StartWorkflowOptions{
					ID:        "iam-writeback-aws-" + event.MessageID,
					TaskQueue: "iam-writeback",
				},
				IAMWritebackWorkflow,
				*event,
			)
			if err != nil {
				slog.Error("failed to start IAMWritebackWorkflow", "error", err)
				// Don't delete — will retry on next poll
				continue
			}

			c.deleteMessage(ctx, msg.ReceiptHandle)
		}
	}
}

func (c *AWSSQSConsumer) parseAndTranslate(body string) (*CloudRoleEvent, string, error) {
	var raw iamIdentityCenterEvent
	if err := json.Unmarshal([]byte(body), &raw); err != nil {
		return nil, "", fmt.Errorf("json unmarshal: %w", err)
	}

	// Idempotency fence: skip events from the Crossplane IRSA role.
	callerRole := raw.Detail.UserIdentity.SessionContext.SessionIssuer.UserName
	if len(c.crossplaneRolePrefix) > 0 && len(callerRole) >= len(c.crossplaneRolePrefix) &&
		callerRole[:len(c.crossplaneRolePrefix)] == c.crossplaneRolePrefix {
		return nil, "originated-by-crossplane", nil
	}

	var eventType string
	switch raw.Detail.EventName {
	case "CreateAccountAssignment":
		eventType = "assigned"
	case "DeleteAccountAssignment":
		eventType = "revoked"
	default:
		return nil, fmt.Sprintf("unhandled event %s", raw.Detail.EventName), nil
	}

	// Extract monok8s role from permission set ARN suffix.
	// ARN format: arn:aws:sso:::permissionSet/ssoins-xxx/ps-xxx
	// Permission set name is not in the ARN — a lookup is needed in production.
	// Here we rely on the permission set being tagged with monok8s-role=<role>.
	// For brevity, role extraction from the ARN is stubbed.
	role := "member" // TODO: look up permission set name via SSO API and call ExtractRoleFromAWSPermissionSet

	// Principal is an Identity Store user or group ID; resolve to monok8s UUID
	// via the Zitadel SCIM external ID mapping stored in user_snapshots.zitadel_id.
	subjectID := raw.Detail.RequestParameters.PrincipalId // TODO: resolve to monok8s UUID
	subjectType := "user"
	if raw.Detail.RequestParameters.PrincipalType == "GROUP" {
		subjectType = "service_account" // groups map to SA roles in monok8s
	}

	// Tenant ID comes from the AWS account tag.
	tenantID := "" // TODO: fetch account tags from AWS Organizations and call ExtractTenantIDFromAWSAccountTag

	return &CloudRoleEvent{
		Cloud:       "aws",
		EventType:   eventType,
		TenantID:    tenantID,
		SubjectID:   subjectID,
		SubjectType: subjectType,
		Role:        role,
		RawEvent:    body,
		OriginatedByMonok8s: callerRole == c.crossplaneRolePrefix,
	}, "", nil
}

func (c *AWSSQSConsumer) deleteMessage(ctx context.Context, receiptHandle *string) {
	_, err := c.sqs.DeleteMessage(ctx, &sqs.DeleteMessageInput{
		QueueUrl:      &c.queueURL,
		ReceiptHandle: receiptHandle,
	})
	if err != nil {
		slog.Error("SQS delete failed", "error", err)
	}
}
