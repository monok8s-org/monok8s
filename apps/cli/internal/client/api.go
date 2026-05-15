package client

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

type Config struct {
	Endpoint string
	APIKey   string
	Cloud    string
}

type Client struct {
	cfg   Config
	token Token
	http  *http.Client
}

func New(cfg Config) (*Client, error) {
	token, err := ResolveToken(context.Background(), cfg)
	if err != nil {
		return nil, err
	}
	return &Client{
		cfg:   cfg,
		token: token,
		http:  &http.Client{Timeout: 30 * time.Second},
	}, nil
}

func (c *Client) Identity() string { return c.token.Identity }

// Tenants.

func (c *Client) ListTenants(ctx context.Context, status string) ([]TenantRow, error) {
	params := map[string]any{}
	if status != "" {
		params["status"] = status
	}
	var result []TenantRow
	return result, c.get(ctx, "/tenants", params, &result)
}

func (c *Client) GetTenant(ctx context.Context, id string) (any, error) {
	var result any
	return result, c.get(ctx, "/tenants/"+id, nil, &result)
}

func (c *Client) OnboardTenant(ctx context.Context, input OnboardTenantInput) (OnboardResult, error) {
	var result OnboardResult
	return result, c.post(ctx, "/tenants/onboard", input, &result)
}

func (c *Client) OffboardTenant(ctx context.Context, id, reason string) (OffboardResult, error) {
	var result OffboardResult
	return result, c.post(ctx, "/tenants/"+id+"/offboard", map[string]string{"reason": reason}, &result)
}

func (c *Client) GetTenantResources(ctx context.Context, tenantID string, withDiff bool) ([]ResourceRow, error) {
	var result []ResourceRow
	return result, c.get(ctx, "/tenants/"+tenantID+"/resources",
		map[string]any{"diff": withDiff}, &result)
}

// Roles.

func (c *Client) ListRoleAssignments(ctx context.Context, tenantID, role, user string) ([]RoleAssignmentRow, error) {
	params := map[string]any{"tenant_id": tenantID}
	if role != "" {
		params["role"] = role
	}
	if user != "" {
		params["user_email"] = user
	}
	var result []RoleAssignmentRow
	return result, c.get(ctx, "/roles", params, &result)
}

func (c *Client) AssignRole(ctx context.Context, input AssignRoleInput) (AssignRoleResult, error) {
	var result AssignRoleResult
	return result, c.post(ctx, "/roles/assign", input, &result)
}

func (c *Client) RevokeRole(ctx context.Context, tenantID, userEmail, role string) error {
	return c.post(ctx, "/roles/revoke", map[string]string{
		"tenant_id":  tenantID,
		"user_email": userEmail,
		"role":       role,
	}, nil)
}

func (c *Client) TriggerCrossplaneSync(ctx context.Context, tenantID string) error {
	return c.post(ctx, "/tenants/"+tenantID+"/sync", nil, nil)
}

// Drift.

func (c *Client) DriftCheck(ctx context.Context, tenantID string) ([]DriftRow, error) {
	var result []DriftRow
	return result, c.get(ctx, "/drift/check", map[string]any{"tenant_id": tenantID}, &result)
}

func (c *Client) DriftCheckAll(ctx context.Context, severity string) ([]DriftRow, error) {
	var result []DriftRow
	return result, c.get(ctx, "/drift/check", map[string]any{"all": true, "severity": severity}, &result)
}

func (c *Client) DriftReconcile(ctx context.Context, input DriftReconcileInput) (DriftReconcileResult, error) {
	var result DriftReconcileResult
	return result, c.post(ctx, "/drift/reconcile", input, &result)
}

// Security findings.

func (c *Client) ListSecurityFindings(ctx context.Context, filter FindingsFilter) ([]FindingRow, error) {
	params := map[string]any{}
	if filter.TenantID != "" {
		params["tenant_id"] = filter.TenantID
	}
	if filter.Severity != "" {
		params["severity"] = filter.Severity
	}
	if filter.Cloud != "" {
		params["cloud"] = filter.Cloud
	}
	if filter.Status != "" {
		params["status"] = filter.Status
	}
	if filter.Limit > 0 {
		params["limit"] = filter.Limit
	}
	var result []FindingRow
	return result, c.get(ctx, "/security-findings", params, &result)
}

func (c *Client) ResolveSecurityFinding(ctx context.Context, findingID, reason string) error {
	return c.post(ctx, "/security-findings/"+findingID+"/resolve",
		map[string]string{"reason": reason}, nil)
}

// Access reviews.

func (c *Client) ListAccessReviews(ctx context.Context, tenantID string, pendingOnly bool) ([]AccessReviewRow, error) {
	var result []AccessReviewRow
	return result, c.get(ctx, "/access-reviews", map[string]any{
		"tenant_id":    tenantID,
		"pending_only": pendingOnly,
	}, &result)
}

func (c *Client) SubmitAccessReviewDecision(ctx context.Context, reviewID, assignmentID, decision string) error {
	return c.post(ctx, "/access-reviews/decide", map[string]string{
		"review_id":     reviewID,
		"assignment_id": assignmentID,
		"decision":      decision,
	}, nil)
}

func (c *Client) TriggerAccessReview(ctx context.Context, tenantID string) (AccessReviewTriggerResult, error) {
	var result AccessReviewTriggerResult
	return result, c.post(ctx, "/access-reviews/trigger", map[string]string{"tenant_id": tenantID}, &result)
}

// Installations.

func (c *Client) ListInstallations(ctx context.Context, tenantID string) ([]InstallationRow, error) {
	var result []InstallationRow
	params := map[string]any{}
	if tenantID != "" {
		params["tenant_id"] = tenantID
	}
	return result, c.get(ctx, "/installations", params, &result)
}

func (c *Client) RegisterInstallation(ctx context.Context, tenantID, name, desc string) (RegisterInstallationResult, error) {
	var result RegisterInstallationResult
	return result, c.post(ctx, "/installations/register", map[string]string{
		"tenant_id":   tenantID,
		"name":        name,
		"description": desc,
	}, &result)
}

func (c *Client) RevokeInstallation(ctx context.Context, id string) error {
	return c.post(ctx, "/installations/"+id+"/revoke", nil, nil)
}

func (c *Client) RotateInstallationKey(ctx context.Context, id string) (RotateKeyResult, error) {
	var result RotateKeyResult
	return result, c.post(ctx, "/installations/"+id+"/rotate-key", nil, &result)
}

func (c *Client) PollWorkflow(ctx context.Context, workflowID string) error {
	for {
		var status struct {
			State string `json:"state"`
		}
		if err := c.get(ctx, "/workflows/"+workflowID, nil, &status); err != nil {
			return err
		}
		switch status.State {
		case "completed":
			return nil
		case "failed", "cancelled", "terminated":
			return fmt.Errorf("workflow %s ended with state: %s", workflowID, status.State)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(3 * time.Second):
		}
	}
}

// HTTP helpers.

func (c *Client) get(ctx context.Context, path string, params map[string]any, out any) error {
	url := c.cfg.Endpoint + "/api/v1" + path
	if len(params) > 0 {
		q := make([]string, 0, len(params))
		for k, v := range params {
			if v == nil || v == "" || v == false {
				continue
			}
			q = append(q, fmt.Sprintf("%s=%v", k, v))
		}
		if len(q) > 0 {
			url += "?" + joinParams(q)
		}
	}
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return err
	}
	return c.do(req, out)
}

func (c *Client) post(ctx context.Context, path string, body any, out any) error {
	var bodyBytes []byte
	if body != nil {
		var err error
		bodyBytes, err = json.Marshal(body)
		if err != nil {
			return err
		}
	}
	req, err := http.NewRequestWithContext(ctx, "POST",
		c.cfg.Endpoint+"/api/v1"+path, bytes.NewReader(bodyBytes))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	return c.do(req, out)
}

func (c *Client) do(req *http.Request, out any) error {
	req.Header.Set("Authorization", "Bearer "+c.token.AccessToken)
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("API request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(resp.Body)
		var apiErr struct {
			Error   string `json:"error"`
			Message string `json:"message"`
		}
		if json.Unmarshal(body, &apiErr) == nil && apiErr.Message != "" {
			return fmt.Errorf("API error %d: %s", resp.StatusCode, apiErr.Message)
		}
		return fmt.Errorf("API error %d: %s", resp.StatusCode, body)
	}

	if out != nil {
		return json.NewDecoder(resp.Body).Decode(out)
	}
	return nil
}

func joinParams(parts []string) string {
	result := ""
	for i, p := range parts {
		if i > 0 {
			result += "&"
		}
		result += p
	}
	return result
}
