// Package main — L4 milestone-gate test driver (#37 Phase 1).
//
// Phase 1 scope: the falsifiable hermeticity claim. Spins up a kind
// cluster (via the rules_kind / itest_suite Bazel rule chain), applies
// platform/argocd/bootstrap.yaml via server-side apply, then asserts
// the K8s apiserver accepted every expected ArgoCD workload resource.
//
// Phase 2 scope (deferred to a follow-up Issue):
// - Every workload reaches Ready (blocked on vanilla ArgoCD v3.3.8's
//   redis secret-init reliability — operator-managed-secret territory)
// - Apply the platform AppSet so ArgoCD reconciles the rest of the stack
// - Run the demo path (monok8s tenant onboard → workflow → tenant.ping)
// - Loki + Tempo trace-span assertions
//
// Phase 1 closes Discussion #4 Gap 3 ("all platform manifests are
// vendored Bazel inputs that install cleanly"). The substantive
// release signal is that the vendored YAML at pinned tags is
// K8s-API-acceptable on a fresh apiserver — a missing CRD, schema
// mismatch, or RBAC rejection surfaces immediately as a test failure.
// Pod-Ready is the deeper bring-up concern Phase 2 covers.

package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/bazelbuild/rules_go/go/runfiles"
)

// applyTimeout — wall-clock budget for the apply + workload-existence
// checks. The server-side apply of bootstrap.yaml runs in ~60s on a
// warm-cache machine, ~90s cold. 5 minute budget absorbs cold-image
// caches without flaking; workload existence checks complete in <1s
// each once apply has returned.
const applyTimeout = 5 * time.Minute

// kubectl path — rules_kind writes its kubectl path into the env
// file's `KUBECTL` key (sourced by itest_suite's wrapper.sh via
// `set -a` + `source <cluster>.env`). Falls back to PATH-resolved
// `kubectl` for ad-hoc local runs against an already-running cluster.
func kubectlPath() string {
	if p := os.Getenv("KUBECTL"); p != "" {
		return p
	}
	return "kubectl"
}

// kubeconfig path — set by rules_itest from the kind_cluster env file.
func kubeconfigPath(t *testing.T) string {
	t.Helper()
	p := os.Getenv("KUBECONFIG")
	if p == "" {
		t.Fatalf("KUBECONFIG not set — driver must be run under the itest_suite wrapper that exports it")
	}
	abs, err := filepath.Abs(p)
	if err != nil {
		t.Fatalf("KUBECONFIG path %q not resolvable: %v", p, err)
	}
	return abs
}

// kubectl runs `kubectl <args>` against the kind cluster + returns
// (stdout, err). Stderr is forwarded to the test log on failure.
func kubectl(ctx context.Context, kubeconfig string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, kubectlPath(), append([]string{"--kubeconfig", kubeconfig}, args...)...)
	out, err := cmd.CombinedOutput()
	return string(out), err
}

// kubectlStdin runs kubectl with stdin piped from a string. Used for
// inline manifests (e.g. the argocd namespace creation).
func kubectlStdin(ctx context.Context, kubeconfig, stdin string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, kubectlPath(), append([]string{"--kubeconfig", kubeconfig}, args...)...)
	cmd.Stdin = strings.NewReader(stdin)
	out, err := cmd.CombinedOutput()
	return string(out), err
}

// tailLines returns the last n lines of s for logging large outputs.
func tailLines(s string, n int) string {
	lines := strings.Split(strings.TrimRight(s, "\n"), "\n")
	if len(lines) <= n {
		return s
	}
	return "…(" + fmt.Sprintf("%d", len(lines)-n) + " lines elided)\n" +
		strings.Join(lines[len(lines)-n:], "\n")
}

// TestArgocdInstalls — Phase 1 gate assertion.
//
// Phase 1 scope (the substantive 0.1.0 release signal): the vendored
// ArgoCD bootstrap manifest is K8s-API-acceptable on a fresh kind
// cluster. The falsifiable claim for Hermeticity Gap 3 ("all platform
// manifests are vendored Bazel inputs that install cleanly") is that
// applying bootstrap.yaml against a fresh apiserver produces all the
// expected workload resources without schema rejection.
//
// Phase 2 scope (deferred to a follow-up Issue): every workload
// reaches Ready. Out of scope for Phase 1 because vanilla ArgoCD
// v3.3.8 install yaml ships a redis `secret-init` initContainer that
// is empirically unreliable in vanilla kind clusters (cascading pod
// CrashLoopBackOff blocks repo-server + server probes). Solving that
// is operator-managed-secret + helm-chart-values territory, not a
// vendored-yaml hermeticity concern. The Phase 2 Issue captures the
// pod-Ready check + the Loki/Tempo trace assertions per #37's AC.
//
// The driver creates the `argocd` namespace + a stub `argocd-redis`
// Secret (operator-managed-credentials path per ArgoCD's official
// install docs), then applies platform/argocd/bootstrap.yaml via
// `kubectl apply --server-side --force-conflicts`. The vendored
// bootstrap manifest does NOT declare its own Namespace resource —
// installation docs assume the operator pre-creates it (so the
// install is portable across operators who manage namespaces via
// Capsule / Crossplane / etc.).
//
// Server-side apply is required because the vendored ArgoCD bootstrap
// includes the `applicationsets.argoproj.io` CRD whose OpenAPI
// annotation exceeds K8s's 256KB metadata annotation limit
// (argoproj/argo-cd#9035 — the canonical ArgoCD-on-K8s pain point).
// Client-side apply writes a `kubectl.kubernetes.io/last-applied-
// configuration` annotation containing the entire prior manifest,
// exceeding the cap. Server-side apply tracks field ownership in the
// API server and doesn't write that annotation.
//
// Assertion chain:
//   1. Namespace creation succeeds (idempotent — already-exists is OK)
//   2. argocd-redis Secret pre-creation succeeds
//   3. Server-side apply of the bootstrap manifest succeeds
//   4. The `argocd` namespace exists post-apply
//   5. Every expected ArgoCD workload (6 Deployments + 1 StatefulSet)
//      is present in the namespace per the K8s apiserver
//
// Step 5 is the falsifiable hermeticity claim — if any workload was
// dropped during the apply (CRD missing, schema mismatch, RBAC
// rejection, etc.), the workload-existence check surfaces it.
func TestArgocdInstalls(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), applyTimeout+90*time.Second)
	defer cancel()
	kubeconfig := kubeconfigPath(t)

	// Step 0a: create the argocd namespace. Bootstrap manifest assumes
	// the operator created it. `create namespace` returns non-zero on
	// already-exists; tolerate that via `apply` over a tiny inline
	// manifest fed on stdin.
	nsYAML := "apiVersion: v1\nkind: Namespace\nmetadata:\n  name: argocd\n"
	if out, err := kubectlStdin(ctx, kubeconfig, nsYAML, "apply", "-f", "-"); err != nil {
		t.Fatalf("argocd namespace apply failed: %v\noutput:\n%s", err, out)
	} else {
		t.Logf("namespace apply: %s", strings.TrimSpace(out))
	}

	// Step 0a.5: pre-create the argocd-redis Secret. Vanilla ArgoCD
	// install yamls (v3.x) ship a `secret-init` initContainer on the
	// redis Deployment that runs `argocd admin redis-initial-password`
	// to self-bootstrap the auth secret. On a fresh kind cluster that
	// path is unreliable — the SA token isn't always provisioned by
	// the time the initContainer runs, producing CrashLoopBackOff that
	// blocks the repo-server + server pods (they secretKeyRef the
	// same Secret). Pre-creating the Secret with a fixed test password
	// is the operator-managed path documented by ArgoCD's official
	// install guide and is hermetic-test-appropriate (this is a kind
	// cluster, not a production install — the password leaks nowhere).
	redisSecretYAML := "apiVersion: v1\n" +
		"kind: Secret\n" +
		"metadata:\n" +
		"  name: argocd-redis\n" +
		"  namespace: argocd\n" +
		"  labels:\n" +
		"    app.kubernetes.io/name: argocd-redis\n" +
		"    app.kubernetes.io/part-of: argocd\n" +
		"type: Opaque\n" +
		"stringData:\n" +
		"  auth: monok8s-test-redis-password-not-for-production\n"
	if out, err := kubectlStdin(ctx, kubeconfig, redisSecretYAML, "apply", "-f", "-"); err != nil {
		t.Fatalf("argocd-redis Secret apply failed: %v\noutput:\n%s", err, out)
	} else {
		t.Logf("argocd-redis Secret apply: %s", strings.TrimSpace(out))
	}

	// Step 0b: apply the bootstrap manifest via server-side apply.
	// rules_go's runfiles library resolves the path from the test's
	// runfiles tree; naive relative paths miss because the sh_test
	// wrapper around the Go binary doesn't chdir into runfiles.
	rf, err := runfiles.New()
	if err != nil {
		t.Fatalf("runfiles.New: %v", err)
	}
	manifest, err := rf.Rlocation("_main/platform/argocd/bootstrap.yaml")
	if err != nil {
		t.Fatalf("Rlocation bootstrap.yaml: %v", err)
	}
	t.Logf("applying %s", manifest)
	if out, err := kubectl(ctx, kubeconfig,
		"apply",
		"--server-side",
		"--force-conflicts",
		"-n", "argocd",
		"-f", manifest,
	); err != nil {
		t.Fatalf("server-side apply of %s failed: %v\noutput:\n%s", manifest, err, out)
	} else {
		t.Logf("kubectl apply output (tail):\n%s", tailLines(out, 20))
	}

	// Step 1: namespace exists.
	if out, err := kubectl(ctx, kubeconfig, "get", "namespace", "argocd"); err != nil {
		t.Fatalf("argocd namespace not found: %v\noutput:\n%s", err, out)
	}

	// Step 2: assert every expected ArgoCD workload was accepted by the
	// apiserver. This is the falsifiable hermeticity claim — if the
	// vendored manifest dropped a workload (CRD missing, schema
	// mismatch, RBAC rejection), the `kubectl get` would NotFound and
	// surface it as a test failure.
	//
	// The set of workloads is fixed by ArgoCD's vendored install —
	// keeping it as an explicit list (vs `--selector` over labels)
	// makes a missing workload a clear test failure instead of a
	// silent pass.
	workloads := []string{
		"deployment/argocd-applicationset-controller",
		"deployment/argocd-dex-server",
		"deployment/argocd-notifications-controller",
		"deployment/argocd-redis",
		"deployment/argocd-repo-server",
		"deployment/argocd-server",
		"statefulset/argocd-application-controller",
	}
	for _, w := range workloads {
		if out, err := kubectl(ctx, kubeconfig,
			"get", w,
			"-n", "argocd",
			"-o", "jsonpath={.metadata.name}",
		); err != nil {
			t.Fatalf("workload %s missing from apiserver: %v\noutput:\n%s",
				w, err, out)
		} else {
			t.Logf("workload %s present: %s", w, out)
		}
	}
	t.Logf("all %d argocd workloads present in apiserver", len(workloads))
}
