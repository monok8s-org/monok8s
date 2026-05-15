// jose v6 ships ESM. Lazy-import to keep top-level cheap (and to
// avoid pulling jose into test runtimes that stub `verifyToken`).
import type { JWTPayload } from "jose";

export interface VerifiedUser {
  userId: string;       // monok8s user.id (stored in JWT sub or custom claim)
  zitadelId: string;    // Zitadel's internal subject ID
  tenantId: string;     // active tenant from JWT claim
  email: string;

  // Authentication context (#169 / #88c — RFC 8176 / RFC 6711).
  // Zitadel emits these whenever the user authenticates with an
  // additional factor; absent on password-only logins, machine-token
  // auth, or other non-interactive paths.
  amr?: string[];       // ["pwd"], ["pwd","mfa"], ["pwd","otp"], ["pwd","hwk"], ["pwd","fido"], etc.
  acr?: string;         // e.g. "urn:zitadel:iam:authentication:loa-1" or :loa-2
}

// MFA-factor markers recognized as "strong factor" within an `amr`
// array. RFC 8176 documents the canonical values; Zitadel emits
// `otp` / `mfa` / `hwk` / `fido` per its OIDC issuer config. `totp`
// is RFC 8176 even though Zitadel doesn't emit it today — included
// for portability across IdPs that DO emit it.
const MFA_AMR_VALUES = new Set(["mfa", "otp", "totp", "hwk", "fido"]);

// hasMFA returns true iff the verified user's `amr` claim contains
// at least one strong-factor marker. False for `undefined` (no
// `amr` claim at all) and for `["pwd"]`-only authentications.
//
// Usage:
//   tenantProcedure("write", { requireMFA: true })  // gates the
//     procedure on a strong-factor login, throws UNAUTHORIZED
//     otherwise.
export function hasMFA(u: VerifiedUser): boolean {
  if (!u.amr) return false;
  return u.amr.some((m) => MFA_AMR_VALUES.has(m));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let jwks: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let joseMod: any = null;

async function getJose() {
  if (!joseMod) {
    joseMod = await import("jose");
  }
  return joseMod;
}

async function getJwks() {
  if (!jwks) {
    const jose = await getJose();
    jwks = jose.createRemoteJWKSet(
      new URL(`${process.env.ZITADEL_ISSUER}/oauth/v2/keys`),
    );
  }
  return jwks;
}

export async function verifyToken(token: string): Promise<VerifiedUser> {
  const jose = await getJose();
  const keys = await getJwks();
  const { payload }: { payload: JWTPayload } = await jose.jwtVerify(token, keys, {
    issuer: process.env.ZITADEL_ISSUER,
  });

  // Zitadel puts the internal subject in `sub`.
  // monok8s user ID and active tenant are stored as custom claims
  // configured in the Zitadel action script (see platform/zitadel/).
  const userId   = payload["monok8s:user_id"] as string;
  const tenantId = payload["monok8s:tenant_id"] as string;

  if (!userId || !tenantId) {
    throw new Error("Missing monok8s claims in JWT — check Zitadel action config");
  }

  // Authentication-context claims (#169). Defensive: payload shape
  // is JWTPayload (record + optional fields); pull only if shape
  // matches. Absent / wrong-typed → undefined, no error.
  const rawAmr = (payload as Record<string, unknown>).amr;
  const amr =
    Array.isArray(rawAmr) && rawAmr.every((v) => typeof v === "string")
      ? (rawAmr as string[])
      : undefined;
  const rawAcr = (payload as Record<string, unknown>).acr;
  const acr = typeof rawAcr === "string" ? rawAcr : undefined;

  return {
    userId,
    zitadelId: payload.sub!,
    tenantId,
    email: payload.email as string,
    ...(amr !== undefined ? { amr } : {}),
    ...(acr !== undefined ? { acr } : {}),
  };
}
