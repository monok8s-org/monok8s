// Package k8s_e2e is the L4 end-to-end test driver for the
// monok8s-bootstrap install Job (#145 / #98b). It assumes a fresh
// K8s cluster brought up by the rules_kind kind_cluster sibling
// target with the install manifest set already applied. It then:
//
//  1. Waits for platform Deployments (Crossplane, Zitadel, SpiceDB,
//     Temporal, Argo Workflows, onboarding worker).
//  2. Creates the install-time `monok8s-bootstrap-admin` Secret.
//  3. Applies the bootstrap Job manifest.
//  4. Waits for the Job's Pod to exit 0.
//  5. Asserts XTenant `system` `.status.ready=true`.
//  6. Asserts a Zitadel admin user exists (REST search via
//     port-forward).
//  7. Asserts the SpiceDB system:monok8s relation
//     `only_system_can_create_tenants` for the admin user
//     (CheckPermission via packages/auth/go::CanOnSystem).
//
// KUBECONFIG is set by rules_kind's `kind_cluster.env` and exported
// into the test environment by service_test.
package k8s_e2e_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	auth "github.com/monok8s/monok8s/packages/auth/go"

	"github.com/bazelbuild/rules_go/go/runfiles"
	"github.com/stretchr/testify/require"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/util/yaml"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/tools/clientcmd"
)

const (
	installNS        = "install"
	zitadelNS        = "zitadel"
	spicedbNS        = "spicedb"
	adminEmail       = "admin@example.test"
	adminPassword    = "ChangeMeOnFirstLogin!2026"
	systemTenantID   = "system"
	systemResourceID = "monok8s"
)

var xtenantGVR = schema.GroupVersionResource{
	Group:    "monok8s.io",
	Version:  "v1alpha1",
	Resource: "xtenants",
}

// TestBootstrapE2E is the single end-to-end test. Sequential phases
// because each phase's assertions depend on the prior phase's state.
func TestBootstrapE2E(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()

	cs, dyn := mustClient(t)

	t.Log("Phase 1 — waiting for platform Deployments to be Ready")
	waitDeployment(t, ctx, cs, "crossplane-system", "crossplane", 5*time.Minute)
	waitDeployment(t, ctx, cs, zitadelNS, "zitadel", 5*time.Minute)
	waitDeployment(t, ctx, cs, "spicedb-operator", "spicedb-operator-manager", 5*time.Minute)
	waitDeployment(t, ctx, cs, "temporal-operator", "temporal-operator-manager", 5*time.Minute)
	waitDeployment(t, ctx, cs, "argo", "workflow-controller", 5*time.Minute)
	waitDeployment(t, ctx, cs, "monok8s-prod", "monok8s-worker-onboarding", 5*time.Minute)

	t.Log("Phase 1b — waiting for the zitadel-admin-sa Secret to be emitted")
	zitadelPAT := readSecretValue(t, ctx, cs, zitadelNS, "zitadel-admin-sa", "pat", 5*time.Minute)
	t.Logf("zitadel-admin-sa PAT discovered (length=%d)", len(zitadelPAT))

	t.Log("Phase 1c — waiting for the spicedb-preshared-key Secret")
	spicedbToken := readSecretValue(t, ctx, cs, spicedbNS, "spicedb-preshared-key", "token", 5*time.Minute)

	t.Log("Phase 2 — creating install-time admin Secret + applying bootstrap Job")
	ensureNamespace(t, ctx, cs, installNS)
	copySecret(t, ctx, cs, zitadelNS, "zitadel-admin-sa", installNS)
	copySecret(t, ctx, cs, spicedbNS, "spicedb-preshared-key", installNS)
	applySecret(t, ctx, cs, installNS, "monok8s-bootstrap-admin",
		map[string][]byte{
			"email":           []byte(adminEmail),
			"initialPassword": []byte(adminPassword),
		})
	applyJobFromRunfiles(t, ctx, cs, "_main/platform/monok8s-bootstrap/bootstrap-job.yaml")

	t.Log("Phase 2b — waiting for the bootstrap Job to succeed")
	waitJobSucceeded(t, ctx, cs, installNS, "monok8s-bootstrap", 5*time.Minute)

	t.Log("Phase 3 — asserting end-to-end state")
	assertXTenantReady(t, ctx, dyn, systemTenantID, 2*time.Minute)
	adminUserID := assertZitadelAdmin(t, ctx, cs, zitadelPAT, adminEmail)
	t.Logf("zitadel admin userID: %s", adminUserID)
	assertSpicedbAdminRelation(t, ctx, cs, spicedbToken, adminUserID)
}

// ─── Kubernetes client helpers ────────────────────────────────────────────────

func mustClient(t *testing.T) (*kubernetes.Clientset, dynamic.Interface) {
	t.Helper()
	kc := os.Getenv("KUBECONFIG")
	require.NotEmpty(t, kc, "KUBECONFIG must be set by rules_kind/service_test")

	cfg, err := clientcmd.BuildConfigFromFlags("", kc)
	require.NoError(t, err, "BuildConfigFromFlags")

	cs, err := kubernetes.NewForConfig(cfg)
	require.NoError(t, err, "kubernetes.NewForConfig")

	dyn, err := dynamic.NewForConfig(cfg)
	require.NoError(t, err, "dynamic.NewForConfig")

	return cs, dyn
}

func waitDeployment(t *testing.T, ctx context.Context, cs *kubernetes.Clientset,
	ns, name string, timeout time.Duration) {
	t.Helper()
	dl, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	tick := time.NewTicker(5 * time.Second)
	defer tick.Stop()
	lastLog := time.Now()
	for {
		d, err := cs.AppsV1().Deployments(ns).Get(dl, name, metav1.GetOptions{})
		if err == nil && d.Status.AvailableReplicas >= 1 {
			t.Logf("✓ Deployment %s/%s Ready", ns, name)
			return
		}
		if time.Since(lastLog) > 30*time.Second {
			t.Logf("… waiting for Deployment %s/%s (err=%v)", ns, name, err)
			lastLog = time.Now()
		}
		select {
		case <-dl.Done():
			t.Fatalf("timeout waiting for Deployment %s/%s: %v", ns, name, dl.Err())
		case <-tick.C:
		}
	}
}

// readSecretValue polls until the given Secret + key exist and returns the
// value. Used for Secrets emitted by other operators' bootstrap jobs.
func readSecretValue(t *testing.T, ctx context.Context, cs *kubernetes.Clientset,
	ns, name, key string, timeout time.Duration) string {
	t.Helper()
	dl, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	tick := time.NewTicker(3 * time.Second)
	defer tick.Stop()
	for {
		s, err := cs.CoreV1().Secrets(ns).Get(dl, name, metav1.GetOptions{})
		if err == nil {
			if v, ok := s.Data[key]; ok && len(v) > 0 {
				return string(v)
			}
		}
		select {
		case <-dl.Done():
			t.Fatalf("timeout waiting for Secret %s/%s.%s: %v", ns, name, key, dl.Err())
		case <-tick.C:
		}
	}
}

func ensureNamespace(t *testing.T, ctx context.Context, cs *kubernetes.Clientset, ns string) {
	t.Helper()
	_, err := cs.CoreV1().Namespaces().Create(ctx, &corev1.Namespace{
		ObjectMeta: metav1.ObjectMeta{Name: ns},
	}, metav1.CreateOptions{})
	if err != nil && !apierrors.IsAlreadyExists(err) {
		t.Fatalf("create namespace %s: %v", ns, err)
	}
}

func copySecret(t *testing.T, ctx context.Context, cs *kubernetes.Clientset,
	srcNS, name, dstNS string) {
	t.Helper()
	src, err := cs.CoreV1().Secrets(srcNS).Get(ctx, name, metav1.GetOptions{})
	require.NoError(t, err, "read source Secret %s/%s", srcNS, name)
	dst := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: dstNS},
		Type:       src.Type,
		Data:       src.Data,
	}
	_, err = cs.CoreV1().Secrets(dstNS).Create(ctx, dst, metav1.CreateOptions{})
	if err != nil && !apierrors.IsAlreadyExists(err) {
		t.Fatalf("copy Secret %s/%s → %s: %v", srcNS, name, dstNS, err)
	}
}

func applySecret(t *testing.T, ctx context.Context, cs *kubernetes.Clientset,
	ns, name string, data map[string][]byte) {
	t.Helper()
	s := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns},
		Type:       corev1.SecretTypeOpaque,
		Data:       data,
	}
	_, err := cs.CoreV1().Secrets(ns).Create(ctx, s, metav1.CreateOptions{})
	if err != nil && !apierrors.IsAlreadyExists(err) {
		t.Fatalf("create Secret %s/%s: %v", ns, name, err)
	}
}

func applyJobFromRunfiles(t *testing.T, ctx context.Context, cs *kubernetes.Clientset, rfPath string) {
	t.Helper()
	rf, err := runfiles.New()
	require.NoError(t, err, "runfiles.New")
	p, err := rf.Rlocation(rfPath)
	require.NoError(t, err, "Rlocation %s", rfPath)
	raw, err := os.ReadFile(p)
	require.NoError(t, err, "read %s", p)

	var job batchv1.Job
	require.NoError(t, yaml.NewYAMLOrJSONDecoder(bytes.NewReader(raw), 4096).Decode(&job),
		"decode Job from %s", p)

	_, err = cs.BatchV1().Jobs(job.Namespace).Create(ctx, &job, metav1.CreateOptions{})
	if err != nil && !apierrors.IsAlreadyExists(err) {
		t.Fatalf("create Job %s/%s: %v", job.Namespace, job.Name, err)
	}
}

func waitJobSucceeded(t *testing.T, ctx context.Context, cs *kubernetes.Clientset,
	ns, name string, timeout time.Duration) {
	t.Helper()
	dl, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	tick := time.NewTicker(5 * time.Second)
	defer tick.Stop()
	for {
		j, err := cs.BatchV1().Jobs(ns).Get(dl, name, metav1.GetOptions{})
		if err == nil {
			if j.Status.Succeeded >= 1 {
				t.Logf("✓ Job %s/%s succeeded", ns, name)
				return
			}
			if j.Status.Failed >= int32(*j.Spec.BackoffLimit) {
				t.Fatalf("Job %s/%s exceeded backoffLimit (failed=%d)", ns, name, j.Status.Failed)
			}
		}
		select {
		case <-dl.Done():
			t.Fatalf("timeout waiting for Job %s/%s to succeed: %v", ns, name, dl.Err())
		case <-tick.C:
		}
	}
}

// ─── Assertions ───────────────────────────────────────────────────────────────

func assertXTenantReady(t *testing.T, ctx context.Context, dyn dynamic.Interface,
	name string, timeout time.Duration) {
	t.Helper()
	dl, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	tick := time.NewTicker(3 * time.Second)
	defer tick.Stop()
	for {
		u, err := dyn.Resource(xtenantGVR).Get(dl, name, metav1.GetOptions{})
		if err == nil {
			ready, found, _ := unstructured.NestedBool(u.Object, "status", "ready")
			if found && ready {
				t.Logf("✓ XTenant %s status.ready=true", name)
				return
			}
		}
		select {
		case <-dl.Done():
			t.Fatalf("timeout waiting for XTenant %s status.ready=true: %v", name, dl.Err())
		case <-tick.C:
		}
	}
}

// assertZitadelAdmin port-forwards Zitadel and queries the v2 users
// search endpoint for the admin email. Returns the userID (used as
// SpiceDB subject in the next assertion).
func assertZitadelAdmin(t *testing.T, ctx context.Context, cs *kubernetes.Clientset,
	pat, email string) string {
	t.Helper()
	pf := portForward(t, ctx, "zitadel", "svc/zitadel", 8080)
	defer pf.stop()

	body, err := json.Marshal(map[string]any{
		"queries": []any{
			map[string]any{
				"emailQuery": map[string]any{
					"emailAddress": email,
				},
			},
		},
	})
	require.NoError(t, err, "marshal Zitadel search body")

	url := fmt.Sprintf("http://localhost:%d/v2/users", pf.localPort)
	req, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(body))
	require.NoError(t, err, "build Zitadel search request")
	req.Header.Set("Authorization", "Bearer "+pat)
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err, "Zitadel search HTTP")
	defer resp.Body.Close()

	require.Equal(t, http.StatusOK, resp.StatusCode, "Zitadel search status")
	raw, err := io.ReadAll(resp.Body)
	require.NoError(t, err, "read Zitadel response")

	var result struct {
		Result []struct {
			UserID string `json:"userId"`
		} `json:"result"`
	}
	require.NoError(t, json.Unmarshal(raw, &result), "decode Zitadel response: %s", string(raw))
	require.Len(t, result.Result, 1, "expected exactly one user for %s; got %s", email, string(raw))
	return result.Result[0].UserID
}

// assertSpicedbAdminRelation port-forwards SpiceDB and calls
// CanOnSystem (packages/auth/go) to verify the admin has
// create_tenants on system:monok8s.
func assertSpicedbAdminRelation(t *testing.T, ctx context.Context, cs *kubernetes.Clientset,
	token, userID string) {
	t.Helper()
	pf := portForward(t, ctx, "spicedb", "svc/spicedb", 50051)
	defer pf.stop()

	endpoint := fmt.Sprintf("localhost:%d", pf.localPort)
	client, err := auth.NewClient(endpoint, token, true /* insecure */)
	require.NoError(t, err, "spicedb auth.NewClient")

	allowed, err := client.CanOnSystem(ctx, userID, "create_tenants", systemResourceID, "")
	require.NoError(t, err, "CanOnSystem")
	require.True(t, allowed, "expected admin user %s to have create_tenants on system:%s", userID, systemResourceID)
	t.Logf("✓ SpiceDB CanOnSystem(%s, create_tenants, system:%s) = true", userID, systemResourceID)
}

// ─── Port-forward sidecar ────────────────────────────────────────────────────

type portForwarder struct {
	cmd       *exec.Cmd
	localPort int
}

func (p *portForwarder) stop() {
	if p.cmd != nil && p.cmd.Process != nil {
		_ = p.cmd.Process.Kill()
		_ = p.cmd.Wait()
	}
}

// portForward exec's `kubectl port-forward` and waits ~5s for the
// forwarder to be ready. Returns a struct that releases the port-forward
// when .stop() is called. The local port is selected by kubectl
// (we pass :<remotePort> to let it pick) and parsed from stderr.
func portForward(t *testing.T, ctx context.Context, ns, target string, remotePort int) *portForwarder {
	t.Helper()
	cmd := exec.CommandContext(ctx, "kubectl",
		"--kubeconfig", os.Getenv("KUBECONFIG"),
		"-n", ns,
		"port-forward", target,
		fmt.Sprintf(":%d", remotePort),
	)
	stderr, err := cmd.StderrPipe()
	require.NoError(t, err, "stderrpipe")
	require.NoError(t, cmd.Start(), "start kubectl port-forward")

	// Parse local port from first stderr line: "Forwarding from 127.0.0.1:NNNN -> ..."
	pf := &portForwarder{cmd: cmd}
	buf := make([]byte, 4096)
	dl := time.Now().Add(10 * time.Second)
	for time.Now().Before(dl) {
		n, err := stderr.Read(buf)
		if n > 0 {
			line := string(buf[:n])
			if i := strings.Index(line, "127.0.0.1:"); i >= 0 {
				tail := line[i+len("127.0.0.1:"):]
				if j := strings.IndexAny(tail, " \t\n\r"); j >= 0 {
					tail = tail[:j]
				}
				_, perr := fmt.Sscanf(tail, "%d", &pf.localPort)
				require.NoError(t, perr, "parse port from %q", line)
				return pf
			}
		}
		if err != nil {
			break
		}
	}
	pf.stop()
	t.Fatalf("kubectl port-forward did not announce a local port within 10s")
	return nil
}
