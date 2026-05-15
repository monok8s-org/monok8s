// L1 unit tests for AuditLogView (#94). Pure helpers (most cases) +
// render (visible state) + parent-callback wiring (filter change /
// load more). Same pattern as WorkflowTimeline (#92) — synthetic
// accessors, no network.

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { fireEvent, render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";

import AuditLogView, {
  applyClientFilters,
  envelopeToUnified,
  historyRowToUnified,
  toCsv,
  unifyRows,
  type AuditEnvelope,
  type AuditFilters,
  type AuditLog,
  type AuditRow,
} from "./AuditLogView";

afterEach(() => {
  // jsdom + Solid-testing-library handle their own cleanup.
});

const TENANT = "00000000-0000-0000-0000-000000000001";
const PRINCIPAL = "00000000-0000-0000-0000-0000000000aa";
const PRINCIPAL_B = "00000000-0000-0000-0000-0000000000bb";
const T = "2026-05-13T20:00:00.000Z";
const T_LATER = "2026-05-13T20:01:00.000Z";
const T_EVEN_LATER = "2026-05-13T20:02:00.000Z";

function historyRow(overrides: Partial<AuditLog> = {}): AuditLog {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    tenant_id: TENANT,
    principal_id: PRINCIPAL,
    principal_type: "user",
    action: "tenant.create",
    target_kind: "tenant",
    target_id: "00000000-0000-0000-0000-000000000099",
    outcome: "success",
    error_message: null,
    metadata: null,
    created_at: new Date(T),
    ...overrides,
  };
}

function envelope(overrides: Partial<AuditEnvelope> = {}): AuditEnvelope {
  return {
    principal: { id: PRINCIPAL, type: "user" },
    action: "audit.ping",
    target: { kind: "audit", id: "ping" },
    outcome: "success",
    timestamp: T_LATER,
    ...overrides,
  };
}

// ── historyRowToUnified ──────────────────────────────────────────────────────

describe("historyRowToUnified", () => {
  test("maps every wire field + tags source=history", () => {
    const u = historyRowToUnified(
      historyRow({
        id: "row-id-1",
        action: "tenant.create",
        principal_id: PRINCIPAL,
        target_kind: "tenant",
        target_id: "tnt-9",
        outcome: "success",
      }),
    );
    expect(u.source).toBe("history");
    expect(u.key).toBe("row-id-1");
    expect(u.action).toBe("tenant.create");
    expect(u.principalId).toBe(PRINCIPAL);
    expect(u.targetKind).toBe("tenant");
    expect(u.targetId).toBe("tnt-9");
  });

  test("normalizes Date created_at to ISO-8601 string", () => {
    const u = historyRowToUnified(historyRow({ created_at: new Date(T) }));
    expect(u.timestamp).toBe(T);
  });
});

// ── envelopeToUnified ────────────────────────────────────────────────────────

describe("envelopeToUnified", () => {
  test("maps envelope shape + tags source=live", () => {
    const u = envelopeToUnified(envelope());
    expect(u.source).toBe("live");
    expect(u.action).toBe("audit.ping");
    expect(u.principalId).toBe(PRINCIPAL);
  });

  test("synthesizes a deterministic key from action+principal+timestamp", () => {
    const a = envelopeToUnified(envelope());
    const b = envelopeToUnified(envelope());
    expect(a.key).toBe(b.key);
  });

  test("nullable fields (targetId, errorMessage, metadata) coerce to null", () => {
    const u = envelopeToUnified({
      principal: { id: PRINCIPAL, type: "user" },
      action: "x",
      target: { kind: "y", id: undefined },
      outcome: "success",
      timestamp: T,
    });
    expect(u.targetId).toBeNull();
    expect(u.errorMessage).toBeNull();
    expect(u.metadata).toBeNull();
  });
});

// ── unifyRows ────────────────────────────────────────────────────────────────

describe("unifyRows", () => {
  test("sorts by timestamp DESC across history + live", () => {
    const rows = unifyRows(
      [historyRow({ created_at: new Date(T) })],
      [envelope({ timestamp: T_LATER, action: "live.b" })],
    );
    expect(rows.map((r) => r.timestamp)).toEqual([T_LATER, T]);
  });

  test("dedupes when live envelope has same (action,principal,timestamp) as history row", () => {
    const rows = unifyRows(
      [
        historyRow({
          id: "real-id",
          action: "audit.ping",
          principal_id: PRINCIPAL,
          created_at: new Date(T),
        }),
      ],
      [
        envelope({
          action: "audit.ping",
          principal: { id: PRINCIPAL, type: "user" },
          timestamp: T,
        }),
      ],
    );
    expect(rows).toHaveLength(1);
    // History wins the dedupe slot — it has the real DB id.
    expect(rows[0]!.source).toBe("history");
    expect(rows[0]!.key).toBe("real-id");
  });

  test("history-only or live-only input both work", () => {
    expect(unifyRows([historyRow()], [])).toHaveLength(1);
    expect(unifyRows([], [envelope()])).toHaveLength(1);
    expect(unifyRows([], [])).toHaveLength(0);
  });
});

// ── applyClientFilters ───────────────────────────────────────────────────────

function unifiedFixture(overrides: Partial<AuditRow> = {}): AuditRow {
  return {
    source: "live",
    key: "k-1",
    timestamp: T,
    action: "tenant.create",
    principalId: PRINCIPAL,
    principalType: "user",
    targetKind: "tenant",
    targetId: null,
    outcome: "success",
    errorMessage: null,
    metadata: null,
    ...overrides,
  };
}

describe("applyClientFilters", () => {
  test("empty filters → pass", () => {
    expect(applyClientFilters(unifiedFixture(), {})).toBe(true);
  });

  test("action mismatch → reject", () => {
    expect(
      applyClientFilters(unifiedFixture({ action: "tenant.create" }), {
        action: "tenant.delete",
      }),
    ).toBe(false);
  });

  test("action match → pass", () => {
    expect(
      applyClientFilters(unifiedFixture({ action: "tenant.create" }), {
        action: "tenant.create",
      }),
    ).toBe(true);
  });

  test("principalId mismatch → reject", () => {
    expect(
      applyClientFilters(unifiedFixture({ principalId: PRINCIPAL }), {
        principalId: PRINCIPAL_B,
      }),
    ).toBe(false);
  });

  test("since: row.timestamp before since → reject", () => {
    expect(
      applyClientFilters(unifiedFixture({ timestamp: T }), {
        since: T_LATER,
      }),
    ).toBe(false);
  });

  test("since: row.timestamp at-or-after since → pass", () => {
    expect(
      applyClientFilters(unifiedFixture({ timestamp: T_LATER }), {
        since: T,
      }),
    ).toBe(true);
  });

  test("until: row.timestamp at-or-after until → reject (strict upper bound)", () => {
    expect(
      applyClientFilters(unifiedFixture({ timestamp: T_LATER }), {
        until: T_LATER,
      }),
    ).toBe(false);
  });
});

// ── toCsv ────────────────────────────────────────────────────────────────────

describe("toCsv", () => {
  test("empty rows produces header-only output", () => {
    const csv = toCsv([]);
    const lines = csv.trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("timestamp");
    expect(lines[0]).toContain("action");
  });

  test("emits one line per row + header", () => {
    const csv = toCsv([
      unifiedFixture({ timestamp: T, action: "a" }),
      unifiedFixture({ timestamp: T_LATER, action: "b" }),
    ]);
    const lines = csv.trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain("a");
    expect(lines[2]).toContain("b");
  });

  test("quotes fields containing commas / newlines / double-quotes", () => {
    const csv = toCsv([
      unifiedFixture({
        errorMessage: 'bad, "very bad",\nworst',
      }),
    ]);
    // Quoted literal contains the original commas + escaped double-quotes.
    expect(csv).toContain('"bad, ""very bad"",\nworst"');
  });

  test("null / undefined cells render as empty strings", () => {
    const csv = toCsv([
      unifiedFixture({ targetId: null, errorMessage: null, metadata: null }),
    ]);
    // The target_id column should be empty.
    const dataLine = csv.split("\n")[1]!;
    expect(dataLine.split(",")).toContain("");
  });

  test("metadata object serializes as JSON", () => {
    const csv = toCsv([
      unifiedFixture({ metadata: { note: "hello" } }),
    ]);
    expect(csv).toContain("note");
  });
});

// ── render ───────────────────────────────────────────────────────────────────

describe("AuditLogView render", () => {
  test("renders one row per unified entry", () => {
    const { container } = render(() => (
      <AuditLogView
        history={() => [historyRow()]}
        live={() => []}
        filters={() => ({})}
        onFiltersChange={() => {}}
      />
    ));
    const rows = container.querySelectorAll("tbody tr");
    expect(rows.length).toBe(1);
  });

  test("subscription error surfaces in an alert region", () => {
    const { getByRole } = render(() => (
      <AuditLogView
        history={() => []}
        live={() => []}
        error={() => "ws closed"}
        filters={() => ({})}
        onFiltersChange={() => {}}
      />
    ));
    const alert = getByRole("alert");
    expect(alert.textContent).toContain("ws closed");
  });

  test("empty-state copy when no rows + not loading", () => {
    const { getByText } = render(() => (
      <AuditLogView
        history={() => []}
        live={() => []}
        filters={() => ({})}
        onFiltersChange={() => {}}
      />
    ));
    expect(getByText(/No audit entries/)).toBeTruthy();
  });

  test("Load more button calls onLoadMore", () => {
    const onLoadMore = jest.fn();
    const { getByRole } = render(() => (
      <AuditLogView
        history={() => [historyRow()]}
        live={() => []}
        filters={() => ({})}
        onFiltersChange={() => {}}
        hasMore={() => true}
        onLoadMore={onLoadMore}
      />
    ));
    fireEvent.click(getByRole("button", { name: "Load more" }));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  test("action filter input fires onFiltersChange", () => {
    const onFiltersChange = jest.fn();
    const { container } = render(() => (
      <AuditLogView
        history={() => []}
        live={() => []}
        filters={() => ({})}
        onFiltersChange={onFiltersChange}
      />
    ));
    const input = container.querySelector(
      'input[name="action"]',
    ) as HTMLInputElement;
    fireEvent.input(input, { target: { value: "tenant.create" } });
    expect(onFiltersChange).toHaveBeenCalledWith({ action: "tenant.create" });
  });

  test("filtered live envelopes are filtered by current filters", () => {
    const [filters] = createSignal<AuditFilters>({ action: "audit.ping" });
    const { container } = render(() => (
      <AuditLogView
        history={() => []}
        live={() => [
          envelope({ action: "audit.ping", timestamp: T }),
          envelope({ action: "tenant.create", timestamp: T_LATER }),
        ]}
        filters={filters}
        onFiltersChange={() => {}}
      />
    ));
    // Only the audit.ping live envelope passes the filter.
    expect(container.querySelectorAll("tbody tr").length).toBe(1);
  });

  test("live reactivity — appending an envelope re-renders", () => {
    const [live, setLive] = createSignal<AuditEnvelope[]>([]);
    const { container } = render(() => (
      <AuditLogView
        history={() => []}
        live={live}
        filters={() => ({})}
        onFiltersChange={() => {}}
      />
    ));
    expect(container.querySelectorAll("tbody tr").length).toBe(0);
    setLive([envelope()]);
    expect(container.querySelectorAll("tbody tr").length).toBe(1);
  });

  // Use a synthetic timestamp far in the future so the "Even later" envelope
  // sorts on top — verifies the unifyRows DESC ordering survives render.
  test("rows render in timestamp-DESC order", () => {
    const { container } = render(() => (
      <AuditLogView
        history={() => [historyRow({ created_at: new Date(T) })]}
        live={() => [envelope({ timestamp: T_EVEN_LATER })]}
        filters={() => ({})}
        onFiltersChange={() => {}}
      />
    ));
    const cells = Array.from(container.querySelectorAll("tbody tr td:first-child"));
    expect(cells[0]?.textContent).toBe(T_EVEN_LATER);
    expect(cells[1]?.textContent).toBe(T);
  });
});
