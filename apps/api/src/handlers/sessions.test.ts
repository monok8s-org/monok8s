// L1 unit tests for handlers/sessions.ts (#191 / #91 Phase B).
//
// All tests use a fresh Map via _setStore_TESTING so they don't see
// each other's entries. Cookie formatting is asserted as a literal
// string match — the wire shape is the contract.

import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";

import type { VerifiedUser } from "@monok8s/auth";

import {
  _setStore_TESTING,
  _TTL_MS_TESTING,
  _COOKIE_NAMES_TESTING,
  consumePendingAuth,
  createPendingAuth,
  createSession,
  deleteSession,
  formatClearPendingCookie,
  formatClearSessionCookie,
  formatPendingCookie,
  formatSessionCookie,
  lookupSession,
  parseCookieHeader,
  readPendingCookie,
  readSessionCookie,
} from "./sessions";

const TEST_USER: VerifiedUser = {
  userId: "00000000-0000-0000-0000-000000000001",
  zitadelId: "zitadel-1",
  tenantId: "00000000-0000-0000-0000-000000000111",
  email: "test@monok8s.test",
};

beforeEach(() => {
  _setStore_TESTING({ sessions: null, pending: null });
});

afterEach(() => {
  _setStore_TESTING({ sessions: null, pending: null });
});

// ── session lifecycle ────────────────────────────────────────────────────────

describe("createSession + lookupSession + deleteSession", () => {
  test("creates a session and looks it up by id", () => {
    const id = createSession(TEST_USER, "access-token-xyz");
    expect(id).toHaveLength(64); // 32 bytes hex
    const rec = lookupSession(id);
    expect(rec?.user.userId).toBe(TEST_USER.userId);
    expect(rec?.accessToken).toBe("access-token-xyz");
  });

  test("lookupSession returns null for unknown id", () => {
    expect(lookupSession("not-a-real-id")).toBeNull();
  });

  test("lookupSession returns null for null id", () => {
    expect(lookupSession(null)).toBeNull();
  });

  test("lookupSession returns null for expired record + GCs it", () => {
    const now = 1_000_000_000_000;
    const id = createSession(TEST_USER, "tok", now);
    // Lookup at now + TTL + 1 → expired
    const expired = lookupSession(id, now + _TTL_MS_TESTING.session + 1);
    expect(expired).toBeNull();
    // Even at the original now, it's gone (GC dropped it on lookup)
    expect(lookupSession(id, now)).toBeNull();
  });

  test("deleteSession returns true when removing an existing session", () => {
    const id = createSession(TEST_USER, "tok");
    expect(deleteSession(id)).toBe(true);
    expect(deleteSession(id)).toBe(false);
    expect(lookupSession(id)).toBeNull();
  });

  test("deleteSession returns false for null / unknown id", () => {
    expect(deleteSession(null)).toBe(false);
    expect(deleteSession("nope")).toBe(false);
  });
});

// ── pending-auth lifecycle ───────────────────────────────────────────────────

describe("createPendingAuth + consumePendingAuth", () => {
  test("creates a pending entry and consumes it once", () => {
    createPendingAuth("state-1", "verifier-1", { returnTo: "/dashboard" });
    const first = consumePendingAuth("state-1");
    expect(first?.codeVerifier).toBe("verifier-1");
    expect(first?.returnTo).toBe("/dashboard");
    // Second consume returns null (single-use).
    expect(consumePendingAuth("state-1")).toBeNull();
  });

  test("consume returns null for unknown / null state", () => {
    expect(consumePendingAuth("nope")).toBeNull();
    expect(consumePendingAuth(null)).toBeNull();
  });

  test("consume returns null for expired pending entry", () => {
    const now = 2_000_000_000_000;
    createPendingAuth("state-2", "verifier-2", { now });
    const expired = consumePendingAuth(
      "state-2",
      now + _TTL_MS_TESTING.pending + 1,
    );
    expect(expired).toBeNull();
  });
});

// ── cookie format ────────────────────────────────────────────────────────────

describe("formatSessionCookie", () => {
  test("emits HttpOnly + SameSite=Lax + Max-Age + Path", () => {
    const cookie = formatSessionCookie("abc123", {
      secure: false,
      domain: "",
    });
    expect(cookie).toContain(`${_COOKIE_NAMES_TESTING.session}=abc123`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain(
      `Max-Age=${Math.floor(_TTL_MS_TESTING.session / 1000)}`,
    );
    expect(cookie).not.toContain("Secure");
    expect(cookie).not.toContain("Domain=");
  });

  test("emits Secure when secure=true and Domain when domain set", () => {
    const cookie = formatSessionCookie("abc123", {
      secure: true,
      domain: ".monok8s.test",
    });
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("Domain=.monok8s.test");
  });
});

describe("formatPendingCookie", () => {
  test("uses the pending-cookie name + pending TTL", () => {
    const cookie = formatPendingCookie("state-x", {
      secure: true,
      domain: "",
    });
    expect(cookie).toContain(`${_COOKIE_NAMES_TESTING.pending}=state-x`);
    expect(cookie).toContain(
      `Max-Age=${Math.floor(_TTL_MS_TESTING.pending / 1000)}`,
    );
  });
});

describe("formatClear*Cookie", () => {
  test("session-clear emits empty value + Max-Age=0", () => {
    const cookie = formatClearSessionCookie({ secure: true, domain: "" });
    expect(cookie).toContain(`${_COOKIE_NAMES_TESTING.session}=`);
    expect(cookie).toContain("Max-Age=0");
  });

  test("pending-clear emits empty value + Max-Age=0", () => {
    const cookie = formatClearPendingCookie({ secure: false, domain: "" });
    expect(cookie).toContain(`${_COOKIE_NAMES_TESTING.pending}=`);
    expect(cookie).toContain("Max-Age=0");
  });
});

// ── cookie parse ─────────────────────────────────────────────────────────────

describe("parseCookieHeader", () => {
  test("returns the value for an existing name", () => {
    expect(parseCookieHeader("foo=bar; baz=qux", "baz")).toBe("qux");
  });

  test("returns null for missing name or empty value", () => {
    expect(parseCookieHeader("foo=bar", "missing")).toBeNull();
    expect(parseCookieHeader("foo=", "foo")).toBeNull();
  });

  test("returns null for undefined header", () => {
    expect(parseCookieHeader(undefined, "x")).toBeNull();
  });

  test("readSessionCookie + readPendingCookie use the right names", () => {
    const header = `${_COOKIE_NAMES_TESTING.session}=sid; ${_COOKIE_NAMES_TESTING.pending}=stateX`;
    expect(readSessionCookie(header)).toBe("sid");
    expect(readPendingCookie(header)).toBe("stateX");
  });
});
