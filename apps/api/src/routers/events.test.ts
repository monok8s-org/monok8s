// L1 unit tests for events.ts (#88a + #88b + #88c).
//
// The subscription body is small (parse + emit.next / emit.error) and
// the canonical coverage is the L2 itest under apps/api/test/. These
// tests cover only the regression-guard surface — the router shape and
// the envelope-type imports.

import { describe, expect, test } from "@jest/globals";
import type { AuditEnvelope } from "@monok8s/auth";

import {
  eventsRouter,
  type TenantEvent,
  type WorkflowStatusEvent,
} from "./events.js";

describe("eventsRouter shape", () => {
  test("exposes the tenant + workflow + audit subscription procedures", () => {
    expect(eventsRouter).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const procs = (eventsRouter as any)._def.procedures;
    expect(procs).toBeDefined();
    expect(procs["tenant"]).toBeDefined();
    // workflow procedure landed with #177.
    expect(procs["workflow"]).toBeDefined();
    // audit procedure landed with #179.
    expect(procs["audit"]).toBeDefined();
  });

  test("AuditEnvelope type imports from @monok8s/auth (regression guard for #179)", () => {
    // Compile-time assertion: if @monok8s/auth's audit surface drifts
    // (renames, removes fields), this test fails to compile.
    const sample: AuditEnvelope = {
      principal: { id: "user-x", type: "user" },
      action: "audit.ping",
      target: { kind: "audit", id: "ping" },
      outcome: "success",
      timestamp: "2026-05-13T13:30:00Z",
    };
    expect(sample.action).toBe("audit.ping");
    expect(sample.principal.type).toBe("user");
  });

  test("TenantEvent type matches the activities_emit.go envelope", () => {
    const sample: TenantEvent = {
      tenantId: "00000000-0000-0000-0000-000000000000",
      event: "tenant.created",
      timestamp: "2026-05-12T00:00:00Z",
    };
    expect(sample.tenantId).toBeTruthy();
    expect(sample.event).toBeTruthy();
    expect(sample.timestamp).toBeTruthy();
  });

  test("WorkflowStatusEvent type covers workflow + step scopes (#177)", () => {
    // Compile-time type assertions: if the wire format from
    // apps/workers/onboarding/activities_workflow_status.go drifts,
    // these assignments fail to compile.
    const wf: WorkflowStatusEvent = {
      scope: "workflow",
      workflowId: "tnt-00000000-0000-0000-0000-000000000000-onboard-abc",
      workflowType: "monok8s.onboarding",
      tenantId: "00000000-0000-0000-0000-000000000000",
      phase: "succeeded",
      timestamp: "2026-05-13T12:00:00Z",
    };
    const step: WorkflowStatusEvent = {
      scope: "step",
      workflowId: "tnt-00000000-0000-0000-0000-000000000000-onboard-abc",
      workflowType: "monok8s.onboarding",
      tenantId: "00000000-0000-0000-0000-000000000000",
      step: "provision_namespace",
      phase: "started",
      timestamp: "2026-05-13T12:00:01Z",
    };
    expect(wf.scope).toBe("workflow");
    expect(step.scope).toBe("step");
  });
});
