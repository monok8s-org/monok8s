// L1 unit tests for apps/api/src/config.ts (#195 — Locality).
//
// loadConfig() is pure when called with an explicit env arg —
// every test passes its own synthetic NodeJS.ProcessEnv. The
// module-cached getConfig() is exercised via the
// _setConfig_TESTING seam so tests don't have to mutate
// process.env (which would leak across tests).

import { afterEach, describe, expect, test } from "@jest/globals";

import {
  _setConfig_TESTING,
  getConfig,
  loadConfig,
  type AppConfig,
} from "./config";

afterEach(() => {
  _setConfig_TESTING(null);
});

describe("loadConfig (pure parse)", () => {
  test("defaults when no env vars set", () => {
    const cfg = loadConfig({});
    expect(cfg.cloud).toBe("bare-metal");
    expect(cfg.region).toBe("unknown");
    expect(cfg.environment).toBe("production");
    expect(cfg.alertmanagerUrl).toBe("");
    expect(cfg.natsUrl).toBe("nats://nats.nats.svc.cluster.local:4222");
    expect(cfg.zitadelIssuer).toBe("");
    expect(cfg.zitadelClientId).toBe("");
    expect(cfg.zitadelRedirectUri).toBe("");
    expect(cfg.cookieDomain).toBe("");
    // No env → environment defaults to "production" → cookieSecure true.
    expect(cfg.cookieSecure).toBe(true);
  });

  test("reads cloud + region + environment + URLs from env", () => {
    const cfg = loadConfig({
      MONOK8S_CLOUD: "gcp",
      MONOK8S_REGION: "us-central1",
      MONOK8S_ENVIRONMENT: "staging",
      ALERTMANAGER_URL: "http://am.test:9093",
      NATS_URL: "nats://nats.test:4222",
      ZITADEL_ISSUER: "https://zitadel.test",
      ZITADEL_CLIENT_ID: "spa-client",
      ZITADEL_REDIRECT_URI: "https://app.test/auth/callback",
      MONOK8S_COOKIE_DOMAIN: ".app.test",
    });
    expect(cfg.cloud).toBe("gcp");
    expect(cfg.region).toBe("us-central1");
    expect(cfg.environment).toBe("staging");
    expect(cfg.alertmanagerUrl).toBe("http://am.test:9093");
    expect(cfg.natsUrl).toBe("nats://nats.test:4222");
    expect(cfg.zitadelIssuer).toBe("https://zitadel.test");
    expect(cfg.zitadelClientId).toBe("spa-client");
    expect(cfg.zitadelRedirectUri).toBe("https://app.test/auth/callback");
    expect(cfg.cookieDomain).toBe(".app.test");
  });

  test("cookieSecure follows environment when MONOK8S_COOKIE_SECURE unset", () => {
    expect(
      loadConfig({ MONOK8S_ENVIRONMENT: "development" }).cookieSecure,
    ).toBe(false);
    expect(
      loadConfig({ MONOK8S_ENVIRONMENT: "staging" }).cookieSecure,
    ).toBe(true);
    expect(
      loadConfig({ MONOK8S_ENVIRONMENT: "production" }).cookieSecure,
    ).toBe(true);
  });

  test("cookieSecure honors explicit MONOK8S_COOKIE_SECURE override", () => {
    expect(
      loadConfig({
        MONOK8S_ENVIRONMENT: "production",
        MONOK8S_COOKIE_SECURE: "false",
      }).cookieSecure,
    ).toBe(false);
    expect(
      loadConfig({
        MONOK8S_ENVIRONMENT: "development",
        MONOK8S_COOKIE_SECURE: "true",
      }).cookieSecure,
    ).toBe(true);
  });

  test("accepts every documented cloud value", () => {
    for (const c of ["gcp", "aws", "azure", "bare-metal"] as const) {
      expect(loadConfig({ MONOK8S_CLOUD: c }).cloud).toBe(c);
    }
  });

  test("accepts every documented environment value", () => {
    for (const e of ["development", "staging", "production"] as const) {
      expect(loadConfig({ MONOK8S_ENVIRONMENT: e }).environment).toBe(e);
    }
  });

  test("rejects invalid cloud value with explicit error", () => {
    expect(() => loadConfig({ MONOK8S_CLOUD: "oracle" })).toThrow(
      /MONOK8S_CLOUD.*invalid.*oracle/,
    );
  });

  test("rejects invalid environment value with explicit error", () => {
    expect(() =>
      loadConfig({ MONOK8S_ENVIRONMENT: "qa" }),
    ).toThrow(/MONOK8S_ENVIRONMENT.*invalid.*qa/);
  });
});

describe("getConfig (cached singleton)", () => {
  test("returns synthetic config when _setConfig_TESTING is active", () => {
    const synthetic: AppConfig = {
      cloud: "aws",
      region: "us-east-1",
      environment: "staging",
      alertmanagerUrl: "http://stub.test",
      natsUrl: "nats://stub.test:4222",
      zitadelIssuer: "https://zitadel.stub",
      zitadelClientId: "stub-spa",
      zitadelRedirectUri: "https://stub.test/auth/callback",
      cookieDomain: ".stub.test",
      cookieSecure: true,
    };
    _setConfig_TESTING(synthetic);
    expect(getConfig()).toBe(synthetic);
  });

  test("subsequent calls return the same instance", () => {
    _setConfig_TESTING(null);
    const a = getConfig();
    const b = getConfig();
    expect(a).toBe(b);
  });
});
