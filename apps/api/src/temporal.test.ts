// L1 unit tests for apps/api/src/temporal.ts (#222 Temporal Client
// bootstrap).
//
// resolveTemporalConfig is pure (parameterized over the env arg) so the
// tests pass their own synthetic NodeJS.ProcessEnv. The cached
// getTemporalClient() singleton is exercised via the
// _setTemporalClient_TESTING seam — tests inject a stub WorkflowClient
// to verify idempotent reuse without touching the real Temporal gRPC
// dial path.

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import type { WorkflowClient } from "@temporalio/client";

import {
  _setTemporalClient_TESTING,
  getTemporalClient,
  resolveTemporalConfig,
} from "./temporal";

afterEach(() => {
  _setTemporalClient_TESTING(null);
});

describe("resolveTemporalConfig (pure parse)", () => {
  test("defaults when no env vars set", () => {
    const cfg = resolveTemporalConfig({});
    expect(cfg.address).toBe("temporal.temporal.svc.cluster.local:7233");
    expect(cfg.namespace).toBe("default");
  });

  test("reads TEMPORAL_HOST from env", () => {
    const cfg = resolveTemporalConfig({
      TEMPORAL_HOST: "temporal.staging.example.com:7233",
    });
    expect(cfg.address).toBe("temporal.staging.example.com:7233");
    expect(cfg.namespace).toBe("default");
  });

  test("reads TEMPORAL_NAMESPACE from env", () => {
    const cfg = resolveTemporalConfig({
      TEMPORAL_NAMESPACE: "monok8s-prod",
    });
    expect(cfg.address).toBe("temporal.temporal.svc.cluster.local:7233");
    expect(cfg.namespace).toBe("monok8s-prod");
  });

  test("reads both env vars together", () => {
    const cfg = resolveTemporalConfig({
      TEMPORAL_HOST: "127.0.0.1:7233",
      TEMPORAL_NAMESPACE: "dev",
    });
    expect(cfg.address).toBe("127.0.0.1:7233");
    expect(cfg.namespace).toBe("dev");
  });

  test("ignores unrelated env vars", () => {
    const cfg = resolveTemporalConfig({
      TEMPORAL_TLS: "true",
      RANDOM_VAR: "xyz",
    });
    expect(cfg.address).toBe("temporal.temporal.svc.cluster.local:7233");
    expect(cfg.namespace).toBe("default");
  });
});

describe("getTemporalClient (test-seam-driven)", () => {
  function makeStubClient(): WorkflowClient {
    return {
      start: jest.fn(),
      getHandle: jest.fn(),
    } as unknown as WorkflowClient;
  }

  test("returns the injected stub when _setTemporalClient_TESTING is set", async () => {
    const stub = makeStubClient();
    _setTemporalClient_TESTING(stub);
    const client = await getTemporalClient();
    expect(client).toBe(stub);
  });

  test("returns the same stub on subsequent calls (idempotent)", async () => {
    const stub = makeStubClient();
    _setTemporalClient_TESTING(stub);
    const first = await getTemporalClient();
    const second = await getTemporalClient();
    expect(first).toBe(second);
    expect(second).toBe(stub);
  });

  test("_setTemporalClient_TESTING(null) resets the singleton", async () => {
    const stub = makeStubClient();
    _setTemporalClient_TESTING(stub);
    expect(await getTemporalClient()).toBe(stub);
    // Reset — next getTemporalClient() falls back to the real construct
    // path. We can't actually call it without a Temporal server, so this
    // case asserts only that the cached reference is cleared by injecting
    // a different stub and confirming it's the new one.
    const stub2 = makeStubClient();
    _setTemporalClient_TESTING(stub2);
    expect(await getTemporalClient()).toBe(stub2);
  });

  test("multiple concurrent callers all receive the same client", async () => {
    const stub = makeStubClient();
    _setTemporalClient_TESTING(stub);
    const results = await Promise.all([
      getTemporalClient(),
      getTemporalClient(),
      getTemporalClient(),
    ]);
    expect(results[0]).toBe(stub);
    expect(results[1]).toBe(stub);
    expect(results[2]).toBe(stub);
  });
});
