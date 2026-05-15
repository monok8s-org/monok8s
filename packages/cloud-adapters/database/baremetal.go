package database

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
)

// BaremetalAdapter is the CloudNativePG-backed database adapter. It
// applies CNPG `Cluster` CRs directly to the Kubernetes API and
// returns a Handle whose DSN points at the canonical CNPG read-write
// service (`<cluster>-rw.<ns>.svc.cluster.local`). The DSN omits the
// password — callers fetch the CNPG-generated `<cluster>-app` Secret
// separately. Password-baking into the Handle is deferred so that
// secret handling stays in one place (the secrets adapter / #85
// connection pool).
//
// Per the per-tenant Composition model (Discussion #76 + #82), one
// adapter = one tenant namespace; the cluster name is the tenant slug.
type BaremetalAdapter struct {
	client    *http.Client
	apiServer string // e.g. https://kubernetes.default.svc
	token     string
	namespace string
	database  string // database name CNPG seeds; default "app"
}

// NewBaremetalAdapter wires a CNPG adapter against a Kubernetes API
// endpoint. `client` should usually be `http.DefaultClient` or one
// configured with the in-cluster ServiceAccount CA; in test mode the
// httptest server's `.Client()` substitutes.
func NewBaremetalAdapter(client *http.Client, apiServer, token, namespace, database string) *BaremetalAdapter {
	if client == nil {
		client = &http.Client{
			Transport: &http.Transport{
				TLSClientConfig: &tls.Config{InsecureSkipVerify: false},
			},
		}
	}
	if database == "" {
		database = "app"
	}
	return &BaremetalAdapter{
		client:    client,
		apiServer: apiServer,
		token:     token,
		namespace: namespace,
		database:  database,
	}
}

const clustersPath = "/apis/postgresql.cnpg.io/v1/namespaces"

// cnpgCluster is the minimal CR shape we serialize. CNPG accepts
// additional spec fields (storage, monitoring, etc.) — keep this
// surface narrow; callers that need more pass through a SpecOverride
// hook (deferred until a real consumer asks for it).
type cnpgCluster struct {
	APIVersion string                 `json:"apiVersion"`
	Kind       string                 `json:"kind"`
	Metadata   map[string]any         `json:"metadata"`
	Spec       map[string]any         `json:"spec"`
	Status     map[string]any         `json:"status,omitempty"`
}

func (a *BaremetalAdapter) clusterURL(name string) string {
	if name == "" {
		return fmt.Sprintf("%s%s/%s/clusters", a.apiServer, clustersPath, a.namespace)
	}
	return fmt.Sprintf("%s%s/%s/clusters/%s", a.apiServer, clustersPath, a.namespace, name)
}

func (a *BaremetalAdapter) do(ctx context.Context, method, url string, body any) (*cnpgCluster, error) {
	var reqBody io.Reader
	if body != nil {
		buf, err := json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("marshal: %w", err)
		}
		reqBody = bytes.NewReader(buf)
	}
	req, err := http.NewRequestWithContext(ctx, method, url, reqBody)
	if err != nil {
		return nil, fmt.Errorf("request: %w", err)
	}
	if a.token != "" {
		req.Header.Set("Authorization", "Bearer "+a.token)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := a.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("do: %w", err)
	}
	defer res.Body.Close()
	rb, _ := io.ReadAll(res.Body)
	if res.StatusCode >= 400 {
		return nil, fmt.Errorf("k8s api %s %s: %d: %s", method, url, res.StatusCode, rb)
	}
	if method == http.MethodDelete || len(rb) == 0 {
		return nil, nil
	}
	out := &cnpgCluster{}
	if err := json.Unmarshal(rb, out); err != nil {
		return nil, fmt.Errorf("decode: %w", err)
	}
	return out, nil
}

func (a *BaremetalAdapter) buildHandle(name string) Handle {
	return Handle{
		ID: fmt.Sprintf("%s/%s", a.namespace, name),
		// Canonical CNPG rw-service DSN. Password omitted; callers
		// fetch from the `<name>-app` Secret (separate concern).
		DSN: fmt.Sprintf("postgres://app@%s-rw.%s.svc.cluster.local:5432/%s?sslmode=require",
			name, a.namespace, a.database),
	}
}

func (a *BaremetalAdapter) ProvisionInstance(ctx context.Context, name, region string) (Handle, error) {
	// `region` is unused on bare-metal — CNPG clusters land in the
	// host cluster. Accepted in the signature for cloud-adapter
	// interface parity (RDS / Cloud SQL / Azure DB all take region).
	_ = region
	cluster := &cnpgCluster{
		APIVersion: "postgresql.cnpg.io/v1",
		Kind:       "Cluster",
		Metadata: map[string]any{
			"name":      name,
			"namespace": a.namespace,
		},
		Spec: map[string]any{
			"instances": 1,
			"bootstrap": map[string]any{
				"initdb": map[string]any{
					"database": a.database,
					"owner":    "app",
				},
			},
		},
	}
	if _, err := a.do(ctx, http.MethodPost, a.clusterURL(""), cluster); err != nil {
		return Handle{}, fmt.Errorf("baremetal database ProvisionInstance %q: %w", name, err)
	}
	return a.buildHandle(name), nil
}

func (a *BaremetalAdapter) DescribeInstance(ctx context.Context, name string) (Handle, error) {
	cl, err := a.do(ctx, http.MethodGet, a.clusterURL(name), nil)
	if err != nil {
		return Handle{}, fmt.Errorf("baremetal database DescribeInstance %q: %w", name, err)
	}
	if cl == nil {
		return Handle{}, fmt.Errorf("baremetal database DescribeInstance %q: empty response", name)
	}
	return a.buildHandle(name), nil
}

func (a *BaremetalAdapter) DeleteInstance(ctx context.Context, name string) error {
	if _, err := a.do(ctx, http.MethodDelete, a.clusterURL(name), nil); err != nil {
		return fmt.Errorf("baremetal database DeleteInstance %q: %w", name, err)
	}
	return nil
}

// Compile-time interface conformance check.
var _ Adapter = (*BaremetalAdapter)(nil)
