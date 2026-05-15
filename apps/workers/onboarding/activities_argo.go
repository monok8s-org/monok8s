package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"time"

	"github.com/nats-io/nats.go"
	"go.temporal.io/sdk/activity"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

// argoNamespace is where the Argo Workflows controller watches for
// Workflow CRs. Hardcoded by upstream bootstrap.yaml + platform/argocd
// wiring.
const argoNamespace = "argo"

// natsHeartbeatInterval is the cadence at which the NATS-wait path
// records Temporal heartbeats while blocked on a callback. The
// per-iteration NextMsg timeout doubles as the heartbeat tick — when
// the timeout fires we heartbeat and loop.
var natsHeartbeatInterval = 10 * time.Second

// argoWaitTimeout caps how long the activity will block on the NATS
// callback. Temporal's StartToCloseTimeout bounds this externally too;
// this in-activity guard exists so the error message names the
// callback subject (Temporal would only surface a bare timeout).
var argoWaitTimeout = 30 * time.Minute

// workflowGVR is the argoproj.io/v1alpha1 Workflow resource — the CR
// the Argo Workflows controller watches. NOT workflowtemplates (those
// are referenced from a Workflow via spec.workflowTemplateRef).
var workflowGVR = schema.GroupVersionResource{
	Group:    "argoproj.io",
	Version:  "v1alpha1",
	Resource: "workflows",
}

// MintTenantVaultKeyActivity submits the mint-tenant-vault-key
// WorkflowTemplate and blocks until its onExit step publishes a phase
// string on `workflow.tenant.<tid>.mint-vault-key`. Per #84 AC step 3
// / Discussion #76.
func MintTenantVaultKeyActivity(ctx context.Context, tenantID string) error {
	if tenantID == "" {
		return errors.New("MintTenantVaultKeyActivity: tenantID empty")
	}
	return submitArgoWorkflowAndWait(
		ctx, tenantID,
		"mint-tenant-vault-key",
		"mint-vault-key-"+tenantID+"-",
		fmt.Sprintf("workflow.tenant.%s.mint-vault-key", tenantID),
	)
}

// RunMigrationsActivity submits the apply-tenant-migrations
// WorkflowTemplate and blocks until its onExit step publishes a phase
// string on `workflow.tenant.<tid>.migrations`. Per #84 AC step 4 /
// Discussion #76.
func RunMigrationsActivity(ctx context.Context, tenantID string) error {
	if tenantID == "" {
		return errors.New("RunMigrationsActivity: tenantID empty")
	}
	return submitArgoWorkflowAndWait(
		ctx, tenantID,
		"apply-tenant-migrations",
		"apply-migrations-"+tenantID+"-",
		fmt.Sprintf("workflow.tenant.%s.migrations", tenantID),
	)
}

// submitArgoWorkflowAndWait creates a Workflow CR in the argo namespace
// referencing the named WorkflowTemplate, then blocks on the given
// NATS subject until the onExit step publishes the Argo phase string.
//
// The wait loop uses SubscribeSync + NextMsg with natsHeartbeatInterval
// as the per-iteration timeout — every tick we either get the message
// and return, or we record a Temporal heartbeat and loop. Both the
// outer argoWaitTimeout and ctx.Done() can terminate early.
//
// The subscriber is established BEFORE the submit so we don't lose a
// fast-completing workflow's callback. NATS core (non-JetStream) drops
// messages with no subscriber — a JetStream upgrade for at-least-once
// delivery is tracked as a sub-PR-5+ follow-up.
func submitArgoWorkflowAndWait(
	ctx context.Context,
	tenantID, templateName, generateNamePrefix, natsSubject string,
) error {
	logger := activity.GetLogger(ctx)

	// 1. NATS subscriber FIRST.
	url := os.Getenv("NATS_URL")
	if url == "" {
		url = DefaultNATSURL
	}
	nc, err := nats.Connect(url, nats.Timeout(5*time.Second))
	if err != nil {
		return fmt.Errorf("nats connect: %w", err)
	}
	defer nc.Close()

	sub, err := nc.SubscribeSync(natsSubject)
	if err != nil {
		return fmt.Errorf("nats subscribe %s: %w", natsSubject, err)
	}
	defer func() { _ = sub.Unsubscribe() }()
	// Flush so the subscribe interest has reached the server before
	// we submit the Workflow CR.
	if err := nc.Flush(); err != nil {
		return fmt.Errorf("nats flush: %w", err)
	}

	// 2. Submit Workflow CR via the same dynamic client used for XRs
	// in activities_xr.go.
	client, err := dynamicClientFactory()
	if err != nil {
		return err
	}
	wf := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "argoproj.io/v1alpha1",
		"kind":       "Workflow",
		"metadata": map[string]any{
			"generateName": generateNamePrefix,
			"namespace":    argoNamespace,
		},
		"spec": map[string]any{
			"workflowTemplateRef": map[string]any{"name": templateName},
			"arguments": map[string]any{
				"parameters": []any{
					map[string]any{"name": "tenantId", "value": tenantID},
				},
			},
		},
	}}
	created, err := client.Resource(workflowGVR).Namespace(argoNamespace).
		Create(ctx, wf, metav1.CreateOptions{FieldManager: fieldManager})
	if err != nil {
		return fmt.Errorf("submit Workflow %s: %w", templateName, err)
	}
	logger.Info("Argo Workflow submitted",
		"template", templateName,
		"name", created.GetName(),
		"subject", natsSubject)

	// 3. Block on the callback subject. Heartbeat per iteration.
	deadline := time.Now().Add(argoWaitTimeout)
	for {
		if time.Now().After(deadline) {
			return fmt.Errorf("submitArgoWorkflowAndWait: timed out waiting on %s", natsSubject)
		}
		msg, err := sub.NextMsg(natsHeartbeatInterval)
		if errors.Is(err, nats.ErrTimeout) {
			activity.RecordHeartbeat(ctx, map[string]any{
				"phase":   "waiting-for-argo-callback",
				"subject": natsSubject,
			})
			if ctx.Err() != nil {
				return ctx.Err()
			}
			continue
		}
		if err != nil {
			return fmt.Errorf("nats next-msg: %w", err)
		}
		phase := string(msg.Data)
		logger.Info("Argo Workflow callback received",
			"subject", natsSubject, "phase", phase)
		if phase == "Succeeded" {
			return nil
		}
		return fmt.Errorf("Argo Workflow %s ended with phase %q", templateName, phase)
	}
}
