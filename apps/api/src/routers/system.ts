import http from "node:http";

import { getConfig, type Cloud } from "../config.js";

// ── /api/v1/system/cloud ──────────────────────────────────────────────────────
//
// Plain REST endpoint (not tRPC) — called unauthenticated by CloudThemeProvider
// before any auth session is established.  Returns the cloud environment the
// platform is deployed on so the frontend can select the right theme tokens and
// navigation shell.
//
// Config comes from env vars resolved at module load via apps/api/src/config.ts
// (#195 — Locality). Pre-#195 every request re-read process.env inline; now
// the env boundary is `loadConfig()`'s single read at startup.
//
// Cloud display names match the naming the portal uses itself — keep them stable
// as they may surface in the UI.

const CLOUD_NAMES: Record<string, string> = {
  gcp:          "Google Cloud",
  aws:          "Amazon Web Services",
  azure:        "Microsoft Azure",
  "bare-metal": "Self-hosted",
};

export interface CloudInfo {
  cloud:       Cloud;
  region:      string;
  cloudName:   string;
  environment: string;
}

function buildCloudInfo(): CloudInfo {
  const config = getConfig();
  return {
    cloud:       config.cloud,
    region:      config.region,
    cloudName:   CLOUD_NAMES[config.cloud] ?? "Unknown",
    environment: config.environment,
  };
}

/**
 * handleSystemRoute
 *
 * Mount this in the HTTP server before the tRPC handler:
 *
 *   if (handleSystemRoute(req, res)) return;
 *   trpcHandler(req, res);
 */
export function handleSystemRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): boolean {
  if (req.url !== "/api/v1/system/cloud") return false;

  const body = JSON.stringify(buildCloudInfo());
  res.writeHead(200, {
    "Content-Type":  "application/json",
    "Cache-Control": "public, max-age=300",   // 5 min — cloud doesn't change at runtime
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
  return true;
}
