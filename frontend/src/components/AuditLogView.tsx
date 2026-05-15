// AuditLogView — #94 / Discussion #76.
//
// Two-source audit display: paginated history from
// `audit.list.query` (#208) + live tail from
// `events.audit.subscribe` (#88c). The parent route owns wire
// access; the component is pure presentation over the accessors it
// receives. Same split as WorkflowTimeline (#92) — keeps L1 tests
// synthetic (parent passes fixture rows; no network).
//
// Wire shapes diverge between the two sources:
//   - `AuditLog` (apps/api → packages/db) — historical rows from the
//     audit_log table; primary keys + per-tenant FK already present.
//   - `AuditEnvelope` (packages/auth) — in-memory envelopes the
//     auditMiddleware emits; identifier-less since the DB row's id
//     is assigned at INSERT time.
//
// `unifyRows` normalizes both into a single `AuditRow` ordered by
// timestamp DESC. Live envelopes are decorated with `_source: "live"`
// so the row component can render a "live" chip; once a refresh fires
// audit.list will return the persisted versions and `unifyRows` dedups
// by (action, principal_id, timestamp).

import { For, Show, type Component } from "solid-js";
import { createMemo } from "solid-js";

import type { AuditEnvelope } from "@monok8s/auth";
import type { AuditLog } from "@monok8s/db";

export type { AuditEnvelope, AuditLog };

// ── unified row shape ────────────────────────────────────────────────────────

export interface AuditRow {
  source: "history" | "live";
  // Stable identifier — for history rows, the DB id; for live rows
  // we synthesize a deterministic key from (action + principal_id +
  // timestamp) so dedupe works without a real id.
  key: string;
  timestamp: string;
  action: string;
  principalId: string;
  principalType?: "user" | "service_account";
  targetKind: string;
  targetId: string | null;
  outcome: "success" | "error";
  errorMessage: string | null;
  metadata: Record<string, unknown> | null;
}

export interface AuditFilters {
  action?: string;
  principalId?: string;
  // ISO-8601 inclusive lower bound; null means "from the start of
  // recorded time" (no filter).
  since?: string | null;
  // ISO-8601 strict upper bound (cursor semantics — `created_at < $before`).
  until?: string | null;
}

// ── pure helpers — exported for L1 tests ─────────────────────────────────────

export function historyRowToUnified(row: AuditLog): AuditRow {
  return {
    source: "history",
    key: row.id,
    timestamp:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : String(row.created_at),
    action: row.action,
    principalId: row.principal_id,
    principalType: row.principal_type,
    targetKind: row.target_kind,
    targetId: row.target_id,
    outcome: row.outcome,
    errorMessage: row.error_message,
    metadata: row.metadata,
  };
}

export function envelopeToUnified(env: AuditEnvelope): AuditRow {
  return {
    source: "live",
    // Synthetic key — composite of envelope identity. Matches the
    // dedupe semantics in unifyRows.
    key: `${env.action}|${env.principal.id}|${env.timestamp}`,
    timestamp: env.timestamp,
    action: env.action,
    principalId: env.principal.id,
    principalType: env.principal.type,
    targetKind: env.target.kind,
    targetId: env.target.id ?? null,
    outcome: env.outcome,
    errorMessage: env.error ?? null,
    metadata: env.metadata ?? null,
  };
}

// unifyRows — merge history + live, dedupe by (action, principal_id,
// timestamp), sort by timestamp DESC. History wins on dedupe (it
// carries a real id; live's synthetic key is just for display).
export function unifyRows(
  history: readonly AuditLog[],
  live: readonly AuditEnvelope[],
): AuditRow[] {
  const seen = new Set<string>();
  const out: AuditRow[] = [];

  // History first so its real ids occupy the dedupe slots.
  for (const r of history) {
    const row = historyRowToUnified(r);
    const dedupeKey = `${row.action}|${row.principalId}|${row.timestamp}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(row);
  }

  for (const env of live) {
    const row = envelopeToUnified(env);
    const dedupeKey = `${row.action}|${row.principalId}|${row.timestamp}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(row);
  }

  // Stable sort by timestamp DESC; Array.prototype.sort is stable in
  // modern V8 / SpiderMonkey / JSC, so equal timestamps preserve
  // insertion order (history first).
  out.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
  return out;
}

// applyClientFilters — events.audit doesn't take filters server-side;
// to keep the live-tail aligned with the user's filter state, we
// filter envelopes client-side using the same predicates as the
// audit.list backend would have applied.
export function applyClientFilters(
  row: AuditRow,
  filters: AuditFilters,
): boolean {
  if (filters.action && row.action !== filters.action) return false;
  if (filters.principalId && row.principalId !== filters.principalId) {
    return false;
  }
  if (filters.since && row.timestamp < filters.since) return false;
  if (filters.until && row.timestamp >= filters.until) return false;
  return true;
}

// toCsv — CSV-ize the visible rows. Spec uses RFC 4180 quoting so
// commas + newlines + double-quotes inside fields survive the
// round-trip. Header line names match the AuditRow fields the user
// sees in the table.
const CSV_HEADERS = [
  "timestamp",
  "action",
  "principal_id",
  "principal_type",
  "target_kind",
  "target_id",
  "outcome",
  "error_message",
  "metadata",
] as const;

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = typeof value === "string" ? value : JSON.stringify(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function toCsv(rows: readonly AuditRow[]): string {
  const lines = [CSV_HEADERS.join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.timestamp,
        row.action,
        row.principalId,
        row.principalType ?? "",
        row.targetKind,
        row.targetId ?? "",
        row.outcome,
        row.errorMessage ?? "",
        row.metadata,
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return lines.join("\n") + "\n";
}

// ── component ────────────────────────────────────────────────────────────────

export interface AuditLogViewProps {
  // Historical rows from audit.list.query. Parent owns the resource +
  // pagination state.
  history: () => AuditLog[];
  // Live envelopes from events.audit.subscribe.
  live: () => AuditEnvelope[];
  // Subscription / query error surfacing.
  error?: () => string | null;
  // Whether the historical query is currently loading.
  loading?: () => boolean;
  // Filter form is parent-owned (so URL-fragment persistence is
  // possible without component-internal state). The component reads
  // current filter state for client-side filtering of live rows.
  filters: () => AuditFilters;
  onFiltersChange: (next: AuditFilters) => void;
  // Pagination — parent extends the history list with each "Load more".
  onLoadMore?: () => void;
  hasMore?: () => boolean;
}

const AuditLogView: Component<AuditLogViewProps> = (props) => {
  // unified runs through createMemo so reactivity tracks both
  // accessors. applyClientFilters runs against live entries (history
  // is assumed pre-filtered server-side by audit.list — the parent
  // route refetches when filter state changes).
  const unified = createMemo(() => {
    const filters = props.filters();
    const liveFiltered = props
      .live()
      .filter((env) => applyClientFilters(envelopeToUnified(env), filters));
    return unifyRows(props.history(), liveFiltered);
  });

  const handleFilterChange = (
    field: keyof AuditFilters,
    value: string,
  ) => {
    const cur = props.filters();
    props.onFiltersChange({
      ...cur,
      [field]: value || undefined,
    });
  };

  const handleCsvExport = () => {
    const csv = toCsv(unified());
    if (typeof document === "undefined") return;
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `audit-log-${new Date().toISOString()}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section aria-label="Audit log view">
      <form
        aria-label="Audit filters"
        onSubmit={(e) => e.preventDefault()}
      >
        <label>
          Action
          <input
            name="action"
            type="text"
            value={props.filters().action ?? ""}
            onInput={(e) =>
              handleFilterChange("action", e.currentTarget.value)
            }
          />
        </label>
        <label>
          Principal ID
          <input
            name="principalId"
            type="text"
            value={props.filters().principalId ?? ""}
            onInput={(e) =>
              handleFilterChange("principalId", e.currentTarget.value)
            }
          />
        </label>
        <label>
          Since
          <input
            name="since"
            type="datetime-local"
            value={props.filters().since ?? ""}
            onInput={(e) =>
              handleFilterChange("since", e.currentTarget.value)
            }
          />
        </label>
        <label>
          Until
          <input
            name="until"
            type="datetime-local"
            value={props.filters().until ?? ""}
            onInput={(e) =>
              handleFilterChange("until", e.currentTarget.value)
            }
          />
        </label>
        <button type="button" onClick={handleCsvExport}>
          Export CSV
        </button>
      </form>

      <Show when={props.error?.()}>
        {(err) => <p role="alert">Audit-log error: {err()}</p>}
      </Show>

      <Show when={props.loading?.()}>
        <p>Loading audit log…</p>
      </Show>

      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Action</th>
            <th>Principal</th>
            <th>Target</th>
            <th>Outcome</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          <For each={unified()}>
            {(row) => (
              <tr
                data-source={row.source}
                data-outcome={row.outcome}
                data-key={row.key}
              >
                <td>{row.timestamp}</td>
                <td>{row.action}</td>
                <td>
                  {row.principalId}
                  <Show when={row.principalType}>
                    {(t) => <span> ({t()})</span>}
                  </Show>
                </td>
                <td>
                  {row.targetKind}
                  <Show when={row.targetId}>
                    {(id) => <span>: {id()}</span>}
                  </Show>
                </td>
                <td>{row.outcome}</td>
                <td>
                  <Show when={row.errorMessage}>
                    {(msg) => <span>{msg()}</span>}
                  </Show>
                </td>
              </tr>
            )}
          </For>
        </tbody>
      </table>

      <Show when={unified().length === 0 && !props.loading?.()}>
        <p>No audit entries match the current filters.</p>
      </Show>

      <Show when={props.hasMore?.() && props.onLoadMore}>
        <button type="button" onClick={() => props.onLoadMore?.()}>
          Load more
        </button>
      </Show>
    </section>
  );
};

export default AuditLogView;
