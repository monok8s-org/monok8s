package main

// Install-time bootstrap binary for the monok8s default admin tenant
// (#98a). Runs as a Kubernetes Job on first cluster install. Per
// Discussion #76 + Issue #98:
//
//  1. Reads admin email + initial password from the
//     `monok8s-bootstrap-admin` Secret in the `install` namespace.
//  2. Checks idempotency — if the `system` XTenant XR exists, exits 0
//     immediately (Job is safe to re-run).
//  3. Submits OnboardTenantWorkflow on the `onboarding` Temporal task
//     queue with TenantID="system". Waits for completion.
//  4. Creates a Zitadel human admin user via the management REST API,
//     using the `zitadel-admin-sa` PAT mounted from a Secret.
//  5. Writes the SpiceDB relation
//     `system:monok8s#only_system_can_create_tenants@user:<userID>`
//     so the admin can create new tenants.
//
// Idempotent end-to-end. Re-running after a partial failure picks up
// where the previous run left off (each step has its own existence
// check). All side effects in step 3 are owned by the underlying
// OnboardTenantWorkflow's compensation logic from #129a.

import (
	"log"
	"os"
)

func main() {
	if err := run(); err != nil {
		log.Printf("monok8s-bootstrap: FAILED: %v", err)
		os.Exit(1)
	}
	log.Printf("monok8s-bootstrap: completed successfully")
}
