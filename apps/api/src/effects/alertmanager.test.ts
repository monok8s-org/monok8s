// L1 unit test for alertmanager effect (#194 — extracted from
// apps/api/src/routers/installations.ts:241).
//
// Asserts: correct URL composition (base + /api/v2/alerts), POST verb,
// JSON content-type, body matches the supplied alerts array.

import { afterEach, describe, expect, jest, test } from "@jest/globals";

import {
  postAlertmanagerAlert,
  type AlertmanagerAlert,
} from "./alertmanager";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("postAlertmanagerAlert", () => {
  test("POSTs alerts to <url>/api/v2/alerts as JSON", async () => {
    const fetchMock = jest.fn<typeof fetch>(async () =>
      new Response("OK", { status: 200 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const alerts: AlertmanagerAlert[] = [
      {
        labels: {
          alertname: "TestAlert",
          severity: "warning",
          tenant_id: "00000000-0000-0000-0000-000000000001",
        },
      },
    ];
    await postAlertmanagerAlert("http://alertmanager.monitoring.svc:9093", alerts);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "http://alertmanager.monitoring.svc:9093/api/v2/alerts",
    );
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json",
    );
    expect(JSON.parse(init.body as string)).toEqual(alerts);
  });

  test("posts an empty array without breaking", async () => {
    const fetchMock = jest.fn<typeof fetch>(async () =>
      new Response("OK", { status: 200 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await postAlertmanagerAlert("http://am.test", []);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual([]);
  });

  test("propagates fetch rejections", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    await expect(
      postAlertmanagerAlert("http://am.test", []),
    ).rejects.toThrow(/ECONNREFUSED/);
  });
});
