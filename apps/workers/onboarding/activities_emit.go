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

// DefaultNATSURL is the in-cluster service DNS for the NATS install
// at platform/nats/ (per #78). Activities override via NATS_URL env
// var when running in test contexts (in-process server) or alternate
// deployments.
const DefaultNATSURL = "nats://nats.nats.svc.cluster.local:4222"

// tenantEvent is the JSON envelope published on `tenant.<tid>.events`
// by EmitTenantCreatedEventActivity (event="tenant.created") and
// EmitTenantCreationFailedEventActivity (event="tenant.creation-failed").
// Consumed by the UI / CLI live-tail subscriptions wired in Tier-2 #88.
type tenantEvent struct {
	TenantID  string `json:"tenantId"`
	Event     string `json:"event"`
	Timestamp string `json:"timestamp"`
}

// EmitTenantCreatedEventActivity publishes the `tenant.created` event
// on NATS subject `tenant.<tenantID>.events`. This is the final step
// (#5) of OnboardTenantWorkflow per #84's AC.
//
// Resolution: NATS_URL env var (default DefaultNATSURL).
// Lifecycle: dial → publish → flush → close. Connection is per-call
// (not pooled) because Temporal retries are infrequent in the
// happy-path flow; a pooled connection adds lifecycle complexity
// without meaningful win at the workflow's tick rate.
//
// Errors: any dial / publish / flush failure propagates as the
// activity's return; Temporal retries per the workflow's
// ActivityOptions.RetryPolicy. tenantID validation is performed up
// front so empty inputs fail fast (non-retriable).
func EmitTenantCreatedEventActivity(ctx context.Context, tenantID string) error {
	if tenantID == "" {
		return errors.New("EmitTenantCreatedEventActivity: tenantID empty")
	}

	url := os.Getenv("NATS_URL")
	if url == "" {
		url = DefaultNATSURL
	}

	logger := activity.GetLogger(ctx)
	logger.Info("EmitTenantCreatedEventActivity: dialing NATS",
		"url", url, "tenantID", tenantID)

	nc, err := nats.Connect(url, nats.Timeout(5*time.Second))
	if err != nil {
		return err
	}
	defer nc.Close()

	body, err := json.Marshal(tenantEvent{
		TenantID:  tenantID,
		Event:     "tenant.created",
		Timestamp: time.Now().UTC().Format(time.RFC3339Nano),
	})
	if err != nil {
		return err
	}

	subject := "tenant." + tenantID + ".events"
	if err := nc.Publish(subject, body); err != nil {
		return err
	}
	if err := nc.Flush(); err != nil {
		return err
	}
	return nc.LastError()
}
