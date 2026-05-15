package iamwriteback

import (
	"fmt"
	"strings"
)

// CloudRoleEvent is a normalised view of an IAM role assignment change,
// regardless of which cloud it originated from.
type CloudRoleEvent struct {
	Cloud        string // "aws" | "azure" | "gcp"
	EventType    string // "assigned" | "revoked"
	ResourceType string // monok8s resource type, e.g. "tenant" (drives SpiceDB resource kind)
	ResourceID   string // monok8s resource UUID (tenant ID, installation ID, etc.)
	SubjectID    string // monok8s user or SA UUID, extracted from the principal
	SubjectType  string // "user" | "service_account"
	Role         string // monok8s role name within the resource type
	RawEvent     string // original event JSON for audit logging
	MessageID    string // cloud message ID for deduplication
	OriginatedByMonok8s bool // true → event was triggered by Crossplane; skip it
}

// ── Role name convention ───────────────────────────────────────────────────────
//
// Each cloud uses a naming convention that embeds both the monok8s resource type
// and role name so translation is a string extraction rather than a heuristic
// mapping. Adding a new resource type requires only adding compositions/cloud
// roles that follow the pattern — no changes here.
//
// AWS IAM Identity Center permission set: "monok8s-<resource-type>-<role>"
//   e.g. "monok8s-tenant-admin", "monok8s-installation-viewer"
//
// Azure Entra app role value:             "monok8s:<resource-type>:<role>"
//   e.g. "monok8s:tenant:admin", "monok8s:installation:viewer"
//
// GCP custom IAM role id:                 "monok8s_<resource_type>_<role>_<resource_id>"
//   e.g. "monok8s_tenant_admin_550e8400-...", "monok8s_installation_viewer_..."
//
// The resource ID is carried separately (from account tags / group name / bucket
// labels) for AWS and Azure; for GCP it is embedded in the role ID itself.

var validRoles = map[string]bool{
	"admin":           true,
	"member":          true,
	"viewer":          true,
	"billing_manager": true,
	// "owner" is intentionally absent — owner cannot be assigned via cloud IAM
}

// ExtractRoleFromAWSPermissionSet parses "monok8s-<resource-type>-<role>".
// Returns the resource type and role separately.
func ExtractRoleFromAWSPermissionSet(permissionSetName string) (resourceType, role string, err error) {
	if !strings.HasPrefix(permissionSetName, "monok8s-") {
		return "", "", fmt.Errorf("permission set %q is not a monok8s set", permissionSetName)
	}
	rest := strings.TrimPrefix(permissionSetName, "monok8s-")
	// rest = "<resource-type>-<role>"; role may not contain hyphens so split from right
	idx := strings.LastIndex(rest, "-")
	if idx < 1 {
		return "", "", fmt.Errorf("cannot parse resource-type and role from permission set %q", permissionSetName)
	}
	resourceType = rest[:idx]
	role = rest[idx+1:]
	if !validRoles[role] {
		return "", "", fmt.Errorf("unknown monok8s role %q in permission set name", role)
	}
	return resourceType, role, nil
}

// ExtractRoleFromAzureAppRole parses "monok8s:<resource-type>:<role>".
// Returns the resource type and role separately.
func ExtractRoleFromAzureAppRole(appRoleValue string) (resourceType, role string, err error) {
	parts := strings.SplitN(appRoleValue, ":", 3)
	if len(parts) != 3 || parts[0] != "monok8s" {
		return "", "", fmt.Errorf("app role value %q is not a monok8s role", appRoleValue)
	}
	resourceType = parts[1]
	role = parts[2]
	if resourceType == "" {
		return "", "", fmt.Errorf("empty resource type in app role value %q", appRoleValue)
	}
	if !validRoles[role] {
		return "", "", fmt.Errorf("unknown monok8s role %q in app role value", role)
	}
	return resourceType, role, nil
}

// ExtractRoleFromGCPCustomRole parses "monok8s_<resource_type>_<role>_<resource_id>".
// Returns the resource type, role, and embedded resource ID separately.
// resource_id is a UUID which contains hyphens — in the role ID hyphens are
// replaced with underscores by GCP (role IDs may not contain hyphens), so the
// last 5 underscore-separated segments reconstruct the UUID.
func ExtractRoleFromGCPCustomRole(roleID string) (resourceType, role, resourceID string, err error) {
	if !strings.HasPrefix(roleID, "monok8s_") {
		return "", "", "", fmt.Errorf("custom role %q is not a monok8s role", roleID)
	}
	parts := strings.Split(strings.TrimPrefix(roleID, "monok8s_"), "_")
	// parts = [<resource_type>, <role>, <uuid-segment-1>, ..., <uuid-segment-5>]
	// UUID has 5 hyphen-separated groups; each group becomes one underscore-separated
	// segment, so we need at least 7 parts total (type + role + 5 uuid segments).
	if len(parts) < 7 {
		return "", "", "", fmt.Errorf("cannot parse resource-type, role, and resource ID from role ID %q", roleID)
	}
	resourceType = parts[0]
	role = parts[1]
	// Re-join the last 5 segments into a UUID (replace underscores back to hyphens)
	resourceID = strings.Join(parts[len(parts)-5:], "-")
	if !validRoles[role] {
		return "", "", "", fmt.Errorf("unknown monok8s role %q in custom role ID", role)
	}
	return resourceType, role, resourceID, nil
}

// ExtractResourceIDFromAWSTag returns the monok8s resource UUID from the
// standardised AWS tag "monok8s.io/resource-id".
func ExtractResourceIDFromAWSTag(tags map[string]string) (string, error) {
	id, ok := tags["monok8s.io/resource-id"]
	if !ok || id == "" {
		// Fall back to legacy tenant-specific tag for backwards compatibility
		id, ok = tags["monok8s-tenant-id"]
		if !ok || id == "" {
			return "", fmt.Errorf("AWS resource missing monok8s.io/resource-id tag")
		}
	}
	return id, nil
}

// ExtractResourceTypeFromAWSTag returns the monok8s resource type from the
// standardised AWS tag "monok8s.io/resource-type".
func ExtractResourceTypeFromAWSTag(tags map[string]string) (string, error) {
	rt, ok := tags["monok8s.io/resource-type"]
	if !ok || rt == "" {
		// Legacy resources are all tenants
		return "tenant", nil
	}
	return rt, nil
}

// ExtractResourceIDFromAzureGroupName parses "monok8s-<resource_type>-<resource_id>-<role>"
// from the Entra group display name included in the role assignment event.
// Group naming convention: monok8s-<resource_type>-<uuid>-<role>
func ExtractResourceIDFromAzureGroupName(groupDisplayName string) (resourceType, resourceID string, err error) {
	if !strings.HasPrefix(groupDisplayName, "monok8s-") {
		return "", "", fmt.Errorf("Entra group %q is not a monok8s group", groupDisplayName)
	}
	// Format: monok8s-<resource_type>-<uuid>-<role>
	// UUID is 5 hyphen-separated segments. Split all parts and reconstruct.
	parts := strings.Split(strings.TrimPrefix(groupDisplayName, "monok8s-"), "-")
	// parts[0]        = resource type
	// parts[1..5]     = UUID (5 segments)
	// parts[6]        = role
	if len(parts) < 7 {
		return "", "", fmt.Errorf("cannot parse resource type and ID from group name %q", groupDisplayName)
	}
	resourceType = parts[0]
	resourceID = strings.Join(parts[1:6], "-")
	return resourceType, resourceID, nil
}

// ExtractResourceIDFromGCPLabel extracts the monok8s resource ID and type from
// the standardised GCP resource labels included in the Audit Log resource labels.
func ExtractResourceIDFromGCPLabel(labels map[string]string) (resourceType, resourceID string, err error) {
	id, ok := labels["monok8s.io/resource-id"]
	if !ok || id == "" {
		// Fall back to legacy label
		id, ok = labels["monok8s.io/tenant-id"]
		if !ok || id == "" {
			return "", "", fmt.Errorf("GCP resource missing monok8s.io/resource-id label")
		}
	}
	rt, ok := labels["monok8s.io/resource-type"]
	if !ok || rt == "" {
		rt = "tenant"
	}
	return rt, id, nil
}
