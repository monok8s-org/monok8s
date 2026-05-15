// L1 unit test for sns effect (#194 — extracted from
// apps/api/src/routers/marketplace.ts:71). Mocks global fetch and
// asserts the SubscribeURL is GET'd verbatim.

import { afterEach, describe, expect, jest, test } from "@jest/globals";

import { confirmSnsSubscription } from "./sns";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("confirmSnsSubscription", () => {
  test("GETs the supplied SubscribeURL", async () => {
    const fetchMock = jest.fn<typeof fetch>(async () =>
      new Response("OK", { status: 200 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await confirmSnsSubscription(
      "https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&Token=abc",
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&Token=abc",
    );
  });

  test("does not throw on fetch resolving normally", async () => {
    globalThis.fetch = (async () =>
      new Response("OK", { status: 200 })) as unknown as typeof fetch;
    await expect(
      confirmSnsSubscription("https://example.test/sns"),
    ).resolves.toBeUndefined();
  });

  test("propagates fetch rejections (network failure)", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ENOTFOUND");
    }) as unknown as typeof fetch;
    await expect(
      confirmSnsSubscription("https://example.test/sns"),
    ).rejects.toThrow(/ENOTFOUND/);
  });
});
