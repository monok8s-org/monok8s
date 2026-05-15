// L1 unit tests for packages/auth/src/zitadel.ts (#169).
//
// hasMFA reads the verified user's `amr` claim and returns true iff
// at least one strong-factor marker is present. The MFA-marker set
// is RFC 8176-aligned + Zitadel-emitted values: mfa / otp / totp /
// hwk / fido. Anything else (notably "pwd"-only) and missing `amr`
// return false.
//
// Full verifyToken coverage requires Zitadel and a real JWKS — out
// of scope for L1. The shape-extraction logic inside verifyToken
// (defensive parse of payload.amr / payload.acr) gets indirect
// coverage via the L3 itest from #170.

import { describe, expect, test } from "@jest/globals";

import { hasMFA } from "./zitadel.js";
import type { VerifiedUser } from "./zitadel.js";

const baseUser: VerifiedUser = {
  userId: "user-alice",
  zitadelId: "zitadel-alice",
  tenantId: "acme",
  email: "alice@example.test",
};

describe("hasMFA", () => {
  test("true for ['pwd','mfa']", () => {
    expect(hasMFA({ ...baseUser, amr: ["pwd", "mfa"] })).toBe(true);
  });

  test("true for ['pwd','otp']", () => {
    expect(hasMFA({ ...baseUser, amr: ["pwd", "otp"] })).toBe(true);
  });

  test("true for ['pwd','hwk']", () => {
    expect(hasMFA({ ...baseUser, amr: ["pwd", "hwk"] })).toBe(true);
  });

  test("true for ['pwd','fido']", () => {
    expect(hasMFA({ ...baseUser, amr: ["pwd", "fido"] })).toBe(true);
  });

  test("true for ['totp']", () => {
    // RFC 8176 standard; Zitadel doesn't emit but should still pass.
    expect(hasMFA({ ...baseUser, amr: ["totp"] })).toBe(true);
  });

  test("false for ['pwd']-only", () => {
    expect(hasMFA({ ...baseUser, amr: ["pwd"] })).toBe(false);
  });

  test("false for undefined amr", () => {
    expect(hasMFA(baseUser)).toBe(false);
  });

  test("false for empty amr array", () => {
    expect(hasMFA({ ...baseUser, amr: [] })).toBe(false);
  });

  test("false for unknown-marker amr (e.g. ['user'])", () => {
    // 'user' is RFC 8176 but is itself just "the user took an
    // explicit action," not a strong second factor.
    expect(hasMFA({ ...baseUser, amr: ["user"] })).toBe(false);
  });
});
