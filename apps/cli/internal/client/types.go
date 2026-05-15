package client

// Tenant.

type TenantRow struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Status    string `json:"status"`
	Plan      string `json:"plan"`
	CreatedAt string `json:"created_at"`
}

type OnboardTenantInput struct {
	Name       string `json:"name"`
	Plan       string `json:"plan"`
	OwnerEmail string `json:"owner_email"`
}

type OnboardResult struct {
	TenantID   string `json:"tenant_id"`
	WorkflowID string `json:"workflow_id"`
}

type OffboardResult struct {
	WorkflowID string `json:"workflow_id"`
}

type ResourceRow struct {
	Cloud      string `json:"cloud"`
	Type       string `json:"type"`
	ResourceID string `json:"resource_id"`
	Name       string `json:"name"`
	Status     string `json:"status"`
}

// Role.

type RoleAssignmentRow struct {
	UserEmail    string `json:"user_email"`
	Role         string `json:"role"`
	AssignedAt   string `json:"assigned_at"`
	LastReviewed string `json:"last_reviewed"`
	IsTemporary  bool   `json:"is_temporary"`
	ExpiresAt    string `json:"expires_at"`
}

type AssignRoleInput struct {
	TenantID  string `json:"tenant_id"`
	UserEmail string `json:"user_email"`
	Role      string `json:"role"`
	Expiry    string `json:"expiry"`
}

type AssignRoleResult struct {
	IsTemporary bool   `json:"is_temporary"`
	ExpiresAt   string `json:"expires_at"`
	WorkflowID  string `json:"workflow_id"`
}

// Drift.

type DriftRow struct {
	TenantID  string `json:"tenant_id"`
	UserEmail string `json:"user_email"`
	Role      string `json:"role"`
	Cloud     string `json:"cloud"`
	Status    string `json:"status"`
	Detail    string `json:"detail"`
}

type DriftReconcileInput struct {
	TenantID string `json:"tenant_id"`
	All      bool   `json:"all"`
	Revert   bool   `json:"revert"`
	DryRun   bool   `json:"dry_run"`
}

type DriftReconcileResult struct {
	Actions []ReconcileAction `json:"actions"`
}

type ReconcileAction struct {
	Action    string `json:"action"`
	TenantID  string `json:"tenant_id"`
	UserEmail string `json:"user_email"`
	Role      string `json:"role"`
	Cloud     string `json:"cloud"`
}

// Security findings.

type FindingsFilter struct {
	TenantID string `json:"tenant_id"`
	Severity string `json:"severity"`
	Cloud    string `json:"cloud"`
	Status   string `json:"status"`
	Limit    int    `json:"limit"`
}

type FindingRow struct {
	FindingID   string `json:"finding_id"`
	Cloud       string `json:"cloud"`
	Severity    string `json:"severity"`
	TenantID    string `json:"tenant_id"`
	FindingType string `json:"finding_type"`
	Title       string `json:"title"`
	ReceivedAt  string `json:"received_at"`
	CloudLink   string `json:"cloud_link"`
}

// Access reviews.

type AccessReviewRow struct {
	ReviewID   string `json:"review_id"`
	TenantID   string `json:"tenant_id"`
	UserEmail  string `json:"user_email"`
	Role       string `json:"role"`
	AssignedAt string `json:"assigned_at"`
	Deadline   string `json:"deadline"`
}

type AccessReviewTriggerResult struct {
	ReviewID string `json:"review_id"`
}

// Installations.

type InstallationRow struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	Status        string `json:"status"`
	LastHeartbeat string `json:"last_heartbeat"`
	Host          string `json:"host"`
}

type RegisterInstallationResult struct {
	InstallationID string `json:"installation_id"`
	BootstrapToken string `json:"bootstrap_token"`
}

type RotateKeyResult struct {
	NewKey string `json:"new_key"`
}
