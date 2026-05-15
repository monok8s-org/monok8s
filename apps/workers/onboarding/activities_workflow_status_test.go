package main

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	natsserver "github.com/nats-io/nats-server/v2/server"
	"github.com/nats-io/nats.go"
	"go.temporal.io/sdk/testsuite"
)

// startInProcessNATSForWorkflow spins up a hermetic nats-server on an
// auto-assigned port for the test's lifetime. Duplicated locally
// instead of importing from activities_emit_test.go because each
// Bazel go_test target is its own compile unit.
func startInProcessNATSForWorkflow(t *testing.T) (string, func()) {
	t.Helper()
	opts := &natsserver.Options{
		Host:           "127.0.0.1",
		Port:           -1,
		NoLog:          true,
		NoSigs:         true,
		MaxControlLine: 4096,
	}
	s, err := natsserver.NewServer(opts)
	if err != nil {
		t.Fatalf("nats-server NewServer: %v", err)
	}
	go s.Start()
	if !s.ReadyForConnections(5 * time.Second) {
		s.Shutdown()
		t.Fatal("nats-server: not ready after 5s")
	}
	return s.ClientURL(), s.Shutdown
}

// TestEmitWorkflowStatusActivity_PublishesWorkflowLifecycle drives the
// activity with a scope=workflow event and asserts the canonical
// subject + envelope shape (#177 / #88b).
func TestEmitWorkflowStatusActivity_PublishesWorkflowLifecycle(t *testing.T) {
	url, shutdown := startInProcessNATSForWorkflow(t)
	defer shutdown()

	const wid = "tnt-11111111-2222-3333-4444-555555555555-onboard-abc"

	sub, err := nats.Connect(url, nats.Timeout(2*time.Second))
	if err != nil {
		t.Fatalf("subscriber nats.Connect: %v", err)
	}
	defer sub.Close()
	msgCh := make(chan *nats.Msg, 1)
	if _, err := sub.Subscribe("workflow."+wid+".status", func(m *nats.Msg) {
		msgCh <- m
	}); err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	if err := sub.Flush(); err != nil {
		t.Fatalf("subscriber flush: %v", err)
	}

	t.Setenv("NATS_URL", url)
	suite := &testsuite.WorkflowTestSuite{}
	env := suite.NewTestActivityEnvironment()
	env.RegisterActivity(EmitWorkflowStatusActivity)

	event := WorkflowStatusEvent{
		Scope:        "workflow",
		WorkflowID:   wid,
		WorkflowType: "monok8s.onboarding",
		TenantID:     "11111111-2222-3333-4444-555555555555",
		Phase:        "started",
		Timestamp:    "2026-05-13T12:00:00.000000000Z",
	}
	if _, err := env.ExecuteActivity(EmitWorkflowStatusActivity, event); err != nil {
		t.Fatalf("ExecuteActivity: %v", err)
	}

	select {
	case msg := <-msgCh:
		var got WorkflowStatusEvent
		if err := json.Unmarshal(msg.Data, &got); err != nil {
			t.Fatalf("unmarshal event: %v", err)
		}
		if got.Scope != "workflow" {
			t.Errorf("scope: got %q, want %q", got.Scope, "workflow")
		}
		if got.WorkflowID != wid {
			t.Errorf("workflowId: got %q, want %q", got.WorkflowID, wid)
		}
		if got.WorkflowType != "monok8s.onboarding" {
			t.Errorf("workflowType: got %q", got.WorkflowType)
		}
		if got.Phase != "started" {
			t.Errorf("phase: got %q", got.Phase)
		}
		// Scope=workflow events omit Step entirely.
		if got.Step != "" {
			t.Errorf("step should be omitted for scope=workflow, got %q", got.Step)
		}
		if msg.Subject != "workflow."+wid+".status" {
			t.Errorf("subject: got %q", msg.Subject)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for workflow-lifecycle event")
	}
}

// TestEmitWorkflowStatusActivity_PublishesStepLifecycle drives the
// activity with a scope=step event and asserts the Step field is
// present + carries the Pedestal-interceptor-shaped step name.
func TestEmitWorkflowStatusActivity_PublishesStepLifecycle(t *testing.T) {
	url, shutdown := startInProcessNATSForWorkflow(t)
	defer shutdown()

	const wid = "tnt-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee-onboard-step-test"

	sub, err := nats.Connect(url, nats.Timeout(2*time.Second))
	if err != nil {
		t.Fatalf("subscriber nats.Connect: %v", err)
	}
	defer sub.Close()
	msgCh := make(chan *nats.Msg, 1)
	if _, err := sub.Subscribe("workflow."+wid+".status", func(m *nats.Msg) {
		msgCh <- m
	}); err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	if err := sub.Flush(); err != nil {
		t.Fatalf("subscriber flush: %v", err)
	}

	t.Setenv("NATS_URL", url)
	suite := &testsuite.WorkflowTestSuite{}
	env := suite.NewTestActivityEnvironment()
	env.RegisterActivity(EmitWorkflowStatusActivity)

	event := WorkflowStatusEvent{
		Scope:        "step",
		WorkflowID:   wid,
		WorkflowType: "monok8s.onboarding",
		TenantID:     "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
		Step:         "provision_namespace",
		Phase:        "succeeded",
		Timestamp:    "2026-05-13T12:00:01.000000000Z",
	}
	if _, err := env.ExecuteActivity(EmitWorkflowStatusActivity, event); err != nil {
		t.Fatalf("ExecuteActivity: %v", err)
	}

	select {
	case msg := <-msgCh:
		var got WorkflowStatusEvent
		if err := json.Unmarshal(msg.Data, &got); err != nil {
			t.Fatalf("unmarshal event: %v", err)
		}
		if got.Scope != "step" {
			t.Errorf("scope: got %q, want %q", got.Scope, "step")
		}
		if got.Step != "provision_namespace" {
			t.Errorf("step: got %q", got.Step)
		}
		if got.Phase != "succeeded" {
			t.Errorf("phase: got %q", got.Phase)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for step-lifecycle event")
	}
}

// TestEmitWorkflowStatusActivity_ValidationErrors covers the up-front
// guards: empty WorkflowID / empty Scope / missing Step when scope=step.
// All three are non-retriable input errors that fail before any NATS
// dial attempt.
func TestEmitWorkflowStatusActivity_ValidationErrors(t *testing.T) {
	cases := []struct {
		name  string
		event WorkflowStatusEvent
	}{
		{
			name: "empty WorkflowID",
			event: WorkflowStatusEvent{
				Scope: "workflow", WorkflowType: "monok8s.onboarding",
				TenantID: "t", Phase: "started",
			},
		},
		{
			name: "empty TenantID",
			event: WorkflowStatusEvent{
				Scope: "workflow", WorkflowID: "tnt-x-y", WorkflowType: "monok8s.onboarding",
				Phase: "started",
			},
		},
		{
			name: "step scope missing Step",
			event: WorkflowStatusEvent{
				Scope: "step", WorkflowID: "tnt-x-y", WorkflowType: "monok8s.onboarding",
				TenantID: "t", Phase: "started",
			},
		},
		{
			name: "invalid scope",
			event: WorkflowStatusEvent{
				Scope: "bogus", WorkflowID: "tnt-x-y", WorkflowType: "monok8s.onboarding",
				TenantID: "t", Phase: "started",
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := EmitWorkflowStatusActivity(context.Background(), tc.event); err == nil {
				t.Fatal("got nil error, want validation failure")
			}
		})
	}
}
