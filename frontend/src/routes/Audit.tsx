// Audit route — Phase C wired the events.audit SSE inline (#91 /
// #192); #94 extracts the timeline into a reusable AuditLogView
// component and adds the historical-list half via audit.list (#208).
//
// The route owns subscription lifecycle + query state + filter state;
// the component is pure presentation. Same separation as
// WorkflowTimeline (#92).

import { type Component } from "solid-js";
import { createResource, createSignal, onCleanup, onMount } from "solid-js";

import AppShell from "../components/AppShell";
import AuditLogView, {
  type AuditEnvelope,
  type AuditFilters,
  type AuditLog,
} from "../components/AuditLogView";
import { monok8sClient } from "../lib/trpc";

const PAGE_SIZE = 50;

const Audit: Component = () => {
  const [filters, setFilters] = createSignal<AuditFilters>({});
  const [error, setError] = createSignal<string | null>(null);
  const [live, setLive] = createSignal<AuditEnvelope[]>([]);
  // Pagination state — `before` cursor for the next page.
  const [before, setBefore] = createSignal<string | null>(null);
  const [historyAccum, setHistoryAccum] = createSignal<AuditLog[]>([]);

  // Historical query — refetches when filters or `before` change.
  // Solid's createResource memoizes on the source signal; we project
  // filters + before into a single tuple for the source.
  const [page] = createResource(
    () => ({ filters: filters(), before: before() }),
    async ({ filters, before }) => {
      const result = (await monok8sClient.audit.list.query({
        ...filters,
        before: before ?? undefined,
        limit: PAGE_SIZE,
      })) as unknown as AuditLog[];
      return result;
    },
  );

  // Accumulate paginated pages into a flat history list. Resetting on
  // filter change (`before === null`) clears the accumulator.
  const handlePageLanded = (rows: AuditLog[]) => {
    if (before() === null) {
      setHistoryAccum(rows);
    } else {
      setHistoryAccum((prev) => [...prev, ...rows]);
    }
  };

  // createResource doesn't expose a "row landed" hook directly; the
  // memo below mirrors `page()` into the accumulator. Solid runs
  // memos eagerly when their dependency settles.
  const accumDriver = () => {
    const result = page();
    if (result !== undefined) handlePageLanded(result);
    return result;
  };

  onMount(() => {
    // Live tail — independent of filter state; applyClientFilters in
    // the component filters envelopes against the current filters.
    const sub = monok8sClient.events.audit.subscribe(undefined, {
      onData: (evt) => setLive((prev) => [...prev, evt as AuditEnvelope]),
      onError: (err) => setError(err.message),
    });
    onCleanup(() => sub.unsubscribe());
  });

  const handleFiltersChange = (next: AuditFilters) => {
    // Reset pagination on filter change.
    setBefore(null);
    setHistoryAccum([]);
    setFilters(next);
  };

  const handleLoadMore = () => {
    const history = historyAccum();
    if (history.length === 0) return;
    const oldest = history[history.length - 1]!;
    const cursor =
      oldest.created_at instanceof Date
        ? oldest.created_at.toISOString()
        : String(oldest.created_at);
    setBefore(cursor);
  };

  const hasMore = () => {
    // No total-count from audit.list; "hasMore" is "the last page
    // returned a full PAGE_SIZE — there may be more behind it".
    const latest = page();
    return latest !== undefined && latest.length === PAGE_SIZE;
  };

  // Touch accumDriver so the memo runs and feeds the accumulator.
  // createResource's reactivity tracking otherwise lets the page()
  // call slip past if nothing reads it.
  return (
    <AppShell>
      <h1>Audit log</h1>
      {(() => {
        accumDriver();
        return null;
      })()}
      <AuditLogView
        history={historyAccum}
        live={live}
        error={error}
        loading={() => page.loading}
        filters={filters}
        onFiltersChange={handleFiltersChange}
        hasMore={hasMore}
        onLoadMore={handleLoadMore}
      />
    </AppShell>
  );
};

export default Audit;
