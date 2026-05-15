package observability

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
)

// BaremetalAdapter pushes logs / metrics / traces to OTLP-compatible
// receivers — typically the Loki, Mimir, Tempo OTLP HTTP receivers
// (or an OTel Collector that dispatches per-signal). Each signal has
// its own endpoint so deployments can route logs to one URL and
// metrics/traces to another (the OTel Collector pattern).
//
// Endpoint convention:
//   Loki OTLP logs:    https://loki.svc/otlp/v1/logs
//   Mimir OTLP metrics: https://mimir.svc/otlp/v1/metrics
//   Tempo OTLP traces:  https://tempo.svc/otlp/v1/traces
type BaremetalAdapter struct {
	client     *http.Client
	logsURL    string
	metricsURL string
	tracesURL  string
	serviceName string
	authHeader  string // optional, e.g. "Basic xxxx" for Mimir tenant header
}

type Config struct {
	Client      *http.Client
	LogsURL     string
	MetricsURL  string
	TracesURL   string
	ServiceName string // emitted as resource attribute
	AuthHeader  string // optional Authorization header value
}

func NewBaremetalAdapter(cfg Config) *BaremetalAdapter {
	if cfg.Client == nil {
		cfg.Client = http.DefaultClient
	}
	if cfg.ServiceName == "" {
		cfg.ServiceName = "monok8s"
	}
	return &BaremetalAdapter{
		client:      cfg.Client,
		logsURL:     cfg.LogsURL,
		metricsURL:  cfg.MetricsURL,
		tracesURL:   cfg.TracesURL,
		serviceName: cfg.ServiceName,
		authHeader:  cfg.AuthHeader,
	}
}

// post sends an OTLP/HTTP/JSON payload to the target URL. Returns the
// underlying error on transport failure or non-2xx response.
func (a *BaremetalAdapter) post(ctx context.Context, url string, payload any) error {
	if url == "" {
		return fmt.Errorf("baremetal observability: endpoint URL not configured")
	}
	buf, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(buf))
	if err != nil {
		return fmt.Errorf("request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if a.authHeader != "" {
		req.Header.Set("Authorization", a.authHeader)
	}
	res, err := a.client.Do(req)
	if err != nil {
		return fmt.Errorf("do: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode >= 400 {
		body, _ := io.ReadAll(res.Body)
		return fmt.Errorf("otlp %s → %d: %s", url, res.StatusCode, body)
	}
	return nil
}

// resourceAttrs builds the OTLP resource block with the service name.
func (a *BaremetalAdapter) resourceAttrs() map[string]any {
	return map[string]any{
		"attributes": []map[string]any{
			{"key": "service.name", "value": map[string]any{"stringValue": a.serviceName}},
		},
	}
}

func attrPairs(labels map[string]string) []map[string]any {
	out := make([]map[string]any, 0, len(labels))
	for k, v := range labels {
		out = append(out, map[string]any{
			"key":   k,
			"value": map[string]any{"stringValue": v},
		})
	}
	return out
}

func (a *BaremetalAdapter) PushLogs(ctx context.Context, records []LogRecord) error {
	if len(records) == 0 {
		return nil
	}
	logRecords := make([]map[string]any, 0, len(records))
	for _, r := range records {
		logRecords = append(logRecords, map[string]any{
			"timeUnixNano":   strconv.FormatInt(r.Timestamp, 10),
			"severityText":   r.Severity,
			"body":           map[string]any{"stringValue": r.Body},
			"attributes":     attrPairs(r.Labels),
		})
	}
	payload := map[string]any{
		"resourceLogs": []map[string]any{{
			"resource": a.resourceAttrs(),
			"scopeLogs": []map[string]any{{
				"logRecords": logRecords,
			}},
		}},
	}
	return a.post(ctx, a.logsURL, payload)
}

func (a *BaremetalAdapter) PushMetrics(ctx context.Context, points []MetricPoint) error {
	if len(points) == 0 {
		return nil
	}
	metrics := make([]map[string]any, 0, len(points))
	for _, p := range points {
		metrics = append(metrics, map[string]any{
			"name": p.Name,
			"gauge": map[string]any{
				"dataPoints": []map[string]any{{
					"timeUnixNano": strconv.FormatInt(p.Timestamp, 10),
					"asDouble":     p.Value,
					"attributes":   attrPairs(p.Labels),
				}},
			},
		})
	}
	payload := map[string]any{
		"resourceMetrics": []map[string]any{{
			"resource": a.resourceAttrs(),
			"scopeMetrics": []map[string]any{{
				"metrics": metrics,
			}},
		}},
	}
	return a.post(ctx, a.metricsURL, payload)
}

func (a *BaremetalAdapter) PushTraces(ctx context.Context, spans []SpanRecord) error {
	if len(spans) == 0 {
		return nil
	}
	spanRecords := make([]map[string]any, 0, len(spans))
	for _, s := range spans {
		spanRecords = append(spanRecords, map[string]any{
			"traceId":           s.TraceID,
			"spanId":            s.SpanID,
			"name":              s.Name,
			"startTimeUnixNano": strconv.FormatInt(s.StartTimeNs, 10),
			"endTimeUnixNano":   strconv.FormatInt(s.EndTimeNs, 10),
			"attributes":        attrPairs(s.Attributes),
		})
	}
	payload := map[string]any{
		"resourceSpans": []map[string]any{{
			"resource": a.resourceAttrs(),
			"scopeSpans": []map[string]any{{
				"spans": spanRecords,
			}},
		}},
	}
	return a.post(ctx, a.tracesURL, payload)
}

// Compile-time interface conformance check.
var _ Adapter = (*BaremetalAdapter)(nil)
