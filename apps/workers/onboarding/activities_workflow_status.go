package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"time"

	"github.com/nats-io/nats.go"
	"go.temporal.io/sdk/activity"
)

// WorkflowStatusEvent is the JSON envelope published on
// `workflow.<wid>.status` by EmitWorkflowStatusActivity (#177 / #88b).
//
// The envelope's shape is forward-compatible with the future
// tenant-built-workflows surface: `WorkflowType` lets platform
// workflows ("monok8s.onboarding") and tenant-defined workflows share
// one subscriber surface; `Step` carries the Pedestal-interceptor-shaped
// sub-unit name so step-level live progress is wire-compatible from
// day one.
//
// Discriminator: `Scope` selects the variant.
//
//	scope=workflow → workflow-lifecycle event (started / succeeded / failed / cancelled)
//	scope=step     → step-lifecycle event (started / succeeded / failed)
//
// The Step field is required when Scope=="step" and elided otherwise
// (omitempty). Error is populated only on failure phases.
//
// Consumed by the apps/api `events.workflow` tRPC subscription
// landed alongside this activity in #177.
type WorkflowStatusEvent struct {
	Scope        string `json:"scope"`
	WorkflowID   string `json:"workflowId"`
	WorkflowType string `json:"workflowType"`
	TenantID     string `json:"tenantId"`
	Step         string `json:"step,omitempty"`
	Phase        string `json:"phase"`
	Timestamp    string `json:"timestamp"`
	Error        string `json:"error,omitempty"`
}

// EmitWorkflowStatusActivity publishes a workflow- or step-lifecycle
// event on NATS subject `workflow.<WorkflowID>.status`. The workflow
// drives the call sites (see workflow.go's per-phase wiring).
//
// Resolution + lifecycle: identical to EmitTenantCreatedEventActivity
// (NATS_URL env var override; per-call dial → publish → flush → close).
//
// Errors: dial / publish / flush failures propagate; Temporal retries
// per the workflow's ActivityOptions. Validation up front (empty
// WorkflowID / WorkflowType / TenantID / Scope / Phase) fails fast.
func EmitWorkflowStatusActivity(ctx context.Context, event WorkflowStatusEvent) error {
	if event.WorkflowID == "" {
		return errors.New("EmitWorkflowStatusActivity: WorkflowID empty")
	}
	if event.WorkflowType == "" {
		return errors.New("EmitWorkflowStatusActivity: WorkflowType empty")
	}
	if event.TenantID == "" {
		return errors.New("EmitWorkflowStatusActivity: TenantID empty")
	}
	if event.Scope != "workflow" && event.Scope != "step" {
		return errors.New(`EmitWorkflowStatusActivity: Scope must be "workflow" or "step"`)
	}
	if event.Scope == "step" && event.Step == "" {
		return errors.New("EmitWorkflowStatusActivity: Step required when Scope=step")
	}
	if event.Phase == "" {
		return errors.New("EmitWorkflowStatusActivity: Phase empty")
	}

	url := os.Getenv("NATS_URL")
	if url == "" {
		url = DefaultNATSURL
	}

	logger := activity.GetLogger(ctx)
	logger.Info("EmitWorkflowStatusActivity: dialing NATS",
		"url", url,
		"workflowID", event.WorkflowID,
		"scope", event.Scope,
		"phase", event.Phase,
		"step", event.Step,
	)

	nc, err := nats.Connect(url, nats.Timeout(5*time.Second))
	if err != nil {
		return err
	}
	defer nc.Close()

	body, err := json.Marshal(event)
	if err != nil {
		return err
	}

	subject := "workflow." + event.WorkflowID + ".status"
	if err := nc.Publish(subject, body); err != nil {
		return err
	}
	if err := nc.Flush(); err != nil {
		return err
	}
	return nc.LastError()
}
