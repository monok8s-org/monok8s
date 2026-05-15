// L1 unit tests for WorkflowTimeline (#92). Two layers:
//
//   1. Pure-derivation tests on deriveTimeline + progressPercent —
//      these are the reducers; they own most of the logic.
//   2. Render tests via @solidjs/testing-library — assert the
//      rendered DOM reflects the derived state and that onRetry
//      wires correctly when present + workflow phase is failed.
//
// Events use the canonical apps/api `WorkflowStatusEvent` shape.

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { fireEvent, render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";

import WorkflowTimeline, {
  deriveTimeline,
  progressPercent,
  type WorkflowStatusEvent,
} from "./WorkflowTimeline";

afterEach(() => {
  // jsdom doesn't reset between tests; @solidjs/testing-library handles
  // its own cleanup, but explicit safety net for any shared state.
});

const WORKFLOW_ID = "tnt-00000000-0000-0000-0000-000000000001-onboard-1";
const T = "2026-05-13T20:00:00.000Z";
const T_LATER = "2026-05-13T20:01:00.000Z";

function workflowStart(): WorkflowStatusEvent {
  return {
    scope: "workflow",
    workflowId: WORKFLOW_ID,
    workflowType: "monok8s.onboarding",
    tenantId: "00000000-0000-0000-0000-000000000001",
    phase: "started",
    timestamp: T,
  };
}

function workflowFinal(
  phase: "succeeded" | "failed" | "cancelled",
  error?: string,
): WorkflowStatusEvent {
  return {
    scope: "workflow",
    workflowId: WORKFLOW_ID,
    workflowType: "monok8s.onboarding",
    tenantId: "00000000-0000-0000-0000-000000000001",
    phase,
    timestamp: T_LATER,
    error,
  };
}

function stepEvent(
  step: string,
  phase: "started" | "succeeded" | "failed",
  timestamp = T,
  error?: string,
): WorkflowStatusEvent {
  return {
    scope: "step",
    workflowId: WORKFLOW_ID,
    workflowType: "monok8s.onboarding",
    tenantId: "00000000-0000-0000-0000-000000000001",
    step,
    phase,
    timestamp,
    error,
  };
}

// ── deriveTimeline ───────────────────────────────────────────────────────────

describe("deriveTimeline", () => {
  test("empty event list returns pending phase + no steps", () => {
    const d = deriveTimeline([]);
    expect(d.workflowPhase).toBe("pending");
    expect(d.workflowType).toBeNull();
    expect(d.workflowError).toBeNull();
    expect(d.steps).toEqual([]);
    expect(d.succeededStepCount).toBe(0);
  });

  test("workflow.started populates phase + type", () => {
    const d = deriveTimeline([workflowStart()]);
    expect(d.workflowPhase).toBe("started");
    expect(d.workflowType).toBe("monok8s.onboarding");
  });

  test("step events accumulate in arrival order", () => {
    const d = deriveTimeline([
      workflowStart(),
      stepEvent("provision_namespace", "started", T),
      stepEvent("provision_database", "started", T),
    ]);
    expect(d.steps).toHaveLength(2);
    expect(d.steps[0]!.name).toBe("provision_namespace");
    expect(d.steps[1]!.name).toBe("provision_database");
  });

  test("step lifecycle merges started+succeeded into one row", () => {
    const d = deriveTimeline([
      stepEvent("provision_namespace", "started", T),
      stepEvent("provision_namespace", "succeeded", T_LATER),
    ]);
    expect(d.steps).toHaveLength(1);
    const step = d.steps[0]!;
    expect(step.phase).toBe("succeeded");
    expect(step.startedAt).toBe(T);
    expect(step.endedAt).toBe(T_LATER);
  });

  test("failed step carries error detail forward", () => {
    const d = deriveTimeline([
      stepEvent("provision_database", "started", T),
      stepEvent(
        "provision_database",
        "failed",
        T_LATER,
        "Timeout waiting for CNPG cluster ready",
      ),
    ]);
    expect(d.steps[0]!.phase).toBe("failed");
    expect(d.steps[0]!.error).toBe(
      "Timeout waiting for CNPG cluster ready",
    );
  });

  test("workflow.failed carries top-level error", () => {
    const d = deriveTimeline([
      workflowStart(),
      workflowFinal("failed", "Activity failure"),
    ]);
    expect(d.workflowPhase).toBe("failed");
    expect(d.workflowError).toBe("Activity failure");
  });

  test("succeededStepCount counts only succeeded steps", () => {
    const d = deriveTimeline([
      stepEvent("a", "succeeded", T),
      stepEvent("b", "succeeded", T),
      stepEvent("c", "failed", T),
      stepEvent("d", "started", T),
    ]);
    expect(d.succeededStepCount).toBe(2);
    expect(d.steps).toHaveLength(4);
  });
});

// ── progressPercent ──────────────────────────────────────────────────────────

describe("progressPercent", () => {
  test("0 when no steps observed", () => {
    expect(progressPercent(deriveTimeline([]))).toBe(0);
  });

  test("100 when every observed step succeeded", () => {
    const d = deriveTimeline([
      stepEvent("a", "succeeded", T),
      stepEvent("b", "succeeded", T),
    ]);
    expect(progressPercent(d)).toBe(100);
  });

  test("50 when half the observed steps succeeded", () => {
    const d = deriveTimeline([
      stepEvent("a", "succeeded", T),
      stepEvent("b", "started", T),
    ]);
    expect(progressPercent(d)).toBe(50);
  });
});

// ── render ───────────────────────────────────────────────────────────────────

describe("WorkflowTimeline render", () => {
  test("renders workflow id + phase + step count", () => {
    const events: WorkflowStatusEvent[] = [
      workflowStart(),
      stepEvent("provision_namespace", "succeeded", T_LATER),
    ];
    const { getByText, container } = render(() => (
      <WorkflowTimeline workflowId={WORKFLOW_ID} events={() => events} />
    ));
    expect(getByText(`Workflow ${WORKFLOW_ID}`)).toBeTruthy();
    expect(getByText("Phase: started")).toBeTruthy();
    expect(getByText("1 of 1 steps complete")).toBeTruthy();
    const stepEl = container.querySelector(
      "[data-step='provision_namespace'][data-phase='succeeded']",
    );
    expect(stepEl).toBeTruthy();
  });

  test("subscription error surfaces in an alert region", () => {
    const events: WorkflowStatusEvent[] = [];
    const { getByRole } = render(() => (
      <WorkflowTimeline
        workflowId={WORKFLOW_ID}
        events={() => events}
        error={() => "ws closed"}
      />
    ));
    const alert = getByRole("alert");
    expect(alert.textContent).toContain("ws closed");
  });

  test("failed workflow surfaces Retry button when onRetry supplied", () => {
    const onRetry = jest.fn();
    const events: WorkflowStatusEvent[] = [
      workflowStart(),
      workflowFinal("failed", "Step provision_database failed"),
    ];
    const { getByRole } = render(() => (
      <WorkflowTimeline
        workflowId={WORKFLOW_ID}
        events={() => events}
        onRetry={onRetry}
      />
    ));
    const btn = getByRole("button", { name: "Retry" });
    fireEvent.click(btn);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  test("failed workflow without onRetry omits the Retry button", () => {
    const events: WorkflowStatusEvent[] = [
      workflowStart(),
      workflowFinal("failed"),
    ];
    const { queryByRole } = render(() => (
      <WorkflowTimeline workflowId={WORKFLOW_ID} events={() => events} />
    ));
    expect(queryByRole("button", { name: "Retry" })).toBeNull();
  });

  test("live reactivity — appending an event re-renders", () => {
    const [events, setEvents] = createSignal<WorkflowStatusEvent[]>([
      workflowStart(),
    ]);
    const { getByText } = render(() => (
      <WorkflowTimeline workflowId={WORKFLOW_ID} events={events} />
    ));
    expect(getByText("0 of 0 steps complete")).toBeTruthy();
    setEvents([...events(), stepEvent("a", "succeeded", T_LATER)]);
    expect(getByText("1 of 1 steps complete")).toBeTruthy();
  });
});
