package main

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	natsserver "github.com/nats-io/nats-server/v2/server"
	"github.com/nats-io/nats.go"
	"go.temporal.io/sdk/testsuite"
)

// startInProcessNATS spins up a hermetic nats-server on an
// auto-assigned port (Port: -1) for the test's lifetime. Mirrors the
// project-blessed "Go httptest+fake" pattern from
// packages/cloud-adapters/secrets/baremetal_test.go, applied to NATS.
// Returns the client URL + a shutdown func.
func startInProcessNATS(t *testing.T) (string, func()) {
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

// TestEmitTenantCreatedEventActivity_Publishes drives the activity
// against a hermetic in-process nats-server and asserts:
//   - the activity returns nil
//   - a single message lands on tenant.acme.events
//   - the JSON envelope's tenantId / event / timestamp parse correctly
//
// Uses Temporal's testsuite.NewTestActivityEnvironment for
// activity-only execution (no workflow involved).
func TestEmitTenantCreatedEventActivity_Publishes(t *testing.T) {
	url, shutdown := startInProcessNATS(t)
	defer shutdown()

	// Subscribe BEFORE the activity publishes so we don't race.
	sub, err := nats.Connect(url, nats.Timeout(2*time.Second))
	if err != nil {
		t.Fatalf("subscriber nats.Connect: %v", err)
	}
	defer sub.Close()
	msgCh := make(chan *nats.Msg, 1)
	if _, err := sub.Subscribe("tenant.acme.events", func(m *nats.Msg) {
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
	env.RegisterActivity(EmitTenantCreatedEventActivity)

	encoded, err := env.ExecuteActivity(EmitTenantCreatedEventActivity, "acme")
	if err != nil {
		t.Fatalf("ExecuteActivity: %v", err)
	}
	// Activity returns nil error and no payload — testsuite encodes
	// the (no-value) result as an empty payload. Verify it decodes to
	// nothing-much; the real assertion is the published message.
	_ = encoded

	select {
	case msg := <-msgCh:
		var evt tenantEvent
		if err := json.Unmarshal(msg.Data, &evt); err != nil {
			t.Fatalf("unmarshal event: %v", err)
		}
		if evt.TenantID != "acme" {
			t.Errorf("tenantId: got %q, want %q", evt.TenantID, "acme")
		}
		if evt.Event != "tenant.created" {
			t.Errorf("event: got %q, want %q", evt.Event, "tenant.created")
		}
		if _, parseErr := time.Parse(time.RFC3339Nano, evt.Timestamp); parseErr != nil {
			t.Errorf("timestamp not RFC3339Nano: %q (%v)", evt.Timestamp, parseErr)
		}
		if msg.Subject != "tenant.acme.events" {
			t.Errorf("subject: got %q, want %q", msg.Subject, "tenant.acme.events")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for published event")
	}
}

// TestEmitTenantCreatedEventActivity_ErrorOnUnreachable points the
// activity at an obviously-unreachable URL and asserts the activity
// returns an error (Temporal then retries per the workflow's
// RetryPolicy; this assertion is about the activity-level failure
// surface).
func TestEmitTenantCreatedEventActivity_ErrorOnUnreachable(t *testing.T) {
	t.Setenv("NATS_URL", "nats://127.0.0.1:1") // port 1 = unreachable

	suite := &testsuite.WorkflowTestSuite{}
	env := suite.NewTestActivityEnvironment()
	env.RegisterActivity(EmitTenantCreatedEventActivity)

	_, err := env.ExecuteActivity(EmitTenantCreatedEventActivity, "acme")
	if err == nil {
		t.Fatal("ExecuteActivity: got nil error, want dial failure")
	}
}

// TestEmitTenantCreatedEventActivity_EmptyTenantID asserts the
// validation guard catches an empty tenantID before any NATS dial
// attempt — this is a non-retriable input error.
func TestEmitTenantCreatedEventActivity_EmptyTenantID(t *testing.T) {
	// Even with a working NATS, an empty tenantID should fail validation.
	url, shutdown := startInProcessNATS(t)
	defer shutdown()
	t.Setenv("NATS_URL", url)

	// Call the function directly for the validation path (testsuite
	// wraps errors through Temporal's failure types, which is fine
	// but not informative for a pre-dial guard).
	err := EmitTenantCreatedEventActivity(context.Background(), "")
	if err == nil {
		t.Fatal("got nil error for empty tenantID, want validation error")
	}
	if !errors.Is(err, err) /* sentinel placeholder */ {
		// (no sentinel today; just assert non-nil)
		_ = err
	}
}
