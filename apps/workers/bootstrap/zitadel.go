package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
)

// zitadelClient is the small REST surface the bootstrap Job needs.
// Two operations:
//   ensureAdminUser(email, password) → returns the userID; idempotent
//                                       via search-then-create.
//
// Authenticates via PAT mounted from the `zitadel-admin-sa` Secret
// that platform/zitadel/bootstrap-job.yaml provisions at install time.
type zitadelClient struct {
	baseURL string
	pat     string
	http    *http.Client
}

// defaultZitadelClient reads the Zitadel mgmt API base URL + admin
// PAT from env vars + mounted-file paths the install Job sets up.
func defaultZitadelClient() (*zitadelClient, error) {
	baseURL := os.Getenv("ZITADEL_API")
	if baseURL == "" {
		baseURL = "http://zitadel.zitadel.svc.cluster.local:8080"
	}

	// PAT may be mounted at a known path (matches the existing
	// platform/zitadel/bootstrap-job.yaml convention of mounting
	// /etc/zitadel/admin-sa/pat) OR provided directly via env var.
	pat := os.Getenv("ZITADEL_ADMIN_PAT")
	if pat == "" {
		patPath := os.Getenv("ZITADEL_ADMIN_PAT_FILE")
		if patPath == "" {
			patPath = "/etc/zitadel/admin-sa/pat"
		}
		data, err := os.ReadFile(patPath)
		if err != nil {
			return nil, fmt.Errorf("read Zitadel admin PAT from %s: %w", patPath, err)
		}
		pat = string(bytes.TrimSpace(data))
	}
	if pat == "" {
		return nil, errors.New("Zitadel admin PAT not available via env or file")
	}

	return &zitadelClient{
		baseURL: baseURL,
		pat:     pat,
		http:    &http.Client{},
	}, nil
}

// ensureAdminUser returns the userID for the named admin email. If no
// such user exists in Zitadel, creates one with the supplied
// initialPassword + force-password-reset-on-first-login flag.
func (zc *zitadelClient) ensureAdminUser(ctx context.Context, email, initialPassword string) (string, error) {
	if existing, err := zc.searchUserByEmail(ctx, email); err != nil {
		return "", fmt.Errorf("search user %s: %w", email, err)
	} else if existing != "" {
		return existing, nil
	}
	return zc.createHumanUser(ctx, email, initialPassword)
}

// searchUserByEmail looks up a user by their primary email. Returns
// "" if not found.
func (zc *zitadelClient) searchUserByEmail(ctx context.Context, email string) (string, error) {
	body := map[string]any{
		"queries": []any{
			map[string]any{
				"emailQuery": map[string]any{
					"emailAddress": email,
					"method":       "TEXT_QUERY_METHOD_EQUALS",
				},
			},
		},
	}
	var resp struct {
		Result []struct {
			ID string `json:"id"`
		} `json:"result"`
	}
	if err := zc.do(ctx, "POST", "/v2/users", body, &resp); err != nil {
		return "", err
	}
	if len(resp.Result) == 0 {
		return "", nil
	}
	return resp.Result[0].ID, nil
}

// createHumanUser creates a new human admin user. Uses the v2 user
// API. The password is provided directly; the change_required flag
// would normally force password reset on first login, but is left out
// here so the admin can log in with the initial password and rotate
// via the standard flow.
func (zc *zitadelClient) createHumanUser(ctx context.Context, email, initialPassword string) (string, error) {
	body := map[string]any{
		"username": email,
		"profile": map[string]any{
			"givenName":  "monok8s",
			"familyName": "admin",
		},
		"email": map[string]any{
			"email":      email,
			"isVerified": true,
		},
		"password": map[string]any{
			"password":       initialPassword,
			"changeRequired": false,
		},
	}
	var resp struct {
		UserID string `json:"userId"`
	}
	if err := zc.do(ctx, "POST", "/v2/users/human", body, &resp); err != nil {
		return "", err
	}
	if resp.UserID == "" {
		return "", errors.New("Zitadel created user but returned empty userId")
	}
	return resp.UserID, nil
}

// do issues an authenticated JSON request against the Zitadel mgmt
// API. Decodes the response body into `out` if non-nil.
func (zc *zitadelClient) do(ctx context.Context, method, path string, body any, out any) error {
	var bodyReader io.Reader
	if body != nil {
		buf, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("marshal request: %w", err)
		}
		bodyReader = bytes.NewReader(buf)
	}
	req, err := http.NewRequestWithContext(ctx, method, zc.baseURL+path, bodyReader)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+zc.pat)
	req.Header.Set("Content-Type", "application/json")

	res, err := zc.http.Do(req)
	if err != nil {
		return fmt.Errorf("%s %s: %w", method, path, err)
	}
	defer res.Body.Close()

	if res.StatusCode >= 400 {
		buf, _ := io.ReadAll(res.Body)
		return fmt.Errorf("%s %s: HTTP %d: %s", method, path, res.StatusCode, string(buf))
	}
	if out != nil {
		if err := json.NewDecoder(res.Body).Decode(out); err != nil {
			return fmt.Errorf("decode response: %w", err)
		}
	}
	return nil
}
