package client

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// Token holds a short-lived monok8s JWT with its expiry.
type Token struct {
	AccessToken string    `json:"access_token"`
	ExpiresAt   time.Time `json:"expires_at"`
	Identity    string    `json:"identity"` // email or sub from the token
}

// tokenCache is the on-disk cache at ~/.monok8s/config.
type tokenCache struct {
	Token    Token  `json:"token"`
	Endpoint string `json:"endpoint"`
}

// ResolveToken returns a valid monok8s JWT, obtaining one via:
//  1. Explicit API key (if set) — exchanged for a short-lived JWT
//  2. Cloud-identity token detected from active gcloud/aws/az session
//  3. Cached token from ~/.monok8s/config
func ResolveToken(ctx context.Context, cfg Config) (Token, error) {
	if cfg.APIKey != "" {
		return exchangeAPIKey(ctx, cfg.Endpoint, cfg.APIKey)
	}

	// Try cloud-identity exchange.
	cloudToken, cloud, err := detectCloudIdentityToken(cfg.Cloud)
	if err == nil && cloudToken != "" {
		return exchangeCloudToken(ctx, cfg.Endpoint, cloudToken, cloud)
	}

	// Fall back to cached token.
	if cached, err := loadCachedToken(cfg.Endpoint); err == nil && time.Now().Before(cached.ExpiresAt) {
		return cached, nil
	}

	return Token{}, fmt.Errorf("no credentials found — run 'monok8s auth login' or set MONOK8S_API_KEY")
}

// Login performs authentication and caches the resulting token.
func Login(cfg Config) (*Client, error) {
	token, err := ResolveToken(context.Background(), cfg)
	if err != nil {
		return nil, err
	}
	if err := cacheToken(cfg.Endpoint, token); err != nil {
		// Non-fatal — caching is a convenience, not a requirement.
		fmt.Fprintf(os.Stderr, "warning: could not cache token: %v\n", err)
	}
	return &Client{cfg: cfg, token: token}, nil
}

// ── Cloud identity detection ───────────────────────────────────────────────────

// detectCloudIdentityToken returns an access token from the active cloud CLI
// session, plus the cloud name ("gcp", "aws", "azure").
// Returns an error if no cloud session is active.
func detectCloudIdentityToken(cloudOverride string) (token, cloud string, err error) {
	probers := []struct {
		cloud string
		fn    func() (string, error)
	}{
		{"gcp", probeGCloud},
		{"aws", probeAWS},
		{"azure", probeAzure},
	}

	for _, p := range probers {
		if cloudOverride != "" && cloudOverride != p.cloud {
			continue
		}
		t, err := p.fn()
		if err == nil && t != "" {
			return t, p.cloud, nil
		}
	}
	return "", "", fmt.Errorf("no active cloud CLI session detected")
}

// probeGCloud returns the current gcloud access token if gcloud is in PATH
// and has an active authenticated session.
func probeGCloud() (string, error) {
	out, err := exec.Command("gcloud", "auth", "print-access-token", "--quiet").Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

// probeAWS returns an AWS STS identity token suitable for exchange.
// Uses aws sts get-caller-identity to verify credentials are active,
// then returns the credentials as a JSON-encoded token for the exchange endpoint.
func probeAWS() (string, error) {
	// Verify credentials are active.
	identityOut, err := exec.Command("aws", "sts", "get-caller-identity",
		"--output", "json").Output()
	if err != nil {
		return "", err
	}
	// Return the STS response as the "token" — the exchange endpoint verifies it
	// by calling STS with the session credentials.
	return string(identityOut), nil
}

// probeAzure returns the current Azure access token for the monok8s resource.
func probeAzure() (string, error) {
	out, err := exec.Command("az", "account", "get-access-token",
		"--resource", "api://monok8s",
		"--query", "accessToken",
		"--output", "tsv").Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

// ── Token exchange ─────────────────────────────────────────────────────────────

// exchangeCloudToken calls the monok8s auth endpoint to exchange a cloud
// identity token for a short-lived monok8s JWT.
func exchangeCloudToken(ctx context.Context, endpoint, cloudToken, cloud string) (Token, error) {
	return callExchangeEndpoint(ctx, endpoint, map[string]string{
		"grant_type":   "cloud_identity",
		"cloud":        cloud,
		"cloud_token":  cloudToken,
	})
}

func exchangeAPIKey(ctx context.Context, endpoint, apiKey string) (Token, error) {
	return callExchangeEndpoint(ctx, endpoint, map[string]string{
		"grant_type": "api_key",
		"api_key":    apiKey,
	})
}

func callExchangeEndpoint(ctx context.Context, endpoint string, body map[string]string) (Token, error) {
	payload, err := json.Marshal(body)
	if err != nil {
		return Token{}, err
	}
	req, err := http.NewRequestWithContext(ctx, "POST", endpoint+"/auth/token", bytes.NewReader(payload))
	if err != nil {
		return Token{}, err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return Token{}, fmt.Errorf("token exchange failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return Token{}, fmt.Errorf("token exchange failed: HTTP %d", resp.StatusCode)
	}

	var result struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
		Identity    string `json:"identity"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return Token{}, fmt.Errorf("token exchange: %w", err)
	}
	return Token{
		AccessToken: result.AccessToken,
		ExpiresAt:   time.Now().Add(time.Duration(result.ExpiresIn) * time.Second),
		Identity:    result.Identity,
	}, nil
}

// ── Token cache ────────────────────────────────────────────────────────────────

func configPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".monok8s", "config"), nil
}

func loadCachedToken(endpoint string) (Token, error) {
	path, err := configPath()
	if err != nil {
		return Token{}, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return Token{}, err
	}
	var cache tokenCache
	if err := json.Unmarshal(data, &cache); err != nil {
		return Token{}, err
	}
	if cache.Endpoint != endpoint {
		return Token{}, fmt.Errorf("cached token is for a different endpoint")
	}
	return cache.Token, nil
}

func cacheToken(endpoint string, t Token) error {
	path, err := configPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	cache := tokenCache{Token: t, Endpoint: endpoint}
	data, err := json.MarshalIndent(cache, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0600)
}

