import { useCloud, type Cloud } from "../providers/cloud-theme";

// ── Term maps ─────────────────────────────────────────────────────────────────
//
// Each cloud uses its own vocabulary for the same monok8s concepts.
// Components call useTerm() and render t("tenant") instead of hard-coding
// "tenant" — the label then matches the cloud portal the user already knows.
//
// Keep terms short (≤ 2 words) so they fit in table headers and nav labels.

type TermKey =
  | "tenant"
  | "tenants"
  | "tenant_id"
  | "member"
  | "members"
  | "role"
  | "roles"
  | "role_assignment"
  | "resource"
  | "resources"
  | "installation"
  | "installations"
  | "drift"
  | "finding"
  | "findings"
  | "access_review"
  | "access_reviews"
  | "billing"
  | "environment"
  | "onboard"
  | "offboard";

type TermMap = Record<TermKey, string>;

const TERMS: Record<Cloud, TermMap> = {

  // GCP: "Projects", organisation hierarchy, Workload Identity
  gcp: {
    tenant:         "Project",
    tenants:        "Projects",
    tenant_id:      "Project ID",
    member:         "Principal",
    members:        "Principals",
    role:           "Role",
    roles:          "Roles",
    role_assignment:"IAM binding",
    resource:       "Resource",
    resources:      "Resources",
    installation:   "Cluster",
    installations:  "Clusters",
    drift:          "Drift",
    finding:        "Finding",
    findings:       "SCC findings",
    access_review:  "Access review",
    access_reviews: "Access reviews",
    billing:        "Billing",
    environment:    "Project",
    onboard:        "Create project",
    offboard:       "Delete project",
  },

  // AWS: "Accounts", IAM, CloudScape density
  aws: {
    tenant:         "Account",
    tenants:        "Accounts",
    tenant_id:      "Account ID",
    member:         "Principal",
    members:        "Principals",
    role:           "Permission set",
    roles:          "Permission sets",
    role_assignment:"Assignment",
    resource:       "Resource",
    resources:      "Resources",
    installation:   "Cluster",
    installations:  "Clusters",
    drift:          "Drift",
    finding:        "Finding",
    findings:       "Security Hub findings",
    access_review:  "Access review",
    access_reviews: "Access reviews",
    billing:        "Cost & usage",
    environment:    "Account",
    onboard:        "Create account",
    offboard:       "Close account",
  },

  // Azure: "Subscriptions", Entra, Fluent UI
  azure: {
    tenant:         "Subscription",
    tenants:        "Subscriptions",
    tenant_id:      "Subscription ID",
    member:         "Member",
    members:        "Members",
    role:           "Role",
    roles:          "Role definitions",
    role_assignment:"Role assignment",
    resource:       "Resource",
    resources:      "Resources",
    installation:   "Cluster",
    installations:  "Clusters",
    drift:          "Drift",
    finding:        "Alert",
    findings:       "Defender alerts",
    access_review:  "Access review",
    access_reviews: "Access reviews",
    billing:        "Cost Management",
    environment:    "Subscription",
    onboard:        "Create subscription",
    offboard:       "Cancel subscription",
  },

  // Bare-metal: use monok8s-native terms
  "bare-metal": {
    tenant:         "Tenant",
    tenants:        "Tenants",
    tenant_id:      "Tenant ID",
    member:         "Member",
    members:        "Members",
    role:           "Role",
    roles:          "Roles",
    role_assignment:"Role assignment",
    resource:       "Resource",
    resources:      "Resources",
    installation:   "Installation",
    installations:  "Installations",
    drift:          "Drift",
    finding:        "Finding",
    findings:       "Security findings",
    access_review:  "Access review",
    access_reviews: "Access reviews",
    billing:        "Billing",
    environment:    "Environment",
    onboard:        "Onboard",
    offboard:       "Offboard",
  },
};

// ── Hook ──────────────────────────────────────────────────────────────────────

/**
 * useTerm
 *
 * Returns a translation function that maps monok8s-internal term keys to the
 * vocabulary used by the active cloud portal.
 *
 * Must be called inside a <CloudThemeProvider>.
 *
 * @example
 * const t = useTerm();
 * // On GCP: t("tenant") === "Project"
 * // On AWS: t("tenant") === "Account"
 * // On Azure: t("tenant") === "Subscription"
 *
 * <h1>{t("tenants")}</h1>
 * <button>{t("onboard")}</button>
 */
export function useTerm(): (key: TermKey) => string {
  const { info } = useCloud();
  const map = TERMS[info.cloud];
  return (key: TermKey) => map[key];
}
