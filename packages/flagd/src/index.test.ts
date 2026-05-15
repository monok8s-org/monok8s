// L1 unit tests for the no-op flagd stub (#35 / 0.1.0).
//
// The stub's behavior is trivial — every flag evaluation returns the
// caller-supplied default. These tests pin that contract so the
// 0.2.0 swap to a real flagd binding can be diff'd against a stable
// expected output.

import { describe, expect, test } from "@jest/globals";

import { getClient } from "./index";

describe("flagd no-op client (0.1.0 stub)", () => {
  test("getBooleanValue returns the caller-supplied default", () => {
    const c = getClient();
    expect(c.getBooleanValue("any-flag", true)).toBe(true);
    expect(c.getBooleanValue("any-flag", false)).toBe(false);
  });

  test("getStringValue returns the caller-supplied default", () => {
    const c = getClient();
    expect(c.getStringValue("any-flag", "control")).toBe("control");
    expect(c.getStringValue("any-flag", "")).toBe("");
  });

  test("getNumberValue returns the caller-supplied default", () => {
    const c = getClient();
    expect(c.getNumberValue("any-flag", 0)).toBe(0);
    expect(c.getNumberValue("any-flag", 42)).toBe(42);
  });

  test("getClient is a singleton — same identity across calls", () => {
    expect(getClient()).toBe(getClient());
  });

  test("client surface matches the documented FlagdClient interface", () => {
    const c = getClient();
    expect(typeof c.getBooleanValue).toBe("function");
    expect(typeof c.getStringValue).toBe("function");
    expect(typeof c.getNumberValue).toBe("function");
  });
});
