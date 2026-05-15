// L1 unit tests for the tRPC client factory (#192 / #91 Phase C).
// Covers the two pure helpers exported alongside createMonok8sClient
// — isSubscription (link-condition predicate) and credentialsFetch
// (cookie-session passthrough wrapper). createMonok8sClient itself
// is a thin composition of upstream factories; smoke-imported here
// to assert it constructs without throwing against a synthetic
// EventSource + fetch.

import { describe, expect, jest, test } from "@jest/globals";

import {
  createMonok8sClient,
  credentialsFetch,
  isSubscription,
} from "./client";

// ── isSubscription ─────────────────────────────────────────────────

describe("isSubscription", () => {
  test("returns true for subscription ops", () => {
    expect(isSubscription({ type: "subscription" } as never)).toBe(true);
  });

  test.each(["query", "mutation"] as const)(
    "returns false for %s ops",
    (type) => {
      expect(isSubscription({ type } as never)).toBe(false);
    },
  );
});

// ── credentialsFetch ───────────────────────────────────────────────

describe("credentialsFetch", () => {
  test("wraps fetch to inject credentials: 'include'", async () => {
    const inner = jest.fn(async () => new Response(null, { status: 204 }));
    const wrapped = credentialsFetch(inner as unknown as typeof fetch);

    await wrapped("/some/url");
    expect(inner).toHaveBeenCalledTimes(1);
    expect((inner.mock.calls[0] as unknown[])[1]).toEqual({
      credentials: "include",
    });
  });

  test("preserves caller-supplied init values alongside credentials", async () => {
    const inner = jest.fn(async () => new Response(null, { status: 204 }));
    const wrapped = credentialsFetch(inner as unknown as typeof fetch);

    await wrapped("/some/url", {
      method: "POST",
      headers: { "X-Trace-Id": "abc" },
    });
    const init = (inner.mock.calls[0] as unknown[])[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "X-Trace-Id": "abc" });
    expect(init.credentials).toBe("include");
  });

  test("caller-supplied credentials are overridden to 'include'", async () => {
    const inner = jest.fn(async () => new Response(null, { status: 204 }));
    const wrapped = credentialsFetch(inner as unknown as typeof fetch);

    await wrapped("/x", { credentials: "omit" });
    const init = (inner.mock.calls[0] as unknown[])[1] as RequestInit;
    expect(init.credentials).toBe("include");
  });
});

// ── createMonok8sClient (smoke) ────────────────────────────────────

describe("createMonok8sClient", () => {
  test("constructs against injected fetch + EventSource", () => {
    // Minimal stub EventSource shape; the constructor body never runs
    // during client construction — splitLink defers link initialization
    // until the first op. Smoke test asserts no synchronous throw.
    class StubEventSource {
      url: string;
      readyState = 0;
      onopen: ((this: EventSource, ev: Event) => unknown) | null = null;
      onmessage: ((this: EventSource, ev: MessageEvent) => unknown) | null =
        null;
      onerror: ((this: EventSource, ev: Event) => unknown) | null = null;
      constructor(url: string | URL) {
        this.url = String(url);
      }
      close(): void {}
      addEventListener(): void {}
      removeEventListener(): void {}
      dispatchEvent(): boolean {
        return false;
      }
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 2;
      readonly CONNECTING = 0;
      readonly OPEN = 1;
      readonly CLOSED = 2;
      withCredentials = false;
    }

    const fetcher = jest.fn(
      async () => new Response(null, { status: 204 }),
    ) as unknown as typeof fetch;

    const client = createMonok8sClient({
      url: "/api/trpc",
      fetch: fetcher,
      EventSource: StubEventSource as unknown as typeof EventSource,
    });

    expect(client).toBeDefined();
  });
});
