package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"time"

	"go.temporal.io/sdk/client"
	auth "github.com/monok8s/monok8s/packages/auth/go"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
)

// systemTenantID is the canonical TenantID for the install-time admin
// tenant. Hard-coded per Discussion #76 ("only the default admin
// tenant can create other tenants"); the API enforces the constraint
// via SpiceDB's system:monok8s#only_system_can_create_tenants check.
const systemTenantID = "system"

// installNamespace is the K8s Namespace where the bootstrap-admin
// Secret lives. Pre-created by the platform install bundle; the
// Job's ServiceAccount has Secret-read RBAC scoped to this Namespace.
const installNamespace = "install"

// bootstrapAdminSecretName is the Secret containing the admin email
// + initial password the operator supplies at install time. Schema:
//   email:           string (the admin's email address)
//   initialPassword: string (must be force-reset on first login)
const bootstrapAdminSecretName = "monok8s-bootstrap-admin"

// XTenant GVR — must match the production CRD installed by Crossplane.
var xtenantGVR = schema.GroupVersionResource{
	Group:    "monok8s.io",
	Version:  "v1alpha1",
	Resource: "xtenants",
}

// workflowExecutionTimeout caps how long the bootstrap Job waits for
// OnboardTenantWorkflow to complete. The workflow itself uses
// activity-level timeouts; this is the outer "give up + retry on next
// Job execution" guard.
const workflowExecutionTimeout = 10 * time.Minute

// Overridable factories — tests inject fakes via package-var
// assignment. Same pattern as apps/workers/onboarding's
// dynamicClientFactory.
var (
	k8sClientFactory     = defaultK8sClient
	dynamicClientFactory = defaultDynamicClient
	temporalClientFactory = defaultTemporalClient
	zitadelClientFactory = defaultZitadelClient
	spicedbWriter        = defaultSpiceDBWriter
)

// run is the bootstrap orchestration. Idempotent: each step's
// existence check returns nil-error if the step has already been
// completed.
func run() error {
	ctx, cancel := context.WithTimeout(context.Background(), workflowExecutionTimeout+1*time.Minute)
	defer cancel()

	// Step 1: read bootstrap admin Secret.
	adminEmail, adminPassword, err := readBootstrapAdminSecret(ctx)
	if err != nil {
		return fmt.Errorf("read bootstrap admin secret: %w", err)
	}
	log.Printf("monok8s-bootstrap: bootstrap admin secret read (email=%s)", adminEmail)

	// Step 2: idempotency check — system XTenant already exists?
	dyn, err := dynamicClientFactory()
	if err != nil {
		return fmt.Errorf("dynamic client: %w", err)
	}
	if exists, err := systemTenantExists(ctx, dyn); err != nil {
		return fmt.Errorf("check system tenant existence: %w", err)
	} else if exists {
		log.Printf("monok8s-bootstrap: system XTenant already exists; skipping workflow submission")
	} else {
		// Step 3: submit OnboardTenantWorkflow.
		if err := executeOnboardingWorkflow(ctx, adminEmail); err != nil {
			return fmt.Errorf("execute onboarding workflow: %w", err)
		}
		log.Printf("monok8s-bootstrap: OnboardTenantWorkflow completed for system tenant")
	}

	// Step 4: Zitadel admin human user (idempotent — search-then-create).
	zclient, err := zitadelClientFactory()
	if err != nil {
		return fmt.Errorf("zitadel client: %w", err)
	}
	userID, err := zclient.ensureAdminUser(ctx, adminEmail, adminPassword)
	if err != nil {
		return fmt.Errorf("ensure Zitadel admin user: %w", err)
	}
	log.Printf("monok8s-bootstrap: Zitadel admin user ensured (userID=%s)", userID)

	// Step 5: SpiceDB system relation (TOUCH semantics = idempotent).
	if err := spicedbWriter(ctx, userID); err != nil {
		return fmt.Errorf("write SpiceDB system admin relation: %w", err)
	}
	log.Printf("monok8s-bootstrap: SpiceDB system:monok8s#only_system_can_create_tenants@user:%s written", userID)

	return nil
}

// systemTenantExists returns true if the `system` XTenant XR has been
// applied to the apiserver. Used for idempotency — a re-run of the
// Job after the first successful execution skips step 3 entirely.
func systemTenantExists(ctx context.Context, dyn dynamic.Interface) (bool, error) {
	_, err := dyn.Resource(xtenantGVR).Get(ctx, systemTenantID, metav1.GetOptions{})
	if err == nil {
		return true, nil
	}
	if apierrors.IsNotFound(err) {
		return false, nil
	}
	return false, err
}

// executeOnboardingWorkflow submits OnboardTenantWorkflow on the
// onboarding task queue with TenantID="system" and waits for
// completion. The workflow does its own provisioning (Crossplane XR
// creation, Argo Workflow steps, NATS publish); this binary just
// drives the trigger.
func executeOnboardingWorkflow(ctx context.Context, adminEmail string) error {
	tc, err := temporalClientFactory()
	if err != nil {
		return err
	}
	defer tc.Close()

	wfID := fmt.Sprintf("monok8s-bootstrap-%s-%d", systemTenantID, time.Now().Unix())
	wfRun, err := tc.ExecuteWorkflow(ctx, client.StartWorkflowOptions{
		ID:                       wfID,
		TaskQueue:                "onboarding",
		WorkflowExecutionTimeout: workflowExecutionTimeout,
	}, "OnboardTenantWorkflow", tenantInputJSON{
		TenantID: systemTenantID,
		Email:    adminEmail,
		Plan:     "admin",
	})
	if err != nil {
		return fmt.Errorf("submit workflow %s: %w", wfID, err)
	}
	log.Printf("monok8s-bootstrap: submitted workflow id=%s runID=%s", wfRun.GetID(), wfRun.GetRunID())

	if err := wfRun.Get(ctx, nil); err != nil {
		return fmt.Errorf("workflow %s failed: %w", wfID, err)
	}
	return nil
}

// tenantInputJSON mirrors apps/workers/onboarding.TenantInput's wire
// shape. Declared locally since the onboarding package is `package
// main` and not importable.
type tenantInputJSON struct {
	TenantID string
	Email    string
	Plan     string
}

// readBootstrapAdminSecret returns the admin email + initial password
// from the Secret in the install namespace. Returns error if the
// Secret is missing or malformed.
func readBootstrapAdminSecret(ctx context.Context) (email, password string, err error) {
	clientset, err := k8sClientFactory()
	if err != nil {
		return "", "", err
	}
	secret, err := clientset.CoreV1().Secrets(installNamespace).Get(ctx, bootstrapAdminSecretName, metav1.GetOptions{})
	if err != nil {
		return "", "", fmt.Errorf("get secret %s/%s: %w", installNamespace, bootstrapAdminSecretName, err)
	}
	emailBytes, ok := secret.Data["email"]
	if !ok || len(emailBytes) == 0 {
		return "", "", errors.New("secret missing required key 'email'")
	}
	passwordBytes, ok := secret.Data["initialPassword"]
	if !ok || len(passwordBytes) == 0 {
		return "", "", errors.New("secret missing required key 'initialPassword'")
	}
	return string(emailBytes), string(passwordBytes), nil
}

// ── factory defaults ────────────────────────────────────────────────

func defaultK8sClient() (kubernetes.Interface, error) {
	cfg, err := loadKubeConfig()
	if err != nil {
		return nil, err
	}
	return kubernetes.NewForConfig(cfg)
}

func defaultDynamicClient() (dynamic.Interface, error) {
	cfg, err := loadKubeConfig()
	if err != nil {
		return nil, err
	}
	return dynamic.NewForConfig(cfg)
}

func loadKubeConfig() (*rest.Config, error) {
	if path := os.Getenv("KUBECONFIG"); path != "" {
		return clientcmd.BuildConfigFromFlags("", path)
	}
	return rest.InClusterConfig()
}

func defaultTemporalClient() (client.Client, error) {
	addr := os.Getenv("TEMPORAL_ADDRESS")
	if addr == "" {
		addr = "temporal.temporal.svc.cluster.local:7233"
	}
	return client.Dial(client.Options{
		HostPort:  addr,
		Namespace: os.Getenv("TEMPORAL_NAMESPACE"),
	})
}

// defaultSpiceDBWriter wraps packages/auth/go's Client. Reads the
// SpiceDB endpoint + token from env vars provisioned by the platform
// install bundle.
func defaultSpiceDBWriter(ctx context.Context, userID string) error {
	endpoint := os.Getenv("SPICEDB_ENDPOINT")
	if endpoint == "" {
		endpoint = "spicedb.spicedb.svc.cluster.local:50051"
	}
	token := os.Getenv("SPICEDB_TOKEN")
	if token == "" {
		return errors.New("SPICEDB_TOKEN env var not set")
	}
	insecure := os.Getenv("SPICEDB_INSECURE") == "true"
	c, err := auth.NewClient(endpoint, token, insecure)
	if err != nil {
		return err
	}
	_, err = c.WriteSystemAdminRelation(ctx, userID)
	return err
}
