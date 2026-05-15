// Package itest hosts the L2 4-server integration test for
// OnboardTenantWorkflow (#129c). Drives the workflow end-to-end against
// real Temporal + Kubernetes (envtest) + NATS backends, with sidecar
// goroutines simulating Crossplane reconcile (status.ready patch) and
// Argo Workflows onExit (NATS callback publish).
//
// First codebase use of:
//   - dynamic.Interface.Watch() (informer-style API).
//   - Background-process sidecars in an L2 test (precedent only had
//     synchronous shell smoke).
//
// Captures the workflow history JSON to $TEST_UNDECLARED_OUTPUTS_DIR
// for downstream wiring into //apps/workers/onboarding:replay_test
// (closes #129b's Gap).
package itest

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/bazelbuild/rules_go/go/runfiles"
	"github.com/nats-io/nats.go"
	enumspb "go.temporal.io/api/enums/v1"
	"go.temporal.io/sdk/client"
	"google.golang.org/protobuf/encoding/protojson"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/watch"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/tools/clientcmd"
)

// GVRs for the resources the sidecars watch. Mirror activities_xr.go
// + activities_argo.go's definitions (these are vendored locally
// rather than imported because apps/workers/onboarding is package
// main, not importable from this test package).
var (
	xtenantGVR = schema.GroupVersionResource{
		Group: "monok8s.io", Version: "v1alpha1", Resource: "xtenants",
	}
	xtenantdatabaseGVR = schema.GroupVersionResource{
		Group: "monok8s.io", Version: "v1alpha1", Resource: "xtenantdatabases",
	}
	workflowGVR = schema.GroupVersionResource{
		Group: "argoproj.io", Version: "v1alpha1", Resource: "workflows",
	}
)

// tenantInputJSON mirrors apps/workers/onboarding.TenantInput's wire
// shape (Go's default struct-to-JSON encoding, no `json:` tags).
type tenantInputJSON struct {
	TenantID string
	Email    string
	Plan     string
}

// TestOnboardTenantWorkflow_L2 is the end-to-end integration test.
// itest_suite has already brought up k8s + nats + temporal and
// exported KUBECONFIG / NATS_URL / TEMPORAL_ADDR + native keys.
func TestOnboardTenantWorkflow_L2(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	temporalAddr := requireEnv(t, "TEMPORAL_ADDR")
	kubeconfig := requireEnv(t, "KUBECONFIG")
	natsURL := requireEnv(t, "NATS_URL")
	namespace := os.Getenv("KUBE_NAMESPACE")
	if namespace == "" {
		namespace = "default"
	}

	tc := mustTemporalClient(t, temporalAddr)
	defer tc.Close()

	dyn := mustDynamicClient(t, kubeconfig)
	nc := mustNATSConn(t, natsURL)
	defer nc.Close()

	// Sidecars run for the lifetime of the test; cancel(ctx) terminates them.
	go watchXRsAndPatchReady(ctx, t, dyn, namespace)
	go watchWorkflowsAndPublishNATS(ctx, t, dyn, nc)

	worker := spawnWorker(t, ctx, temporalAddr, kubeconfig, natsURL)
	defer worker.kill()

	waitForWorkerPoller(t, ctx, tc, "onboarding")

	wfID := fmt.Sprintf("onboard-acme-l2-%d", time.Now().UnixNano())
	wfRun, err := tc.ExecuteWorkflow(ctx, client.StartWorkflowOptions{
		ID:                       wfID,
		TaskQueue:                "onboarding",
		WorkflowExecutionTimeout: 60 * time.Second,
	}, "OnboardTenantWorkflow", tenantInputJSON{
		TenantID: "acme",
		Email:    "acme@example.com",
		Plan:     "free",
	})
	if err != nil {
		t.Fatalf("ExecuteWorkflow: %v", err)
	}
	t.Logf("workflow submitted: id=%s runID=%s", wfRun.GetID(), wfRun.GetRunID())

	if err := wfRun.Get(ctx, nil); err != nil {
		t.Fatalf("OnboardTenantWorkflow failed: %v\n--- worker stderr tail ---\n%s",
			err, worker.stderrTail())
	}
	t.Logf("workflow completed successfully")

	histJSON := captureHistory(t, ctx, tc, wfRun.GetID(), wfRun.GetRunID())
	writeHistoryOutput(t, histJSON)
}

// requireEnv fails the test if the named env var is not set.
func requireEnv(t *testing.T, key string) string {
	t.Helper()
	v := os.Getenv(key)
	if v == "" {
		t.Fatalf("required env var %q not set; itest_suite wrapper should have populated it", key)
	}
	return v
}

// mustTemporalClient dials the Temporal frontend in the
// itest-managed namespace (TEMPORAL_NAMESPACE, populated by
// rules_temporal's temporal_server target).
func mustTemporalClient(t *testing.T, addr string) client.Client {
	t.Helper()
	c, err := client.Dial(client.Options{
		HostPort:  addr,
		Namespace: os.Getenv("TEMPORAL_NAMESPACE"),
	})
	if err != nil {
		t.Fatalf("temporal client.Dial(%s): %v", addr, err)
	}
	return c
}

// mustDynamicClient builds a dynamic.Interface from KUBECONFIG.
func mustDynamicClient(t *testing.T, kubeconfig string) dynamic.Interface {
	t.Helper()
	cfg, err := clientcmd.BuildConfigFromFlags("", kubeconfig)
	if err != nil {
		t.Fatalf("clientcmd.BuildConfigFromFlags: %v", err)
	}
	dyn, err := dynamic.NewForConfig(cfg)
	if err != nil {
		t.Fatalf("dynamic.NewForConfig: %v", err)
	}
	return dyn
}

// mustNATSConn dials the in-process NATS server.
func mustNATSConn(t *testing.T, url string) *nats.Conn {
	t.Helper()
	nc, err := nats.Connect(url, nats.Timeout(5*time.Second))
	if err != nil {
		t.Fatalf("nats.Connect(%s): %v", url, err)
	}
	return nc
}

// waitForWorkerPoller polls Temporal's DescribeTaskQueue until at
// least one poller is registered, or the deadline elapses. Solves
// the worker-startup-race: ExecuteWorkflow with no pollers stalls
// (the workflow gets scheduled but never picked up).
func waitForWorkerPoller(t *testing.T, ctx context.Context, tc client.Client, taskQueue string) {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		resp, err := tc.DescribeTaskQueue(ctx, taskQueue, enumspb.TASK_QUEUE_TYPE_WORKFLOW)
		if err == nil && len(resp.GetPollers()) > 0 {
			t.Logf("worker poller registered: %d active", len(resp.GetPollers()))
			return
		}
		time.Sleep(200 * time.Millisecond)
	}
	t.Fatalf("worker never registered as poller for task queue %q within 30s", taskQueue)
}

// watchXRsAndPatchReady runs sidecar goroutine #1 — simulates the
// Crossplane reconciler. Watches XTenant + XTenantDatabase ADDED
// events on the apiserver; for each, patches `.status.ready=true`
// after a 200ms delay. activities_xr.go's poll loop sees the patch
// and returns nil.
func watchXRsAndPatchReady(ctx context.Context, t *testing.T, dyn dynamic.Interface, ns string) {
	gvrs := []schema.GroupVersionResource{xtenantGVR, xtenantdatabaseGVR}
	for _, gvr := range gvrs {
		go func(gvr schema.GroupVersionResource) {
			w, err := dyn.Resource(gvr).Watch(ctx, metav1.ListOptions{})
			if err != nil {
				t.Logf("watchXRsAndPatchReady(%s): Watch error: %v", gvr.Resource, err)
				return
			}
			defer w.Stop()
			for event := range w.ResultChan() {
				if event.Type != watch.Added {
					continue
				}
				u, ok := event.Object.(*unstructured.Unstructured)
				if !ok {
					continue
				}
				go patchReadyAfterDelay(ctx, t, dyn, gvr, u.GetName(), 200*time.Millisecond)
			}
		}(gvr)
	}
	<-ctx.Done()
}

func patchReadyAfterDelay(ctx context.Context, t *testing.T, dyn dynamic.Interface, gvr schema.GroupVersionResource, name string, delay time.Duration) {
	select {
	case <-time.After(delay):
	case <-ctx.Done():
		return
	}
	current, err := dyn.Resource(gvr).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		t.Logf("sidecar: get %s/%s: %v", gvr.Resource, name, err)
		return
	}
	if err := unstructured.SetNestedField(current.Object, true, "status", "ready"); err != nil {
		t.Logf("sidecar: SetNestedField %s/%s: %v", gvr.Resource, name, err)
		return
	}
	if _, err := dyn.Resource(gvr).Update(ctx, current, metav1.UpdateOptions{}); err != nil {
		t.Logf("sidecar: update %s/%s: %v", gvr.Resource, name, err)
		return
	}
	t.Logf("sidecar: %s/%s status.ready=true", gvr.Resource, name)
}

// watchWorkflowsAndPublishNATS runs sidecar goroutine #2 — simulates
// the Argo Workflows controller's onExit step. Watches Workflow CR
// ADDED events in the `argo` namespace; for each, reads the
// workflowTemplateRef name + tenantId argument, maps to the per-step
// NATS subject, and publishes "Succeeded" after a 200ms delay.
// activities_argo.go's SubscribeSync sees the message and returns nil.
func watchWorkflowsAndPublishNATS(ctx context.Context, t *testing.T, dyn dynamic.Interface, nc *nats.Conn) {
	w, err := dyn.Resource(workflowGVR).Namespace("argo").Watch(ctx, metav1.ListOptions{})
	if err != nil {
		t.Logf("watchWorkflowsAndPublishNATS: Watch error: %v", err)
		return
	}
	defer w.Stop()
	for event := range w.ResultChan() {
		if event.Type != watch.Added {
			continue
		}
		u, ok := event.Object.(*unstructured.Unstructured)
		if !ok {
			continue
		}
		template, _, _ := unstructured.NestedString(u.Object, "spec", "workflowTemplateRef", "name")
		params, _, _ := unstructured.NestedSlice(u.Object, "spec", "arguments", "parameters")
		tenantID := extractTenantIDParam(params)
		subject := mapTemplateToNATSSubject(template, tenantID)
		if subject == "" {
			t.Logf("sidecar: skipping Workflow %s (template=%q tenantID=%q → no subject)", u.GetName(), template, tenantID)
			continue
		}
		go publishSucceededAfterDelay(ctx, t, nc, subject, 200*time.Millisecond)
	}
}

func extractTenantIDParam(params []any) string {
	for _, p := range params {
		m, ok := p.(map[string]any)
		if !ok {
			continue
		}
		if m["name"] == "tenantId" {
			if v, ok := m["value"].(string); ok {
				return v
			}
		}
	}
	return ""
}

func mapTemplateToNATSSubject(template, tenantID string) string {
	switch template {
	case "mint-tenant-vault-key":
		return fmt.Sprintf("workflow.tenant.%s.mint-vault-key", tenantID)
	case "apply-tenant-migrations":
		return fmt.Sprintf("workflow.tenant.%s.migrations", tenantID)
	default:
		return ""
	}
}

func publishSucceededAfterDelay(ctx context.Context, t *testing.T, nc *nats.Conn, subject string, delay time.Duration) {
	select {
	case <-time.After(delay):
	case <-ctx.Done():
		return
	}
	if err := nc.Publish(subject, []byte("Succeeded")); err != nil {
		t.Logf("sidecar: publish %s: %v", subject, err)
		return
	}
	if err := nc.Flush(); err != nil {
		t.Logf("sidecar: flush after publish %s: %v", subject, err)
		return
	}
	t.Logf("sidecar: published Succeeded → %s", subject)
}

// workerHandle wraps the production :worker subprocess + a captured
// stderr ring-buffer for failure diagnostics.
type workerHandle struct {
	cmd      *exec.Cmd
	stderrCh <-chan string
	tail     []string
}

func (h *workerHandle) kill() {
	if h.cmd != nil && h.cmd.Process != nil {
		_ = h.cmd.Process.Kill()
		_ = h.cmd.Wait()
	}
}

func (h *workerHandle) stderrTail() string {
	for {
		select {
		case line, ok := <-h.stderrCh:
			if !ok {
				return joinTail(h.tail)
			}
			h.tail = append(h.tail, line)
			if len(h.tail) > 100 {
				h.tail = h.tail[len(h.tail)-100:]
			}
		default:
			return joinTail(h.tail)
		}
	}
}

func joinTail(lines []string) string {
	out := ""
	for _, l := range lines {
		out += l + "\n"
	}
	return out
}

// spawnWorker exec's the :worker binary as a subprocess. Located via
// Bazel runfiles. Inherits TEMPORAL_NAMESPACE from the itest_suite
// wrapper env.
func spawnWorker(t *testing.T, ctx context.Context, temporalAddr, kubeconfig, natsURL string) *workerHandle {
	t.Helper()
	rf, err := runfiles.New()
	if err != nil {
		t.Fatalf("runfiles.New: %v", err)
	}
	workerPath, err := rf.Rlocation("_main/apps/workers/onboarding/worker_/worker")
	if err != nil {
		t.Fatalf("runfiles.Rlocation worker binary: %v", err)
	}
	cmd := exec.CommandContext(ctx, workerPath)
	cmd.Env = append(os.Environ(),
		"TEMPORAL_ADDRESS="+temporalAddr,
		"TEMPORAL_NAMESPACE="+os.Getenv("TEMPORAL_NAMESPACE"),
		"KUBECONFIG="+kubeconfig,
		"NATS_URL="+natsURL,
	)
	stderr, err := cmd.StderrPipe()
	if err != nil {
		t.Fatalf("cmd.StderrPipe: %v", err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatalf("worker cmd.Start: %v", err)
	}
	// Drain stderr into a channel so the test driver can dump tail on
	// failure. 1KB read at a time; backpressure-buffered to 256 lines.
	ch := make(chan string, 256)
	go func() {
		defer close(ch)
		buf := make([]byte, 4096)
		line := ""
		for {
			n, err := stderr.Read(buf)
			if n > 0 {
				line += string(buf[:n])
				for {
					i := indexByte(line, '\n')
					if i < 0 {
						break
					}
					select {
					case ch <- line[:i]:
					default:
						// drop oldest on overflow
					}
					line = line[i+1:]
				}
			}
			if err != nil {
				return
			}
		}
	}()
	return &workerHandle{cmd: cmd, stderrCh: ch}
}

func indexByte(s string, b byte) int {
	for i := 0; i < len(s); i++ {
		if s[i] == b {
			return i
		}
	}
	return -1
}

// captureHistory pulls all events for the workflow via
// client.GetWorkflowHistory and serializes them via protojson — the
// same encoder `temporal workflow show -o json` uses. The output
// shape `{"events": [...]}` matches what `temporal workflow replay`
// expects.
func captureHistory(t *testing.T, ctx context.Context, c client.Client, wfID, runID string) []byte {
	t.Helper()
	iter := c.GetWorkflowHistory(ctx, wfID, runID, false,
		enumspb.HISTORY_EVENT_FILTER_TYPE_ALL_EVENT)
	events := []json.RawMessage{}
	for iter.HasNext() {
		event, err := iter.Next()
		if err != nil {
			t.Fatalf("iter.Next: %v", err)
		}
		data, err := protojson.Marshal(event)
		if err != nil {
			t.Fatalf("protojson.Marshal: %v", err)
		}
		events = append(events, json.RawMessage(data))
	}
	out, err := json.MarshalIndent(map[string]any{"events": events}, "", "  ")
	if err != nil {
		t.Fatalf("MarshalIndent: %v", err)
	}
	return out
}

// writeHistoryOutput writes the captured JSON to
// $TEST_UNDECLARED_OUTPUTS_DIR so the operator can extract it from
// `bazel-testlogs/.../test.outputs/` post-run and commit to
// `apps/workers/onboarding/testdata/histories/`.
func writeHistoryOutput(t *testing.T, jsonBytes []byte) {
	t.Helper()
	dir := os.Getenv("TEST_UNDECLARED_OUTPUTS_DIR")
	if dir == "" {
		t.Logf("TEST_UNDECLARED_OUTPUTS_DIR not set; skipping history file write")
		return
	}
	path := filepath.Join(dir, "onboard_tenant_happy.json")
	if err := os.WriteFile(path, jsonBytes, 0644); err != nil {
		t.Fatalf("write history JSON: %v", err)
	}
	t.Logf("history JSON written to %s (%d bytes; extract via bazel-testlogs/.../test.outputs/onboard_tenant_happy.json)",
		path, len(jsonBytes))
}

