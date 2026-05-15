// Alertmanager effects (#194 — Rule 2 / effect_then_interceptor).
//
// Forwards labelled alerts from tenant installations to the project's
// Alertmanager instance. The forwarder is the orchestrator; this
// module's `postAlertmanagerAlert` is the IO effect — explicit URL +
// payload inputs, returns void.
//
// The URL plumbing currently reads from `process.env.ALERTMANAGER_URL`
// at the call site (`apps/api/src/routers/installations.ts`'s
// `forwardToAlertmanager`). Sibling Issue #195 hoists that env read
// to `ctx.config.alertmanagerUrl` so the URL becomes a real
// caller-supplied param at the effect boundary too.

export interface AlertmanagerAlert {
  labels: Record<string, string>;
  // Alertmanager accepts arbitrary additional fields per the v2 API;
  // we don't enforce shape here — the caller composes the alert.
  [key: string]: unknown;
}

// Production effect: POST the labelled alerts to Alertmanager's v2
// API. Caller composes the labels + URL; this function does the
// HTTP work. No retry / circuit-breaker logic — Alertmanager is
// expected to be in-cluster and reliably reachable; the existing
// upstream installations.ts caller hasn't asked for either.
export async function postAlertmanagerAlert(
  url: string,
  alerts: readonly AlertmanagerAlert[],
): Promise<void> {
  await fetch(url + "/api/v2/alerts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(alerts),
  });
}
