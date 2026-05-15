// WorkflowTimeline — #92 / Discussion #76.
//
// Renders the lifecycle of a Temporal workflow as a step-by-step
// timeline. Consumes the `events.workflow` SSE channel via a parent-
// owned subscription — the component itself is pure presentation
// over `events()` + `error()` accessors. This separation keeps the
// L1 test surface synthetic (parent passes fixture events; no
// network) and lets the same component drive both the standalone
// /workflows route AND any in-flight modal / panel that needs a
// timeline (e.g., #20 tenant-create progress, #93 cluster mutation
// view).
//
// Event shape mirrors apps/api's `WorkflowStatusEvent` discriminated
// union exactly — `scope: "workflow"` carries lifecycle phases
// (started / succeeded / failed / cancelled); `scope: "step"`
// carries per-step phases (started / succeeded / failed) plus the
// `step` name. The type lives at apps/api/src/handlers/events.ts;
// imported type-only so esbuild strips at bundle time (the SPA never
// pulls apps/api runtime code).

import { For, Show, type Component } from "solid-js";

import type { WorkflowStatusEvent } from "../../../apps/api/src/handlers/events";

export type { WorkflowStatusEvent };

export interface WorkflowTimelineProps {
  workflowId: string;
  // Live event stream — parent owns the subscription. The accessor
  // shape lets Solid track reactivity through `For`.
  events: () => WorkflowStatusEvent[];
  // Optional subscription-error accessor. When set + truthy, the
  // timeline surfaces it instead of the empty-state.
  error?: () => string | null;
  // Optional retry callback. When the workflow phase reaches `failed`
  // and onRetry is supplied, the failure pane offers a Retry button.
  onRetry?: () => void;
}

// ── pure derivations ─────────────────────────────────────────────────────────
//
// Exported so L1 tests assert on the reducers without going through the
// component tree. Pure functions over an event list.

export interface TimelineDerived {
  workflowPhase: "pending" | "started" | "succeeded" | "failed" | "cancelled";
  workflowType: string | null;
  workflowError: string | null;
  steps: StepRow[];
  succeededStepCount: number;
}

export interface StepRow {
  name: string;
  phase: "started" | "succeeded" | "failed";
  startedAt: string | null;
  endedAt: string | null;
  error: string | null;
}

export function deriveTimeline(
  events: readonly WorkflowStatusEvent[],
): TimelineDerived {
  let workflowPhase: TimelineDerived["workflowPhase"] = "pending";
  let workflowType: string | null = null;
  let workflowError: string | null = null;
  // Step rows keyed by step name. Map preserves insertion order, which
  // matches arrival-of-first-event order — the natural timeline shape.
  const stepMap = new Map<string, StepRow>();

  for (const evt of events) {
    if (workflowType === null) workflowType = evt.workflowType;
    if (evt.scope === "workflow") {
      workflowPhase = evt.phase;
      workflowError = evt.error ?? null;
      continue;
    }
    // scope === "step"
    const existing = stepMap.get(evt.step);
    if (existing === undefined) {
      stepMap.set(evt.step, {
        name: evt.step,
        phase: evt.phase,
        startedAt: evt.phase === "started" ? evt.timestamp : null,
        endedAt: evt.phase === "started" ? null : evt.timestamp,
        error: evt.error ?? null,
      });
    } else {
      // Subsequent event for an already-known step — usually
      // `started → succeeded|failed`. Update phase + timestamps.
      existing.phase = evt.phase;
      if (evt.phase === "started") {
        existing.startedAt = evt.timestamp;
      } else {
        existing.endedAt = evt.timestamp;
      }
      if (evt.error) existing.error = evt.error;
    }
  }

  const steps = Array.from(stepMap.values());
  const succeededStepCount = steps.filter((s) => s.phase === "succeeded").length;

  return {
    workflowPhase,
    workflowType,
    workflowError,
    steps,
    succeededStepCount,
  };
}

// progressPercent — succeeded / total-observed, 0 when no steps have
// arrived yet. Total-observed (rather than a fixed denominator) means
// the bar reflects the live picture: as new steps arrive the
// denominator grows, and "completion" is when every observed step has
// succeeded AND the workflow itself is succeeded.
export function progressPercent(derived: TimelineDerived): number {
  if (derived.steps.length === 0) return 0;
  return Math.round((derived.succeededStepCount / derived.steps.length) * 100);
}

// ── component ────────────────────────────────────────────────────────────────

const WorkflowTimeline: Component<WorkflowTimelineProps> = (props) => {
  const derived = () => deriveTimeline(props.events());
  const pct = () => progressPercent(derived());

  return (
    <section aria-label="Workflow timeline" data-workflow-id={props.workflowId}>
      <header>
        <h2>Workflow {props.workflowId}</h2>
        <Show when={derived().workflowType}>
          {(type) => <p>Type: {type()}</p>}
        </Show>
        <p>Phase: {derived().workflowPhase}</p>
      </header>

      <Show when={props.error?.()}>
        {(err) => <p role="alert">Subscription error: {err()}</p>}
      </Show>

      <progress
        aria-label="Workflow progress"
        max="100"
        value={pct()}
      >
        {pct()}%
      </progress>
      <p>
        {derived().succeededStepCount} of {derived().steps.length} steps
        complete
      </p>

      <ol>
        <For each={derived().steps}>
          {(step) => (
            <li data-step={step.name} data-phase={step.phase}>
              <strong>{step.name}</strong> — {step.phase}
              <Show when={step.startedAt}>
                {(t) => <span> · started {t()}</span>}
              </Show>
              <Show when={step.endedAt}>
                {(t) => <span> · ended {t()}</span>}
              </Show>
              <Show when={step.error}>
                {(e) => <span class="step-error"> · {e()}</span>}
              </Show>
            </li>
          )}
        </For>
      </ol>

      <Show when={derived().workflowPhase === "failed"}>
        <div role="alert">
          <p>Workflow failed.</p>
          <Show when={derived().workflowError}>
            {(err) => <p>{err()}</p>}
          </Show>
          <Show when={props.onRetry}>
            {(_handler) => (
              <button type="button" onClick={() => props.onRetry?.()}>
                Retry
              </button>
            )}
          </Show>
        </div>
      </Show>
    </section>
  );
};

export default WorkflowTimeline;
