// Workflows route — Phase C wired the subscription inline (#91 / #192);
// #92 extracts the timeline rendering into a reusable WorkflowTimeline
// component. The route owns subscription lifecycle (mount / unmount,
// event accumulation, error state); the component owns presentation.
//
// The workflowId is still a placeholder — a real workflow-table click
// (separate Issue) replaces the sentinel id. The route renders the
// "no events yet" state until that landing.

import { type Component } from "solid-js";
import { createSignal, onCleanup, onMount } from "solid-js";

import AppShell from "../components/AppShell";
import WorkflowTimeline, {
  type WorkflowStatusEvent,
} from "../components/WorkflowTimeline";
import { useAuth } from "../lib/auth";
import { monok8sClient } from "../lib/trpc";

// Placeholder workflowId — the real value comes from a workflow-table
// row click (sibling Issue). For now the SSE channel connects to a
// tenant-uuid-prefixed sentinel that yields no events; the timeline
// renders the empty "connected, waiting" state.
function placeholderWorkflowId(tenantId: string): string {
  return `tnt-${tenantId}-phase-c-placeholder`;
}

const Workflows: Component = () => {
  const { user } = useAuth();
  const [events, setEvents] = createSignal<WorkflowStatusEvent[]>([]);
  const [error, setError] = createSignal<string | null>(null);
  const [workflowId, setWorkflowId] = createSignal<string>("");

  onMount(() => {
    const u = user();
    if (!u) return;
    const id = placeholderWorkflowId(u.tenantId);
    setWorkflowId(id);
    const sub = monok8sClient.events.workflow.subscribe(
      { workflowId: id },
      {
        onData: (evt) =>
          setEvents((prev) => [...prev, evt as WorkflowStatusEvent]),
        onError: (err) => setError(err.message),
      },
    );
    onCleanup(() => sub.unsubscribe());
  });

  return (
    <AppShell>
      <h1>Workflows</h1>
      {workflowId() ? (
        <WorkflowTimeline
          workflowId={workflowId()}
          events={events}
          error={error}
        />
      ) : (
        <p>Loading…</p>
      )}
      <p>
        TODO: workflow-table picker drops the placeholder workflowId in
        favor of a real row click. Sibling Issue closes when the table
        view lands.
      </p>
    </AppShell>
  );
};

export default Workflows;
